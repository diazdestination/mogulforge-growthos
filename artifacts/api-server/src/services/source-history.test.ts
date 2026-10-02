import { describe, expect, it } from "vitest";
import { needsSourceVerification, originalOpportunityDate, parseSourceAmount, parseSourceDate } from "./source-history";

describe("source history validation", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  it("accepts explicit calendar dates/timezones without guessing locale or future dates", () => {
    expect(parseSourceDate("2026-07-01", "Date", now)).toBe("2026-07-01T00:00:00.000Z");
    expect(parseSourceDate("2026-07-01T09:00:00-07:00", "Date", now)).toBe("2026-07-01T16:00:00.000Z");
    expect(parseSourceDate("", "Date", now)).toBeNull();
    for (const input of ["07/01/2026", "2026-02-30", "2026-07-01T25:00:00Z", "2026-11-01", "2026-07-01T09:00:00"]) {
      expect(() => parseSourceDate(input, "Date", now)).toThrow();
    }
  });
  it("keeps an unknown amount distinct from zero and rejects guesses/overflow", () => {
    expect(parseSourceAmount("")).toBeNull();
    expect(parseSourceAmount("0")).toBe(0);
    expect(parseSourceAmount("12,345.67")).toBe(1_234_567);
    for (const input of ["1.999", "1,23", "-5", "$10", "1e4", "21474836.48"]) {
      expect(() => parseSourceAmount(input)).toThrow();
    }
  });
  it("does not use ingestion as a guessed original date for legacy imports", () => {
    const createdAt = new Date("2026-10-01T00:00:00Z");
    expect(originalOpportunityDate({ createdAt, creationMethod: "import" })).toBeNull();
    expect(originalOpportunityDate({ createdAt, creationMethod: "form" })).toEqual(createdAt);
    expect(needsSourceVerification({ creationMethod: "import" })).toBe(true);
    expect(needsSourceVerification({ creationMethod: "form" })).toBe(false);
  });
});
