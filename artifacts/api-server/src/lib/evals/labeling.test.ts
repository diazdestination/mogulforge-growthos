import { describe, expect, it } from "vitest";

import { applyLabelSheet, caseReviewFingerprint, exportLabelSheet, LABEL_SHEET_COLUMNS } from "./labeling";
import type { EvidenceEvalCase } from "./schemas";
import { parseCsv, toCsv } from "./text";
import { makeEvidenceCase } from "./test-fixtures";

const reviewer = { reviewerRole: "roofing estimator", labeledBy: "roof-reviewer-1", reviewedAt: "2026-10-20" };

function fillSheet(csv: string, decide: (row: Record<string, string>) => Partial<Record<string, string>> | null): string {
  const [header, ...rows] = parseCsv(csv);
  const filled = rows.map((cells) => {
    const row = Object.fromEntries(header.map((column, i) => [column, cells[i] ?? ""]));
    const patch = decide(row);
    return header.map((column) => (patch && column in patch ? patch[column]! : row[column]));
  });
  return toCsv([header, ...filled]);
}

describe("contractor label workflow", () => {
  const cases = [makeEvidenceCase(), makeEvidenceCase({ id: "case-two" }), makeEvidenceCase({ id: "case-three", verified: true })];

  it("exports one row per research-draft label plus missing-observation rows and a review packet", () => {
    const sheet = exportLabelSheet(cases);
    const [header, ...rows] = parseCsv(sheet.csv);
    expect(header).toEqual([...LABEL_SHEET_COLUMNS]);
    expect(sheet.caseIds).toEqual(["case-one", "case-two"]);
    // 4 observations + 1 conflict + 2 gaps + 1 forbidden + 2 blank rows, per case
    expect(rows.filter((row) => row[0] === "case-one")).toHaveLength(10);
    expect(sheet.markdown).toContain("## case-one");
    expect(sheet.markdown).toContain("Do not write names");
  });

  it("verifies a fully reviewed case, applies edits/rejections/additions and records the reviewer role", () => {
    const { csv } = exportLabelSheet(cases);
    const filled = fillSheet(csv, (row) => {
      if (row.caseId !== "case-one") return null;
      if (!row.itemId) {
        return { decision: "missing", editedStatement: "ridge vent dented", editedCritical: "no", editedAliases: "E2" };
      }
      if (row.itemId === "obs-b") return { decision: "edit", editedStatement: "south slope has 10 hits", editedCritical: "yes" };
      if (row.itemId === "obs-d") return { decision: "reject" };
      return { decision: "agree" };
    });
    const result = applyLabelSheet(cases, filled, reviewer);
    expect(result.verifiedCaseIds).toEqual(["case-one"]);
    expect(result.untouchedCaseIds).toEqual(["case-two", "case-three"]);

    const updated = result.cases.find((c) => c.id === "case-one")!;
    expect(updated.labelProvenance).toEqual({
      status: "contractor-verified",
      labeledBy: "roof-reviewer-1",
      labeledAt: "2026-10-20",
      reviewerRole: "roofing estimator",
    });
    const statements = updated.labels.expectedObservations.map((o) => o.statement);
    expect(statements).toContain("south slope has 10 hits");
    expect(statements).not.toContain("canopy has no hits");
    expect(updated.labels.expectedObservations.filter((o) => o.category === "contractor-added")).toHaveLength(2);
    expect(result.cases.find((c) => c.id === "case-two")!.labelProvenance.status).toBe("research-draft");
  });

  it("leaves a partially reviewed case as an unchanged research draft", () => {
    const { csv } = exportLabelSheet(cases);
    const filled = fillSheet(csv, (row) =>
      row.caseId === "case-two" && row.itemId && row.itemId !== "gap-b" ? { decision: "reject" } : null,
    );
    const result = applyLabelSheet(cases, filled, reviewer);
    expect(result.incompleteCaseIds).toEqual(["case-two"]);
    expect(result.cases.find((c) => c.id === "case-two")).toEqual(cases[1]);
  });

  describe("stale sheets cannot certify changed material", () => {
    const documentCase = makeEvidenceCase({
      id: "case-doc",
      kind: "document-extraction",
      labels: {
        ...makeEvidenceCase().labels,
        document: {
          documentType: "invoice",
          lineItems: [{ title: "Standard Repair", qty: 1, amountCents: 115000, descriptionComponents: ["New Filter Drier"] }],
          totals: { subtotalCents: 115000, totalCents: 115000, amountPaidCents: null, balanceDueCents: 115000 },
          paymentTerms: "Upon receipt",
          warranty: { present: false, terms: [] },
          flags: [{ id: "flag-warranty", description: "no warranty dates" }],
        },
      },
    });
    const all = [makeEvidenceCase(), documentCase];
    const agreeAll = (caseId: string) =>
      fillSheet(exportLabelSheet(all).csv, (row) => (row.caseId === caseId && row.itemId ? { decision: "agree" } : null));

    it("binds every exported row to a case fingerprint and accepts an unchanged case", () => {
      const [header, ...rows] = parseCsv(exportLabelSheet(all).csv);
      const column = header.indexOf("caseFingerprint");
      expect(column).toBeGreaterThan(-1);
      expect(rows.every((row) => /^[0-9a-f]{64}$/.test(row[column]))).toBe(true);
      expect(caseReviewFingerprint(all[0])).not.toBe(caseReviewFingerprint(documentCase));
      expect(applyLabelSheet(all, agreeAll("case-doc"), reviewer).verifiedCaseIds).toEqual(["case-doc"]);
    });

    const drifts: Array<[string, string, (c: EvidenceEvalCase) => EvidenceEvalCase]> = [
      ["observation statement", "case-one", (c) => ({ ...c, labels: { ...c.labels, expectedObservations: c.labels.expectedObservations.map((o) => (o.id === "obs-a" ? { ...o, statement: "west slope has 75 hits" } : o)) } })],
      ["critical flag", "case-one", (c) => ({ ...c, labels: { ...c.labels, expectedObservations: c.labels.expectedObservations.map((o) => (o.id === "obs-c" ? { ...o, critical: true } : o)) } })],
      ["supporting aliases", "case-one", (c) => ({ ...c, labels: { ...c.labels, expectedObservations: c.labels.expectedObservations.map((o) => (o.id === "obs-a" ? { ...o, supportingAliases: ["E2"] } : o)) } })],
      ["added label", "case-one", (c) => ({ ...c, labels: { ...c.labels, expectedGaps: [...c.labels.expectedGaps, { id: "gap-new", description: "new gap" }] } })],
      ["forbidden claim", "case-one", (c) => ({ ...c, labels: { ...c.labels, forbiddenClaims: [{ id: "forbid-a", description: "something else" }] } })],
      ["document line quantity", "case-doc", (c) => ({ ...c, labels: { ...c.labels, document: { ...c.labels.document!, lineItems: [{ ...c.labels.document!.lineItems[0], qty: 2 }] } } })],
      ["document warranty", "case-doc", (c) => ({ ...c, labels: { ...c.labels, document: { ...c.labels.document!, warranty: { present: true, terms: ["1 year parts"] } } } })],
      ["source artifact text", "case-one", (c) => ({ ...c, artifacts: c.artifacts.map((a) => (a.alias === "E1" ? { ...a, text: "alpha, revised" } : a)) })],
      ["source label", "case-one", (c) => ({ ...c, artifacts: c.artifacts.map((a) => (a.alias === "E2" ? { ...a, sourceLabel: "other source" } : a)) })],
      ["case summary", "case-doc", (c) => ({ ...c, caseSummary: "A different summary." })],
    ];
    for (const [label, caseId, mutate] of drifts) {
      it(`rejects a sheet after ${label} drift`, () => {
        const sheet = agreeAll(caseId);
        const current = all.map((c) => (c.id === caseId ? mutate(structuredClone(c)) : c));
        expect(() => applyLabelSheet(current, sheet, reviewer)).toThrow(/changed since this sheet was exported/);
      });
    }

    it("rejects label text altered inside the sheet without an edit decision", () => {
      const tampered = fillSheet(exportLabelSheet(all).csv, (row) =>
        row.caseId === "case-one" && row.itemId
          ? { decision: "agree", ...(row.itemId === "obs-a" ? { statement: "west slope has 75 hits" } : {}) }
          : null,
      );
      expect(() => applyLabelSheet(all, tampered, reviewer)).toThrow(/altered in the sheet/);
      const flipped = fillSheet(exportLabelSheet(all).csv, (row) =>
        row.caseId === "case-one" && row.itemId ? { decision: "agree", ...(row.itemId === "obs-c" ? { critical: "yes" } : {}) } : null,
      );
      expect(() => applyLabelSheet(all, flipped, reviewer)).toThrow(/altered in the sheet/);
    });
  });

  it("rejects names, unknown items and malformed decisions", () => {
    const { csv } = exportLabelSheet(cases);
    expect(() => applyLabelSheet(cases, csv, { ...reviewer, labeledBy: "Jane Smith" })).toThrow(/pseudonymous/);
    expect(() => applyLabelSheet(cases, fillSheet(csv, (row) => (row.itemId === "obs-a" ? { itemId: "obs-zzz", decision: "agree" } : null)), reviewer)).toThrow(
      /not a label/,
    );
    expect(() => applyLabelSheet(cases, fillSheet(csv, (row) => (row.itemId === "obs-a" ? { decision: "maybe" } : null)), reviewer)).toThrow(
      /unknown decision/,
    );
    expect(() => applyLabelSheet(cases, fillSheet(csv, (row) => (row.itemId === "obs-a" ? { caseId: "nope" } : null)), reviewer)).toThrow(
      /unknown case/,
    );
    expect(() => applyLabelSheet(cases, "wrong,header\n", reviewer)).toThrow(/header/);
  });
});
