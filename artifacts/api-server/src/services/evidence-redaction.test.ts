import { describe, expect, it } from "vitest";

import { redactEvidenceText } from "./evidence-redaction";

describe("redactEvidenceText", () => {
  it("removes common direct identifiers while preserving evidence details", () => {
    const result = redactEvidenceText(
      "Roof has 14 missing shingles. Email jane@example.com, call (555) 123-4567. SSN 123-45-6789. Policy # ABC-123456.",
    );

    expect(result.text).toContain("Roof has 14 missing shingles");
    expect(result.text).toContain("[REDACTED_EMAIL]");
    expect(result.text).toContain("[REDACTED_PHONE]");
    expect(result.text).toContain("[REDACTED_SSN]");
    expect(result.text).toContain("[REDACTED_POLICY_ID]");
    expect(result.counts).toEqual({ email: 1, phone: 1, ssn: 1, policy: 1 });
  });

  it("does not mutate evidence text with no identifiers", () => {
    const input = "North slope photo shows lifted shingle tabs near the ridge.";
    expect(redactEvidenceText(input).text).toBe(input);
  });
});
