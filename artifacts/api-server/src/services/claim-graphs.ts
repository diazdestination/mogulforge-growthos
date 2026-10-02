import {
  claimCanonicalGraphsTable,
  claimCasesTable,
  db,
  estimatesTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";

import { recordAudit } from "./audit";
import {
  compileClaimGraphTarget,
  compileNativeEstimateClaimGraph,
  type ClaimGraphTarget,
} from "./claim-compilation";

export class ClaimGraphError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

async function requireCase(organizationId: string, caseId: string) {
  const [claimCase] = await db
    .select()
    .from(claimCasesTable)
    .where(and(eq(claimCasesTable.organizationId, organizationId), eq(claimCasesTable.id, caseId)))
    .limit(1);
  if (!claimCase) throw new ClaimGraphError("Claim case not found.", 404);
  return claimCase;
}

async function requireGraph(organizationId: string, caseId: string, graphId: string) {
  const [graph] = await db
    .select()
    .from(claimCanonicalGraphsTable)
    .where(
      and(
        eq(claimCanonicalGraphsTable.organizationId, organizationId),
        eq(claimCanonicalGraphsTable.caseId, caseId),
        eq(claimCanonicalGraphsTable.id, graphId),
      ),
    )
    .limit(1);
  if (!graph) throw new ClaimGraphError("Canonical claim graph not found.", 404);
  return graph;
}

export async function listClaimGraphs(organizationId: string, caseId: string) {
  await requireCase(organizationId, caseId);
  return db
    .select()
    .from(claimCanonicalGraphsTable)
    .where(and(eq(claimCanonicalGraphsTable.organizationId, organizationId), eq(claimCanonicalGraphsTable.caseId, caseId)))
    .orderBy(desc(claimCanonicalGraphsTable.version));
}

/**
 * The first compiler adapter supports the estimates native to this product.
 * External estimate formats can be added as independent adapters without
 * changing the graph or its provenance ledger.
 */
export async function compileNativeEstimateForClaim(
  organizationId: string,
  caseId: string,
  estimateId: string,
  actorUserId: string,
) {
  const claimCase = await requireCase(organizationId, caseId);
  const [estimate] = await db
    .select()
    .from(estimatesTable)
    .where(and(eq(estimatesTable.organizationId, organizationId), eq(estimatesTable.id, estimateId)))
    .limit(1);
  if (!estimate) throw new ClaimGraphError("Estimate not found.", 404);
  if (claimCase.leadId && claimCase.leadId !== estimate.leadId) {
    throw new ClaimGraphError("The selected estimate belongs to a different lead than this claim case.", 409);
  }

  const graph = compileNativeEstimateClaimGraph({
    claimId: caseId,
    estimateId: estimate.id,
    lineItems: estimate.lineItems,
    subtotalCents: estimate.subtotalCents,
    taxCents: estimate.taxCents,
    totalCents: estimate.totalCents,
  });
  const [latest] = await db
    .select({ version: claimCanonicalGraphsTable.version })
    .from(claimCanonicalGraphsTable)
    .where(and(eq(claimCanonicalGraphsTable.organizationId, organizationId), eq(claimCanonicalGraphsTable.caseId, caseId)))
    .orderBy(desc(claimCanonicalGraphsTable.version))
    .limit(1);
  const version = (latest?.version ?? 0) + 1;
  const [created] = await db
    .insert(claimCanonicalGraphsTable)
    .values({
      organizationId,
      caseId,
      version,
      status: graph.valid ? "valid" : "invalid",
      sourceKind: "native_estimate",
      sourceReference: estimate.id,
      rulesetVersion: graph.rulesetVersion,
      graph: graph as unknown as Record<string, unknown>,
      graphHash: graph.digest,
      invariantReport: graph.invariants as unknown as Record<string, unknown>[],
      createdByUserId: actorUserId,
    })
    .returning();
  await recordAudit({
    organizationId,
    actorUserId,
    action: "claim.graph_compiled",
    entityType: "claim_canonical_graph",
    entityId: created.id,
    metadata: {
      caseId,
      estimateId,
      graphHash: created.graphHash,
      status: created.status,
      failedInvariantCount: graph.invariants.filter((item) => !item.passed).length,
    },
  });
  return created;
}

export async function compileClaimGraphForTarget(
  organizationId: string,
  caseId: string,
  graphId: string,
  target: ClaimGraphTarget,
) {
  const graphRecord = await requireGraph(organizationId, caseId, graphId);
  if (graphRecord.status !== "valid") {
    throw new ClaimGraphError("A graph with failed invariants cannot be compiled for a target.", 409);
  }
  const graph = graphRecord.graph as unknown as Parameters<typeof compileClaimGraphTarget>[0];
  let compiled: ReturnType<typeof compileClaimGraphTarget>;
  try {
    compiled = compileClaimGraphTarget(graph, target);
  } catch (error) {
    throw new ClaimGraphError(error instanceof Error ? error.message : "Claim graph target compilation failed.", 409);
  }
  if (compiled.sourceGraphDigest !== graphRecord.graphHash) {
    throw new ClaimGraphError("Stored graph integrity verification failed.", 409);
  }
  return compiled;
}

export function isClaimGraphTarget(value: unknown): value is ClaimGraphTarget {
  return value === "mogulforge-estimate-v1" || value === "contractor-claim-statement-v1";
}
