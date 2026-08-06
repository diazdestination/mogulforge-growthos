import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { userRoleEnum } from "./enums";

// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
export const sessionsTable = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);

// (IMPORTANT) This table is mandatory for Replit Auth, don't drop it.
// Extended with organization membership + role for GrowthOS multi-tenancy.
export const usersTable = pgTable("users", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  /**
   * scrypt password hash for self-hosted email/password auth
   * (format: "scrypt$<salt>$<hash>"). Null for users who authenticate via an
   * external IdP (e.g. Replit OIDC) instead of a local password.
   */
  passwordHash: varchar("password_hash"),
  organizationId: uuid("organization_id").references(
    () => organizationsTable.id,
  ),
  role: userRoleEnum("role").notNull().default("viewer"),
  /**
   * Platform-level super admin (MogulForge operator): may list and manage
   * ALL organizations. Distinct from org "owner", which is scoped to one org.
   */
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type UpsertUser = typeof usersTable.$inferInsert;
export type User = typeof usersTable.$inferSelect;
