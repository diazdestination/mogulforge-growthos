import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RevenueWorkspace,
  ValueLedger,
  parseRecordedCents,
} from "./revenue-workspace";
import { renderWithQuery } from "@/test/render";
import { mockApi } from "@/test/mock-api";
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const desk = () => ({
  queue: [
    {
      leadId: "lead-one",
      contactName: "Local Customer",
      title: "Review this inquiry",
      reasons: ["No recorded response"],
      assignedUserId: null,
      receivedAt: "2026-09-14T12:00:00Z",
      source: "qa",
      proposals: [],
    },
  ],
  records: [{ id: "lead-one", summary: "LOCAL QA roof", status: "new" }],
  proposals: [],
  profile: null,
  executions: [],
  staff: [],
  followup: {
    summary: { unassigned: 1, overdue: 1, awaitingAttempt: 1 },
    pending: [],
  },
  boundary: "Suggestions are not delivery.",
});
const ledger = () => ({
  entryCount: 0,
  receiptEntryCount: 0,
  costEntryCount: 0,
  acceptedEstimateCount: 0,
  acceptedEstimateCents: 0,
  completedProjectCount: 0,
  netReceiptsCents: 0,
  netDirectCostsCents: 0,
  recordedContributionCents: null,
  entries: [],
  boundary: "Staff-recorded data is not a bank feed or causal ROI.",
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("Revenue Desk workflows", () => {
  it("renders recorded context and makes claim ownership an explicit action", async () => {
    const spy = mockApi("owner", {
      handler: (method, path) =>
        path.endsWith("/revenue/desk")
          ? response(desk())
          : path.endsWith("/revenue/leads/lead-one/claim")
            ? response({ id: "lead-one" })
            : undefined,
    });
    renderWithQuery(<RevenueWorkspace />);
    expect(await screen.findByText("Local Customer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Claim for me" }));
    await screen.findByText(
      "You now own this inquiry. No contact attempt was recorded.",
    );
    expect(
      spy.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    const sent = spy.mock.calls.find(([url]) => String(url).includes("/claim"));
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({ confirmed: true });
  });
  it("hides consequential controls from viewers", async () => {
    mockApi("viewer", {
      handler: (_m, p) =>
        p.endsWith("/revenue/desk") ? response(desk()) : undefined,
    });
    renderWithQuery(<RevenueWorkspace />);
    await screen.findByText("Local Customer");
    expect(screen.queryByRole("button", { name: "Claim for me" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Business knowledge" }));
    expect(
      screen.queryByRole("button", { name: "Approve knowledge version" }),
    ).toBeNull();
    expect(
      (screen.getByLabelText("Services offered") as HTMLTextAreaElement)
        .disabled,
    ).toBe(true);
  });
  it("requires explicit knowledge approval and preserves unsaved content after failure", async () => {
    mockApi("owner", {
      handler: (m, p) =>
        p.endsWith("/revenue/desk")
          ? response(desk())
          : p.endsWith("/revenue/profile") && m === "POST"
            ? response({ error: "Profile changed. Refresh." }, 409)
            : undefined,
    });
    renderWithQuery(<RevenueWorkspace />);
    await screen.findByText("Local Customer");
    fireEvent.click(screen.getByRole("button", { name: "Business knowledge" }));
    const save = screen.getByRole("button", {
      name: "Approve knowledge version",
    });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    for (const label of [
      "Services offered",
      "Service area",
      "Business hours",
      "Human escalation and response policy",
      "Approved materials and brands",
      "Verified warranty terms",
      "Pricing and commitment boundaries",
      "Approval source / reference",
    ])
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: `LOCAL QA ${label}` },
      });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(save);
    await screen.findByRole("alert");
    expect(
      (screen.getByLabelText("Services offered") as HTMLTextAreaElement).value,
    ).toBe("LOCAL QA Services offered");
  });
  it("renders unavailable rather than invented healthy or zero states", async () => {
    mockApi("owner", {
      handler: (_m, p) =>
        p.endsWith("/revenue/desk")
          ? response({ error: "offline" }, 503)
          : undefined,
    });
    renderWithQuery(<RevenueWorkspace />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "No empty totals",
    );
    expect(screen.queryByText("Inquiries needing an owner")).toBeNull();
  });
  it("keeps an empty ledger distinct from zero verified revenue", async () => {
    mockApi("owner", {
      handler: (_m, p) =>
        p.endsWith("/revenue/value") ? response(ledger()) : undefined,
    });
    renderWithQuery(<ValueLedger />);
    expect(await screen.findByText("Not available")).toBeTruthy();
    expect(screen.getAllByText("Not recorded")).toHaveLength(2);
    expect(
      screen.getByText("Staff-recorded data is not a bank feed or causal ROI."),
    ).toBeTruthy();
  });
  it("provides a true project-story empty state and no publish control", async () => {
    mockApi("owner", {
      handler: (_m, p) =>
        p.endsWith("/revenue/desk")
          ? response(desk())
          : p.endsWith("/revenue/growth")
            ? response({
                projects: [],
                stories: [],
                boundary: "Nothing publishes from this screen.",
              })
            : undefined,
    });
    renderWithQuery(<RevenueWorkspace />);
    await screen.findByText("Local Customer");
    fireEvent.click(screen.getByRole("button", { name: "Project stories" }));
    await screen.findByText(/No completed projects are recorded/);
    expect(screen.queryByRole("button", { name: /publish/i })).toBeNull();
  });
  it("does not present missing job costs as zero contribution expenses", async () => {
    mockApi("owner", {
      handler: (_m, p) =>
        p.endsWith("/revenue/value")
          ? response({
              ...ledger(),
              entryCount: 1,
              receiptEntryCount: 1,
              costEntryCount: 0,
              netReceiptsCents: 50000,
              recordedContributionCents: null,
            })
          : undefined,
    });
    renderWithQuery(<ValueLedger />);
    expect(await screen.findByText("Not available")).toBeTruthy();
    expect(screen.getByText("Not recorded")).toBeTruthy();
    expect(screen.getByText("$500.00")).toBeTruthy();
  });
  it("shows indeterminate receipts and gates owner reconciliation", async () => {
    mockApi("owner", {
      handler: (_m, p) =>
        p.endsWith("/revenue/desk")
          ? response({
              ...desk(),
              executions: [
                {
                  id: "e-one",
                  kind: "send_email",
                  state: "indeterminate",
                  createdAt: "2026-09-14T12:00:00Z",
                  expiresAt: "2026-09-14T12:15:00Z",
                  detail: "Check provider before replay.",
                },
              ],
            })
          : undefined,
    });
    renderWithQuery(<RevenueWorkspace />);
    await screen.findByText("Local Customer");
    fireEvent.click(screen.getByText("Execution history · 1 recent records"));
    const save = screen.getByRole("button", {
      name: "Record reconciliation without replay",
    });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("Check provider before replay.", { exact: false }),
    ).toBeTruthy();
  });
  it("parses monetary inputs exactly without floating-point rounding", () => {
    expect(parseRecordedCents("19.99")).toBe(1999);
    expect(parseRecordedCents("0.01")).toBe(1);
    for (const value of ["-1", "0", "12.999", "1e4", "NaN", "10000000.01"])
      expect(() => parseRecordedCents(value)).toThrow();
  });
});
