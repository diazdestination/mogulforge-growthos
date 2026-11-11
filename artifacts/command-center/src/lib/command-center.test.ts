import { describe, expect, it } from "vitest";
import {
  agentStatuses,
  buildNeeds,
  greeting,
  phoneLabel,
  summaryLine,
  type CommandInputs,
  type WorkDay,
} from "./command-center";

const now = new Date("2026-11-11T13:00:00Z"); // 8:00 AM in New York
const queue = { items: [], total: 0, truncated: false };
function day(overrides: Partial<WorkDay> = {}): WorkDay {
  return {
    organizationId: "o1",
    date: "2026-11-11",
    timeZone: "America/New_York",
    startAt: "2026-11-11T05:00:00Z",
    endAt: "2026-11-12T05:00:00Z",
    scope: "company",
    appointments: queue,
    tasks: queue,
    projects: queue,
    services: queue,
    ...overrides,
  };
}
const base = (overrides: Partial<CommandInputs> = {}): CommandInputs => ({
  now,
  timeZone: "America/New_York",
  ...overrides,
});

describe("command center helpers", () => {
  it("greets in the company's time zone", () => {
    expect(greeting(now, "America/New_York", "Adam")).toBe("Good morning, Adam");
    expect(greeting(new Date("2026-11-11T19:00:00Z"), "America/New_York", null)).toBe("Good afternoon");
    expect(greeting(new Date("2026-11-11T23:30:00Z"), "America/New_York", "Jo")).toBe("Good evening, Jo");
  });

  it("formats US phone numbers in plain words", () => {
    expect(phoneLabel("+12025550101")).toBe("(202) 555-0101");
    expect(phoneLabel(null)).toBe("an unknown number");
  });

  it("puts overdue callbacks and late money first, and skips paid or future invoices", () => {
    const needs = buildNeeds(
      base({
        day: day(),
        callbacks: [{ id: "c1", phone: "+12025550101", state: "open", overdue: true, dueAt: null, createdAt: "2026-11-11T12:00:00Z" }],
        invoices: [
          { id: "i1", status: "issued", title: "Roof repair", customerName: "James", totalCents: 1240000, dueDate: "2026-11-04", balanceDueCents: 1240000, paymentState: "unpaid" },
          { id: "i2", status: "issued", title: "Paid job", customerName: "Ann", totalCents: 5000, dueDate: "2026-11-01", balanceDueCents: 0, paymentState: "paid" },
          { id: "i3", status: "issued", title: "Not due", customerName: "Bo", totalCents: 5000, dueDate: "2026-12-01", balanceDueCents: 5000, paymentState: "unpaid" },
          { id: "i4", status: "draft", title: "Draft", customerName: "Cy", totalCents: 5000, dueDate: "2026-11-01", balanceDueCents: 5000, paymentState: "unpaid" },
        ],
        nba: [{ leadId: "l1", actionType: "call_now", title: "Call this lead now", reasons: ["Hot lead"], priority: 96, contactName: "Sarah" }],
      }),
    );
    expect(needs.map((n) => n.key)).toEqual(["callie:c1", "bill:i1", "scout:l1"]);
    expect(needs[0]).toMatchObject({ title: "Call back (202) 555-0101", href: "/calls", tone: "urgent" });
    expect(needs[1]).toMatchObject({ title: "Collect $12,400 from James", detail: "Roof repair is 7 days past due.", href: "/invoices/i1" });
    expect(needs[2]).toMatchObject({ title: "Call Sarah", action: "Call now", href: "/leads/l1" });
  });

  it("flags unassigned visits and estimates waiting three days or more", () => {
    const needs = buildNeeds(
      base({
        day: day({
          appointments: {
            items: [
              { id: "a1", type: "estimate_review", status: "scheduled", scheduledStart: "2026-11-11T18:00:00Z", scheduledEnd: "2026-11-11T19:00:00Z", customerLabel: "William", assigneeName: null },
              { id: "a2", type: "inspection", status: "completed", scheduledStart: "2026-11-11T14:00:00Z", scheduledEnd: null, customerLabel: "Done", assigneeName: "Kim" },
            ],
            total: 2,
            truncated: false,
          },
        }),
        estimates: [
          { id: "e1", title: "Roof", status: "sent", totalCents: 1865000, leadLabel: "Ava", sentAt: "2026-11-05T12:00:00Z", updatedAt: "2026-11-05T12:00:00Z" },
          { id: "e2", title: "Gutters", status: "sent", totalCents: 1000, leadLabel: "Ben", sentAt: "2026-11-10T12:00:00Z", updatedAt: "2026-11-10T12:00:00Z" },
        ],
      }),
    );
    expect(needs.map((n) => n.key)).toEqual(["appt:a1", "esti:e1"]);
    expect(needs[0]).toMatchObject({ title: "1:00 PM · Estimate review with William", action: "Assign someone", tone: "urgent" });
    expect(needs[1]).toMatchObject({ title: "Nudge Ava about a $18,650 estimate", detail: "Sent 6 days ago with no answer yet." });
  });

  it("never shows money to members who cannot read invoices", () => {
    const hidden = new Set(["bill", "invo"] as const);
    const input = base({
      hidden,
      invoices: [{ id: "i1", status: "issued", title: "Roof", customerName: "James", totalCents: 100, dueDate: "2026-11-01", balanceDueCents: 100, paymentState: "unpaid" }],
      draftInvoiceCount: 3,
    });
    expect(buildNeeds(input)).toEqual([]);
    const statuses = agentStatuses(input);
    expect(statuses.filter((s) => s.state === "hidden").map((s) => s.agent)).toEqual(["bill", "invo"]);
  });

  it("gives every specialist a plain status line, and says when it could not check", () => {
    const statuses = agentStatuses(
      base({
        day: day({ appointments: { items: [{ id: "a1", type: "inspection", status: "scheduled", scheduledStart: "2026-11-11T14:30:00Z", scheduledEnd: null, customerLabel: null, assigneeName: "Kim" }], total: 1, truncated: false } }),
        nba: [],
        callbacks: null,
        invoices: [{ id: "i1", status: "issued", title: "Roof", customerName: "James", totalCents: 1240000, dueDate: "2026-11-04", balanceDueCents: 1000000, paymentState: "partial" }],
        draftInvoiceCount: 0,
        estimates: [],
      }),
      { esti: true },
    );
    const line = Object.fromEntries(statuses.map((s) => [s.agent, `${s.state}: ${s.line}`]));
    expect(line).toEqual({
      scout: "clear: Every lead has a next step",
      callie: "unknown: Tap to check in",
      appt: "needs-you: 1 visit today · next at 9:30 AM",
      sched: "clear: No crew jobs on the board today",
      esti: "unknown: Checking…",
      bill: "needs-you: $10,000 owed · 1 late",
      invo: "clear: No drafts waiting to go out",
      maintain: "clear: No service coming due",
    });
  });

  it("sums up the day in one sentence", () => {
    expect(summaryLine([], true)).toBe("Your team is checking on everything…");
    expect(summaryLine([], false)).toBe("You're all caught up. Nothing needs you right now.");
    const needs = buildNeeds(base({ callbacks: [{ id: "c1", phone: null, state: "open", overdue: false, dueAt: null, createdAt: "" }] }));
    expect(summaryLine(needs, false)).toBe("1 thing needs you today, 1 of them right away.");
  });
});
