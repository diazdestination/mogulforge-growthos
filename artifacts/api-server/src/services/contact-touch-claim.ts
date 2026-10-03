import { activitiesTable, bieActionProposalsTable, contactsTable, db, DEFAULT_SENDING_HOURS, leadsTable, orgSettingsTable, playbookEnrollmentsTable, revenueExecutionsTable, scheduledActionsTable } from "@workspace/db";
import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import { contactTouchReservationsTable as reservations } from "../../../../lib/db/src/schema/contact-touch-reservations";
import { sourceOutreachItemsTable } from "../../../../lib/db/src/schema/source-adoption";
import { acquireNurtureLocks, type NurtureTx } from "./source-outreach-ownership";
import { sourceFingerprint } from "./source-adoption-contract";

export type ContactTouchClaim = { organizationId: string; logicalKey: string; contactId: string; address: string; channel: "email" | "sms";
  sourceKind: typeof reservations.$inferInsert.sourceKind; payload: unknown; leadId?: string | null };
export class ContactTouchDeferredError extends Error {
  constructor(readonly resumeAt: Date, readonly reason: string) { super("The original contact allowance is held until a later permitted window."); }
}
export class ContactTouchError extends Error { constructor(readonly code: string) { super(code); } }
export const touchAddress = (channel: "email" | "sms", value: string) => channel === "email" ? value.trim().toLowerCase() : value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
export async function contactTouchHours(reader: Pick<typeof db, "select">, org: string) {
  const [settings] = await reader.select({ hours: orgSettingsTable.sendingHours }).from(orgSettingsTable).where(eq(orgSettingsTable.organizationId, org));
  // Match the existing effective settings without its lazy settings-row writer.
  const merged = { ...DEFAULT_SENDING_HOURS, ...settings?.hours };
  try { new Intl.DateTimeFormat("en-US", { timeZone: merged.timezone }); } catch { merged.timezone = DEFAULT_SENDING_HOURS.timezone; }
  merged.startHour = Math.min(Math.max(Math.trunc(merged.startHour), 0), 23);
  merged.endHour = Math.min(Math.max(Math.trunc(merged.endHour), merged.startHour + 1), 24);
  merged.maxTouchesPerDay = Math.max(Math.trunc(merged.maxTouchesPerDay), 0);
  if (!Array.isArray(merged.days) || merged.days.length === 0) merged.days = DEFAULT_SENDING_HOURS.days;
  return merged;
}
const activityTouchKey = (row: typeof activitiesTable.$inferSelect) => {
  const metadata = row.metadata ?? {};
  return typeof metadata.touchLogicalKey === "string" ? metadata.touchLogicalKey
    : typeof metadata.sourceOutreachItemId === "string" && row.leadId ? `source-outreach:${row.leadId}:email`
    : typeof metadata.enrollmentId === "string" && typeof metadata.stepIndex === "number" ? `playbook:${metadata.enrollmentId}:${metadata.stepIndex}`
    : typeof metadata.proposalId === "string" ? `bie:${metadata.proposalId}` : `activity:${row.id}`;
};
/** Persisted keys make accepted activity plus its pending/unknown claim one touch. */
export async function contactTouchTimes(reader: Pick<typeof db, "select">, org: string, contactId: string, since: Date, excludeKey?: string) {
  const [contact] = await reader.select().from(contactsTable).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, contactId)));
  const aliases = contact ? await reader.select({ id: contactsTable.id }).from(contactsTable).where(and(eq(contactsTable.organizationId, org), or(eq(contactsTable.id, contactId),
    contact.email ? sql`lower(btrim(${contactsTable.email})) = ${touchAddress("email", contact.email)}` : undefined,
    contact.phone ? sql`regexp_replace(regexp_replace(${contactsTable.phone}, '[^0-9]', '', 'g'), '^1(?=[0-9]{10}$)', '') = ${touchAddress("sms", contact.phone)}` : undefined))) : [];
  const ids = [...new Set([contactId, ...aliases.map(row => row.id)])];
  const owned = await reader.select().from(reservations).where(and(eq(reservations.organizationId, org), or(inArray(reservations.contactId, ids),
    contact?.email ? and(eq(reservations.channel, "email"), eq(reservations.address, touchAddress("email", contact.email))) : undefined,
    contact?.phone ? and(eq(reservations.channel, "sms"), eq(reservations.address, touchAddress("sms", contact.phone))) : undefined)));
  const effectiveAt = (row: typeof reservations.$inferSelect) => new Date(Math.max(row.reservedAt.getTime(), row.dispatchStartedAt?.getTime() ?? 0, row.acceptedAt?.getTime() ?? 0));
  const byKey = new Map(owned.filter(row => row.logicalKey !== excludeKey && effectiveAt(row) > since).map(row => [row.logicalKey, effectiveAt(row)]));
  const allKeys = new Set(owned.map(row => row.logicalKey));
  const retain = (key: string, at: Date) => { if (key !== excludeKey && at > since) byKey.set(key, new Date(Math.max(byKey.get(key)?.getTime() ?? 0, at.getTime()))); };
  const activity = await reader.select().from(activitiesTable).where(and(eq(activitiesTable.organizationId, org), inArray(activitiesTable.contactId, ids),
    inArray(activitiesTable.type, ["playbook_touch_sent", "automation_message_sent", "bie_email_sent"]), gt(activitiesTable.occurredAt, since)));
  const { serviceActivityTouchKeys, servicePendingTouchTimes } = await import("./service-care-budget");
  const legacyServiceKeys = await serviceActivityTouchKeys(reader, org, activity);
  for (const row of activity) {
    const key = legacyServiceKeys.get(row.id) ?? activityTouchKey(row);
    if (key === excludeKey) continue;
    // An accepted activity can survive a crash before acceptedAt was written.
    // It advances the same logical touch; it never adds a second allowance.
    retain(key, row.occurredAt);
  }
  // Original legacy claims, including crashes before receipt creation, remain
  // counted without manufacturing a new authority/reservation for old effects.
  const source = await reader.select().from(sourceOutreachItemsTable).where(and(eq(sourceOutreachItemsTable.organizationId, org), inArray(sourceOutreachItemsTable.contactId, ids), gt(sourceOutreachItemsTable.claimedAt, since)));
  for (const row of source) { const key = `source-outreach:${row.leadId}:email`; if (!allKeys.has(key)) retain(key, row.claimedAt!); }
  const bie = await reader.select({ receipt: revenueExecutionsTable, proposal: bieActionProposalsTable }).from(revenueExecutionsTable)
    .innerJoin(bieActionProposalsTable, and(eq(bieActionProposalsTable.organizationId, org), sql`${revenueExecutionsTable.actionKey} = 'bie:' || ${bieActionProposalsTable.id}::text`))
    .where(and(eq(revenueExecutionsTable.organizationId, org), eq(revenueExecutionsTable.kind, "send_email"), gt(revenueExecutionsTable.createdAt, since),
      inArray(revenueExecutionsTable.state, ["processing", "indeterminate", "succeeded", "confirmed_succeeded", "confirmed_not_performed"]),
      sql`exists (select 1 from leads where leads.organization_id = ${org} and leads.id = ${bieActionProposalsTable.leadId} and leads.contact_id in (${sql.join(ids.map(id => sql`${id}`), sql`, `)}))`));
  const consumedLegacyActivity = new Set<string>();
  for (const row of bie) {
    if (row.receipt.actionKey === excludeKey || allKeys.has(row.receipt.actionKey) || byKey.has(row.receipt.actionKey)) continue;
    // Unkeyed legacy acceptance can cover at most ONE successful original
    // receipt. Similar timing never resolves a different unknown/processing or
    // operator-reconciled effect, even when it belongs to the same lead.
    const accepted = row.receipt.state === "succeeded" && row.receipt.completedAt ? activity.find(a =>
      a.type === "bie_email_sent" && a.leadId === row.proposal.leadId && !consumedLegacyActivity.has(a.id) &&
      activityTouchKey(a) === `activity:${a.id}` && a.occurredAt >= row.receipt.createdAt && a.occurredAt <= row.receipt.completedAt!) : undefined;
    if (accepted) { consumedLegacyActivity.add(accepted.id); continue; }
    retain(row.receipt.actionKey, row.receipt.createdAt);
  }
  // Before the ledger existed, a scheduled receipt or playbook's one-way CAS
  // could own an effect even when the worker died before recording activity.
  // Observe that original ownership only: never backfill or grant a retry.
  const leadRows = await reader.select({ id: leadsTable.id }).from(leadsTable).where(and(eq(leadsTable.organizationId, org), inArray(leadsTable.contactId, ids)));
  const leadIds = leadRows.map(row => row.id);
  {
    const enrollments = leadIds.length ? await reader.select().from(playbookEnrollmentsTable).where(and(eq(playbookEnrollmentsTable.organizationId, org), inArray(playbookEnrollmentsTable.leadId, leadIds))) : [];
    const enrollmentById = new Map(enrollments.map(row => [row.id, row]));
    const scheduled = await reader.select({ receipt: revenueExecutionsTable, action: scheduledActionsTable }).from(revenueExecutionsTable)
      .innerJoin(scheduledActionsTable, and(eq(scheduledActionsTable.organizationId, org), sql`${revenueExecutionsTable.actionKey} = 'scheduled:' || ${scheduledActionsTable.id}::text`))
      .where(and(eq(revenueExecutionsTable.organizationId, org), inArray(revenueExecutionsTable.kind, ["send_email", "send_sms", "appointment_reminder", "playbook_step"]),
        inArray(revenueExecutionsTable.state, ["processing", "indeterminate", "succeeded", "confirmed_succeeded", "confirmed_not_performed"]),
        or(sql`${scheduledActionsTable.context}->>'contactId' in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`,
          leadIds.length ? sql`${scheduledActionsTable.context}->>'leadId' in (${sql.join(leadIds.map(id => sql`${id}`), sql`, `)})` : undefined,
          enrollments.length ? sql`${scheduledActionsTable.action}->'params'->>'enrollmentId' in (${sql.join(enrollments.map(row => sql`${row.id}`), sql`, `)})` : undefined),
        or(gt(revenueExecutionsTable.createdAt, since), eq(revenueExecutionsTable.kind, "playbook_step"))));
    const legacyStepReceiptAt = new Map<string, Date>();
    for (const row of scheduled) {
      const { enrollmentId, stepIndex } = row.action.action.params;
      const original = row.action.action.type === "playbook_step" && typeof enrollmentId === "string" &&
        typeof stepIndex === "number" && Number.isSafeInteger(stepIndex) && stepIndex >= 0 && enrollmentById.has(enrollmentId);
      const key = original ? `playbook:${enrollmentId}:${stepIndex}` : row.receipt.actionKey;
      if (original) legacyStepReceiptAt.set(key, new Date(Math.max(legacyStepReceiptAt.get(key)?.getTime() ?? 0, row.receipt.createdAt.getTime())));
      if (key === excludeKey || allKeys.has(key)) continue;
      retain(key, row.receipt.createdAt);
    }
    for (const row of enrollments) {
      // Corrupt/ambiguous historic counters cannot trigger unbounded work or
      // silently release the allowance. This hold requires office inspection.
      if (!Number.isSafeInteger(row.currentStep) || row.currentStep < 0 || row.currentStep > 100) throw new ContactTouchError("legacy_playbook_history_requires_review");
      for (let index = 0; index < row.currentStep; index++) {
        const key = `playbook:${row.id}:${index}`;
        if (key === excludeKey || allKeys.has(key) || byKey.has(key)) continue;
        const history = row.history.filter(entry => entry.stepIndex === index);
        const sent = history.filter(entry => entry.kind === "sent").map(entry => new Date(entry.at)).filter(at => Number.isFinite(at.getTime()));
        if (sent.length) { retain(key, new Date(Math.max(...sent.map(at => at.getTime())))); continue; }
        if (history.some(entry => entry.kind === "skipped" || entry.kind === "step_skipped")) continue;
        // A retained original receipt is a better clock than a later human edit
        // to the enrollment. Without it, updatedAt is intentionally conservative.
        retain(key, legacyStepReceiptAt.get(key) ?? row.updatedAt);
      }
    }
  }
  const service = (await Promise.all(ids.map(id => servicePendingTouchTimes(reader, org, id, since, excludeKey)))).flat();
  return [...byKey.values(), ...service];
}
/** Only existing original action identities are accepted by the server callers. */
export async function reserveContactTouch(tx: NurtureTx, input: ContactTouchClaim) {
  await acquireNurtureLocks(tx, input.organizationId, input.leadId ? [input.leadId] : []);
  if (!/^(scheduled:|bie:|source-outreach:|playbook:|automation-run:)/.test(input.logicalKey)) throw new ContactTouchError("invalid_touch_identity");
  const address = touchAddress(input.channel, input.address), payloadHash = sourceFingerprint(input.payload);
  const [existing] = await tx.select().from(reservations).where(and(eq(reservations.organizationId, input.organizationId), eq(reservations.logicalKey, input.logicalKey))).for("update");
  if (existing) {
    if (existing.contactId !== input.contactId || existing.address !== address || existing.channel !== input.channel || existing.sourceKind !== input.sourceKind || existing.payloadHash !== payloadHash) throw new ContactTouchError("touch_payload_changed");
    return { reservation: existing, created: false };
  }
  const [contact] = await tx.select().from(contactsTable).where(and(eq(contactsTable.organizationId, input.organizationId), eq(contactsTable.id, input.contactId))).for("share");
  if (!contact || touchAddress(input.channel, (input.channel === "email" ? contact.email : contact.phone) ?? "") !== address) throw new ContactTouchError("touch_recipient_changed");
  const { checkOutreachTiming } = await import("./send-gate");
  const gate = await checkOutreachTiming({ organizationId: input.organizationId, contact, sendingHours: await contactTouchHours(tx, input.organizationId), touchLogicalKey: input.logicalKey }, tx);
  if (!gate.ok && gate.outcome === "deferred") throw new ContactTouchDeferredError(gate.resumeAt, gate.reason);
  const [reservation] = await tx.insert(reservations).values({ organizationId: input.organizationId, logicalKey: input.logicalKey, contactId: input.contactId, address,
    channel: input.channel, sourceKind: input.sourceKind, payloadHash, reservedAt: new Date() }).returning();
  return { reservation, created: true };
}
export async function claimContactTouch(input: ContactTouchClaim) { return db.transaction(tx => reserveContactTouch(tx, input)); }
export async function assertContactTouchCurrent(reader: Pick<typeof db, "select">, input: ContactTouchClaim) {
  const [row] = await reader.select().from(reservations).where(and(eq(reservations.organizationId, input.organizationId), eq(reservations.logicalKey, input.logicalKey)));
  if (!row || row.contactId !== input.contactId || row.channel !== input.channel || row.address !== touchAddress(input.channel, input.address) || row.payloadHash !== sourceFingerprint(input.payload) || row.sourceKind !== input.sourceKind) throw new ContactTouchError("touch_claim_changed");
  const [contact] = await reader.select().from(contactsTable).where(and(eq(contactsTable.organizationId, input.organizationId), eq(contactsTable.id, input.contactId)));
  if (!contact || touchAddress(input.channel, (input.channel === "email" ? contact.email : contact.phone) ?? "") !== row.address) throw new ContactTouchError("touch_contact_unavailable");
  const { checkOutreachTiming } = await import("./send-gate");
  const gate = await checkOutreachTiming({ organizationId: input.organizationId, contact, sendingHours: await contactTouchHours(reader, input.organizationId), touchLogicalKey: input.logicalKey }, reader);
  if (!gate.ok) throw new ContactTouchError("touch_allowance_changed");
  return row;
}
export async function acceptContactTouch(org: string, logicalKey: string) {
  await db.update(reservations).set({ acceptedAt: new Date() }).where(and(eq(reservations.organizationId, org), eq(reservations.logicalKey, logicalKey)));
}
/** Trace only, never send/replay authority; invoke only at the physical boundary. */
export async function markContactTouchDispatchStarted(org: string, logicalKey: string) {
  await db.update(reservations).set({ dispatchStartedAt: new Date() }).where(and(eq(reservations.organizationId, org), eq(reservations.logicalKey, logicalKey), sql`${reservations.dispatchStartedAt} is null`));
}
/** Narrow SMS adapter proof; immutable digest is reread, never supplied consent. */
export async function assertSmsContactTouch(input: { organizationId: string; contactId: string; to: string; logicalKey: string; payloadHash: string }) {
  const [row] = await db.select().from(reservations).where(and(eq(reservations.organizationId, input.organizationId), eq(reservations.logicalKey, input.logicalKey)));
  if (!row || row.contactId !== input.contactId || row.channel !== "sms" || row.address !== touchAddress("sms", input.to) || row.payloadHash !== input.payloadHash) throw new ContactTouchError("touch_claim_changed");
  const [contact] = await db.select().from(contactsTable).where(and(eq(contactsTable.organizationId, input.organizationId), eq(contactsTable.id, input.contactId)));
  if (!contact || touchAddress("sms", contact.phone ?? "") !== row.address) throw new ContactTouchError("touch_contact_changed");
  const gate = await (await import("./send-gate")).checkOutreachTiming({ organizationId: input.organizationId, contact, touchLogicalKey: input.logicalKey });
  if (!gate.ok) throw new ContactTouchError("touch_allowance_changed");
}
