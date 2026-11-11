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

export type CustomerImportField =
  | "firstName" | "lastName" | "email" | "phone" | "externalCustomerId"
  | "addressLine1" | "addressLine2" | "city" | "state" | "postalCode"
  | "address2Line1" | "address2Line2" | "address2City" | "address2State" | "address2PostalCode"
  | "tags" | "source" | "notes";

// Generic header names plus the published Housecall Pro customer export
// ("Address_1 Street Line 1", "Tags", "Notes", "ID"). These are suggestions
// staff must confirm; they are not an approved layout.
const first = "(?:address[_\\s-]*1[_\\s-]*)?";
const second = "address[_\\s-]*2[_\\s-]*";
const parts = {
  line1: "(?:street[\\s_-]*line[\\s_-]*1|street|address[\\s_-]*line[\\s_-]*1|service[\\s_-]*address)",
  line2: "(?:street[\\s_-]*line[\\s_-]*2|address[\\s_-]*line[\\s_-]*2|unit|apt|suite)",
  city: "city",
  state: "(?:state|province)",
  postal: "(?:postal[\\s_-]*code|zip(?:[\\s_-]*code)?)",
};
const re = (prefix: string, part: string) => new RegExp(`^${prefix}${part}$`, "i");
const SYNONYMS: Record<CustomerImportField, RegExp> = {
  firstName: /^(first[\s_-]*name|first|given[\s_-]*name)$/i,
  lastName: /^(last[\s_-]*name|last|surname|family[\s_-]*name)$/i,
  email: /^(e-?mail|e-?mail[\s_-]*address)$/i,
  phone: /^(mobile[\s_-]*(number|phone)?|cell[\s_-]*(number|phone)?|phone[\s_-]*(number)?)$/i,
  externalCustomerId: /^(customer[\s_-]*)?id$/i,
  addressLine1: re(first, parts.line1),
  addressLine2: re(first, parts.line2),
  city: re(first, parts.city),
  state: re(first, parts.state),
  postalCode: re(first, parts.postal),
  address2Line1: re(second, parts.line1),
  address2Line2: re(second, parts.line2),
  address2City: re(second, parts.city),
  address2State: re(second, parts.state),
  address2PostalCode: re(second, parts.postal),
  tags: /^(customer[\s_-]*)?tags?$/i,
  source: /^(lead[\s_-]*source|source|referral[\s_-]*source)$/i,
  notes: /^(customer[\s_-]*)?notes$/i,
};
// Some exports repeat the first address block's names for the second address.
const SECOND_BLOCK: Partial<Record<CustomerImportField, CustomerImportField>> = {
  address2Line1: "addressLine1", address2Line2: "addressLine2", address2City: "city", address2State: "state", address2PostalCode: "postalCode",
};

export function suggestCustomerMapping(header: string[]): Partial<Record<CustomerImportField, number>> {
  const result: Partial<Record<CustomerImportField, number>> = {};
  const used = new Set<number>();
  const find = (pattern: RegExp) => header.findIndex((name, i) => !used.has(i) && pattern.test(name.trim()));
  for (const field of Object.keys(SYNONYMS) as CustomerImportField[]) {
    let index = find(SYNONYMS[field]);
    const repeated = SECOND_BLOCK[field];
    if (index < 0 && repeated && result[repeated] !== undefined) index = find(SYNONYMS[repeated]);
    if (index >= 0) { result[field] = index; used.add(index); }
  }
  return result;
}
