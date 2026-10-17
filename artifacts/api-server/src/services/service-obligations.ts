import {
  auditEventsTable,
  appointmentsTable,
  contactsTable,
  crmTasksTable,
  db,
  propertiesTable,
  serviceObligationsTable,
  SERVICE_OBLIGATION_KINDS,
  type ServiceObligationKind,
} from "@workspace/db";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { CsvParseError, parseCsv } from "./reactivation";
import { phoneE164 } from "./twilio-controls";
import { assertOperationalStaff, assertScheduleVersion, lockContractorSchedule, ScheduleError, type ScheduleTransaction } from "./contractor-scheduling";
import { z } from "zod";
import { guardWorkdayService } from "./workday-guards";

const DAY_MS = 86_400_000;
const MAX_IMPORT_ROWS = 5_000;
const MAX_ERROR_SAMPLES = 20;

/** Calendar-date parser for CRM exports. Never guess non-US day/month order. */
export function parseServiceDate(input: string): Date | null {
  const value = input.trim();
  let year: number, month: number, day: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (iso) {
    [, year, month, day] = iso.map(Number);
  } else if (us) {
    month = Number(us[1]);
    day = Number(us[2]);
    year = Number(us[3]);
  } else {
    return null;
  }
  if (year < 2000 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day, 12));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? parsed
    : null;
}

export function serviceNoticeAt(dueAt: Date, noticeDays: number): Date {
  return new Date(dueAt.getTime() - noticeDays * DAY_MS);
}

function clean(input: string | undefined | null, max: number): string | null {
  const value = (input ?? "").trim();
  return value ? value.slice(0, max) : null;
}

function kindLabel(kind: ServiceObligationKind): string {
  return kind === "warranty_check"
    ? "Warranty check"
    : kind === "service_plan"
      ? "Service-plan visit"
      : "Maintenance visit";
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => parseServiceDate(value) !== null);
export const serviceRecurrenceSchema = z.object({
  mode: z.literal("calendar_months"), intervalMonths: z.number().int().min(1).max(60),
  anchorDate: isoDate, endDate: isoDate.nullable(), agreementNote: z.string().trim().min(1).max(500),
  approvedByUserId: z.string().min(1), approvedAt: z.iso.datetime(),
}).strict();

/** Always calculate from the original calendar anchor; Jan 31 -> Feb 28 -> Mar 31. */
export function nextServiceDate(anchor: string, months: number): Date {
  const original = parseServiceDate(anchor);
  if (!original || !Number.isInteger(months) || months < 1) throw new Error("Invalid recurrence date");
  const month = new Date(Date.UTC(original.getUTCFullYear(), original.getUTCMonth() + months, 1, 12));
  const lastDay = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
  month.setUTCDate(Math.min(original.getUTCDate(), lastDay));
  return month;
}

function validCoverage(input: { coverageStartsOn?: string | null; coverageEndsOn?: string | null; coverageEvidence?: string | null }) {
  const start = input.coverageStartsOn, end = input.coverageEndsOn;
  return (!start || isoDate.safeParse(start).success) && (!end || isoDate.safeParse(end).success) &&
    (!start || !end || start <= end) && (!(start || end) || !!input.coverageEvidence?.trim());
}

async function insertObligation(
  tx: Transaction,
  input: {
    organizationId: string;
    contactId: string;
    propertyId?: string | null;
    kind: ServiceObligationKind;
    equipmentLabel: string;
    dueAt: Date;
    noticeDays: number;
    source: string;
    externalRef?: string | null;
    notes?: string | null;
    assignedUserId?: string | null;
    recurrence?: typeof serviceObligationsTable.$inferInsert.recurrence;
    predecessorObligationId?: string;
    occurrenceIndex?: number;
    coverageStartsOn?: string | null;
    coverageEndsOn?: string | null;
    coverageEvidence?: string | null;
  },
) {
  const [task] = await tx
    .insert(crmTasksTable)
    .values({
      organizationId: input.organizationId,
      contactId: input.contactId,
      assignedUserId: input.assignedUserId,
      title: `${kindLabel(input.kind)}: ${input.equipmentLabel}`,
      description: `Service due ${input.dueAt.toISOString().slice(0, 10)}. Confirm appointment and customer notification preferences.`,
      sourceEvent: "service.obligation_due",
      dueAt: serviceNoticeAt(input.dueAt, input.noticeDays),
      priority: "normal",
    })
    .returning();
  const { assignedUserId: _assigned, ...values } = input;
  const [obligation] = await tx
    .insert(serviceObligationsTable)
    .values({ ...values, taskId: task.id })
    .returning();
  return obligation;
}

export async function createServiceObligation(
  organizationId: string,
  actorUserId: string,
  input: {
    contactId: string;
    propertyId?: string | null;
    kind: ServiceObligationKind;
    equipmentLabel: string;
    dueDate: string;
    noticeDays: number;
    source?: string;
    externalRef?: string | null;
    notes?: string | null;
    assignedUserId?: string | null;
    coverageStartsOn?: string | null;
    coverageEndsOn?: string | null;
    coverageEvidence?: string | null;
  },
) {
  const dueAt = parseServiceDate(input.dueDate);
  if (!dueAt) return { error: "invalid_due_date" as const };
  if (!validCoverage(input)) return { error: "invalid_coverage_evidence" as const };
  return db.transaction(async (tx) => {
    await lockContractorSchedule(tx, organizationId);
    await assertOperationalStaff(tx, organizationId, input.assignedUserId ? [input.assignedUserId] : []);
    // Keep the explicitly selected customer/property stable through task and service creation.
    // A later property edit is allowed, but cannot race these parent checks.
    const [contact] = await tx.select({ id: contactsTable.id }).from(contactsTable)
      .where(and(eq(contactsTable.id, input.contactId), eq(contactsTable.organizationId, organizationId))).for("share");
    if (!contact) return { error: "contact_not_found" as const };
    if (input.propertyId) {
      const [property] = await tx.select({ id: propertiesTable.id }).from(propertiesTable)
        .where(and(
          eq(propertiesTable.id, input.propertyId),
          eq(propertiesTable.organizationId, organizationId),
          eq(propertiesTable.contactId, input.contactId),
        )).for("share");
      if (!property) return { error: "property_not_found" as const };
    }
    const source = clean(input.source, 80) ?? "manual";
    const externalRef = clean(input.externalRef, 160);
    if (externalRef) {
      const [existing] = await tx.select({ id: serviceObligationsTable.id }).from(serviceObligationsTable)
        .where(and(
          eq(serviceObligationsTable.organizationId, organizationId),
          eq(serviceObligationsTable.source, source),
          eq(serviceObligationsTable.externalRef, externalRef),
        ));
      if (existing) return { error: "duplicate_external_ref" as const };
    }
    const obligation = await insertObligation(tx, {
      organizationId,
      contactId: contact.id,
      propertyId: input.propertyId,
      kind: input.kind,
      equipmentLabel: input.equipmentLabel.trim().slice(0, 160),
      dueAt,
      noticeDays: input.noticeDays,
      source,
      externalRef,
      notes: clean(input.notes, 500),
      assignedUserId: input.assignedUserId,
      coverageStartsOn: input.coverageStartsOn,
      coverageEndsOn: input.coverageEndsOn,
      coverageEvidence: clean(input.coverageEvidence, 1000),
    });
    await tx.insert(auditEventsTable).values({
      organizationId,
      actorUserId,
      action: "service.obligation_created",
      entityType: "service_obligation",
      entityId: obligation.id,
      metadata: { kind: input.kind, source },
    });
    return obligation;
  });
}

export const SERVICE_LIST_PAGE_SIZE = 500;
export async function listServiceObligations(organizationId: string, options: { status?: 'active' | 'completed' | 'cancelled'; offset?: number; includeLookahead?: boolean } = {}) {
  return db
    .select({ obligation: serviceObligationsTable, contact: contactsTable, task: crmTasksTable })
    .from(serviceObligationsTable)
    .innerJoin(contactsTable, and(eq(serviceObligationsTable.contactId, contactsTable.id), eq(contactsTable.organizationId, organizationId)))
    .innerJoin(crmTasksTable, and(eq(serviceObligationsTable.taskId, crmTasksTable.id), eq(crmTasksTable.organizationId, organizationId)))
    .where(and(eq(serviceObligationsTable.organizationId, organizationId), options.status ? eq(serviceObligationsTable.status, options.status) : undefined))
    .orderBy(asc(serviceObligationsTable.dueAt), asc(serviceObligationsTable.id))
    .offset(options.offset ?? 0)
    .limit(SERVICE_LIST_PAGE_SIZE + (options.includeLookahead ? 1 : 0));
}

export async function updateServiceObligation(
  organizationId: string,
  actorUserId: string,
  id: string,
  input: { status?: "active" | "completed" | "cancelled"; dueDate?: string; appointmentId?: string | null; expectedUpdatedAt?: string; assignedUserId?: string | null; completionNote?: string; coverageStartsOn?: string | null; coverageEndsOn?: string | null; coverageEvidence?: string | null },
  execution?: { transaction: ScheduleTransaction; preserveTaskPlan: true; originalCompletionId: string },
) {
  const dueAt = input.dueDate === undefined ? undefined : parseServiceDate(input.dueDate);
  if (dueAt === null) return { error: "invalid_due_date" as const };
  const mutate = async (tx: ScheduleTransaction) => {
    await lockContractorSchedule(tx, organizationId);
    const [current] = await tx.select().from(serviceObligationsTable)
      .where(and(eq(serviceObligationsTable.id, id), eq(serviceObligationsTable.organizationId, organizationId)))
      .for("update");
    if (!current) return { error: "not_found" as const };
    await guardWorkdayService(tx, organizationId, id, current, input, execution?.originalCompletionId);
    const [successor] = await tx.select({ id: serviceObligationsTable.id }).from(serviceObligationsTable).where(and(eq(serviceObligationsTable.organizationId, organizationId), eq(serviceObligationsTable.predecessorObligationId, current.id))).limit(1);
    if (current.status === "completed" && input.status === "completed" && input.dueDate === undefined && input.appointmentId === undefined && input.assignedUserId === undefined && input.coverageStartsOn === undefined && input.coverageEndsOn === undefined && input.coverageEvidence === undefined && (input.completionNote === undefined || input.completionNote.trim() === current.completionNote)) return { ...current, nextObligationId: successor?.id ?? null };
    assertScheduleVersion(current.updatedAt, input.expectedUpdatedAt);
    if (current.status === "cancelled" && input.status === "completed") return { error: "cancelled_service_requires_reopen" as const };
    if (current.status === "completed" && successor && input.status && input.status !== "completed") return { error: "successor_already_created" as const };
    if (!validCoverage({ coverageStartsOn: input.coverageStartsOn === undefined ? current.coverageStartsOn : input.coverageStartsOn, coverageEndsOn: input.coverageEndsOn === undefined ? current.coverageEndsOn : input.coverageEndsOn, coverageEvidence: input.coverageEvidence === undefined ? current.coverageEvidence : input.coverageEvidence })) return { error: "invalid_coverage_evidence" as const };
    if (input.assignedUserId !== undefined) await assertOperationalStaff(tx, organizationId, input.assignedUserId ? [input.assignedUserId] : []);
    let linkedAppointment: typeof appointmentsTable.$inferSelect | undefined;
    if (input.appointmentId) {
      const [appointment] = await tx.select().from(appointmentsTable)
        .where(and(eq(appointmentsTable.id, input.appointmentId), eq(appointmentsTable.organizationId, organizationId)));
      if (!appointment || appointment.contactId !== current.contactId) {
        return { error: "appointment_not_for_customer" as const };
      }
      if (appointment.propertyId && current.propertyId && appointment.propertyId !== current.propertyId) return { error: "appointment_not_for_property" as const };
      if (!["scheduled", "confirmed", "completed"].includes(appointment.status)) return { error: "appointment_not_active" as const };
      linkedAppointment = appointment;
    }
    const status = input.status ?? current.status;
    const nextDue = dueAt ?? current.dueAt;
    const appointmentId = input.appointmentId === undefined ? current.appointmentId : input.appointmentId;
    if (appointmentId && !linkedAppointment) [linkedAppointment] = await tx.select().from(appointmentsTable).where(and(eq(appointmentsTable.organizationId, organizationId), eq(appointmentsTable.id, appointmentId)));
    if (linkedAppointment?.propertyId && current.propertyId && linkedAppointment.propertyId !== current.propertyId) return { error: "appointment_not_for_property" as const };
    const policy = current.recurrence ? serviceRecurrenceSchema.safeParse(current.recurrence) : null;
    if (policy && !policy.success) return { error: "invalid_saved_recurrence" as const };
    const nextDate = policy?.success ? nextServiceDate(policy.data.anchorDate, policy.data.intervalMonths * (current.occurrenceIndex + 1)) : null;
    if (dueAt && nextDate && dueAt >= nextDate) return { error: "recurrence_due_date_conflict" as const };
    const [updated] = await tx.update(serviceObligationsTable)
      .set({ status, dueAt: nextDue, appointmentId, completedAt: status === "completed" ? current.completedAt ?? new Date() : null,
        ...(current.status === "cancelled" && status === "active" ? { recurrence: null, occurrenceIndex: 0 } : {}),
        ...(input.completionNote === undefined ? {} : { completionNote: clean(input.completionNote, 1000) }),
        ...(input.coverageStartsOn === undefined ? {} : { coverageStartsOn: input.coverageStartsOn }),
        ...(input.coverageEndsOn === undefined ? {} : { coverageEndsOn: input.coverageEndsOn }),
        ...(input.coverageEvidence === undefined ? {} : { coverageEvidence: clean(input.coverageEvidence, 1000) }),
      })
      .where(eq(serviceObligationsTable.id, id))
      .returning();
    const taskStatus = status === "cancelled" ? "cancelled" : status === "completed" || (linkedAppointment && ["scheduled", "confirmed"].includes(linkedAppointment.status)) ? "done" : "open";
    await tx.update(crmTasksTable)
      .set({
        status: taskStatus,
        ...(execution?.preserveTaskPlan ? {} : { dueAt: serviceNoticeAt(nextDue, current.noticeDays) }),
        completedAt: taskStatus === "done" ? new Date() : null,
        ...(input.assignedUserId === undefined ? {} : { assignedUserId: input.assignedUserId }),
      })
      .where(and(eq(crmTasksTable.id, current.taskId), eq(crmTasksTable.organizationId, organizationId)));
    await tx.insert(auditEventsTable).values({
      organizationId,
      actorUserId,
      action: "service.obligation_updated",
      entityType: "service_obligation",
      entityId: id,
      metadata: { status, dueDate: nextDue.toISOString().slice(0, 10), appointmentId },
    });
    let nextObligationId = successor?.id ?? null;
    if (status === "completed" && current.status !== "completed" && !successor && policy?.success && nextDate && (!policy.data.endDate || nextDate <= parseServiceDate(policy.data.endDate)!)) {
      const [task] = await tx.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, organizationId), eq(crmTasksTable.id, current.taskId)));
      await assertOperationalStaff(tx, organizationId, task?.assignedUserId ? [task.assignedUserId] : []);
      // Approval creates a staff task, never an appointment or customer message.
      const next = await insertObligation(tx, { organizationId, contactId: current.contactId, propertyId: current.propertyId,
        kind: current.kind, equipmentLabel: current.equipmentLabel, dueAt: nextDate, noticeDays: current.noticeDays,
        source: "approved_recurrence", notes: current.notes, assignedUserId: task?.assignedUserId,
        recurrence: policy.data, predecessorObligationId: current.id, occurrenceIndex: current.occurrenceIndex + 1,
        coverageStartsOn: updated.coverageStartsOn, coverageEndsOn: updated.coverageEndsOn, coverageEvidence: updated.coverageEvidence,
      });
      nextObligationId = next.id;
      await tx.insert(auditEventsTable).values({ organizationId, actorUserId, action: "service.next_visit_prepared", entityType: "service_obligation", entityId: current.id, metadata: { nextObligationId, dueDate: nextDate.toISOString().slice(0, 10), approvalUserId: policy.data.approvedByUserId } });
    }
    return { ...updated, nextObligationId };
  };
  return execution ? mutate(execution.transaction) : db.transaction(mutate);
}

/** Reuses native completion/anchored recurrence without another pool checkout. */
export async function completeWorkdayServiceInTransaction(tx: ScheduleTransaction, organizationId: string, actorUserId: string, id: string, expectedUpdatedAt: string, originalCompletionId: string) {
  return updateServiceObligation(organizationId, actorUserId, id, { status: "completed", expectedUpdatedAt }, { transaction: tx, preserveTaskPlan: true, originalCompletionId });
}

export async function approveServiceRecurrence(org: string, actor: string, id: string, input: { expectedUpdatedAt: string; intervalMonths: number | null; endDate?: string | null; agreementNote: string }) {
  return db.transaction(async tx => {
    await lockContractorSchedule(tx, org);
    await assertOperationalStaff(tx, org, [actor]);
    const [current] = await tx.select().from(serviceObligationsTable).where(and(eq(serviceObligationsTable.organizationId, org), eq(serviceObligationsTable.id, id))).for("update");
    if (!current) return { error: "not_found" as const };
    assertScheduleVersion(current.updatedAt, input.expectedUpdatedAt);
    if (current.status !== "active") return { error: "active_service_required" as const };
    const note = input.agreementNote.trim();
    if (!note || note.length > 500) return { error: "agreement_note_required" as const };
    const anchorDate = current.dueAt.toISOString().slice(0, 10);
    const policy = input.intervalMonths === null ? null : serviceRecurrenceSchema.safeParse({ mode: "calendar_months", intervalMonths: input.intervalMonths, anchorDate, endDate: input.endDate ?? null, agreementNote: note, approvedByUserId: actor, approvedAt: new Date().toISOString() });
    if (policy && (!policy.success || (policy.data.endDate && policy.data.endDate < anchorDate))) return { error: "invalid_recurrence" as const };
    const [updated] = await tx.update(serviceObligationsTable).set({ recurrence: policy?.success ? policy.data : null, occurrenceIndex: 0 }).where(eq(serviceObligationsTable.id, id)).returning();
    await tx.insert(auditEventsTable).values({ organizationId: org, actorUserId: actor, action: policy ? "service.recurrence_approved" : "service.recurrence_stopped", entityType: "service_obligation", entityId: id, metadata: { intervalMonths: input.intervalMonths, endDate: input.endDate ?? null, agreementNote: note } });
    return updated;
  });
}

/** Appointment state changes reopen the office task; service is completed only by staff. */
export async function reconcileServiceAppointment(tx: ScheduleTransaction, org: string, appointment: typeof appointmentsTable.$inferSelect, options: { preserveTaskPlan?: boolean } = {}) {
  const rows = await tx.select().from(serviceObligationsTable).where(and(eq(serviceObligationsTable.organizationId, org), eq(serviceObligationsTable.appointmentId, appointment.id), eq(serviceObligationsTable.status, "active"))).for("update");
  const booked = ["scheduled", "confirmed"].includes(appointment.status);
  for (const obligation of rows) {
    if (appointment.contactId !== obligation.contactId || (appointment.propertyId && obligation.propertyId && appointment.propertyId !== obligation.propertyId)) throw new ScheduleError("customer_reference_mismatch", 400);
    await tx.update(crmTasksTable).set({ status: booked ? "done" : "open", completedAt: booked ? new Date() : null,
      ...(options.preserveTaskPlan ? {} : { description: booked ? "Office appointment is booked. Mark service complete after the visit is confirmed." : `Appointment ${appointment.status}. Review this service obligation and arrange the next office-approved step.` }),
    }).where(and(eq(crmTasksTable.organizationId, org), eq(crmTasksTable.id, obligation.taskId)));
  }
}

export const CUSTOMER_IMPORT_FIELDS = [
  "firstName", "lastName", "email", "phone", "equipmentLabel", "kind", "dueDate", "externalRef", "notes",
] as const;
export type CustomerImportField = (typeof CUSTOMER_IMPORT_FIELDS)[number];

/** Housecall Pro or other CRM export: customers stay contacts, not sales leads. */
export async function importServiceCustomers(
  organizationId: string,
  actorUserId: string,
  input: {
    csv: string;
    mapping: Partial<Record<CustomerImportField, number>>;
    hasHeader: boolean;
    source: string;
    defaultKind?: ServiceObligationKind;
    defaultEquipmentLabel?: string;
    noticeDays: number;
    commit: boolean;
  },
) {
  let all: string[][];
  try { all = parseCsv(input.csv); }
  catch (error) {
    if (error instanceof CsvParseError) return { error: "invalid_csv" as const };
    throw error;
  }
  const rows = input.hasHeader ? all.slice(1) : all;
  if (!rows.length || rows.length > MAX_IMPORT_ROWS) return { error: "invalid_row_count" as const };
  const mapping = input.mapping;
  if (mapping.firstName === undefined || mapping.dueDate === undefined ||
      (mapping.email === undefined && mapping.phone === undefined) ||
      (mapping.equipmentLabel === undefined && !input.defaultEquipmentLabel) ||
      (mapping.kind === undefined && !input.defaultKind)) {
    return { error: "missing_required_mapping" as const };
  }
  if (!input.source.trim()) return { error: "source_required" as const };
  const source = input.source.trim().slice(0, 80);
  let imported = 0, duplicates = 0, skipped = 0;
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const get = (field: CustomerImportField) => {
      const column = mapping[field];
      return column === undefined ? undefined : row[column];
    };
    const firstName = clean(get("firstName"), 100);
    const email = clean(get("email"), 200)?.toLowerCase() ?? null;
    const phone = phoneE164(get("phone") ?? "");
    const dueAt = parseServiceDate(get("dueDate") ?? "");
    const rawKind = clean(get("kind"), 40) ?? input.defaultKind;
    const kind = SERVICE_OBLIGATION_KINDS.find((value) => value === rawKind);
    const equipmentLabel = clean(get("equipmentLabel"), 160) ?? clean(input.defaultEquipmentLabel, 160);
    const externalRef = clean(get("externalRef"), 160);
    const rowNo = index + (input.hasHeader ? 2 : 1);
    if (!firstName || (!email && !phone) || !dueAt || !kind || !equipmentLabel) {
      skipped++;
      if (errors.length < MAX_ERROR_SAMPLES) errors.push(`Row ${rowNo}: missing or invalid customer, service kind, equipment, or date`);
      continue;
    }
    const rowKey = externalRef
      ? `${source}:${externalRef}`
      : `${email ?? phone}:${kind}:${equipmentLabel.toLowerCase()}:${dueAt.toISOString()}`;
    if (seen.has(rowKey)) {
      duplicates++;
      continue;
    }
    seen.add(rowKey);
    const result = await db.transaction(async (tx) => {
      if (externalRef) {
        const [existing] = await tx.select({ id: serviceObligationsTable.id })
          .from(serviceObligationsTable)
          .where(and(
            eq(serviceObligationsTable.organizationId, organizationId),
            eq(serviceObligationsTable.source, source),
            eq(serviceObligationsTable.externalRef, externalRef),
          ));
        if (existing) return "duplicate" as const;
      }
      const matches = await tx.select().from(contactsTable)
        .where(and(
          eq(contactsTable.organizationId, organizationId),
          or(
            email ? sql`lower(${contactsTable.email}) = ${email}` : undefined,
            phone ? sql`regexp_replace(coalesce(${contactsTable.phone}, ''), '[^0-9]', '', 'g') IN (${phone.slice(1)}, ${phone.slice(2)})` : undefined,
          ),
        ))
        .limit(3);
      if (matches.length > 1) return "ambiguous_contact" as const;
      const existingContact = matches[0];
      if (existingContact && !externalRef) {
        const [duplicate] = await tx.select({ id: serviceObligationsTable.id })
          .from(serviceObligationsTable)
          .where(and(
            eq(serviceObligationsTable.organizationId, organizationId),
            eq(serviceObligationsTable.contactId, existingContact.id),
            eq(serviceObligationsTable.kind, kind),
            eq(serviceObligationsTable.dueAt, dueAt),
            sql`lower(${serviceObligationsTable.equipmentLabel}) = ${equipmentLabel.toLowerCase()}`,
          ))
          .limit(1);
        if (duplicate) return "duplicate" as const;
      }
      if (!input.commit) return "preview" as const;
      const [contact] = existingContact
        ? [existingContact]
        : await tx.insert(contactsTable).values({
            organizationId,
            firstName,
            lastName: clean(get("lastName"), 100),
            email,
            phone,
          }).returning();
      await insertObligation(tx, {
        organizationId,
        contactId: contact.id,
        kind,
        equipmentLabel,
        dueAt,
        noticeDays: input.noticeDays,
        source,
        externalRef,
        notes: clean(get("notes"), 500),
      });
      return "imported" as const;
    });
    if (result === "duplicate") duplicates++;
    else if (result === "ambiguous_contact") {
      skipped++;
      if (errors.length < MAX_ERROR_SAMPLES) errors.push(`Row ${rowNo}: multiple matching contacts; resolve manually`);
    } else imported++;
  }
  if (input.commit) {
    await db.insert(auditEventsTable).values({
      organizationId,
      actorUserId,
      action: "service.customer_imported",
      entityType: "service_import",
      metadata: { source, totalRows: rows.length, imported, duplicates, skipped },
    });
  }
  return { preview: !input.commit, totalRows: rows.length, imported, duplicates, skipped, errors };
}
