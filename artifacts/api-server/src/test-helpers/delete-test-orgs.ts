import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Test-only helper: delete one or more organizations and EVERY row that
 * belongs to them, in FK-safe order.
 *
 * Why it exists: the schema has no ON DELETE CASCADE, so a suite that
 * deletes its org/users while forgetting a dependent table (audit_events
 * was the classic offender) hits an FK violation inside afterAll. Vitest
 * reports the failure but the suite still "passes", silently stranding the
 * org — and stranded orgs make any org-scanning check (e.g. the API-key
 * expiry reminder) flaky over time.
 *
 * How it works: every org-scoped table carries an `organization_id` column,
 * so we discover them from information_schema (future tables are covered
 * automatically) and delete with a retry loop — a table whose delete is
 * blocked by an FK from another pending table is retried on the next pass.
 * The final organization delete is also retried after another scoped sweep,
 * because parallel suites can finish an already-started audit write between
 * the first sweep and the parent delete. The helper verifies the org rows
 * themselves are gone, so cleanup failures are loud instead of silent.
 */
export async function deleteTestOrgs(
  ...orgIds: Array<string | undefined | null>
): Promise<void> {
  const ids = orgIds.filter((id): id is string => Boolean(id));
  if (ids.length === 0) return;

  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const discovered = await db.execute<{ table_name: string }>(sql`
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'organization_id'
      AND t.table_type = 'BASE TABLE'
  `);

  const postgresErrorCode = (err: unknown): string | undefined =>
    (err as { code?: string }).code ??
    (err as { cause?: { code?: string } }).cause?.code;

  const deleteScopedRows = async (): Promise<void> => {
    let pending = discovered.rows.map((r) => r.table_name);
    while (pending.length > 0) {
      const blocked: string[] = [];
      const errors: string[] = [];
      for (const table of pending) {
        try {
          await db.execute(
            sql`DELETE FROM ${sql.identifier(table)} WHERE organization_id IN (${idList})`,
          );
        } catch (err) {
          // 23503 = foreign_key_violation: another pending table still
          // references this one; retry after that table is cleared.
          // (drizzle may wrap the pg error, so also check `cause`.)
          if (postgresErrorCode(err) === "23503") {
            blocked.push(table);
            errors.push(`${table}: ${(err as Error).message}`);
          } else {
            throw err;
          }
        }
      }
      if (blocked.length === pending.length) {
        throw new Error(
          `deleteTestOrgs made no progress; still blocked: ${errors.join("; ")}`,
        );
      }
      pending = blocked;
    }
  };

  const maxOrganizationDeleteAttempts = 5;
  for (let attempt = 1; ; attempt += 1) {
    await deleteScopedRows();
    try {
      await db.execute(sql`DELETE FROM organizations WHERE id IN (${idList})`);
      break;
    } catch (err) {
      const canRetry =
        postgresErrorCode(err) === "23503" &&
        attempt < maxOrganizationDeleteAttempts;
      if (!canRetry) throw err;
    }
  }

  const remaining = await db.execute<{ id: string }>(
    sql`SELECT id FROM organizations WHERE id IN (${idList})`,
  );
  if (remaining.rows.length > 0) {
    throw new Error(
      `deleteTestOrgs failed to delete orgs: ${remaining.rows.map((r) => r.id).join(", ")}`,
    );
  }
}
