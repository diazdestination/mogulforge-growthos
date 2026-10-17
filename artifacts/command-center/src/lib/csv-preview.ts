/**
 * Validate the whole CSV and retain its first rows for column mapping. Mirrors
 * the server's parser so the selected columns are the ones the server applies.
 */
export function parseCsvPreview(text: string, maxRows = 6): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false;
  const invalid = () => { throw new Error("The CSV contains invalid quoting."); };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (inQuotes) {
      if (c === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; afterQuote = true; }
      else field += c;
    } else if (c === '"') {
      if (field !== "" || afterQuote) invalid();
      inQuotes = true;
    }
    else if (c === ",") { row.push(field); field = ""; afterQuote = false; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && source[i + 1] === "\n") i++;
      row.push(field); field = ""; afterQuote = false;
      if (rows.length < maxRows && row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      if (afterQuote) invalid();
      field += c;
    }
  }
  if (inQuotes) invalid();
  if (rows.length < maxRows) {
    row.push(field);
    if (row.some((f) => f.trim() !== "")) rows.push(row);
  }
  return rows;
}

export type CustomerImportField = "firstName" | "lastName" | "email" | "phone" | "externalCustomerId";

// Generic header names only. These are suggestions staff must confirm; they are
// not an approved Housecall Pro layout.
const SYNONYMS: Record<CustomerImportField, RegExp> = {
  firstName: /^(first[\s_-]*name|first|given[\s_-]*name)$/i,
  lastName: /^(last[\s_-]*name|last|surname|family[\s_-]*name)$/i,
  email: /^(e-?mail|e-?mail[\s_-]*address)$/i,
  phone: /^(mobile[\s_-]*(number|phone)?|cell[\s_-]*(number|phone)?|phone[\s_-]*(number)?)$/i,
  externalCustomerId: /^(customer[\s_-]*)?id$/i,
};

export function suggestCustomerMapping(header: string[]): Partial<Record<CustomerImportField, number>> {
  const result: Partial<Record<CustomerImportField, number>> = {};
  const used = new Set<number>();
  for (const field of Object.keys(SYNONYMS) as CustomerImportField[]) {
    const index = header.findIndex((name, i) => !used.has(i) && SYNONYMS[field].test(name.trim()));
    if (index >= 0) { result[field] = index; used.add(index); }
  }
  return result;
}
