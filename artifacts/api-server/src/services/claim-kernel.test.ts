import { describe, expect, it } from "vitest";

import {
  buildCertificateIntegrityManifest,
  buildEvidenceManifest,
  buildRoutePacket,
  canTransitionExecutionState,
  canonicalJson,
  evaluateRoutePreflight,
  sha256Canonical,
} from "./claim-kernel";

const artifact = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "photo",
  filename: "north-slope.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 1024,
  sha256: "a".repeat(64),
  sourceLabel: "Contractor field photo",
  aiUseApprovedAt: "2026-08-06T12:00:00.000Z",
  createdAt: "2026-08-06T11:00:00.000Z",
};

const integrityHash = "b".repeat(64);

describe("MogulForge Claim Kernel", () => {
  it("produces identical canonical bytes and digests regardless of object key order", () => {
    const first = { z: [3, { b: true, a: "value" }], a: 1 };
    const second = { a: 1, z: [3, { a: "value", b: true }] };
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(sha256Canonical(first)).toBe(sha256Canonical(second));
  });

  it("freezes approved artifacts into a run-local manifest with stable aliases", () => {
    const result = buildEvidenceManifest([artifact, { ...artifact, id: "00000000-0000-4000-8000-000000000002", sha256: "c".repeat(64) }]);
    expect(result.manifest.artifacts.map((item) => item.alias)).toEqual(["E1", "E2"]);
    expect(result.aliases.get("E2")).toBe("00000000-0000-4000-8000-000000000002");
    expect(result.digest).toHaveLength(64);
  });

  it("refuses unapproved evidence before a manifest can reach AI", () => {
    expect(() => buildEvidenceManifest([{ ...artifact, aiUseApprovedAt: null }])).toThrow(
      "not approved for AI use",
    );
  });

  it("binds human review decisions into the certificate digest deterministically", () => {
    const base = {
      certificate: { id: "certificate-1", version: 1, status: "issued" as const, contentHash: "d".repeat(64) },
      claim: { id: "claim-1", lossType: "hail", lossDate: "2026-08-01T00:00:00.000Z" },
      evidenceRun: { id: "run-1", manifestHash: "e".repeat(64), promptVersion: "prompt-v1", model: "test-model" },
    };
    const verified = {
      id: "observation-b",
      artifactId: artifact.id,
      category: "Exterior",
      statement: "Lifted shingle tab observed.",
      locator: "north slope",
      basis: "visible tab edge",
      confidence: 88,
      needsHumanReview: true,
      status: "verified" as const,
      reviewedByUserId: "user-1",
      reviewedAt: "2026-08-06T13:00:00.000Z",
    };
    const rejected = { ...verified, id: "observation-a", status: "rejected" as const, reviewedByUserId: "user-2" };
    const first = buildCertificateIntegrityManifest({ ...base, observations: [verified, rejected] });
    const reordered = buildCertificateIntegrityManifest({ ...base, observations: [rejected, verified] });
    const altered = buildCertificateIntegrityManifest({ ...base, observations: [{ ...verified, status: "rejected" }] });

    expect(first.digest).toBe(reordered.digest);
    expect(first.manifest.policy).toMatchObject({ allObservationsReviewed: true, verifiedObservationCount: 1 });
    expect(first.digest).not.toBe(altered.digest);
  });

  it("compiles a single-attempt constraint packet and blocks a stale certificate during preflight", () => {
    const { packet, digest } = buildRoutePacket({
      claimId: "claim-1",
      certificateId: "certificate-1",
      certificateIntegrityHash: integrityHash,
      routeVersion: 1,
      target: "carrier-portal",
      operation: "submit-claim-package",
      adapterName: "carrier-portal",
      adapterVersion: "1.0.0",
      adapterFingerprint: "adapter-sha256-1",
      postconditions: [{ code: "confirmation-number", description: "A target confirmation number is captured." }],
      capabilityRequirements: ["carrier:write:claim"],
      maxExternalWrites: 1,
      maxAttempts: 1,
    });
    expect(digest).toHaveLength(64);
    expect(packet.idempotencyKey).toHaveLength(64);

    const stale = evaluateRoutePreflight({
      certificateIssued: true,
      certificateIntegrityHash: "f".repeat(64),
      packet,
      allObservationsReviewed: true,
      verifiedObservationCount: 1,
      adapterFingerprint: "adapter-sha256-1",
    });
    expect(stale.allowed).toBe(false);
    expect(stale.checks.find((item) => item.code === "certificate-integrity")?.passed).toBe(false);

    const valid = evaluateRoutePreflight({
      certificateIssued: true,
      certificateIntegrityHash: integrityHash,
      packet,
      allObservationsReviewed: true,
      verifiedObservationCount: 1,
      adapterFingerprint: "adapter-sha256-1",
    });
    expect(valid.allowed).toBe(true);
  });

  it("does not permit blind retries after an indeterminate external write", () => {
    expect(canTransitionExecutionState("prepared", "indeterminate")).toBe(true);
    expect(canTransitionExecutionState("indeterminate", "prepared")).toBe(false);
    expect(canTransitionExecutionState("indeterminate", "reconciled")).toBe(true);
  });

  it("binds a human-verified corroboration assessment when a route requires one", () => {
    const corroborationHash = "c".repeat(64);
    const { packet } = buildRoutePacket({
      claimId: "claim-1",
      certificateId: "certificate-1",
      certificateIntegrityHash: integrityHash,
      corroborationId: "corroboration-1",
      corroborationAssessmentHash: corroborationHash,
      routeVersion: 2,
      target: "carrier-portal",
      operation: "submit-claim-package",
      adapterName: "carrier-portal",
      adapterVersion: "1.0.0",
      adapterFingerprint: "adapter-sha256-1",
      postconditions: [{ code: "confirmation-number", description: "A target confirmation number is captured." }],
      capabilityRequirements: ["carrier:write:claim"],
      maxExternalWrites: 1,
      maxAttempts: 1,
    });
    expect(packet.corroboration).toEqual({ id: "corroboration-1", assessmentHash: corroborationHash });

    const blocked = evaluateRoutePreflight({
      certificateIssued: true,
      certificateIntegrityHash: integrityHash,
      packet,
      allObservationsReviewed: true,
      verifiedObservationCount: 1,
      corroborationVerified: false,
      corroborationAssessmentHash: corroborationHash,
      adapterFingerprint: "adapter-sha256-1",
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.checks.find((item) => item.code === "corroboration-verified")?.passed).toBe(false);

    const allowed = evaluateRoutePreflight({
      certificateIssued: true,
      certificateIntegrityHash: integrityHash,
      packet,
      allObservationsReviewed: true,
      verifiedObservationCount: 1,
      corroborationVerified: true,
      corroborationAssessmentHash: corroborationHash,
      adapterFingerprint: "adapter-sha256-1",
    });
    expect(allowed.allowed).toBe(true);
  });
});
