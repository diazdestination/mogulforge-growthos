import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { contactsTable } from "./contacts";
import { propertiesTable } from "./properties";
import { usersTable } from "./auth";
import { estimatesTable } from "./estimates";
import { projectsTable } from "./projects";

/** Immutable identity only. Native estimates/jobs/invoices own all business state. */
export const customerWorkRootsTable = pgTable("customer_work_roots", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  contactId: uuid("contact_id").notNull(), propertyId: uuid("property_id"), createdByUserId: varchar("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("customer_work_roots_org_id_uq").on(t.organizationId, t.id),
  foreignKey({ columns: [t.organizationId, t.contactId], foreignColumns: [contactsTable.organizationId, contactsTable.id], name: "customer_work_root_contact_fk" }),
  foreignKey({ columns: [t.organizationId, t.propertyId], foreignColumns: [propertiesTable.organizationId, propertiesTable.id], name: "customer_work_root_property_fk" }),
  foreignKey({ columns: [t.organizationId, t.createdByUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "customer_work_root_creator_fk" }),
  index("customer_work_roots_contact_idx").on(t.organizationId, t.contactId, t.createdAt),
  index("customer_work_roots_property_idx").on(t.organizationId, t.propertyId),
]);
export const customerWorkCommandsTable = pgTable("customer_work_commands", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull(), requestId: uuid("request_id").notNull(),
  actorUserId: varchar("actor_user_id").notNull(), action: text("action").$type<"estimate_created" | "estimate_updated" | "project_created" | "project_updated">().notNull(),
  payloadSha256: text("payload_sha256").notNull(), customerWorkId: uuid("customer_work_id").notNull(),
  estimateId: uuid("estimate_id"), projectId: uuid("project_id"), resultVersion: integer("result_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique("customer_work_command_request_uq").on(t.organizationId, t.requestId),
  foreignKey({ columns: [t.organizationId, t.customerWorkId], foreignColumns: [customerWorkRootsTable.organizationId, customerWorkRootsTable.id], name: "customer_work_command_root_fk" }),
  foreignKey({ columns: [t.organizationId, t.actorUserId], foreignColumns: [usersTable.organizationId, usersTable.id], name: "customer_work_command_actor_fk" }),
  foreignKey({ columns: [t.organizationId, t.estimateId, t.customerWorkId], foreignColumns: [estimatesTable.organizationId, estimatesTable.id, estimatesTable.customerWorkId], name: "customer_work_command_estimate_fk" }),
  foreignKey({ columns: [t.organizationId, t.projectId, t.customerWorkId], foreignColumns: [projectsTable.organizationId, projectsTable.id, projectsTable.customerWorkId], name: "customer_work_command_project_fk" }),
  check("customer_work_command_target_ck", sql`(${t.action} in ('estimate_created','estimate_updated') and ${t.estimateId} is not null and ${t.projectId} is null) or (${t.action} in ('project_created','project_updated') and ${t.projectId} is not null and ${t.estimateId} is null)`),
  check("customer_work_command_value_ck", sql`${t.resultVersion} > 0 and ${t.payloadSha256} ~ '^[a-f0-9]{64}$'`),
  index("customer_work_commands_root_idx").on(t.organizationId, t.customerWorkId),
]);
