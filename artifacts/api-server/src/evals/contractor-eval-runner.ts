/**
 * Contractor eval harness entry. Run through `pnpm --filter @workspace/api-server
 * run eval:contractor -- <mode>`; the launcher bundles this file with esbuild.
 * Mode handling, live admission and judge selection live in `lib/evals/cli.ts`.
 * This file only wires the real Evidence Intelligence agent, CRM assistant loop
 * and OpenAI judge. Console output never includes evidence or answer text.
 */
import { sha256Hex } from "../lib/evals/dataset";
import { runContractorEvalCli } from "../lib/evals/cli";
import { OpenAiJudge } from "../lib/evals/judge";
import type { AssistantOutputRecord, EvidenceOutputRecord } from "../lib/evals/recording";
import type { AssistantEvalCase, EvidenceEvalCase } from "../lib/evals/schemas";
import { ASSISTANT_MODEL, ASSISTANT_TOOL_SPECS, buildSystemPrompt, runAssistantToolLoop } from "../services/assistant-chat-loop";
import { DEFAULT_EVIDENCE_MODEL, EVIDENCE_PROMPT_VERSION, runEvidenceAgent } from "../services/evidence-agent";
import { redactEvidenceText } from "../services/evidence-redaction";

const EVAL_ORGANIZATION_ID = "contractor-eval-harness";

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

runContractorEvalCli(process.argv.slice(2), {
  runEvidenceCase,
  runAssistantCase,
  createOpenAiJudge: () => new OpenAiJudge(),
  models: {
    evidence: process.env.OPENAI_EVIDENCE_MODEL?.trim() || DEFAULT_EVIDENCE_MODEL,
    assistant: ASSISTANT_MODEL,
    evidencePromptVersion: EVIDENCE_PROMPT_VERSION,
  },
  env: process.env,
  log: (line) => console.log(line),
  now: () => new Date(),
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Contractor eval failed.");
    process.exitCode = 1;
  });
