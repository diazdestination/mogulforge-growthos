/**
 * Pure scorers for the contractor eval harness.
 *
 * Contractor agreement is ONLY reported from `contractor-verified` cases.
 * Research-draft labels are scored in a separate cohort so developers get a
 * signal without anyone mistaking it for a contractor benchmark.
 */
import type { Judge } from "./judge";
import type {
  AssistantEvalCase,
  AssistantOutput,
  CalibrationPair,
  DocumentExtraction,
  DocumentLabels,
  EvalDraft,
  EvidenceEvalCase,
} from "./schemas";
import { normalizeText, tokenCoverage } from "./text";

export const QUALITY_TARGET = {
  observationAgreementMin: 0.95,
  criticalOmissionMax: 0.05,
  minContractorVerifiedCases: 20,
  judgeAgreementMin: 0.9,
} as const;

export type Cohort = "contractorVerified" | "researchDraft";

export function cohortOf(status: "research-draft" | "contractor-verified"): Cohort {
  return status === "contractor-verified" ? "contractorVerified" : "researchDraft";
}

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

/* ------------------------------------------------------- document scoring */

export type DocumentScore =
  | { status: "not-run"; reason: string }
  | {
      status: "scored";
      lineItems: {
        expected: number;
        /** Title, amount and quantity all agree. */
        matched: number;
        quantitiesCorrect: number;
        /** Title and amount agree but a stated quantity differs (or is missing). */
        quantityMismatches: number;
        /** A quantity was extracted where the document states none. */
        inventedQuantities: number;
        componentsExpected: number;
        componentsMatched: number;
        inventedLineItems: number;
        inventedComponentPrices: number;
      };
      totals: { checked: number; correct: number; invented: number };
      extractedTotalsReconcile: boolean | null;
      paymentTermsCorrect: boolean;
      warranty: { presenceCorrect: boolean; termsExpected: number; termsMatched: number };
      flags: { expected: number; detected: number; missedIds: string[] };
    };

const TOTAL_KEYS = ["subtotalCents", "totalCents", "amountPaidCents", "balanceDueCents"] as const;

export async function scoreDocumentExtraction(
  labels: DocumentLabels,
  extraction: DocumentExtraction | null,
  judge: Judge,
): Promise<DocumentScore> {
  if (!extraction) {
    return { status: "not-run", reason: "No document extraction output was recorded for this case." };
  }

  const remaining = extraction.lineItems.map((item, index) => ({ item, index }));
  let matched = 0;
  let quantitiesCorrect = 0;
  let quantityMismatches = 0;
  let inventedQuantities = 0;
  let componentsExpected = 0;
  let componentsMatched = 0;
  for (const expected of labels.lineItems) {
    componentsExpected += expected.descriptionComponents.length;
    const position = remaining.findIndex(
      ({ item }) =>
        item.amountCents === expected.amountCents &&
        (normalizeText(item.title) === normalizeText(expected.title) ||
          tokenCoverage(expected.title, item.title) >= 0.6),
    );
    if (position === -1) continue;
    const [{ item }] = remaining.splice(position, 1);
    // A line counts as matched only when its quantity also agrees. A quantity on a
    // document that states none is invented; a different stated quantity is a mismatch.
    if (expected.qty === null) {
      if (item.qty === null) {
        matched += 1;
        quantitiesCorrect += 1;
      } else {
        inventedQuantities += 1;
      }
    } else if (item.qty === expected.qty) {
      matched += 1;
      quantitiesCorrect += 1;
    } else {
      quantityMismatches += 1;
    }
    for (const component of expected.descriptionComponents) {
      if (item.descriptionComponents.some((candidate) => tokenCoverage(component, candidate) >= 0.6)) {
        componentsMatched += 1;
      }
    }
  }
  const inventedComponentPrices = extraction.lineItems.reduce(
    (sum, item) => sum + item.componentPricesCents.length,
    0,
  );

  let checked = 0;
  let correct = 0;
  let invented = 0;
  for (const key of TOTAL_KEYS) {
    const want = labels.totals[key];
    const have = extraction.totals[key];
    if (want === null) {
      if (have !== null) invented += 1;
      continue;
    }
    checked += 1;
    if (have === want) correct += 1;
  }

  const amounts = extraction.lineItems.map((item) => item.amountCents);
  const extractedTotalsReconcile =
    extraction.totals.subtotalCents === null || amounts.some((amount) => amount === null)
      ? null
      : amounts.reduce<number>((sum, amount) => sum + (amount ?? 0), 0) === extraction.totals.subtotalCents;

  const paymentTermsCorrect =
    labels.paymentTerms === null
      ? extraction.paymentTerms === null
      : extraction.paymentTerms !== null &&
        tokenCoverage(labels.paymentTerms, extraction.paymentTerms) >= 0.6;

  let termsMatched = 0;
  for (const term of labels.warranty.terms) {
    if (extraction.warranty.terms.some((candidate) => tokenCoverage(term, candidate) >= 0.6)) termsMatched += 1;
  }

  const flagCandidates = extraction.flags.map((text, index) => ({ index, text }));
  const missedIds: string[] = [];
  let detected = 0;
  for (const flag of labels.flags) {
    const verdict = await judge.judgeMatch({ statement: flag.description, keyTerms: flag.keyTerms }, flagCandidates);
    if (verdict.matchedIndex === null) missedIds.push(flag.id);
    else detected += 1;
  }

  return {
    status: "scored",
    lineItems: {
      expected: labels.lineItems.length,
      matched,
      quantitiesCorrect,
      quantityMismatches,
      inventedQuantities,
      componentsExpected,
      componentsMatched,
      inventedLineItems: remaining.length,
      inventedComponentPrices,
    },
    totals: { checked, correct, invented },
    extractedTotalsReconcile,
    paymentTermsCorrect,
    warranty: {
      presenceCorrect: labels.warranty.present === extraction.warranty.present,
      termsExpected: labels.warranty.terms.length,
      termsMatched,
    },
    flags: { expected: labels.flags.length, detected, missedIds },
  };
}

/* ------------------------------------------------------- evidence scoring */

export type EvidenceCaseScore = {
  caseId: string;
  kind: EvidenceEvalCase["kind"];
  trade: EvidenceEvalCase["trade"];
  cohort: Cohort;
  status: "scored" | "model-error";
  error?: string;
  observations: {
    expected: number;
    matched: number;
    matchedWithSupportingCitation: number;
    criticalExpected: number;
    criticalMissed: number;
    details: Array<{
      id: string;
      critical: boolean;
      matchedFindingIndex: number | null;
      citesSupportingAlias: boolean;
      rationale: string;
    }>;
  };
  findings: { total: number; unmatched: number; unmatchedIndexes: number[] };
  citations: { total: number; allowlistViolations: number; invalidAliases: string[] };
  conflicts: { expected: number; detected: number; missedIds: string[] };
  gaps: { expected: number; detected: number; missedIds: string[] };
  forbidden: { checked: number; violations: Array<{ id: string; rationale: string }> };
  document?: DocumentScore;
};

export function draftText(draft: EvalDraft): string {
  return [
    draft.executiveSummary,
    ...draft.findings.map((finding) => `${finding.category}: ${finding.statement}`),
    ...draft.conflicts.map((conflict) => conflict.summary),
    ...draft.gaps.map((gap) => `${gap.title}. ${gap.reason}. ${gap.recommendedAction}`),
    ...draft.limitations,
    ...draft.recommendedNextSteps,
  ].join("\n");
}

export async function scoreEvidenceCase(
  evalCase: EvidenceEvalCase,
  output: { draft: EvalDraft | null; error?: string; documentExtraction?: DocumentExtraction | null },
  judge: Judge,
): Promise<EvidenceCaseScore> {
  const { labels } = evalCase;
  const cohort = cohortOf(evalCase.labelProvenance.status);
  const allowlist = new Set(evalCase.artifacts.map((artifact) => artifact.alias));
  const criticalExpected = labels.expectedObservations.filter((item) => item.critical).length;
  const base = {
    caseId: evalCase.id,
    kind: evalCase.kind,
    trade: evalCase.trade,
    cohort,
  };

  const document = labels.document
    ? await scoreDocumentExtraction(labels.document, output.documentExtraction ?? null, judge)
    : undefined;

  const draft = output.draft;
  if (!draft) {
    // A model failure counts as missing every expected item: conservative by design.
    return {
      ...base,
      status: "model-error",
      error: output.error ?? "no draft",
      observations: {
        expected: labels.expectedObservations.length,
        matched: 0,
        matchedWithSupportingCitation: 0,
        criticalExpected,
        criticalMissed: criticalExpected,
        details: labels.expectedObservations.map((item) => ({
          id: item.id,
          critical: item.critical,
          matchedFindingIndex: null,
          citesSupportingAlias: false,
          rationale: "model produced no draft",
        })),
      },
      findings: { total: 0, unmatched: 0, unmatchedIndexes: [] },
      citations: { total: 0, allowlistViolations: 0, invalidAliases: [] },
      conflicts: { expected: labels.expectedConflicts.length, detected: 0, missedIds: labels.expectedConflicts.map((c) => c.id) },
      gaps: { expected: labels.expectedGaps.length, detected: 0, missedIds: labels.expectedGaps.map((g) => g.id) },
      forbidden: { checked: 0, violations: [] },
      ...(document ? { document } : {}),
    };
  }

  // Critical observations claim findings first so a shared finding is credited where it matters most.
  const ordered = [...labels.expectedObservations].sort((a, b) => Number(b.critical) - Number(a.critical));
  const available = new Map(
    draft.findings.map((finding, index) => [index, `${finding.category}: ${finding.statement}`] as const),
  );
  const details: EvidenceCaseScore["observations"]["details"] = [];
  for (const expected of ordered) {
    const verdict = await judge.judgeMatch(
      { statement: expected.statement, keyTerms: expected.keyTerms },
      [...available].map(([index, text]) => ({ index, text })),
    );
    const index = verdict.matchedIndex !== null && available.has(verdict.matchedIndex) ? verdict.matchedIndex : null;
    if (index !== null) available.delete(index);
    const citesSupportingAlias =
      index !== null &&
      draft.findings[index].citations.some((citation) => expected.supportingAliases.includes(citation.artifactId));
    details.push({
      id: expected.id,
      critical: expected.critical,
      matchedFindingIndex: index,
      citesSupportingAlias,
      rationale: verdict.rationale,
    });
  }
  const matched = details.filter((detail) => detail.matchedFindingIndex !== null);

  const citationAliases = [
    ...draft.findings.flatMap((finding) => finding.citations.map((citation) => citation.artifactId)),
    ...draft.conflicts.flatMap((conflict) => conflict.artifactIds),
  ];
  const invalidAliases = [...new Set(citationAliases.filter((value) => !allowlist.has(value)))];

  const conflictCandidates = draft.conflicts.map((conflict, index) => ({ index, text: conflict.summary }));
  const conflictMissed: string[] = [];
  for (const expected of labels.expectedConflicts) {
    const verdict = await judge.judgeMatch({ statement: expected.description, keyTerms: expected.keyTerms }, conflictCandidates);
    const hit =
      verdict.matchedIndex !== null &&
      expected.aliases.filter((value) => draft.conflicts[verdict.matchedIndex!]?.artifactIds.includes(value)).length >= 2;
    if (!hit) conflictMissed.push(expected.id);
  }

  const gapCandidates = draft.gaps.map((gap, index) => ({
    index,
    text: `${gap.title}. ${gap.reason}. ${gap.recommendedAction}`,
  }));
  const gapMissed: string[] = [];
  for (const expected of labels.expectedGaps) {
    const verdict = await judge.judgeMatch({ statement: expected.description, keyTerms: expected.keyTerms }, gapCandidates);
    if (verdict.matchedIndex === null) gapMissed.push(expected.id);
  }

  const fullText = draftText(draft);
  const violations: EvidenceCaseScore["forbidden"]["violations"] = [];
  for (const rule of labels.forbiddenClaims) {
    const verdict = await judge.judgeForbidden(rule, fullText);
    if (verdict.violated) violations.push({ id: rule.id, rationale: verdict.rationale });
  }

  return {
    ...base,
    status: "scored",
    observations: {
      expected: labels.expectedObservations.length,
      matched: matched.length,
      matchedWithSupportingCitation: matched.filter((detail) => detail.citesSupportingAlias).length,
      criticalExpected,
      criticalMissed: details.filter((detail) => detail.critical && detail.matchedFindingIndex === null).length,
      details,
    },
    findings: {
      total: draft.findings.length,
      unmatched: available.size,
      unmatchedIndexes: [...available.keys()],
    },
    citations: {
      total: citationAliases.length,
      allowlistViolations: citationAliases.filter((value) => !allowlist.has(value)).length,
      invalidAliases,
    },
    conflicts: {
      expected: labels.expectedConflicts.length,
      detected: labels.expectedConflicts.length - conflictMissed.length,
      missedIds: conflictMissed,
    },
    gaps: {
      expected: labels.expectedGaps.length,
      detected: labels.expectedGaps.length - gapMissed.length,
      missedIds: gapMissed,
    },
    forbidden: { checked: labels.forbiddenClaims.length, violations },
    ...(document ? { document } : {}),
  };
}

export type EvidenceCohortSummary = {
  cases: number;
  modelErrors: number;
  observationsExpected: number;
  observationsMatched: number;
  observationAgreement: number | null;
  supportingCitationRate: number | null;
  criticalExpected: number;
  criticalMissed: number;
  criticalOmissionRate: number | null;
  findingsTotal: number;
  findingsUnmatched: number;
  findingPrecision: number | null;
  citationsTotal: number;
  citationAllowlistViolations: number;
  citationValidity: number | null;
  conflictRecall: number | null;
  gapRecall: number | null;
  forbiddenViolations: number;
  casesWithForbiddenViolation: number;
};

export function summarizeEvidence(scores: EvidenceCaseScore[]): EvidenceCohortSummary {
  const sum = (pick: (score: EvidenceCaseScore) => number) => scores.reduce((total, score) => total + pick(score), 0);
  const observationsExpected = sum((s) => s.observations.expected);
  const observationsMatched = sum((s) => s.observations.matched);
  const criticalExpected = sum((s) => s.observations.criticalExpected);
  const criticalMissed = sum((s) => s.observations.criticalMissed);
  const findingsTotal = sum((s) => s.findings.total);
  const findingsUnmatched = sum((s) => s.findings.unmatched);
  const citationsTotal = sum((s) => s.citations.total);
  const citationAllowlistViolations = sum((s) => s.citations.allowlistViolations);
  return {
    cases: scores.length,
    modelErrors: scores.filter((s) => s.status === "model-error").length,
    observationsExpected,
    observationsMatched,
    observationAgreement: ratio(observationsMatched, observationsExpected),
    supportingCitationRate: ratio(sum((s) => s.observations.matchedWithSupportingCitation), observationsMatched),
    criticalExpected,
    criticalMissed,
    criticalOmissionRate: ratio(criticalMissed, criticalExpected),
    findingsTotal,
    findingsUnmatched,
    findingPrecision: ratio(findingsTotal - findingsUnmatched, findingsTotal),
    citationsTotal,
    citationAllowlistViolations,
    citationValidity: ratio(citationsTotal - citationAllowlistViolations, citationsTotal),
    conflictRecall: ratio(sum((s) => s.conflicts.detected), sum((s) => s.conflicts.expected)),
    gapRecall: ratio(sum((s) => s.gaps.detected), sum((s) => s.gaps.expected)),
    forbiddenViolations: sum((s) => s.forbidden.violations.length),
    casesWithForbiddenViolation: scores.filter((s) => s.forbidden.violations.length > 0).length,
  };
}

export type DocumentSummary = {
  cases: number;
  notRun: number;
  lineItemRecall: number | null;
  quantityMismatches: number;
  inventedQuantities: number;
  componentRecall: number | null;
  inventedLineItems: number;
  inventedComponentPrices: number;
  totalsAccuracy: number | null;
  inventedTotals: number;
  flagRecall: number | null;
};

export function summarizeDocuments(scores: EvidenceCaseScore[]): DocumentSummary {
  const documents = scores.map((score) => score.document).filter((value): value is DocumentScore => Boolean(value));
  const scored = documents.filter((value): value is Extract<DocumentScore, { status: "scored" }> => value.status === "scored");
  const sum = (pick: (score: (typeof scored)[number]) => number) => scored.reduce((total, score) => total + pick(score), 0);
  return {
    cases: documents.length,
    notRun: documents.length - scored.length,
    lineItemRecall: ratio(sum((s) => s.lineItems.matched), sum((s) => s.lineItems.expected)),
    quantityMismatches: sum((s) => s.lineItems.quantityMismatches),
    inventedQuantities: sum((s) => s.lineItems.inventedQuantities),
    componentRecall: ratio(sum((s) => s.lineItems.componentsMatched), sum((s) => s.lineItems.componentsExpected)),
    inventedLineItems: sum((s) => s.lineItems.inventedLineItems),
    inventedComponentPrices: sum((s) => s.lineItems.inventedComponentPrices),
    totalsAccuracy: ratio(sum((s) => s.totals.correct), sum((s) => s.totals.checked)),
    inventedTotals: sum((s) => s.totals.invented),
    flagRecall: ratio(sum((s) => s.flags.detected), sum((s) => s.flags.expected)),
  };
}

/* ------------------------------------------------------ assistant scoring */

export type AssistantCaseScore = {
  caseId: string;
  cohort: Cohort;
  status: "scored" | "model-error";
  error?: string;
  tools: { expected: string[]; called: string[]; missing: string[]; unexpected: string[]; correct: boolean };
  facts: { required: number; present: number; missingIds: string[] };
  forbidden: { checked: number; violations: Array<{ id: string; rationale: string }> };
};

export async function scoreAssistantCase(
  evalCase: AssistantEvalCase,
  output: AssistantOutput | null,
  judge: Judge,
  error?: string,
): Promise<AssistantCaseScore> {
  const cohort = cohortOf(evalCase.labelProvenance.status);
  if (!output) {
    return {
      caseId: evalCase.id,
      cohort,
      status: "model-error",
      error: error ?? "no answer",
      tools: { expected: evalCase.expectedTools, called: [], missing: evalCase.expectedTools, unexpected: [], correct: false },
      facts: { required: evalCase.requiredFacts.length, present: 0, missingIds: evalCase.requiredFacts.map((f) => f.id) },
      forbidden: { checked: 0, violations: [] },
    };
  }
  const called = [...new Set(output.toolCalls.map((call) => call.name))];
  const allowed = new Set<string>([...evalCase.expectedTools, ...evalCase.optionalTools]);
  const missing = evalCase.expectedTools.filter((tool) => !called.includes(tool));
  const unexpected = called.filter((tool) => !allowed.has(tool));

  const missingIds: string[] = [];
  for (const fact of evalCase.requiredFacts) {
    const verdict = await judge.judgeFactPresent({ statement: fact.statement, keyTerms: fact.keyTerms }, output.answer);
    if (!verdict.present) missingIds.push(fact.id);
  }
  const violations: AssistantCaseScore["forbidden"]["violations"] = [];
  for (const rule of evalCase.forbiddenBehaviors) {
    const verdict = await judge.judgeForbidden(rule, output.answer);
    if (verdict.violated) violations.push({ id: rule.id, rationale: verdict.rationale });
  }
  return {
    caseId: evalCase.id,
    cohort,
    status: "scored",
    tools: {
      expected: evalCase.expectedTools,
      called,
      missing,
      unexpected,
      correct: missing.length === 0 && unexpected.length === 0,
    },
    facts: {
      required: evalCase.requiredFacts.length,
      present: evalCase.requiredFacts.length - missingIds.length,
      missingIds,
    },
    forbidden: { checked: evalCase.forbiddenBehaviors.length, violations },
  };
}

export type AssistantCohortSummary = {
  cases: number;
  modelErrors: number;
  toolSelectionAccuracy: number | null;
  requiredFactCoverage: number | null;
  forbiddenBehaviorViolations: number;
  casesWithForbiddenBehavior: number;
};

export function summarizeAssistant(scores: AssistantCaseScore[]): AssistantCohortSummary {
  const required = scores.reduce((total, score) => total + score.facts.required, 0);
  const present = scores.reduce((total, score) => total + score.facts.present, 0);
  return {
    cases: scores.length,
    modelErrors: scores.filter((score) => score.status === "model-error").length,
    toolSelectionAccuracy: ratio(scores.filter((score) => score.tools.correct).length, scores.length),
    requiredFactCoverage: ratio(present, required),
    forbiddenBehaviorViolations: scores.reduce((total, score) => total + score.forbidden.violations.length, 0),
    casesWithForbiddenBehavior: scores.filter((score) => score.forbidden.violations.length > 0).length,
  };
}

/* ------------------------------------------------------ judge calibration */

export type CalibrationReport = {
  judgeKind: Judge["kind"];
  judgeVersion: string;
  pairs: number;
  humanVerifiedPairs: number;
  agreement: number | null;
  cohensKappa: number | null;
  confusion: { truePositive: number; falsePositive: number; falseNegative: number; trueNegative: number };
  disagreementIds: string[];
  threshold: number;
  calibrated: boolean;
};

export function cohensKappa(confusion: CalibrationReport["confusion"]): number | null {
  const { truePositive: tp, falsePositive: fp, falseNegative: fn, trueNegative: tn } = confusion;
  const n = tp + fp + fn + tn;
  if (n === 0) return null;
  const observed = (tp + tn) / n;
  const humanYes = (tp + fn) / n;
  const judgeYes = (tp + fp) / n;
  const expected = humanYes * judgeYes + (1 - humanYes) * (1 - judgeYes);
  if (expected === 1) return observed === 1 ? 1 : 0;
  return (observed - expected) / (1 - expected);
}

export async function calibrateJudge(pairs: CalibrationPair[], judge: Judge): Promise<CalibrationReport> {
  const confusion = { truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0 };
  const disagreementIds: string[] = [];
  for (const pair of pairs) {
    const verdict = await judge.judgeMatch(pair.expected, [{ index: 0, text: pair.finding.statement }]);
    const judgeSaysMatch = verdict.matchedIndex === 0;
    const humanSaysMatch = pair.humanVerdict === "match";
    if (judgeSaysMatch && humanSaysMatch) confusion.truePositive += 1;
    else if (judgeSaysMatch) confusion.falsePositive += 1;
    else if (humanSaysMatch) confusion.falseNegative += 1;
    else confusion.trueNegative += 1;
    if (judgeSaysMatch !== humanSaysMatch) disagreementIds.push(pair.id);
  }
  const agreement = ratio(pairs.length - disagreementIds.length, pairs.length);
  return {
    judgeKind: judge.kind,
    judgeVersion: judge.version,
    pairs: pairs.length,
    humanVerifiedPairs: pairs.filter((pair) => pair.labelProvenance.status === "contractor-verified").length,
    agreement,
    cohensKappa: cohensKappa(confusion),
    confusion,
    disagreementIds,
    threshold: QUALITY_TARGET.judgeAgreementMin,
    calibrated: agreement !== null && agreement >= QUALITY_TARGET.judgeAgreementMin,
  };
}

/* ------------------------------------------------------------ quality gate */

export type QualityGate = {
  target: number;
  criticalOmissionMax: number;
  minContractorVerifiedCases: number;
  contractorVerifiedCases: number;
  observationAgreement: number | null;
  criticalOmissionRate: number | null;
  status: "passed" | "failed" | "not-measurable";
  reasons: string[];
};

export function evaluateQualityGate(
  contractorVerified: EvidenceCohortSummary,
  calibration: CalibrationReport | null,
): QualityGate {
  const gate = {
    target: QUALITY_TARGET.observationAgreementMin,
    criticalOmissionMax: QUALITY_TARGET.criticalOmissionMax,
    minContractorVerifiedCases: QUALITY_TARGET.minContractorVerifiedCases,
    contractorVerifiedCases: contractorVerified.cases,
    observationAgreement: contractorVerified.observationAgreement,
    criticalOmissionRate: contractorVerified.criticalOmissionRate,
  };
  const notMeasurable: string[] = [];
  if (contractorVerified.cases < QUALITY_TARGET.minContractorVerifiedCases) {
    notMeasurable.push(
      `Only ${contractorVerified.cases} contractor-verified cases; at least ${QUALITY_TARGET.minContractorVerifiedCases} are required.`,
    );
  }
  if (!calibration) {
    notMeasurable.push("The judge was not calibrated against human verdicts in this run.");
  } else {
    if (!calibration.calibrated) {
      notMeasurable.push(
        `Judge is uncalibrated: human agreement ${calibration.agreement === null ? "n/a" : calibration.agreement.toFixed(3)} < ${calibration.threshold}.`,
      );
    }
    if (calibration.humanVerifiedPairs < calibration.pairs) {
      notMeasurable.push(
        `${calibration.pairs - calibration.humanVerifiedPairs} of ${calibration.pairs} calibration verdicts are research drafts, not contractor-verified.`,
      );
    }
  }
  if (contractorVerified.observationAgreement === null || contractorVerified.criticalOmissionRate === null) {
    notMeasurable.push("Contractor-verified cases contain no expected observations or no critical observations.");
  }
  if (notMeasurable.length > 0) return { ...gate, status: "not-measurable", reasons: notMeasurable };

  const failures: string[] = [];
  if ((contractorVerified.observationAgreement ?? 0) < QUALITY_TARGET.observationAgreementMin) {
    failures.push(`Observation agreement ${contractorVerified.observationAgreement!.toFixed(3)} is below ${QUALITY_TARGET.observationAgreementMin}.`);
  }
  if ((contractorVerified.criticalOmissionRate ?? 1) > QUALITY_TARGET.criticalOmissionMax) {
    failures.push(`Critical omission rate ${contractorVerified.criticalOmissionRate!.toFixed(3)} exceeds ${QUALITY_TARGET.criticalOmissionMax}.`);
  }
  if (contractorVerified.citationAllowlistViolations > 0) {
    failures.push(`${contractorVerified.citationAllowlistViolations} citations fall outside the run allowlist.`);
  }
  return failures.length > 0
    ? { ...gate, status: "failed", reasons: failures }
    : { ...gate, status: "passed", reasons: [] };
}

export type ContractorEvalReport = {
  evidence: { contractorVerified: EvidenceCohortSummary; researchDraft: EvidenceCohortSummary };
  documents: { contractorVerified: DocumentSummary; researchDraft: DocumentSummary };
  assistant: { contractorVerified: AssistantCohortSummary; researchDraft: AssistantCohortSummary };
  calibration: CalibrationReport | null;
  gate: QualityGate;
  notice: string;
};

export function buildReport(input: {
  evidenceScores: EvidenceCaseScore[];
  assistantScores: AssistantCaseScore[];
  calibration: CalibrationReport | null;
}): ContractorEvalReport {
  const byCohort = <T extends { cohort: Cohort }>(scores: T[], cohort: Cohort) =>
    scores.filter((score) => score.cohort === cohort);
  const verifiedEvidence = summarizeEvidence(byCohort(input.evidenceScores, "contractorVerified"));
  const gate = evaluateQualityGate(verifiedEvidence, input.calibration);
  return {
    evidence: {
      contractorVerified: verifiedEvidence,
      researchDraft: summarizeEvidence(byCohort(input.evidenceScores, "researchDraft")),
    },
    documents: {
      contractorVerified: summarizeDocuments(byCohort(input.evidenceScores, "contractorVerified")),
      researchDraft: summarizeDocuments(byCohort(input.evidenceScores, "researchDraft")),
    },
    assistant: {
      contractorVerified: summarizeAssistant(byCohort(input.assistantScores, "contractorVerified")),
      researchDraft: summarizeAssistant(byCohort(input.assistantScores, "researchDraft")),
    },
    calibration: input.calibration,
    gate,
    notice:
      "Contractor agreement is reported only from contractor-verified cases. Research-draft figures are a development signal, not a contractor benchmark.",
  };
}
