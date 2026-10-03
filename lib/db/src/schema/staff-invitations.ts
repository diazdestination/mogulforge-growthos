import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./auth";
import { userRoleEnum } from "./enums";

/** Invitation authority and delivery evidence. No invitation token or email body is stored. */
export const staffInvitationsTable = pgTable(
  "staff_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    requestId: uuid("request_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    // Deliberately not a foreign key: accepting the invitation retires this placeholder ID.
    pendingUserId: varchar("pending_user_id").notNull(),
    email: text("email").notNull(),
    role: userRoleEnum("role").notNull(),
    tokenRevision: uuid("token_revision").notNull().defaultRandom(),
    version: integer("version").notNull().default(1),
    state: text("state")
      .$type<"pending" | "accepted" | "revoked">()
      .notNull()
      .default("pending"),
    deliveryState: text("delivery_state")
      .$type<"sending" | "sent" | "unconfirmed">()
      .notNull()
      .default("sending"),
    deliveryAttemptedAt: timestamp("delivery_attempted_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdByUserId: varchar("created_by_user_id")
      .notNull()
      .references(() => usersTable.id),
    acceptedUserId: varchar("accepted_user_id").references(() => usersTable.id),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("staff_invitations_org_id_unique").on(table.organizationId, table.id),
    uniqueIndex("staff_invitations_request_idx").on(
      table.organizationId,
      table.requestId,
    ),
    uniqueIndex("staff_invitations_pending_user_idx").on(table.pendingUserId),
    index("staff_invitations_org_idx").on(table.organizationId),
    check(
      "staff_invitations_state_valid",
      sql`${table.state} in ('pending', 'accepted', 'revoked')`,
    ),
    check(
      "staff_invitations_delivery_valid",
      sql`${table.deliveryState} in ('sending', 'sent', 'unconfirmed')`,
    ),
    check("staff_invitations_version_valid", sql`${table.version} > 0`),
  ],
);

export type StaffInvitation = typeof staffInvitationsTable.$inferSelect;
