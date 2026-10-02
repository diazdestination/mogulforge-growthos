import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { organizationsTable } from "./organizations";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Portable private-object storage for self-hosted MogulForge deployments.
 *
 * Small customer-uploaded photos are stored in Postgres so a Docker/Fly
 * instance does not depend on Replit's sidecar or an ephemeral filesystem.
 * The object-service boundary still supports the legacy GCS/Replit provider.
 */
export const storedObjectsTable = pgTable(
  "stored_objects",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id").references(
      () => organizationsTable.id,
    ),
    data: bytea("data").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("stored_objects_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);

export type StoredObject = typeof storedObjectsTable.$inferSelect;
