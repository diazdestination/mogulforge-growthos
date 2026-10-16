import { describe, expect, it } from "vitest";
import { DEMO_COMPANIES } from "./demo-data.mjs";
import { addDays, classifyBaseUrl, parseArgs, stableId, zonedInstant } from "./seed-soft-onboarding.mjs";

describe("soft-onboarding seeder target guard", () => {
  it("accepts only the local demo runtime ports and the exact staging origin", () => {
    expect(classifyBaseUrl("http://127.0.0.1:4192")).toEqual({ target: "local", origin: "http://127.0.0.1:4192" });
    expect(classifyBaseUrl("http://localhost:4193/")).toEqual({ target: "local", origin: "http://localhost:4193" });
    expect(classifyBaseUrl("https://mogulforge-growthos-staging.fly.dev")).toEqual({ target: "staging", origin: "https://mogulforge-growthos-staging.fly.dev" });
  });

  it.each([
    "https://mogulforge-growthos.fly.dev",
    "https://MOGULFORGE-GROWTHOS.fly.dev/",
    "http://mogulforge-growthos.internal:8080",
    "http://mogulforge-growthos.flycast",
    "https://app.mogulforge.com",
    "https://mogulforge.app",
    "https://growthos.example.org",
  ])("refuses production-like host %s", (url) => {
    expect(() => classifyBaseUrl(url)).toThrow(/production/);
  });

  it.each([
    "http://mogulforge-growthos-staging.fly.dev",
    "https://mogulforge-growthos-staging.fly.dev.evil.example",
    "https://mogulforge-growthos-staging.fly.dev:8443",
    "https://mogulforge-growthos-staging.fly.dev/api",
    "https://user:pw@mogulforge-growthos-staging.fly.dev",
    "http://127.0.0.1:4194",
    "http://127.0.0.1",
    "https://127.0.0.1:4192",
    "http://10.0.0.5:4192",
    "not a url",
    "",
  ])("refuses non-allowlisted target %s", (url) => {
    expect(() => classifyBaseUrl(url)).toThrow(/Refusing/);
  });

  it("is dry-run by default and validates options", () => {
    expect(parseArgs(["--base-url", "http://127.0.0.1:4192"])).toMatchObject({ apply: false, company: "both" });
    expect(parseArgs(["--base-url", "x", "--apply", "--company", "css"])).toMatchObject({ apply: true, company: "css" });
    expect(() => parseArgs(["--base-url", "x", "--company", "acme"])).toThrow();
    expect(() => parseArgs(["--company", "css"])).toThrow(/base-url/);
    expect(() => parseArgs(["--base-url", "x", "--demo-date", "10/17"])).toThrow();
  });
});

describe("soft-onboarding demo data", () => {
  it("labels every company and record as TEST with fictional contact details", () => {
    for (const company of Object.values(DEMO_COMPANIES)) {
      expect(company.name.startsWith("TEST Demo - ")).toBe(true);
      for (const c of company.customers) {
        expect(c.last).toMatch(/\(TEST\)$/);
        expect(c.email).toMatch(/@example\.com$/);
        expect(c.phone).toMatch(/555-01\d\d$/);
      }
      for (const s of company.staff) expect(s.email).toMatch(/@example\.com$/);
      for (const l of company.leads) expect(l.summary.startsWith("TEST")).toBe(true);
      for (const e of company.estimates) expect(e.title.startsWith("TEST")).toBe(true);
      for (const a of company.appointments) expect(a.notes.startsWith("TEST")).toBe(true);
      for (const i of company.invoices) expect(i.title.startsWith("TEST")).toBe(true);
      for (const t of company.tasks) expect(t.title.startsWith("TEST")).toBe(true);
    }
  });

  it("uses exact demo company names", () => {
    expect(DEMO_COMPANIES.css.name).toBe("TEST Demo - Climate Simulation Solutions (HVAC)");
    expect(DEMO_COMPANIES.painless.name).toBe("TEST Demo - Painless Roofing");
  });
});

describe("helpers", () => {
  it("converts company wall-clock time to an instant across DST", () => {
    expect(zonedInstant("2026-10-17", "09:00", "America/New_York").toISOString()).toBe("2026-10-17T13:00:00.000Z");
    expect(zonedInstant("2026-12-01", "09:00", "America/New_York").toISOString()).toBe("2026-12-01T14:00:00.000Z");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
  });
  it("derives stable RFC-4122-shaped request IDs", () => {
    expect(stableId("org", "invoice", "a")).toBe(stableId("org", "invoice", "a"));
    expect(stableId("org", "invoice", "a")).not.toBe(stableId("org", "invoice", "b"));
    expect(stableId("x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
