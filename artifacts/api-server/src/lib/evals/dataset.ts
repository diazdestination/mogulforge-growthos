import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";

import {
  assistantCaseSchema,
  calibrationPairSchema,
  evidenceCaseSchema,
  type AssistantEvalCase,
  type CalibrationPair,
  type EvidenceEvalCase,
} from "./schemas";

export const DATASET_FILES = {
  evidence: "evidence-cases.jsonl",
  assistant: "assistant-cases.jsonl",
  calibration: "judge-calibration.jsonl",
} as const;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function parseJsonl<S extends z.ZodType>(text: string, schema: S, label: string): Array<z.output<S>> {
  const rows: Array<z.output<S>> = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.trim().length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`${label}:${index + 1} is not valid JSON.`);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `${label}:${index + 1} failed validation: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    rows.push(parsed.data);
  });
  return rows;
}

function assertUniqueIds(rows: Array<{ id: string }>, label: string): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error(`${label} has duplicate case id ${row.id}.`);
    seen.add(row.id);
  }
}

export type ContractorDataset = {
  evidenceCases: EvidenceEvalCase[];
  assistantCases: AssistantEvalCase[];
  calibrationPairs: CalibrationPair[];
  sha256: { evidence: string; assistant: string; calibration: string };
};

export function parseContractorDataset(texts: { evidence: string; assistant: string; calibration: string }): ContractorDataset {
  const evidenceCases = parseJsonl(texts.evidence, evidenceCaseSchema, DATASET_FILES.evidence);
  const assistantCases = parseJsonl(texts.assistant, assistantCaseSchema, DATASET_FILES.assistant);
  const calibrationPairs = parseJsonl(texts.calibration, calibrationPairSchema, DATASET_FILES.calibration);
  assertUniqueIds(evidenceCases, DATASET_FILES.evidence);
  assertUniqueIds(assistantCases, DATASET_FILES.assistant);
  assertUniqueIds(calibrationPairs, DATASET_FILES.calibration);
  return {
    evidenceCases,
    assistantCases,
    calibrationPairs,
    sha256: {
      evidence: sha256Hex(texts.evidence),
      assistant: sha256Hex(texts.assistant),
      calibration: sha256Hex(texts.calibration),
    },
  };
}

export function readDatasetTexts(directory: string): { evidence: string; assistant: string; calibration: string } {
  return {
    evidence: readFileSync(path.join(directory, DATASET_FILES.evidence), "utf8"),
    assistant: readFileSync(path.join(directory, DATASET_FILES.assistant), "utf8"),
    calibration: readFileSync(path.join(directory, DATASET_FILES.calibration), "utf8"),
  };
}

export function loadContractorDataset(directory: string): ContractorDataset {
  return parseContractorDataset(readDatasetTexts(directory));
}
