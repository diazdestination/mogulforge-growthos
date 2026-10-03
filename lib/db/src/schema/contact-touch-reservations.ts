import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { contactsTable } from "./contacts";

/** Allowance ownership is not consent, provider acceptance or authority to replay. */
export const contactTouchReservationsTable = pgTable("contact_touch_reservations", {
  id: uuid("id").defaultRandom().primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  logicalKey: text("logical_key").notNull(), contactId: uuid("contact_id").notNull(), address: text("address").notNull(), channel: text("channel").$type<"email" | "sms">().notNull(),
  sourceKind: text("source_kind").$type<"bie" | "source" | "nurture" | "service" | "playbook" | "automation">().notNull(),
  payloadHash: text("payload_hash").notNull(), reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(),
  dispatchStartedAt: timestamp("dispatch_started_at", { withTimezone: true }), acceptedAt: timestamp("accepted_at", { withTimezone: true }),
}, t => [
  unique("contact_touch_org_id_uq").on(t.organizationId, t.id), unique("contact_touch_logical_key_uq").on(t.organizationId, t.logicalKey),
  index("contact_touch_window_idx").on(t.organizationId, t.contactId, t.reservedAt),
  foreignKey({ columns: [t.organizationId, t.contactId], foreignColumns: [contactsTable.organizationId, contactsTable.id], name: "contact_touch_contact_fk" }),
  check("contact_touch_kind_ck", sql`${t.channel} in ('email','sms') and ${t.sourceKind} in ('bie','source','nurture','service','playbook','automation')`),
  check("contact_touch_hash_ck", sql`${t.payloadHash} ~ '^[0-9a-f]{64}$'`),
]);
