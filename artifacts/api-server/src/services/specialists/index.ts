/**
 * Specialist entry points used by routes. Running a specialist only appends
 * `proposed` rows; review and execution remain in services/bie.ts.
 */
import { bieActionProposalsTable, bieAgentRunsTable, db } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";

import { runInvo, type InvoOptions, type InvoPrincipal } from "./invo";
import { runScout } from "./scout";
import { SPECIALIST_LABEL, SPECIALIST_RUN_KIND, type RunnableSpecialistKey, type SpecialistKey } from "./contract";

export { SpecialistAccessError, canReadInvoiceProposals } from "./invo";
export { RUNNABLE_SPECIALISTS, SPECIALIST_KEYS, type SpecialistKey } from "./contract";

export async function runSpecialist(
  organizationId: string,
  key: RunnableSpecialistKey,
  actorUserId: string,
  options: Partial<InvoOptions> = {},
  principal: InvoPrincipal = {},
  now = new Date(),
) {
  const outcome = key === "scout"
    ? await runScout(organizationId, actorUserId, now)
    : await runInvo(organizationId, actorUserId, options, now, principal);
  return {
    specialist: SPECIALIST_LABEL[key],
    runId: outcome.runId,
    proposals: outcome.inserted,
    skipped: outcome.skipped.slice(0, 200),
    skippedCount: outcome.skipped.length,
  };
}

/**
 * Proposals attributed (by run kind, not client data) to one specialist.
 * Callers must check invoice visibility before listing INVO proposals.
 */
export async function listSpecialistProposals(organizationId: string, key: SpecialistKey) {
  const rows = await db.select({ proposal: bieActionProposalsTable })
    .from(bieActionProposalsTable)
    .innerJoin(bieAgentRunsTable, and(eq(bieActionProposalsTable.runId, bieAgentRunsTable.id), eq(bieAgentRunsTable.organizationId, organizationId)))
    .where(and(eq(bieActionProposalsTable.organizationId, organizationId), eq(bieAgentRunsTable.kind, SPECIALIST_RUN_KIND[key])))
    .orderBy(desc(bieActionProposalsTable.createdAt))
    .limit(200);
  return rows.map(({ proposal }) => ({ ...proposal, specialist: key }));
}
