import { describe, expect, it } from "vitest";

import {
  compileClaimGraphTarget,
  compileNativeEstimateClaimGraph,
  verifyCanonicalClaimGraph,
} from "./claim-compilation";

const validEstimate = {
  claimId: "claim-1",
  estimateId: "estimate-1",
  lineItems: [
    { description: " Architectural shingles ", quantity: 12, unitPriceCents: 12_500, totalCents: 150_000 },
    { description: "Ridge cap", quantity: 4, unitPriceCents: 5_000, totalCents: 20_000 },
  ],
  subtotalCents: 170_000,
  taxCents: 13_600,
  totalCents: 183_600,
};

describe("Provenance-preserving native estimate compilation", () => {
  it("builds a stable semantic graph with node-level source mappings and financial conservation", () => {
    const graph = compileNativeEstimateClaimGraph(validEstimate);
    expect(graph.valid).toBe(true);
    expect(graph.digest).toHaveLength(64);
    expect(graph.mappingLedger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ canonicalPath: "nodes.line:1.value.totalCents", transformation: "computed" }),
        expect.objectContaining({ canonicalPath: "nodes.total.value.totalCents", transformation: "computed" }),
      ]),
    );
    expect(graph.invariants.every((item) => item.passed)).toBe(true);
    expect(verifyCanonicalClaimGraph(graph)).toBe(true);
  });

  it("is replayable for the same source estimate and detects altered graph bytes", () => {
    const first = compileNativeEstimateClaimGraph(validEstimate);
    const replay = compileNativeEstimateClaimGraph({ ...validEstimate, lineItems: [...validEstimate.lineItems] });
    expect(first.digest).toBe(replay.digest);
    expect(verifyCanonicalClaimGraph({ ...first, nodes: [...first.nodes, { id: "tampered", kind: "tax", value: {} }] })).toBe(false);
  });

  it("retains a diagnostic graph but blocks target compilation if a source total is corrupted", () => {
    const graph = compileNativeEstimateClaimGraph({
      ...validEstimate,
      lineItems: [{ ...validEstimate.lineItems[0]!, totalCents: 1 }, validEstimate.lineItems[1]!],
      subtotalCents: 20_001,
      totalCents: 33_601,
    });
    expect(graph.valid).toBe(false);
    expect(graph.invariants.filter((item) => !item.passed).map((item) => item.code)).toEqual(
      expect.arrayContaining(["line.1.total_conservation", "subtotal.declared_total", "total.declared_total"]),
    );
    expect(() => compileClaimGraphTarget(graph, "mogulforge-estimate-v1")).toThrow("failed invariants");
  });

  it("emits two deterministic, vendor-neutral target representations from a valid graph", () => {
    const graph = compileNativeEstimateClaimGraph(validEstimate);
    const estimateTarget = compileClaimGraphTarget(graph, "mogulforge-estimate-v1");
    const statementTarget = compileClaimGraphTarget(graph, "contractor-claim-statement-v1");
    expect(estimateTarget.sourceGraphDigest).toBe(graph.digest);
    expect(statementTarget.sourceGraphDigest).toBe(graph.digest);
    expect(estimateTarget.digest).not.toBe(statementTarget.digest);
  });
});
