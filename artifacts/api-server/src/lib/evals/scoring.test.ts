import { describe, expect, it } from "vitest";

import type { DocumentExtraction, DocumentLabels } from "./schemas";
import {
  buildReport,
  calibrateJudge,
  cohensKappa,
  evaluateQualityGate,
  scoreAssistantCase,
  scoreDocumentExtraction,
  scoreEvidenceCase,
  summarizeEvidence,
  type CalibrationReport,
  type EvidenceCohortSummary,
} from "./scoring";
import { FakeJudge, finding, makeAssistantCase, makeDraft, makeEvidenceCase } from "./test-fixtures";

describe("scoreEvidenceCase", () => {
  it("computes agreement, critical omissions, precision, citations, conflicts, gaps and forbidden claims", async () => {
    const evalCase = makeEvidenceCase();
    const draft = makeDraft({
      findings: [
        finding("West slope has 11 hits in the test square", ["E1"]),
        finding("Gutter dents on the west run", ["E1"]), // matched but cites the wrong alias (E2 expected)
        finding("Shingles look old", ["E9"]), // unmatched, cites an alias outside the allowlist
      ],
      conflicts: [{ summary: "The dates differ between email and report", artifactIds: ["E1", "E2"] }],
      gaps: [{ title: "No photos", reason: "none supplied", recommendedAction: "take photos" }],
      limitations: ["FORBIDDEN:coverage decision"],
    });
    const score = await scoreEvidenceCase(evalCase, { draft }, new FakeJudge());

    expect(score.status).toBe("scored");
    expect(score.cohort).toBe("researchDraft");
    expect(score.observations).toMatchObject({ expected: 4, matched: 2, matchedWithSupportingCitation: 1, criticalExpected: 2, criticalMissed: 1 });
    expect(score.findings).toEqual({ total: 3, unmatched: 1, unmatchedIndexes: [2] });
    expect(score.citations).toEqual({ total: 5, allowlistViolations: 1, invalidAliases: ["E9"] });
    expect(score.conflicts).toEqual({ expected: 1, detected: 1, missedIds: [] });
    expect(score.gaps).toEqual({ expected: 2, detected: 1, missedIds: ["gap-b"] });
    expect(score.forbidden.violations.map((v) => v.id)).toEqual(["forbid-a"]);
  });

  it("credits one finding to one expected observation, critical items first", async () => {
    const evalCase = makeEvidenceCase({
      labels: {
        ...makeEvidenceCase().labels,
        expectedObservations: [
          { id: "minor", statement: "11 hits", category: "x", critical: false, supportingAliases: ["E1"] },
          { id: "major", statement: "west slope has 11 hits", category: "x", critical: true, supportingAliases: ["E1"] },
        ],
      },
    });
    const score = await scoreEvidenceCase(evalCase, { draft: makeDraft({ findings: [finding("west slope has 11 hits")] }) }, new FakeJudge());
    expect(score.observations.matched).toBe(1);
    expect(score.observations.criticalMissed).toBe(0);
    expect(score.observations.details.find((d) => d.id === "minor")?.matchedFindingIndex).toBeNull();
  });

  it("does not count a conflict that cites fewer than two expected aliases", async () => {
    const draft = makeDraft({ conflicts: [{ summary: "dates differ", artifactIds: ["E1", "E3"] }] });
    const score = await scoreEvidenceCase(makeEvidenceCase(), { draft }, new FakeJudge());
    expect(score.conflicts.detected).toBe(0);
  });

  it("treats a model failure as missing every expected item", async () => {
    const score = await scoreEvidenceCase(makeEvidenceCase(), { draft: null, error: "timeout" }, new FakeJudge());
    expect(score.status).toBe("model-error");
    expect(score.observations.matched).toBe(0);
    expect(score.observations.criticalMissed).toBe(2);
    expect(score.conflicts.missedIds).toEqual(["conf-a"]);
  });
});

describe("summaries and the quality gate", () => {
  const calibrated: CalibrationReport = {
    judgeKind: "fake",
    judgeVersion: "fake-v1",
    pairs: 10,
    humanVerifiedPairs: 10,
    agreement: 0.95,
    cohensKappa: 0.9,
    confusion: { truePositive: 5, falsePositive: 0, falseNegative: 1, trueNegative: 4 },
    disagreementIds: [],
    threshold: 0.9,
    calibrated: true,
  };
  const summary = (overrides: Partial<EvidenceCohortSummary>): EvidenceCohortSummary => ({
    ...summarizeEvidence([]),
    cases: 25,
    observationsExpected: 100,
    observationsMatched: 97,
    observationAgreement: 0.97,
    criticalExpected: 40,
    criticalMissed: 1,
    criticalOmissionRate: 0.025,
    ...overrides,
  });

  it("is not measurable below the contractor-verified minimum", () => {
    const gate = evaluateQualityGate(summary({ cases: 19 }), calibrated);
    expect(gate.status).toBe("not-measurable");
    expect(gate.reasons[0]).toMatch(/19 contractor-verified/);
  });

  it("is not measurable with an uncalibrated or research-draft-calibrated judge", () => {
    expect(evaluateQualityGate(summary({}), { ...calibrated, agreement: 0.85, calibrated: false }).status).toBe("not-measurable");
    expect(evaluateQualityGate(summary({}), { ...calibrated, humanVerifiedPairs: 3 }).status).toBe("not-measurable");
    expect(evaluateQualityGate(summary({}), null).status).toBe("not-measurable");
  });

  it("passes only when agreement >= 95%, critical omissions <= 5% and no allowlist violations", () => {
    expect(evaluateQualityGate(summary({}), calibrated)).toMatchObject({ status: "passed", target: 0.95, criticalOmissionMax: 0.05 });
    expect(evaluateQualityGate(summary({ observationAgreement: 0.94 }), calibrated).status).toBe("failed");
    expect(evaluateQualityGate(summary({ criticalOmissionRate: 0.06 }), calibrated).status).toBe("failed");
    expect(evaluateQualityGate(summary({ citationAllowlistViolations: 1 }), calibrated).status).toBe("failed");
  });

  it("micro-averages and keeps research drafts out of the contractor cohort", async () => {
    const judge = new FakeJudge();
    const draftScore = await scoreEvidenceCase(makeEvidenceCase(), { draft: makeDraft({ findings: [finding("west slope has 11 hits")] }) }, judge);
    const verifiedScore = await scoreEvidenceCase(
      makeEvidenceCase({ id: "case-two", verified: true }),
      {
        draft: makeDraft({
          findings: [finding("west slope has 11 hits"), finding("south slope has 9 hits"), finding("gutter dents", ["E2"]), finding("canopy has no hits")],
        }),
      },
      judge,
    );
    const report = buildReport({ evidenceScores: [draftScore, verifiedScore], assistantScores: [], calibration: calibrated });
    expect(report.evidence.contractorVerified).toMatchObject({ cases: 1, observationAgreement: 1, criticalOmissionRate: 0 });
    expect(report.evidence.researchDraft).toMatchObject({ cases: 1, observationAgreement: 0.25, criticalOmissionRate: 0.5 });
    expect(report.gate.status).toBe("not-measurable");
    expect(report.notice).toMatch(/only from contractor-verified/);
  });
});

describe("scoreDocumentExtraction", () => {
  const labels: DocumentLabels = {
    documentType: "invoice",
    lineItems: [
      { title: "Standard Repair", qty: 1, amountCents: 115000, descriptionComponents: ["New High Pressure Limit Switch", "New Filter Drier"] },
      { title: "Standard Repair", qty: 1, amountCents: 121500, descriptionComponents: ["New Blower Motor Belt (2)"] },
    ],
    totals: { subtotalCents: 236500, totalCents: 236500, amountPaidCents: null, balanceDueCents: 236500 },
    paymentTerms: "Upon receipt",
    warranty: { present: false, terms: [] },
    flags: [
      { id: "flag-warranty", description: "no warranty dates" },
      { id: "flag-two", description: "(2) is ambiguous" },
    ],
  };

  it("returns not-run when no extraction was recorded", async () => {
    expect(await scoreDocumentExtraction(labels, null, new FakeJudge())).toMatchObject({ status: "not-run" });
  });

  it("scores line items, totals, invented values, warranty and flags", async () => {
    const extraction: DocumentExtraction = {
      lineItems: [
        { title: "Standard Repair", qty: 1, amountCents: 115000, descriptionComponents: ["High pressure limit switch (new)"], componentPricesCents: [40000] },
        { title: "Standard Repair", qty: 1, amountCents: 121500, descriptionComponents: ["New blower motor belt (2)"], componentPricesCents: [] },
        { title: "Trip charge", qty: 1, amountCents: 8900, descriptionComponents: [], componentPricesCents: [] },
      ],
      totals: { subtotalCents: 236500, totalCents: 236500, amountPaidCents: 0, balanceDueCents: 236500 },
      paymentTerms: "Due upon receipt",
      warranty: { present: false, terms: [] },
      flags: ["Invoice has no warranty dates listed"],
    };
    const score = await scoreDocumentExtraction(labels, extraction, new FakeJudge());
    expect(score).toMatchObject({
      status: "scored",
      lineItems: { expected: 2, matched: 2, quantitiesCorrect: 2, quantityMismatches: 0, inventedQuantities: 0, componentsExpected: 3, componentsMatched: 2, inventedLineItems: 1, inventedComponentPrices: 1 },
      totals: { checked: 3, correct: 3, invented: 1 },
      extractedTotalsReconcile: false,
      paymentTermsCorrect: true,
      warranty: { presenceCorrect: true, termsExpected: 0, termsMatched: 0 },
      flags: { expected: 2, detected: 1, missedIds: ["flag-two"] },
    });
  });
});

describe("scoreDocumentExtraction quantities", () => {
  const base: DocumentLabels = {
    documentType: "invoice",
    lineItems: [{ title: "Standard Repair", qty: 1, amountCents: 115000, descriptionComponents: [] }],
    totals: { subtotalCents: 115000, totalCents: 115000, amountPaidCents: null, balanceDueCents: 115000 },
    paymentTerms: null,
    warranty: { present: false, terms: [] },
    flags: [],
  };
  const extraction = (qty: number | null): DocumentExtraction => ({
    lineItems: [{ title: "Standard Repair", qty, amountCents: 115000, descriptionComponents: [], componentPricesCents: [] }],
    totals: { subtotalCents: 115000, totalCents: 115000, amountPaidCents: null, balanceDueCents: 115000 },
    paymentTerms: null,
    warranty: { present: false, terms: [] },
    flags: [],
  });

  it("does not match a line whose stated quantity disagrees", async () => {
    const score = await scoreDocumentExtraction(base, extraction(999), new FakeJudge());
    expect(score).toMatchObject({ lineItems: { matched: 0, quantitiesCorrect: 0, quantityMismatches: 1, inventedQuantities: 0 } });
    const missing = await scoreDocumentExtraction(base, extraction(null), new FakeJudge());
    expect(missing).toMatchObject({ lineItems: { matched: 0, quantityMismatches: 1 } });
  });

  it("flags a quantity extracted where the document states none, and accepts null for null", async () => {
    const lumpSum: DocumentLabels = { ...base, lineItems: [{ ...base.lineItems[0], qty: null }] };
    const invented = await scoreDocumentExtraction(lumpSum, extraction(32), new FakeJudge());
    expect(invented).toMatchObject({ lineItems: { matched: 0, inventedQuantities: 1, quantityMismatches: 0 } });
    const agreed = await scoreDocumentExtraction(lumpSum, extraction(null), new FakeJudge());
    expect(agreed).toMatchObject({ lineItems: { matched: 1, quantitiesCorrect: 1, inventedQuantities: 0 } });
  });

  const repeated = (qtys: Array<number | null>): DocumentExtraction => ({
    ...extraction(null),
    lineItems: qtys.map((qty) => ({ title: "Standard Repair", qty, amountCents: 115000, descriptionComponents: [], componentPricesCents: [] })),
    totals: { subtotalCents: 230000, totalCents: 230000, amountPaidCents: null, balanceDueCents: 230000 },
  });
  const repeatedLabels = (qtys: Array<number | null>): DocumentLabels => ({
    ...base,
    lineItems: qtys.map((qty) => ({ title: "Standard Repair", qty, amountCents: 115000, descriptionComponents: [] })),
    totals: { subtotalCents: 230000, totalCents: 230000, amountPaidCents: null, balanceDueCents: 230000 },
  });

  it("matches repeated title/amount lines independent of order (numeric quantities)", async () => {
    for (const [want, got] of [
      [[1, 2], [2, 1]],
      [[1, 2], [1, 2]],
      [[2, 1, 2], [2, 2, 1]],
    ] as Array<[number[], number[]]>) {
      expect(await scoreDocumentExtraction(repeatedLabels(want), repeated(got), new FakeJudge())).toMatchObject({
        lineItems: { matched: want.length, quantitiesCorrect: want.length, quantityMismatches: 0, inventedQuantities: 0, inventedLineItems: 0 },
      });
    }
  });

  it("matches repeated lines independent of order (numeric and null quantities)", async () => {
    expect(await scoreDocumentExtraction(repeatedLabels([1, null]), repeated([null, 1]), new FakeJudge())).toMatchObject({
      lineItems: { matched: 2, quantitiesCorrect: 2, quantityMismatches: 0, inventedQuantities: 0 },
    });
  });

  it("still reports true mismatches and invented quantities among repeated lines", async () => {
    expect(await scoreDocumentExtraction(repeatedLabels([1, 2]), repeated([2, 3]), new FakeJudge())).toMatchObject({
      lineItems: { matched: 1, quantitiesCorrect: 1, quantityMismatches: 1, inventedQuantities: 0, inventedLineItems: 0 },
    });
    expect(await scoreDocumentExtraction(repeatedLabels([1, null]), repeated([1, 4]), new FakeJudge())).toMatchObject({
      lineItems: { matched: 1, quantityMismatches: 0, inventedQuantities: 1 },
    });
    expect(await scoreDocumentExtraction(repeatedLabels([1, 2]), repeated([null, 2]), new FakeJudge())).toMatchObject({
      lineItems: { matched: 1, quantityMismatches: 1, inventedQuantities: 0 },
    });
  });

  it("matches when the stated quantity agrees", async () => {
    expect(await scoreDocumentExtraction(base, extraction(1), new FakeJudge())).toMatchObject({
      lineItems: { matched: 1, quantitiesCorrect: 1, quantityMismatches: 0, inventedQuantities: 0 },
    });
  });
});

describe("scoreAssistantCase", () => {
  it("checks tool selection, required facts and forbidden behaviors", async () => {
    const score = await scoreAssistantCase(
      makeAssistantCase(),
      {
        toolCalls: [
          { name: "get_stale_leads", args: { days: 3 } },
          { name: "get_pipeline_snapshot", args: {} },
        ],
        answer: "You have three stale leads. FORBIDDEN:claims a reminder was sent",
      },
      new FakeJudge(),
    );
    expect(score.tools).toMatchObject({ missing: [], unexpected: [], correct: true });
    expect(score.facts).toEqual({ required: 2, present: 1, missingIds: ["fact-b"] });
    expect(score.forbidden.violations.map((v) => v.id)).toEqual(["forbid-sent"]);
  });

  it("marks unexpected and missing tools as incorrect selection", async () => {
    const score = await scoreAssistantCase(
      makeAssistantCase(),
      { toolCalls: [{ name: "get_revenue_summary", args: null }], answer: "" },
      new FakeJudge(),
    );
    expect(score.tools).toMatchObject({ missing: ["get_stale_leads"], unexpected: ["get_revenue_summary"], correct: false });
  });
});

describe("judge calibration", () => {
  it("computes Cohen's kappa", () => {
    expect(cohensKappa({ truePositive: 5, falsePositive: 0, falseNegative: 0, trueNegative: 5 })).toBe(1);
    expect(cohensKappa({ truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0 })).toBeNull();
    // po = 0.7, pe = 0.5 → kappa 0.4
    expect(cohensKappa({ truePositive: 4, falsePositive: 2, falseNegative: 1, trueNegative: 3 })).toBeCloseTo(0.4, 5);
  });

  it("flags a judge below 90% human agreement as uncalibrated", async () => {
    const provenance = { status: "research-draft" as const, labeledBy: "x-reviewer", labeledAt: "2026-10-11", reviewerRole: "draft" };
    const pairs = [
      { id: "p-one", expected: { statement: "eleven hits" }, finding: { statement: "eleven hits on west" }, humanVerdict: "match" as const, rationale: "r", labelProvenance: provenance },
      { id: "p-two", expected: { statement: "eleven hits" }, finding: { statement: "11 hits on west" }, humanVerdict: "match" as const, rationale: "r", labelProvenance: provenance },
      { id: "p-three", expected: { statement: "nine hits" }, finding: { statement: "some hits" }, humanVerdict: "no-match" as const, rationale: "r", labelProvenance: provenance },
    ];
    const report = await calibrateJudge(pairs, new FakeJudge());
    expect(report.confusion).toEqual({ truePositive: 1, falsePositive: 0, falseNegative: 1, trueNegative: 1 });
    expect(report.agreement).toBeCloseTo(2 / 3, 5);
    expect(report.calibrated).toBe(false);
    expect(report.disagreementIds).toEqual(["p-two"]);
    expect(report.humanVerifiedPairs).toBe(0);
  });
});
