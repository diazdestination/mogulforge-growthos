import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { afterEach, describe, expect, it, vi } from "vitest";
import Today, { type ContractorDay } from "./today";
import { mockApi, sampleMe } from "@/test/mock-api";
import { renderWithQuery } from "@/test/render";
import { makeReservationSnapshot } from "@/test/scheduling-ui-fixtures";

const queue = { items: [], total: 0, truncated: false };
function day(overrides: Partial<ContractorDay> = {}): ContractorDay {
  return {
    organizationId: "o1",
    generatedAt: "2026-10-01T12:00:00Z",
    date: "2026-10-01",
    timeZone: "America/Los_Angeles",
    timeZoneSource: "configured",
    startAt: "2026-10-01T07:00:00Z",
    endAt: "2026-10-02T07:00:00Z",
    scope: "company",
    schedulingPolicyState: "unconfigured",
    schedulingPolicyRevision: 0,
    tasks: queue,
    appointments: queue,
    projects: queue,
    services: queue,
    ...overrides,
  };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function renderDay(role: string, handler: (url: URL) => Response) {
  const requests: string[] = [];
  mockApi(role, {
    handler: (_method, path, raw) => {
      if (path.endsWith("/contractor/today")) {
        requests.push(raw!);
        return handler(new URL(raw!, "http://localhost"));
      }
      return undefined;
    },
  });
  const { hook } = memoryLocation({ path: "/" });
  renderWithQuery(
    <Router hook={hook}>
      <Today />
    </Router>,
  );
  return requests;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("Today work day", () => {
  it("renders saved appointment and job projections in the current company zone while retaining original protection", async () => {
    const reservation = makeReservationSnapshot();
    renderDay("office", () => json(day({ date: "2035-01-01", timeZone: "America/New_York", startAt: "2035-01-01T05:00:00Z", endAt: "2035-01-02T05:00:00Z", schedulingPolicyState: "unconfigured", schedulingPolicyRevision: 2,
      appointments: { total: 1, truncated: false, items: [{ id: reservation.target.id, title: "Synthetic inspection", type: "inspection", status: "scheduled", leadId: null, contactId: null, customerLabel: "Synthetic customer", assignedUserId: "staff-synthetic", assigneeName: "Synthetic staff", scheduledStart: reservation.startAt, scheduledEnd: reservation.endAt, schedulingReservation: reservation, schedulingEvidence: "versioned" }] },
      projects: { total: 1, truncated: false, items: [{ id: reservation.target.id, title: "Protected job", status: "scheduled", leadId: null, customerLabel: null, crewNames: ["Job staff"], scheduledStart: reservation.startAt, scheduledEnd: reservation.endAt, schedulingReservation: makeReservationSnapshot({ target: { kind: "project", id: reservation.target.id } }), schedulingEvidence: "versioned" }] },
    })));
    await screen.findByText("Protected job");
    expect(screen.getAllByText(/Saved travel gap: 60 minutes/)).toHaveLength(2);
    expect(screen.getAllByText(/Approved company zone: America\/Los_Angeles/)).toHaveLength(2);
    expect(screen.getAllByText(/Current company zone: America\/New_York/)).toHaveLength(2);
    expect(screen.getAllByText(/90 elapsed minutes/)).toHaveLength(2);
    expect(screen.getAllByRole("region")).toHaveLength(4);
    const link = screen.getByRole("link", { name: /^inspection/ });
    expect(link.getAttribute("href")).toBe(`/appointments?appointmentId=${reservation.target.id}&organizationId=o1`);
    expect(link.querySelector('[role="group"]')).toBeNull();
  });
  it("holds invalid projected evidence while keeping historical work and invalid-policy status visible", async () => {
    renderDay("office", () => json(day({ schedulingPolicyState: "invalid", schedulingPolicyRevision: null,
      appointments: { total: 1, truncated: false, items: [{ id: "invalid", title: "Invalid inspection", type: "inspection", status: "scheduled", leadId: null, contactId: null, customerLabel: "Retained customer", assignedUserId: null, assigneeName: null, scheduledStart: "2026-10-01T14:00:00Z", scheduledEnd: null, schedulingReservation: null, schedulingEvidence: "invalid" }] },
    })));
    await screen.findByText("Retained customer");
    expect(screen.getAllByRole("alert").some(item => /current scheduling policy.*held/i.test(item.textContent || ""))).toBe(true);
    expect(screen.getAllByRole("alert").some(item => /Scheduling evidence.*held/.test(item.textContent || ""))).toBe(true);
    expect(screen.queryByText(/Legacy travel gap: 0/)).toBeNull();
  });
  it.each(["Invalid/Zone", ""])("holds unusable backend company zone %s without hiding the load failure as an empty day", async timeZone => {
    renderDay("office", () => json(day({ timeZone })));
    expect((await screen.findByRole("alert")).textContent).toMatch(/work day could not load/);
    expect(screen.queryByText(/No appointments overlap/)).toBeNull();
  });
  it('opens returning jobs and native office handoffs at exact company-pinned records without a fifth queue', async () => {
    const organizationId = '00000000-0000-4000-8000-000000000001', contactId = '00000000-0000-4000-8000-000000000002', projectId = '00000000-0000-4000-8000-000000000003';
    const actionPath = `/invoices?projectId=${projectId}&organizationId=${organizationId}`;
    const base = { status: 'open', dueAt: null, leadId: null, contactId, customerLabel: 'Returning synthetic customer', assignedUserId: null, assigneeName: null };
    mockApi('office', { me: { organization: { id: organizationId, name: 'Synthetic', slug: 'synthetic', timezone: 'UTC' } }, handler: (_method, path) => path.endsWith('/contractor/today') ? json(day({ organizationId,
      tasks: { total: 2, truncated: false, items: [{ ...base, id: 'original', title: 'Prepare returning invoice', actionPath }, { ...base, id: 'wrong', title: 'Reject mismatched company action', actionPath: actionPath.replace(organizationId, contactId) }] },
      projects: { total: 1, truncated: false, items: [{ id: projectId, title: 'Exact returning job', status: 'scheduled', leadId: null, contactId, customerWorkId: '00000000-0000-4000-8000-000000000004', customerLabel: base.customerLabel, crewNames: [], scheduledStart: null, scheduledEnd: null }] },
    })) : undefined });
    const { hook } = memoryLocation({ path: '/' }); renderWithQuery(<Router hook={hook}><Today /></Router>);
    expect((await screen.findByRole('link', { name: /Prepare returning invoice/ })).getAttribute('href')).toBe(actionPath);
    expect(screen.getByRole('link', { name: /Reject mismatched/ }).getAttribute('href')).toBe('/tasks?taskId=wrong');
    expect(screen.getByRole('link', { name: /Exact returning job/ }).getAttribute('href')).toBe(`/projects?projectId=${projectId}&organizationId=${organizationId}`);
    expect(screen.getAllByRole('region').map(item => item.getAttribute('aria-label'))).toEqual(['Appointments', 'Due and unplanned tasks', 'Jobs', 'Warranties & Service']);
    expect(document.querySelector('a[href*="leads/null"]')).toBeNull();
  });
  it("opens exact service and appointment records while keeping customer navigation as a separate link", async () => {
    const organizationId = "00000000-0000-4000-8000-000000000001", contactId = "00000000-0000-4000-8000-000000000002";
    const appointmentId = "00000000-0000-4000-8000-000000000003", serviceId = "00000000-0000-4000-8000-000000000004";
    const assigned = { contactId, customerLabel: "Synthetic Customer", assignedUserId: null, assigneeName: null, status: "scheduled" };
    mockApi("office", { me: { organization: { id: organizationId, name: "Synthetic HVAC", slug: "synthetic", timezone: "UTC" } }, handler: (_method, path) => path.endsWith("/contractor/today") ? json(day({ organizationId,
      appointments: { total: 2, truncated: false, items: [{ ...assigned, id: appointmentId, title: "Inspection", type: "inspection", leadId: null, scheduledStart: "2026-10-01T14:00:00Z", scheduledEnd: null }, { ...assigned, id: "unlinked", title: "Other visit", contactId: null, type: "other", leadId: null, scheduledStart: "2026-10-01T15:00:00Z", scheduledEnd: null }] },
      services: { total: 1, truncated: false, items: [{ ...assigned, id: serviceId, title: "Heat pump maintenance", dueAt: "2026-10-01T12:00:00Z", kind: "maintenance", taskId: "task" }] },
    })) : undefined });
    const { hook } = memoryLocation({ path: "/" }); renderWithQuery(<Router hook={hook}><Today /></Router>);
    const visit = await screen.findByRole("link", { name: /^inspection/ });
    const service = screen.getByRole("link", { name: /^Heat pump maintenance/ });
    expect(visit.getAttribute("href")).toBe(`/appointments?appointmentId=${appointmentId}&organizationId=${organizationId}`);
    expect(service.getAttribute("href")).toBe(`/service?serviceObligationId=${serviceId}&organizationId=${organizationId}`);
    for (const primary of [visit, service]) {
      const secondary = within(primary.closest("li")!).getByRole("link", { name: "Open customer record for Synthetic Customer" });
      expect(secondary.getAttribute("href")).toBe(`/contacts/${contactId}?organizationId=${organizationId}`);
      expect(primary.contains(secondary)).toBe(false); expect(primary.querySelector("a")).toBeNull();
    }
    expect(within(screen.getByRole("link", { name: /^other/ }).closest("li")!).queryByRole("link", { name: /Open customer record/ })).toBeNull();
  });
  it("removes cached work on profile failure and ignores an old-company response after switching membership", async () => {
    let company = "o1", fail = false, hold = false, resolve!: (value: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    const fetch = mockApi("office"), fallback = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (raw.endsWith("/me")) return fail ? json({ error: "Unavailable" }, 403) : json({ ...sampleMe("office"), organization: { id: company, name: company, slug: company, timezone: "UTC" } });
      if (raw.includes("/contractor/today")) return hold && company === "o1" ? pending : json(day({ organizationId: company, tasks: { total: 1, truncated: false, items: [{ id: "task", title: `${company} work only`, status: "open", dueAt: null, leadId: null, contactId: null, customerLabel: null, assignedUserId: null, assigneeName: null, actionPath: "/tasks?taskId=task" }] } }));
      return fallback(input, init);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); const { hook } = memoryLocation({ path: "/" });
    render(<QueryClientProvider client={client}><Router hook={hook}><Today /></Router></QueryClientProvider>);
    await screen.findByText("o1 work only"); fail = true;
    await act(async () => { await client.refetchQueries({ queryKey: getGetMeQueryKey() }); });
    await screen.findByRole("alert"); expect(screen.queryByText("o1 work only")).toBeNull();
    fail = false; hold = true; fireEvent.click(screen.getByRole("button", { name: "Check work-day access" }));
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url).includes("/contractor/today")).length).toBeGreaterThan(1));
    company = "o2";
    await act(async () => { await client.refetchQueries({ queryKey: getGetMeQueryKey() }); });
    await screen.findByText("o2 work only");
    await act(async () => { resolve(json(day())); });
    expect(screen.queryByText("o1 work only")).toBeNull(); expect(screen.getByText("o2 work only")).toBeTruthy();
  });
  it("opens a server-linked reply task at its exact lead Messages tab, never an arbitrary supplied destination", async () => {
    const leadId = "00000000-0000-4000-8000-000000000456";
    const base = { status: "open", dueAt: null, leadId, contactId: "c1", customerLabel: "Synthetic", assignedUserId: "u1", assigneeName: "Office" };
    renderDay("office", () => json(day({ tasks: { total: 4, truncated: false, items: [
      { ...base, id: "reply-1", title: "Review original reply", actionPath: `/leads/${leadId}?tab=messages` },
      { ...base, id: "reply-2", title: "Wrong customer path", actionPath: "/leads/00000000-0000-4000-8000-000000000999?tab=messages" },
      { ...base, id: "reply-3", title: "External path", actionPath: "https://example.invalid/" },
      { ...base, id: "reply-4", title: "Extra query path", actionPath: `/leads/${leadId}?tab=messages&redirect=other` },
    ] } })));
    expect((await screen.findByRole("link", { name: /Review original reply/ })).getAttribute("href")).toBe(`/leads/${leadId}?tab=messages`);
    for (const [title, id] of [["Wrong customer path", "reply-2"], ["External path", "reply-3"], ["Extra query path", "reply-4"]])
      expect(screen.getByRole("link", { name: new RegExp(title) }).getAttribute("href")).toBe(`/tasks?taskId=${id}`);
  });
  it("shows real snapshot work, exact truncation and explicit timezone without downloading all-time lists", async () => {
    const requests = renderDay("office", () =>
      json(
        day({
          tasks: {
            items: [
              {
                id: "task-1",
                title: "Prepare invoice for completed repair",
                status: "open",
                dueAt: null,
                leadId: "lead-1",
                contactId: "contact-1",
                customerLabel: "Synthetic Customer",
                assignedUserId: "u1",
                assigneeName: "Office",
                actionPath:
                  "/invoices?projectId=00000000-0000-4000-8000-000000000123",
              },
            ],
            total: 51,
            truncated: true,
          },
        }),
      ),
    );
    expect(
      await screen.findByText("Prepare invoice for completed repair"),
    ).toBeTruthy();
    expect(screen.getByText("Showing 1 of 51")).toBeTruthy();
    expect(screen.getByText(/America\/Los_Angeles/)).toBeTruthy();
    expect(screen.getByText(/More work is available/)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /Prepare invoice/ })
        .getAttribute("href"),
    ).toBe("/invoices?projectId=00000000-0000-4000-8000-000000000123");
    expect(
      new URL(requests[0], "http://localhost").searchParams.get("scope"),
    ).toBe("company");
  });
  it("defaults field staff to their assignments and holds obsolete UTC fallback responses", async () => {
    const requests = renderDay("production", () =>
      json(
        day({ scope: "mine", timeZone: "UTC", timeZoneSource: "utc_fallback" }),
      ),
    );
    await screen.findByRole("alert");
    expect(screen.queryByText(/this view uses UTC/)).toBeNull();
    expect(
      new URL(requests[0], "http://localhost").searchParams.get("scope"),
    ).toBe("mine");
    expect(screen.queryByRole("link", { name: "Review settings" })).toBeNull();
  });
  it("requests a selected date and scope explicitly", async () => {
    const requests = renderDay("office", (url) =>
      json(
        day({
          date: url.searchParams.get("date") || "2026-10-01",
          scope: url.searchParams.get("scope") as "mine" | "company",
        }),
      ),
    );
    await screen.findByText(/America\/Los_Angeles/);
    fireEvent.change(screen.getByLabelText("Work day"), {
      target: { value: "2026-11-01" },
    });
    fireEvent.change(screen.getByLabelText("Show"), {
      target: { value: "mine" },
    });
    await waitFor(() =>
      expect(
        requests.some(
          (url) =>
            url.includes("date=2026-11-01") && url.includes("scope=mine"),
        ),
      ).toBe(true),
    );
    expect(await screen.findByText(/Sunday, November 1, 2026/)).toBeTruthy();
  });
  it("labels midnight-spanning appointment dates and preserves calendar service due dates", async () => {
    const assigned = {
      id: "work-1",
      title: "Annual service",
      status: "scheduled",
      dueAt: "2026-10-01T12:00:00Z",
      leadId: null,
      contactId: null,
      customerLabel: "Synthetic Customer",
      assignedUserId: null,
      assigneeName: null,
    };
    renderDay("office", () =>
      json(
        day({
          timeZone: "Pacific/Kiritimati",
          startAt: "2026-09-30T10:00:00Z",
          endAt: "2026-10-01T10:00:00Z",
          appointments: {
            items: [
              {
                ...assigned,
                type: "inspection",
                schedulingEvidence: "legacy",
                schedulingReservation: null,
                scheduledStart: "2026-09-30T09:30:00Z",
                scheduledEnd: "2026-09-30T11:00:00Z",
              },
            ],
            total: 1,
            truncated: false,
          },
          services: {
            items: [{ ...assigned, contactId: "contact-1", kind: "maintenance", taskId: "task-1" }],
            total: 1,
            truncated: false,
          },
        }),
      ),
    );
    expect(await screen.findByText(/Sep 30, 11:30 PM/)).toBeTruthy();
    expect(screen.getByText(/Due Oct 1, 2026/)).toBeTruthy();
    expect(screen.queryByText(/Due Oct 2/)).toBeNull();
  });
  it.each(["unavailable", "foreign-company"])(
    "does not replace %s with empty-day claims",
    async (failure) => {
      renderDay("office", () =>
        failure === "unavailable"
          ? json({ error: "unavailable" }, 503)
          : json(day({ organizationId: "other-company" })),
      );
      expect((await screen.findByRole("alert")).textContent).toContain(
        "The work day could not load",
      );
      expect(
        screen.queryByText("No appointments overlap this work day."),
      ).toBeNull();
    },
  );
});
