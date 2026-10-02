import { canonicalJson, sha256Canonical } from "./claim-kernel";

/**
 * This module deliberately contains no provider calls and no model inference.
 * It turns already-captured, source-linked observations into a repeatable
 * decision-support assessment. A human still decides what the evidence means
 * for a claim, scope, safety, or coverage determination.
 */
export const LOSS_CORROBORATION_VERSION = "mogulforge-loss-corroboration-v1";
export const LOSS_CORROBORATION_RULESET_VERSION = "mogulforge-loss-corroboration-rules-v1";

export type CorroborationSignal = "supporting" | "contradicting" | "neutral";
export type CorroborationSourceKind = "weather" | "property" | "inspection" | "photo" | "document" | "other";

export type Coordinates = {
  latitude: number;
  longitude: number;
};

export type RoofFacet = {
  id: string;
  azimuthDegrees: number;
  weight?: number;
};

export type CorroborationObservationInput = {
  id: string;
  signal: CorroborationSignal;
  phenomenon: string;
  observedAt: string;
  magnitudeScore: number;
  coordinates?: Coordinates | null;
  directionDegrees?: number | null;
};

export type CorroborationSourceInput = {
  sourceArtifactId: string;
  sourceArtifactSha256: string;
  sourceKind: CorroborationSourceKind;
  provider: string;
  providerVersion: string;
  retrievedAt: string;
  qualityScore: number;
  coverageScore: number;
  missingFields: string[];
  temporalCoverage: { startsAt: string; endsAt: string };
  observations: CorroborationObservationInput[];
};

export type LossCorroborationInput = {
  claimId: string;
  claimGraphDigest: string;
  lossDate: string;
  propertyCoordinates: Coordinates | null;
  roofFacets: RoofFacet[];
  sources: CorroborationSourceInput[];
};

type NormalizedObservation = {
  id: string;
  signal: CorroborationSignal;
  phenomenon: string;
  observedAt: string;
  magnitudeScore: number;
  coordinates: Coordinates | null;
  directionDegrees: number | null;
};

type NormalizedSource = Omit<CorroborationSourceInput, "retrievedAt" | "temporalCoverage" | "observations" | "missingFields"> & {
  retrievedAt: string;
  missingFields: string[];
  temporalCoverage: { startsAt: string; endsAt: string };
  observations: NormalizedObservation[];
};

export type LossCorroborationManifest = {
  version: typeof LOSS_CORROBORATION_VERSION;
  rulesetVersion: typeof LOSS_CORROBORATION_RULESET_VERSION;
  claim: { id: string; graphDigest: string; lossDate: string };
  property: { coordinates: Coordinates | null; roofFacets: Array<{ id: string; azimuthDegrees: number; weight: number }> };
  sources: NormalizedSource[];
};

export type ObservationAssessment = {
  id: string;
  signal: CorroborationSignal;
  phenomenon: string;
  observedAt: string;
  magnitudeScore: number;
  temporal: { daysFromLoss: number; coveredBySourceWindow: boolean; score: number };
  spatial: { available: boolean; distanceMiles: number | null; score: number; fallbackFactor: number };
  directional: { available: boolean; bestFacetId: string | null; score: number; fallbackFactor: number };
  contributionScore: number;
};

export type SourceAssessment = {
  sourceArtifactId: string;
  sourceArtifactSha256: string;
  sourceKind: CorroborationSourceKind;
  provider: string;
  providerVersion: string;
  qualityScore: number;
  coverageScore: number;
  missingFields: string[];
  observationCount: number;
  supportingContribution: number;
  contradictingContribution: number;
  neutralObservationCount: number;
  observations: ObservationAssessment[];
};

export type CorroborationContradiction = {
  phenomenon: string;
  supportingSourceArtifactId: string;
  contradictingSourceArtifactId: string;
  supportingObservationId: string;
  contradictingObservationId: string;
  daysApart: number;
  reason: string;
};

export type LossCorroborationAssessment = {
  version: typeof LOSS_CORROBORATION_VERSION;
  rulesetVersion: typeof LOSS_CORROBORATION_RULESET_VERSION;
  claim: { id: string; graphDigest: string; lossDate: string };
  sourceManifestHash: string;
  sourceAssessments: SourceAssessment[];
  contradictions: CorroborationContradiction[];
  breakdown: {
    state: "insufficient_evidence" | "mixed_evidence" | "corroborating_signals" | "contradicting_signals";
    supportingEvidenceScore: number;
    contradictingEvidenceScore: number;
    supportBalanceScore: number;
    evidenceStrengthScore: number;
    sourceCoverageScore: number;
    missingnessScore: number;
    crossSourceConsistencyScore: number;
    confidenceScore: number;
    sourceCount: number;
    distinctProviderCount: number;
  };
  limitations: string[];
};

export type LossCorroborationBundle = {
  manifest: LossCorroborationManifest;
  manifestHash: string;
  assessment: LossCorroborationAssessment;
  assessmentHash: string;
};

const SOURCE_KINDS: CorroborationSourceKind[] = ["weather", "property", "inspection", "photo", "document", "other"];
const SIGNALS: CorroborationSignal[] = ["supporting", "contradicting", "neutral"];
const DAY_MS = 24 * 60 * 60 * 1000;

function requiredString(value: string, field: string, maxLength = 240): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`${field} is required and must be ${maxLength} characters or fewer.`);
  return normalized;
}

function hash(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${field} must be a SHA-256 digest.`);
  return value.toLowerCase();
}

function iso(value: string, field: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid timestamp.`);
  return date.toISOString();
}

function score(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${field} must be a number from 0 to 100.`);
  return Math.round(value);
}

function normalizedBearing(value: number, field: string): number {
  if (!Number.isFinite(value)) throw new Error(`${field} must be a finite number.`);
  return ((value % 360) + 360) % 360;
}

function normalizedCoordinates(value: Coordinates | null | undefined, field: string): Coordinates | null {
  if (!value) return null;
  if (!Number.isFinite(value.latitude) || value.latitude < -90 || value.latitude > 90) {
    throw new Error(`${field} latitude must be between -90 and 90.`);
  }
  if (!Number.isFinite(value.longitude) || value.longitude < -180 || value.longitude > 180) {
    throw new Error(`${field} longitude must be between -180 and 180.`);
  }
  return { latitude: Number(value.latitude.toFixed(6)), longitude: Number(value.longitude.toFixed(6)) };
}

function uniqueSorted(values: string[], field: string, maxLength = 160): string[] {
  return [...new Set(values.map((value) => requiredString(value, field, maxLength)))].sort((left, right) => left.localeCompare(right));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function haversineMiles(left: Coordinates, right: Coordinates): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(right.latitude - left.latitude);
  const dLon = radians(right.longitude - left.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude)) * Math.sin(dLon / 2) ** 2;
  return 3958.7613 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function temporalScore(lossDate: string, observedAt: string, coverage: { startsAt: string; endsAt: string }) {
  const loss = new Date(lossDate).getTime();
  const observed = new Date(observedAt).getTime();
  const starts = new Date(coverage.startsAt).getTime();
  const ends = new Date(coverage.endsAt).getTime();
  const daysFromLoss = round(Math.abs(loss - observed) / DAY_MS);
  const coveredBySourceWindow = observed >= starts && observed <= ends;
  // The 45-day decay is a versioned relevance heuristic, not a causation model.
  const relevance = Math.exp(-daysFromLoss / 45);
  return { daysFromLoss, coveredBySourceWindow, score: round(100 * relevance * (coveredBySourceWindow ? 1 : 0)) };
}

function spatialScore(property: Coordinates | null, observation: Coordinates | null) {
  if (!property || !observation) return { available: false, distanceMiles: null, score: 0, fallbackFactor: 0.25 };
  const distanceMiles = round(haversineMiles(property, observation));
  // 50 miles is a transparent relevance horizon, not a statement of storm extent.
  return {
    available: true,
    distanceMiles,
    score: round(100 * Math.max(0, 1 - distanceMiles / 50)),
    fallbackFactor: 1,
  };
}

function directionalScore(facets: Array<{ id: string; azimuthDegrees: number; weight: number }>, directionDegrees: number | null) {
  if (directionDegrees === null || facets.length === 0) {
    return { available: false, bestFacetId: null, score: 0, fallbackFactor: 0.5 };
  }
  const scored = facets.map((facet) => {
    const difference = Math.abs(((facet.azimuthDegrees - directionDegrees + 540) % 360) - 180);
    // Alignment is intentionally simple and exposed. It is not an engineering load model.
    return { facet, score: ((Math.cos((difference * Math.PI) / 180) + 1) / 2) * facet.weight };
  });
  const best = scored.sort((left, right) => right.score - left.score || left.facet.id.localeCompare(right.facet.id))[0]!;
  return { available: true, bestFacetId: best.facet.id, score: round(Math.min(100, best.score * 100)), fallbackFactor: 1 };
}

function normalizedManifest(input: LossCorroborationInput): LossCorroborationManifest {
  const claimId = requiredString(input.claimId, "Claim ID", 120);
  const claimGraphDigest = hash(input.claimGraphDigest, "Canonical claim graph digest");
  const lossDate = iso(input.lossDate, "Loss date");
  const propertyCoordinates = normalizedCoordinates(input.propertyCoordinates, "Property coordinates");
  const roofFacets = input.roofFacets
    .map((facet) => {
      const weight = facet.weight === undefined ? 1 : facet.weight;
      if (!Number.isFinite(weight) || weight <= 0 || weight > 1) throw new Error("Roof facet weight must be greater than 0 and no greater than 1.");
      return { id: requiredString(facet.id, "Roof facet ID", 120), azimuthDegrees: normalizedBearing(facet.azimuthDegrees, "Roof facet azimuth"), weight: round(weight) };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(roofFacets.map((facet) => facet.id)).size !== roofFacets.length) throw new Error("Roof facet IDs must be unique.");
  if (input.sources.length === 0) throw new Error("At least one source-linked observation is required.");

  const sources = input.sources
    .map((source): NormalizedSource => {
      if (!SOURCE_KINDS.includes(source.sourceKind)) throw new Error("Source kind is not supported.");
      const startsAt = iso(source.temporalCoverage.startsAt, "Source temporal coverage start");
      const endsAt = iso(source.temporalCoverage.endsAt, "Source temporal coverage end");
      if (new Date(startsAt).getTime() > new Date(endsAt).getTime()) {
        throw new Error("Source temporal coverage must end after it starts.");
      }
      if (source.observations.length === 0) throw new Error("Every corroboration source requires at least one observation.");
      const observations = source.observations
        .map((observation): NormalizedObservation => {
          if (!SIGNALS.includes(observation.signal)) throw new Error("Observation signal is not supported.");
          return {
            id: requiredString(observation.id, "Observation ID", 120),
            signal: observation.signal,
            phenomenon: requiredString(observation.phenomenon, "Observation phenomenon", 120).toLowerCase(),
            observedAt: iso(observation.observedAt, "Observation timestamp"),
            magnitudeScore: score(observation.magnitudeScore, "Observation magnitude score"),
            coordinates: normalizedCoordinates(observation.coordinates, "Observation coordinates"),
            directionDegrees: observation.directionDegrees === null || observation.directionDegrees === undefined ? null : normalizedBearing(observation.directionDegrees, "Observation direction"),
          };
        })
        .sort((left, right) => left.id.localeCompare(right.id));
      if (new Set(observations.map((observation) => observation.id)).size !== observations.length) {
        throw new Error("Observation IDs must be unique within a source.");
      }
      return {
        sourceArtifactId: requiredString(source.sourceArtifactId, "Source artifact ID", 120),
        sourceArtifactSha256: hash(source.sourceArtifactSha256, "Source artifact digest"),
        sourceKind: source.sourceKind,
        provider: requiredString(source.provider, "Source provider", 160),
        providerVersion: requiredString(source.providerVersion, "Source provider version", 160),
        retrievedAt: iso(source.retrievedAt, "Source retrieval timestamp"),
        qualityScore: score(source.qualityScore, "Source quality score"),
        coverageScore: score(source.coverageScore, "Source coverage score"),
        missingFields: uniqueSorted(source.missingFields, "Missing field", 160),
        temporalCoverage: { startsAt, endsAt },
        observations,
      };
    })
    .sort((left, right) => left.sourceArtifactId.localeCompare(right.sourceArtifactId));
  if (new Set(sources.map((source) => source.sourceArtifactId)).size !== sources.length) {
    throw new Error("Each corroboration source must reference a different artifact.");
  }

  return {
    version: LOSS_CORROBORATION_VERSION,
    rulesetVersion: LOSS_CORROBORATION_RULESET_VERSION,
    claim: { id: claimId, graphDigest: claimGraphDigest, lossDate },
    property: { coordinates: propertyCoordinates, roofFacets },
    sources,
  };
}

function findContradictions(sourceAssessments: SourceAssessment[]): CorroborationContradiction[] {
  const observations = sourceAssessments.flatMap((source) =>
    source.observations.map((observation) => ({ sourceArtifactId: source.sourceArtifactId, observation })),
  );
  const contradictions: CorroborationContradiction[] = [];
  for (const supporting of observations.filter((item) => item.observation.signal === "supporting")) {
    for (const contradicting of observations.filter((item) => item.observation.signal === "contradicting")) {
      if (supporting.sourceArtifactId === contradicting.sourceArtifactId) continue;
      if (supporting.observation.phenomenon !== contradicting.observation.phenomenon) continue;
      const daysApart = round(Math.abs(new Date(supporting.observation.observedAt).getTime() - new Date(contradicting.observation.observedAt).getTime()) / DAY_MS);
      if (daysApart > 14) continue;
      contradictions.push({
        phenomenon: supporting.observation.phenomenon,
        supportingSourceArtifactId: supporting.sourceArtifactId,
        contradictingSourceArtifactId: contradicting.sourceArtifactId,
        supportingObservationId: supporting.observation.id,
        contradictingObservationId: contradicting.observation.id,
        daysApart,
        reason: "Independent sources report opposite signals for the same phenomenon within a 14-day comparison window.",
      });
    }
  }
  return contradictions.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

/**
 * Computes a source-manifest-bound assessment. The calculation is entirely
 * deterministic: identical inputs, including source ordering, yield identical
 * hashes and component scores.
 */
export function buildLossCorroboration(input: LossCorroborationInput): LossCorroborationBundle {
  const manifest = normalizedManifest(input);
  const manifestHash = sha256Canonical(manifest);
  const sourceAssessments: SourceAssessment[] = manifest.sources.map((source) => {
    const observations = source.observations.map((observation): ObservationAssessment => {
      const temporal = temporalScore(manifest.claim.lossDate, observation.observedAt, source.temporalCoverage);
      const spatial = spatialScore(manifest.property.coordinates, observation.coordinates);
      const directional = directionalScore(manifest.property.roofFacets, observation.directionDegrees);
      const missingPenalty = Math.max(0.4, 1 - source.missingFields.length * 0.08);
      const contributionScore = round(
        (observation.magnitudeScore / 100) *
          (source.qualityScore / 100) *
          (source.coverageScore / 100) *
          (temporal.score / 100) *
          (spatial.available ? spatial.score / 100 : spatial.fallbackFactor) *
          (directional.available ? directional.score / 100 : directional.fallbackFactor) *
          missingPenalty *
          100,
      );
      return {
        id: observation.id,
        signal: observation.signal,
        phenomenon: observation.phenomenon,
        observedAt: observation.observedAt,
        magnitudeScore: observation.magnitudeScore,
        temporal,
        spatial,
        directional,
        contributionScore,
      };
    });
    return {
      sourceArtifactId: source.sourceArtifactId,
      sourceArtifactSha256: source.sourceArtifactSha256,
      sourceKind: source.sourceKind,
      provider: source.provider,
      providerVersion: source.providerVersion,
      qualityScore: source.qualityScore,
      coverageScore: source.coverageScore,
      missingFields: source.missingFields,
      observationCount: observations.length,
      supportingContribution: round(observations.filter((item) => item.signal === "supporting").reduce((sum, item) => sum + item.contributionScore, 0)),
      contradictingContribution: round(observations.filter((item) => item.signal === "contradicting").reduce((sum, item) => sum + item.contributionScore, 0)),
      neutralObservationCount: observations.filter((item) => item.signal === "neutral").length,
      observations,
    };
  });
  const supportingEvidenceScore = round(sourceAssessments.reduce((sum, source) => sum + source.supportingContribution, 0));
  const contradictingEvidenceScore = round(sourceAssessments.reduce((sum, source) => sum + source.contradictingContribution, 0));
  const signedTotal = supportingEvidenceScore + contradictingEvidenceScore;
  const supportBalanceScore = signedTotal === 0 ? 50 : round((supportingEvidenceScore / signedTotal) * 100);
  const nonNeutralObservations = sourceAssessments.flatMap((source) => source.observations).filter((item) => item.signal !== "neutral");
  const evidenceStrengthScore = nonNeutralObservations.length === 0
    ? 0
    : round(nonNeutralObservations.reduce((sum, item) => sum + item.contributionScore, 0) / nonNeutralObservations.length);
  const sourceCoverageScore = round(sourceAssessments.reduce((sum, source) => sum + source.coverageScore, 0) / sourceAssessments.length);
  const distinctProviderCount = new Set(sourceAssessments.map((source) => source.provider.toLowerCase())).size;
  const missing = new Set(sourceAssessments.flatMap((source) => source.missingFields));
  if (!manifest.property.coordinates) missing.add("property_coordinates");
  if (sourceAssessments.some((source) => source.observations.some((observation) => !observation.spatial.available))) missing.add("source_coordinates");
  if (manifest.property.roofFacets.length === 0) missing.add("roof_facet_azimuths");
  if (sourceAssessments.some((source) => source.observations.some((observation) => !observation.directional.available))) missing.add("event_direction");
  const missingnessScore = Math.min(100, missing.size * 12);
  const contradictions = findContradictions(sourceAssessments);
  const polarityAgreement = signedTotal === 0 ? 0 : round((Math.abs(supportingEvidenceScore - contradictingEvidenceScore) / signedTotal) * 100);
  const sourceDiversity = Math.min(100, distinctProviderCount * 50);
  const contradictionPenalty = Math.min(50, contradictions.length * 15);
  const crossSourceConsistencyScore = Math.max(0, round(polarityAgreement * 0.7 + sourceDiversity * 0.3 - contradictionPenalty));
  const confidenceScore = Math.max(
    0,
    round(evidenceStrengthScore * 0.4 + sourceCoverageScore * 0.25 + crossSourceConsistencyScore * 0.2 + (100 - missingnessScore) * 0.15),
  );
  const enoughIndependentEvidence = sourceAssessments.length >= 2 && distinctProviderCount >= 2 && sourceCoverageScore >= 60 && missingnessScore <= 40 && evidenceStrengthScore >= 20;
  const state = !enoughIndependentEvidence
    ? "insufficient_evidence"
    : contradictions.length > 0 || (supportingEvidenceScore > 0 && contradictingEvidenceScore > 0 && supportBalanceScore > 30 && supportBalanceScore < 70)
      ? "mixed_evidence"
      : supportBalanceScore >= 70
        ? "corroborating_signals"
        : supportBalanceScore <= 30
          ? "contradicting_signals"
          : "mixed_evidence";
  const limitations = [
    "This is deterministic decision support, not an insurance, engineering, safety, causation, or coverage determination.",
    "Scores reflect only the source-linked inputs and versioned rules in this certificate; they do not prove an event occurred or caused damage.",
    ...(!manifest.property.coordinates ? ["Property coordinates were absent, so spatial relevance used an explicit conservative fallback."] : []),
    ...(manifest.property.roofFacets.length === 0 ? ["Roof-facet azimuths were absent, so directional exposure used an explicit conservative fallback."] : []),
    ...(contradictions.length > 0 ? ["Conflicting source signals require human review before relying on this assessment."] : []),
  ];
  const assessment: LossCorroborationAssessment = {
    version: LOSS_CORROBORATION_VERSION,
    rulesetVersion: LOSS_CORROBORATION_RULESET_VERSION,
    claim: manifest.claim,
    sourceManifestHash: manifestHash,
    sourceAssessments,
    contradictions,
    breakdown: {
      state,
      supportingEvidenceScore,
      contradictingEvidenceScore,
      supportBalanceScore,
      evidenceStrengthScore,
      sourceCoverageScore,
      missingnessScore,
      crossSourceConsistencyScore,
      confidenceScore,
      sourceCount: sourceAssessments.length,
      distinctProviderCount,
    },
    limitations,
  };
  return { manifest, manifestHash, assessment, assessmentHash: sha256Canonical(assessment) };
}

export function verifyLossCorroboration(bundle: LossCorroborationBundle): boolean {
  return (
    sha256Canonical(bundle.manifest) === bundle.manifestHash &&
    bundle.assessment.sourceManifestHash === bundle.manifestHash &&
    sha256Canonical(bundle.assessment) === bundle.assessmentHash
  );
}

export function canonicalLossCorroborationBytes(bundle: LossCorroborationBundle): string {
  return canonicalJson(bundle);
}
