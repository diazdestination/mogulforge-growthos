import {
  claimCasesTable,
  claimCertificatesTable,
  claimExecutionReceiptsTable,
  claimLossCorroborationsTable,
  claimRoutePacketsTable,
  db,
  type ClaimExecutionReceiptState,
  type ClaimRoutePacketStatus,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";

import { recordAudit } from "./audit";
import {
  buildRoutePacket,
  canTransitionExecutionState,
  evaluateRoutePreflight,
  sha256Canonical,
  type RoutePacket,
} from "./claim-kernel";

export class ClaimExecutionError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

export type CompileRouteInput = {
  certificateId: string;
  corroborationId?: string;
  target: string;
  operation: string;
  adapterName: string;
  adapterVersion: string;
  adapterFingerprint: string;
  postconditions: Array<{ code: string; description: string }>;
  capabilityRequirements: string[];
  maxExternalWrites?: number;
  maxAttempts?: number;
};

async function requireCase(organizationId: string, caseId: string) {
  const [claimCase] = await db
    .select()
    .from(claimCasesTable)
    .where(and(eq(claimCasesTable.organizationId, organizationId), eq(claimCasesTable.id, caseId)))
    .limit(1);
  if (!claimCase) throw new ClaimExecutionError("Claim case not found.", 404);
  return claimCase;
}

async function requireRoutePacket(organizationId: string, caseId: string, routePacketId: string) {
  const [routePacket] = await db
    .select()
    .from(claimRoutePacketsTable)
    .where(
      and(
        eq(claimRoutePacketsTable.organizationId, organizationId),
        eq(claimRoutePacketsTable.caseId, caseId),
        eq(claimRoutePacketsTable.id, routePacketId),
      ),
    )
    .limit(1);
  if (!routePacket) throw new ClaimExecutionError("Route packet not found.", 404);
  return routePacket;
}

function readReviewPolicy(value: Record<string, unknown>): { allObservationsReviewed: boolean; verifiedObservationCount: number } {
  const policy = value.policy;
  if (!policy || typeof policy !== "object") return { allObservationsReviewed: false, verifiedObservationCount: 0 };
  const record = policy as Record<string, unknown>;
  return {
    allObservationsReviewed: record.allObservationsReviewed === true,
    verifiedObservationCount:
      typeof record.verifiedObservationCount === "number" && Number.isFinite(record.verifiedObservationCount)
        ? record.verifiedObservationCount
        : 0,
  };
}

function asRoutePacket(value: Record<string, unknown>): RoutePacket {
  const packet = value as unknown as RoutePacket;
  if (!packet?.certificateIntegrityHash || !packet?.adapter?.fingerprint || !Array.isArray(packet.preconditions)) {
    throw new ClaimExecutionError("Route packet is malformed and cannot be executed.", 409);
  }
  return packet;
}

export async function listClaimRoutePackets(organizationId: string, caseId: string) {
  await requireCase(organizationId, caseId);
  return db
    .select()
    .from(claimRoutePacketsTable)
    .where(and(eq(claimRoutePacketsTable.organizationId, organizationId), eq(claimRoutePacketsTable.caseId, caseId)))
    .orderBy(desc(claimRoutePacketsTable.version));
}

/**
 * Compiles an issued, integrity-bound certificate into a non-executing route
 * packet. The packet is immutable evidence of the exact target constraints a
 * future executor must satisfy.
 */
export async function compileClaimRoutePacket(
  organizationId: string,
  caseId: string,
  actorUserId: string,
  input: CompileRouteInput,
) {
  await requireCase(organizationId, caseId);
  const [certificate] = await db
    .select()
    .from(claimCertificatesTable)
    .where(
      and(
        eq(claimCertificatesTable.organizationId, organizationId),
        eq(claimCertificatesTable.caseId, caseId),
        eq(claimCertificatesTable.id, input.certificateId),
      ),
    )
    .limit(1);
  if (!certificate) throw new ClaimExecutionError("Evidence certificate not found.", 404);
  if (certificate.status !== "issued") {
    throw new ClaimExecutionError("Only an issued Loss Evidence Certificate can compile a route packet.", 409);
  }
  if (!/^[a-f0-9]{64}$/i.test(certificate.integrityHash)) {
    throw new ClaimExecutionError("This certificate lacks a verifiable integrity package. Reissue from a current evidence run.", 409);
  }
  const policy = readReviewPolicy(certificate.integrityManifest);
  if (!policy.allObservationsReviewed || policy.verifiedObservationCount < 1) {
    throw new ClaimExecutionError("Certificate review policy is not satisfied for execution.", 409);
  }
  const corroboration = input.corroborationId
    ? (
        await db
          .select()
          .from(claimLossCorroborationsTable)
          .where(
            and(
              eq(claimLossCorroborationsTable.organizationId, organizationId),
              eq(claimLossCorroborationsTable.caseId, caseId),
              eq(claimLossCorroborationsTable.id, input.corroborationId),
            ),
          )
          .limit(1)
      )[0]
    : null;
  if (input.corroborationId && !corroboration) {
    throw new ClaimExecutionError("Loss corroboration assessment not found.", 404);
  }
  if (corroboration && (corroboration.status !== "verified" || !/^[a-f0-9]{64}$/i.test(corroboration.assessmentHash))) {
    throw new ClaimExecutionError("Only a human-verified, integrity-bound loss corroboration may become a route precondition.", 409);
  }

  const [latest] = await db
    .select({ version: claimRoutePacketsTable.version })
    .from(claimRoutePacketsTable)
    .where(and(eq(claimRoutePacketsTable.organizationId, organizationId), eq(claimRoutePacketsTable.caseId, caseId)))
    .orderBy(desc(claimRoutePacketsTable.version))
    .limit(1);
  const version = (latest?.version ?? 0) + 1;
  let compiled: ReturnType<typeof buildRoutePacket>;
  try {
    compiled = buildRoutePacket({
      claimId: caseId,
      certificateId: certificate.id,
      certificateIntegrityHash: certificate.integrityHash,
      corroborationId: corroboration?.id,
      corroborationAssessmentHash: corroboration?.assessmentHash,
      routeVersion: version,
      target: input.target,
      operation: input.operation,
      adapterName: input.adapterName,
      adapterVersion: input.adapterVersion,
      adapterFingerprint: input.adapterFingerprint,
      postconditions: input.postconditions,
      capabilityRequirements: input.capabilityRequirements,
      maxExternalWrites: input.maxExternalWrites ?? 1,
      maxAttempts: input.maxAttempts ?? 1,
    });
  } catch (error) {
    throw new ClaimExecutionError(error instanceof Error ? error.message : "Route packet could not be compiled.");
  }

  const [created] = await db
    .insert(claimRoutePacketsTable)
    .values({
      organizationId,
      caseId,
      certificateId: certificate.id,
      corroborationId: corroboration?.id ?? null,
      version,
      target: compiled.packet.target,
      operation: compiled.packet.operation,
      adapterName: compiled.packet.adapter.name,
      adapterVersion: compiled.packet.adapter.version,
      adapterFingerprint: compiled.packet.adapter.fingerprint,
      certificateIntegrityHash: certificate.integrityHash,
      idempotencyKey: compiled.packet.idempotencyKey,
      packet: compiled.packet as unknown as Record<string, unknown>,
      packetHash: compiled.digest,
      sideEffectBudget: compiled.packet.sideEffectBudget,
      createdByUserId: actorUserId,
    })
    .returning();

  await recordAudit({
    organizationId,
    actorUserId,
    action: "claim.route_packet_compiled",
    entityType: "claim_route_packet",
    entityId: created.id,
    metadata: {
      caseId,
      certificateId: certificate.id,
      packetHash: created.packetHash,
      certificateIntegrityHash: certificate.integrityHash,
      corroborationId: corroboration?.id ?? null,
      target: created.target,
      operation: created.operation,
      adapterFingerprint: created.adapterFingerprint,
    },
  });
  return created;
}

export async function preflightClaimRoutePacket(
  organizationId: string,
  caseId: string,
  routePacketId: string,
  activeAdapterFingerprint: string | null,
) {
  const routePacket = await requireRoutePacket(organizationId, caseId, routePacketId);
  const [certificate] = await db
    .select()
    .from(claimCertificatesTable)
    .where(
      and(
        eq(claimCertificatesTable.organizationId, organizationId),
        eq(claimCertificatesTable.caseId, caseId),
        eq(claimCertificatesTable.id, routePacket.certificateId),
      ),
    )
    .limit(1);
  if (!certificate) throw new ClaimExecutionError("Route packet certificate is missing.", 409);
  const corroboration = routePacket.corroborationId
    ? (
        await db
          .select()
          .from(claimLossCorroborationsTable)
          .where(
            and(
              eq(claimLossCorroborationsTable.organizationId, organizationId),
              eq(claimLossCorroborationsTable.caseId, caseId),
              eq(claimLossCorroborationsTable.id, routePacket.corroborationId),
            ),
          )
          .limit(1)
      )[0] ?? null
    : null;

  const packet = asRoutePacket(routePacket.packet);
  const policy = readReviewPolicy(certificate.integrityManifest);
  const result = evaluateRoutePreflight({
    certificateIssued: certificate.status === "issued",
    certificateIntegrityHash: certificate.integrityHash || null,
    packet,
    allObservationsReviewed: policy.allObservationsReviewed,
    verifiedObservationCount: policy.verifiedObservationCount,
    corroborationVerified: corroboration?.status === "verified",
    corroborationAssessmentHash: corroboration?.assessmentHash ?? null,
    adapterFingerprint: activeAdapterFingerprint,
  });
  return { routePacket, ...result };
}

/**
 * Reserves the single permitted attempt only after an executor has supplied a
 * successful preflight result. No browser or provider interaction occurs here.
 */
export async function prepareClaimRouteExecution(
  organizationId: string,
  caseId: string,
  routePacketId: string,
  actorUserId: string,
  activeAdapterFingerprint: string,
) {
  const preflight = await preflightClaimRoutePacket(organizationId, caseId, routePacketId, activeAdapterFingerprint);
  if (!preflight.allowed) throw new ClaimExecutionError("Route packet preconditions are not satisfied.", 409);
  if (preflight.routePacket.status !== "ready") {
    throw new ClaimExecutionError("This route packet is no longer eligible for a new execution attempt.", 409);
  }

  const preparedAt = new Date().toISOString();
  const receipt = {
    routePacketId,
    packetHash: preflight.routePacket.packetHash,
    certificateIntegrityHash: preflight.routePacket.certificateIntegrityHash,
    state: "prepared" as const,
    preparedAt,
    preflight: preflight.checks,
  };
  const receiptHash = sha256Canonical(receipt);
  const [prepared] = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(claimRoutePacketsTable)
      .set({ status: "executing" satisfies ClaimRoutePacketStatus })
      .where(
        and(
          eq(claimRoutePacketsTable.id, routePacketId),
          eq(claimRoutePacketsTable.organizationId, organizationId),
          eq(claimRoutePacketsTable.status, "ready"),
        ),
      )
      .returning();
    if (!updated) throw new ClaimExecutionError("Route packet was claimed by another executor or changed state.", 409);
    return tx
      .insert(claimExecutionReceiptsTable)
      .values({
        organizationId,
        caseId,
        routePacketId,
        attempt: 1,
        state: "prepared" satisfies ClaimExecutionReceiptState,
        receipt,
        receiptHash,
      })
      .returning();
  });
  await recordAudit({
    organizationId,
    actorUserId,
    action: "claim.route_execution_prepared",
    entityType: "claim_execution_receipt",
    entityId: prepared.id,
    metadata: { caseId, routePacketId, receiptHash },
  });
  return prepared;
}

/**
 * This transition guard is used by future target adapters. An indeterminate
 * write cannot transition back to prepared or retry; it can only be
 * reconciled using target-side evidence.
 */
export function assertExecutionStateTransition(from: ClaimExecutionReceiptState, to: ClaimExecutionReceiptState): void {
  if (!canTransitionExecutionState(from, to)) {
    throw new ClaimExecutionError(`Execution state cannot transition from ${from} to ${to}.`, 409);
  }
}
