import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RoiReport } from "@workspace/api-client-react";
import { renderWithQuery } from "@/test/render";
import Reports from "./reports";

const end = "2026-10-01T12:00:00.000Z";
const range = (days = 30) => ({
  startAt: new Date(Date.parse(end) - days * 86_400_000).toISOString(),
  endAt: end,
  timeZone: "UTC" as const,
});
const report = (days = 30): RoiReport => ({
  windowDays: days,
  generatedAt: end,
  period: range(days),
  comparison: {
    period: {
      ...range(days),
      startAt: new Date(Date.parse(end) - days * 2 * 86_400_000).toISOString(),
      endAt: range(days).startAt,
    },
    appointmentsRecorded: 2,
    won: 0,
    recordedWinValueCents: 0,
    unknownWinValues: 0,
  },
  dataQuality: {
    unknownOriginalDates: 3,
    unknownWinValues: 1,
    unknownPipelineValues: 1,
    importedFirstTouchExcluded: 1,
  },
  evidence: [
    {
      leadId: "source-lead",
      title: "Synthetic roof opportunity",
      wonAt: "2026-09-30T12:00:00.000Z",
      valueCents: null,
      attribution: "unknown",
    },
  ],
  leads: {
    total: 2,
    native: 1,
    imported: 1,
    qualified: 1,
    bySource: [],
    byCampaign: [],
    byTool: [],
    byLandingPage: [],
    byServiceType: [],
  },
  appointments: {
    total: 3,
    distinctBookedLeads: 2,
    leadsWithAppointment: 1,
    appointmentRatePct: 50,
  },
  responsiveness: {
    leadsContacted: 2,
    leadsReplied: 1,
    responseRatePct: 50,
    medianMinutesToFirstTouch: null,
    firstTouchMeasuredLeads: 0,
  },
  outcomes: {
    won: 1,
    revenueWonCents: null,
    revenueByAttribution: [
      { category: "unknown", count: 1, revenueCents: null, unknownValues: 1 },
    ],
    pipelineValueCents: null,
    lost: 0,
    lostReasons: [],
  },
  playbooks: [],
  reviewsAndReferrals: {
    reviewRequestsSent: 0,
    reviewLinkClicks: 0,
    referralRequestsSent: 0,
    referralSubmissions: 0,
    referralLeads: 0,
  },
  reactivation: { campaignsLaunched: 0, leadsEnrolled: 0, leadsReplied: 0 },
});
const ledger = {
  entryCount: 1,
  receiptEntryCount: 1,
  costEntryCount: 0,
  acceptedEstimateCount: 0,
  acceptedEstimateCents: 0,
  completedProjectCount: 0,
  netReceiptsCents: 50000,
  netDirectCostsCents: 0,
  recordedContributionCents: null,
  undatedAcceptedEstimateCount: 1,
  undatedCompletedProjectCount: 2,
  entries: [
    {
      id: "entry",
      leadId: "source-lead",
      kind: "payment",
      amountCents: 50000,
      sourceReference: "QA receipt",
      occurredAt: end,
    },
  ],
  boundary: "Staff-recorded entries; not causal ROI.",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function api(overrides?: (url: URL) => Response | undefined) {
  const fetcher = vi
    .fn()
    .mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://localhost");
      const custom = overrides?.(url);
      if (custom) return custom;
      if (url.pathname.endsWith("/reports/roi/export"))
        return new Response("section,metric,key,value\n", {
          headers: { "Content-Type": "text/csv" },
        });
      if (url.pathname.endsWith("/reports/roi"))
        return json(report(Number(url.searchParams.get("days") ?? 30)));
      if (url.pathname.endsWith("/revenue/value"))
        return json({
          ...ledger,
          period: {
            ...range(),
            startAt: url.searchParams.get("startAt"),
            endAt: url.searchParams.get("endAt"),
          },
        });
      throw new Error("Unexpected synthetic request");
    });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shows honest period and unknown-value labels with evidence links and passes the exact range to the ledger", async () => {
  const fetcher = api();
  renderWithQuery(<Reports />);
  await screen.findByRole("region", { name: "Win evidence" });
  expect(
    within(screen.getByTestId("stat-revenue")).getByText("Not recorded"),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: "Synthetic roof opportunity" })
      .getAttribute("href"),
  ).toBe("/leads/source-lead");
  expect(
    screen.getByText(
      /3 imported opportunities across the account have no original creation date/,
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(/Historical first-contact coverage is unknown/),
  ).toBeTruthy();
  expect(screen.getByText(/not appointments scheduled to occur/)).toBeTruthy();
  expect(
    await screen.findByText(
      /Dates need attention: 1 accepted estimates and 2 completed projects/,
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/All-time USD records/)).toBeNull();
  const ledgerUrl = fetcher.mock.calls
    .map(([url]) => new URL(String(url), "http://localhost"))
    .find((url) => url.pathname.endsWith("/revenue/value"))!;
  expect(ledgerUrl.searchParams.get("startAt")).toBe(range().startAt);
  expect(ledgerUrl.searchParams.get("endAt")).toBe(end);
  expect(screen.getByText("Not available")).toBeTruthy();
});

it("recovers report failure through an explicit retry instead of an endless spinner", async () => {
  let fails = true;
  api((url) =>
    url.pathname.endsWith("/reports/roi") && fails
      ? json({ error: "synthetic unavailable" }, 503)
      : undefined,
  );
  renderWithQuery(<Reports />);
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("could not load"),
  );
  expect(
    (screen.getByRole("button", { name: "Export CSV" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fails = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry report" }));
  await screen.findByTestId("stat-won");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps the report usable when financial proof is unavailable and retries the ledger", async () => {
  let fails = true;
  api((url) =>
    url.pathname.endsWith("/revenue/value") && fails
      ? json({ error: "synthetic unavailable" }, 503)
      : undefined,
  );
  renderWithQuery(<Reports />);
  const retry = await screen.findByRole("button", { name: "Retry ledger" });
  expect(screen.getByTestId("stat-won")).toBeTruthy();
  expect(screen.queryByText("$500.00")).toBeNull();
  fails = false;
  fireEvent.click(retry);
  expect(await screen.findByText(/Selected UTC period/)).toBeTruthy();
});

it("anchors export to the displayed period and allows recovery from export failure", async () => {
  let fails = true;
  const fetcher = api((url) =>
    url.pathname.endsWith("/reports/roi/export") && fails
      ? json({ error: "synthetic export unavailable" }, 503)
      : undefined,
  );
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:synthetic"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  renderWithQuery(<Reports />);
  await screen.findByTestId("stat-won");
  fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("CSV export failed"),
  );
  fails = false;
  fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
  await waitFor(() => expect(click).toHaveBeenCalledOnce());
  expect(screen.queryByRole("alert")).toBeNull();
  const exports = fetcher.mock.calls
    .map(([url]) => new URL(String(url), "http://localhost"))
    .filter((url) => url.pathname.endsWith("/reports/roi/export"));
  expect(exports).toHaveLength(2);
  for (const url of exports) expect(url.searchParams.get("endAt")).toBe(end);
});

it("changes the report and financial window together without reusing all-time cached totals", async () => {
  const fetcher = api();
  renderWithQuery(<Reports />);
  await screen.findByText(/Selected UTC period/);
  fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
  await screen.findByRole("heading", { name: "Last 7 days" });
  await waitFor(() => {
    const ledgerUrls = fetcher.mock.calls
      .map(([url]) => new URL(String(url), "http://localhost"))
      .filter((url) => url.pathname.endsWith("/revenue/value"));
    expect(
      ledgerUrls.some(
        (url) => url.searchParams.get("startAt") === range(7).startAt,
      ),
    ).toBe(true);
  });
  expect(
    screen
      .getByRole("button", { name: "Last 7 days" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});
