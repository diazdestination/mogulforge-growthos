import { db, workChecklistRevisionsTable as revisions, workChecklistTemplatesTable as templates } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { hasPermission } from "../lib/permissions";
import { WORKDAY_CHECKLIST_STARTERS } from "./contractor-workday-baselines";
import { approveWorkdayTemplateSchema, createWorkdayTemplateSchema, previewWorkdayTemplateSchema, retireWorkdayTemplateSchema, reviseWorkdayTemplateSchema, workdayRevisionSchema, workdayTemplateCatalogSchema, workdayTemplateMutationSchema, workdayTemplateSchema } from "./contractor-workday-contract";
import { lockWorkday, readWorkdayReview, signWorkdayReview, workdayActor, workdayAudit, workdayFail, workdayHash, workdayReplay, workdayVersion, type WorkdayActor, type WorkdayReader } from "./workday-shared";

export function projectWorkdayRevision(row: typeof revisions.$inferSelect) {
  return workdayRevisionSchema.parse({ id: row.id, templateId: row.templateId, version: row.version, definition: row.definition, definitionSha256: row.definitionSha256, baselineId: row.baselineId, baselineVersion: row.baselineVersion, createdAt: row.createdAt.toISOString(), createdByUserId: row.createdByUserId, reviewedAt: row.reviewedAt?.toISOString() ?? null, reviewedByUserId: row.reviewedByUserId });
}
export async function readWorkdayTemplate(reader: WorkdayReader, org: string, id: string, locked = false) {
  const q = reader.select().from(templates).where(and(eq(templates.organizationId, org), eq(templates.id, id)));
  const [row] = await (locked ? q.for("update") : q);
  if (!row) workdayFail("workday_template_missing", "Checklist unavailable in this company.", 404);
  const rows = await reader.select().from(revisions).where(and(eq(revisions.organizationId, org), eq(revisions.templateId, id))).orderBy(desc(revisions.version));
  if (!rows.length) workdayFail("workday_template_invalid");
  return { row, rows, view: workdayTemplateSchema.parse({ id, organizationId: org, version: row.version, status: row.status, latestRevision: projectWorkdayRevision(rows[0]), approvedRevision: rows.find(r => r.reviewedAt) ? projectWorkdayRevision(rows.find(r => r.reviewedAt)!) : null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }) };
}
export async function getWorkdayTemplate(org: string, actor: WorkdayActor, id: string) { await workdayActor(db, org, actor); return (await readWorkdayTemplate(db, org, id)).view; }
export async function listWorkdayTemplates(org: string, actor: WorkdayActor) {
  const user = await workdayActor(db, org, actor), ids = await db.select({ id: templates.id }).from(templates).where(eq(templates.organizationId, org)).orderBy(desc(templates.createdAt), desc(templates.id)).limit(101);
  const views = [];
  for (const row of ids.slice(0, 100)) views.push((await readWorkdayTemplate(db, org, row.id)).view);
  return workdayTemplateCatalogSchema.parse({ organizationId: org, templates: views, starters: WORKDAY_CHECKLIST_STARTERS, canManage: hasPermission(user.role, "settings.manage") && hasPermission(actor.effectiveRole ?? user.role, "settings.manage"), limit: 100, limitReached: ids.length > 100 });
}
export async function createWorkdayTemplate(org: string, actor: WorkdayActor, raw: unknown) {
  const input = createWorkdayTemplateSchema.parse(raw);
  const starter = input.baselineId ? WORKDAY_CHECKLIST_STARTERS.find(s => s.id === input.baselineId) : null;
  if (input.baselineId && !starter) workdayFail("workday_baseline_missing", "Choose an available researched starter or create a blank company checklist.", 400);
  return db.transaction(async tx => {
    await lockWorkday(tx, org); await workdayActor(tx, org, actor, "settings.manage", true);
    const old = await workdayReplay(tx, org, "workday.template_created", input.requestId, input);
    if (old) return workdayTemplateMutationSchema.parse({ ...old, receipt: { requestId: input.requestId, replayed: true } });
    const [template] = await tx.insert(templates).values({ organizationId: org, createdByUserId: actor.userId }).returning();
    await tx.insert(revisions).values({ organizationId: org, templateId: template.id, version: 1, definition: input.definition, definitionSha256: workdayHash(input.definition), baselineId: starter?.id ?? null, baselineVersion: starter?.version ?? null, createdByUserId: actor.userId });
    const result = { organizationId: org, template: (await readWorkdayTemplate(tx, org, template.id)).view };
    await workdayAudit(tx, org, actor.userId, "workday.template_created", template.id, input.requestId, input, result);
    return { ...result, receipt: { requestId: input.requestId, replayed: false } };
  });
}
export async function reviseWorkdayTemplate(org: string, actor: WorkdayActor, id: string, raw: unknown) {
  const input = reviseWorkdayTemplateSchema.parse(raw), payload = { id, ...input };
  return db.transaction(async tx => {
    await lockWorkday(tx, org); await workdayActor(tx, org, actor, "settings.manage", true);
    const old = await workdayReplay(tx, org, "workday.template_revised", input.requestId, payload);
    if (old) return workdayTemplateMutationSchema.parse({ ...old, receipt: { requestId: input.requestId, replayed: true } });
    const { row, rows } = await readWorkdayTemplate(tx, org, id, true); workdayVersion(row.version, input.expectedVersion);
    await tx.insert(revisions).values({ organizationId: org, templateId: id, version: rows[0].version + 1, definition: input.definition, definitionSha256: workdayHash(input.definition), baselineId: rows[0].baselineId, baselineVersion: rows[0].baselineVersion, createdByUserId: actor.userId });
    await tx.update(templates).set({ version: row.version + 1, status: "draft", updatedAt: new Date() }).where(eq(templates.id, id));
    const result = { organizationId: org, template: (await readWorkdayTemplate(tx, org, id)).view };
    await workdayAudit(tx, org, actor.userId, "workday.template_revised", id, input.requestId, payload, result);
    return { ...result, receipt: { requestId: input.requestId, replayed: false } };
  });
}
export async function previewWorkdayTemplate(org: string, actor: WorkdayActor, id: string, raw: unknown) {
  const input = previewWorkdayTemplateSchema.parse(raw); await workdayActor(db, org, actor, "settings.manage");
  const { row, rows } = await readWorkdayTemplate(db, org, id); workdayVersion(row.version, input.expectedVersion);
  if (rows[0].id !== input.revisionId || row.status === "retired" || rows[0].reviewedAt) workdayFail("workday_review_unavailable", "Review the latest saved unapproved company draft.");
  const signed = signWorkdayReview("template", org, actor.userId, { id, version: row.version, revisionId: rows[0].id, hash: rows[0].definitionSha256 });
  return { organizationId: org, templateId: id, expectedVersion: row.version, revision: projectWorkdayRevision(rows[0]), ...signed };
}
export async function approveWorkdayTemplate(org: string, actor: WorkdayActor, id: string, raw: unknown) {
  const input = approveWorkdayTemplateSchema.parse(raw), payload = { id, ...input };
  return db.transaction(async tx => {
    await lockWorkday(tx, org); await workdayActor(tx, org, actor, "settings.manage", true);
    const old = await workdayReplay(tx, org, "workday.template_approved", input.requestId, payload);
    if (old) return workdayTemplateMutationSchema.parse({ ...old, receipt: { requestId: input.requestId, replayed: true } });
    const proof = readWorkdayReview<{ id: string; version: number; revisionId: string; hash: string }>(input.previewToken, "template", org, actor.userId);
    const { row, rows } = await readWorkdayTemplate(tx, org, id, true);
    if (proof.id !== id || row.version !== proof.version || row.status === "retired" || rows[0].id !== proof.revisionId || rows[0].definitionSha256 !== proof.hash || rows[0].reviewedAt) workdayFail("workday_review_changed");
    await tx.update(revisions).set({ reviewedAt: new Date(), reviewedByUserId: actor.userId }).where(eq(revisions.id, proof.revisionId));
    await tx.update(templates).set({ version: row.version + 1, status: "reviewed", updatedAt: new Date() }).where(eq(templates.id, id));
    const result = { organizationId: org, template: (await readWorkdayTemplate(tx, org, id)).view };
    await workdayAudit(tx, org, actor.userId, "workday.template_approved", id, input.requestId, payload, result);
    return { ...result, receipt: { requestId: input.requestId, replayed: false } };
  });
}
export async function retireWorkdayTemplate(org: string, actor: WorkdayActor, id: string, raw: unknown) {
  const input = retireWorkdayTemplateSchema.parse(raw), payload = { id, ...input };
  return db.transaction(async tx => {
    await lockWorkday(tx, org); await workdayActor(tx, org, actor, "settings.manage", true);
    const old = await workdayReplay(tx, org, "workday.template_retired", input.requestId, payload);
    if (old) return workdayTemplateMutationSchema.parse({ ...old, receipt: { requestId: input.requestId, replayed: true } });
    const { row } = await readWorkdayTemplate(tx, org, id, true); workdayVersion(row.version, input.expectedVersion);
    await tx.update(templates).set({ status: "retired", version: row.version + 1, updatedAt: new Date() }).where(eq(templates.id, id));
    const result = { organizationId: org, template: (await readWorkdayTemplate(tx, org, id)).view };
    await workdayAudit(tx, org, actor.userId, "workday.template_retired", id, input.requestId, payload, result);
    return { ...result, receipt: { requestId: input.requestId, replayed: false } };
  });
}
