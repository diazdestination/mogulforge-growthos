import { createHash } from "node:crypto";

/**
 * The Claim Kernel is deliberately provider-neutral. It produces stable bytes
 * for evidence, certificate, and route-packet records so a later worker can
 * independently verify exactly what it was allowed to act upon.
 */
export const CLAIM_KERNEL_VERSION = "mogulforge-claim-kernel-v1";
export const EVIDENCE_MANIFEST_VERSION = "mogulforge-evidence-manifest-v1";
export const CERTIFICATE_INTEGRITY_VERSION = "mogulforge-certificate-integrity-v1";
export const ROUTE_PACKET_VERSION = "mogulforge-route-packet-v1";

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export type EvidenceArtifactSnapshot = {
  id: string;
  kind: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  sourceLabel: string | null;
  aiUseApprovedAt: Date | string | null;
  createdAt: Date | string;
};

export type EvidenceManifestEntry = {
  alias: string;
  artifactId: string;
  kind: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  sourceLabel: string | null;
  aiUseApprovedAt: string;
  createdAt: string;
};

export type EvidenceManifest = {
  version: typeof EVIDENCE_MANIFEST_VERSION;
  kernelVersion: typeof CLAIM_KERNEL_VERSION;
  artifacts: EvidenceManifestEntry[];
};

export type IntegrityObservation = {
  id: string;
  artifactId: string | null;
  category: string;
  statement: string;
  locator: string | null;
  basis: string | null;
  confidence: number;
  needsHumanReview: boolean;
  status: "ai_draft" | "verified" | "rejected";
  reviewedByUserId: string | null;
  reviewedAt: Date | string | null;
};

export type CertificateIntegrityManifest = {
  version: typeof CERTIFICATE_INTEGRITY_VERSION;
  kernelVersion: typeof CLAIM_KERNEL_VERSION;
  certificate: {
    id: string | null;
    version: number;
    status: "draft" | "issued";
    contentHash: string;
  };
  claim: {
    id: string;
    lossType: string | null;
    lossDate: string | null;
  };
  evidenceRun: {
    id: string;
    manifestHash: string;
    promptVersion: string;
    model: string;
  };
  reviewLedger: IntegrityObservation[];
  policy: {
    aiDraftOnly: true;
    humanIssuanceRequired: true;
    allObservationsReviewed: boolean;
    verifiedObservationCount: number;
  };
};

export type RouteCondition = {
  code: string;
  description: string;
  expected: string | number | boolean;
};

export type RoutePacket = {
  version: typeof ROUTE_PACKET_VERSION;
  kernelVersion: typeof CLAIM_KERNEL_VERSION;
  claimId: string;
  certificateId: string;
  certificateIntegrityHash: string;
  routeVersion: number;
  target: string;
  operation: string;
  adapter: {
    name: string;
    version: string;
    fingerprint: string;
  };
  preconditions: RouteCondition[];
  postconditions: RouteCondition[];
  capabilityRequirements: string[];
  sideEffectBudget: {
    maxExternalWrites: number;
    maxAttempts: number;
  };
  idempotencyKey: string;
};

export type RoutePreflightResult = {
  allowed: boolean;
  checks: Array<{ code: string; passed: boolean; reason: string }>;
};

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Claim Kernel received an invalid timestamp.");
  return date.toISOString();
}

/**
 * Recursively sort object keys and reject values that would make a digest
 * non-replayable. Arrays retain caller-defined order because their order can
 * carry semantic meaning (for example, a review ledger).
 */
export function canonicalize(value: unknown): CanonicalValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Claim Kernel cannot canonicalize a non-finite number.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (value instanceof Date) return iso(value);
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, item]) => [key, canonicalize(item)]));
  }
  throw new Error(`Claim Kernel cannot canonicalize ${typeof value}.`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function buildEvidenceManifest(artifacts: EvidenceArtifactSnapshot[]): {
  manifest: EvidenceManifest;
  digest: string;
  aliases: Map<string, string>;
} {
  if (artifacts.length === 0) throw new Error("An evidence manifest requires at least one artifact.");

  const aliases = new Map<string, string>();
  const entries = artifacts.map((artifact, index) => {
    if (!artifact.aiUseApprovedAt) {
      throw new Error("An evidence manifest cannot include an artifact not approved for AI use.");
    }
    const alias = `E${index + 1}`;
    aliases.set(alias, artifact.id);
    return {
      alias,
      artifactId: artifact.id,
      kind: artifact.kind,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      sourceLabel: artifact.sourceLabel,
      aiUseApprovedAt: iso(artifact.aiUseApprovedAt),
      createdAt: iso(artifact.createdAt),
    };
  });

  const manifest: EvidenceManifest = {
    version: EVIDENCE_MANIFEST_VERSION,
    kernelVersion: CLAIM_KERNEL_VERSION,
    artifacts: entries,
  };
  return { manifest, digest: sha256Canonical(manifest), aliases };
}

export function buildCertificateIntegrityManifest(input: {
  certificate: CertificateIntegrityManifest["certificate"];
  claim: CertificateIntegrityManifest["claim"];
  evidenceRun: CertificateIntegrityManifest["evidenceRun"];
  observations: IntegrityObservation[];
}): { manifest: CertificateIntegrityManifest; digest: string } {
  const reviewLedger = [...input.observations]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((observation) => ({
      ...observation,
      reviewedAt: observation.reviewedAt ? iso(observation.reviewedAt) : null,
    }));
  const allObservationsReviewed = reviewLedger.length > 0 && reviewLedger.every((item) => item.status !== "ai_draft");
  const verifiedObservationCount = reviewLedger.filter((item) => item.status === "verified").length;
  const manifest: CertificateIntegrityManifest = {
    version: CERTIFICATE_INTEGRITY_VERSION,
    kernelVersion: CLAIM_KERNEL_VERSION,
    certificate: input.certificate,
    claim: {
      ...input.claim,
      lossDate: input.claim.lossDate ? iso(input.claim.lossDate) : null,
    },
    evidenceRun: input.evidenceRun,
    reviewLedger,
    policy: {
      aiDraftOnly: true,
      humanIssuanceRequired: true,
      allObservationsReviewed,
      verifiedObservationCount,
    },
  };
  return { manifest, digest: sha256Canonical(manifest) };
}

function requireNonBlank(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required for a route packet.`);
  return normalized;
}

export function buildRoutePacket(input: {
  claimId: string;
  certificateId: string;
  certificateIntegrityHash: string;
  routeVersion: number;
  target: string;
  operation: string;
  adapterName: string;
  adapterVersion: string;
  adapterFingerprint: string;
  postconditions: Array<{ code: string; description: string }>;
  capabilityRequirements: string[];
  maxExternalWrites: number;
  maxAttempts: number;
}): { packet: RoutePacket; digest: string } {
  if (!/^[a-f0-9]{64}$/i.test(input.certificateIntegrityHash)) {
    throw new Error("An issued certificate integrity hash is required for a route packet.");
  }
  if (!Number.isInteger(input.routeVersion) || input.routeVersion < 1) {
    throw new Error("Route packet version must be a positive integer.");
  }
  if (!Number.isInteger(input.maxExternalWrites) || input.maxExternalWrites < 0 || input.maxExternalWrites > 1) {
    throw new Error("A route packet may permit zero or one external write.");
  }
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 1) {
    throw new Error("A write-bearing route packet may permit exactly one execution attempt.");
  }
  if (input.postconditions.length === 0) throw new Error("At least one target-side postcondition is required.");

  const target = requireNonBlank(input.target, "Target");
  const operation = requireNonBlank(input.operation, "Operation");
  const adapter = {
    name: requireNonBlank(input.adapterName, "Adapter name"),
    version: requireNonBlank(input.adapterVersion, "Adapter version"),
    fingerprint: requireNonBlank(input.adapterFingerprint, "Adapter fingerprint"),
  };
  const postconditions = input.postconditions.map((condition) => ({
    code: requireNonBlank(condition.code, "Postcondition code"),
    description: requireNonBlank(condition.description, "Postcondition description"),
    expected: true,
  }));
  const capabilityRequirements = [...new Set(input.capabilityRequirements.map((item) => item.trim()).filter(Boolean))].sort();
  if (capabilityRequirements.length === 0) throw new Error("At least one execution capability is required.");

  const idempotencyKey = sha256Canonical({
    claimId: input.claimId,
    certificateId: input.certificateId,
    certificateIntegrityHash: input.certificateIntegrityHash,
    routeVersion: input.routeVersion,
    target,
    operation,
    adapter,
  });
  const packet: RoutePacket = {
    version: ROUTE_PACKET_VERSION,
    kernelVersion: CLAIM_KERNEL_VERSION,
    claimId: input.claimId,
    certificateId: input.certificateId,
    certificateIntegrityHash: input.certificateIntegrityHash,
    routeVersion: input.routeVersion,
    target,
    operation,
    adapter,
    preconditions: [
      { code: "certificate-issued", description: "The named Loss Evidence Certificate is issued.", expected: true },
      { code: "certificate-integrity", description: "The issued certificate hash still matches this packet.", expected: input.certificateIntegrityHash },
      { code: "human-review-complete", description: "All evidence observations were reviewed by a human.", expected: true },
      { code: "human-verification-present", description: "At least one observation was human verified.", expected: true },
      { code: "adapter-fingerprint", description: "The target adapter matches the compiled fingerprint.", expected: adapter.fingerprint },
    ],
    postconditions,
    capabilityRequirements,
    sideEffectBudget: { maxExternalWrites: input.maxExternalWrites, maxAttempts: input.maxAttempts },
    idempotencyKey,
  };
  return { packet, digest: sha256Canonical(packet) };
}

export function evaluateRoutePreflight(input: {
  certificateIssued: boolean;
  certificateIntegrityHash: string | null;
  packet: RoutePacket;
  allObservationsReviewed: boolean;
  verifiedObservationCount: number;
  adapterFingerprint: string | null;
}): RoutePreflightResult {
  const checks = [
    {
      code: "certificate-issued",
      passed: input.certificateIssued,
      reason: input.certificateIssued ? "Issued certificate present." : "Certificate is not issued.",
    },
    {
      code: "certificate-integrity",
      passed: input.certificateIntegrityHash === input.packet.certificateIntegrityHash,
      reason:
        input.certificateIntegrityHash === input.packet.certificateIntegrityHash
          ? "Certificate integrity hash matches the route packet."
          : "Certificate integrity hash does not match the route packet.",
    },
    {
      code: "human-review-complete",
      passed: input.allObservationsReviewed,
      reason: input.allObservationsReviewed ? "Every observation has a human review decision." : "At least one observation is unreviewed.",
    },
    {
      code: "human-verification-present",
      passed: input.verifiedObservationCount > 0,
      reason:
        input.verifiedObservationCount > 0
          ? "At least one observation is human verified."
          : "No human-verified observation is present.",
    },
    {
      code: "adapter-fingerprint",
      passed: input.adapterFingerprint === input.packet.adapter.fingerprint,
      reason:
        input.adapterFingerprint === input.packet.adapter.fingerprint
          ? "Target adapter fingerprint matches the compiled packet."
          : "Target adapter fingerprint differs from the compiled packet.",
    },
  ];
  return { allowed: checks.every((check) => check.passed), checks };
}

export type ExecutionState = "prepared" | "indeterminate" | "succeeded" | "failed" | "reconciled";

/**
 * Unknown external-write state is intentionally terminal until a reconciler
 * supplies target evidence. This makes a blind retry impossible by design.
 */
export function canTransitionExecutionState(from: ExecutionState, to: ExecutionState): boolean {
  return (
    (from === "prepared" && (to === "succeeded" || to === "failed" || to === "indeterminate")) ||
    (from === "indeterminate" && to === "reconciled")
  );
}
