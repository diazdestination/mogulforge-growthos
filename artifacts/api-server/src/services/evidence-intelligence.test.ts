import { describe, expect, it } from "vitest";

import { evidenceDraftSchema } from "./evidence-agent";
import {
  evaluateIssueReadiness,
  EvidenceIntelligenceError,
  mapAndValidateDraft,
} from "./evidence-intelligence";

const baseDraft = evidenceDraftSchema.parse({
  executiveSummary: "One grounded exterior observation is ready for contractor review.",
  findings: [
    {
      category: "Exterior",
      statement: "Several shingle tabs appear lifted.",
      citations: [
        { artifactId: "E1", locator: "north slope near ridge", basis: "visible lifted tabs", strength: "direct" },
      ],
      confidence: 87,
      needsHumanReview: true,
    },
  ],
  conflicts: [],
  gaps: [],
  limitations: ["Image-only observation; no physical inspection."],
  recommendedNextSteps: ["Contractor verifies the north slope in person."],
});

describe("Evidence Intelligence trust gates", () => {
  it("remaps only known run-local aliases to tenant-owned artifact IDs", () => {
    const mapped = mapAndValidateDraft(baseDraft, new Map([["E1", "00000000-0000-4000-8000-000000000001"]]));
    expect(mapped.findings[0]?.citations[0]?.artifactId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("rejects unknown or cross-tenant evidence citations", () => {
    expect(() => mapAndValidateDraft(baseDraft, new Map([["E2", "other-tenant-artifact"]]))).toThrow(
      EvidenceIntelligenceError,
    );
  });

  it("never considers an AI draft ready for issuance", () => {
    expect(evaluateIssueReadiness([{ status: "ai_draft" }])).toEqual({
      ready: false,
      reason: "Review every AI observation before issuing the certificate.",
    });
  });

  it("requires at least one human-verified observation", () => {
    expect(evaluateIssueReadiness([{ status: "rejected" }]).ready).toBe(false);
    expect(evaluateIssueReadiness([{ status: "verified" }, { status: "rejected" }]).ready).toBe(true);
  });
});
