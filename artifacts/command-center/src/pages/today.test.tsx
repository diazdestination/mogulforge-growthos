import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { afterEach, describe, expect, it, vi } from "vitest";
import Today, { type ContractorDay } from "./today";
import { mockApi } from "@/test/mock-api";
import { renderWithQuery } from "@/test/render";

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
  it("defaults field staff to their assignments and states the UTC fallback", async () => {
    const requests = renderDay("production", () =>
      json(
        day({ scope: "mine", timeZone: "UTC", timeZoneSource: "utc_fallback" }),
      ),
    );
    await screen.findByText(/company time zone is not configured/);
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
                scheduledStart: "2026-09-30T09:30:00Z",
                scheduledEnd: "2026-09-30T11:00:00Z",
              },
            ],
            total: 1,
            truncated: false,
          },
          services: {
            items: [{ ...assigned, kind: "maintenance", taskId: "task-1" }],
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
