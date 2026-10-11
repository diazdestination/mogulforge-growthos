import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadContractorDataset } from "./dataset";
import { ASSISTANT_TOOL_NAMES } from "./schemas";

const datasetDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../evals/contractor");
const dataset = loadContractorDataset(datasetDir);

describe("committed contractor eval dataset", () => {
  it("validates every case file against its schema", () => {
    expect(dataset.evidenceCases.length).toBeGreaterThanOrEqual(24);
    expect(dataset.assistantCases.length).toBeGreaterThanOrEqual(12);
    expect(dataset.calibrationPairs.length).toBeGreaterThanOrEqual(15);
    expect(dataset.sha256.evidence).toMatch(/^[0-9a-f]{64}$/);
  });

  it("balances roofing and HVAC evidence cases", () => {
    const roofing = dataset.evidenceCases.filter((c) => c.trade === "roofing").length;
    const hvac = dataset.evidenceCases.filter((c) => c.trade === "hvac").length;
    expect(roofing).toBeGreaterThanOrEqual(12);
    expect(hvac).toBeGreaterThanOrEqual(12);
  });

  it("starts every label as a research draft with no contractor agreement claimed", () => {
    for (const row of [...dataset.evidenceCases, ...dataset.assistantCases, ...dataset.calibrationPairs]) {
      expect(row.labelProvenance.status).toBe("research-draft");
    }
  });

  it("covers the required adversarial workflows", () => {
    const tags = new Set(dataset.evidenceCases.flatMap((c) => c.tags));
    for (const tag of ["prompt-injection", "conflict", "mechanical-damage", "insufficient-evidence", "invoice-wording"]) {
      expect(tags.has(tag), tag).toBe(true);
    }
    expect(dataset.evidenceCases.some((c) => c.labels.expectedConflicts.length > 0 && c.tags.includes("dates"))).toBe(true);
  });

  it("includes both owner-supplied real invoices as document-extraction cases with reconciling labels", () => {
    const real = dataset.evidenceCases.filter((c) => c.tags.includes("real-source"));
    expect(real.map((c) => c.trade).sort()).toEqual(["hvac", "roofing"]);
    for (const evalCase of real) {
      expect(evalCase.kind).toBe("document-extraction");
      expect(evalCase.labelProvenance.source).toMatch(/^owner-supplied real invoice, redacted 2026-10-11/);
      const doc = evalCase.labels.document!;
      const sum = doc.lineItems.reduce((total, line) => total + line.amountCents, 0);
      expect(sum).toBe(doc.totals.subtotalCents);
      expect(doc.totals.totalCents).toBe(doc.totals.balanceDueCents);
    }
    const hvacInvoice = real.find((c) => c.trade === "hvac")!;
    expect(hvacInvoice.labels.document!.warranty.present).toBe(false);
    expect(hvacInvoice.labels.document!.totals.subtotalCents).toBe(236500);
    const roofInvoice = real.find((c) => c.trade === "roofing")!;
    expect(roofInvoice.labels.document!.lineItems).toHaveLength(1);
    expect(roofInvoice.labels.document!.lineItems[0].qty).toBeNull();
  });

  it("uses only the assistant's existing read-only tools", () => {
    for (const evalCase of dataset.assistantCases) {
      for (const tool of [...evalCase.expectedTools, ...evalCase.optionalTools, ...Object.keys(evalCase.toolFixtures)]) {
        expect(ASSISTANT_TOOL_NAMES).toContain(tool);
      }
    }
    expect(dataset.assistantCases.some((c) => c.forbiddenBehaviors.some((f) => f.id === "no-claimed-send"))).toBe(true);
  });

  it("compiles every forbidden-claim pattern", () => {
    const rules = [
      ...dataset.evidenceCases.flatMap((c) => c.labels.forbiddenClaims),
      ...dataset.assistantCases.flatMap((c) => c.forbiddenBehaviors),
    ];
    for (const rule of rules) for (const pattern of rule.patterns ?? []) expect(() => new RegExp(pattern, "i")).not.toThrow();
  });
});

describe("PII guard", () => {
  const files = readdirSync(datasetDir).filter((name) => /\.(jsonl|md|csv)$/.test(name));
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;
  const STREET =
    /\b\d{1,6}\s+(?:[NSEW]\.?\s+)?[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Way|Pkwy|Parkway|Cir|Circle|Pl|Place|Trl|Trail|Hwy|Highway)\b\.?/;

  it("scans every committed fixture file", () => {
    expect(files).toEqual(expect.arrayContaining(["evidence-cases.jsonl", "assistant-cases.jsonl", "judge-calibration.jsonl"]));
  });

  for (const name of files) {
    it(`${name} contains no emails, phone numbers or street addresses`, () => {
      const text = readFileSync(path.join(datasetDir, name), "utf8");
      expect(text.match(EMAIL)?.[0]).toBeUndefined();
      expect(text.match(PHONE)?.[0]).toBeUndefined();
      expect(text.match(STREET)?.[0]).toBeUndefined();
    });
  }

  it("detects the patterns it guards against", () => {
    expect(EMAIL.test("reach me at someone@example.com")).toBe(true);
    expect(PHONE.test("call (404) 555-0123")).toBe(true);
    expect(STREET.test("job at 1234 Peachtree Industrial Blvd")).toBe(true);
    expect(STREET.test("Install new pipe boots")).toBe(false);
  });
});
