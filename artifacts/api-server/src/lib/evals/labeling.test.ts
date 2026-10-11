import { describe, expect, it } from "vitest";

import { applyLabelSheet, exportLabelSheet, LABEL_SHEET_COLUMNS } from "./labeling";
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
