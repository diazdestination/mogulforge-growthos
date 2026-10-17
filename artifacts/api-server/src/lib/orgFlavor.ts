import { db, organizationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CLIENT } from "./client.config";

/**
 * Whether an org is the legacy default tenant (the original client this
 * deployment was built for). The legacy org keeps its historical
 * roofing-flavored defaults; every other org gets industry-neutral behavior.
 *
 * Lives in its own module (not services/org.ts) so seed modules like
 * playbooks/automation can use it without import cycles.
 */
const cache = new Map<string, boolean>();

/**
 * The shared pool or an open transaction. Callers inside `db.transaction(...)`
 * must pass their `tx`: reaching back to the pool while the transaction holds
 * a connection deadlocks a one-connection pool (GAP-16).
 */
type OrgFlavorExecutor = Pick<typeof db, "select">;

export async function isLegacyDefaultOrg(
  organizationId: string,
  executor: OrgFlavorExecutor = db,
): Promise<boolean> {
  const cached = cache.get(organizationId);
  if (cached !== undefined) return cached;
  const [org] = await executor
    .select({ slug: organizationsTable.slug })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId));
  const isLegacy = org?.slug === CLIENT.defaultOrgSlug;
  cache.set(organizationId, isLegacy);
  return isLegacy;
}

/** Test helper: orgs come and go in tests; never cache across suites. */
export function clearLegacyOrgCache(): void {
  cache.clear();
}
