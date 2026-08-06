import {
  claimCanonicalGraphsTable,
  claimCasesTable,
  claimEvidenceArtifactsTable,
  claimLossCorroborationsTable,
  db,
  propertiesTable,
  type ClaimCorroborationStatus,
} from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";

import { recordAudit } from "./audit";
import { verifyCanonicalClaimGraph } from "./claim-compilation";
import {
  buildLossCorroboration,
  type Coordinates,
  type CorroborationSourceInput,
  type LossCorroborationBundle,
  type RoofFacet,
} from "./loss-corroboration";

export class LossCorroborationError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

export type CompileLossCorroborationInput = {
  canonicalGraphId: string;
  propertyCoordinates: Coordinates | null;
  roofFacets: RoofFacet[];
  sources: Array<Omit<CorroborationSourceInput, "sourceArtifactSha256">>;
};

async function requireCase(organizationId: string, caseId: string) {
  const [claimCase] = await db
    .select()
    .from(claimCasesTable)
    .where(and(eq(claimCasesTable.organizationId, organizationId), eq(claimCasesTable.id, caseId)))
    .limit(1);
  if (!claimCase) throw new LossCorroborationError("Claim case not found.", 404);
  return claimCase;
}

function coordinatesFromProperty(property: { latitude: string | null; longitude: string | null } | undefined): Coordinates | null {
  if (!property?.latitude || !property.longitude) return null;
  const latitude = Number(property.latitude);
  const longitude = Number(property.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

export async function listLossCorroborations(organizationId: string, caseId: string) {
  await requireCase(organizationId, caseId);
  return db
    .select()
    .from(claimLossCorroborationsTable)
    .where(and(eq(claimLossCorroborationsTable.organizationId, organizationId), eq(claimLossCorroborationsTable.caseId, caseId)))
    .orderBy(desc(claimLossCorroborationsTable.version));
}

/**
 * Every record must name a valid canonical claim graph and source artifacts
 * owned by the same tenant/case. The pure calculation receives digests copied
 * from those immutable rows; callers cannot choose their own provenance hash.
 */
export async function compileLossCorroboration(
  organizationId: string,
  caseId: string,
  actorUserId: string,
  input: CompileLossCorroborationInput,
) {
  const claimCase = await requireCase(organizationId, caseId);
  if (!claimCase.lossDate) {
    throw new LossCorroborationError("Set a reported loss date before computing loss corroboration.", 409);
  }
  const [graph] = await db
    .select()
    .from(claimCanonicalGraphsTable)
    .where(
      and(
        eq(claimCanonicalGraphsTable.organizationId, organizationId),
        eq(claimCanonicalGraphsTable.caseId, caseId),
        eq(claimCanonicalGraphsTable.id, input.canonicalGraphId),
      ),
    )
    .limit(1);
  if (!graph) throw new LossCorroborationError("Canonical claim graph not found.", 404);
  if (graph.status !== "valid" || !verifyCanonicalClaimGraph(graph.graph as Parameters<typeof verifyCanonicalClaimGraph>[0])) {
    throw new LossCorroborationError("A valid, untampered canonical claim graph is required for corroboration.", 409);
  }
  if (input.sources.length === 0) throw new LossCorroborationError("Add at least one source-linked observation.");

  const sourceArtifactIds = input.sources.map((source) => source.sourceArtifactId);
  const artifacts = await db
    .select({ id: claimEvidenceArtifactsTable.id, sha256: claimEvidenceArtifactsTable.sha256 })
    .from(claimEvidenceArtifactsTable)
    .where(
      and(
        eq(claimEvidenceArtifactsTable.organizationId, organizationId),
        eq(claimEvidenceArtifactsTable.caseId, caseId),
        inArray(claimEvidenceArtifactsTable.id, sourceArtifactIds),
      ),
    );
  if (artifacts.length !== new Set(sourceArtifactIds).size || artifacts.length !== sourceArtifactIds.length) {
    throw new LossCorroborationError("Every corroboration source must reference a distinct artifact in this claim case.", 409);
  }
  const digests = new Map(artifacts.map((artifact) => [artifact.id, artifact.sha256]));

  const property = claimCase.propertyId
    ? (
        await db
          .select({ latitude: propertiesTable.latitude, longitude: propertiesTable.longitude })
          .from(propertiesTable)
          .where(and(eq(propertiesTable.organizationId, organizationId), eq(propertiesTable.id, claimCase.propertyId)))
          .limit(1)
      )[0]
    : undefined;
  const propertyCoordinates = coordinatesFromProperty(property) ?? input.propertyCoordinates;
  let bundle: LossCorroborationBundle;
  try {
    bundle = buildLossCorroboration({
      claimId: caseId,
      claimGraphDigest: graph.graphHash,
      lossDate: claimCase.lossDate.toISOString(),
      propertyCoordinates,
      roofFacets: input.roofFacets,
      sources: input.sources.map((source) => ({
        ...source,
        sourceArtifactSha256: digests.get(source.sourceArtifactId)!,
      })),
    });
  } catch (error) {
    throw new LossCorroborationError(error instanceof Error ? error.message : "Loss corroboration could not be computed.");
  }

  const [latest] = await db
    .select({ version: claimLossCorroborationsTable.version })
    .from(claimLossCorroborationsTable)
    .where(and(eq(claimLossCorroborationsTable.organizationId, organizationId), eq(claimLossCorroborationsTable.caseId, caseId)))
    .orderBy(desc(claimLossCorroborationsTable.version))
    .limit(1);
  const version = (latest?.version ?? 0) + 1;
  const [created] = await db
    .insert(claimLossCorroborationsTable)
    .values({
      organizationId,
      caseId,
      canonicalGraphId: graph.id,
      version,
      status: "computed" satisfies ClaimCorroborationStatus,
      calculationVersion: bundle.assessment.rulesetVersion,
      sourceManifest: bundle.manifest as unknown as Record<string, unknown>,
      sourceManifestHash: bundle.manifestHash,
      assessment: bundle.assessment as unknown as Record<string, unknown>,
      assessmentHash: bundle.assessmentHash,
      createdByUserId: actorUserId,
    })
    .returning();
  await recordAudit({
    organizationId,
    actorUserId,
    action: "claim.loss_corroboration_computed",
    entityType: "claim_loss_corroboration",
    entityId: created.id,
    metadata: {
      caseId,
      graphId: graph.id,
      graphHash: graph.graphHash,
      sourceManifestHash: created.sourceManifestHash,
      assessmentHash: created.assessmentHash,
      state: bundle.assessment.breakdown.state,
      sourceCount: bundle.assessment.breakdown.sourceCount,
    },
  });
  return created;
}

export async function reviewLossCorroboration(
  organizationId: string,
  caseId: string,
  corroborationId: string,
  actorUserId: string,
  status: Exclude<ClaimCorroborationStatus, "computed">,
  reviewNote: string | null,
) {
  const [corroboration] = await db
    .select()
    .from(claimLossCorroborationsTable)
    .where(
      and(
        eq(claimLossCorroborationsTable.organizationId, organizationId),
        eq(claimLossCorroborationsTable.caseId, caseId),
        eq(claimLossCorroborationsTable.id, corroborationId),
      ),
    )
    .limit(1);
  if (!corroboration) throw new LossCorroborationError("Loss corroboration assessment not found.", 404);
  if (corroboration.status !== "computed") {
    throw new LossCorroborationError("A reviewed loss corroboration is immutable. Compute a new version to revise it.", 409);
  }
  const normalizedNote = reviewNote?.trim() || null;
  if (normalizedNote && normalizedNote.length > 2_000) {
    throw new LossCorroborationError("Review note must be 2,000 characters or fewer.");
  }
  const [reviewed] = await db
    .update(claimLossCorroborationsTable)
    .set({ status, reviewedByUserId: actorUserId, reviewedAt: new Date(), reviewNote: normalizedNote })
    .where(eq(claimLossCorroborationsTable.id, corroboration.id))
    .returning();
  await recordAudit({
    organizationId,
    actorUserId,
    action: status === "verified" ? "claim.loss_corroboration_verified" : "claim.loss_corroboration_rejected",
    entityType: "claim_loss_corroboration",
    entityId: reviewed.id,
    metadata: { caseId, assessmentHash: reviewed.assessmentHash, sourceManifestHash: reviewed.sourceManifestHash },
  });
  return reviewed;
}
