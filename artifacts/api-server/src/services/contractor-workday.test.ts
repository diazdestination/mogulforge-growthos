import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { appointmentsTable, appointmentWorkCompletionsTable, appointmentWorkEntriesTable, contactsTable, crmTasksTable, db, leadsTable, pool, propertiesTable, revenueExecutionsTable, scheduledActionsTable, serviceObligationsTable, usersTable, workChecklistRevisionsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { answerWorkday, contractorWorkdayFixture, reviewWorkday, workdayTestAsset, workdayTestDefinition, type WorkdayFixture } from "../test-helpers/contractor-workday-fixture";
import { cancelAppointmentWorkEntry, completeAppointmentWork, correctAppointmentWork, createAppointmentWorkEntry, getAppointmentWork, previewAppointmentWorkCompletion, readAppointmentWork, saveAppointmentWorkEntry } from "./appointment-work";
import { approveWorkdayTemplate, createWorkdayTemplate, getWorkdayTemplate, previewWorkdayTemplate, retireWorkdayTemplate, reviseWorkdayTemplate } from "./work-checklists";
import { createWorkdayAsset, listWorkdayAssets, updateWorkdayAsset } from "./property-assets";
import { createAppointment, mergeLeads, updateAppointment, updateProperty, updateTask } from "./crm";
import { approveServiceRecurrence, createServiceObligation, updateServiceObligation } from "./service-obligations";
import { appointmentWorkSchema, workdayCompletionPreviewSchema, workdayTemplateCatalogSchema } from "./contractor-workday-contract";
import { updateInspectionIfAvailable } from "./inspection-booking";
const orgs: string[] = [];
async function fixture(options?: Parameters<typeof contractorWorkdayFixture>[0]) { const f = await contractorWorkdayFixture(options); orgs.push(f.org); return f; }
beforeAll(() => { vi.stubEnv("SESSION_SECRET", "synthetic-workday-test-only-signing-key"); vi.stubGlobal("fetch", async () => { throw Error("No providers in workday tests"); }); });
afterAll(async () => { await deleteTestOrgs(...orgs); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const finish = async (f: WorkdayFixture, attention = false) => { const review = await reviewWorkday(f, attention); return completeAppointmentWork(f.org, f.actor, f.appointment.id, { requestId: randomUUID(), previewToken: review.previewToken, confirmed: true }); };

it("keeps equipment facts explicit, paginates 25 records, and refuses same-name wrong-parent or foreign assets", async () => {
  const f = await fixture({ enroll: false, service: false });
  for (let i = 0; i < 26; i++) await createWorkdayAsset(f.org, f.manager, f.contact.id, { ...workdayTestAsset, label: `Unit ${i}`, requestId: randomUUID(), propertyId: f.property.id });
  const first = await listWorkdayAssets(f.org, f.actor, f.contact.id, { propertyId: f.property.id });
  expect(first.items).toHaveLength(25); expect(first.hasMore).toBe(true);
  const second = await listWorkdayAssets(f.org, f.actor, f.contact.id, { propertyId: f.property.id, cursor: first.nextCursor });
  expect(second.items).toHaveLength(2); expect(new Set([...first.items, ...second.items].map(a => a.id)).size).toBe(27);
  await expect(createWorkdayAsset(f.org, f.actor, f.otherContact.id, { ...workdayTestAsset, requestId: randomUUID(), propertyId: f.property.id })).rejects.toMatchObject({ code: "workday_parent_changed" });
  await expect(createWorkdayAsset(f.org, f.actor, f.contact.id, { ...workdayTestAsset, requestId: randomUUID(), propertyId: f.property.id, warrantyStartsOn: "2025-01-01" })).rejects.toMatchObject({ code: "workday_warranty_source_required" });
  await updateProperty(f.org, f.property.id, { contactId: f.otherContact.id });
  const held = await listWorkdayAssets(f.org, f.actor, f.contact.id, {}); expect(held.items.every(a => !a.currentParentCoherent && !a.canEdit)).toBe(true);
  expect((await listWorkdayAssets(f.org, f.actor, f.otherContact.id, {})).items).toEqual([]);
});
it("company checklist approval is exact actor-bound and saved revisions stay immutable", async () => {
  const f = await fixture({ enroll: false, service: false });
  const draft = await createWorkdayTemplate(f.org, f.manager, { requestId: randomUUID(), definition: workdayTestDefinition }); const t = draft.template as Awaited<ReturnType<typeof getWorkdayTemplate>>;
  const p = await previewWorkdayTemplate(f.org, f.manager, t.id, { expectedVersion: t.version, revisionId: t.latestRevision.id });
  await expect(approveWorkdayTemplate(f.org, { userId: f.office.id }, t.id, { requestId: randomUUID(), previewToken: p.previewToken, confirmed: true })).rejects.toMatchObject({ code: "workday_access_denied" });
  await reviseWorkdayTemplate(f.org, f.manager, t.id, { requestId: randomUUID(), expectedVersion: t.version, definition: { ...workdayTestDefinition, name: "Changed saved draft" } });
  await expect(approveWorkdayTemplate(f.org, f.manager, t.id, { requestId: randomUUID(), previewToken: p.previewToken, confirmed: true })).rejects.toMatchObject({ code: "workday_review_changed" });
  expect((await db.select().from(workChecklistRevisionsTable).where(eq(workChecklistRevisionsTable.id, t.latestRevision.id)))[0].definition).toEqual(workdayTestDefinition);
});
it("retired or replaced templates block new enrollment but not pinned reviewed work", async () => {
  const f = await fixture(); await answerWorkday(f);
  await retireWorkdayTemplate(f.org, f.manager, f.template.id, { requestId: randomUUID(), expectedVersion: f.template.version, reason: "Use newer instructions for future work only", confirmed: true });
  await expect(createAppointmentWorkEntry(f.org, f.actor, f.appointment.id, { requestId: randomUUID(), expectedAppointmentUpdatedAt: f.appointment.updatedAt.toISOString(), checklistRevisionId: f.template.approvedRevision.id, assetId: null, serviceObligationId: null })).rejects.toMatchObject({ code: "workday_reviewed_checklist_required" });
  expect((await finish(f)).work.completion?.nativeAppointmentStatus).toBe("completed");
});
it("returning-customer completion seals saved work atomically, creates one anchored successor, and preserves staff notes", async () => {
  const f = await fixture(); await answerWorkday(f, true);
  const [beforeTask] = await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.service!.taskId));
  const review = await reviewWorkday(f, true); workdayCompletionPreviewSchema.parse(review);
  const input = { requestId: randomUUID(), previewToken: review.previewToken, confirmed: true };
  const result = await completeAppointmentWork(f.org, f.actor, f.appointment.id, input); appointmentWorkSchema.parse(result.work);
  expect(result.work.appointment).toMatchObject({ status: "completed", notes: f.appointment.notes, leadId: null });
  expect(result.work.completion).toMatchObject({ performerUserId: f.tech.id, outcome: "needs_followup", nativeAppointmentStatus: "completed" });
  const [task] = await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, f.service!.taskId));
  expect(task).toMatchObject({ status: "done", description: beforeTask.description, assignedUserId: beforeTask.assignedUserId, dueAt: beforeTask.dueAt });
  const successors = await db.select().from(serviceObligationsTable).where(eq(serviceObligationsTable.predecessorObligationId, f.service!.id));
  expect(successors).toHaveLength(1); expect(successors[0]).toMatchObject({ appointmentId: null, equipmentLabel: f.service!.equipmentLabel, dueAt: new Date("2035-02-28T12:00:00Z") });
  expect(await db.select().from(leadsTable).where(eq(leadsTable.organizationId, f.org))).toHaveLength(0);
  expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, f.org))).toHaveLength(1);
  expect((await completeAppointmentWork(f.org, f.actor, f.appointment.id, input)).receipt.replayed).toBe(true);
  expect(await db.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, f.org), eq(crmTasksTable.sourceEvent, `appointment.work_followup:${f.appointment.id}`)))).toHaveLength(1);
  await expect(completeAppointmentWork(f.org, f.actor, f.appointment.id, { ...input, previewToken: input.previewToken + "x" })).rejects.toMatchObject({ code: "workday_request_conflict" });
});
it("enrollment blocks both generic completion writers while unenrolled legacy completion remains usable", async () => {
  const f = await fixture();
  await expect(updateAppointment(f.org, f.appointment.id, { status: "completed" })).rejects.toMatchObject({ code: "workday_completion_required" });
  await expect(updateServiceObligation(f.org, f.owner.id, f.service!.id, { status: "completed" })).rejects.toMatchObject({ code: "workday_completion_required" });
  const old = await fixture({ enroll: false });
  expect(await updateAppointment(old.org, old.appointment.id, { status: "completed" })).toMatchObject({ status: "completed" });
  expect(await updateServiceObligation(old.org, old.owner.id, old.service!.id, { status: "completed" })).toMatchObject({ status: "completed" });
});
it("sealed evidence cannot authorize generic reopening, relinking or rewriting original notes; corrections append only", async () => {
  const f = await fixture(); await answerWorkday(f); const completed = await finish(f), original = completed.work.completion!;
  for (const patch of [{ status: "scheduled" as const }, { notes: "Overwrite original" }]) await expect(updateAppointment(f.org, f.appointment.id, patch)).rejects.toMatchObject({ code: "workday_completion_required" });
  await expect(updateAppointment(f.org, f.appointment.id, { propertyId: null })).rejects.toMatchObject({ code: "workday_parent_locked", message: expect.stringContaining("separate visit") });
  await expect(updateInspectionIfAvailable(f.org, f.appointment.id, { status: "scheduled", type: "inspection" }, { start: new Date("2035-01-31T15:00:00Z"), end: new Date("2035-01-31T16:00:00Z") })).rejects.toMatchObject({ code: "workday_completion_required" });
  await expect(updateServiceObligation(f.org, f.owner.id, f.service!.id, { status: "active" })).rejects.toMatchObject({ code: "workday_completion_required" });
  const input = { requestId: randomUUID(), note: "Append-only correction to the recorded observation." };
  const corrected = await correctAppointmentWork(f.org, f.actor, f.appointment.id, original.id, input);
  expect(corrected.work.completion).toEqual(original); expect(corrected.work.corrections).toHaveLength(1);
  expect((await correctAppointmentWork(f.org, f.actor, f.appointment.id, original.id, input)).receipt.replayed).toBe(true);
  expect(await db.select().from(serviceObligationsTable).where(eq(serviceObligationsTable.predecessorObligationId, f.service!.id))).toHaveLength(1);
});
it("missing answers, invalid observations and attention without accountable follow-up cannot finish", async () => {
  const f = await fixture(), work = await getAppointmentWork(f.org, f.actor, f.appointment.id), e = work.entries[0];
  await expect(reviewWorkday(f)).rejects.toMatchObject({ code: "workday_required_answers" });
  for (const answer of [
    { itemKey: "observed", result: "not_applicable", value: null, reason: null },
    { itemKey: "reading", result: "done", value: "71", reason: null },
    { itemKey: "observed", result: "needs_attention", value: null, reason: null },
  ]) await expect(saveAppointmentWorkEntry(f.org, f.actor, f.appointment.id, e.id, { requestId: randomUUID(), expectedVersion: e.version, answers: [answer], notes: "" })).rejects.toBeDefined();
  await answerWorkday(f, true); await expect(reviewWorkday(f)).rejects.toMatchObject({ code: "workday_attention_followup_required" });
  const review = await reviewWorkday(f, true);
  await expect(previewAppointmentWorkCompletion(f.org, f.actor, f.appointment.id, { ...review.intent, performedAt: new Date(Date.now() + 86400000).toISOString() })).rejects.toMatchObject({ code: "workday_future_performance" });
});
it("explicit N/A reasons work, and no service is completed unless selected in the final attestation", async () => {
  const f = await fixture(), work = await getAppointmentWork(f.org, f.actor, f.appointment.id), e = work.entries[0];
  await saveAppointmentWorkEntry(f.org, f.actor, f.appointment.id, e.id, { requestId: randomUUID(), expectedVersion: e.version, answers: [{ itemKey: "observed", result: "not_applicable", value: null, reason: "Work not applicable to the inspected system; office informed." }], notes: "Not a passed inspection" });
  const reviewed = await reviewWorkday(f), p = await previewAppointmentWorkCompletion(f.org, f.actor, f.appointment.id, { ...reviewed.intent, serviceObligationIds: [] });
  const result = await completeAppointmentWork(f.org, f.actor, f.appointment.id, { requestId: randomUUID(), previewToken: p.previewToken, confirmed: true });
  expect(result.work.completion?.services).toEqual([]);
  expect((await db.select().from(serviceObligationsTable).where(eq(serviceObligationsTable.id, f.service!.id)))[0].status).toBe("active");
  await expect(updateServiceObligation(f.org, f.owner.id, f.service!.id, { status: "completed" })).rejects.toMatchObject({ code: "workday_completion_required" });
});
it("an explicitly unperformed service can be rebooked and finished later without replaying the first visit", async () => {
  const f = await fixture();
  const created = await createServiceObligation(f.org, f.owner.id, { contactId: f.contact.id, propertyId: f.property.id, kind: "maintenance", equipmentLabel: "Second unit, not performed today", dueDate: "2035-01-31", noticeDays: 7, assignedUserId: f.tech.id });
  if ("error" in created) throw Error(created.error);
  await updateServiceObligation(f.org, f.owner.id, created.id, { appointmentId: f.appointment.id });
  await createAppointmentWorkEntry(f.org, f.actor, f.appointment.id, { requestId: randomUUID(), expectedAppointmentUpdatedAt: f.appointment.updatedAt.toISOString(), checklistRevisionId: f.template.approvedRevision.id, assetId: null, serviceObligationId: created.id });
  await answerWorkday(f); const first = await finish(f), proof = first.work.completion!;
  expect(proof.services.map(s => s.id)).toEqual([f.service!.id]);
  await updateTask(f.org, created.taskId, { status: "in_progress", description: "New office note must survive unrelated replay" });
  for (const patch of [{ status: "completed" as const }, { notes: f.appointment.notes }, { assignedUserId: f.tech.id }, {}]) await expect(updateAppointment(f.org, f.appointment.id, patch)).rejects.toMatchObject({ code: "workday_completion_required" });
  expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.id, created.taskId)))[0]).toMatchObject({ status: "in_progress", description: "New office note must survive unrelated replay" });
  const next = await createAppointment(f.org, { contactId: f.contact.id, propertyId: f.property.id, assignedUserId: f.tech.id, type: "other", scheduledStart: new Date("2035-02-01T15:00:00Z"), scheduledEnd: new Date("2035-02-01T16:00:00Z") });
  if (!next || typeof next === "string") throw Error("Missing later explicit visit");
  const relinked = await updateServiceObligation(f.org, f.owner.id, created.id, { appointmentId: next.id }); if (relinked.error) throw Error(relinked.error);
  await createAppointmentWorkEntry(f.org, f.actor, next.id, { requestId: randomUUID(), expectedAppointmentUpdatedAt: next.updatedAt.toISOString(), checklistRevisionId: f.template.approvedRevision.id, assetId: null, serviceObligationId: created.id });
  const later = { ...f, appointment: next, service: relinked };
  await answerWorkday(later); expect((await finish(later)).work.completion?.services.map(s => s.id)).toEqual([created.id]);
  expect((await getAppointmentWork(f.org, f.actor, f.appointment.id)).completion).toEqual(proof);
});
it("the actual lead merge retains prepared and sealed visit history instead of bulk-reparenting evidence", async () => {
  const f = await fixture({ enroll: false });
  const [source, survivor] = await db.insert(leadsTable).values([{ organizationId: f.org, contactId: f.contact.id, propertyId: f.property.id }, { organizationId: f.org, contactId: f.contact.id, propertyId: f.property.id }]).returning();
  const visit = await updateAppointment(f.org, f.appointment.id, { leadId: source.id }); if (!visit || typeof visit === "string") throw Error("Missing visit");
  await createAppointmentWorkEntry(f.org, f.actor, visit.id, { requestId: randomUUID(), expectedAppointmentUpdatedAt: visit.updatedAt.toISOString(), checklistRevisionId: f.template.approvedRevision.id, assetId: f.assetId, serviceObligationId: f.service!.id });
  expect(await mergeLeads(f.org, survivor.id, source.id, f.owner.id)).toEqual({ ok: false, error: "outreach_history_retained" });
  await answerWorkday(f); const sealed = (await finish(f)).work.completion;
  expect(await mergeLeads(f.org, survivor.id, source.id, f.owner.id)).toEqual({ ok: false, error: "outreach_history_retained" });
  const work = await getAppointmentWork(f.org, f.actor, visit.id); expect(work.appointment.leadId).toBe(source.id); expect(work.completion).toEqual(sealed);
});
it("changed staff assignment, source asset or saved task after preview invalidates completion", async () => {
  for (const kind of ["asset", "task", "assignment"] as const) {
    const f = await fixture(); await answerWorkday(f); const review = await reviewWorkday(f);
    if (kind === "asset") await updateWorkdayAsset(f.org, f.manager, f.assetId!, { ...workdayTestAsset, label: "Office corrected equipment", requestId: randomUUID(), expectedVersion: 1, status: "active" });
    if (kind === "task") await updateTask(f.org, f.service!.taskId, { description: "Actual office change after review" });
    if (kind === "assignment") await updateAppointment(f.org, f.appointment.id, { assignedUserId: f.office.id });
    await expect(completeAppointmentWork(f.org, f.actor, f.appointment.id, { requestId: randomUUID(), previewToken: review.previewToken, confirmed: true })).rejects.toBeDefined();
    expect(await db.select().from(appointmentWorkCompletionsTable).where(eq(appointmentWorkCompletionsTable.organizationId, f.org))).toHaveLength(0);
  }
});
it("a real address edit with the original timestamp retained still invalidates prepared parent identity", async () => {
  const f = await fixture(); await answerWorkday(f); const review = await reviewWorkday(f);
  await updateProperty(f.org, f.property.id, { addressLine1: "200 Different actual worksite" });
  await pool.query("UPDATE properties SET updated_at=$2 WHERE id=$1", [f.property.id, f.property.updatedAt]);
  expect((await getAppointmentWork(f.org, f.actor, f.appointment.id)).entries[0].holdReasons).toContain("workday_parent_changed");
  await expect(completeAppointmentWork(f.org, f.actor, f.appointment.id, { requestId: randomUUID(), previewToken: review.previewToken, confirmed: true })).rejects.toMatchObject({ code: "workday_parent_changed" });
});
it("office must explicitly attest for the accepted assigned performer; unassigned sales and capped owners cannot write", async () => {
  const f = await fixture(), e = (await getAppointmentWork(f.org, f.actor, f.appointment.id)).entries[0];
  const input = { requestId: randomUUID(), expectedVersion: e.version, answers: [], notes: "Actual office note" };
  await expect(saveAppointmentWorkEntry(f.org, { userId: f.office.id }, f.appointment.id, e.id, input)).rejects.toMatchObject({ code: "workday_acting_note_required" });
  await expect(saveAppointmentWorkEntry(f.org, { userId: f.sales.id }, f.appointment.id, e.id, { ...input, actingNote: "Cannot grant authority" })).rejects.toMatchObject({ code: "workday_assignment_required" });
  await expect(saveAppointmentWorkEntry(f.org, { userId: f.owner.id, effectiveRole: "viewer" }, f.appointment.id, e.id, { ...input, actingNote: "Cannot override cap" })).rejects.toMatchObject({ code: "workday_assignment_required" });
  const saved = await saveAppointmentWorkEntry(f.org, { userId: f.office.id }, f.appointment.id, e.id, { ...input, actingNote: "I am recording the assigned technician's reported work on their behalf." });
  expect(saved.work.entries[0].notes).toBe(input.notes);
  await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, f.tech.id));
  expect((await getAppointmentWork(f.org, { userId: f.office.id }, f.appointment.id)).capabilities.canEdit).toBe(false);
});
it("two-company and same-company wrong visit selectors cannot expose or enroll foreign work", async () => {
  const a = await fixture(), b = await fixture();
  await expect(getAppointmentWork(b.org, b.actor, a.appointment.id)).rejects.toMatchObject({ status: 404 });
  await expect(createAppointmentWorkEntry(a.org, a.actor, a.appointment.id, { requestId: randomUUID(), expectedAppointmentUpdatedAt: a.appointment.updatedAt.toISOString(), checklistRevisionId: b.template.approvedRevision.id, assetId: null, serviceObligationId: null })).rejects.toMatchObject({ code: "workday_reviewed_checklist_required" });
  const wrong = await createWorkdayAsset(a.org, a.manager, a.contact.id, { ...workdayTestAsset, requestId: randomUUID(), propertyId: a.property.id });
  expect(wrong.receipt.replayed).toBe(false);
  await expect(saveAppointmentWorkEntry(a.org, a.actor, a.appointment.id, (await getAppointmentWork(b.org, b.actor, b.appointment.id)).entries[0].id, { requestId: randomUUID(), expectedVersion: 1, answers: [], notes: "" })).rejects.toMatchObject({ code: "workday_entry_unavailable" });
});
it("multiple units keep independent answers and snapshots, and an exact draft replay does not overwrite newer saved work", async () => {
  const f = await fixture();
  await createAppointmentWorkEntry(f.org, f.actor, f.appointment.id, { requestId: randomUUID(), expectedAppointmentUpdatedAt: f.appointment.updatedAt.toISOString(), checklistRevisionId: f.template.approvedRevision.id, assetId: null, serviceObligationId: null });
  let work = await getAppointmentWork(f.org, f.actor, f.appointment.id); expect(work.entries).toHaveLength(2);
  const e = work.entries[0], first = { requestId: randomUUID(), expectedVersion: e.version, answers: [], notes: "First saved state" };
  await saveAppointmentWorkEntry(f.org, f.actor, f.appointment.id, e.id, first);
  await saveAppointmentWorkEntry(f.org, f.actor, f.appointment.id, e.id, { ...first, requestId: randomUUID(), expectedVersion: 2, notes: "Newer saved state" });
  const replay = await saveAppointmentWorkEntry(f.org, f.actor, f.appointment.id, e.id, first);
  expect(replay.receipt.replayed).toBe(true); expect(replay.work.entries.find(x => x.id === e.id)?.notes).toBe("Newer saved state");
  await expect(saveAppointmentWorkEntry(f.org, f.actor, f.appointment.id, e.id, { ...first, notes: "Changed old request" })).rejects.toMatchObject({ code: "workday_request_conflict" });
  await answerWorkday(f); work = (await finish(f)).work; expect(work.completion?.entries).toHaveLength(2);
});
it("canceled and no-show visits cannot enroll or finish, and cancellation is an explicit office re-preparation path", async () => {
  for (const status of ["cancelled", "no_show"] as const) {
    const f = await fixture(); await updateAppointment(f.org, f.appointment.id, { status });
    await expect(answerWorkday(f)).rejects.toMatchObject({ code: "workday_visit_not_active" });
  }
  const f = await fixture(), entry = (await getAppointmentWork(f.org, f.actor, f.appointment.id)).entries[0];
  await updateWorkdayAsset(f.org, f.manager, f.assetId!, { ...workdayTestAsset, requestId: randomUUID(), expectedVersion: 1, status: "retired" });
  await cancelAppointmentWorkEntry(f.org, f.manager, f.appointment.id, entry.id, { requestId: randomUUID(), expectedVersion: entry.version, reason: "Explicitly replace a retired unit before work", actingNote: "Office records cancellation for assigned technician" });
  expect((await getAppointmentWork(f.org, f.actor, f.appointment.id)).entries[0].state).toBe("cancelled");
});
it("held drafts expose cancellation only to current effective office authority without changing saved answers or unknown effects", async () => {
  const f = await fixture(); await answerWorkday(f);
  const before = await getAppointmentWork(f.org, f.actor, f.appointment.id), entry = before.entries[0];
  const [action] = await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org));
  const [receipt] = await db.insert(revenueExecutionsTable).values({ organizationId: f.org, actionKey: `scheduled:${action.id}`, fingerprint: "e".repeat(64), kind: "appointment_reminder", state: "indeterminate", expiresAt: new Date(Date.now() - 1000) }).returning();
  await updateWorkdayAsset(f.org, f.manager, f.assetId!, { ...workdayTestAsset, label: "Explicitly corrected unit", requestId: randomUUID(), expectedVersion: 1, status: "active" });
  await updateProperty(f.org, f.property.id, { addressLine1: "Corrected original property address" });
  const office = { userId: f.office.id }, input = { requestId: randomUUID(), expectedVersion: entry.version, reason: "Discard held preparation and review the corrected source", actingNote: "Office cancels preparation on behalf of the assigned technician" };
  const held = await getAppointmentWork(f.org, office, f.appointment.id);
  expect(held.capabilities).toMatchObject({ canCancel: true, canComplete: false, requiresActingNote: true });
  expect(held.entries[0].holdReasons).toEqual(expect.arrayContaining(["workday_asset_changed", "workday_parent_changed"]));
  for (const actor of [f.actor, { userId: f.sales.id }, { userId: f.viewer.id }, { userId: f.owner.id, effectiveRole: "inspector" as const }]) {
    expect((await getAppointmentWork(f.org, actor, f.appointment.id)).capabilities.canCancel).toBe(false);
    await expect(cancelAppointmentWorkEntry(f.org, actor, f.appointment.id, entry.id, input)).rejects.toMatchObject({ status: 403 });
  }
  await expect(saveAppointmentWorkEntry(f.org, office, f.appointment.id, entry.id, { requestId: randomUUID(), expectedVersion: entry.version, answers: [], notes: "Must not overwrite held evidence", actingNote: input.actingNote })).rejects.toMatchObject({ code: "workday_parent_changed" });
  await expect(cancelAppointmentWorkEntry(f.org, office, f.appointment.id, entry.id, { ...input, actingNote: undefined })).rejects.toMatchObject({ code: "workday_acting_note_required" });
  await expect(cancelAppointmentWorkEntry(f.org, office, f.appointment.id, entry.id, { ...input, expectedVersion: entry.version + 1 })).rejects.toMatchObject({ code: "workday_stale_version" });
  await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, f.office.id));
  await expect(cancelAppointmentWorkEntry(f.org, office, f.appointment.id, entry.id, input)).rejects.toMatchObject({ status: 403 });
  await db.update(usersTable).set({ isActive: true }).where(eq(usersTable.id, f.office.id));
  const cancelled = await cancelAppointmentWorkEntry(f.org, office, f.appointment.id, entry.id, input);
  expect(cancelled.work.capabilities.canCancel).toBe(false);
  expect(cancelled.work.entries[0]).toMatchObject({ state: "cancelled", version: entry.version + 1, answers: entry.answers, notes: entry.notes, assetSnapshot: entry.assetSnapshot });
  expect((await cancelAppointmentWorkEntry(f.org, office, f.appointment.id, entry.id, input)).receipt.replayed).toBe(true);
  await expect(cancelAppointmentWorkEntry(f.org, office, f.appointment.id, entry.id, { ...input, reason: "Changed old command" })).rejects.toMatchObject({ code: "workday_request_conflict" });
  expect((await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.id, receipt.id)))[0]).toEqual(receipt);
  expect((await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.id, action.id)))[0]).toEqual(action);
  expect(cancelled.work.completion).toBeNull(); expect(cancelled.work.appointment.status).toBe(before.appointment.status);
});
it("actual native reparenting cannot move draft or cancelled work history to another customer, property or lead", async () => {
  const f = await fixture({ service: false });
  const [otherProperty] = await db.insert(propertiesTable).values({ organizationId: f.org, contactId: f.contact.id, addressLine1: "Separate worksite", city: "Example", state: "GA", postalCode: "00000" }).returning();
  const [lead] = await db.insert(leadsTable).values({ organizationId: f.org, contactId: f.contact.id, propertyId: f.property.id }).returning();
  const before = (await db.select().from(appointmentsTable).where(eq(appointmentsTable.id, f.appointment.id)))[0];
  for (const phase of ["draft", "cancelled"] as const) {
    if (phase === "cancelled") {
      const entry = (await getAppointmentWork(f.org, f.actor, f.appointment.id)).entries[0];
      await cancelAppointmentWorkEntry(f.org, f.manager, f.appointment.id, entry.id, { requestId: randomUUID(), expectedVersion: entry.version, reason: "Original preparation retained", actingNote: "Office records cancellation for the assigned technician" });
    }
    for (const patch of [{ contactId: f.otherContact.id, propertyId: null }, { propertyId: otherProperty.id }, { leadId: lead.id }]) {
      await expect(updateAppointment(f.org, f.appointment.id, patch)).rejects.toMatchObject({ code: "workday_parent_locked", message: expect.stringContaining("separate visit") });
    }
    expect((await db.select().from(appointmentsTable).where(eq(appointmentsTable.id, f.appointment.id)))[0]).toEqual(before);
    expect((await getAppointmentWork(f.org, f.actor, f.appointment.id)).entries[0]).toMatchObject({ state: phase, contactId: f.contact.id, propertyId: f.property.id });
  }
  const unchanged = await updateAppointment(f.org, f.appointment.id, { contactId: f.contact.id, propertyId: f.property.id, leadId: null });
  expect(unchanged).toMatchObject({ contactId: f.contact.id, propertyId: f.property.id, leadId: null });
  const [legacy] = await db.insert(appointmentsTable).values({ organizationId: f.org, leadId: lead.id, contactId: null, propertyId: null, assignedUserId: f.tech.id, type: "other", scheduledStart: new Date("2035-04-01T12:00:00Z"), scheduledEnd: new Date("2035-04-01T13:00:00Z") }).returning();
  await createAppointmentWorkEntry(f.org, f.actor, legacy.id, { requestId: randomUUID(), expectedAppointmentUpdatedAt: legacy.updatedAt.toISOString(), checklistRevisionId: f.template.approvedRevision.id, assetId: null, serviceObligationId: null });
  await expect(updateAppointment(f.org, legacy.id, { notes: "Cannot silently backfill a retained native customer" })).rejects.toMatchObject({ code: "workday_parent_locked" });
  expect((await db.select().from(appointmentsTable).where(eq(appointmentsTable.id, legacy.id)))[0]).toEqual(legacy);
});
it("late native service failure rolls back the original evidence, appointment, follow-up and successor together", async () => {
  const f = await fixture(); await answerWorkday(f, true);
  await db.update(serviceObligationsTable).set({ recurrence: { invalid: "deliberately corrupt persisted policy" } as never }).where(eq(serviceObligationsTable.id, f.service!.id));
  const review = await reviewWorkday(f, true);
  await expect(completeAppointmentWork(f.org, f.actor, f.appointment.id, { requestId: randomUUID(), previewToken: review.previewToken, confirmed: true })).rejects.toMatchObject({ code: "workday_invalid_saved_recurrence" });
  const work = await getAppointmentWork(f.org, f.actor, f.appointment.id); expect(work.completion).toBeNull(); expect(work.appointment.status).toBe("scheduled"); expect(work.entries[0].state).toBe("draft");
  expect(await db.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, f.org), eq(crmTasksTable.sourceEvent, `appointment.work_followup:${f.appointment.id}`)))).toHaveLength(0);
  expect(await db.select().from(serviceObligationsTable).where(eq(serviceObligationsTable.predecessorObligationId, f.service!.id))).toHaveLength(0);
});
it("work completion retains the exact uncertain original reminder claim and creates only its reconciliation task", async () => {
  const f = await fixture(); await answerWorkday(f);
  const [action] = await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.organizationId, f.org));
  const [receipt] = await db.insert(revenueExecutionsTable).values({ organizationId: f.org, actionKey: `scheduled:${action.id}`, fingerprint: "a".repeat(64), kind: "appointment_reminder", state: "indeterminate", expiresAt: new Date(Date.now() - 1000), detail: "Original downstream effect is unknown" }).returning();
  await finish(f);
  expect((await db.select().from(revenueExecutionsTable).where(eq(revenueExecutionsTable.id, receipt.id)))[0]).toEqual(receipt);
  expect((await db.select().from(scheduledActionsTable).where(eq(scheduledActionsTable.id, action.id)))[0].status).toBe("pending");
  expect(await db.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, f.org), eq(crmTasksTable.sourceEvent, `appointment.reminder_reconcile:${action.id}`)))).toHaveLength(1);
});
it("finite recurrence completion makes no successor beyond the explicitly approved end date", async () => {
  const f = await fixture();
  const recurrence = await approveServiceRecurrence(f.org, f.owner.id, f.service!.id, { expectedUpdatedAt: f.service!.updatedAt.toISOString(), intervalMonths: 1, endDate: "2035-01-31", agreementNote: "Actual finite agreement ends at this occurrence in the synthetic test" });
  if ("error" in recurrence) throw Error(recurrence.error);
  await answerWorkday(f); const result = await finish(f);
  expect(result.work.completion?.services).toEqual([{ id: f.service!.id, nextObligationId: null }]);
  expect(await db.select().from(serviceObligationsTable).where(eq(serviceObligationsTable.predecessorObligationId, f.service!.id))).toHaveLength(0);
});
it("work reads execute in a read-only transaction and expired exact completion previews cannot mutate records", async () => {
  const f = await fixture(); await answerWorkday(f);
  await db.transaction(async tx => { await tx.execute(sql`SET TRANSACTION READ ONLY`); const work = await readAppointmentWork(tx, f.org, f.actor, f.appointment.id); expect(work.entries).toHaveLength(1); });
  const review = await reviewWorkday(f), clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
  try { await expect(completeAppointmentWork(f.org, f.actor, f.appointment.id, { requestId: randomUUID(), previewToken: review.previewToken, confirmed: true })).rejects.toMatchObject({ code: "workday_review_expired" }); } finally { clock.mockRestore(); }
  expect((await getAppointmentWork(f.org, f.actor, f.appointment.id)).completion).toBeNull();
});
