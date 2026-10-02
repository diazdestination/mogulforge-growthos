import type { ImportedOpportunityHistory } from "@workspace/db";

export class SourceHistoryValidationError extends Error {}

/** Source dates are independent of the time GrowthOS received a record. */
export function originalOpportunityDate(lead: {
  createdAt: Date;
  creationMethod?: string | null;
  importedHistory?: ImportedOpportunityHistory | null;
}): Date | null {
  if (lead.importedHistory) {
    return lead.importedHistory.originalCreatedAt
      ? new Date(lead.importedHistory.originalCreatedAt)
      : null;
  }
  return lead.creationMethod === "import" ? null : lead.createdAt;
}

export function sourceLastContactDate(history?: ImportedOpportunityHistory | null): Date | null {
  return history?.lastContactAt ? new Date(history.lastContactAt) : null;
}

/** No freshness attestation exists yet. CSV uploads cannot authorize automated outreach. */
export function needsSourceVerification(lead: {
  creationMethod?: string | null;
  importedHistory?: ImportedOpportunityHistory | null;
}): boolean {
  return lead.creationMethod === "import" || lead.importedHistory?.kind === "csv_snapshot";
}

/** Unambiguous ISO date or timestamp only; reject Date's rollover normalization. */
export function parseSourceDate(value: string | undefined, field: string, now: Date): string | null {
  const input = value?.trim();
  if (!input) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(input);
  if (!dateOnly && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input)) {
    throw new SourceHistoryValidationError(`${field} must be YYYY-MM-DD or an ISO timestamp with timezone`);
  }
  const [year, month, day] = input.slice(0, 10).split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const parsed = new Date(dateOnly ? `${input}T00:00:00.000Z` : input);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || !Number.isFinite(parsed.getTime()) ||
      (!dateOnly && (Number(input.slice(11, 13)) > 23 || Number(input.slice(14, 16)) > 59 || Number(input.slice(17, 19)) > 59))) {
    throw new SourceHistoryValidationError(`${field} is not a valid calendar date`);
  }
  if (parsed.getTime() > now.getTime()) throw new SourceHistoryValidationError(`${field} cannot be in the future`);
  return parsed.toISOString();
}

/** Amount input is explicitly USD dollars, never guessed or converted from other currencies. */
export function parseSourceAmount(value: string | undefined): number | null {
  const input = value?.trim();
  if (!input) return null;
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(input)) {
    throw new SourceHistoryValidationError("Estimate amount must be a non-negative USD amount with at most two decimals");
  }
  const [whole, fraction = ""] = input.replace(/,/g, "").split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 2_147_483_647) throw new SourceHistoryValidationError("Estimate amount is too large");
  return cents;
}
