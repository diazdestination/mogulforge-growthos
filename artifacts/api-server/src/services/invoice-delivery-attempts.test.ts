import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activitiesTable,
  auditEventsTable as audits,
  contactsTable,
  customerLifecycleTable,
  db,
  invoicesTable,
  revenueExecutionsTable as executions,
  revenueExecutionEventsTable as events,
  usersTable,
} from "@workspace/db";
import { invoiceDeliveryAttemptsTable as attempts } from "../../../../lib/db/src/schema/invoice-delivery-attempts";
import {
  invoiceAcceptance,
  invoiceAttemptFixture,
  invoiceAttemptReview,
  type InvoiceAttemptFixture,
} from "../test-helpers/invoice-attempt-fixture";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  assertInvoiceDeliveryAttemptDispatch,
  getInvoiceDeliveryChain,
  getInvoiceDeliveryChains,
  runInvoiceDeliveryAttempt,
  type InvoiceAttemptReview,
} from "./invoice-delivery-attempts";
import {
  deliveryFingerprint,
  invoiceDeliveryKey,
} from "./invoice-delivery-contract";

const orgs: string[] = [];
beforeEach(() => vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false"));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => deleteTestOrgs(...orgs));
async function fixture() {
  const f = await invoiceAttemptFixture();
  orgs.push(f.org);
  return f;
}
const refused = () => ({
  kind: "not_dispatched" as const,
  code: "dispatch_guard_rejected" as const,
});
async function accept(review: InvoiceAttemptReview) {
  return runInvoiceDeliveryAttempt(review, async (claim) => {
    await assertInvoiceDeliveryAttemptDispatch(claim);
    return invoiceAcceptance(review);
  });
}

it("atomically reserves exact ledgers before an effect and records acceptance once without financial mutation", async () => {
  const f = await fixture(),
    review = await invoiceAttemptReview(f);
  let calls = 0;
  const first = await runInvoiceDeliveryAttempt(review, async (claim) => {
    calls++;
    expect(
      await db
        .select()
        .from(attempts)
        .where(eq(attempts.organizationId, f.org)),
    ).toHaveLength(1);
    expect(
      (
        await db
          .select()
          .from(executions)
          .where(eq(executions.id, claim.executionId))
      )[0],
    ).toMatchObject({
      state: "processing",
      fingerprint: claim.executionFingerprint,
      actionKey: invoiceDeliveryKey(f.invoice.id),
    });
    expect(
      await db
        .select()
        .from(events)
        .where(eq(events.executionId, claim.executionId)),
    ).toHaveLength(1);
    await assertInvoiceDeliveryAttemptDispatch(claim);
    return invoiceAcceptance(review);
  });
  expect(first).toMatchObject({
    integrity: "valid",
    attemptCount: 1,
    nextIntents: ["additional_copy"],
    attempts: [
      {
        legacy: false,
        ordinal: 1,
        state: "succeeded",
        proof: "provider_accepted",
        provider: "microsoft",
        providerMessageId: null,
      },
    ],
  });
  await runInvoiceDeliveryAttempt(review, async () => {
    calls++;
    throw new Error("must not replay");
  });
  expect(calls).toBe(1);
  expect(
    await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.organizationId, f.org),
          eq(activitiesTable.type, "email_sent"),
        ),
      ),
  ).toHaveLength(1);
  expect(
    (
      await db
        .select()
        .from(invoicesTable)
        .where(eq(invoicesTable.id, f.invoice.id))
    )[0].version,
  ).toBe(f.invoice.version);
});
it("typed no-dispatch proof unlocks exactly one reviewed successor, then caps all lifetime attempts at five", async () => {
  const f = await fixture(),
    initial = await invoiceAttemptReview(f);
  const blocked = await runInvoiceDeliveryAttempt(initial, async () =>
    refused(),
  );
  expect(blocked).toMatchObject({
    integrity: "valid",
    nextIntents: ["retry_not_dispatched"],
    attempts: [{ proof: "not_dispatched", state: "blocked" }],
  });
  const retry = await invoiceAttemptReview(f),
    stale = await invoiceAttemptReview(f);
  const second = await accept(retry);
  expect(second).toMatchObject({
    attemptCount: 2,
    nextIntents: ["additional_copy"],
  });
  await expect(accept(stale)).rejects.toMatchObject({
    code: "invoice_delivery_head_changed",
  });
  for (let ordinal = 3; ordinal <= 5; ordinal++) {
    const copy = await invoiceAttemptReview(f);
    const page = await accept(copy);
    expect(page.attemptCount).toBe(ordinal);
    expect(page.attempts.at(-1)?.actionKey).toBe(
      `${invoiceDeliveryKey(f.invoice.id)}:attempt:${ordinal}`,
    );
  }
  const full = await getInvoiceDeliveryChain(f.org, f.invoice.id);
  expect(full).toMatchObject({
    attemptCount: 5,
    maxAttempts: 5,
    nextIntents: [],
    attentionReason: "attempt_limit_reached",
  });
  await expect(
    accept(await invoiceAttemptReview(f, "additional_copy")),
  ).rejects.toMatchObject({ code: "invoice_delivery_head_changed" });
  expect(
    await db.select().from(attempts).where(eq(attempts.organizationId, f.org)),
  ).toHaveLength(5);
});
it("an additional copy requires a post-preview acknowledgement and keeps the saved preview false", async () => {
  const f = await fixture();
  await accept(await invoiceAttemptReview(f));
  const copy = await invoiceAttemptReview(f);
  expect(
    (await db.select().from(audits).where(eq(audits.id, copy.previewId)))[0]
      .metadata.duplicateCopyAcknowledged,
  ).toBe(false);
  await expect(
    accept({ ...copy, duplicateCopyAcknowledged: false }),
  ).rejects.toMatchObject({
    code: "invoice_delivery_copy_acknowledgement_required",
  });
  await accept(copy);
  expect(
    (
      await db
        .select()
        .from(attempts)
        .where(and(eq(attempts.organizationId, f.org), eq(attempts.ordinal, 2)))
    )[0].duplicateCopyAcknowledged,
  ).toBe(true);
});
it("ambiguous provider errors cannot manufacture a refusal by supplying effectNotAttempted", async () => {
  const f = await fixture(),
    review = await invoiceAttemptReview(f);
  const result = await runInvoiceDeliveryAttempt(review, async () => {
    throw Object.assign(new Error("Synthetic lost provider receipt"), {
      effectNotAttempted: true,
    });
  });
  expect(result).toMatchObject({
    integrity: "valid",
    nextIntents: [],
    attempts: [{ state: "indeterminate", proof: "none" }],
  });
  expect(
    await db
      .select()
      .from(audits)
      .where(
        and(
          eq(audits.organizationId, f.org),
          eq(audits.action, "invoice_delivery.not_dispatched"),
        ),
      ),
  ).toHaveLength(0);
  await expect(accept(await invoiceAttemptReview(f))).rejects.toMatchObject({
    code: "invoice_delivery_head_changed",
  });
});
it("a lost atomic finalization preserves unknown ownership and cannot create a safe retry", async () => {
  const f = await fixture(),
    review = await invoiceAttemptReview(f);
  let effects = 0;
  const result = await runInvoiceDeliveryAttempt(review, async () => {
    effects++;
    vi.spyOn(db, "transaction").mockRejectedValueOnce(
      new Error("Synthetic commit failure before final receipt"),
    );
    return invoiceAcceptance(review);
  });
  expect(result).toMatchObject({
    nextIntents: [],
    attempts: [{ state: "indeterminate", proof: "none" }],
  });
  await runInvoiceDeliveryAttempt(review, async () => {
    effects++;
    return invoiceAcceptance(review);
  });
  expect(effects).toBe(1);
});
it("an unexpected zero-row final CAS rolls back provider proof and activity before retaining uncertainty", async () => {
  const f = await fixture(),
    review = await invoiceAttemptReview(f);
  let effects = 0;
  const original = db.transaction.bind(db);
  const result = await runInvoiceDeliveryAttempt(review, async () => {
    effects++;
    vi.spyOn(db, "transaction").mockImplementationOnce((callback, config) =>
      original(async (tx) => {
        const update = tx.update.bind(tx);
        vi.spyOn(tx, "update").mockImplementation(((
          table: Parameters<typeof update>[0],
        ) =>
          table === executions
            ? { set: () => ({ where: () => ({ returning: async () => [] }) }) }
            : update(table)) as typeof tx.update);
        return callback(tx);
      }, config),
    );
    return invoiceAcceptance(review);
  });
  expect(result).toMatchObject({
    integrity: "valid",
    nextIntents: [],
    attempts: [{ state: "indeterminate", proof: "none" }],
  });
  expect(
    await db
      .select()
      .from(audits)
      .where(
        and(
          eq(audits.organizationId, f.org),
          eq(audits.action, "invoice_delivery.provider_accepted"),
        ),
      ),
  ).toHaveLength(0);
  expect(
    await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.organizationId, f.org),
          eq(activitiesTable.type, "email_sent"),
        ),
      ),
  ).toHaveLength(0);
  await runInvoiceDeliveryAttempt(review, async () => {
    effects++;
    return invoiceAcceptance(review);
  });
  expect(effects).toBe(1);
});
it("a lost acknowledgement after the atomic commit reads the existing accepted receipt without replay", async () => {
  const f = await fixture(),
    review = await invoiceAttemptReview(f);
  let effects = 0;
  const original = db.transaction.bind(db);
  const result = await runInvoiceDeliveryAttempt(review, async () => {
    effects++;
    vi.spyOn(db, "transaction").mockImplementationOnce(
      async (callback, config) => {
        await original(callback, config);
        throw new Error("Synthetic lost commit acknowledgement");
      },
    );
    return invoiceAcceptance(review);
  });
  expect(result).toMatchObject({
    integrity: "valid",
    nextIntents: ["additional_copy"],
    attempts: [{ state: "succeeded", proof: "provider_accepted" }],
  });
  await runInvoiceDeliveryAttempt(review, async () => {
    effects++;
    return invoiceAcceptance(review);
  });
  expect(effects).toBe(1);
  expect(
    await db
      .select()
      .from(audits)
      .where(
        and(
          eq(audits.organizationId, f.org),
          eq(audits.action, "invoice_delivery.provider_accepted"),
        ),
      ),
  ).toHaveLength(1);
});
it("late provider acceptance is retained without replacing reconciliation or manufacturing copy permission", async () => {
  const f = await fixture(),
    review = await invoiceAttemptReview(f);
  const result = await runInvoiceDeliveryAttempt(review, async (claim) => {
    await db
      .update(executions)
      .set({ state: "confirmed_not_performed" })
      .where(eq(executions.id, claim.executionId));
    return invoiceAcceptance(review);
  });
  expect(result).toMatchObject({
    integrity: "valid",
    nextIntents: [],
    attempts: [
      { state: "confirmed_not_performed", proof: "provider_accepted" },
    ],
  });
});
it("actual acceptance finalizes after actor/lifecycle changes without reclassifying a dispatched message as blocked", async () => {
  const f = await fixture(),
    review = await invoiceAttemptReview(f);
  const result = await runInvoiceDeliveryAttempt(review, async () => {
    await db
      .update(usersTable)
      .set({ isActive: false })
      .where(eq(usersTable.id, f.actor));
    await db.insert(customerLifecycleTable).values({
      organizationId: f.org,
      state: "paused",
      reason: "Synthetic pause after POST",
    });
    return invoiceAcceptance(review);
  });
  expect(result.attempts[0]).toMatchObject({
    state: "succeeded",
    proof: "provider_accepted",
  });
  await expect(accept(await invoiceAttemptReview(f))).rejects.toMatchObject({
    status: 403,
  });
});
it.each(["actor", "invoice", "recipient", "expiry", "lifecycle", "global"])(
  "last dispatch gate blocks late %s change without asserting provider failure",
  async (change) => {
    const f = await fixture(),
      review = await invoiceAttemptReview(f);
    const result = await runInvoiceDeliveryAttempt(review, async (claim) => {
      if (change === "actor")
        await db
          .update(usersTable)
          .set({ emailVerifiedAt: null })
          .where(eq(usersTable.id, f.actor));
      if (change === "invoice")
        await db
          .update(invoicesTable)
          .set({ version: f.invoice.version + 1 })
          .where(eq(invoicesTable.id, f.invoice.id));
      if (change === "recipient")
        await db
          .update(contactsTable)
          .set({ email: "other@example.invalid" })
          .where(eq(contactsTable.id, f.contact));
      if (change === "expiry")
        await db
          .update(executions)
          .set({ expiresAt: new Date(0) })
          .where(eq(executions.id, claim.executionId));
      if (change === "lifecycle")
        await db.insert(customerLifecycleTable).values({
          organizationId: f.org,
          state: "paused",
          reason: "Synthetic late pause",
        });
      if (change === "global") vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
      await expect(
        assertInvoiceDeliveryAttemptDispatch(claim),
      ).rejects.toMatchObject({ effectNotAttempted: true });
      return refused();
    });
    expect(result.attempts[0]).toMatchObject({
      state: "blocked",
      proof: "not_dispatched",
    });
  },
);
async function legacy(
  f: InvoiceAttemptFixture,
  state: "succeeded" | "blocked" | "indeterminate" | "confirmed_not_performed",
  accepted = false,
) {
  const payloadSha256 = deliveryFingerprint({ legacy: f.invoice.id }),
    documentSha256 = deliveryFingerprint(f.invoice.document);
  const [preview] = await db
    .insert(audits)
    .values({
      organizationId: f.org,
      actorUserId: f.actor,
      action: "invoice_delivery.previewed",
      entityType: "invoice",
      entityId: f.invoice.id,
      metadata: {
        payloadSha256,
        documentSha256,
        invoiceVersion: f.invoice.version,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    })
    .returning();
  const [receipt] = await db
    .insert(executions)
    .values({
      organizationId: f.org,
      actionKey: invoiceDeliveryKey(f.invoice.id),
      fingerprint: deliveryFingerprint({
        invoiceId: f.invoice.id,
        previewId: preview.id,
        payloadSha256,
      }),
      kind: "invoice_email",
      actorUserId: f.actor,
      state,
      expiresAt: new Date(0),
      completedAt: new Date(),
      detail:
        "Historical text says no email was sent, but text is not typed proof.",
    })
    .returning();
  if (accepted)
    await db.insert(audits).values({
      organizationId: f.org,
      actorUserId: f.actor,
      action: "invoice_delivery.provider_accepted",
      entityType: "invoice",
      entityId: f.invoice.id,
      metadata: {
        provider: "microsoft",
        providerMessageId: null,
        providerRequestId: "historical-request",
        senderEmail: "office@example.invalid",
        senderUserId: f.actor,
        acceptance: "accepted",
        deliveryConfirmed: false,
        invoiceId: f.invoice.id,
        invoiceNumber: f.invoice.invoiceNumber,
        previewId: preview.id,
        payloadSha256,
        documentSha256,
      },
    });
  return receipt;
}
it("an exact legacy accepted receipt remains visible but hash-only preview cannot authorize a new copy", async () => {
  const f = await fixture();
  const receipt = await legacy(f, "succeeded", true);
  expect(await getInvoiceDeliveryChain(f.org, f.invoice.id)).toMatchObject({
    integrity: "valid",
    attemptCount: 1,
    latestExecutionId: receipt.id,
    nextIntents: [],
    attentionReason: "legacy_review_identity_unavailable",
    attempts: [
      {
        legacy: true,
        attemptId: null,
        ordinal: 1,
        state: "succeeded",
        proof: "provider_accepted",
      },
    ],
  });
  await expect(
    accept(await invoiceAttemptReview(f, "additional_copy")),
  ).rejects.toMatchObject({ code: "invoice_delivery_head_changed" });
  expect(
    await db.select().from(attempts).where(eq(attempts.organizationId, f.org)),
  ).toHaveLength(0);
});
it.each([
  "blocked",
  "indeterminate",
  "confirmed_not_performed",
  "succeeded",
] as const)(
  "legacy %s without exact accepted proof is never retry authority",
  async (state) => {
    const f = await fixture();
    await legacy(f, state);
    expect(await getInvoiceDeliveryChain(f.org, f.invoice.id)).toMatchObject({
      integrity: "valid",
      attemptCount: 1,
      nextIntents: [],
      attempts: [{ proof: "none" }],
    });
    await expect(accept(await invoiceAttemptReview(f))).rejects.toMatchObject({
      code: "invoice_delivery_head_changed",
    });
  },
);
it.each(["review", "proof", "duplicateProof", "orphan", "receiptFingerprint"])(
  "fails closed on corrupt %s evidence instead of selecting an older usable head",
  async (change) => {
    const f = await fixture(),
      review = await invoiceAttemptReview(f);
    await runInvoiceDeliveryAttempt(review, async () => refused());
    if (change === "review")
      await db
        .update(audits)
        .set({ metadata: { bad: true } })
        .where(eq(audits.id, review.previewId));
    if (change === "proof" || change === "duplicateProof") {
      const [proof] = await db
        .select()
        .from(audits)
        .where(
          and(
            eq(audits.organizationId, f.org),
            eq(audits.action, "invoice_delivery.not_dispatched"),
          ),
        );
      if (change === "proof")
        await db
          .update(audits)
          .set({ metadata: { ...proof.metadata, phase: "after_provider" } })
          .where(eq(audits.id, proof.id));
      else await db.insert(audits).values({ ...proof, id: randomUUID() });
    }
    if (change === "orphan")
      await db.insert(executions).values({
        organizationId: f.org,
        actionKey: `${invoiceDeliveryKey(f.invoice.id)}:attempt:3`,
        fingerprint: "a".repeat(64),
        kind: "invoice_email",
        actorUserId: f.actor,
        expiresAt: new Date(),
      });
    if (change === "receiptFingerprint") {
      const [proof] = await db
        .select()
        .from(audits)
        .where(
          and(
            eq(audits.organizationId, f.org),
            eq(audits.action, "invoice_delivery.not_dispatched"),
          ),
        );
      await db
        .update(audits)
        .set({
          metadata: { ...proof.metadata, executionFingerprint: "c".repeat(64) },
        })
        .where(eq(audits.id, proof.id));
    }
    expect(await getInvoiceDeliveryChain(f.org, f.invoice.id)).toMatchObject({
      integrity: "unavailable",
      nextIntents: [],
    });
  },
);
it("exact invoice, actor, review, receipt and predecessor/proof FKs prevent tenant or null escape", async () => {
  const a = await fixture(),
    b = await fixture();
  await runInvoiceDeliveryAttempt(await invoiceAttemptReview(a), async () =>
    refused(),
  );
  await runInvoiceDeliveryAttempt(await invoiceAttemptReview(a), async () =>
    refused(),
  );
  const rows = await db
    .select()
    .from(attempts)
    .where(eq(attempts.organizationId, a.org));
  const initial = rows.find((row) => row.ordinal === 1)!,
    successor = rows.find((row) => row.ordinal === 2)!;
  for (const patch of [
    { organizationId: b.org },
    { invoiceId: b.invoice.id },
    { actorUserId: b.actor },
    { predecessorExecutionId: null },
    { predecessorProofId: null },
    { predecessorActionKey: null },
  ])
    await expect(
      db.update(attempts).set(patch).where(eq(attempts.id, successor.id)),
    ).rejects.toThrow();
  await expect(
    db
      .update(attempts)
      .set({ ordinal: 6 })
      .where(eq(attempts.id, successor.id)),
  ).rejects.toThrow();
  await expect(
    db
      .update(attempts)
      .set({ intent: "additional_copy", duplicateCopyAcknowledged: false })
      .where(eq(attempts.id, successor.id)),
  ).rejects.toThrow();
  expect(
    (await getInvoiceDeliveryChains(b.org, [a.invoice.id])).get(a.invoice.id),
  ).toMatchObject({ integrity: "unavailable", attempts: [] });
  expect(initial.predecessorExecutionId).toBeNull();
});
describe.skipIf(process.env.SCHEDULER_TEST_BACKEND === "pglite")(
  "independent PostgreSQL invoice attempt races",
  () => {
    it.each(["initial", "successor"])(
      "allows one concurrent %s claim across distinct reviewed requests",
      async (kind) => {
        const f = await fixture();
        if (kind === "successor")
          await runInvoiceDeliveryAttempt(
            await invoiceAttemptReview(f),
            async () => refused(),
          );
        const a = await invoiceAttemptReview(f),
          b = await invoiceAttemptReview(f);
        let calls = 0;
        const results = await Promise.allSettled(
          [a, b].map((review) =>
            runInvoiceDeliveryAttempt(review, async () => {
              calls++;
              return invoiceAcceptance(review);
            }),
          ),
        );
        expect(calls).toBe(1);
        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
          (await getInvoiceDeliveryChain(f.org, f.invoice.id)).attemptCount,
        ).toBe(kind === "initial" ? 1 : 2);
      },
    );
  },
);
