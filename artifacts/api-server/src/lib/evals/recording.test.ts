import { describe, expect, it } from "vitest";

import { parseContractorDataset, type ContractorDataset } from "./dataset";
import { LexicalJudge } from "./judge";
import { RECORDING_SCHEMA_VERSION, rescoreRecording, scoreOutputs } from "./recording";
import { FakeJudge, finding, makeAssistantCase, makeDraft, makeEvidenceCase } from "./test-fixtures";

function datasetFrom(): ContractorDataset {
  const provenance = { status: "research-draft", labeledBy: "growthos-eval-research", labeledAt: "2026-10-11", reviewerRole: "draft" };
  const texts = {
    evidence: `${JSON.stringify(makeEvidenceCase())}\n${JSON.stringify(makeEvidenceCase({ id: "case-two" }))}\n`,
    assistant: `${JSON.stringify(makeAssistantCase())}\n`,
    calibration: `${JSON.stringify({
      id: "cal-one",
      expected: { statement: "west slope has 11 hits" },
      finding: { statement: "west slope has 11 hits in the square" },
      humanVerdict: "match",
      rationale: "same",
      labelProvenance: provenance,
    })}\n`,
  };
  return parseContractorDataset(texts);
}

function recordingFor(dataset: ContractorDataset) {
  return {
    schemaVersion: RECORDING_SCHEMA_VERSION,
    runId: "run-1",
    mode: "live",
    startedAt: "2026-10-11T00:00:00.000Z",
    finishedAt: "2026-10-11T00:05:00.000Z",
    models: { evidence: "model-e", assistant: "model-a" },
    promptVersions: { evidence: "evidence-intelligence-v1" },
    judge: { kind: "lexical", version: "v", model: null },
    dataset: {
      evidenceSha256: dataset.sha256.evidence,
      assistantSha256: dataset.sha256.assistant,
      calibrationSha256: dataset.sha256.calibration,
    },
    outputs: {
      evidence: [
        {
          caseId: "case-one",
          draft: makeDraft({ findings: [finding("west slope has 11 hits"), finding("south slope has 9 hits")] }),
        },
      ],
      assistant: [{ caseId: "asst-one", output: { toolCalls: [{ name: "get_stale_leads", args: {} }], answer: "three stale leads" } }],
    },
  };
}

describe("replay rescoring", () => {
  it("rescores recorded outputs offline and reports missing outputs as model errors", async () => {
    const dataset = datasetFrom();
    const judge = new FakeJudge();
    const result = await rescoreRecording(recordingFor(dataset), dataset, judge);
    expect(result.datasetChanged).toBe(false);
    expect(result.missingOutputs).toEqual(["case-two"]);
    expect(result.evidenceScores[0].observations.matched).toBe(2);
    expect(result.evidenceScores[1].status).toBe("model-error");
    expect(result.assistantScores[0].tools.correct).toBe(true);
    expect(result.report.evidence.researchDraft).toMatchObject({ cases: 2, observationsExpected: 8, observationsMatched: 2 });
    expect(result.report.calibration?.agreement).toBe(1);
    expect(result.report.gate.status).toBe("not-measurable");
  });

  it("flags label drift when the dataset changed after recording", async () => {
    const dataset = datasetFrom();
    const recording = recordingFor(dataset);
    recording.dataset.evidenceSha256 = "0".repeat(64);
    expect((await rescoreRecording(recording, dataset, new LexicalJudge())).datasetChanged).toBe(true);
  });

  it("rejects a malformed recording", async () => {
    await expect(rescoreRecording({ schemaVersion: 99 }, datasetFrom(), new FakeJudge())).rejects.toThrow();
  });

  it("is deterministic for the same outputs and judge", async () => {
    const dataset = datasetFrom();
    const outputs = recordingFor(dataset).outputs as Parameters<typeof scoreOutputs>[1];
    const first = await scoreOutputs(dataset, outputs, new LexicalJudge());
    const second = await scoreOutputs(dataset, outputs, new LexicalJudge());
    expect(second.report).toEqual(first.report);
  });
});
