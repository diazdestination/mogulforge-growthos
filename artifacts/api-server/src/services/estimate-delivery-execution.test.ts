import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  db,
  auditEventsTable,
  activitiesTable,
  estimatesTable,
  leadsTable,
  orgSettingsTable,
  emailSenderPreferencesTable,
  gmailConnectionsTable,
  revenueExecutionsTable,
  revenueExecutionEventsTable,
  usersTable,
  customerLifecycleTable,
  emailIntelligenceSourcesTable,
  emailResponseReviewsTable,
} from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  returningCustomerFixture,
  returningEstimateDraft,
} from "../test-helpers/returning-customer-fixture";
import { createEstimate, updateEstimate } from "./crm";
import {
  createCustomerWorkEstimate,
  updateCustomerWorkEstimate,
} from "./returning-customer";
import { readEstimateEmailAuthority } from "./estimate-delivery-authority";
import { estimateDeliveryFingerprint } from "./estimate-delivery-contract";
import * as history from "./estimate-delivery-history";
import {
  claimEstimateEmail,
  assertEstimateEmailDispatch,
  finalizeEstimateEmail,
} from "./estimate-delivery-execution";

const orgs: string[] = [];
beforeEach(() => {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "synthetic");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "synthetic");
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubGlobal("fetch", () => {
    throw Error("No external transport in kernel tests");
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => deleteTestOrgs(...orgs));
async function fixture(returning = false) {
  const f = await returningCustomerFixture();
  orgs.push(f.org);
  await db
    .insert(orgSettingsTable)
    .values({ organizationId: f.org, customerEmailSenderUserId: f.office.id });
  await db
    .insert(emailSenderPreferencesTable)
    .values({ organizationId: f.org, userId: f.office.id, provider: "gmail" });
  await db.insert(gmailConnectionsTable).values({
    organizationId: f.org,
    userId: f.office.id,
    email: "office@example.test",
    encryptedRefreshToken: "synthetic-never-decrypted",
    grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
  });
  const [lead] = await db
    .insert(leadsTable)
    .values({
      organizationId: f.org,
      contactId: f.contact.id,
      propertyId: f.secondProperty.id,
      source: "manual",
    })
    .returning();
  const draft = returningEstimateDraft(f);
  const estimate = returning
    ? (await createCustomerWorkEstimate(f.org, f.actor, draft)).estimate
    : (await createEstimate(
        f.org,
        {
          leadId: lead.id,
          title: draft.title,
          lineItems: draft.lineItems.map((x) => ({ ...x, totalCents: 10000 })),
          notes: draft.notes,
        },
        f.actor,
      ))!;
  return { ...f, lead, estimate, draft };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function review(f: Fixture) {
  const snapshot = await db.transaction((tx) =>
    readEstimateEmailAuthority(tx, f.org, f.actor, f.estimate.id, true),
  );
  const payloadSha256 = estimateDeliveryFingerprint(snapshot),
    now = new Date();
  const [row] = await db
    .insert(auditEventsTable)
    .values({
      organizationId: f.org,
      actorUserId: f.actor.userId,
      action: "estimate_delivery.previewed",
      entityType: "estimate",
      entityId: f.estimate.id,
      createdAt: now,
      metadata: {
        version: 1,
        payloadSha256,
        expiresAt: new Date(now.getTime() + 600000).toISOString(),
        snapshot,
      },
    })
    .returning();
  return { previewId: row.id, payloadSha256, confirmed: true as const };
}
const claim = async (f: Fixture) =>
  claimEstimateEmail(f.org, f.actor, f.estimate.id, await review(f));
const accepted = () => ({
  state: "accepted" as const,
  receipt: {
    id: "synthetic-message",
    provider: "gmail" as const,
    senderEmail: "office@example.test",
    acceptance: "accepted" as const,
  },
  acceptedAt: new Date(),
});
const row = async (f: Fixture) =>
  (
    await db
      .select()
      .from(estimatesTable)
      .where(eq(estimatesTable.id, f.estimate.id))
  )[0]!;
const audits = (f: Fixture, action: string) =>
  db
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.entityId, f.estimate.id),
        eq(auditEventsTable.action, action),
      ),
    );

it.each([false, true])(
  "claims and atomically retains accepted original quote for returning=%s",
  async (returning) => {
    const f = await fixture(returning),
      c = await claim(f);
    await assertEstimateEmailDispatch(c);
    const outcome = accepted();
    await finalizeEstimateEmail(c, outcome);
    await finalizeEstimateEmail(c, outcome);
    expect(
      (await audits(f, "estimate_delivery.provider_accepted")).length,
    ).toBe(1);
    expect((await row(f)).status).toBe("sent");
    expect((await row(f)).workVersion).toBe(returning ? 2 : null);
    const activity = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.organizationId, f.org),
          eq(activitiesTable.type, "estimate_email_accepted"),
        ),
      );
    expect(activity).toHaveLength(1);
    expect(activity[0].leadId).toBe(returning ? null : f.lead.id);
    expect(activity[0].contactId).toBe(f.contact.id);
    expect(JSON.stringify(activity)).not.toMatch(
      /payloadSha256|previewId|senderIdentitySha256|synthetic-never/,
    );
    const saved = await audits(f, "estimate.saved_state");
    expect(saved.at(-1)?.metadata.intact).toBe(true);
    if (returning) {
      const { source: _source, ...edit } = f.draft;
      await expect(
        updateCustomerWorkEstimate(f.org, f.actor, f.estimate.id, {
          ...edit,
          requestId: randomUUID(),
          expectedWorkVersion: 1,
          status: "draft",
        }),
      ).rejects.toBeDefined();
    }
  },
);
it.each([
  "blocked",
  "indeterminate",
  "confirmed_not_performed",
  "confirmed_succeeded",
  "succeeded",
  "processing",
] as const)(
  "never rearms permanent ownership after %s or expiry",
  async (state) => {
    const f = await fixture(),
      p1 = await review(f),
      p2 = await review(f),
      c = await claimEstimateEmail(f.org, f.actor, f.estimate.id, p1);
    await db
      .update(revenueExecutionsTable)
      .set({ state, expiresAt: new Date(0) })
      .where(eq(revenueExecutionsTable.id, c.executionId));
    await expect(
      claimEstimateEmail(f.org, f.actor, f.estimate.id.toUpperCase(), p2),
    ).rejects.toMatchObject({ code: "estimate_delivery_reserved" });
    await expect(assertEstimateEmailDispatch(c)).rejects.toBeDefined();
  },
);
it.each(["actor", "tenant", "target", "hash", "metadata", "expiry"] as const)(
  "rejects mismatched review %s before claiming",
  async (kind) => {
    const f = await fixture(),
      p = await review(f);
    if (kind === "hash") p.payloadSha256 = "a".repeat(64);
    if (kind === "metadata")
      await db
        .update(auditEventsTable)
        .set({ metadata: { version: 1 } })
        .where(eq(auditEventsTable.id, p.previewId));
    if (kind === "expiry") {
      const [a] = await audits(f, "estimate_delivery.previewed");
      const t = new Date(Date.now() - 600000);
      await db
        .update(auditEventsTable)
        .set({
          createdAt: t,
          metadata: {
            ...a.metadata,
            expiresAt: new Date(t.getTime() + 600000).toISOString(),
          },
        })
        .where(eq(auditEventsTable.id, p.previewId));
    }
    await expect(
      claimEstimateEmail(
        kind === "tenant" ? randomUUID() : f.org,
        kind === "actor" ? { userId: f.office.id } : f.actor,
        kind === "target" ? randomUUID() : f.estimate.id,
        p,
      ),
    ).rejects.toBeDefined();
    expect(
      await db
        .select()
        .from(revenueExecutionsTable)
        .where(eq(revenueExecutionsTable.organizationId, f.org)),
    ).toHaveLength(0);
  },
);
it("normalizes an explicitly absent effective role through durable JSON", async () => {
  const f = await fixture(),
    p = await review(f);
  const c = await claimEstimateEmail(
    f.org,
    { userId: f.owner.id, effectiveRole: undefined },
    f.estimate.id,
    p,
  );
  await assertEstimateEmailDispatch(c);
});
it("legacy claim bridge rolls back on failure and never anchors ambiguous history", async () => {
  const f = await fixture(true);
  await legacy(f);
  const p = await review(f);
  const original = history.recordEstimateSavedState;
  const writer = vi
    .spyOn(history, "recordEstimateSavedState")
    .mockImplementationOnce(async (...args) => {
      await original(...args);
      throw Error("Synthetic bridge failure");
    });
  await expect(
    claimEstimateEmail(f.org, f.actor, f.estimate.id, p),
  ).rejects.toThrow("Synthetic bridge failure");
  writer.mockRestore();
  expect(await audits(f, "estimate.saved_state")).toHaveLength(0);
  expect(await audits(f, "estimate_delivery.admitted")).toHaveLength(0);
  expect(
    await db
      .select()
      .from(revenueExecutionsTable)
      .where(eq(revenueExecutionsTable.organizationId, f.org)),
  ).toHaveLength(0);
  await db.insert(auditEventsTable).values({
    organizationId: f.org,
    actorUserId: f.owner.id,
    entityType: "estimate",
    entityId: f.estimate.id,
    action: "unknown_legacy_mutation",
  });
  await expect(
    claimEstimateEmail(f.org, f.actor, f.estimate.id, p),
  ).rejects.toMatchObject({ code: "estimate_history_held" });
  expect(await audits(f, "estimate.saved_state")).toHaveLength(0);
});
it("an expired valid legacy review remains a non-effect but cannot authorize admission", async () => {
  const f = await fixture(true);
  await legacy(f);
  const p = await review(f),
    [a] = await audits(f, "estimate_delivery.previewed");
  vi.spyOn(Date, "now").mockReturnValue(a.createdAt.getTime() + 600000);
  await history.assertEstimateCleanHistory(db, f.org, await row(f));
  await expect(
    claimEstimateEmail(f.org, f.actor, f.estimate.id, p),
  ).rejects.toMatchObject({ code: "estimate_review_expired" });
  expect(await audits(f, "estimate.saved_state")).toHaveLength(0);
});
it.each(["actor", "hash", "snapshot", "execution"] as const)(
  "rejects tampered claim %s",
  async (kind) => {
    const f = await fixture(),
      c = await claim(f),
      bad = structuredClone(c);
    if (kind === "actor") bad.actor.userId = f.office.id;
    if (kind === "hash") bad.payloadSha256 = "b".repeat(64);
    if (kind === "snapshot") bad.snapshot.contactId = f.otherContact.id;
    if (kind === "execution") bad.executionId = randomUUID();
    await expect(assertEstimateEmailDispatch(bad)).rejects.toBeDefined();
    await expect(finalizeEstimateEmail(bad, accepted())).rejects.toBeDefined();
    expect(await audits(f, "estimate_delivery.provider_accepted")).toHaveLength(
      0,
    );
  },
);
it.each(["admission", "event", "execution"] as const)(
  "fails closed on retained %s foreign linkage",
  async (kind) => {
    const f = await fixture(),
      other = await fixture(),
      c = await claim(f);
    if (kind === "admission") {
      const [a] = await audits(f, "estimate_delivery.admitted");
      await db
        .update(auditEventsTable)
        .set({ organizationId: other.org })
        .where(eq(auditEventsTable.id, a.id));
    }
    if (kind === "event")
      await db
        .update(revenueExecutionEventsTable)
        .set({ organizationId: other.org })
        .where(eq(revenueExecutionEventsTable.executionId, c.executionId));
    if (kind === "execution")
      await db
        .update(revenueExecutionsTable)
        .set({ actionKey: "wrong-key" })
        .where(eq(revenueExecutionsTable.id, c.executionId));
    await expect(assertEstimateEmailDispatch(c)).rejects.toBeDefined();
    await expect(finalizeEstimateEmail(c, accepted())).rejects.toBeDefined();
    // Restore cross-org rows so ordinary synthetic cleanup remains correctly ordered.
    if (kind === "event")
      await db
        .update(revenueExecutionEventsTable)
        .set({ organizationId: f.org })
        .where(eq(revenueExecutionEventsTable.executionId, c.executionId));
  },
);
it.each([false, true])(
  "retains original evidence while preserving later edits/accepted status returning=%s",
  async (returning) => {
    const f = await fixture(returning),
      c = await claim(f);
    if (returning) {
      const { source: _source, ...edit } = f.draft;
      await updateCustomerWorkEstimate(f.org, f.actor, f.estimate.id, {
        ...edit,
        requestId: randomUUID(),
        expectedWorkVersion: 1,
        status: "accepted",
        notes: "Later synthetic notes",
      });
    } else
      await updateEstimate(
        f.org,
        f.estimate.id,
        { status: "accepted", notes: "Later synthetic notes" },
        f.actor,
      );
    const before = await row(f);
    await finalizeEstimateEmail(c, accepted());
    const after = await row(f);
    expect(after).toEqual(before);
    expect(
      (await audits(f, "estimate_delivery.provider_accepted"))[0].metadata
        .snapshot,
    ).toEqual(c.snapshot);
  },
);
it("retains acceptance after role/company pause and late reconciliation without changing terminal state", async () => {
  const f = await fixture(),
    c = await claim(f);
  await db
    .update(usersTable)
    .set({ isActive: false })
    .where(eq(usersTable.id, f.owner.id));
  await db.insert(customerLifecycleTable).values({
    organizationId: f.org,
    state: "paused",
    reason: "Synthetic pause",
  });
  await db
    .update(revenueExecutionsTable)
    .set({ state: "confirmed_not_performed" })
    .where(eq(revenueExecutionsTable.id, c.executionId));
  await finalizeEstimateEmail(c, accepted());
  expect(
    (
      await db
        .select()
        .from(revenueExecutionsTable)
        .where(eq(revenueExecutionsTable.id, c.executionId))
    )[0].state,
  ).toBe("confirmed_not_performed");
  expect(await audits(f, "estimate_delivery.provider_accepted")).toHaveLength(
    1,
  );
});
it("rolls back receipt/activity/event/status on injected history failure and retains permanent uncertainty", async () => {
  const f = await fixture(true),
    c = await claim(f);
  const priorEvents = await db
    .select()
    .from(revenueExecutionEventsTable)
    .where(eq(revenueExecutionEventsTable.executionId, c.executionId));
  const writer = vi
    .spyOn(history, "recordEstimateSavedState")
    .mockRejectedValueOnce(Error("Synthetic finalization failure"));
  await expect(finalizeEstimateEmail(c, accepted())).rejects.toThrow(
    "Synthetic finalization failure",
  );
  writer.mockRestore();
  expect(await audits(f, "estimate_delivery.provider_accepted")).toHaveLength(
    0,
  );
  expect(
    await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.organizationId, f.org),
          eq(activitiesTable.type, "estimate_email_accepted"),
        ),
      ),
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(revenueExecutionEventsTable)
      .where(eq(revenueExecutionEventsTable.executionId, c.executionId)),
  ).toEqual(priorEvents);
  expect((await row(f)).status).toBe("draft");
  await finalizeEstimateEmail(c, {
    state: "uncertain",
    reason: "Raw provider body must not be retained",
  });
  await expect(claim(f)).rejects.toMatchObject({
    code: "estimate_delivery_reserved",
  });
  await finalizeEstimateEmail(c, accepted());
  expect(
    (
      await db
        .select()
        .from(revenueExecutionsTable)
        .where(eq(revenueExecutionsTable.id, c.executionId))
    )[0].state,
  ).toBe("indeterminate");
});
it("post-OAuth guard independently rejects lead-only reply hold", async () => {
  const f = await fixture(),
    c = await claim(f);
  const [s] = await db
    .insert(emailIntelligenceSourcesTable)
    .values({ organizationId: f.org, intakeAlias: randomUUID() })
    .returning();
  await db.insert(emailResponseReviewsTable).values({
    organizationId: f.org,
    sourceId: s.id,
    externalMessageId: randomUUID(),
    payloadSha256: "a".repeat(64),
    reason: "Synthetic reply",
    state: "confirmed",
    contactId: null,
    leadId: f.lead.id,
    holdActive: true,
  });
  await expect(assertEstimateEmailDispatch(c)).rejects.toMatchObject({
    code: "estimate_email_held",
  });
});
it("holds malformed execution state rather than appending an invalid terminal event", async () => {
  const f = await fixture(),
    c = await claim(f);
  await db
    .update(revenueExecutionsTable)
    .set({ state: "unknown_state" as "processing" })
    .where(eq(revenueExecutionsTable.id, c.executionId));
  await expect(finalizeEstimateEmail(c, accepted())).rejects.toMatchObject({
    code: "estimate_delivery_integrity",
  });
  expect(await audits(f, "estimate_delivery.provider_accepted")).toHaveLength(
    0,
  );
});
it("denies a non-office effective role with the authority error before admission", async () => {
  const f = await fixture(),
    p = await review(f);
  await expect(
    claimEstimateEmail(
      f.org,
      { ...f.actor, effectiveRole: "sales_rep" },
      f.estimate.id,
      p,
    ),
  ).rejects.toMatchObject({ status: 403 });
});
it("does not dispatch again when a terminal event survives a reverted execution row", async () => {
  const f = await fixture(),
    c = await claim(f);
  await finalizeEstimateEmail(c, {
    state: "held",
    reason: "Synthetic refusal",
  });
  await db
    .update(revenueExecutionsTable)
    .set({ state: "processing" })
    .where(eq(revenueExecutionsTable.id, c.executionId));
  await expect(assertEstimateEmailDispatch(c)).rejects.toBeDefined();
});
it.each([false, true])(
  "keeps originally admitted participant activity after a lead relink returning=%s",
  async (returning) => {
    const f = await fixture(returning),
      c = await claim(f);
    await db
      .update(leadsTable)
      .set({ contactId: f.otherContact.id })
      .where(eq(leadsTable.id, f.lead.id));
    await Promise.all([
      finalizeEstimateEmail(c, accepted()),
      finalizeEstimateEmail(c, accepted()),
    ]);
    const rows = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.organizationId, f.org),
          eq(activitiesTable.type, "estimate_email_accepted"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].contactId).toBe(f.contact.id);
    expect(await audits(f, "estimate_delivery.provider_accepted")).toHaveLength(
      1,
    );
  },
);
it("expires the post-OAuth callback at exactly ten minutes without releasing ownership", async () => {
  const f = await fixture(),
    p = await review(f),
    c = await claimEstimateEmail(f.org, f.actor, f.estimate.id, p);
  const [a] = await audits(f, "estimate_delivery.previewed");
  vi.spyOn(Date, "now").mockReturnValue(a.createdAt.getTime() + 600000);
  await expect(assertEstimateEmailDispatch(c)).rejects.toMatchObject({
    code: "estimate_review_expired",
  });
  await expect(
    claimEstimateEmail(f.org, f.actor, f.estimate.id, p),
  ).rejects.toMatchObject({ code: "estimate_delivery_reserved" });
});
it.each(["provider", "mailbox", "raw-body"] as const)(
  "rejects mismatched receipt %s and preserves ownership",
  async (kind) => {
    const f = await fixture(),
      c = await claim(f),
      outcome = accepted();
    const receipt = {
      ...outcome.receipt,
      ...(kind === "provider"
        ? { provider: "microsoft" as const }
        : kind === "mailbox"
          ? { senderEmail: "other@example.test" }
          : { rawBody: "Do not retain provider content" }),
    };
    await expect(
      finalizeEstimateEmail(c, { ...outcome, receipt }),
    ).rejects.toBeDefined();
    expect(await audits(f, "estimate_delivery.provider_accepted")).toHaveLength(
      0,
    );
  },
);
it("reserves a preexisting UUID-cased effect alias permanently", async () => {
  const f = await fixture(),
    p = await review(f),
    c = await claimEstimateEmail(f.org, f.actor, f.estimate.id, p);
  await db
    .update(revenueExecutionsTable)
    .set({
      actionKey: `estimate-delivery:${f.estimate.id.toUpperCase()}:email`,
      state: "confirmed_not_performed",
    })
    .where(eq(revenueExecutionsTable.id, c.executionId));
  await expect(
    claimEstimateEmail(f.org, f.actor, f.estimate.id, p),
  ).rejects.toMatchObject({ code: "estimate_delivery_reserved" });
});
it("never rearms an orphaned retained admission when its generic execution row is missing", async () => {
  const f = await fixture(),
    p = await review(f),
    c = await claimEstimateEmail(f.org, f.actor, f.estimate.id, p);
  await db
    .delete(revenueExecutionEventsTable)
    .where(eq(revenueExecutionEventsTable.executionId, c.executionId));
  await db
    .delete(revenueExecutionsTable)
    .where(eq(revenueExecutionsTable.id, c.executionId));
  const wronglyClaimed = await claimEstimateEmail(
    f.org,
    f.actor,
    f.estimate.id,
    await review(f),
  ).then(
    () => true,
    () => false,
  );
  expect(wronglyClaimed).toBe(false);
});
async function legacy(f: Fixture) {
  await db
    .delete(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.entityId, f.estimate.id),
        eq(auditEventsTable.action, "estimate.saved_state"),
      ),
    );
  const [created] = await audits(f, "customer_work.estimate_created");
  const { savedStateVersion: _version, ...metadata } = created.metadata;
  await db
    .update(auditEventsTable)
    .set({ metadata })
    .where(eq(auditEventsTable.id, created.id));
}
it("legacy returning v1 survives reviewed admission and post-OAuth dispatch without a fabricated staff command", async () => {
  const f = await fixture(true);
  await legacy(f);
  const p = await review(f);
  expect(await audits(f, "estimate.saved_state")).toHaveLength(0);
  const c = await claimEstimateEmail(f.org, f.actor, f.estimate.id, p);
  await assertEstimateEmailDispatch(c);
  await finalizeEstimateEmail(c, accepted());
  expect((await row(f)).status).toBe("sent");
  expect(
    (await audits(f, "estimate.saved_state")).every(
      (a) => a.metadata.anchor === "legacy_returning" && a.metadata.intact,
    ),
  ).toBe(true);
});
it.each([
  "malformed-review",
  "foreign-review",
  "admitted",
  "provider-proof",
] as const)(
  "legacy returning baseline holds %s retained evidence",
  async (kind) => {
    const f = await fixture(true);
    await legacy(f);
    await review(f);
    const [a] = await audits(f, "estimate_delivery.previewed");
    await db
      .update(auditEventsTable)
      .set(
        kind === "malformed-review"
          ? { metadata: { ...a.metadata, extra: true } }
          : kind === "foreign-review"
            ? { actorUserId: f.office.id }
            : {
                action:
                  kind === "admitted"
                    ? "estimate_delivery.admitted"
                    : "estimate_delivery.provider_accepted",
              },
      )
      .where(eq(auditEventsTable.id, a.id));
    await expect(
      history.assertEstimateCleanHistory(db, f.org, await row(f)),
    ).rejects.toMatchObject({ code: "estimate_history_held" });
  },
);
