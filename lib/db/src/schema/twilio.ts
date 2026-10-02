import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  boolean,
  uniqueIndex,
  unique,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { contactsTable } from "./contacts";
import { crmTasksTable } from "./crm-tasks";
import { leadsTable } from "./leads";
import { usersTable } from "./auth";

/** One isolated Twilio subaccount/number per organization. All launch gates default off.
 * Secret references name server-side environment entries, never secret values. */
export const twilioClientBindingsTable = pgTable(
  "twilio_client_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    accountSid: text("account_sid").notNull(),
    phoneNumber: text("phone_number").notNull(),
    messagingServiceSid: text("messaging_service_sid"),
    apiKeySid: text("api_key_sid"),
    authTokenSecretRef: text("auth_token_secret_ref").notNull(),
    apiKeySecretRef: text("api_key_secret_ref"),
    publicOrigin: text("public_origin").notNull(),
    businessName: text("business_name").notNull(),
    staffPhone: text("staff_phone"),
    smsDisclosureVersion: text("sms_disclosure_version"),
    publicEnrollmentToken: text("public_enrollment_token"),
    dailySmsLimit: integer("daily_sms_limit").notNull().default(0),
    dailyCallLimit: integer("daily_call_limit").notNull().default(0),
    launchApproved: boolean("launch_approved").notNull().default(false),
    smsEnabled: boolean("sms_enabled").notNull().default(false),
    registrationApproved: boolean("registration_approved").notNull().default(false),
    advancedOptOut: boolean("advanced_opt_out").notNull().default(false),
    voiceEnabled: boolean("voice_enabled").notNull().default(false),
    voiceApproved: boolean("voice_approved").notNull().default(false),
    geoPermissionsReviewed: boolean("geo_permissions_reviewed").notNull().default(false),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("twilio_client_binding_org_uq").on(table.organizationId),
    uniqueIndex("twilio_client_binding_account_uq").on(table.accountSid),
    uniqueIndex("twilio_client_binding_phone_uq").on(table.phoneNumber),
    uniqueIndex("twilio_client_binding_program_uq").on(table.publicEnrollmentToken),
  ],
);

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
    unique("twilio_calls_org_id_uq").on(table.organizationId, table.id),
  ],
);

/** One staff-visible follow-up per missed inbound call. No SMS consent is inferred. */
export const missedCallHandoffsTable = pgTable(
  "missed_call_handoffs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    callId: uuid("call_id")
      .notNull()
      .references(() => twilioCallsTable.id),
    taskId: uuid("task_id")
      .notNull()
      .references(() => crmTasksTable.id),
    contactId: uuid("contact_id").references(() => contactsTable.id),
    leadId: uuid("lead_id").references(() => leadsTable.id),
    reviewRequestId: uuid("review_request_id"),
    reviewPayloadHash: text("review_payload_hash"),
    reviewedByUserId: text("reviewed_by_user_id").references(() => usersTable.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("missed_call_handoffs_call_uq").on(table.callId)],
);
