/**
 * Proves the API-key expiry reminder does not replay attempted sends for keys
 * expiring within the window, and skips revoked/far-future/already-reminded
 * keys.
 */
import {
  apiKeysTable,
  auditEventsTable,
  db,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { logger } from "../lib/logger";
import { ResendSendError } from "./resend-delivery";
import * as audit from "./audit";

process.env.SESSION_SECRET ??= "test-session-secret";

const sent: { to: string; subject: string }[] = [];
const attempted: string[] = [];
const recipientFailures = new Map<string, unknown>();
let sendFailure: unknown;

vi.mock("./providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers")>();
  return {
    ...actual,
    transactionalEmailProvider: {
      send: async (to: string, subject: string) => {
        attempted.push(to);
        if (recipientFailures.has(to)) throw recipientFailures.get(to);
        if (sendFailure !== undefined) throw sendFailure;
        sent.push({ to, subject });
        return { id: "mock", provider: "mock" };
      },
    },
  };
});

const { processApiKeyExpiryReminders } =
  await import("./api-key-expiry-reminder");

let org: { id: string };
// Unique per-run emails so assertions can be scoped to this org even when the
// DB holds leftover expiring keys from other test files (the reminder job
// scans every organization).
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const adminEmail = `kr-admin-${suffix}@example.com`;
const ownerEmail = `kr-owner-${suffix}@example.com`;
const repEmail = `kr-rep-${suffix}@example.com`;
const myEmails = new Set([adminEmail, ownerEmail, repEmail]);
/** Only emails sent to this test's own org users. */
const mine = () => sent.filter((s) => myEmails.has(s.to));
const myAttempts = () => attempted.filter((to) => myEmails.has(to));
const userIds: string[] = [];
const keyIds: string[] = [];
const now = new Date();
const days = (n: number) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);

async function makeKey(overrides: Partial<typeof apiKeysTable.$inferInsert>) {
  const [row] = await db
    .insert(apiKeysTable)
    .values({
      organizationId: org.id,
      name: "Key",
      prefix: "pk_test",
      keyHash: `hash-${Math.random().toString(36).slice(2)}`,
      createdByUserId: userIds[0],
      ...overrides,
    })
    .returning();
  keyIds.push(row.id);
  return row;
}

async function reminderAudit(keyId: string) {
  const events = await db
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.organizationId, org.id),
        eq(auditEventsTable.entityId, keyId),
        eq(auditEventsTable.action, "api_key.expiry_reminder.processed"),
      ),
    );
  expect(events).toHaveLength(1);
  return events[0].metadata;
}

beforeAll(async () => {
  const [row] = await db
    .insert(organizationsTable)
    .values({
      name: "Key Reminder Org",
      slug: `test-key-reminder-${Date.now()}`,
    })
    .returning();
  org = row;
  const users = await db
    .insert(usersTable)
    .values([
      {
        id: `test-kr-admin-${Date.now()}`,
        email: adminEmail,
        organizationId: org.id,
        role: "admin",
      },
      {
        id: `test-kr-owner-${Date.now()}`,
        email: ownerEmail,
        organizationId: org.id,
        role: "owner",
      },
      {
        id: `test-kr-rep-${Date.now()}`,
        email: repEmail,
        organizationId: org.id,
        role: "sales_rep",
      },
    ])
    .returning();
  userIds.push(...users.map((u) => u.id));
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

beforeEach(async () => {
  if (keyIds.length)
    await db.delete(apiKeysTable).where(inArray(apiKeysTable.id, keyIds));
  keyIds.length = 0;
  await db
    .update(usersTable)
    .set({ isActive: true })
    .where(inArray(usersTable.id, userIds));
  sent.length = 0;
  attempted.length = 0;
  sendFailure = undefined;
  recipientFailures.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("processApiKeyExpiryReminders", () => {
  it("emails all org admins once for a key expiring within the window", async () => {
    const key = await makeKey({ name: "Expiring", expiresAt: days(3) });

    const claimed = await processApiKeyExpiryReminders(7, now);
    expect(claimed.map((k) => k.id)).toContain(key.id);
    const own = mine();
    expect(own.map((s) => s.to).sort()).toEqual([adminEmail, ownerEmail]);
    expect(own[0].subject).toContain("Expiring");
    expect(await reminderAudit(key.id)).toMatchObject({
      outcome: "accepted",
      acceptedCount: 2,
      rejectedCount: 0,
      unknownCount: 0,
      claimRetained: true,
      automaticRetry: false,
      deliveryVerified: false,
      reconciliationRequired: false,
      operatorReviewRequired: false,
    });

    // Second run: reminder is not re-sent.
    sent.length = 0;
    const again = await processApiKeyExpiryReminders(7, now);
    expect(again.map((k) => k.id)).not.toContain(key.id);
    expect(mine()).toHaveLength(0);

    const [after] = await db
      .select()
      .from(apiKeysTable)
      .where(eq(apiKeysTable.id, key.id));
    expect(after.expiryReminderSentAt).not.toBeNull();
  });

  it("skips keys outside the window, already expired, revoked, or already reminded", async () => {
    const farFuture = await makeKey({ name: "Far", expiresAt: days(30) });
    const expired = await makeKey({ name: "Gone", expiresAt: days(-1) });
    const revoked = await makeKey({
      name: "Revoked",
      expiresAt: days(2),
      isActive: false,
      revokedAt: now,
    });
    const reminded = await makeKey({
      name: "Reminded",
      expiresAt: days(2),
      expiryReminderSentAt: now,
    });
    const noExpiry = await makeKey({ name: "NoExpiry", expiresAt: null });

    const claimed = await processApiKeyExpiryReminders(7, now);
    const claimedIds = claimed.map((k) => k.id);
    for (const k of [farFuture, expired, revoked, reminded, noExpiry]) {
      expect(claimedIds).not.toContain(k.id);
    }
    expect(mine()).toHaveLength(0);
  });

  it("keeps an attempted key claimed when its audit fails and still processes the next claimed key", async () => {
    const first = await makeKey({
      name: "Audit candidate A",
      expiresAt: days(3),
    });
    const second = await makeKey({
      name: "Audit candidate B",
      expiresAt: days(3),
    });
    const privateDetails = `${adminEmail} re_private-key private audit error body`;
    const originalRecordAudit = audit.recordAudit;
    let failedKeyId: string | undefined;
    const writeAudit = vi
      .spyOn(audit, "recordAudit")
      .mockImplementation(async (params) => {
        if (params.organizationId === org.id && !failedKeyId) {
          failedKeyId = params.entityId!;
          throw new Error(privateDetails);
        }
        return originalRecordAudit(params);
      });
    const log = vi.spyOn(logger, "error").mockImplementation(() => {});

    const claimed = await processApiKeyExpiryReminders(7, now);
    expect(claimed.map((key) => key.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
    expect(mine()).toHaveLength(4);
    for (const key of [first, second])
      expect(
        mine().filter((email) => email.subject.includes(key.name)),
      ).toHaveLength(2);
    const records = await db
      .select()
      .from(apiKeysTable)
      .where(inArray(apiKeysTable.id, [first.id, second.id]));
    expect(records).toHaveLength(2);
    expect(
      records.every(
        (key) => key.expiryReminderSentAt?.getTime() === now.getTime(),
      ),
    ).toBe(true);
    expect(
      writeAudit.mock.calls.filter(
        ([params]) => params.organizationId === org.id,
      ),
    ).toHaveLength(2);
    const completedKeyId = [first.id, second.id].find(
      (id) => id !== failedKeyId,
    )!;
    expect(await reminderAudit(completedKeyId)).toMatchObject({
      outcome: "accepted",
      acceptedCount: 2,
    });
    const missingAudit = await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.entityId, failedKeyId!),
          eq(auditEventsTable.action, "api_key.expiry_reminder.processed"),
        ),
      );
    expect(missingAudit).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeyId: failedKeyId,
        outcome: "accepted",
        acceptedCount: 2,
        unknownCount: 0,
        claimRetained: true,
        automaticRetry: false,
        auditRecorded: false,
        operatorReviewRequired: true,
        errorCode: "api_key_expiry_reminder_audit_failed",
      }),
      "api-key expiry reminder: audit write failed; claim retained and remaining keys will continue",
    );
    for (const privateValue of [
      adminEmail,
      "re_private-key",
      "private audit error body",
    ])
      expect(JSON.stringify(log.mock.calls)).not.toContain(privateValue);

    attempted.length = 0;
    const again = await processApiKeyExpiryReminders(
      7,
      new Date(now.getTime() + 60_000),
    );
    expect(again.map((key) => key.id)).not.toContain(first.id);
    expect(again.map((key) => key.id)).not.toContain(second.id);
    expect(myAttempts()).toHaveLength(0);
  });

  it("releases only a pre-send lookup failure and continues processing other claimed keys", async () => {
    const first = await makeKey({
      name: "Lookup candidate A",
      expiresAt: days(3),
    });
    const second = await makeKey({
      name: "Lookup candidate B",
      expiresAt: days(3),
    });
    const log = vi.spyOn(logger, "error").mockImplementation(() => {});
    const lookup = vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error(`${adminEmail} private lookup details`);
    });
    await processApiKeyExpiryReminders(7, now);
    lookup.mockRestore();

    expect(mine()).toHaveLength(2);
    const records = await db
      .select()
      .from(apiKeysTable)
      .where(inArray(apiKeysTable.id, [first.id, second.id]));
    const released = records.find((key) => key.expiryReminderSentAt === null)!;
    const completed = records.find((key) => key.expiryReminderSentAt !== null)!;
    expect(released).toBeDefined();
    expect(completed).toBeDefined();
    expect(await reminderAudit(completed.id)).toMatchObject({
      outcome: "accepted",
      acceptedCount: 2,
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKeyId: released.id,
        outcome: "not_attempted",
        errorCode: "api_key_expiry_reminder_recipient_lookup_failed",
      }),
      "api-key expiry reminder: recipient lookup failed before any send",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(adminEmail);
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "private lookup details",
    );

    sent.length = 0;
    attempted.length = 0;
    const retried = await processApiKeyExpiryReminders(
      7,
      new Date(now.getTime() + 60_000),
    );
    expect(retried.map((key) => key.id)).toContain(released.id);
    expect(retried.map((key) => key.id)).not.toContain(completed.id);
    expect(myAttempts().sort()).toEqual([adminEmail, ownerEmail]);
    expect(mine().every((email) => email.subject.includes(released.name))).toBe(
      true,
    );
  });

  it.each(["Resend timeout", "unclassified transport error"])(
    "retains the claim after %s and does not replay on the next tick",
    async (kind) => {
      const key = await makeKey({ name: "Outage", expiresAt: days(3) });
      const rawError = new Error(
        "recipient@example.test token=private-token re_private-key message body",
      );
      rawError.name = "private-error-name";
      sendFailure =
        kind === "Resend timeout" ? new ResendSendError("unknown") : rawError;
      const log = vi.spyOn(logger, "warn").mockImplementation(() => {});

      const claimed = await processApiKeyExpiryReminders(7, now);
      expect(claimed.map((k) => k.id)).toContain(key.id);
      expect(mine()).toHaveLength(0);
      expect(myAttempts().sort()).toEqual([adminEmail, ownerEmail]);

      const [afterFail] = await db
        .select()
        .from(apiKeysTable)
        .where(eq(apiKeysTable.id, key.id));
      expect(afterFail.expiryReminderSentAt).toEqual(now);
      const audit = await reminderAudit(key.id);
      expect(audit).toMatchObject({
        outcome: "indeterminate",
        acceptedCount: 0,
        rejectedCount: 0,
        unknownCount: 2,
        claimRetained: true,
        automaticRetry: false,
        deliveryVerified: false,
        reconciliationRequired: true,
        operatorReviewRequired: true,
      });
      const exposed = JSON.stringify({ audit, logs: log.mock.calls });
      for (const privateValue of [
        adminEmail,
        ownerEmail,
        "recipient@example.test",
        "private-token",
        "re_private-key",
        "message body",
        "private-error-name",
      ])
        expect(exposed).not.toContain(privateValue);

      // A healthy provider later cannot establish what happened to the old send.
      sendFailure = undefined;
      attempted.length = 0;
      const retryNow = new Date(now.getTime() + 60 * 1000);
      const retried = await processApiKeyExpiryReminders(7, retryNow);
      expect(retried.map((k) => k.id)).not.toContain(key.id);
      expect(myAttempts()).toHaveLength(0);
      expect(mine()).toHaveLength(0);
    },
  );

  it.each(["unknown", "rejected"] as const)(
    "records partial acceptance plus a %s recipient without replaying either",
    async (failureOutcome) => {
      const key = await makeKey({ name: "Partial", expiresAt: days(3) });
      recipientFailures.set(
        adminEmail,
        new ResendSendError(
          failureOutcome,
          failureOutcome === "rejected" ? 403 : 503,
        ),
      );
      await processApiKeyExpiryReminders(7, now);
      expect(mine().map((value) => value.to)).toEqual([ownerEmail]);
      expect(myAttempts().sort()).toEqual([adminEmail, ownerEmail]);
      expect(await reminderAudit(key.id)).toMatchObject({
        outcome:
          failureOutcome === "unknown" ? "indeterminate" : "partially_accepted",
        acceptedCount: 1,
        unknownCount: failureOutcome === "unknown" ? 1 : 0,
        rejectedCount: failureOutcome === "rejected" ? 1 : 0,
        claimRetained: true,
        automaticRetry: false,
        operatorReviewRequired: true,
        reconciliationRequired: failureOutcome === "unknown",
      });
      recipientFailures.clear();
      attempted.length = 0;
      sent.length = 0;
      const again = await processApiKeyExpiryReminders(
        7,
        new Date(now.getTime() + 60_000),
      );
      expect(again.map((k) => k.id)).not.toContain(key.id);
      expect(myAttempts()).toHaveLength(0);
      expect(mine()).toHaveLength(0);
    },
  );

  it("retains an explicit nonretryable provider rejection for operator review", async () => {
    const key = await makeKey({ name: "Rejected", expiresAt: days(3) });
    sendFailure = new ResendSendError("rejected", 403);
    await processApiKeyExpiryReminders(7, now);
    expect(await reminderAudit(key.id)).toMatchObject({
      outcome: "rejected",
      acceptedCount: 0,
      rejectedCount: 2,
      unknownCount: 0,
      claimRetained: true,
      automaticRetry: false,
      reconciliationRequired: false,
      operatorReviewRequired: true,
    });
    sendFailure = undefined;
    attempted.length = 0;
    const again = await processApiKeyExpiryReminders(
      7,
      new Date(now.getTime() + 60_000),
    );
    expect(again.map((k) => k.id)).not.toContain(key.id);
    expect(myAttempts()).toHaveLength(0);
  });

  it("preserves an uncertain reminder claim when a rename supplies the unchanged expiry", async () => {
    const { updateApiKey } = await import("./api-keys");
    const key = await makeKey({
      name: "Uncertain reminder",
      expiresAt: days(3),
    });
    sendFailure = new ResendSendError("unknown", 503);
    await processApiKeyExpiryReminders(7, now);
    expect(myAttempts()).toHaveLength(2);
    expect(await reminderAudit(key.id)).toMatchObject({
      outcome: "indeterminate",
    });

    const updated = await updateApiKey(org.id, key.id, {
      name: "Renamed key",
      expiresAt: new Date(key.expiresAt!.toISOString()),
    });
    expect(updated?.after.name).toBe("Renamed key");
    expect(updated?.after.expiryReminderSentAt).toEqual(now);
    expect(updated?.after.expiresAt).toEqual(key.expiresAt);
    sendFailure = undefined;
    attempted.length = 0;
    const again = await processApiKeyExpiryReminders(
      7,
      new Date(now.getTime() + 60_000),
    );
    expect(again.map((value) => value.id)).not.toContain(key.id);
    expect(myAttempts()).toHaveLength(0);
  });

  it("preserves a newer matching claim even when the initial expiry snapshot is stale", async () => {
    const { updateApiKey } = await import("./api-keys");
    const key = await makeKey({
      name: "Concurrent expiry",
      expiresAt: days(3),
      expiryReminderSentAt: now,
    });
    const newExpiry = days(5);
    const interveningClaim = new Date(now.getTime() + 1_000);
    await db
      .update(apiKeysTable)
      .set({ expiresAt: newExpiry, expiryReminderSentAt: interveningClaim })
      .where(eq(apiKeysTable.id, key.id));
    // Inject only an old initial SELECT result; execute the actual UPDATE
    // against the newer stored row. This checks the stale-snapshot boundary
    // without claiming independent-session concurrency evidence from PGlite.
    vi.spyOn(db, "select").mockReturnValueOnce({
      from: () => ({ where: async () => [key] }),
    } as unknown as ReturnType<typeof db.select>);
    const updated = await updateApiKey(org.id, key.id, {
      name: "Saved",
      expiresAt: newExpiry,
    });
    expect(updated?.before.expiresAt).toEqual(key.expiresAt);
    expect(updated?.after.expiresAt).toEqual(newExpiry);
    expect(updated?.after.expiryReminderSentAt).toEqual(interveningClaim);
  });

  it("releases a claim when there are no recipients and may send after admins return", async () => {
    const key = await makeKey({ name: "No recipients", expiresAt: days(3) });
    await db
      .update(usersTable)
      .set({ isActive: false })
      .where(inArray(usersTable.id, userIds));
    await processApiKeyExpiryReminders(7, now);
    expect(myAttempts()).toHaveLength(0);
    const [released] = await db
      .select()
      .from(apiKeysTable)
      .where(eq(apiKeysTable.id, key.id));
    expect(released.expiryReminderSentAt).toBeNull();
    await db
      .update(usersTable)
      .set({ isActive: true })
      .where(inArray(usersTable.id, userIds));
    await processApiKeyExpiryReminders(7, new Date(now.getTime() + 60_000));
    expect(myAttempts().sort()).toEqual([adminEmail, ownerEmail]);
  });

  it.each(["hold", "missing configuration"])(
    "releases a known pre-dispatch %s without invoking the provider",
    async (reason) => {
      const key = await makeKey({ name: "Pre-dispatch", expiresAt: days(3) });
      if (reason === "hold") vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
      else {
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("RESEND_API_KEY", "");
        vi.stubEnv("RESEND_FROM_EMAIL", "");
      }
      await processApiKeyExpiryReminders(7, now);
      expect(myAttempts()).toHaveLength(0);
      const [released] = await db
        .select()
        .from(apiKeysTable)
        .where(eq(apiKeysTable.id, key.id));
      expect(released.expiryReminderSentAt).toBeNull();
      vi.unstubAllEnvs();
      await processApiKeyExpiryReminders(7, new Date(now.getTime() + 60_000));
      expect(myAttempts().sort()).toEqual([adminEmail, ownerEmail]);
    },
  );

  it("sends a fresh reminder after an admin changes the key's expiry", async () => {
    const { updateApiKey } = await import("./api-keys");
    const key = await makeKey({ name: "Extended", expiresAt: days(3) });

    // First reminder for the original expiry.
    await processApiKeyExpiryReminders(7, now);
    sent.length = 0;

    // Admin extends the key; the sent marker is cleared.
    const updated = await updateApiKey(org.id, key.id, { expiresAt: days(60) });
    expect(updated?.after.expiryReminderSentAt).toBeNull();

    // Outside the window: no reminder yet.
    const early = await processApiKeyExpiryReminders(7, now);
    expect(early.map((k) => k.id)).not.toContain(key.id);
    expect(sent).toHaveLength(0);

    // As the new expiry approaches, exactly one fresh reminder goes out.
    const later = days(55);
    const claimed = await processApiKeyExpiryReminders(7, later);
    expect(claimed.map((k) => k.id)).toContain(key.id);
    expect(sent.length).toBeGreaterThan(0);

    sent.length = 0;
    const again = await processApiKeyExpiryReminders(7, later);
    expect(again.map((k) => k.id)).not.toContain(key.id);
    expect(sent).toHaveLength(0);
  });
});
