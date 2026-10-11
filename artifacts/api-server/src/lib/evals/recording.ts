/**
 * Recorded eval runs. A live run stores raw model outputs next to the scores so
 * any later judge or label revision can rescore the same outputs offline with
 * `--replay`, without another paid model call.
 */
import { z } from "zod";

import type { ContractorDataset } from "./dataset";
import type { Judge } from "./judge";
import {
  assistantOutputSchema,
  documentExtractionSchema,
  evalDraftSchema,
} from "./schemas";
import {
  buildReport,
  calibrateJudge,
  scoreAssistantCase,
  scoreEvidenceCase,
  type AssistantCaseScore,
  type ContractorEvalReport,
  type EvidenceCaseScore,
} from "./scoring";

export const RECORDING_SCHEMA_VERSION = 1;

export const evidenceOutputRecordSchema = z.object({
  caseId: z.string(),
  draft: evalDraftSchema.nullable(),
  error: z.string().optional(),
  documentExtraction: documentExtractionSchema.nullable().default(null),
  model: z.string().nullable().optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
});

export const assistantOutputRecordSchema = z.object({
  caseId: z.string(),
  output: assistantOutputSchema.nullable(),
  error: z.string().optional(),
});

export const contractorEvalRecordingSchema = z.object({
  schemaVersion: z.literal(RECORDING_SCHEMA_VERSION),
  runId: z.string(),
  mode: z.enum(["live", "replay"]),
  startedAt: z.string(),
  finishedAt: z.string(),
  replayOf: z.string().nullable().default(null),
  models: z.object({ evidence: z.string().nullable(), assistant: z.string().nullable() }),
  promptVersions: z.object({ evidence: z.string().nullable() }),
  judge: z.object({ kind: z.string(), version: z.string(), model: z.string().nullable() }),
  dataset: z.object({ evidenceSha256: z.string(), assistantSha256: z.string(), calibrationSha256: z.string() }),
  outputs: z.object({
    evidence: z.array(evidenceOutputRecordSchema),
    assistant: z.array(assistantOutputRecordSchema),
  }),
  scores: z.unknown().optional(),
  report: z.unknown().optional(),
});

export type ContractorEvalRecording = z.infer<typeof contractorEvalRecordingSchema>;
export type EvidenceOutputRecord = z.infer<typeof evidenceOutputRecordSchema>;
export type AssistantOutputRecord = z.infer<typeof assistantOutputRecordSchema>;

export type ScoredRun = {
  evidenceScores: EvidenceCaseScore[];
  assistantScores: AssistantCaseScore[];
  report: ContractorEvalReport;
  missingOutputs: string[];
};

/** Score recorded outputs against the dataset. Cases without an output are scored as model errors. */
export async function scoreOutputs(
  dataset: ContractorDataset,
  outputs: ContractorEvalRecording["outputs"],
  judge: Judge,
): Promise<ScoredRun> {
  const evidenceById = new Map(outputs.evidence.map((record) => [record.caseId, record]));
  const assistantById = new Map(outputs.assistant.map((record) => [record.caseId, record]));
  const missingOutputs: string[] = [];

  const evidenceScores: EvidenceCaseScore[] = [];
  for (const evalCase of dataset.evidenceCases) {
    const record = evidenceById.get(evalCase.id);
    if (!record) missingOutputs.push(evalCase.id);
    evidenceScores.push(
      await scoreEvidenceCase(
        evalCase,
        {
          draft: record?.draft ?? null,
          error: record?.error ?? (record ? undefined : "no recorded output"),
          documentExtraction: record?.documentExtraction ?? null,
        },
        judge,
      ),
    );
  }

  const assistantScores: AssistantCaseScore[] = [];
  for (const evalCase of dataset.assistantCases) {
    const record = assistantById.get(evalCase.id);
    if (!record) missingOutputs.push(evalCase.id);
    assistantScores.push(
      await scoreAssistantCase(evalCase, record?.output ?? null, judge, record?.error ?? "no recorded output"),
    );
  }

  const calibration = await calibrateJudge(dataset.calibrationPairs, judge);
  return {
    evidenceScores,
    assistantScores,
    report: buildReport({ evidenceScores, assistantScores, calibration }),
    missingOutputs,
  };
}

/** Rescore a recorded run offline. Flags label drift when the dataset hashes changed. */
export async function rescoreRecording(
  recordingJson: unknown,
  dataset: ContractorDataset,
  judge: Judge,
): Promise<ScoredRun & { recording: ContractorEvalRecording; datasetChanged: boolean }> {
  const recording = contractorEvalRecordingSchema.parse(recordingJson);
  const scored = await scoreOutputs(dataset, recording.outputs, judge);
  const datasetChanged =
    recording.dataset.evidenceSha256 !== dataset.sha256.evidence ||
    recording.dataset.assistantSha256 !== dataset.sha256.assistant ||
    recording.dataset.calibrationSha256 !== dataset.sha256.calibration;
  return { ...scored, recording, datasetChanged };
}
