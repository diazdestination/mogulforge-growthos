import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid, varchar, type AnyPgColumn } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./auth";
import { contactsTable } from "./contacts";
import { propertiesTable } from "./properties";
import { appointmentsTable } from "./appointments";
import { serviceObligationsTable } from "./service-obligations";
import { storedObjectsTable } from "./object-storage";

export const propertyAssetsTable = pgTable("property_assets", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  contactId: uuid("contact_id").notNull(), propertyId: uuid("property_id").notNull(),
  version: integer("version").notNull().default(1), status: text("status").notNull().default("active"),
  facts: jsonb("facts").$type<Record<string, unknown>>().notNull(), createdByUserId: varchar("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("property_assets_org_id_uq").on(t.organizationId, t.id),
  unique("property_assets_scope_uq").on(t.organizationId, t.id, t.contactId, t.propertyId),
  index("property_assets_customer_page_idx").on(t.organizationId, t.contactId, t.createdAt, t.id),
  foreignKey({ columns: [t.organizationId, t.contactId], foreignColumns: [contactsTable.organizationId, contactsTable.id], name: "property_assets_contact_fk" }),
  foreignKey({ columns: [t.organizationId, t.propertyId], foreignColumns: [propertiesTable.organizationId, propertiesTable.id], name: "property_assets_property_fk" }),
  foreignKey({ columns: [t.organizationId, t.createdByUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "property_assets_actor_fk" }),
  check("property_assets_state_ck", sql`${t.version}>0 AND ${t.status} IN ('active','retired') AND jsonb_typeof(${t.facts})='object'`),
]);

export const workChecklistTemplatesTable = pgTable("work_checklist_templates", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  version: integer("version").notNull().default(1), status: text("status").notNull().default("draft"), createdByUserId: varchar("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("work_checklist_templates_org_id_uq").on(t.organizationId, t.id),
  foreignKey({ columns: [t.organizationId, t.createdByUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "work_checklist_templates_actor_fk" }),
  check("work_checklist_templates_state_ck", sql`${t.version}>0 AND ${t.status} IN ('draft','reviewed','retired')`),
]);

export const workChecklistRevisionsTable = pgTable("work_checklist_revisions", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  templateId: uuid("template_id").notNull(), version: integer("version").notNull(), definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
  definitionSha256: text("definition_sha256").notNull(), baselineId: text("baseline_id"), baselineVersion: integer("baseline_version"),
  createdByUserId: varchar("created_by_user_id").notNull(), reviewedByUserId: varchar("reviewed_by_user_id"), reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("work_checklist_revisions_org_id_uq").on(t.organizationId, t.id),
  unique("work_checklist_revisions_number_uq").on(t.organizationId, t.templateId, t.version),
  foreignKey({ columns: [t.organizationId, t.templateId], foreignColumns: [workChecklistTemplatesTable.organizationId, workChecklistTemplatesTable.id], name: "work_checklist_revisions_template_fk" }),
  foreignKey({ columns: [t.organizationId, t.createdByUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "work_checklist_revisions_creator_fk" }),
  foreignKey({ columns: [t.organizationId, t.reviewedByUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "work_checklist_revisions_reviewer_fk" }),
  check("work_checklist_revisions_shape_ck", sql`${t.version}>0 AND ${t.definitionSha256} ~ '^[a-f0-9]{64}$' AND jsonb_typeof(${t.definition})='object' AND ((${t.reviewedAt} IS NULL AND ${t.reviewedByUserId} IS NULL) OR (${t.reviewedAt} IS NOT NULL AND ${t.reviewedByUserId} IS NOT NULL)) AND ((${t.baselineId} IS NULL AND ${t.baselineVersion} IS NULL) OR (${t.baselineId} IS NOT NULL AND ${t.baselineVersion} IS NOT NULL AND ${t.baselineVersion}>0))`),
]);

export const appointmentWorkCompletionsTable = pgTable("appointment_work_completions", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  appointmentId: uuid("appointment_id").notNull(), contactId: uuid("contact_id").notNull(), propertyId: uuid("property_id"),
  originalCompletionId: uuid("original_completion_id").references((): AnyPgColumn => appointmentWorkCompletionsTable.id),
  requestId: uuid("request_id").notNull(), payloadSha256: text("payload_sha256").notNull(),
  actorUserId: varchar("actor_user_id").notNull(), snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("appointment_work_completions_org_id_uq").on(t.organizationId, t.id),
  unique("appointment_work_completions_visit_uq").on(t.organizationId, t.id, t.appointmentId),
  unique("appointment_work_completions_request_uq").on(t.organizationId, t.requestId),
  uniqueIndex("appointment_work_completions_original_uq").on(t.organizationId, t.appointmentId).where(sql`${t.originalCompletionId} IS NULL`),
  foreignKey({ columns: [t.organizationId, t.appointmentId], foreignColumns: [appointmentsTable.organizationId, appointmentsTable.id], name: "appointment_work_completions_appointment_fk" }),
  foreignKey({ columns: [t.organizationId, t.contactId], foreignColumns: [contactsTable.organizationId, contactsTable.id], name: "appointment_work_completions_contact_fk" }),
  foreignKey({ columns: [t.organizationId, t.propertyId], foreignColumns: [propertiesTable.organizationId, propertiesTable.id], name: "appointment_work_completions_property_fk" }),
  foreignKey({ columns: [t.organizationId, t.actorUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "appointment_work_completions_actor_fk" }),
  foreignKey({ columns: [t.organizationId, t.originalCompletionId, t.appointmentId], foreignColumns: [t.organizationId, t.id, t.appointmentId], name: "appointment_work_completions_original_fk" }),
  check("appointment_work_completions_shape_ck", sql`${t.payloadSha256} ~ '^[a-f0-9]{64}$' AND jsonb_typeof(${t.snapshot})='object' AND (${t.originalCompletionId} IS NULL OR ${t.originalCompletionId}<>${t.id})`),
]);

export const appointmentWorkEntriesTable = pgTable("appointment_work_entries", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  appointmentId: uuid("appointment_id").notNull(), contactId: uuid("contact_id").notNull(), propertyId: uuid("property_id"),
  assetId: uuid("asset_id"), serviceObligationId: uuid("service_obligation_id"), checklistRevisionId: uuid("checklist_revision_id").notNull(),
  version: integer("version").notNull().default(1), state: text("state").notNull().default("draft"),
  parentSnapshot: jsonb("parent_snapshot").$type<Record<string, unknown>>().notNull(), assetSnapshot: jsonb("asset_snapshot").$type<Record<string, unknown>>(),
  answers: jsonb("answers").$type<Record<string, unknown>[]>().notNull().default([]), notes: text("notes").notNull().default(""),
  completionId: uuid("completion_id"), createdByUserId: varchar("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("appointment_work_entries_org_id_uq").on(t.organizationId, t.id),
  unique("appointment_work_entries_visit_uq").on(t.organizationId, t.id, t.appointmentId),
  index("appointment_work_entries_visit_idx").on(t.organizationId, t.appointmentId),
  foreignKey({ columns: [t.organizationId, t.appointmentId], foreignColumns: [appointmentsTable.organizationId, appointmentsTable.id], name: "appointment_work_entries_appointment_fk" }),
  foreignKey({ columns: [t.organizationId, t.contactId], foreignColumns: [contactsTable.organizationId, contactsTable.id], name: "appointment_work_entries_contact_fk" }),
  foreignKey({ columns: [t.organizationId, t.propertyId], foreignColumns: [propertiesTable.organizationId, propertiesTable.id], name: "appointment_work_entries_property_fk" }),
  foreignKey({ columns: [t.organizationId, t.assetId, t.contactId, t.propertyId], foreignColumns: [propertyAssetsTable.organizationId, propertyAssetsTable.id, propertyAssetsTable.contactId, propertyAssetsTable.propertyId], name: "appointment_work_entries_asset_fk" }),
  foreignKey({ columns: [t.organizationId, t.serviceObligationId], foreignColumns: [serviceObligationsTable.organizationId, serviceObligationsTable.id], name: "appointment_work_entries_service_fk" }),
  foreignKey({ columns: [t.organizationId, t.checklistRevisionId], foreignColumns: [workChecklistRevisionsTable.organizationId, workChecklistRevisionsTable.id], name: "appointment_work_entries_revision_fk" }),
  foreignKey({ columns: [t.organizationId, t.completionId, t.appointmentId], foreignColumns: [appointmentWorkCompletionsTable.organizationId, appointmentWorkCompletionsTable.id, appointmentWorkCompletionsTable.appointmentId], name: "appointment_work_entries_completion_fk" }),
  foreignKey({ columns: [t.organizationId, t.createdByUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "appointment_work_entries_actor_fk" }),
  check("appointment_work_entries_state_ck", sql`${t.version}>0 AND ${t.state} IN ('draft','cancelled','finalized') AND ((${t.state}='finalized' AND ${t.completionId} IS NOT NULL) OR (${t.state}<>'finalized' AND ${t.completionId} IS NULL)) AND ((${t.assetId} IS NULL AND ${t.assetSnapshot} IS NULL) OR (${t.assetId} IS NOT NULL AND ${t.propertyId} IS NOT NULL AND ${t.assetSnapshot} IS NOT NULL)) AND jsonb_typeof(${t.answers})='array' AND jsonb_array_length(${t.answers})<=50`),
]);

export const appointmentWorkPhotosTable = pgTable("appointment_work_photos", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  appointmentId: uuid("appointment_id").notNull(), entryId: uuid("entry_id").notNull(), reservedObjectId: uuid("reserved_object_id").notNull(), objectId: uuid("object_id"),
  requestId: uuid("request_id").notNull(), payloadSha256: text("payload_sha256").notNull(), state: text("state").notNull().default("reserved"),
  itemKey: text("item_key"), caption: text("caption").notNull().default(""), contentType: text("content_type").notNull(), sizeBytes: integer("size_bytes").notNull(),
  objectSha256: text("object_sha256"), createdByUserId: varchar("created_by_user_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), attachedAt: timestamp("attached_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("appointment_work_photos_org_id_uq").on(t.organizationId, t.id),
  unique("appointment_work_photos_request_uq").on(t.organizationId, t.requestId),
  unique("appointment_work_photos_object_uq").on(t.reservedObjectId),
  foreignKey({ columns: [t.organizationId, t.entryId, t.appointmentId], foreignColumns: [appointmentWorkEntriesTable.organizationId, appointmentWorkEntriesTable.id, appointmentWorkEntriesTable.appointmentId], name: "appointment_work_photos_entry_fk" }),
  foreignKey({ columns: [t.organizationId, t.objectId], foreignColumns: [storedObjectsTable.organizationId, storedObjectsTable.id], name: "appointment_work_photos_object_fk" }),
  foreignKey({ columns: [t.organizationId, t.createdByUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "appointment_work_photos_actor_fk" }),
  check("appointment_work_photos_shape_ck", sql`${t.state} IN ('reserved','attached','expired') AND ${t.sizeBytes}>0 AND ${t.sizeBytes}<=10485760 AND ${t.contentType} IN ('image/jpeg','image/png','image/webp') AND ${t.payloadSha256} ~ '^[a-f0-9]{64}$' AND ((${t.state}='attached' AND ${t.objectId} IS NOT NULL AND ${t.objectId}=${t.reservedObjectId} AND ${t.attachedAt} IS NOT NULL AND ${t.objectSha256} IS NOT NULL AND ${t.objectSha256} ~ '^[a-f0-9]{64}$') OR (${t.state}<>'attached' AND ${t.objectId} IS NULL AND ${t.attachedAt} IS NULL AND ${t.objectSha256} IS NULL))`),
]);
