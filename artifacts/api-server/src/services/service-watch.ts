import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { appointmentsTable, auditEventsTable, contactsTable, crmTasksTable, db, orgSettingsTable, revenueExecutionsTable, scheduledActionsTable, serviceObligationsTable, usersTable } from "@workspace/db";
import { serviceWatchCasesTable as cases, type ServiceWatchState } from "../../../../lib/db/src/schema/service-watch";
import { hasPermission } from "../lib/permissions";
import { assertOperationalStaff, lockContractorSchedule, type ScheduleTransaction } from "./contractor-scheduling";
import { getCustomerLifecycleStatus } from "./customer-lifecycle";
import { careFingerprint } from "./service-care-policy";
import { serviceNoticeAt } from "./service-obligations";
import { enqueueStaffServiceNotice } from "./staff-push";
import { serviceWatchCommand, serviceWatchQuery, serviceWatchReasons, WATCH_BATCH_SIZE, WATCH_PAGE_SIZE } from "./service-watch-policy";
import { serviceMailboxReplyFacts } from "./mailbox-communication";
import { serviceSmsReplyFacts } from "./service-sms";

type Case = typeof cases.$inferSelect;
type Reader = typeof db | ScheduleTransaction;
const where = (org: string, id: string) => and(eq(cases.organizationId, org), eq(cases.serviceObligationId, id));
export class ServiceWatchError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
function fail(code: string, message: string, status = 409): never { throw new ServiceWatchError(code, message, status); }
async function member(reader: Reader, org: string, actor: string, write = false) {
  const [user] = await reader.select().from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.id, actor)));
  if (!user || !user.isActive || !user.emailVerifiedAt || user.id.startsWith("invite:") || !hasPermission(user.role, write ? "crm.write" : "crm.read")) fail("staff_required", "Accepted active company staff access is required.", 403);
}
async function lock(tx: ScheduleTransaction, org: string) {
  // The lifecycle lock comes first; neither lane takes these locks in reverse.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`customer-lifecycle:${org}`}, 0))`);
  await lockContractorSchedule(tx, org);
}
async function latest(reader: Reader, org: string, id: string, action: string) {
  const [event] = await reader.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.entityType, "service_obligation"), eq(auditEventsTable.entityId, id), eq(auditEventsTable.action, action))).orderBy(desc(auditEventsTable.createdAt), desc(auditEventsTable.id)).limit(1);
  return event ?? null;
}
function calendarDate(now: Date, candidate: unknown) {
  let timezone = typeof candidate === "string" ? candidate : "UTC", fallback = false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(now); } catch { timezone = "UTC"; fallback = true; }
  if (!candidate) fallback = true;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  return { today: `${part("year")}-${part("month")}-${part("day")}`, timezone, timezoneFallback: fallback };
}
async function observe(reader: Reader, org: string, id: string, current: Case | null, now: Date) {
  const [service] = await reader.select().from(serviceObligationsTable).where(and(eq(serviceObligationsTable.organizationId, org), eq(serviceObligationsTable.id, id)));
  if (!service) fail("not_found", "Service is not available in this company.", 404);
  const [task] = await reader.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.id, service.taskId)));
  const [contact] = await reader.select().from(contactsTable).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, service.contactId)));
  if (!task || !contact) fail("source_unavailable", "The canonical customer or office task is unavailable. Operator review is required.");
  const [owner] = task.assignedUserId ? await reader.select().from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.id, task.assignedUserId))) : [];
  const ownerValid = !!owner && owner.isActive && !!owner.emailVerifiedAt && !owner.id.startsWith("invite:") && hasPermission(owner.role, "crm.write");
  const [appointment] = service.appointmentId ? await reader.select().from(appointmentsTable).where(and(eq(appointmentsTable.organizationId, org), eq(appointmentsTable.id, service.appointmentId))) : [];
  const approval = await latest(reader, org, id, "service.care_reminder_approved");
  const accepted = await latest(reader, org, id, "service.care_reminder_accepted");
  const response = await latest(reader, org, id, "service.care_response_recorded");
  const mailboxReply = await serviceMailboxReplyFacts(org, id, reader);
  const smsReply = await serviceSmsReplyFacts(org, id, reader);
  const saved = approval?.metadata as { scheduledActionId?: string; snapshot?: { updatedAt?: string } } | undefined;
  const [scheduled] = saved?.scheduledActionId ? await reader.select().from(scheduledActionsTable).where(and(eq(scheduledActionsTable.organizationId, org), eq(scheduledActionsTable.id, saved.scheduledActionId))) : [];
  const [receipt] = saved?.scheduledActionId ? await reader.select().from(revenueExecutionsTable).where(and(eq(revenueExecutionsTable.organizationId, org), eq(revenueExecutionsTable.actionKey, `scheduled:${saved.scheduledActionId}`))) : [];
  const lifecycle = await getCustomerLifecycleStatus(org, reader);
  const [settings] = await reader.select({ availability: orgSettingsTable.inspectionAvailability }).from(orgSettingsTable).where(eq(orgSettingsTable.organizationId, org));
  const calendar = calendarDate(now, settings?.availability?.timezone);
  const facts = {
    active: service.status === "active", dueDate: service.dueAt.toISOString().slice(0, 10), today: calendar.today,
    noticeAt: serviceNoticeAt(service.dueAt, service.noticeDays), booked: !!appointment && ["scheduled", "confirmed"].includes(appointment.status),
    appointmentStatus: appointment?.status ?? null, approval: !!approval,
    approvalChanged: !!approval && !receipt && saved?.snapshot?.updatedAt !== service.updatedAt.toISOString(),
    scheduledState: scheduled?.status ?? null, receiptState: receipt?.state ?? null, receiptExpiresAt: receipt?.expiresAt ?? null,
    acceptedAt: accepted?.createdAt ?? null, responseRecorded: !!response,
    mailboxReplyNeedsReview: !!mailboxReply && (mailboxReply.state === "needs_review" || !response || response.createdAt < mailboxReply.recordedAt) ||
      !!smsReply && (smsReply.state === "needs_review" || !response || response.createdAt < smsReply.recordedAt), ownerValid,
    nextActionAt: current && ["open", "acknowledged", "held"].includes(current.state) ? current.nextActionAt : null,
  };
  const reasons = serviceWatchReasons(facts, now);
  const source = { serviceVersion: service.updatedAt.toISOString(), taskVersion: task.updatedAt.toISOString(), contactVersion: contact.updatedAt.toISOString(), appointmentVersion: appointment?.updatedAt.toISOString() ?? null,
    appointmentId: appointment?.id ?? null, approvalId: approval?.id ?? null, acceptedId: accepted?.id ?? null, responseId: response?.id ?? null,
    mailboxReplyId: mailboxReply?.id ?? null, mailboxReplyVersion: mailboxReply?.version ?? null,
    smsReplyId: smsReply?.id ?? null, smsReplyVersion: smsReply?.version ?? null, smsReplyCorrelation: smsReply?.correlation ?? null,
    scheduledState: scheduled?.status ?? null, receiptState: receipt?.state ?? null, ownerId: owner?.id ?? null, ownerValid,
    lifecycleState: lifecycle.state, lifecycleVersion: lifecycle.version, reasons, nextActionAt: facts.nextActionAt?.toISOString() ?? null, timezone: calendar.timezone };
  return { service, task, contact, owner, ownerValid, reasons, fingerprint: careFingerprint(source), held: !lifecycle.automationAllowed,
    calendar, receiptState: receipt?.state ?? null, customerLabel: `${contact.firstName} ${contact.lastName ?? ""}`.trim() };
}
function projection(current: Case | null, observation: Awaited<ReturnType<typeof observe>>, now: Date) {
  const { reasons } = observation;
  const changedAttention = !current || careFingerprint(current.reasons) !== careFingerprint(reasons) || current.assignedUserId !== (observation.owner?.id ?? null);
  const state: ServiceWatchState = observation.held && (reasons.length > 0 || (current?.episode ?? 0) > 0) ? "held"
    : !reasons.length ? (current?.episode ? "resolved" : "clear")
    : current?.state === "acknowledged" && !changedAttention && !!current.nextActionAt && current.nextActionAt > now ? "acknowledged" : "open";
  return { state, reasons, changedAttention };
}
async function audit(tx: ScheduleTransaction, row: Case, action: string, actor: string | null, metadata: Record<string, unknown> = {}) {
  await tx.insert(auditEventsTable).values({ organizationId: row.organizationId, actorUserId: actor, action: `service.watch_${action}`, entityType: "service_obligation", entityId: row.serviceObligationId,
    metadata: { caseId: row.id, version: row.version, episode: row.episode, state: row.state, reasons: row.reasons, assignedUserId: row.assignedUserId, ...metadata } });
}
async function enqueue(tx: ScheduleTransaction, row: Case, now: Date) {
  if (row.state !== "open" || !row.assignedUserId) return;
  await enqueueStaffServiceNotice({ organizationId: row.organizationId, serviceObligationId: row.serviceObligationId, caseId: row.id, assignedUserId: row.assignedUserId,
    eventKey: `service-watch:${row.id}:${row.noticeRevision}`, noticeRevision: row.noticeRevision, occurredAt: now }, tx);
}
async function reconcile(tx: ScheduleTransaction, org: string, id: string, current: Case | null, now: Date) {
  const observation = await observe(tx, org, id, current, now);
  const next = projection(current, observation, now);
  const transition = !current || current.state !== next.state || next.changedAttention;
  const changed = transition || current.observedFingerprint !== observation.fingerprint;
  const opened = next.state === "open" && (!current || ["clear", "resolved", "held", "acknowledged"].includes(current.state));
  const values = { state: next.state, reasons: next.reasons, observedFingerprint: observation.fingerprint,
    assignedUserId: observation.owner?.id ?? null, version: (current?.version ?? 0) + (changed ? 1 : 0),
    episode: (current?.episode ?? 0) + (opened ? 1 : 0), noticeRevision: (current?.noticeRevision ?? 0) + (transition ? 1 : 0),
    resolvedAt: next.state === "resolved" ? (current?.state === "resolved" ? current.resolvedAt : now) : null,
    lastEvaluatedAt: now, updatedAt: changed ? now : current!.updatedAt };
  const [row] = current ? await tx.update(cases).set(values).where(eq(cases.id, current.id)).returning()
    : await tx.insert(cases).values({ organizationId: org, serviceObligationId: id, ...values, createdAt: now }).returning();
  if (transition && (row.episode || row.state === "held" || row.reasons.length)) {
    const action = opened ? (current?.episode ? "reopened" : "opened") : row.state === "resolved" ? "resolved" : row.state === "held" ? "held" : "changed";
    await audit(tx, row, action, null, { previousState: current?.state ?? null, evidence: "canonical_record_observation_not_customer_contact" });
    if (observation.ownerValid) await enqueue(tx, row, now);
  }
  return row;
}

/** Bootstrap and rotation have independent bounds; held/old work cannot starve later rows. */
export async function processServiceWatch(organizationId?: string, now = new Date()) {
  const missing = await db.select({ org: serviceObligationsTable.organizationId, id: serviceObligationsTable.id }).from(serviceObligationsTable)
    .leftJoin(cases, and(eq(cases.organizationId, serviceObligationsTable.organizationId), eq(cases.serviceObligationId, serviceObligationsTable.id)))
    .where(and(isNull(cases.id), organizationId ? eq(serviceObligationsTable.organizationId, organizationId) : undefined))
    .orderBy(asc(serviceObligationsTable.createdAt), asc(serviceObligationsTable.id)).limit(WATCH_BATCH_SIZE);
  const rotation = await db.select({ org: cases.organizationId, id: cases.serviceObligationId }).from(cases)
    .where(organizationId ? eq(cases.organizationId, organizationId) : undefined).orderBy(asc(cases.lastEvaluatedAt), asc(cases.id)).limit(WATCH_BATCH_SIZE);
  let checked = 0;
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [...missing, ...rotation]) {
    const key = `${candidate.org}:${candidate.id}`; if (seen.has(key)) continue; seen.add(key);
    try {
      await db.transaction(async tx => {
        await lock(tx, candidate.org);
        const [current] = await tx.select().from(cases).where(where(candidate.org, candidate.id)).for("update");
        await reconcile(tx, candidate.org, candidate.id, current ?? null, now);
      }); checked++;
    } catch {
      // Retain and rotate failed bootstrap rows as well as existing rows. A batch
      // of corrupt old sources must not starve all newer service obligations.
      await db.transaction(async tx => {
        await lock(tx, candidate.org);
        const [previous] = await tx.select().from(cases).where(where(candidate.org, candidate.id)).for("update");
        const reasons = [...new Set([...(previous?.reasons ?? []), "source_review_required" as const])];
        const changed = previous?.state !== "held" || !previous.reasons.includes("source_review_required");
        const value = { state: "held" as const, reasons, lastEvaluatedAt: now,
          version: (previous?.version ?? 0) + (changed ? 1 : 0), noticeRevision: (previous?.noticeRevision ?? 0) + (changed ? 1 : 0),
          episode: previous?.episode || 1, updatedAt: changed ? now : previous!.updatedAt };
        const [row] = previous ? await tx.update(cases).set(value).where(eq(cases.id, previous.id)).returning()
          : await tx.insert(cases).values({ organizationId: candidate.org, serviceObligationId: candidate.id, ...value }).returning();
        if (changed) await audit(tx, row, "held", null, { reason: "source_review_required" });
      });
      failures.push(candidate.id);
    }
  }
  if (failures.length) throw new ServiceWatchError("monitor_review_required", `${failures.length} service watch records require operator review; other bounded work was checked.`, 503);
  return { checked };
}

/** Final push-boundary guard; no reconciliation, queue writes or provider lookup. */
export async function serviceWatchNoticeCurrent(org: string, caseId: string, noticeRevision: number, ownerId: string) {
  const [row] = await db.select().from(cases).where(and(eq(cases.organizationId, org), eq(cases.id, caseId)));
  if (!row || row.state !== "open" || row.noticeRevision !== noticeRevision || row.assignedUserId !== ownerId) return false;
  const now = new Date(), observation = await observe(db, org, row.serviceObligationId, row, now);
  return !observation.held && observation.service.status === "active" && observation.ownerValid && observation.owner?.id === ownerId &&
    observation.fingerprint === row.observedFingerprint && projection(row, observation, now).state === "open";
}

export async function getServiceWatch(org: string, actor: string, id: string, now = new Date()) {
  await member(db, org, actor);
  const [current] = await db.select().from(cases).where(where(org, id));
  const observation = await observe(db, org, id, current ?? null, now);
  const projected = projection(current ?? null, observation, now);
  const history = await db.select({ id: auditEventsTable.id, action: auditEventsTable.action, createdAt: auditEventsTable.createdAt, metadata: auditEventsTable.metadata }).from(auditEventsTable)
    .where(and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.entityType, "service_obligation"), eq(auditEventsTable.entityId, id), sql`${auditEventsTable.action} like 'service.watch_%'`))
    .orderBy(desc(auditEventsTable.createdAt), desc(auditEventsTable.id)).limit(51);
  return { obligationId: id, customerLabel: observation.customerLabel, equipmentLabel: observation.service.equipmentLabel,
    serviceStatus: observation.service.status, dueDate: observation.service.dueAt.toISOString().slice(0, 10), taskId: observation.task.id,
    expectedVersion: current?.version ?? 0, expectedFingerprint: observation.fingerprint, state: projected.state, reasons: projected.reasons,
    recordedState: current?.state ?? null, monitorPending: current?.observedFingerprint !== observation.fingerprint,
    assignedUserId: observation.owner?.id ?? null, ownerValid: observation.ownerValid, held: observation.held,
    nextAction: current?.nextAction ?? null, nextActionAt: current?.nextActionAt?.toISOString() ?? null,
    acknowledgedAt: current?.acknowledgedAt?.toISOString() ?? null, lastEvaluatedAt: current?.lastEvaluatedAt?.toISOString() ?? null,
    history: history.slice(0, 50), historyHasMore: history.length > 50, ...observation.calendar };
}
export async function listServiceWatch(org: string, actor: string, raw: unknown = {}) {
  await member(db, org, actor);
  const query = serviceWatchQuery.parse(raw);
  const rows = await db.select({ watch: cases, equipmentLabel: serviceObligationsTable.equipmentLabel, dueAt: serviceObligationsTable.dueAt, firstName: contactsTable.firstName, lastName: contactsTable.lastName })
    .from(cases).innerJoin(serviceObligationsTable, and(eq(serviceObligationsTable.organizationId, org), eq(serviceObligationsTable.id, cases.serviceObligationId)))
    .leftJoin(contactsTable, and(eq(contactsTable.organizationId, org), eq(contactsTable.id, serviceObligationsTable.contactId)))
    .where(and(eq(cases.organizationId, org), query.scope === "attention" ? inArray(cases.state, ["open", "acknowledged", "held"]) : query.scope === "history" ? eq(cases.state, "resolved") : undefined))
    .orderBy(asc(cases.updatedAt), asc(cases.id)).limit(WATCH_PAGE_SIZE + 1).offset(query.offset);
  const [count] = await db.select({ count: sql<number>`count(*)::int` }).from(serviceObligationsTable).leftJoin(cases, and(eq(cases.organizationId, org), eq(cases.serviceObligationId, serviceObligationsTable.id)))
    .where(and(eq(serviceObligationsTable.organizationId, org), eq(serviceObligationsTable.status, "active"), isNull(cases.id)));
  const lifecycle = await getCustomerLifecycleStatus(org);
  return { items: rows.slice(0, WATCH_PAGE_SIZE).map(row => ({ ...row.watch, equipmentLabel: row.equipmentLabel, customerLabel: row.firstName ? `${row.firstName} ${row.lastName ?? ""}`.trim() : "Customer record unavailable — operator review", dueDate: row.dueAt.toISOString().slice(0, 10) })),
    hasMore: rows.length > WATCH_PAGE_SIZE, offset: query.offset, limit: WATCH_PAGE_SIZE, unmonitoredCount: count?.count ?? 0, held: !lifecycle.automationAllowed };
}

export async function updateServiceWatch(org: string, actor: string, id: string, raw: unknown, now = new Date()) {
  const command = serviceWatchCommand.parse(raw);
  return db.transaction(async tx => {
    await lock(tx, org); await member(tx, org, actor, true); await assertOperationalStaff(tx, org, [actor]);
    const [repeated] = await tx.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.entityType, "service_obligation"), eq(auditEventsTable.entityId, id), eq(auditEventsTable.action, "service.watch_staff_action"), sql`${auditEventsTable.metadata}->>'requestId' = ${command.requestId}`)).limit(1);
    if (repeated) {
      if (repeated.metadata.requestFingerprint !== careFingerprint(command)) fail("request_changed", "This request belongs to different details. Refresh and review.");
      return { caseId: repeated.metadata.caseId as string, version: repeated.metadata.version as number, replayed: true };
    }
    if (command.action === "acknowledge" && (new Date(command.nextActionAt) <= now || new Date(command.nextActionAt).getTime() > now.getTime() + 30 * 86_400_000)) fail("invalid_deadline", "Choose a future office follow-up time within 30 days.", 400);
    if (!(await getCustomerLifecycleStatus(org, tx)).automationAllowed) fail("customer_lifecycle_paused", "Company work is paused. Review operating status before changing the office plan.", 423);
    const [current] = await tx.select().from(cases).where(where(org, id)).for("update");
    const observation = await observe(tx, org, id, current ?? null, now);
    if ((current?.version ?? 0) !== command.expectedVersion || observation.fingerprint !== command.expectedFingerprint) fail("stale_watch", "The service or office plan changed. Refresh and review before saving; nothing was overwritten.");
    if (!observation.reasons.length) fail("attention_cleared", "There is no current service exception to acknowledge. Review the service record.");
    await assertOperationalStaff(tx, org, [command.assignedUserId]);
    const row = await reconcile(tx, org, id, current ?? null, now);
    await tx.update(crmTasksTable).set({ assignedUserId: command.assignedUserId, ...(command.action === "acknowledge" ? { dueAt: new Date(command.nextActionAt) } : {}) })
      .where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.id, observation.task.id)));
    const plan = { ...row, assignedUserId: command.assignedUserId, ...(command.action === "acknowledge" ? { state: "acknowledged" as const, nextAction: command.note, nextActionAt: new Date(command.nextActionAt), acknowledgedByUserId: actor, acknowledgedAt: now } : {}) };
    const fresh = await observe(tx, org, id, plan, now);
    const [updated] = await tx.update(cases).set({ assignedUserId: command.assignedUserId, state: command.action === "acknowledge" ? "acknowledged" : "open",
      reasons: fresh.reasons, observedFingerprint: fresh.fingerprint, version: row.version + 1, noticeRevision: row.noticeRevision + 1,
      ...(command.action === "acknowledge" ? { nextAction: command.note, nextActionAt: new Date(command.nextActionAt), acknowledgedByUserId: actor, acknowledgedAt: now } : {}), updatedAt: now })
      .where(eq(cases.id, row.id)).returning();
    await audit(tx, updated, "staff_action", actor, { requestId: command.requestId, requestFingerprint: careFingerprint(command), action: command.action, note: command.note, nextActionAt: command.action === "acknowledge" ? command.nextActionAt : null,
      evidence: "internal_office_plan_not_customer_response_or_booking" });
    if (command.action === "assign") await enqueue(tx, updated, now);
    return { caseId: updated.id, version: updated.version, replayed: false };
  });
}
