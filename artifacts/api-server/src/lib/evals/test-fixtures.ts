/** Shared in-memory fixtures for the eval harness unit tests. Not used at runtime. */
import type { Judge, JudgeCandidate, JudgeExpectation, JudgeRule } from "./judge";
import {
  assistantCaseSchema,
  evidenceCaseSchema,
  type AssistantEvalCase,
  type EvalDraft,
  type EvidenceEvalCase,
} from "./schemas";

/** Deterministic judge: a candidate matches when it contains the expected statement verbatim. */
export class FakeJudge implements Judge {
  readonly kind = "fake" as const;
  readonly version = "fake-v1";
  readonly model = null;
  calls = 0;

  async judgeMatch(expected: JudgeExpectation, candidates: JudgeCandidate[]) {
    this.calls += 1;
    const hit = candidates.find((candidate) => candidate.text.toLowerCase().includes(expected.statement.toLowerCase()));
    return { matchedIndex: hit ? hit.index : null, rationale: hit ? "contains" : "absent" };
  }

  async judgeForbidden(rule: JudgeRule, text: string) {
    this.calls += 1;
    return { violated: text.includes(`FORBIDDEN:${rule.description}`), rationale: "marker" };
  }

  async judgeFactPresent(fact: JudgeExpectation, text: string) {
    this.calls += 1;
    return { present: text.toLowerCase().includes(fact.statement.toLowerCase()), rationale: "contains" };
  }
}

export function makeEvidenceCase(overrides: Partial<EvidenceEvalCase> & { verified?: boolean } = {}): EvidenceEvalCase {
  const { verified, ...rest } = overrides;
  return evidenceCaseSchema.parse({
    id: "case-one",
    kind: "evidence",
    trade: "roofing",
    workflow: "test#workflow",
    tags: [],
    caseSummary: "Synthetic test case.",
    artifacts: [
      { alias: "E1", filename: "a.txt", mimeType: "text/plain", sourceLabel: "test", text: "alpha" },
      { alias: "E2", filename: "b.txt", mimeType: "text/plain", sourceLabel: "test", text: "beta" },
    ],
    labels: {
      expectedObservations: [
        { id: "obs-a", statement: "west slope has 11 hits", category: "hail", critical: true, supportingAliases: ["E1"] },
        { id: "obs-b", statement: "south slope has 9 hits", category: "hail", critical: true, supportingAliases: ["E1"] },
        { id: "obs-c", statement: "gutter dents", category: "metal", critical: false, supportingAliases: ["E2"] },
        { id: "obs-d", statement: "canopy has no hits", category: "hail", critical: false, supportingAliases: ["E1"] },
      ],
      expectedConflicts: [{ id: "conf-a", description: "dates differ", aliases: ["E1", "E2"] }],
      expectedGaps: [{ id: "gap-a", description: "no photos" }, { id: "gap-b", description: "no weather" }],
      forbiddenClaims: [{ id: "forbid-a", description: "coverage decision" }],
    },
    labelProvenance: verified
      ? { status: "contractor-verified", labeledBy: "roof-reviewer-1", labeledAt: "2026-10-12", reviewerRole: "roofing estimator" }
      : { status: "research-draft", labeledBy: "growthos-eval-research", labeledAt: "2026-10-11", reviewerRole: "engineering research draft" },
    ...rest,
  });
}

export function finding(statement: string, aliases: string[] = ["E1"]): EvalDraft["findings"][number] {
  return {
    category: "test",
    statement,
    citations: aliases.map((artifactId) => ({ artifactId, locator: "line 1", basis: "text", strength: "direct" })),
    confidence: 80,
    needsHumanReview: true,
  };
}

export function makeDraft(partial: Partial<EvalDraft> = {}): EvalDraft {
  return {
    executiveSummary: "summary",
    findings: [],
    conflicts: [],
    gaps: [],
    limitations: [],
    recommendedNextSteps: [],
    ...partial,
  };
}

export function makeAssistantCase(overrides: Partial<AssistantEvalCase> = {}): AssistantEvalCase {
  return assistantCaseSchema.parse({
    id: "asst-one",
    trade: "hvac",
    workflow: "test#assistant",
    orgName: null,
    question: "How many stale leads?",
    toolFixtures: { get_stale_leads: { count: 3 } },
    expectedTools: ["get_stale_leads"],
    optionalTools: ["get_pipeline_snapshot"],
    requiredFacts: [
      { id: "fact-a", statement: "three stale leads" },
      { id: "fact-b", statement: "top lead is worth $4,200" },
    ],
    forbiddenBehaviors: [{ id: "forbid-sent", description: "claims a reminder was sent" }],
    labelProvenance: { status: "research-draft", labeledBy: "growthos-eval-research", labeledAt: "2026-10-11", reviewerRole: "engineering research draft" },
    ...overrides,
  });
}
