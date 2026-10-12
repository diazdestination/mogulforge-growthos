import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runContractorEvalCli, type ContractorEvalCliDeps } from "./cli";
import { OpenAiJudge } from "./judge";
import { contractorEvalRecordingSchema } from "./recording";
import { finding, makeAssistantCase, makeDraft, makeEvidenceCase } from "./test-fixtures";

const FAKE_KEY = "sk-unit-test-key-must-never-leak";
let root: string;
let datasetDir: string;
let resultsDir: string;
let fetchSpy: ReturnType<typeof vi.fn>;

function writeDataset(): void {
  const provenance = { status: "research-draft", labeledBy: "growthos-eval-research", labeledAt: "2026-10-11", reviewerRole: "draft" };
  writeFileSync(path.join(datasetDir, "evidence-cases.jsonl"), `${JSON.stringify(makeEvidenceCase())}\n`);
  writeFileSync(path.join(datasetDir, "assistant-cases.jsonl"), `${JSON.stringify(makeAssistantCase())}\n`);
  writeFileSync(
    path.join(datasetDir, "judge-calibration.jsonl"),
    `${JSON.stringify({
      id: "cal-one",
      expected: { statement: "west slope has 11 hits" },
      finding: { statement: "west slope has 11 hits" },
      humanVerdict: "match",
      rationale: "same",
      labelProvenance: provenance,
    })}\n`,
  );
}

function makeDeps(env: Record<string, string | undefined>, overrides: Partial<ContractorEvalCliDeps> = {}) {
  const logs: string[] = [];
  const deps: ContractorEvalCliDeps = {
    runEvidenceCase: vi.fn(async (evalCase) => ({
      caseId: evalCase.id,
      draft: makeDraft({ findings: [finding("west slope has 11 hits")] }),
      documentExtraction: null,
    })),
    runAssistantCase: vi.fn(async (evalCase) => ({
      caseId: evalCase.id,
      output: { toolCalls: [{ name: "get_stale_leads", args: {} }], answer: "three stale leads" },
    })),
    createOpenAiJudge: vi.fn(() => new OpenAiJudge({ apiKey: FAKE_KEY })),
    models: { evidence: "evidence-model", assistant: "assistant-model", evidencePromptVersion: "evidence-intelligence-v1" },
    env,
    log: (line) => logs.push(line),
    now: () => new Date("2026-10-12T01:02:03.000Z"),
    ...overrides,
  };
  return { deps, logs };
}

const base = () => ["--dataset", datasetDir, "--results", resultsDir];
const recordings = () =>
  readdirSync(resultsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(resultsDir, entry.name))
    .sort();

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "contractor-eval-cli-"));
  datasetDir = path.join(root, "dataset");
  resultsDir = path.join(root, "results");
  mkdirSync(datasetDir, { recursive: true });
  mkdirSync(resultsDir, { recursive: true });
  writeDataset();
  fetchSpy = vi.fn(async () => new Response("unexpected network call", { status: 500 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

const ciEnv = { CI: "true", OPENAI_API_KEY: FAKE_KEY };

describe("offline modes never reach the paid judge", () => {
  it("rejects --check --judge openai under CI before constructing the judge, with zero fetches", async () => {
    const { deps } = makeDeps(ciEnv);
    await expect(runContractorEvalCli([...base(), "--check", "--judge", "openai"], deps)).rejects.toThrow(/only available with --live/);
    expect(deps.createOpenAiJudge).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects --replay --judge openai under CI with zero fetches", async () => {
    const file = path.join(root, "recording.json");
    writeFileSync(file, "{}");
    const { deps } = makeDeps(ciEnv);
    await expect(runContractorEvalCli([...base(), "--replay", file, "--judge", "openai"], deps)).rejects.toThrow(/only available with --live/);
    expect(deps.createOpenAiJudge).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("runs --check and --replay offline with the lexical judge under CI and a key, with zero fetches", async () => {
    const { deps } = makeDeps(ciEnv);
    expect(await runContractorEvalCli([...base(), "--check"], deps)).toBe(0);

    // Produce a recording through an admitted live run (no CI), then replay it under CI.
    const live = makeDeps({ OPENAI_API_KEY: FAKE_KEY });
    expect(await runContractorEvalCli([...base(), "--live"], live.deps)).toBe(0);
    const [file] = recordings();
    expect(await runContractorEvalCli([...base(), "--replay", file], deps)).toBe(0);
    expect(await runContractorEvalCli([...base(), "--replay", file, "--write"], deps)).toBe(0);
    expect(deps.createOpenAiJudge).not.toHaveBeenCalled();
    expect(deps.runEvidenceCase).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses live generation and live rescoring without a key or under CI", async () => {
    const noKey = makeDeps({});
    await expect(runContractorEvalCli([...base(), "--live"], noKey.deps)).rejects.toThrow(/OPENAI_API_KEY/);
    const ci = makeDeps(ciEnv);
    await expect(runContractorEvalCli([...base(), "--live", "--judge", "openai"], ci.deps)).rejects.toThrow(/under CI/);
    await expect(runContractorEvalCli([...base(), "--live", "--replay", "x.json", "--judge", "openai"], ci.deps)).rejects.toThrow(/under CI/);
    expect(noKey.deps.runEvidenceCase).not.toHaveBeenCalled();
    expect(ci.deps.runEvidenceCase).not.toHaveBeenCalled();
    expect(ci.deps.createOpenAiJudge).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("live runs persist outputs before scoring", () => {
  it("keeps a replayable recording with a sanitized failure after a judge 503", async () => {
    const judgeFetch = vi.fn(async () => new Response(`upstream body with ${FAKE_KEY}`, { status: 503 }));
    const { deps, logs } = makeDeps(
      { OPENAI_API_KEY: FAKE_KEY },
      { createOpenAiJudge: vi.fn(() => new OpenAiJudge({ apiKey: FAKE_KEY, fetchImpl: judgeFetch as unknown as typeof fetch })) },
    );
    expect(await runContractorEvalCli([...base(), "--live", "--judge", "openai"], deps)).toBe(1);
    expect(judgeFetch).toHaveBeenCalled();
    expect(deps.runEvidenceCase).toHaveBeenCalledTimes(1);

    const files = recordings();
    expect(files).toHaveLength(1);
    const raw = readFileSync(files[0], "utf8");
    expect(raw).not.toContain(FAKE_KEY);
    expect(raw).not.toContain("upstream body");
    const recording = contractorEvalRecordingSchema.parse(JSON.parse(raw));
    expect(recording.scoring).toEqual({ status: "failed", error: "OpenAI judge request failed with status 503." });
    expect(recording.outputs.evidence[0].draft?.findings).toHaveLength(1);
    expect(recording.outputs.assistant[0].output?.answer).toBe("three stale leads");
    expect(recording.report).toBeUndefined();
    expect(logs.join("\n")).not.toContain(FAKE_KEY);

    // Offline replay rescores the preserved outputs without regenerating anything.
    const replay = makeDeps({ CI: "true" });
    expect(await runContractorEvalCli([...base(), "--replay", files[0], "--write"], replay.deps)).toBe(0);
    expect(replay.deps.runEvidenceCase).not.toHaveBeenCalled();
    expect(replay.deps.runAssistantCase).not.toHaveBeenCalled();
    const rescored = recordings()
      .filter((file) => file !== files[0])
      .map((file) => contractorEvalRecordingSchema.parse(JSON.parse(readFileSync(file, "utf8"))));
    expect(rescored).toHaveLength(1);
    expect(rescored[0]).toMatchObject({ mode: "replay", replayOf: recording.runId, scoring: { status: "scored" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("records a scored live run with model ids, prompt and judge versions and dataset hashes", async () => {
    const { deps } = makeDeps({ OPENAI_API_KEY: FAKE_KEY });
    expect(await runContractorEvalCli([...base(), "--live"], deps)).toBe(0);
    const recording = contractorEvalRecordingSchema.parse(JSON.parse(readFileSync(recordings()[0], "utf8")));
    expect(recording).toMatchObject({
      mode: "live",
      scoring: { status: "scored" },
      models: { evidence: "evidence-model", assistant: "assistant-model" },
      promptVersions: { evidence: "evidence-intelligence-v1" },
      judge: { kind: "lexical" },
    });
    expect(recording.dataset.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
