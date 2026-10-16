/**
 * GAP-16 regression: default-seed transactions must not reach back to the
 * shared pool while they hold a connection. With a one-connection pool (the
 * disposable preview server) a pool query inside the transaction waits
 * forever for the connection the transaction itself is holding, so the first
 * lead.created for a fresh org deadlocks. Under production concurrency the
 * same pattern doubles connection demand and can exhaust the pool.
 *
 * This suite swaps the shared pool for a single-connection pool with a short
 * acquire timeout so the deadlock surfaces as a fast failure instead of a hang.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/db")>();
  const pg = (await import("pg")).default;
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const schema = await import("@workspace/db/schema");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 3_000,
  });
  return { ...original, pool, db: drizzle(pool, { schema }) };
});

import {
  automationsTable,
  db,
  organizationsTable,
  playbooksTable,
  pool,
} from "@workspace/db";
import { eq } from "drizzle-orm";

import { clearLegacyOrgCache } from "../lib/orgFlavor";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { ensureDefaultAutomations } from "./automation";
import * as crm from "./crm";
import { autoEnrollLead, DEFAULT_PLAYBOOK_SEED_KEY, ensureDefaultPlaybook } from "./playbooks";

const orgIds: string[] = [];

async function freshOrg(): Promise<string> {
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "Single Connection Org", slug: `test-single-conn-${randomUUID()}` })
    .returning();
  orgIds.push(row.id);
  return row.id;
}

beforeAll(() => {
  expect(pool.options.max).toBe(1);
});

beforeEach(() => {
  // A cold org-flavor cache is what forces the lookup query inside the tx.
  clearLegacyOrgCache();
});

afterAll(async () => {
  await deleteTestOrgs(...orgIds);
  await pool.end();
});

describe("default seeding on a single-connection pool (GAP-16)", () => {
  it("ensureDefaultPlaybook seeds a fresh org without a second connection", async () => {
    const orgId = await freshOrg();
    await ensureDefaultPlaybook(orgId);
    const rows = await db
      .select({ seedKey: playbooksTable.seedKey })
      .from(playbooksTable)
      .where(eq(playbooksTable.organizationId, orgId));
    expect(rows.map((r) => r.seedKey)).toEqual([DEFAULT_PLAYBOOK_SEED_KEY]);
  });

  it("lead.created auto-enrollment completes for a fresh org", async () => {
    const orgId = await freshOrg();
    const contact = await crm.createContact(orgId, {
      firstName: "Single",
      lastName: "Connection",
      email: `${randomUUID()}@example.invalid`,
    });
    const lead = await crm.createLead(orgId, { contactId: contact.id });
    clearLegacyOrgCache();
    await autoEnrollLead(orgId, lead!.id);
    const rows = await db
      .select({ id: playbooksTable.id })
      .from(playbooksTable)
      .where(eq(playbooksTable.organizationId, orgId));
    expect(rows).toHaveLength(1);
  });

  it("ensureDefaultAutomations seeds a fresh org without a second connection", async () => {
    const orgId = await freshOrg();
    await ensureDefaultAutomations(orgId);
    const rows = await db
      .select({ id: automationsTable.id })
      .from(automationsTable)
      .where(eq(automationsTable.organizationId, orgId));
    expect(rows.length).toBeGreaterThan(0);
  });
});
