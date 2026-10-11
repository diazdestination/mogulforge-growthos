/**
 * Contractor eval harness CLI. Run through `pnpm --filter @workspace/api-server
 * run eval:contractor -- <mode>`; the launcher bundles this file with esbuild.
 *
 * Modes (exactly one):
 *   --check                    Validate the dataset and calibrate the offline judge. No network.
 *   --live                     Call the real Evidence Intelligence agent and CRM assistant loop.
 *                              Requires OPENAI_API_KEY; refuses to run under CI.
 *   --replay <file>            Rescore a recorded run offline (add --write to save the rescore).
 *   --export-labels <dir>      Write a contractor label sheet (CSV) and review packet (Markdown).
 *   --import-labels <csv>      Apply a completed sheet (needs --reviewer-role, --labeled-by, --reviewed-at).
 *
 * Options: --judge lexical|openai (default lexical), --only evidence|assistant, --case <id>.
 *
 * Output never includes evidence or answer text on the console; recorded runs
 * contain model outputs for the synthetic/redacted dataset only.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadContractorDataset, DATASET_FILES, sha256Hex, type ContractorDataset } from "../lib/evals/dataset";
import { LexicalJudge, OpenAiJudge, type Judge } from "../lib/evals/judge";
import { applyLabelSheet, exportLabelSheet } from "../lib/evals/labeling";
import {
  RECORDING_SCHEMA_VERSION,
  rescoreRecording,
  scoreOutputs,
  type AssistantOutputRecord,
  type ContractorEvalRecording,
  type EvidenceOutputRecord,
  type ScoredRun,
} from "../lib/evals/recording";
import { calibrateJudge, QUALITY_TARGET } from "../lib/evals/scoring";
import type { AssistantEvalCase, EvidenceEvalCase } from "../lib/evals/schemas";
import { ASSISTANT_MODEL, ASSISTANT_TOOL_SPECS, buildSystemPrompt, runAssistantToolLoop } from "../services/assistant-chat-loop";
import { DEFAULT_EVIDENCE_MODEL, EVIDENCE_PROMPT_VERSION, runEvidenceAgent } from "../services/evidence-agent";
import { redactEvidenceText } from "../services/evidence-redaction";

const EVAL_ORGANIZATION_ID = "contractor-eval-harness";

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

function makeJudge(args: Args): Judge {
  const kind = stringArg(args, "judge") ?? "lexical";
  if (kind === "lexical") return new LexicalJudge();
  if (kind === "openai") return new OpenAiJudge();
  throw new Error(`Unknown judge ${kind}; use lexical or openai.`);
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

function printSummary(scored: ScoredRun): void {
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
  console.log(lines.join("\n"));
}

function writeRecording(resultsDir: string, recording: ContractorEvalRecording): string {
  mkdirSync(resultsDir, { recursive: true });
  const stamp = recording.finishedAt.replace(/[:.]/g, "-");
  const file = path.join(resultsDir, `contractor-${recording.mode}-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`);
  return file;
}

async function runEvidenceCase(evalCase: EvidenceEvalCase): Promise<EvidenceOutputRecord> {
  try {
    const result = await runEvidenceAgent({
      organizationId: EVAL_ORGANIZATION_ID,
      caseSummary: evalCase.caseSummary,
      artifacts: evalCase.artifacts.map((artifact) => ({
        alias: artifact.alias,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sha256: sha256Hex(artifact.text),
        sourceLabel: artifact.sourceLabel,
        redactedText: redactEvidenceText(artifact.text).text,
        blob: null,
      })),
    });
    // There is no production line-item extractor yet, so document cases record no extraction.
    return { caseId: evalCase.id, draft: result.draft, documentExtraction: null, model: result.model, usage: result.usage };
  } catch (error) {
    return { caseId: evalCase.id, draft: null, documentExtraction: null, error: error instanceof Error ? error.name : "error" };
  }
}

async function runAssistantCase(evalCase: AssistantEvalCase): Promise<AssistantOutputRecord> {
  const toolCalls: Array<{ name: string; args: Record<string, unknown> | null }> = [];
  const tools = Object.fromEntries(
    Object.entries(ASSISTANT_TOOL_SPECS).map(([name, spec]) => [
      name,
      {
        ...spec,
        run: async () =>
          name in evalCase.toolFixtures
            ? evalCase.toolFixtures[name as keyof typeof evalCase.toolFixtures]
            : { error: "No data is available from this lookup in the eval fixture." },
      },
    ]),
  );
  try {
    const answer = await runAssistantToolLoop({
      systemPrompt: buildSystemPrompt(evalCase.orgName),
      messages: [{ role: "user", content: evalCase.question }],
      tools,
      onDelta: () => {},
      onToolCall: (name, args) => toolCalls.push({ name, args }),
    });
    return { caseId: evalCase.id, output: { toolCalls, answer } };
  } catch (error) {
    return { caseId: evalCase.id, output: null, error: error instanceof Error ? error.name : "error" };
  }
}

async function live(args: Args, dataset: ContractorDataset, resultsDir: string): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Refusing to run: OPENAI_API_KEY is not set. Live runs need an approved key and spend.");
  }
  if (process.env.CI && process.env.CI !== "false" && process.env.CONTRACTOR_EVAL_ALLOW_CI !== "1") {
    throw new Error("Refusing to run a live, paid eval under CI.");
  }
  const judge = makeJudge(args);
  const startedAt = new Date().toISOString();
  const evidence: EvidenceOutputRecord[] = [];
  for (const evalCase of dataset.evidenceCases) {
    const record = await runEvidenceCase(evalCase);
    console.log(`evidence ${evalCase.id}: ${record.draft ? "ok" : `error ${record.error}`}`);
    evidence.push(record);
  }
  const assistant: AssistantOutputRecord[] = [];
  for (const evalCase of dataset.assistantCases) {
    const record = await runAssistantCase(evalCase);
    console.log(`assistant ${evalCase.id}: ${record.output ? "ok" : `error ${record.error}`}`);
    assistant.push(record);
  }
  const outputs = { evidence, assistant };
  const scored = await scoreOutputs(dataset, outputs, judge);
  const recording: ContractorEvalRecording = {
    schemaVersion: RECORDING_SCHEMA_VERSION,
    runId: randomUUID(),
    mode: "live",
    startedAt,
    finishedAt: new Date().toISOString(),
    replayOf: null,
    models: {
      evidence: process.env.OPENAI_EVIDENCE_MODEL?.trim() || DEFAULT_EVIDENCE_MODEL,
      assistant: ASSISTANT_MODEL,
    },
    promptVersions: { evidence: EVIDENCE_PROMPT_VERSION },
    judge: { kind: judge.kind, version: judge.version, model: judge.model },
    dataset: {
      evidenceSha256: dataset.sha256.evidence,
      assistantSha256: dataset.sha256.assistant,
      calibrationSha256: dataset.sha256.calibration,
    },
    outputs,
    scores: { evidence: scored.evidenceScores, assistant: scored.assistantScores },
    report: scored.report,
  };
  printSummary(scored);
  console.log(`Recorded ${writeRecording(resultsDir, recording)}`);
}

async function replay(args: Args, file: string, dataset: ContractorDataset, resultsDir: string): Promise<void> {
  const judge = makeJudge(args);
  const rescored = await rescoreRecording(JSON.parse(readFileSync(path.resolve(file), "utf8")), dataset, judge);
  if (rescored.datasetChanged) console.log("Note: dataset hashes differ from the recorded run; labels changed since recording.");
  printSummary(rescored);
  if (args.get("write") === true) {
    const recording: ContractorEvalRecording = {
      ...rescored.recording,
      runId: randomUUID(),
      mode: "replay",
      replayOf: rescored.recording.runId,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      judge: { kind: judge.kind, version: judge.version, model: judge.model },
      dataset: {
        evidenceSha256: dataset.sha256.evidence,
        assistantSha256: dataset.sha256.assistant,
        calibrationSha256: dataset.sha256.calibration,
      },
      scores: { evidence: rescored.evidenceScores, assistant: rescored.assistantScores },
      report: rescored.report,
    };
    console.log(`Recorded ${writeRecording(resultsDir, recording)}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const datasetDir = requireDir(args, "dataset");
  const resultsDir = requireDir(args, "results");
  const modes = ["check", "live", "replay", "export-labels", "import-labels"].filter((mode) => args.has(mode));
  if (modes.length !== 1) throw new Error("Choose exactly one mode: --check, --live, --replay <file>, --export-labels <dir>, --import-labels <csv>.");
  const fullDataset = loadContractorDataset(datasetDir);
  const dataset = filterDataset(fullDataset, args);

  switch (modes[0]) {
    case "check": {
      const verified = fullDataset.evidenceCases.filter((c) => c.labelProvenance.status === "contractor-verified").length;
      console.log(
        `Dataset valid: ${fullDataset.evidenceCases.length} evidence cases (${verified} contractor-verified), ${fullDataset.assistantCases.length} assistant cases, ${fullDataset.calibrationPairs.length} calibration pairs.`,
      );
      const calibration = await calibrateJudge(fullDataset.calibrationPairs, makeJudge(args));
      console.log(
        `Judge calibration (${calibration.judgeKind} ${calibration.judgeVersion}): agreement ${pct(calibration.agreement)}, kappa ${calibration.cohensKappa?.toFixed(3) ?? "n/a"}, ${calibration.calibrated ? "calibrated" : "UNCALIBRATED"}; ${calibration.humanVerifiedPairs}/${calibration.pairs} verdicts contractor-verified; disagreements: ${calibration.disagreementIds.join(", ") || "none"}`,
      );
      console.log(
        `Contractor-agreement gate needs at least ${QUALITY_TARGET.minContractorVerifiedCases} contractor-verified cases; ${verified} exist, so it is ${verified >= QUALITY_TARGET.minContractorVerifiedCases ? "measurable after a live run" : "not measurable"}.`,
      );
      return;
    }
    case "live":
      return live(args, dataset, resultsDir);
    case "replay":
      return replay(args, stringArg(args, "replay")!, dataset, resultsDir);
    case "export-labels": {
      const outDir = path.resolve(stringArg(args, "export-labels")!);
      mkdirSync(outDir, { recursive: true });
      const sheet = exportLabelSheet(dataset.evidenceCases);
      writeFileSync(path.join(outDir, "contractor-label-sheet.csv"), sheet.csv);
      writeFileSync(path.join(outDir, "contractor-label-packet.md"), sheet.markdown);
      console.log(`Exported ${sheet.caseIds.length} research-draft cases to ${outDir}`);
      return;
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
      console.log(
        `Verified: ${result.verifiedCaseIds.length}. Incomplete (left as research drafts): ${result.incompleteCaseIds.join(", ") || "none"}.`,
      );
      return;
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Contractor eval failed.");
  process.exitCode = 1;
});
