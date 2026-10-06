import { createHash, randomUUID } from "node:crypto";
import { appointmentsTable, appointmentWorkCompletionsTable as completions, appointmentWorkEntriesTable as entries, appointmentWorkPhotosTable as photos, contactsTable, crmTasksTable, db, leadsTable, propertiesTable, propertyAssetsTable as assets, serviceObligationsTable as services, storedObjectsTable, usersTable, workChecklistRevisionsTable as revisions, workChecklistTemplatesTable as templates } from "@workspace/db";
import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { hasPermission } from "../lib/permissions";
import { appointmentWorkSchema, cancelWorkdayEntrySchema, completeWorkdaySchema, correctWorkdaySchema, createWorkdayEntrySchema, previewWorkdayCompletionSchema, saveWorkdayEntrySchema, workdayAnswerSchema, workdayCompletionSchema, workdayCorrectionSchema, workdayDefinitionSchema, workdayEntrySchema, workdayPhotoSchema, type WorkdayAnswer, type WorkdayDefinition } from "./contractor-workday-contract";
import { completeWorkdayAppointmentInTransaction } from "./crm";
import { completeWorkdayServiceInTransaction } from "./service-obligations";
import { projectWorkdayRevision } from "./work-checklists";
import { lockWorkday, readWorkdayReview, signWorkdayReview, workdayActor, workdayAudit, workdayFail, workdayHash, workdayReplay, workdayVersion, type WorkdayActor, type WorkdayReader, type WorkdayTx } from "./workday-shared";

export async function readWorkdayVisit(reader: WorkdayReader, org: string, actor: WorkdayActor, id: string, locked = false) {
  const user = await workdayActor(reader, org, actor, "crm.read", locked);
  const aq = reader.select().from(appointmentsTable).where(and(eq(appointmentsTable.organizationId, org), eq(appointmentsTable.id, id)));
  const [appointment] = await (locked ? aq.for("update") : aq);
  if (!appointment) workdayFail("workday_visit_missing", "Visit unavailable in this company.", 404);
  const reasons: string[] = [];
  let contactId = appointment.contactId;
  let leadIdentity: { id: string; contactId: string; propertyId: string | null } | null = null;
  if (appointment.leadId) {
    const q = reader.select().from(leadsTable).where(and(eq(leadsTable.organizationId, org), eq(leadsTable.id, appointment.leadId)));
    const [lead] = await (locked ? q.for("share") : q);
    if (!lead || (contactId && lead.contactId !== contactId) || (appointment.propertyId && lead.propertyId && appointment.propertyId !== lead.propertyId)) reasons.push("workday_parent_changed");
    contactId ??= lead?.contactId ?? null;
    if (lead) {
      leadIdentity = { id: lead.id, contactId: lead.contactId, propertyId: lead.propertyId };
      if (lead.propertyId && lead.propertyId !== appointment.propertyId) {
        const lpq = reader.select({ contactId: propertiesTable.contactId }).from(propertiesTable).where(and(eq(propertiesTable.organizationId, org), eq(propertiesTable.id, lead.propertyId)));
        const [leadProperty] = await (locked ? lpq.for("share") : lpq);
        if (!leadProperty || leadProperty.contactId !== contactId) reasons.push("workday_parent_changed");
      }
    }
  }
  const cq = reader.select().from(contactsTable).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, contactId ?? "00000000-0000-0000-0000-000000000000")));
  const [contact] = await (locked ? cq.for("share") : cq);
  if (!contact) reasons.push("workday_customer_required");
  let property: typeof propertiesTable.$inferSelect | undefined;
  if (appointment.propertyId) {
    const pq = reader.select().from(propertiesTable).where(and(eq(propertiesTable.organizationId, org), eq(propertiesTable.id, appointment.propertyId)));
    [property] = await (locked ? pq.for("share") : pq);
    if (!property || property.contactId !== contactId) reasons.push("workday_parent_changed");
  }
  const uq = reader.select().from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.id, appointment.assignedUserId ?? "")));
  const [performer] = await (locked ? uq.for("share") : uq);
  if (!performer || !performer.isActive || !performer.emailVerifiedAt || performer.id.startsWith("invite:") || !hasPermission(performer.role, "crm.write")) reasons.push("workday_performer_required");
  const writer = hasPermission(user.role, "crm.write") && hasPermission(actor.effectiveRole ?? user.role, "crm.write");
  const office = ["owner", "admin", "office"].includes(user.role) && ["owner", "admin", "office"].includes(actor.effectiveRole ?? user.role);
  const assigned = appointment.assignedUserId === user.id;
  if (!writer || (!assigned && !office)) reasons.push("workday_assignment_required");
  const parentSnapshot = { appointmentId: id, contactId, propertyId: appointment.propertyId, leadId: appointment.leadId, assignedUserId: appointment.assignedUserId,
    scheduledStart: appointment.scheduledStart.toISOString(), scheduledEnd: appointment.scheduledEnd?.toISOString() ?? null,
    contactUpdatedAt: contact?.updatedAt.toISOString() ?? null, propertyUpdatedAt: property?.updatedAt.toISOString() ?? null,
    leadIdentity, customerIdentity: contact ? { firstName: contact.firstName, lastName: contact.lastName, email: contact.email, phone: contact.phone } : null,
    propertyIdentity: property ? { contactId: property.contactId, addressLine1: property.addressLine1, addressLine2: property.addressLine2, city: property.city, state: property.state, postalCode: property.postalCode } : null };
  return { appointment, contact, property, performer, user, contactId, reasons: [...new Set(reasons)], officeWriter: office && writer, requiresActingNote: !assigned && office, parentSnapshot };
}
export function assertWorkdayVisitWritable(v: Awaited<ReturnType<typeof readWorkdayVisit>>, actingNote?: string, terminal = false) {
  if (v.reasons.length) workdayFail(v.reasons[0]);
  if (!terminal && !["scheduled", "confirmed"].includes(v.appointment.status)) workdayFail("workday_visit_not_active");
  if (v.requiresActingNote && !actingNote?.trim()) workdayFail("workday_acting_note_required", "Record that you are acting on behalf of the assigned performer.", 400);
}
export async function loadWorkdayEntries(reader: WorkdayReader, org: string, appointmentId: string, locked = false) {
  const q = reader.select().from(entries).where(and(eq(entries.organizationId, org), eq(entries.appointmentId, appointmentId))).orderBy(asc(entries.id));
  return locked ? q.for("update") : q;
}
export async function workdayPhotoView(row: typeof photos.$inferSelect) {
  const expired = row.state === "reserved" && row.expiresAt.getTime() <= Date.now();
  return workdayPhotoSchema.parse({ id: row.id, entryId: row.entryId, itemKey: row.itemKey, caption: row.caption, state: expired ? "expired" : row.state, contentType: row.contentType, sizeBytes: row.sizeBytes, expiresAt: row.expiresAt.toISOString(), attachedAt: row.attachedAt?.toISOString() ?? null, contentPath: row.state === "attached" ? `/api/v1/appointments/${row.appointmentId}/work/photos/${row.id}/content` : null, available: row.state === "attached" });
}
export async function workdayEntryView(reader: WorkdayReader, row: typeof entries.$inferSelect, parentSnapshot?: unknown) {
  const [revision] = await reader.select().from(revisions).where(and(eq(revisions.organizationId, row.organizationId), eq(revisions.id, row.checklistRevisionId)));
  if (!revision || !revision.reviewedAt || revision.definitionSha256 !== workdayHash(revision.definition)) workdayFail("workday_saved_checklist_invalid");
  const attached = await reader.select().from(photos).where(and(eq(photos.organizationId, row.organizationId), eq(photos.entryId, row.id))).orderBy(asc(photos.createdAt), asc(photos.id));
  const holdReasons: string[] = [];
  if (row.state === "draft" && parentSnapshot && workdayHash(row.parentSnapshot) !== workdayHash(parentSnapshot)) holdReasons.push("workday_parent_changed");
  if (row.state === "draft" && row.assetId) {
    const [asset] = await reader.select().from(assets).where(and(eq(assets.organizationId, row.organizationId), eq(assets.id, row.assetId)));
    if (!asset || asset.status !== "active" || asset.contactId !== row.contactId || asset.propertyId !== row.propertyId || asset.version !== row.assetSnapshot?.version) holdReasons.push("workday_asset_changed");
  }
  return workdayEntrySchema.parse({ id: row.id, appointmentId: row.appointmentId, contactId: row.contactId, propertyId: row.propertyId, assetId: row.assetId, serviceObligationId: row.serviceObligationId, version: row.version, state: row.state, checklist: projectWorkdayRevision(revision), assetSnapshot: row.assetSnapshot, answers: row.answers, notes: row.notes, photos: await Promise.all(attached.map(workdayPhotoView)), completionId: row.completionId, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), holdReasons });
}
export async function readAppointmentWork(reader: WorkdayReader, org: string, actor: WorkdayActor, id: string) {
  const v = await readWorkdayVisit(reader, org, actor, id), rows = await loadWorkdayEntries(reader, org, id);
  const views = []; for (const row of rows) views.push(await workdayEntryView(reader, row, v.parentSnapshot));
  const c = await reader.select().from(completions).where(and(eq(completions.organizationId, org), eq(completions.appointmentId, id))).orderBy(desc(completions.createdAt), desc(completions.id));
  const original = c.find(row => !row.originalCompletionId), corrections = c.filter(row => row.originalCompletionId);
  const linked = await reader.select().from(services).where(and(eq(services.organizationId, org), eq(services.appointmentId, id), eq(services.contactId, v.contactId ?? "00000000-0000-0000-0000-000000000000"))).orderBy(asc(services.id));
  const active = ["scheduled", "confirmed"].includes(v.appointment.status), canWrite = v.reasons.length === 0;
  const reasons = [...v.reasons, ...views.flatMap(e => e.holdReasons)];
  // This customer is resolved only through explicit native contact/lead lineage;
  // projection does not rewrite legacy contactId:null or infer a property.
  return appointmentWorkSchema.parse({ organizationId: org, appointment: { id, contactId: v.contactId, propertyId: v.appointment.propertyId, leadId: v.appointment.leadId, assignedUserId: v.appointment.assignedUserId, status: v.appointment.status, type: v.appointment.type, scheduledStart: v.appointment.scheduledStart.toISOString(), scheduledEnd: v.appointment.scheduledEnd?.toISOString() ?? null, updatedAt: v.appointment.updatedAt.toISOString(), notes: v.appointment.notes,
    customerLabel: v.contact && !v.reasons.includes("workday_parent_changed") ? [v.contact.firstName, v.contact.lastName].filter(Boolean).join(" ") : null, propertyLabel: v.property?.contactId === v.contactId ? [v.property.addressLine1, v.property.city, v.property.state].join(", ") : null },
    entries: views, completion: original ? workdayCompletionSchema.parse(original.snapshot.result) : null,
    corrections: corrections.slice(0, 25).map(row => workdayCorrectionSchema.parse({ id: row.id, originalCompletionId: row.originalCompletionId, note: row.snapshot.note, recordedAt: row.createdAt.toISOString(), recordedByUserId: row.actorUserId })), correctionsHasMore: corrections.length > 25,
    linkedServices: linked.filter(s => !s.propertyId || !v.appointment.propertyId || s.propertyId === v.appointment.propertyId).map(s => ({ id: s.id, equipmentLabel: s.equipmentLabel, status: s.status, updatedAt: s.updatedAt.toISOString() })),
    capabilities: { canPrepare: canWrite && active && !original && rows.length < 20, canEdit: canWrite && active && !original, canCancel: v.officeWriter && !original && rows.some(r => r.state === "draft"), canComplete: canWrite && active && !original && !reasons.length && rows.some(r => r.state === "draft"), canCorrect: canWrite && !!original, requiresActingNote: v.requiresActingNote, reasons } });
}
export async function getAppointmentWork(org: string, actor: WorkdayActor, id: string) { return readAppointmentWork(db, org, actor, id); }
async function mutationResult(tx: WorkdayTx, org: string, actor: WorkdayActor, id: string, requestId: string, replayed: boolean) { return { organizationId: org, work: await readAppointmentWork(tx, org, actor, id), receipt: { requestId, replayed } }; }

export async function createAppointmentWorkEntry(org: string, actor: WorkdayActor, id: string, raw: unknown) {
  const input = createWorkdayEntrySchema.parse(raw), payload = { id, ...input };
  return db.transaction(async tx => {
    await lockWorkday(tx, org); const v = await readWorkdayVisit(tx, org, actor, id, true);
    const old = await workdayReplay(tx, org, "workday.entry_created", input.requestId, payload); if (old) return mutationResult(tx, org, actor, id, input.requestId, true);
    assertWorkdayVisitWritable(v, input.actingNote); if (v.appointment.updatedAt.toISOString() !== input.expectedAppointmentUpdatedAt) workdayFail("workday_stale_version");
    const existing = await loadWorkdayEntries(tx, org, id, true); if (existing.length >= 20) workdayFail("workday_entry_limit");
    const [revision] = await tx.select().from(revisions).where(and(eq(revisions.organizationId, org), eq(revisions.id, input.checklistRevisionId))).for("share");
    if (!revision?.reviewedAt) workdayFail("workday_reviewed_checklist_required");
    const [template] = await tx.select().from(templates).where(and(eq(templates.organizationId, org), eq(templates.id, revision.templateId))).for("share");
    const [latest] = await tx.select().from(revisions).where(and(eq(revisions.organizationId, org), eq(revisions.templateId, revision.templateId))).orderBy(desc(revisions.version)).limit(1);
    if (template?.status !== "reviewed" || latest?.id !== revision.id || revision.definitionSha256 !== workdayHash(revision.definition)) workdayFail("workday_reviewed_checklist_required");
    let assetSnapshot: Record<string, unknown> | null = null;
    if (input.assetId) {
      const [asset] = await tx.select().from(assets).where(and(eq(assets.organizationId, org), eq(assets.id, input.assetId))).for("share");
      if (!asset || asset.status !== "active" || !v.appointment.propertyId || asset.propertyId !== v.appointment.propertyId || asset.contactId !== v.contactId) workdayFail("workday_asset_changed");
      assetSnapshot = { ...asset.facts, id: asset.id, version: asset.version };
    }
    if (input.serviceObligationId) {
      const [s] = await tx.select().from(services).where(and(eq(services.organizationId, org), eq(services.id, input.serviceObligationId))).for("share");
      if (!s || s.status !== "active" || s.appointmentId !== id || s.contactId !== v.contactId || (s.propertyId && s.propertyId !== v.appointment.propertyId)) workdayFail("workday_service_changed");
    }
    const [entry] = await tx.insert(entries).values({ organizationId: org, appointmentId: id, contactId: v.contactId!, propertyId: v.appointment.propertyId, assetId: input.assetId, serviceObligationId: input.serviceObligationId, checklistRevisionId: revision.id, parentSnapshot: v.parentSnapshot, assetSnapshot, createdByUserId: actor.userId }).returning();
    await workdayAudit(tx, org, actor.userId, "workday.entry_created", entry.id, input.requestId, payload, { entryId: entry.id });
    return mutationResult(tx, org, actor, id, input.requestId, false);
  });
}
export async function requireWorkdayEntry(tx: WorkdayTx, org: string, appointmentId: string, entryId: string, expectedVersion: number, parentSnapshot: unknown) {
  const [entry] = await tx.select().from(entries).where(and(eq(entries.organizationId, org), eq(entries.appointmentId, appointmentId), eq(entries.id, entryId))).for("update");
  if (!entry || entry.state !== "draft") workdayFail("workday_entry_unavailable"); workdayVersion(entry.version, expectedVersion);
  const view = await workdayEntryView(tx, entry, parentSnapshot); if (view.holdReasons.length) workdayFail(view.holdReasons[0]);
  return { entry, view };
}
export function validateWorkdayAnswers(definition: WorkdayDefinition, answers: WorkdayAnswer[], final: boolean, photoItems: Set<string> = new Set()) {
  if (new Set(answers.map(a => a.itemKey)).size !== answers.length) workdayFail("workday_duplicate_answer", "Answer each checklist item once.", 400);
  for (const answer of answers) {
    const item = definition.items.find(i => i.key === answer.itemKey); if (!item) workdayFail("workday_unknown_item", "Use the saved reviewed checklist items.", 400);
    if (answer.result === "not_applicable") { if (!item.allowNotApplicable || !answer.reason?.trim() || answer.value !== null) workdayFail("workday_na_reason_required", "This item does not allow N/A or needs a reason.", 400); continue; }
    if (answer.result === "needs_attention" && !answer.reason?.trim()) workdayFail("workday_attention_reason_required", "Record the observed issue without an unsupported safety conclusion.", 400);
    if (item.kind === "number" && (typeof answer.value !== "number" || !Number.isFinite(answer.value))) workdayFail("workday_numeric_observation_required", "Enter a numeric observation with the reviewed unit.", 400);
    if (item.kind === "text" && (typeof answer.value !== "string" || !answer.value.trim())) workdayFail("workday_text_required", "Record the observed result.", 400);
    if ((item.kind === "result" || item.kind === "photo") && answer.value !== null) workdayFail("workday_invalid_answer", "This checklist item has no text or numeric value.", 400);
    if (final && item.kind === "photo" && !photoItems.has(item.key)) workdayFail("workday_photo_required", "Attach the required photo to its reviewed checklist item.");
  }
  if (final && definition.items.some(item => item.required && !answers.some(a => a.itemKey === item.key))) workdayFail("workday_required_answers", "Complete every required reviewed checklist item before finishing.");
}
export async function saveAppointmentWorkEntry(org: string, actor: WorkdayActor, id: string, entryId: string, raw: unknown) {
  const input = saveWorkdayEntrySchema.parse(raw), payload = { id, entryId, ...input };
  return db.transaction(async tx => {
    await lockWorkday(tx, org); const v = await readWorkdayVisit(tx, org, actor, id, true);
    const old = await workdayReplay(tx, org, "workday.entry_saved", input.requestId, payload); if (old) return mutationResult(tx, org, actor, id, input.requestId, true);
    assertWorkdayVisitWritable(v, input.actingNote); const { entry, view } = await requireWorkdayEntry(tx, org, id, entryId, input.expectedVersion, v.parentSnapshot);
    validateWorkdayAnswers(view.checklist.definition, input.answers, false);
    await tx.update(entries).set({ answers: input.answers, notes: input.notes, version: entry.version + 1, updatedAt: new Date() }).where(eq(entries.id, entryId));
    await workdayAudit(tx, org, actor.userId, "workday.entry_saved", entryId, input.requestId, payload, { entryId, version: entry.version + 1 });
    return mutationResult(tx, org, actor, id, input.requestId, false);
  });
}
export async function cancelAppointmentWorkEntry(org: string, actor: WorkdayActor, id: string, entryId: string, raw: unknown) {
  const input = cancelWorkdayEntrySchema.parse(raw), payload = { id, entryId, ...input };
  return db.transaction(async tx => {
    await lockWorkday(tx, org); const v = await readWorkdayVisit(tx, org, actor, id, true);
    // Explicit cancellation is the re-preparation path when asset/parent identity changed.
    // This fresh office/write authority is independent of permission to edit or
    // attest the held work; the same predicate drives the read-only capability.
    if (!v.officeWriter) workdayFail("workday_office_required", "The office must explicitly cancel prepared work before replacing it.", 403);
    const old = await workdayReplay(tx, org, "workday.entry_cancelled", input.requestId, payload); if (old) return mutationResult(tx, org, actor, id, input.requestId, true);
    if (v.requiresActingNote && !input.actingNote) workdayFail("workday_acting_note_required");
    const [original] = await tx.select({ id: completions.id }).from(completions).where(and(eq(completions.organizationId, org), eq(completions.appointmentId, id), isNull(completions.originalCompletionId))).for("share");
    if (original) workdayFail("workday_completion_required", "Recorded work is sealed. Use an append-only correction, not cancellation.");
    const [entry] = await tx.select().from(entries).where(and(eq(entries.organizationId, org), eq(entries.appointmentId, id), eq(entries.id, entryId))).for("update");
    if (!entry || entry.state !== "draft") workdayFail("workday_entry_unavailable"); workdayVersion(entry.version, input.expectedVersion);
    await tx.update(entries).set({ state: "cancelled", version: entry.version + 1, updatedAt: new Date() }).where(eq(entries.id, entryId));
    await workdayAudit(tx, org, actor.userId, "workday.entry_cancelled", entryId, input.requestId, payload, { entryId });
    return mutationResult(tx, org, actor, id, input.requestId, false);
  });
}

type CompletionIntent = ReturnType<typeof previewWorkdayCompletionSchema.parse>;
async function completionSnapshot(tx: WorkdayTx, org: string, actor: WorkdayActor, id: string, intent: CompletionIntent) {
  const v = await readWorkdayVisit(tx, org, actor, id, true); assertWorkdayVisitWritable(v, intent.actingNote);
  if (v.appointment.updatedAt.toISOString() !== intent.expectedAppointmentUpdatedAt) workdayFail("workday_stale_version");
  if (Date.parse(intent.performedAt) > Date.now()) workdayFail("workday_future_performance", "Record when work was actually performed, not a future visit.", 400);
  if (intent.outcome === "needs_followup" ? !intent.followup : !!intent.followup) workdayFail("workday_followup_required", "A follow-up outcome requires its explicit owner, deadline and office note.", 400);
  if (intent.followup) {
    if (Date.parse(intent.followup.dueAt) <= Date.now() || Date.parse(intent.followup.dueAt) > Date.now() + 365 * 86_400_000) workdayFail("workday_followup_deadline", "Choose a future next-action deadline within one year.", 400);
    await workdayActor(tx, org, { userId: intent.followup.assignedUserId }, "crm.write", true);
  }
  const rows = (await loadWorkdayEntries(tx, org, id, true)).filter(e => e.state !== "cancelled");
  if (!rows.length || rows.some(e => e.state !== "draft") || new Set(intent.entries.map(e => e.id)).size !== rows.length || intent.entries.length !== rows.length || rows.some(e => !intent.entries.some(expected => expected.id === e.id && expected.version === e.version))) workdayFail("workday_saved_entries_changed");
  const views = [];
  for (const row of rows) {
    if (row.assetId) await tx.select().from(assets).where(and(eq(assets.organizationId, org), eq(assets.id, row.assetId))).for("share");
    const view = await workdayEntryView(tx, row, v.parentSnapshot); if (view.holdReasons.length) workdayFail(view.holdReasons[0]);
    const proofPhotos = await tx.select().from(photos).where(and(eq(photos.organizationId, org), eq(photos.entryId, row.id), eq(photos.state, "attached"))).orderBy(asc(photos.id)).for("share");
    for (const photo of proofPhotos) {
      const [object] = await tx.select().from(storedObjectsTable).where(and(eq(storedObjectsTable.organizationId, org), eq(storedObjectsTable.id, photo.objectId!))).for("share");
      if (!object || object.sizeBytes !== photo.sizeBytes || object.contentType !== photo.contentType || createHash("sha256").update(object.data).digest("hex") !== photo.objectSha256) workdayFail("workday_photo_unavailable", "An attached photo is unavailable. Review the saved work before finishing.");
    }
    validateWorkdayAnswers(view.checklist.definition, view.answers, true, new Set(view.photos.filter(p => p.state === "attached" && p.itemKey).map(p => p.itemKey!)));
    if (view.answers.some(a => a.result === "needs_attention") && intent.outcome !== "needs_followup") workdayFail("workday_attention_followup_required", "Needs-attention observations require an accountable follow-up.");
    views.push(view);
  }
  const selected = [...new Set(intent.serviceObligationIds)].sort(); if (selected.length !== intent.serviceObligationIds.length) workdayFail("workday_duplicate_service");
  const serviceRows = await tx.select().from(services).where(and(eq(services.organizationId, org), eq(services.appointmentId, id))).orderBy(asc(services.id)).for("update");
  const tasks: (typeof crmTasksTable.$inferSelect)[] = [];
  const enrolledServiceIds = [...new Set(rows.map(r => r.serviceObligationId).filter((x): x is string => !!x))];
  if (enrolledServiceIds.some(serviceId => !serviceRows.some(s => s.id === serviceId && s.status === "active"))) workdayFail("workday_service_changed");
  for (const s of serviceRows) {
    if (s.contactId !== v.contactId || (s.propertyId && s.propertyId !== v.appointment.propertyId)) workdayFail("workday_service_changed");
    const [task] = await tx.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.id, s.taskId))).for("share");
    if (!task || (task.contactId && task.contactId !== v.contactId)) workdayFail("workday_service_task_changed");
    tasks.push(task);
  }
  if (selected.some(serviceId => !enrolledServiceIds.includes(serviceId))) workdayFail("workday_service_not_enrolled");
  const hash = workdayHash({ parent: v.parentSnapshot, appointment: v.appointment, entries: rows, photos: views.map(e => e.photos), services: serviceRows, tasks, intent });
  return { v, rows, views, serviceRows, tasks, hash };
}
export async function previewAppointmentWorkCompletion(org: string, actor: WorkdayActor, id: string, raw: unknown) {
  const intent = previewWorkdayCompletionSchema.parse(raw);
  return db.transaction(async tx => { await lockWorkday(tx, org); const saved = await completionSnapshot(tx, org, actor, id, intent);
    return { organizationId: org, appointmentId: id, ...signWorkdayReview("completion", org, actor.userId, { id, hash: saved.hash, intent }), entries: saved.views, intent, serviceVersions: saved.serviceRows.map(s => ({ id: s.id, updatedAt: s.updatedAt.toISOString() })), warning: "Staff-recorded work; not warranty coverage, customer acceptance, invoice delivery or payment." as const }; });
}
export async function completeAppointmentWork(org: string, actor: WorkdayActor, id: string, raw: unknown) {
  const input = completeWorkdaySchema.parse(raw), payload = { id, ...input };
  return db.transaction(async tx => {
    await lockWorkday(tx, org); await workdayActor(tx, org, actor, "crm.read", true);
    const [old] = await tx.select().from(completions).where(and(eq(completions.organizationId, org), eq(completions.requestId, input.requestId)));
    if (old) { if (old.payloadSha256 !== workdayHash(payload) || old.appointmentId !== id || old.actorUserId !== actor.userId || old.originalCompletionId) workdayFail("workday_request_conflict"); return mutationResult(tx, org, actor, id, input.requestId, true); }
    const proof = readWorkdayReview<{ id: string; hash: string; intent: CompletionIntent }>(input.previewToken, "completion", org, actor.userId);
    if (proof.id !== id) workdayFail("workday_review_invalid");
    const intent = previewWorkdayCompletionSchema.parse(proof.intent), saved = await completionSnapshot(tx, org, actor, id, intent);
    if (proof.hash !== saved.hash) workdayFail("workday_review_changed");
    const [existing] = await tx.select().from(completions).where(and(eq(completions.organizationId, org), eq(completions.appointmentId, id), isNull(completions.originalCompletionId)));
    if (existing) workdayFail("workday_already_completed");
    const completionId = randomUUID(), now = new Date(), selected = saved.serviceRows.filter(s => intent.serviceObligationIds.includes(s.id));
    let followupTaskId: string | null = null;
    if (intent.followup) {
      const [task] = await tx.insert(crmTasksTable).values({ organizationId: org, contactId: saved.v.contactId, leadId: saved.v.appointment.leadId, assignedUserId: intent.followup.assignedUserId, title: "Follow up on recorded visit work", description: intent.followup.note, dueAt: new Date(intent.followup.dueAt), sourceEvent: `appointment.work_followup:${id}` }).returning(); followupTaskId = task.id;
    }
    const result = { id: completionId, appointmentId: id, contactId: saved.v.contactId!, propertyId: saved.v.appointment.propertyId, requestId: input.requestId, performedAt: intent.performedAt, recordedAt: now.toISOString(), recordedByUserId: actor.userId, performerUserId: saved.v.performer!.id, actingNote: intent.actingNote ?? null, summary: intent.summary, outcome: intent.outcome, followupTaskId,
      entries: saved.rows.map(e => ({ id: e.id, version: e.version, checklistRevisionId: e.checklistRevisionId, assetId: e.assetId })), services: selected.map(s => ({ id: s.id, nextObligationId: null as string | null })), nativeAppointmentStatus: "completed" as const };
    const snapshot = { result, services: result.services, entryEvidence: saved.views, parent: saved.v.parentSnapshot, nativeBefore: saved.v.appointment, tasksBefore: saved.tasks };
    await tx.insert(completions).values({ id: completionId, organizationId: org, appointmentId: id, contactId: saved.v.contactId!, propertyId: saved.v.appointment.propertyId, requestId: input.requestId, payloadSha256: workdayHash(payload), actorUserId: actor.userId, snapshot });
    await tx.update(entries).set({ state: "finalized", completionId, updatedAt: now }).where(and(eq(entries.organizationId, org), inArray(entries.id, saved.rows.map(e => e.id))));
    const appointment = await completeWorkdayAppointmentInTransaction(tx, org, id, intent.expectedAppointmentUpdatedAt, completionId);
    if (!appointment || typeof appointment === "string") workdayFail("workday_native_completion_failed");
    for (const service of selected) {
      const completed = await completeWorkdayServiceInTransaction(tx, org, actor.userId, service.id, service.updatedAt.toISOString(), completionId);
      if (completed.error) workdayFail(`workday_${completed.error}`);
      result.services.find(s => s.id === service.id)!.nextObligationId = completed.nextObligationId;
    }
    // Finalize only this newly inserted original record inside the same transaction.
    await tx.update(completions).set({ snapshot: { ...snapshot, result, services: result.services } }).where(eq(completions.id, completionId));
    await workdayAudit(tx, org, actor.userId, "workday.completed", completionId, input.requestId, payload, { completionId, followupTaskId, serviceIds: selected.map(s => s.id) });
    return mutationResult(tx, org, actor, id, input.requestId, false);
  });
}
export async function correctAppointmentWork(org: string, actor: WorkdayActor, id: string, completionId: string, raw: unknown) {
  const input = correctWorkdaySchema.parse(raw), payload = { id, completionId, ...input };
  return db.transaction(async tx => {
    await lockWorkday(tx, org); const v = await readWorkdayVisit(tx, org, actor, id, true); assertWorkdayVisitWritable(v, input.actingNote, true);
    const [old] = await tx.select().from(completions).where(and(eq(completions.organizationId, org), eq(completions.requestId, input.requestId)));
    if (old) { if (old.payloadSha256 !== workdayHash(payload) || old.originalCompletionId !== completionId) workdayFail("workday_request_conflict"); return mutationResult(tx, org, actor, id, input.requestId, true); }
    const [original] = await tx.select().from(completions).where(and(eq(completions.organizationId, org), eq(completions.id, completionId), eq(completions.appointmentId, id), isNull(completions.originalCompletionId)));
    if (!original) workdayFail("workday_completion_missing", "Original completion unavailable.", 404);
    await tx.insert(completions).values({ organizationId: org, appointmentId: id, contactId: original.contactId, propertyId: original.propertyId, originalCompletionId: completionId, requestId: input.requestId, payloadSha256: workdayHash(payload), actorUserId: actor.userId, snapshot: { note: input.note, actingNote: input.actingNote ?? null } });
    await workdayAudit(tx, org, actor.userId, "workday.corrected", completionId, input.requestId, payload, { completionId });
    return mutationResult(tx, org, actor, id, input.requestId, false);
  });
}
