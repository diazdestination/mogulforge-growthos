/**
 * proposeOnly guard: specialist code can only insert `proposed` rows and can
 * never reach BIE review, execution or autopilot.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assertProposalDraft, SpecialistContractError, type SpecialistProposalDraft } from "./contract";

const dir = fileURLToPath(new URL(".", import.meta.url));
const sources = readdirSync(dir)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .map((file) => ({ file, text: readFileSync(join(dir, file), "utf8") }));

const draft = (): SpecialistProposalDraft => ({
  leadId: "00000000-0000-4000-8000-0000000000a1", actionType: "create_task", title: "Synthetic", rationale: "Synthetic reason",
  subjectKey: "scout:test", evidence: { rule: "test" }, payload: { title: "Synthetic" },
});

describe("specialist proposeOnly guard", () => {
  it("covers every specialist module", () => {
    expect(sources.map((s) => s.file).sort()).toEqual(["assistant-proposals.ts", "contract.ts", "index.ts", "invo.ts", "scout.ts"]);
  });

  it("no specialist imports or calls review, execution, autopilot or send functions", () => {
    const forbidden = /\b(executeBieProposal|reviewBieProposal|runAutopilot|prepareBieEmailProposal|runDurableAction|sendEmailForUser|executeBieProposalEffect)\b|from\s+["']\.\.\/bie["']/;
    for (const { file, text } of sources) expect(text, file).not.toMatch(forbidden);
  });

  it("specialists never update proposal rows and only ever write status 'proposed'", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/\.update\(\s*bieActionProposalsTable/);
      expect(text, file).not.toMatch(/\.delete\(\s*bieActionProposalsTable/);
      // A change_stage payload names the reviewed target *lead* stage; that is not a proposal status.
      const withoutStagePayloads = text.replace(/payload:\s*\{\s*status:\s*"[a-z_]+"\s*\}/g, "");
      const written = [...withoutStagePayloads.matchAll(/status:\s*"([a-z_]+)"/g)].map((m) => m[1]);
      // Only the proposal status and the run lifecycle (bie_agent_runs) appear as literals.
      for (const status of written) expect(["proposed", "running", "completed"], `${file}: ${status}`).toContain(status);
    }
    expect(sources.filter((s) => /\.insert\(\s*bieActionProposalsTable/.test(s.text)).map((s) => s.file)).toEqual(["contract.ts"]);
  });

  it("rejects a draft that tries to set a status, reviewer or run", () => {
    for (const extra of [{ status: "approved" }, { reviewedByUserId: "x" }, { runId: "x" }, { executionDetail: "x" }]) {
      expect(() => assertProposalDraft({ ...draft(), ...extra } as SpecialistProposalDraft)).toThrow(SpecialistContractError);
    }
    expect(() => assertProposalDraft({ ...draft(), evidence: { status: "approved" } })).toThrow(SpecialistContractError);
    expect(() => assertProposalDraft({ ...draft(), payload: { status: "won" } })).toThrow(SpecialistContractError);
    expect(() => assertProposalDraft({ ...draft(), actionType: "change_stage", payload: { status: "follow_up" } })).not.toThrow();
    expect(() => assertProposalDraft({ ...draft(), actionType: "execute" as never })).toThrow(SpecialistContractError);
  });
});
