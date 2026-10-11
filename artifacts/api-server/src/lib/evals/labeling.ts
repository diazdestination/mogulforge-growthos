/**
 * Contractor labeling workflow.
 *
 * `exportLabelSheet` turns research-draft cases into a CSV (one row per label)
 * plus a Markdown packet with the case material. A qualified reviewer marks
 * each row agree / edit / reject, and adds rows for missing observations.
 * `applyLabelSheet` applies a completed sheet. A case becomes
 * `contractor-verified` only when every one of its label rows has a decision.
 * Reviewers are recorded by role and pseudonymous handle, never by name.
 */
import type { EvidenceEvalCase, ExpectedObservation } from "./schemas";
import { evidenceCaseSchema } from "./schemas";
import { parseCsv, toCsv } from "./text";

export const LABEL_SHEET_COLUMNS = [
  "caseId",
  "trade",
  "labelKind",
  "itemId",
  "critical",
  "statement",
  "supportingAliases",
  "decision",
  "editedStatement",
  "editedCritical",
  "editedAliases",
  "reviewerNotes",
] as const;

type LabelKind = "observation" | "conflict" | "gap" | "forbidden" | "document";
const LABEL_KINDS: LabelKind[] = ["observation", "conflict", "gap", "forbidden", "document"];
const DECISIONS = ["agree", "edit", "reject", "missing"] as const;
type Decision = (typeof DECISIONS)[number];

const MISSING_TEMPLATE_ROWS = 2;

export function exportLabelSheet(
  cases: EvidenceEvalCase[],
  options: { includeVerified?: boolean } = {},
): { csv: string; markdown: string; caseIds: string[] } {
  const selected = cases.filter(
    (evalCase) => options.includeVerified || evalCase.labelProvenance.status === "research-draft",
  );
  const rows: string[][] = [[...LABEL_SHEET_COLUMNS]];
  const blank = (caseId: string, trade: string, kind: LabelKind, itemId: string, critical: string, statement: string, aliases: string) =>
    [caseId, trade, kind, itemId, critical, statement, aliases, "", "", "", "", ""];

  for (const evalCase of selected) {
    const { id, trade, labels } = evalCase;
    for (const item of labels.expectedObservations) {
      rows.push(blank(id, trade, "observation", item.id, item.critical ? "yes" : "no", item.statement, item.supportingAliases.join(" ")));
    }
    for (const item of labels.expectedConflicts) {
      rows.push(blank(id, trade, "conflict", item.id, "", item.description, item.aliases.join(" ")));
    }
    for (const item of labels.expectedGaps) rows.push(blank(id, trade, "gap", item.id, "", item.description, ""));
    for (const item of labels.forbiddenClaims) rows.push(blank(id, trade, "forbidden", item.id, "", item.description, ""));
    if (labels.document) {
      const doc = labels.document;
      const summary = [
        `${doc.lineItems.length} line item(s): ${doc.lineItems.map((line) => `${line.title} $${(line.amountCents / 100).toFixed(2)} [${line.descriptionComponents.join("; ")}]`).join(" | ")}`,
        `total ${doc.totals.totalCents === null ? "absent" : `$${(doc.totals.totalCents / 100).toFixed(2)}`}`,
        `terms ${doc.paymentTerms ?? "absent"}`,
        `warranty ${doc.warranty.present ? doc.warranty.terms.join("; ") : "absent"}`,
        `flags: ${doc.flags.map((flag) => flag.description).join(" | ")}`,
      ].join(". ");
      rows.push(blank(id, trade, "document", "document-labels", "", summary, ""));
    }
    for (let i = 0; i < MISSING_TEMPLATE_ROWS; i++) rows.push(blank(id, trade, "observation", "", "", "", ""));
  }

  const markdown = [
    "# Contractor label review packet",
    "",
    "For each row in the CSV choose a `decision`: `agree`, `edit` (fill `editedStatement` and, for observations, `editedCritical` yes/no and `editedAliases`), or `reject`.",
    "Use the blank observation rows (decision `missing`) to add an observation the labels missed.",
    "Leave every decision for a case empty if you did not review it; it stays a research draft.",
    "Do not write names, phone numbers, emails or street addresses in any cell.",
    "",
    ...selected.flatMap((evalCase) => [
      `## ${evalCase.id} (${evalCase.trade})`,
      "",
      `Workflow: ${evalCase.workflow}`,
      "",
      `Case summary: ${evalCase.caseSummary}`,
      "",
      ...evalCase.artifacts.flatMap((artifact) => [
        `### ${artifact.alias} — ${artifact.filename} (${artifact.sourceLabel})`,
        "",
        "```text",
        artifact.text,
        "```",
        "",
      ]),
    ]),
  ].join("\n");

  return { csv: toCsv(rows), markdown, caseIds: selected.map((evalCase) => evalCase.id) };
}

export type LabelImportResult = {
  cases: EvidenceEvalCase[];
  verifiedCaseIds: string[];
  incompleteCaseIds: string[];
  untouchedCaseIds: string[];
};

const PSEUDONYM = /^[a-z0-9][a-z0-9-]{1,40}$/;

function parseAliases(value: string): string[] {
  return value.split(/[\s,;]+/).filter(Boolean);
}

function parseCritical(value: string, rowNumber: number): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "yes" || normalized === "true") return true;
  if (normalized === "no" || normalized === "false") return false;
  throw new Error(`Row ${rowNumber}: critical must be yes or no.`);
}

export function applyLabelSheet(
  cases: EvidenceEvalCase[],
  csvText: string,
  reviewer: { reviewerRole: string; labeledBy: string; reviewedAt: string },
): LabelImportResult {
  if (!reviewer.reviewerRole.trim()) throw new Error("A reviewer role is required.");
  if (!PSEUDONYM.test(reviewer.labeledBy)) {
    throw new Error("labeledBy must be a lowercase pseudonymous handle such as hvac-reviewer-1, not a name.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewer.reviewedAt)) throw new Error("reviewedAt must be YYYY-MM-DD.");

  const [header, ...body] = parseCsv(csvText);
  if (!header || LABEL_SHEET_COLUMNS.some((column, index) => header[index]?.trim() !== column)) {
    throw new Error("Label sheet header does not match the exported columns.");
  }
  const byCase = new Map<string, Array<{ row: Record<(typeof LABEL_SHEET_COLUMNS)[number], string>; rowNumber: number }>>();
  body.forEach((cells, index) => {
    const row = Object.fromEntries(LABEL_SHEET_COLUMNS.map((column, i) => [column, (cells[i] ?? "").trim()])) as Record<
      (typeof LABEL_SHEET_COLUMNS)[number],
      string
    >;
    if (!row.caseId) return;
    const list = byCase.get(row.caseId) ?? [];
    list.push({ row, rowNumber: index + 2 });
    byCase.set(row.caseId, list);
  });

  const known = new Set(cases.map((evalCase) => evalCase.id));
  for (const caseId of byCase.keys()) {
    if (!known.has(caseId)) throw new Error(`Label sheet references unknown case ${caseId}.`);
  }

  const verifiedCaseIds: string[] = [];
  const incompleteCaseIds: string[] = [];
  const untouchedCaseIds: string[] = [];
  const updated = cases.map((evalCase) => {
    const rows = byCase.get(evalCase.id);
    if (!rows) {
      untouchedCaseIds.push(evalCase.id);
      return evalCase;
    }
    const labelRows = rows.filter(({ row }) => row.itemId || row.decision);
    for (const { row, rowNumber } of labelRows) {
      if (!LABEL_KINDS.includes(row.labelKind as LabelKind)) throw new Error(`Row ${rowNumber}: unknown labelKind ${row.labelKind}.`);
      if (row.decision && !DECISIONS.includes(row.decision as Decision)) throw new Error(`Row ${rowNumber}: unknown decision ${row.decision}.`);
      if (row.decision === "missing" && row.itemId) throw new Error(`Row ${rowNumber}: missing-observation rows must not reuse an item id.`);
      if (row.decision && row.decision !== "missing" && !row.itemId) throw new Error(`Row ${rowNumber}: decision ${row.decision} needs an itemId.`);
    }
    const decided = labelRows.filter(({ row }) => row.decision);
    if (decided.length === 0) {
      untouchedCaseIds.push(evalCase.id);
      return evalCase;
    }

    const labels = structuredClone(evalCase.labels);
    const existingRows = labelRows.filter(({ row }) => row.itemId);
    const expectedIds = new Set([
      ...labels.expectedObservations.map((item) => `observation:${item.id}`),
      ...labels.expectedConflicts.map((item) => `conflict:${item.id}`),
      ...labels.expectedGaps.map((item) => `gap:${item.id}`),
      ...labels.forbiddenClaims.map((item) => `forbidden:${item.id}`),
      ...(labels.document ? ["document:document-labels"] : []),
    ]);
    const seen = new Set<string>();
    let complete = true;
    let documentRejected = false;
    for (const { row, rowNumber } of existingRows) {
      const key = `${row.labelKind}:${row.itemId}`;
      if (!expectedIds.has(key)) throw new Error(`Row ${rowNumber}: ${key} is not a label of ${evalCase.id}.`);
      if (seen.has(key)) throw new Error(`Row ${rowNumber}: ${key} appears more than once.`);
      seen.add(key);
      if (!row.decision) {
        complete = false;
        continue;
      }
      const decision = row.decision as Decision;
      if (decision === "missing") continue;
      if (decision === "edit" && !row.editedStatement) throw new Error(`Row ${rowNumber}: edit needs editedStatement.`);
      if (row.labelKind === "document") {
        if (decision === "edit") throw new Error(`Row ${rowNumber}: edit document labels in the JSONL, then re-export.`);
        if (decision === "reject") documentRejected = true;
        continue;
      }
      if (row.labelKind === "observation") {
        const index = labels.expectedObservations.findIndex((item) => item.id === row.itemId);
        if (decision === "reject") labels.expectedObservations.splice(index, 1);
        else if (decision === "edit") {
          const item = labels.expectedObservations[index];
          labels.expectedObservations[index] = {
            id: item.id,
            statement: row.editedStatement,
            category: item.category,
            critical: row.editedCritical ? parseCritical(row.editedCritical, rowNumber) : item.critical,
            supportingAliases: row.editedAliases ? parseAliases(row.editedAliases) : item.supportingAliases,
          };
        }
      } else if (row.labelKind === "conflict") {
        const index = labels.expectedConflicts.findIndex((item) => item.id === row.itemId);
        if (decision === "reject") labels.expectedConflicts.splice(index, 1);
        else if (decision === "edit") {
          const item = labels.expectedConflicts[index];
          labels.expectedConflicts[index] = {
            id: item.id,
            description: row.editedStatement,
            aliases: row.editedAliases ? parseAliases(row.editedAliases) : item.aliases,
          };
        }
      } else if (row.labelKind === "gap") {
        const index = labels.expectedGaps.findIndex((item) => item.id === row.itemId);
        if (decision === "reject") labels.expectedGaps.splice(index, 1);
        else if (decision === "edit") labels.expectedGaps[index] = { id: row.itemId, description: row.editedStatement };
      } else if (row.labelKind === "forbidden") {
        const index = labels.forbiddenClaims.findIndex((item) => item.id === row.itemId);
        if (decision === "reject") labels.forbiddenClaims.splice(index, 1);
        else if (decision === "edit") labels.forbiddenClaims[index] = { id: row.itemId, description: row.editedStatement };
      }
    }
    if ([...expectedIds].some((key) => !seen.has(key))) complete = false;

    let added = 0;
    for (const { row, rowNumber } of decided.filter(({ row }) => row.decision === "missing")) {
      const statement = row.editedStatement || row.statement;
      if (!statement) throw new Error(`Row ${rowNumber}: a missing observation needs a statement.`);
      if (!row.editedCritical) throw new Error(`Row ${rowNumber}: a missing observation needs editedCritical yes/no.`);
      const aliases = parseAliases(row.editedAliases || row.supportingAliases);
      if (aliases.length === 0) throw new Error(`Row ${rowNumber}: a missing observation needs supporting aliases.`);
      added += 1;
      const observation: ExpectedObservation = {
        id: `${evalCase.id}-cv${added}`.slice(0, 80),
        statement,
        category: "contractor-added",
        critical: parseCritical(row.editedCritical, rowNumber),
        supportingAliases: aliases,
      };
      labels.expectedObservations.push(observation);
    }

    const verified = complete && !documentRejected;
    const next = evidenceCaseSchema.parse({
      ...evalCase,
      labels,
      labelProvenance: verified
        ? {
            status: "contractor-verified",
            labeledBy: reviewer.labeledBy,
            labeledAt: reviewer.reviewedAt,
            reviewerRole: reviewer.reviewerRole.trim(),
            ...(evalCase.labelProvenance.source ? { source: evalCase.labelProvenance.source } : {}),
          }
        : evalCase.labelProvenance,
    });
    (verified ? verifiedCaseIds : incompleteCaseIds).push(evalCase.id);
    // An incomplete review must not partially rewrite research-draft labels.
    return verified ? next : evalCase;
  });

  return { cases: updated, verifiedCaseIds, incompleteCaseIds, untouchedCaseIds };
}
