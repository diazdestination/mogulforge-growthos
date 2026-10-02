import { describe, expect, it } from "vitest";

import {
  buildLossCorroboration,
  verifyLossCorroboration,
  type LossCorroborationInput,
} from "./loss-corroboration";

const GRAPH_HASH = "a".repeat(64);

function input(overrides: Partial<LossCorroborationInput> = {}): LossCorroborationInput {
  return {
    claimId: "claim-1",
    claimGraphDigest: GRAPH_HASH,
    lossDate: "2026-05-15T00:00:00.000Z",
    propertyCoordinates: { latitude: 32.7767, longitude: -96.797 },
    roofFacets: [{ id: "south", azimuthDegrees: 180 }],
    sources: [
      {
        sourceArtifactId: "artifact-weather",
        sourceArtifactSha256: "b".repeat(64),
        sourceKind: "weather",
        provider: "National Weather Test Feed",
        providerVersion: "2026.5",
        retrievedAt: "2026-05-16T00:00:00.000Z",
        qualityScore: 92,
        coverageScore: 90,
        missingFields: [],
        temporalCoverage: { startsAt: "2026-05-01T00:00:00.000Z", endsAt: "2026-05-31T23:59:59.000Z" },
        observations: [
          {
            id: "weather-hail",
            signal: "supporting",
            phenomenon: "hail",
            observedAt: "2026-05-15T00:00:00.000Z",
            magnitudeScore: 90,
            coordinates: { latitude: 32.7767, longitude: -96.797 },
            directionDegrees: 180,
          },
        ],
      },
      {
        sourceArtifactId: "artifact-inspection",
        sourceArtifactSha256: "c".repeat(64),
        sourceKind: "inspection",
        provider: "Independent Inspection",
        providerVersion: "1.0",
        retrievedAt: "2026-05-17T00:00:00.000Z",
        qualityScore: 88,
        coverageScore: 84,
        missingFields: [],
        temporalCoverage: { startsAt: "2026-05-10T00:00:00.000Z", endsAt: "2026-05-20T00:00:00.000Z" },
        observations: [
          {
            id: "inspection-impact",
            signal: "supporting",
            phenomenon: "hail",
            observedAt: "2026-05-16T00:00:00.000Z",
            magnitudeScore: 78,
            coordinates: { latitude: 32.78, longitude: -96.79 },
            directionDegrees: 180,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("deterministic loss corroboration", () => {
  it("creates a source-manifest-bound, replayable assessment independent of input order", () => {
    const first = buildLossCorroboration(input());
    const reversed = buildLossCorroboration(input({ sources: [...input().sources].reverse() }));

    expect(first.manifestHash).toBe(reversed.manifestHash);
    expect(first.assessmentHash).toBe(reversed.assessmentHash);
    expect(first.assessment.breakdown.state).toBe("corroborating_signals");
    expect(verifyLossCorroboration(first)).toBe(true);
  });

  it("exposes temporal, spatial, and directional factors rather than hiding them in a score", () => {
    const result = buildLossCorroboration(input());
    const weather = result.assessment.sourceAssessments.find((source) => source.sourceArtifactId === "artifact-weather");
    const observation = weather!.observations[0]!;

    expect(observation.temporal.score).toBe(100);
    expect(observation.spatial).toMatchObject({ available: true, distanceMiles: 0, score: 100 });
    expect(observation.directional).toMatchObject({ available: true, bestFacetId: "south", score: 100 });
    expect(result.assessment.breakdown.missingnessScore).toBe(0);
  });

  it("records opposite independent signals as a human-review contradiction", () => {
    const sources = input().sources;
    const result = buildLossCorroboration(input({
      sources: [
        sources[0]!,
        {
          ...sources[1]!,
          observations: [{ ...sources[1]!.observations[0]!, id: "inspection-no-hail", signal: "contradicting", observedAt: "2026-05-15T00:00:00.000Z" }],
        },
      ],
    }));

    expect(result.assessment.breakdown.state).toBe("mixed_evidence");
    expect(result.assessment.contradictions).toHaveLength(1);
    expect(result.assessment.limitations.join(" ")).toContain("Conflicting source signals");
  });

  it("makes spatial and directional missingness explicit and penalized", () => {
    const result = buildLossCorroboration(input({ propertyCoordinates: null, roofFacets: [] }));

    expect(result.assessment.breakdown.missingnessScore).toBeGreaterThan(0);
    expect(result.assessment.limitations.join(" ")).toContain("Property coordinates were absent");
    expect(result.assessment.sourceAssessments[0]!.observations[0]!.spatial.available).toBe(false);
    expect(result.assessment.sourceAssessments[0]!.observations[0]!.directional.available).toBe(false);
  });

  it("rejects a claim that is not cryptographically identified", () => {
    expect(() => buildLossCorroboration(input({ claimGraphDigest: "not-a-digest" }))).toThrow("Canonical claim graph digest");
  });
});
