import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { contactsTable } from "./contacts";

export const twilioDispatchesTable = pgTable(
  "twilio_dispatches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contactsTable.id),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    phone: text("phone").notNull(),
    purpose: text("purpose").notNull(),
    accountSid: text("account_sid").notNull(),
    providerSid: text("provider_sid"),
    status: text("status").notNull().default("dispatching"),
    errorCode: text("error_code"),
    attempts: integer("attempts").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("twilio_dispatch_key").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    uniqueIndex("twilio_dispatch_sid").on(table.providerSid),
  ],
);

export const twilioConsentProofsTable = pgTable("twilio_consent_proofs", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizationsTable.id),
  contactId: uuid("contact_id")
    .notNull()
    .references(() => contactsTable.id),
  phone: text("phone").notNull(),
  purpose: text("purpose").notNull(),
  granted: boolean("granted").notNull(),
  disclosureVersion: text("disclosure_version").notNull(),
  source: text("source").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const twilioEnrollmentsTable = pgTable(
  "twilio_enrollments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    phone: text("phone").notNull(),
    challengeHash: text("challenge_hash").notNull(),
    disclosureVersion: text("disclosure_version").notNull(),
    customerCare: boolean("customer_care").notNull(),
    appointments: boolean("appointments").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("twilio_enrollment_phone").on(
      table.organizationId,
      table.phone,
    ),
  ],
);

export const twilioInboundEventsTable = pgTable("twilio_inbound_events", {
  messageSid: text("message_sid").primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizationsTable.id),
  phone: text("phone").notNull(),
  eventType: text("event_type").notNull(),
  body: text("body"),
  contactId: uuid("contact_id").references(() => contactsTable.id),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const twilioCallsTable = pgTable(
  "twilio_calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    contactId: uuid("contact_id").references(() => contactsTable.id),
    requestKey: text("request_key").notNull(),
    direction: text("direction").notNull(),
    phone: text("phone").notNull(),
    staffPhone: text("staff_phone").notNull(),
    accountSid: text("account_sid").notNull(),
    providerSid: text("provider_sid"),
    status: text("status").notNull().default("dispatching"),
    dialStatus: text("dial_status"),
    bridgeStarted: boolean("bridge_started").notNull().default(false),
    authorizationSource: text("authorization_source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("twilio_call_request").on(
      table.organizationId,
      table.requestKey,
    ),
    uniqueIndex("twilio_call_sid").on(table.providerSid),
  ],
);
