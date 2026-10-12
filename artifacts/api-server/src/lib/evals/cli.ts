/**
 * Contractor eval harness command logic. Production model calls, the OpenAI
 * judge and the clock are injected so every mode is unit-testable without a
 * network; `src/evals/contractor-eval-runner.ts` wires the real dependencies.
 *
 * Modes (exactly one; `--live` may be combined with `--replay`):
 *   --check                    Validate the dataset and calibrate the lexical judge. Offline.
 *   --replay <file> [--write]  Rescore a recorded run offline with the lexical judge.
 *   --live                     Generate outputs with the real agents, persist them, then score.
 *   --live --replay <file>     Rescore a recording with a paid judge without regenerating.
 *   --export-labels <dir>      Write a contractor label sheet (CSV) and review packet (Markdown).
 *   --import-labels <csv>      Apply a completed sheet (needs --reviewer-role, --labeled-by, --reviewed-at).
 *
 * The OpenAI judge (`--judge openai`) is only constructed inside an admitted
 * live mode: OPENAI_API_KEY present and not under CI. Offline modes never
 * create it, so they can never make a paid request.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { DATASET_FILES, loadContractorDataset, type ContractorDataset } from "./dataset";
import { LexicalJudge, OpenAiJudgeError, type Judge } from "./judge";
import { applyLabelSheet, exportLabelSheet } from "./labeling";
import {
  RECORDING_SCHEMA_VERSION,
  contractorEvalRecordingSchema,
  scoreOutputs,
  type AssistantOutputRecord,
  type ContractorEvalRecording,
  type EvidenceOutputRecord,
  type ScoredRun,
} from "./recording";
import { calibrateJudge, QUALITY_TARGET } from "./scoring";
import type { AssistantEvalCase, EvidenceEvalCase } from "./schemas";

export type ContractorEvalCliDeps = {
  runEvidenceCase: (evalCase: EvidenceEvalCase) => Promise<EvidenceOutputRecord>;
  runAssistantCase: (evalCase: AssistantEvalCase) => Promise<AssistantOutputRecord>;
  /** Called only after live admission succeeds. */
  createOpenAiJudge: () => Judge;
  models: { evidence: string; assistant: string; evidencePromptVersion: string };
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  now: () => Date;
};

type Args = Map<string, string | true>;

function parseArgs(argv: string[]): Args {
  const args: Args = new Map();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument ${token}.`);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args.set(token.slice(2), next);
      i += 1;
    } else {
      args.set(token.slice(2), true);
    }
  }
  return args;
}

function stringArg(args: Args, name: string): string | undefined {
  const value = args.get(name);
  if (value === true) throw new Error(`--${name} needs a value.`);
  return value;
}

function requireDir(args: Args, name: string): string {
  const value = stringArg(args, name);
  if (!value) throw new Error(`--${name} is required (the launcher supplies it).`);
  return path.resolve(value);
}

/** Refuses paid model use unless a key is present and the process is not running under CI. */
export function assertLiveAdmitted(env: Record<string, string | undefined>): void {
  if (!env.OPENAI_API_KEY) {
    throw new Error("Refusing to run: OPENAI_API_KEY is not set. Live runs need an approved key and spend.");
  }
  if (env.CI && env.CI !== "false" && env.CONTRACTOR_EVAL_ALLOW_CI !== "1") {
    throw new Error("Refusing to run a live, paid eval under CI.");
  }
}

/** The paid judge exists only in admitted live mode; everything else is the offline lexical judge. */
export function selectJudge(args: Args, liveAdmitted: boolean, deps: ContractorEvalCliDeps): Judge {
  const kind = stringArg(args, "judge") ?? "lexical";
  if (kind === "lexical") return new LexicalJudge();
  if (kind !== "openai") throw new Error(`Unknown judge ${kind}; use lexical or openai.`);
  if (!liveAdmitted) {
    throw new Error("The OpenAI judge is only available with --live (use --live --replay <file> to rescore a recording); offline modes use the lexical judge.");
  }
  return deps.createOpenAiJudge();
}

function filterDataset(dataset: ContractorDataset, args: Args): ContractorDataset {
  const only = stringArg(args, "only");
  const caseId = stringArg(args, "case");
  const keep = <T extends { id: string }>(rows: T[], section: "evidence" | "assistant") =>
    rows.filter((row) => (!only || only === section) && (!caseId || row.id === caseId));
  return {
    ...dataset,
    evidenceCases: keep(dataset.evidenceCases, "evidence"),
    assistantCases: keep(dataset.assistantCases, "assistant"),
  };
}

const pct = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);

function summaryLines(scored: ScoredRun): string[] {
  const { report } = scored;
  const lines = [
    `Gate: ${report.gate.status}${report.gate.reasons.length ? `\n  - ${report.gate.reasons.join("\n  - ")}` : ""}`,
    `Evidence (contractor-verified): ${report.evidence.contractorVerified.cases} cases, agreement ${pct(report.evidence.contractorVerified.observationAgreement)}, critical omissions ${pct(report.evidence.contractorVerified.criticalOmissionRate)}`,
    `Evidence (research-draft, NOT a contractor benchmark): ${report.evidence.researchDraft.cases} cases, agreement ${pct(report.evidence.researchDraft.observationAgreement)}, critical omissions ${pct(report.evidence.researchDraft.criticalOmissionRate)}, citation validity ${pct(report.evidence.researchDraft.citationValidity)}, forbidden-claim violations ${report.evidence.researchDraft.forbiddenViolations}, model errors ${report.evidence.researchDraft.modelErrors}`,
    `Documents (research-draft): ${report.documents.researchDraft.cases} cases, extraction not run ${report.documents.researchDraft.notRun}`,
    `Assistant (research-draft): ${report.assistant.researchDraft.cases} cases, tool selection ${pct(report.assistant.researchDraft.toolSelectionAccuracy)}, required facts ${pct(report.assistant.researchDraft.requiredFactCoverage)}, forbidden behaviors ${report.assistant.researchDraft.forbiddenBehaviorViolations}`,
    report.calibration
      ? `Judge calibration (${report.calibration.judgeKind} ${report.calibration.judgeVersion}): agreement ${pct(report.calibration.agreement)}, kappa ${report.calibration.cohensKappa?.toFixed(3) ?? "n/a"}, ${report.calibration.calibrated ? "calibrated" : "UNCALIBRATED"}; disagreements: ${report.calibration.disagreementIds.join(", ") || "none"}`
      : "Judge calibration: not run",
  ];
  if (scored.missingOutputs.length) lines.push(`Cases without recorded output: ${scored.missingOutputs.join(", ")}`);
  return lines;
}

function recordingPath(resultsDir: string, recording: ContractorEvalRecording): string {
  const stamp = recording.startedAt.replace(/[:.]/g, "-");
  return path.join(resultsDir, `contractor-${recording.mode}-${stamp}-${recording.runId.slice(0, 8)}.json`);
}

function saveRecording(file: string, recording: ContractorEvalRecording): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`);
}

function sanitizedScoringError(error: unknown): string {
  return error instanceof OpenAiJudgeError ? error.message : "Scoring failed; raw outputs were preserved for replay.";
}

/** Score a persisted recording, updating it in place; a scoring failure keeps the outputs and a sanitized reason. */
async function scoreAndPersist(
  file: string,
  recording: ContractorEvalRecording,
  dataset: ContractorDataset,
  judge: Judge,
  deps: ContractorEvalCliDeps,
): Promise<number> {
  try {
    const scored = await scoreOutputs(dataset, recording.outputs, judge);
    saveRecording(file, {
      ...recording,
      finishedAt: deps.now().toISOString(),
      scoring: { status: "scored" },
      scores: { evidence: scored.evidenceScores, assistant: scored.assistantScores },
      report: scored.report,
    });
    for (const line of summaryLines(scored)) deps.log(line);
    deps.log(`Recorded ${file}`);
    return 0;
  } catch (error) {
    const reason = sanitizedScoringError(error);
    saveRecording(file, { ...recording, finishedAt: deps.now().toISOString(), scoring: { status: "failed", error: reason } });
    deps.log(`Scoring failed: ${reason}`);
    deps.log(`Raw outputs preserved in ${file}; rescore with --replay without regenerating.`);
    return 1;
  }
}

function datasetHashes(dataset: ContractorDataset): ContractorEvalRecording["dataset"] {
  return {
    evidenceSha256: dataset.sha256.evidence,
    assistantSha256: dataset.sha256.assistant,
    calibrationSha256: dataset.sha256.calibration,
  };
}

async function live(args: Args, dataset: ContractorDataset, resultsDir: string, deps: ContractorEvalCliDeps): Promise<number> {
  assertLiveAdmitted(deps.env);
  const judge = selectJudge(args, true, deps);
  const startedAt = deps.now().toISOString();
  const evidence: EvidenceOutputRecord[] = [];
  for (const evalCase of dataset.evidenceCases) {
    const record = await deps.runEvidenceCase(evalCase);
    deps.log(`evidence ${evalCase.id}: ${record.draft ? "ok" : `error ${record.error ?? "unknown"}`}`);
    evidence.push(record);
  }
  const assistant: AssistantOutputRecord[] = [];
  for (const evalCase of dataset.assistantCases) {
    const record = await deps.runAssistantCase(evalCase);
    deps.log(`assistant ${evalCase.id}: ${record.output ? "ok" : `error ${record.error ?? "unknown"}`}`);
    assistant.push(record);
  }
  const recording: ContractorEvalRecording = {
    schemaVersion: RECORDING_SCHEMA_VERSION,
    runId: randomUUID(),
    mode: "live",
    startedAt,
    finishedAt: deps.now().toISOString(),
    replayOf: null,
    models: { evidence: deps.models.evidence, assistant: deps.models.assistant },
    promptVersions: { evidence: deps.models.evidencePromptVersion },
    judge: { kind: judge.kind, version: judge.version, model: judge.model },
    dataset: datasetHashes(dataset),
    outputs: { evidence, assistant },
    scoring: { status: "pending" },
  };
  // Persist paid outputs before any judge call so a judge outage never forces regeneration.
  const file = recordingPath(resultsDir, recording);
  saveRecording(file, recording);
  return scoreAndPersist(file, recording, dataset, judge, deps);
}

async function replay(
  args: Args,
  file: string,
  dataset: ContractorDataset,
  resultsDir: string,
  liveAdmitted: boolean,
  deps: ContractorEvalCliDeps,
): Promise<number> {
  const judge = selectJudge(args, liveAdmitted, deps);
  const source = contractorEvalRecordingSchema.parse(JSON.parse(readFileSync(path.resolve(file), "utf8")));
  const changed =
    source.dataset.evidenceSha256 !== dataset.sha256.evidence ||
    source.dataset.assistantSha256 !== dataset.sha256.assistant ||
    source.dataset.calibrationSha256 !== dataset.sha256.calibration;
  if (changed) deps.log("Note: dataset hashes differ from the recorded run; labels changed since recording.");
  const rescored: ContractorEvalRecording = {
    ...source,
    runId: randomUUID(),
    mode: "replay",
    replayOf: source.runId,
    startedAt: deps.now().toISOString(),
    finishedAt: deps.now().toISOString(),
    judge: { kind: judge.kind, version: judge.version, model: judge.model },
    dataset: datasetHashes(dataset),
    scoring: { status: "pending" },
    scores: undefined,
    report: undefined,
  };
  if (args.get("write") === true || liveAdmitted) {
    const out = recordingPath(resultsDir, rescored);
    saveRecording(out, rescored);
    return scoreAndPersist(out, rescored, dataset, judge, deps);
  }
  const scored = await scoreOutputs(dataset, source.outputs, judge);
  for (const line of summaryLines(scored)) deps.log(line);
  return 0;
}

export async function runContractorEvalCli(argv: string[], deps: ContractorEvalCliDeps): Promise<number> {
  const args = parseArgs(argv);
  const datasetDir = requireDir(args, "dataset");
  const resultsDir = requireDir(args, "results");
  const isLive = args.get("live") === true;
  const modes = ["check", "replay", "export-labels", "import-labels"].filter((mode) => args.has(mode));
  if (isLive && modes.some((mode) => mode !== "replay")) throw new Error("--live can only be combined with --replay.");
  if (!isLive && modes.length !== 1) {
    throw new Error("Choose exactly one mode: --check, --live, --replay <file>, --export-labels <dir>, --import-labels <csv>.");
  }
  if (!isLive && stringArg(args, "judge") === "openai") {
    // Reject before loading anything so an offline invocation can never reach a paid judge.
    selectJudge(args, false, deps);
  }
  const fullDataset = loadContractorDataset(datasetDir);
  const dataset = filterDataset(fullDataset, args);

  if (isLive) {
    if (modes.includes("replay")) {
      assertLiveAdmitted(deps.env);
      return replay(args, stringArg(args, "replay")!, dataset, resultsDir, true, deps);
    }
    return live(args, dataset, resultsDir, deps);
  }

  switch (modes[0]) {
    case "check": {
      const verified = fullDataset.evidenceCases.filter((c) => c.labelProvenance.status === "contractor-verified").length;
      deps.log(
        `Dataset valid: ${fullDataset.evidenceCases.length} evidence cases (${verified} contractor-verified), ${fullDataset.assistantCases.length} assistant cases, ${fullDataset.calibrationPairs.length} calibration pairs.`,
      );
      const calibration = await calibrateJudge(fullDataset.calibrationPairs, selectJudge(args, false, deps));
      deps.log(
        `Judge calibration (${calibration.judgeKind} ${calibration.judgeVersion}): agreement ${pct(calibration.agreement)}, kappa ${calibration.cohensKappa?.toFixed(3) ?? "n/a"}, ${calibration.calibrated ? "calibrated" : "UNCALIBRATED"}; ${calibration.humanVerifiedPairs}/${calibration.pairs} verdicts contractor-verified; disagreements: ${calibration.disagreementIds.join(", ") || "none"}`,
      );
      deps.log(
        `Contractor-agreement gate needs at least ${QUALITY_TARGET.minContractorVerifiedCases} contractor-verified cases; ${verified} exist, so it is ${verified >= QUALITY_TARGET.minContractorVerifiedCases ? "measurable after a live run" : "not measurable"}.`,
      );
      return 0;
    }
    case "replay":
      return replay(args, stringArg(args, "replay")!, dataset, resultsDir, false, deps);
    case "export-labels": {
      const outDir = path.resolve(stringArg(args, "export-labels")!);
      mkdirSync(outDir, { recursive: true });
      const sheet = exportLabelSheet(dataset.evidenceCases);
      writeFileSync(path.join(outDir, "contractor-label-sheet.csv"), sheet.csv);
      writeFileSync(path.join(outDir, "contractor-label-packet.md"), sheet.markdown);
      deps.log(`Exported ${sheet.caseIds.length} research-draft cases to ${outDir}`);
      return 0;
    }
    case "import-labels": {
      const result = applyLabelSheet(fullDataset.evidenceCases, readFileSync(path.resolve(stringArg(args, "import-labels")!), "utf8"), {
        reviewerRole: stringArg(args, "reviewer-role") ?? "",
        labeledBy: stringArg(args, "labeled-by") ?? "",
        reviewedAt: stringArg(args, "reviewed-at") ?? "",
      });
      writeFileSync(
        path.join(datasetDir, DATASET_FILES.evidence),
        result.cases.map((evalCase) => JSON.stringify(evalCase)).join("\n") + "\n",
      );
      deps.log(
        `Verified: ${result.verifiedCaseIds.length}. Incomplete (left as research drafts): ${result.incompleteCaseIds.join(", ") || "none"}.`,
      );
      return 0;
    }
    default:
      throw new Error("Unknown mode.");
  }
}
