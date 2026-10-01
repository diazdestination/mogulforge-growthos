/**
 * Proves that when an IP crosses the invalid-API-key threshold, active
 * org owners/admins are emailed (in addition to the audit event), and that
 * inactive users, non-admin roles, and unusable mailboxes are skipped.
 *
 * The alert fans out to every org with an active API key, so assertions
 * filter the captured sends down to this test's unique recipient addresses.
 */
import {
  apiKeysTable,
  db,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { logger } from "../lib/logger";
import { ResendSendError } from "./resend-delivery";

process.env.SESSION_SECRET ??= "test-session-secret";

const sent: { to: string; subject: string; body: string }[] = [];
let sendFailure: unknown;

vi.mock("./providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers")>();
  return {
    ...actual,
    transactionalEmailProvider: {
      send: async (to: string, subject: string, body: string) => {
        sent.push({ to, subject, body });
        if (sendFailure !== undefined) throw sendFailure;
        return { id: "mock", provider: "mock" };
      },
    },
  };
});

const { reportApiKeyBruteForceBlock, reportCallbackBruteForceBlock } =
  await import("./security-alerts");

const stamp = Date.now();
const adminEmail = `bf-alert-admin-${stamp}@example.com`;
const ownerEmail = `bf-alert-owner-${stamp}@example.com`;
const inactiveEmail = `bf-alert-inactive-${stamp}@example.com`;
const repEmail = `bf-alert-rep-${stamp}@example.com`;
const ourEmails = new Set([adminEmail, ownerEmail, inactiveEmail, repEmail]);

let orgId: string;
const userIds: string[] = [];
const keyIds: string[] = [];

beforeAll(async () => {
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: "BF Email Org", slug: `bf-email-${stamp}` })
    .returning();
  orgId = org.id;
  const users = await db
    .insert(usersTable)
    .values([
      {
        id: `bf-admin-${stamp}`,
        email: adminEmail,
        organizationId: orgId,
        role: "admin",
      },
      {
        id: `bf-owner-${stamp}`,
        email: ownerEmail,
        organizationId: orgId,
        role: "owner",
      },
      {
        id: `bf-inactive-${stamp}`,
        email: inactiveEmail,
        organizationId: orgId,
        role: "admin",
        isActive: false,
      },
      {
        id: `bf-rep-${stamp}`,
        email: repEmail,
        organizationId: orgId,
        role: "sales_rep",
      },
    ])
    .returning();
  userIds.push(...users.map((u) => u.id));
  // The org must hold an active API key to be alerted.
  const [key] = await db
    .insert(apiKeysTable)
    .values({
      organizationId: orgId,
      name: "bf alert key",
      prefix: "pk_bf",
      keyHash: `hash-bf-${stamp}`,
      createdByUserId: users[0].id,
    })
    .returning();
  keyIds.push(key.id);
});

afterAll(async () => {
  await deleteTestOrgs(orgId);
});

beforeEach(() => {
  sent.length = 0;
  sendFailure = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("security alert email failures", () => {
  it.each([
    ["api_key", "raw"],
    ["login", "raw"],
    ["api_key", "Resend"],
    ["login", "Resend"],
  ] as const)(
    "redacts %s %s failures without replaying recipients",
    async (context, failureKind) => {
      const privateDetails = `${adminEmail} ${ownerEmail} token=private-token re_private-key private message body`;
      const rawError = new Error(privateDetails, {
        cause: { body: privateDetails },
      });
      rawError.name = privateDetails;
      sendFailure =
        failureKind === "Resend"
          ? new ResendSendError("unknown", 503)
          : rawError;
      const log = vi.spyOn(logger, "error").mockImplementation(() => {});
      const report =
        context === "api_key"
          ? reportApiKeyBruteForceBlock
          : reportCallbackBruteForceBlock;
      await expect(
        report({ ip: "203.0.113.99", windowMs: 900_000, maxFailures: 10 }),
      ).resolves.toBeUndefined();
      expect(
        sent
          .filter((value) => ourEmails.has(value.to))
          .map((value) => value.to)
          .sort(),
      ).toEqual([adminEmail, ownerEmail].sort());
      const ownLogs = log.mock.calls.filter(
        ([entry]) =>
          typeof entry === "object" &&
          entry !== null &&
          "organizationId" in entry &&
          entry.organizationId === orgId,
      );
      expect(ownLogs).toHaveLength(2);
      for (const [entry, message] of ownLogs) {
        expect(entry).toEqual({
          organizationId: orgId,
          context,
          errorCode:
            failureKind === "Resend"
              ? "resend_send_outcome_unknown"
              : "security_alert_email_unconfirmed",
          outcome: "unknown",
          httpStatus: failureKind === "Resend" ? 503 : undefined,
        });
        expect(message).toMatch(
          /not confirmed; check delivery before another send/,
        );
      }
      const exposed = JSON.stringify(log.mock.calls);
      for (const privateValue of [
        adminEmail,
        ownerEmail,
        "private-token",
        "re_private-key",
        "private message body",
      ])
        expect(exposed).not.toContain(privateValue);
    },
  );
});

describe("brute-force block emails org admins", () => {
  it("emails active owners/admins once, skipping inactive and non-admin users", async () => {
    await reportApiKeyBruteForceBlock({
      ip: "203.0.113.77",
      windowMs: 15 * 60 * 1000,
      maxFailures: 10,
    });
    const ours = sent.filter((s) => ourEmails.has(s.to));
    expect(ours.map((s) => s.to).sort()).toEqual(
      [adminEmail, ownerEmail].sort(),
    );
    for (const mail of ours) {
      expect(mail.subject).toMatch(/api key/i);
      expect(mail.body).toContain("203.0.113.77");
      expect(mail.body).toContain("10 invalid API key attempts");
      expect(mail.body).toContain("15 minutes");
    }
  });

  it("skips orgs without an active API key", async () => {
    await db
      .update(apiKeysTable)
      .set({ isActive: false })
      .where(eq(apiKeysTable.id, keyIds[0]));
    try {
      await reportApiKeyBruteForceBlock({
        ip: "203.0.113.78",
        windowMs: 15 * 60 * 1000,
        maxFailures: 10,
      });
      expect(sent.filter((s) => ourEmails.has(s.to))).toHaveLength(0);
    } finally {
      await db
        .update(apiKeysTable)
        .set({ isActive: true })
        .where(eq(apiKeysTable.id, keyIds[0]));
    }
  });
});

describe("reportCallbackBruteForceBlock emails org admins about login attacks", () => {
  it("emails active owners/admins, skipping inactive and non-admin users", async () => {
    await reportCallbackBruteForceBlock({
      ip: "203.0.113.90",
      windowMs: 15 * 60 * 1000,
      maxFailures: 10,
    });
    const ours = sent.filter((s) => ourEmails.has(s.to));
    expect(ours.map((s) => s.to).sort()).toEqual(
      [adminEmail, ownerEmail].sort(),
    );
    for (const mail of ours) {
      expect(mail.subject).toMatch(/login/i);
      expect(mail.body).toContain("203.0.113.90");
      expect(mail.body).toContain("10 failed login attempts");
      expect(mail.body).toContain("15 minutes");
    }
  });

  it("records an auth.brute_force_blocked audit event for the org", async () => {
    const { auditEventsTable } = await import("@workspace/db");
    const { and, eq, sql } = await import("drizzle-orm");

    await reportCallbackBruteForceBlock({
      ip: "203.0.113.91",
      windowMs: 15 * 60 * 1000,
      maxFailures: 10,
    });

    const events = await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, orgId),
          eq(auditEventsTable.action, "auth.brute_force_blocked"),
          sql`${auditEventsTable.metadata} ->> 'ip' = ${"203.0.113.91"}`,
        ),
      );
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].entityType).toBe("session");
  });

  it("skips orgs without an active API key", async () => {
    const { auditEventsTable } = await import("@workspace/db");
    const { and, eq, sql } = await import("drizzle-orm");

    // Deactivate the org's API key so it is excluded from the fan-out.
    await db
      .update(apiKeysTable)
      .set({ isActive: false })
      .where(eq(apiKeysTable.id, keyIds[0]));
    try {
      await reportCallbackBruteForceBlock({
        ip: "203.0.113.92",
        windowMs: 15 * 60 * 1000,
        maxFailures: 10,
      });
      // No emails to our test addresses.
      expect(sent.filter((s) => ourEmails.has(s.to))).toHaveLength(0);
      // No audit row for our org.
      const events = await db
        .select()
        .from(auditEventsTable)
        .where(
          and(
            eq(auditEventsTable.organizationId, orgId),
            eq(auditEventsTable.action, "auth.brute_force_blocked"),
            sql`${auditEventsTable.metadata} ->> 'ip' = ${"203.0.113.92"}`,
          ),
        );
      expect(events).toHaveLength(0);
    } finally {
      await db
        .update(apiKeysTable)
        .set({ isActive: true })
        .where(eq(apiKeysTable.id, keyIds[0]));
    }
  });
});
