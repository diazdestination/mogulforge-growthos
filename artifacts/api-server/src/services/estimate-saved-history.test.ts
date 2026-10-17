import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditEventsTable,
  customerWorkCommandsTable,
  db,
  estimatesTable,
  leadsTable,
  type Estimate,
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
import * as history from "./estimate-delivery-history";
import { assertEstimateCleanHistory } from "./estimate-delivery-history";
const orgs: string[] = [];
async function fixture() {
  const f = await returningCustomerFixture();
  orgs.push(f.org);
  const [lead] = await db
    .insert(leadsTable)
    .values({
      organizationId: f.org,
      contactId: f.contact.id,
      source: "manual",
    })
    .returning();
  return { ...f, lead };
}
afterAll(async () => deleteTestOrgs(...orgs));
async function row(org: string, id: string) {
  return (
    await db
      .select()
      .from(estimatesTable)
      .where(
        and(eq(estimatesTable.organizationId, org), eq(estimatesTable.id, id)),
      )
  )[0]!;
}
async function saved(org: string, id: string) {
  return db
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.organizationId, org),
        eq(auditEventsTable.entityId, id),
        eq(auditEventsTable.action, "estimate.saved_state"),
      ),
    );
}
const held = (org: string, e: Estimate) =>
  expect(assertEstimateCleanHistory(db, org, e)).rejects.toMatchObject({
    code: "estimate_history_held",
  });
it("retains declined creation through draft and serializes concurrent native saves into one chain", async () => {
  const f = await fixture();
  const e = (await createEstimate(
    f.org,
    { leadId: f.lead.id, title: "Synthetic", status: "declined" },
    f.actor,
  ))!;
  await Promise.all([
    updateEstimate(f.org, e.id, { status: "draft" }, f.actor),
    updateEstimate(f.org, e.id, { title: "Edited" }, f.actor),
  ]);
  await held(f.org, await row(f.org, e.id));
  const events = await saved(f.org, e.id);
  expect(events).toHaveLength(3);
  const ids = new Set(events.map((e) => e.id));
  const links = events
    .map((e) => (e.metadata as any).previousAuditId)
    .filter(Boolean);
  expect(links).toHaveLength(2);
  expect(links.every((id) => ids.has(id))).toBe(true);
});
it.each(["sent", "accepted"] as const)(
  "holds retained %s even after current timestamps disappear",
  async (status) => {
    const f = await fixture();
    const e = (await createEstimate(
      f.org,
      { leadId: f.lead.id, title: "Synthetic", status },
      f.actor,
    ))!;
    await updateEstimate(f.org, e.id, { status: "draft" }, f.actor);
    await db
      .update(estimatesTable)
      .set({ sentAt: null, acceptedAt: null })
      .where(eq(estimatesTable.id, e.id));
    await held(f.org, await row(f.org, e.id));
  },
);
it("qualifies clean new drafts edited as draft but detects semantic bypass and missing history", async () => {
  const f = await fixture();
  const e = (await createEstimate(
    f.org,
    { leadId: f.lead.id, title: "Synthetic" },
    f.actor,
  ))!;
  await updateEstimate(
    f.org,
    e.id,
    { notes: "Complete synthetic notes" },
    f.actor,
  );
  await expect(
    assertEstimateCleanHistory(db, f.org, await row(f.org, e.id)),
  ).resolves.toBeUndefined();
  expect(await saved(f.org, e.id)).toHaveLength(2);
  await db
    .update(estimatesTable)
    .set({ title: "Bypass" })
    .where(eq(estimatesTable.id, e.id));
  await held(f.org, await row(f.org, e.id));
  await updateEstimate(f.org, e.id, { notes: "Later edit" }, f.actor);
  await held(f.org, await row(f.org, e.id));
});
it("never anchors a legacy lead through its next edit", async () => {
  const f = await fixture();
  const [e] = await db
    .insert(estimatesTable)
    .values({ organizationId: f.org, leadId: f.lead.id, title: "Legacy" })
    .returning();
  await held(f.org, e!);
  await updateEstimate(f.org, e!.id, { title: "Edited" }, f.actor);
  await held(f.org, await row(f.org, e!.id));
});
it("binds returning history to its exact commands and retains declined states", async () => {
  const f = await fixture(),
    input = returningEstimateDraft(f);
  const e = await createCustomerWorkEstimate(f.org, f.actor, input);
  const { source, ...edit } = input;
  await expect(
    assertEstimateCleanHistory(db, f.org, await row(f.org, e.estimate.id)),
  ).resolves.toBeUndefined();
  const changed = await updateCustomerWorkEstimate(
    f.org,
    f.actor,
    e.estimate.id,
    {
      ...edit,
      requestId: randomUUID(),
      expectedWorkVersion: 1,
      status: "declined",
    },
  );
  await updateCustomerWorkEstimate(f.org, f.actor, e.estimate.id, {
    ...edit,
    requestId: randomUUID(),
    expectedWorkVersion: changed.estimate.workVersion,
    status: "draft",
  });
  await held(f.org, await row(f.org, e.estimate.id));
  expect(await saved(f.org, e.estimate.id)).toHaveLength(3);
});
it("unknown returning versions stay held after future updates", async () => {
  const f = await fixture(),
    input = returningEstimateDraft(f);
  const e = await createCustomerWorkEstimate(f.org, f.actor, input);
  await db
    .delete(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.organizationId, f.org),
        eq(auditEventsTable.entityId, e.estimate.id),
      ),
    );
  await db
    .update(estimatesTable)
    .set({ workVersion: 2 })
    .where(eq(estimatesTable.id, e.estimate.id));
  await held(f.org, await row(f.org, e.estimate.id));
  const { source, ...edit } = input;
  await updateCustomerWorkEstimate(f.org, f.actor, e.estimate.id, {
    ...edit,
    requestId: randomUUID(),
    expectedWorkVersion: 2,
    status: "draft",
  });
  await held(f.org, await row(f.org, e.estimate.id));
});

it("rolls back native and returning mutations if transactional history insertion fails", async () => {
  const f = await fixture(),
    e = (await createEstimate(
      f.org,
      { leadId: f.lead.id, title: "Original" },
      f.actor,
    ))!,
    input = returningEstimateDraft(f);
  const spy = vi
    .spyOn(history, "recordEstimateSavedState")
    .mockImplementation(async (tx, org, e) => {
      await tx.insert(auditEventsTable).values({
        organizationId: org,
        actorUserId: "synthetic-missing-actor",
        action: "estimate.saved_state",
        entityType: "estimate",
        entityId: e.id,
      });
    });
  try {
    await expect(
      updateEstimate(f.org, e.id, { title: "Must rollback" }, f.actor),
    ).rejects.toThrow();
    expect((await row(f.org, e.id)).title).toBe("Original");
    await expect(
      createEstimate(
        f.org,
        { leadId: f.lead.id, title: "Must rollback" },
        f.actor,
      ),
    ).rejects.toThrow();
    await expect(
      createCustomerWorkEstimate(f.org, f.actor, input),
    ).rejects.toThrow();
    expect(
      await db
        .select()
        .from(estimatesTable)
        .where(eq(estimatesTable.organizationId, f.org)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(customerWorkCommandsTable)
        .where(eq(customerWorkCommandsTable.organizationId, f.org)),
    ).toHaveLength(0);
  } finally {
    spy.mockRestore();
  }
});
it("validates linked history without timestamp ordering and rejects gaps or malformed evidence", async () => {
  const f = await fixture(),
    e = (await createEstimate(
      f.org,
      { leadId: f.lead.id, title: "Synthetic" },
      f.actor,
    ))!;
  await updateEstimate(f.org, e.id, { title: "Second" }, f.actor);
  await updateEstimate(f.org, e.id, { title: "Third" }, f.actor);
  const all = await saved(f.org, e.id);
  await db
    .update(auditEventsTable)
    .set({ createdAt: new Date("2000-01-01T00:00:00Z") })
    .where(
      and(
        eq(auditEventsTable.organizationId, f.org),
        eq(auditEventsTable.entityId, e.id),
      ),
    );
  await expect(
    assertEstimateCleanHistory(db, f.org, await row(f.org, e.id)),
  ).resolves.toBeUndefined();
  const middle = all.find((r) => (r.metadata as any).sequence === 2)!;
  await db.delete(auditEventsTable).where(eq(auditEventsTable.id, middle.id));
  await held(f.org, await row(f.org, e.id));
  await updateEstimate(f.org, e.id, { notes: "Later edit" }, f.actor);
  await held(f.org, await row(f.org, e.id));
  const clean = (await createEstimate(
    f.org,
    { leadId: f.lead.id, title: "Clean" },
    f.actor,
  ))!;
  const [event] = await saved(f.org, clean.id);
  await db
    .update(auditEventsTable)
    .set({ metadata: { version: 1 } })
    .where(eq(auditEventsTable.id, event!.id));
  await held(f.org, clean);
});
it("allows only the exact legacy returning version-one command baseline and retains it on an edit", async () => {
  const f = await fixture(),
    input = returningEstimateDraft(f),
    e = await createCustomerWorkEstimate(f.org, f.actor, input);
  await db
    .delete(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.organizationId, f.org),
        eq(auditEventsTable.entityId, e.estimate.id),
        eq(auditEventsTable.action, "estimate.saved_state"),
      ),
    );
  await held(f.org, await row(f.org, e.estimate.id));
  const [creation] = await db
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.organizationId, f.org),
        eq(auditEventsTable.entityId, e.estimate.id),
        eq(auditEventsTable.action, "customer_work.estimate_created"),
      ),
    );
  const { savedStateVersion, ...legacyMetadata } = creation!.metadata;
  await db
    .update(auditEventsTable)
    .set({ metadata: legacyMetadata })
    .where(eq(auditEventsTable.id, creation!.id));
  await expect(
    assertEstimateCleanHistory(db, f.org, await row(f.org, e.estimate.id)),
  ).resolves.toBeUndefined();
  const { source, ...edit } = input;
  await updateCustomerWorkEstimate(f.org, f.actor, e.estimate.id, {
    ...edit,
    requestId: randomUUID(),
    expectedWorkVersion: 1,
    status: "draft",
  });
  await expect(
    assertEstimateCleanHistory(db, f.org, await row(f.org, e.estimate.id)),
  ).resolves.toBeUndefined();
  const events = await saved(f.org, e.estimate.id);
  expect(events).toHaveLength(2);
  expect(events.every((r) => r.metadata.anchor === "legacy_returning")).toBe(
    true,
  );
});

it("rejects a substituted command or branching history and retains route actor evidence", async () => {
  const f = await fixture(),
    input = returningEstimateDraft(f);
  const created = await createCustomerWorkEstimate(f.org, f.actor, input);
  const [event] = await saved(f.org, created.estimate.id);
  expect(event!.actorUserId).toBe(f.actor.userId);
  await db
    .update(auditEventsTable)
    .set({ metadata: { ...event!.metadata, commandId: randomUUID() } })
    .where(eq(auditEventsTable.id, event!.id));
  await held(f.org, await row(f.org, created.estimate.id));
  const e = (await createEstimate(
    f.org,
    { leadId: f.lead.id, title: "Native" },
    f.actor,
  ))!;
  await updateEstimate(f.org, e.id, { title: "Edited" }, f.actor);
  const entries = await saved(f.org, e.id),
    tail = entries.find((r) => r.metadata.sequence === 2)!;
  await db
    .insert(auditEventsTable)
    .values({
      organizationId: f.org,
      actorUserId: f.actor.userId,
      action: "estimate.saved_state",
      entityType: "estimate",
      entityId: e.id,
      metadata: tail.metadata,
    });
  await held(f.org, await row(f.org, e.id));
});
