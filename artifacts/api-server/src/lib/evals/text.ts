/** Small deterministic text helpers shared by the lexical judge and scorers. */

const STOPWORDS = new Set(
  "a an and are as at be been by for from has have in into is it its of on or that the their there this to was were with without not no per".split(
    " ",
  ),
);

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/(\d)\.00\b/g, "$1")
    .replace(/[^a-z0-9.%/ ]+/g, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stem(token: string): string {
  if (/^\d/.test(token)) return token;
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (token.length > suffix.length + 3 && token.endsWith(suffix)) return token.slice(0, -suffix.length);
  }
  return token;
}

export function contentTokens(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map(stem);
}

/** Fraction of the expected text's content tokens that appear in the candidate. */
export function tokenCoverage(expected: string, candidate: string): number {
  const wanted = new Set(contentTokens(expected));
  if (wanted.size === 0) return 0;
  const have = new Set(contentTokens(candidate));
  let hit = 0;
  for (const token of wanted) if (have.has(token)) hit += 1;
  return hit / wanted.size;
}

/**
 * Every key term must be present; `a|b` accepts either alternative. Numeric
 * terms must match whole tokens ("2" never matches "2026"); word terms match
 * at a token start so "crease" also finds "creased".
 */
export function keyTermsPresent(terms: string[], candidate: string): boolean {
  const haystack = ` ${normalizeText(candidate)} `;
  return terms.every((term) =>
    term.split("|").some((alternative) => {
      const needle = normalizeText(alternative);
      if (needle.length === 0) return false;
      return /\d$/.test(needle) ? haystack.includes(` ${needle} `) : haystack.includes(` ${needle}`);
    }),
  );
}

/* --------------------------------------------------------------- CSV */

export function toCsv(rows: string[][]): string {
  return (
    rows
      .map((row) =>
        row
          .map((cell) => (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
          .join(","),
      )
      .join("\r\n") + "\r\n"
  );
}

export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const text = input.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell.length === 0) quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (quoted) throw new Error("CSV ends inside a quoted cell.");
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((value) => value.trim().length > 0));
}
