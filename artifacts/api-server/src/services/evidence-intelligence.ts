import { createHash } from "node:crypto";
import {
  claimCasesTable,
  claimCanonicalGraphsTable,
  claimCertificatesTable,
  claimEvidenceArtifactsTable,
  claimEvidenceRunsTable,
  claimLossCorroborationsTable,
  claimObservationsTable,
  claimRoutePacketsTable,
  db,
  estimatesTable,
  type CertificateFinding,
  type EvidenceArtifactKind,
  type ObservationStatus,
} from "@workspace/db";
import { and, asc, desc, eq } from "drizzle-orm";

import { recordAudit } from "./audit";
import {
  EVIDENCE_PROMPT_VERSION,
  runEvidenceAgent,
  type AgentEvidenceArtifact,
  type EvidenceDraft,
} from "./evidence-agent";
import { redactEvidenceText } from "./evidence-redaction";
import {
  buildCertificateIntegrityManifest,
  buildEvidenceManifest,
  CERTIFICATE_INTEGRITY_VERSION,
} from "./claim-kernel";

export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_EVIDENCE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "text/plain",
] as const;

export class EvidenceIntelligenceError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 | 503 = 400,
  ) {
    super(message);
  }
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function withoutBlob<T extends { blob: Buffer | null }>(artifact: T): Omit<T, "blob"> {
  const { blob: _blob, ...safe } = artifact;
  return safe;
}

async function requireCase(organizationId: string, caseId: string) {
  const [claimCase] = await db
    .select()
    .from(claimCasesTable)
    .where(and(eq(claimCasesTable.organizationId, organizationId), eq(claimCasesTable.id, caseId)))
    .limit(1);
  if (!claimCase) throw new EvidenceIntelligenceError("Evidence case not found.", 404);
  return claimCase;
}

export async function listEvidenceCases(organizationId: string) {
  return db
    .select()
    .from(claimCasesTable)
    .where(eq(claimCasesTable.organizationId, organizationId))
    .orderBy(desc(claimCasesTable.updatedAt));
}

export async function createEvidenceCase(
  organizationId: string,
  actorUserId: string,
  input: {
    title: string;
    lossType?: string | null;
    lossDate?: Date | null;
    description?: string | null;
    leadId?: string | null;
    propertyId?: string | null;
  },
) {
  const [created] = await db
    .insert(claimCasesTable)
    .values({
      organizationId,
      title: input.title.trim(),
      lossType: input.lossType?.trim() || null,
      lossDate: input.lossDate ?? null,
      description: input.description?.trim() || null,
      leadId: input.leadId ?? null,
      propertyId: input.propertyId ?? null,
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
    })
    .returning();

  await recordAudit({
    organizationId,
    actorUserId,
    action: "evidence.case_created",
    entityType: "claim_case",
    entityId: created.id,
  });
  return created;
}

export async function getEvidenceCase(organizationId: string, caseId: string) {
  const claimCase = await requireCase(organizationId, caseId);
  const [artifacts, runs, observations, certificates, graphs, corroborations, routePackets, eligibleEstimates] = await Promise.all([
    db
      .select()
      .from(claimEvidenceArtifactsTable)
      .where(
        and(
          eq(claimEvidenceArtifactsTable.organizationId, organizationId),
          eq(claimEvidenceArtifactsTable.caseId, caseId),
        ),
      )
      .orderBy(desc(claimEvidenceArtifactsTable.createdAt)),
    db
      .select()
      .from(claimEvidenceRunsTable)
      .where(
        and(
          eq(claimEvidenceRunsTable.organizationId, organizationId),
          eq(claimEvidenceRunsTable.caseId, caseId),
        ),
      )
      .orderBy(desc(claimEvidenceRunsTable.startedAt)),
    db
      .select()
      .from(claimObservationsTable)
      .where(
        and(
          eq(claimObservationsTable.organizationId, organizationId),
          eq(claimObservationsTable.caseId, caseId),
        ),
      )
      .orderBy(desc(claimObservationsTable.createdAt)),
    db
      .select()
      .from(claimCertificatesTable)
      .where(
        and(
          eq(claimCertificatesTable.organizationId, organizationId),
          eq(claimCertificatesTable.caseId, caseId),
        ),
      )
      .orderBy(desc(claimCertificatesTable.version)),
    db
      .select()
      .from(claimCanonicalGraphsTable)
      .where(
        and(
          eq(claimCanonicalGraphsTable.organizationId, organizationId),
          eq(claimCanonicalGraphsTable.caseId, caseId),
        ),
      )
      .orderBy(desc(claimCanonicalGraphsTable.version)),
    db
      .select()
      .from(claimLossCorroborationsTable)
      .where(
        and(
          eq(claimLossCorroborationsTable.organizationId, organizationId),
          eq(claimLossCorroborationsTable.caseId, caseId),
        ),
      )
      .orderBy(desc(claimLossCorroborationsTable.version)),
    db
      .select()
      .from(claimRoutePacketsTable)
      .where(
        and(
          eq(claimRoutePacketsTable.organizationId, organizationId),
          eq(claimRoutePacketsTable.caseId, caseId),
        ),
      )
      .orderBy(desc(claimRoutePacketsTable.version)),
    claimCase.leadId
      ? db
          .select()
          .from(estimatesTable)
          .where(
            and(
              eq(estimatesTable.organizationId, organizationId),
              eq(estimatesTable.leadId, claimCase.leadId),
            ),
          )
          .orderBy(desc(estimatesTable.updatedAt))
      : Promise.resolve([]),
  ]);

  return {
    case: claimCase,
    artifacts: artifacts.map(withoutBlob),
    runs,
    observations,
    certificates,
    graphs,
    corroborations,
    routePackets,
    eligibleEstimates,
    policy: {
      aiDraftOnly: true,
      humanIssuanceRequired: true,
      allArtifactsRequireApproval: true,
    },
  };
}

export async function addEvidenceArtifact(
  organizationId: string,
  caseId: string,
  actorUserId: string,
  input: {
    kind: EvidenceArtifactKind;
    filename: string;
    mimeType: (typeof ALLOWED_EVIDENCE_MIME_TYPES)[number];
    data: Buffer;
    sourceLabel?: string | null;
    approveForAi: boolean;
  },
) {
  await requireCase(organizationId, caseId);
  if (input.data.byteLength === 0) throw new EvidenceIntelligenceError("Evidence cannot be empty.");
  if (input.data.byteLength > MAX_EVIDENCE_BYTES) {
    throw new EvidenceIntelligenceError("Evidence files must be 5MB or smaller.");
  }

  const digest = sha256(input.data);
  const [duplicate] = await db
    .select({ id: claimEvidenceArtifactsTable.id })
    .from(claimEvidenceArtifactsTable)
    .where(
      and(
        eq(claimEvidenceArtifactsTable.organizationId, organizationId),
        eq(claimEvidenceArtifactsTable.caseId, caseId),
        eq(claimEvidenceArtifactsTable.sha256, digest),
      ),
    )
    .limit(1);
  if (duplicate) throw new EvidenceIntelligenceError("That exact evidence artifact is already in this case.", 409);

  const isText = input.mimeType === "text/plain";
  const redaction = isText ? redactEvidenceText(input.data.toString("utf8")) : null;
  const now = input.approveForAi ? new Date() : null;
  const [created] = await db
    .insert(claimEvidenceArtifactsTable)
    .values({
      organizationId,
      caseId,
      kind: input.kind,
      filename: input.filename.replace(/^.*[\\/]/, "").slice(0, 240) || "evidence",
      mimeType: input.mimeType,
      sizeBytes: input.data.byteLength,
      sha256: digest,
      blob: input.data,
      redactedText: redaction?.text ?? null,
      sourceLabel: input.sourceLabel?.trim().slice(0, 240) || null,
      aiUseApprovedAt: now,
      aiUseApprovedByUserId: now ? actorUserId : null,
      createdByUserId: actorUserId,
    })
    .returning();

  await recordAudit({
    organizationId,
    actorUserId,
    action: "evidence.artifact_added",
    entityType: "claim_evidence_artifact",
    entityId: created.id,
    metadata: {
      caseId,
      kind: created.kind,
      mimeType: created.mimeType,
      sizeBytes: created.sizeBytes,
      sha256: created.sha256,
      aiUseApproved: Boolean(created.aiUseApprovedAt),
      redactions: redaction?.counts ?? {},
    },
  });
  return withoutBlob(created);
}

export async function getEvidenceArtifactContent(
  organizationId: string,
  caseId: string,
  artifactId: string,
) {
  const [artifact] = await db
    .select()
    .from(claimEvidenceArtifactsTable)
    .where(
      and(
        eq(claimEvidenceArtifactsTable.organizationId, organizationId),
        eq(claimEvidenceArtifactsTable.caseId, caseId),
        eq(claimEvidenceArtifactsTable.id, artifactId),
      ),
    )
    .limit(1);
  if (!artifact?.blob) throw new EvidenceIntelligenceError("Evidence artifact not found.", 404);
  return artifact;
}

function buildCaseSummary(claimCase: Awaited<ReturnType<typeof requireCase>>): string {
  return [
    `Title: ${claimCase.title}`,
    `Loss type: ${claimCase.lossType ?? "not supplied"}`,
    `Loss date: ${claimCase.lossDate?.toISOString() ?? "not supplied"}`,
    `Operator description: ${claimCase.description ?? "not supplied"}`,
  ].join("\n");
}

export function mapAndValidateDraft(
  draft: EvidenceDraft,
  aliases: Map<string, string>,
): EvidenceDraft & { findings: CertificateFinding[] } {
  const mapAlias = (alias: string) => {
    const artifactId = aliases.get(alias);
    if (!artifactId) {
      throw new EvidenceIntelligenceError(`AI draft cited unknown evidence alias ${alias}.`, 409);
    }
    return artifactId;
  };

  return {
    ...draft,
    findings: draft.findings.map((finding) => ({
      ...finding,
      citations: finding.citations.map((citation) => ({
        ...citation,
        artifactId: mapAlias(citation.artifactId),
      })),
    })),
    conflicts: draft.conflicts.map((conflict) => ({
      ...conflict,
      artifactIds: conflict.artifactIds.map(mapAlias),
    })),
  };
}

export function evaluateIssueReadiness(
  observations: Array<{ status: ObservationStatus }>,
): { ready: boolean; reason: string | null } {
  if (observations.length === 0) {
    return { ready: false, reason: "A certificate needs at least one evidence observation." };
  }
  if (observations.some((observation) => observation.status === "ai_draft")) {
    return { ready: false, reason: "Review every AI observation before issuing the certificate." };
  }
  if (!observations.some((observation) => observation.status === "verified")) {
    return { ready: false, reason: "At least one observation must be verified before issuance." };
  }
  return { ready: true, reason: null };
}

function draftContentHash(draft: ReturnType<typeof mapAndValidateDraft>): string {
  return sha256(
    JSON.stringify({
      executiveSummary: draft.executiveSummary,
      findings: draft.findings,
      conflicts: draft.conflicts,
      gaps: draft.gaps,
      limitations: draft.limitations,
      recommendedNextSteps: draft.recommendedNextSteps,
    }),
  );
}

function certificateIntegrityFor(input: {
  certificate: {
    id: string | null;
    version: number;
    status: "draft" | "issued";
    contentHash: string;
  };
  claimCase: Awaited<ReturnType<typeof requireCase>>;
  run: {
    id: string;
    manifestHash: string;
    promptVersion: string;
    model: string;
  };
  observations: Array<{
    id: string;
    artifactId: string | null;
    category: string;
    statement: string;
    locator: string | null;
    basis: string | null;
    confidence: number;
    needsHumanReview: boolean;
    status: ObservationStatus;
    reviewedByUserId: string | null;
    reviewedAt: Date | null;
  }>;
}) {
  return buildCertificateIntegrityManifest({
    certificate: input.certificate,
    claim: {
      id: input.claimCase.id,
      lossType: input.claimCase.lossType,
      lossDate: input.claimCase.lossDate?.toISOString() ?? null,
    },
    evidenceRun: input.run,
    observations: input.observations,
  });
}

export async function analyzeEvidenceCase(
  organizationId: string,
  caseId: string,
  actorUserId: string,
) {
  const claimCase = await requireCase(organizationId, caseId);
  const artifacts = await db
    .select()
    .from(claimEvidenceArtifactsTable)
    .where(
      and(
        eq(claimEvidenceArtifactsTable.organizationId, organizationId),
        eq(claimEvidenceArtifactsTable.caseId, caseId),
      ),
    )
    .orderBy(asc(claimEvidenceArtifactsTable.createdAt), asc(claimEvidenceArtifactsTable.id));

  if (artifacts.length === 0) throw new EvidenceIntelligenceError("Add evidence before running analysis.", 409);
  const unapproved = artifacts.filter((artifact) => !artifact.aiUseApprovedAt);
  if (unapproved.length > 0) {
    throw new EvidenceIntelligenceError(
      `${unapproved.length} artifact${unapproved.length === 1 ? " is" : "s are"} not approved for AI use.`,
      409,
    );
  }

  const { manifest, digest: manifestHash, aliases } = buildEvidenceManifest(artifacts);
  const agentArtifacts: AgentEvidenceArtifact[] = artifacts.map((artifact, index) => {
    const alias = manifest.artifacts[index]!.alias;
    return {
      alias,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      sha256: artifact.sha256,
      sourceLabel: artifact.sourceLabel,
      redactedText: artifact.redactedText,
      blob: artifact.redactedText === null ? artifact.blob : null,
    };
  });

  const model = process.env.OPENAI_EVIDENCE_MODEL?.trim() || "gpt-5.6-sol";
  const [run] = await db
    .insert(claimEvidenceRunsTable)
    .values({
      organizationId,
      caseId,
      model,
      promptVersion: EVIDENCE_PROMPT_VERSION,
      manifest: manifest as unknown as Record<string, unknown>,
      manifestHash,
      initiatedByUserId: actorUserId,
    })
    .returning();

  await db
    .update(claimCasesTable)
    .set({ status: "analyzing", updatedByUserId: actorUserId })
    .where(and(eq(claimCasesTable.organizationId, organizationId), eq(claimCasesTable.id, caseId)));

  try {
    const result = await runEvidenceAgent({
      organizationId,
      caseSummary: buildCaseSummary(claimCase),
      artifacts: agentArtifacts,
    });
    const draft = mapAndValidateDraft(result.draft, aliases);
    const [latestCertificate] = await db
      .select({ version: claimCertificatesTable.version })
      .from(claimCertificatesTable)
      .where(
        and(
          eq(claimCertificatesTable.organizationId, organizationId),
          eq(claimCertificatesTable.caseId, caseId),
        ),
      )
      .orderBy(desc(claimCertificatesTable.version))
      .limit(1);
    const version = (latestCertificate?.version ?? 0) + 1;

    const certificate = await db.transaction(async (tx) => {
      await tx
        .update(claimCertificatesTable)
        .set({ status: "superseded" })
        .where(
          and(
            eq(claimCertificatesTable.organizationId, organizationId),
            eq(claimCertificatesTable.caseId, caseId),
            eq(claimCertificatesTable.status, "draft"),
          ),
        );

      const observations =
        draft.findings.length > 0
          ? await tx
              .insert(claimObservationsTable)
              .values(
                draft.findings.map((finding) => ({
                  organizationId,
                  caseId,
                  runId: run.id,
                  artifactId: finding.citations[0]?.artifactId ?? null,
                  category: finding.category,
                  statement: finding.statement,
                  locator: finding.citations[0]?.locator ?? null,
                  basis: finding.citations[0]?.basis ?? null,
                  confidence: finding.confidence,
                  needsHumanReview: finding.needsHumanReview,
                })),
              )
              .returning()
          : [];

      const contentHash = draftContentHash(draft);
      const [inserted] = await tx
        .insert(claimCertificatesTable)
        .values({
          organizationId,
          caseId,
          runId: run.id,
          version,
          executiveSummary: draft.executiveSummary,
          findings: draft.findings,
          conflicts: draft.conflicts,
          gaps: draft.gaps,
          limitations: draft.limitations,
          recommendedNextSteps: draft.recommendedNextSteps,
          contentHash,
          integrityVersion: CERTIFICATE_INTEGRITY_VERSION,
          modelDetails: {
            model: result.model,
            promptVersion: EVIDENCE_PROMPT_VERSION,
            responseId: result.responseId,
          },
          createdByUserId: actorUserId,
        })
        .returning();

      const integrity = certificateIntegrityFor({
        certificate: {
          id: inserted.id,
          version,
          status: "draft",
          contentHash,
        },
        claimCase,
        run,
        observations,
      });
      const [boundCertificate] = await tx
        .update(claimCertificatesTable)
        .set({
          integrityVersion: CERTIFICATE_INTEGRITY_VERSION,
          integrityManifest: integrity.manifest as unknown as Record<string, unknown>,
          integrityHash: integrity.digest,
        })
        .where(eq(claimCertificatesTable.id, inserted.id))
        .returning();
      if (!boundCertificate) throw new EvidenceIntelligenceError("Certificate integrity binding failed.", 503);

      await tx
        .update(claimEvidenceRunsTable)
        .set({
          status: "completed",
          traceId: result.responseId,
          usage: result.usage,
          completedAt: new Date(),
        })
        .where(
          and(eq(claimEvidenceRunsTable.organizationId, organizationId), eq(claimEvidenceRunsTable.id, run.id)),
        );
      await tx
        .update(claimCasesTable)
        .set({ status: "review", updatedByUserId: actorUserId })
        .where(and(eq(claimCasesTable.organizationId, organizationId), eq(claimCasesTable.id, caseId)));
      return boundCertificate;
    });

    await recordAudit({
      organizationId,
      actorUserId,
      action: "evidence.analysis_completed",
      entityType: "claim_evidence_run",
      entityId: run.id,
      metadata: {
        caseId,
        certificateId: certificate.id,
        artifactCount: artifacts.length,
        findingCount: draft.findings.length,
        model: result.model,
        promptVersion: EVIDENCE_PROMPT_VERSION,
      },
    });
    return getEvidenceCase(organizationId, caseId);
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 1000) : "Evidence analysis failed.";
    await Promise.all([
      db
        .update(claimEvidenceRunsTable)
        .set({ status: "failed", error: detail, completedAt: new Date() })
        .where(
          and(eq(claimEvidenceRunsTable.organizationId, organizationId), eq(claimEvidenceRunsTable.id, run.id)),
        ),
      db
        .update(claimCasesTable)
        .set({ status: claimCase.status === "issued" ? "issued" : "open", updatedByUserId: actorUserId })
        .where(and(eq(claimCasesTable.organizationId, organizationId), eq(claimCasesTable.id, caseId))),
    ]);
    await recordAudit({
      organizationId,
      actorUserId,
      action: "evidence.analysis_failed",
      entityType: "claim_evidence_run",
      entityId: run.id,
      metadata: { caseId, detail },
    });
    if (error instanceof EvidenceIntelligenceError) throw error;
    throw new EvidenceIntelligenceError(detail, 503);
  }
}

export async function reviewEvidenceObservation(
  organizationId: string,
  caseId: string,
  observationId: string,
  actorUserId: string,
  status: Exclude<ObservationStatus, "ai_draft">,
) {
  const claimCase = await requireCase(organizationId, caseId);
  if (claimCase.status === "issued") {
    throw new EvidenceIntelligenceError("Issued evidence is immutable. Run a new analysis to create a new version.", 409);
  }
  const [updated] = await db
    .update(claimObservationsTable)
    .set({ status, reviewedAt: new Date(), reviewedByUserId: actorUserId })
    .where(
      and(
        eq(claimObservationsTable.organizationId, organizationId),
        eq(claimObservationsTable.caseId, caseId),
        eq(claimObservationsTable.id, observationId),
      ),
    )
    .returning();
  if (!updated) throw new EvidenceIntelligenceError("Evidence observation not found.", 404);

  await recordAudit({
    organizationId,
    actorUserId,
    action: status === "verified" ? "evidence.observation_verified" : "evidence.observation_rejected",
    entityType: "claim_observation",
    entityId: updated.id,
    metadata: { caseId, runId: updated.runId },
  });
  return updated;
}

export async function issueEvidenceCertificate(
  organizationId: string,
  caseId: string,
  certificateId: string,
  actorUserId: string,
) {
  const claimCase = await requireCase(organizationId, caseId);
  const [certificate] = await db
    .select()
    .from(claimCertificatesTable)
    .where(
      and(
        eq(claimCertificatesTable.organizationId, organizationId),
        eq(claimCertificatesTable.caseId, caseId),
        eq(claimCertificatesTable.id, certificateId),
      ),
    )
    .limit(1);
  if (!certificate) throw new EvidenceIntelligenceError("Evidence certificate not found.", 404);
  if (certificate.status !== "draft") {
    throw new EvidenceIntelligenceError("Only the current draft can be issued.", 409);
  }

  const observations = await db
    .select()
    .from(claimObservationsTable)
    .where(
      and(
        eq(claimObservationsTable.organizationId, organizationId),
        eq(claimObservationsTable.caseId, caseId),
        eq(claimObservationsTable.runId, certificate.runId),
      ),
    );
  const readiness = evaluateIssueReadiness(observations);
  if (!readiness.ready) throw new EvidenceIntelligenceError(readiness.reason!, 409);

  const [run] = await db
    .select()
    .from(claimEvidenceRunsTable)
    .where(
      and(
        eq(claimEvidenceRunsTable.organizationId, organizationId),
        eq(claimEvidenceRunsTable.caseId, caseId),
        eq(claimEvidenceRunsTable.id, certificate.runId),
      ),
    )
    .limit(1);
  if (!run?.manifestHash) {
    throw new EvidenceIntelligenceError(
      "This legacy evidence run has no frozen manifest. Run a new analysis before issuing a certificate.",
      409,
    );
  }

  const integrity = certificateIntegrityFor({
    certificate: {
      id: certificate.id,
      version: certificate.version,
      status: "issued",
      contentHash: certificate.contentHash,
    },
    claimCase,
    run,
    observations,
  });

  const now = new Date();
  const [issued] = await db.transaction(async (tx) => {
    await tx
      .update(claimCertificatesTable)
      .set({ status: "superseded" })
      .where(
        and(
          eq(claimCertificatesTable.organizationId, organizationId),
          eq(claimCertificatesTable.caseId, caseId),
          eq(claimCertificatesTable.status, "issued"),
        ),
      );
    const rows = await tx
      .update(claimCertificatesTable)
      .set({
        status: "issued",
        issuedAt: now,
        issuedByUserId: actorUserId,
        integrityVersion: CERTIFICATE_INTEGRITY_VERSION,
        integrityManifest: integrity.manifest as unknown as Record<string, unknown>,
        integrityHash: integrity.digest,
      })
      .where(
        and(
          eq(claimCertificatesTable.organizationId, organizationId),
          eq(claimCertificatesTable.caseId, caseId),
          eq(claimCertificatesTable.id, certificateId),
          eq(claimCertificatesTable.status, "draft"),
        ),
      )
      .returning();
    if (!rows[0]) {
      // Throw inside the transaction so a concurrent request cannot
      // supersede the previously issued certificate and then commit no new one.
      throw new EvidenceIntelligenceError("Certificate issuance conflicted with another update.", 409);
    }
    await tx
      .update(claimCasesTable)
      .set({ status: "issued", updatedByUserId: actorUserId })
      .where(and(eq(claimCasesTable.organizationId, organizationId), eq(claimCasesTable.id, caseId)));
    return rows;
  });
  await recordAudit({
    organizationId,
    actorUserId,
    action: "evidence.certificate_issued",
    entityType: "claim_certificate",
    entityId: issued.id,
    metadata: {
      caseId,
      version: issued.version,
      contentHash: issued.contentHash,
      integrityHash: issued.integrityHash,
      manifestHash: run.manifestHash,
    },
  });
  return issued;
}

export function validateArtifactKind(value: unknown): value is EvidenceArtifactKind {
  return ["photo", "document", "note", "weather", "property", "other"].includes(String(value));
}

export function validateEvidenceMimeType(
  value: unknown,
): value is (typeof ALLOWED_EVIDENCE_MIME_TYPES)[number] {
  return ALLOWED_EVIDENCE_MIME_TYPES.includes(value as (typeof ALLOWED_EVIDENCE_MIME_TYPES)[number]);
}
