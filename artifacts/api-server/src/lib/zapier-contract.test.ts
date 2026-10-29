import { describe, expect, it } from "vitest";

import {
  ACCOUNTING_INVOICE_INPUT,
  CALENDAR_EVENT_INPUT,
  findZapierCandidate,
  getZapierCapability,
  summarizeZapierInput,
  ZAPIER_CAPABILITIES,
  ZAPIER_CAPABILITY_KEYS,
} from "../services/zapier/zapier-capabilities";
import {
  canonicalJson,
  detectServerMode,
  sha256Hex,
  summarizeZapierResult,
  validateZapierServerUrl,
  zapierMcpConfig,
  ZapierMcpError,
} from "../services/zapier/zapier-mcp-client";

describe("Zapier MCP client contract", () => {
  it("accepts only https URLs on Zapier's MCP host without credentials", () => {
    expect(validateZapierServerUrl("https://mcp.zapier.com/api/mcp/s/abc123/mcp").hostname).toBe("mcp.zapier.com");
    for (const bad of [
      "http://mcp.zapier.com/api/mcp/s/abc/mcp",
      "https://user:pw@mcp.zapier.com/api/mcp/s/abc/mcp",
      "https://evil.example/mcp",
      "https://mcp.zapier.com.evil.example/mcp",
      "not a url",
    ]) {
      expect(() => validateZapierServerUrl(bad)).toThrow(ZapierMcpError);
    }
  });

  it("requires both the embed id and the embed secret", () => {
    expect(zapierMcpConfig({})).toBeNull();
    expect(zapierMcpConfig({ ZAPIER_MCP_EMBED_ID: "e" })).toBeNull();
    expect(zapierMcpConfig({ ZAPIER_MCP_EMBED_ID: "e", ZAPIER_MCP_EMBED_SECRET: " s " })).toEqual({ embedId: "e", embedSecret: "s" });
  });

  it("produces key-order independent digests", () => {
    const a = canonicalJson({ b: [1, { d: 2, c: 3 }], a: "x", skipped: undefined });
    const b = canonicalJson({ a: "x", b: [1, { c: 3, d: 2 }] });
    expect(a).toBe(b);
    expect(sha256Hex(a)).toBe(sha256Hex(b));
    expect(sha256Hex(a)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("detects agentic versus managed servers from the tool list", () => {
    expect(detectServerMode([{ name: "execute_zapier_write_action", description: null }])).toBe("agentic");
    expect(detectServerMode([{ name: "google_calendar_create_detailed_event", description: null }])).toBe("managed");
    expect(detectServerMode([])).toBe("unknown");
  });
});

describe("Zapier capability registry", () => {
  it("declares every capability exactly once with a reviewed candidate set", () => {
    expect(ZAPIER_CAPABILITIES.map((item) => item.key).sort()).toEqual([...ZAPIER_CAPABILITY_KEYS].sort());
    for (const definition of ZAPIER_CAPABILITIES) {
      expect(definition.candidates.length).toBeGreaterThan(0);
      expect(["read", "write"]).toContain(definition.direction);
      expect(definition.defaultDailyBudget).toBeGreaterThan(0);
      // Writes default to human approval unless the registry explicitly says auto.
      if (definition.direction === "write" && definition.key !== "appt.calendar.create_event") {
        expect(definition.defaultMode).toBe("approve");
      }
    }
  });

  it("maps a calendar event deterministically and never passes unvalidated fields", () => {
    const definition = getZapierCapability("appt.calendar.create_event")!;
    const candidate = findZapierCandidate(definition, { app: "GoogleCalendarCLIAPI", action: "detailed_event" })!;
    const input = CALENDAR_EVENT_INPUT.parse({
      title: "Roof inspection: Jane Doe",
      startsAt: "2026-11-03T14:00:00.000Z",
      endsAt: "2026-11-03T15:00:00.000Z",
      timezone: "America/New_York",
      attendeeEmails: ["crew@example.test"],
      ignored: "should not pass",
    } as unknown);
    const params = candidate.toParams(input, { calendarid: "primary" });
    expect(params).toEqual({
      calendarid: "primary",
      summary: "Roof inspection: Jane Doe",
      description: "",
      location: "",
      start_time: "2026-11-03T14:00:00.000Z",
      end_time: "2026-11-03T15:00:00.000Z",
      timezone: "America/New_York",
      attendees: "crew@example.test",
    });
    expect(Object.keys(params)).not.toContain("ignored");
  });

  it("matches live actions by display name when ids differ, but never across direction", () => {
    const definition = getZapierCapability("invo.accounting.create_invoice")!;
    expect(findZapierCandidate(definition, { app: "QuickBooksOnlineCLIAPI", appName: "QuickBooks Online", action: "create_invoice", actionName: "Create Invoice" })).not.toBeNull();
    expect(findZapierCandidate(definition, { app: "QuickBooksOnlineCLIAPI", appName: "QuickBooks Online", action: "find_customer", actionName: "Find Customer" })).toBeNull();
  });

  it("formats money for accounting as decimal strings and keeps totals", () => {
    const definition = getZapierCapability("invo.accounting.create_invoice")!;
    const candidate = findZapierCandidate(definition, { app: "QuickBooksCLIAPI", action: "invoice" })!;
    const input = ACCOUNTING_INVOICE_INPUT.parse({
      invoiceNumber: "INV-42",
      customerName: "Jane Doe",
      issuedOn: "2026-10-29",
      lineItems: [{ description: "Shingles", quantity: 2, unitPriceCents: 125050, totalCents: 250100 }],
      subtotalCents: 250100,
      taxCents: 17507,
      totalCents: 267607,
    });
    const params = candidate.toParams(input, {}) as { line_items: { unit_price: string; amount: string }[]; total_amount: string };
    expect(params.line_items[0]).toMatchObject({ unit_price: "1250.50", amount: "2501.00" });
    expect(params.total_amount).toBe("2676.07");
  });

  it("summarizes inputs through the allow-list only", () => {
    const definition = getZapierCapability("callie.sms.send")!;
    expect(summarizeZapierInput(definition, { toPhone: "+14045550100", body: "private message text" })).toEqual({ toPhone: "+14045550100" });
  });
});

describe("Zapier result summaries", () => {
  it("keeps only allow-listed identifiers and counts", () => {
    expect(summarizeZapierResult({ results: [{ id: "evt_1", htmlLink: "https://calendar/x", attendees: ["secret@x"] }] })).toEqual({
      count: 1,
      id: "evt_1",
      htmlLink: "https://calendar/x",
    });
    expect(summarizeZapierResult([1, 2, 3])).toEqual({ count: 3 });
    expect(summarizeZapierResult("plain text")).toEqual({});
  });
});
