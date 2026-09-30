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
import { parseCsv } from "./reactivation";
import { phoneE164 } from "./twilio-controls";

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
  },
) {
  const [task] = await tx
    .insert(crmTasksTable)
    .values({
      organizationId: input.organizationId,
      contactId: input.contactId,
      title: `${kindLabel(input.kind)}: ${input.equipmentLabel}`,
      description: `Service due ${input.dueAt.toISOString().slice(0, 10)}. Confirm appointment and customer notification preferences.`,
      sourceEvent: "service.obligation_due",
      dueAt: serviceNoticeAt(input.dueAt, input.noticeDays),
      priority: "normal",
    })
    .returning();
  const [obligation] = await tx
    .insert(serviceObligationsTable)
    .values({ ...input, taskId: task.id })
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
  },
) {
  const dueAt = parseServiceDate(input.dueDate);
  if (!dueAt) return { error: "invalid_due_date" as const };
  return db.transaction(async (tx) => {
    const [contact] = await tx.select({ id: contactsTable.id }).from(contactsTable)
      .where(and(eq(contactsTable.id, input.contactId), eq(contactsTable.organizationId, organizationId)));
    if (!contact) return { error: "contact_not_found" as const };
    if (input.propertyId) {
      const [property] = await tx.select({ id: propertiesTable.id }).from(propertiesTable)
        .where(and(
          eq(propertiesTable.id, input.propertyId),
          eq(propertiesTable.organizationId, organizationId),
          eq(propertiesTable.contactId, input.contactId),
        ));
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

export async function listServiceObligations(organizationId: string) {
  return db
    .select({ obligation: serviceObligationsTable, contact: contactsTable, task: crmTasksTable })
    .from(serviceObligationsTable)
    .innerJoin(contactsTable, eq(serviceObligationsTable.contactId, contactsTable.id))
    .innerJoin(crmTasksTable, eq(serviceObligationsTable.taskId, crmTasksTable.id))
    .where(eq(serviceObligationsTable.organizationId, organizationId))
    .orderBy(asc(serviceObligationsTable.dueAt))
    .limit(500);
}

export async function updateServiceObligation(
  organizationId: string,
  actorUserId: string,
  id: string,
  input: { status?: "active" | "completed" | "cancelled"; dueDate?: string; appointmentId?: string | null },
) {
  const dueAt = input.dueDate === undefined ? undefined : parseServiceDate(input.dueDate);
  if (dueAt === null) return { error: "invalid_due_date" as const };
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(serviceObligationsTable)
      .where(and(eq(serviceObligationsTable.id, id), eq(serviceObligationsTable.organizationId, organizationId)))
      .for("update");
    if (!current) return { error: "not_found" as const };
    if (input.appointmentId) {
      const [appointment] = await tx.select().from(appointmentsTable)
        .where(and(eq(appointmentsTable.id, input.appointmentId), eq(appointmentsTable.organizationId, organizationId)));
      if (!appointment || appointment.contactId !== current.contactId) {
        return { error: "appointment_not_for_customer" as const };
      }
    }
    const status = input.status ?? current.status;
    const nextDue = dueAt ?? current.dueAt;
    const appointmentId = input.appointmentId === undefined ? current.appointmentId : input.appointmentId;
    const [updated] = await tx.update(serviceObligationsTable)
      .set({ status, dueAt: nextDue, appointmentId, completedAt: status === "completed" ? new Date() : null })
      .where(eq(serviceObligationsTable.id, id))
      .returning();
    const taskStatus = status === "cancelled" ? "cancelled" : status === "completed" || appointmentId ? "done" : "open";
    await tx.update(crmTasksTable)
      .set({
        status: taskStatus,
        dueAt: serviceNoticeAt(nextDue, current.noticeDays),
        completedAt: taskStatus === "done" ? new Date() : null,
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
    return updated;
  });
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
  const all = parseCsv(input.csv);
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
