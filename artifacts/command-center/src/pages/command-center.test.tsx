import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { afterEach, describe, expect, it, vi } from "vitest";
import CommandCenter from "./command-center";
import { mockApi } from "@/test/mock-api";
import { renderWithQuery } from "@/test/render";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const queue = { items: [], total: 0, truncated: false };
const today = new Date().toISOString().slice(0, 10);
const longAgo = new Date(Date.now() - 6 * 86_400_000).toISOString();

type Routes = Record<string, (url: URL) => Response>;
function renderHome(role: string, routes: Routes = {}) {
  const requested: string[] = [];
  const defaults: Routes = {
    "/contractor/today": () =>
      json({ organizationId: "o1", date: today, timeZone: "UTC", startAt: "", endAt: "", scope: "company", tasks: queue, projects: queue, services: queue, appointments: queue }),
    "/next-best-action/today-actions": () => json({ actions: [] }),
    "/communications/callie": () => json({ items: [] }),
    "/service-watch": () => json({ items: [] }),
    "/estimates": () => json([]),
    "/invoices": () => json({ items: [], total: 0, page: 0, pageSize: 25 }),
  };
  mockApi(role, {
    handler: (_method, path, raw) => {
      const route = Object.keys({ ...defaults, ...routes }).find((key) => path.endsWith(`/api/v1${key}`));
      if (!route) return undefined;
      requested.push(raw!);
      return (routes[route] ?? defaults[route])(new URL(raw!, "http://localhost"));
    },
  });
  const { hook } = memoryLocation({ path: "/" });
  renderWithQuery(
    <Router hook={hook}>
      <CommandCenter />
    </Router>,
  );
  return requested;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Command center home", () => {
  it("lists what needs the owner today with one clear button each, most urgent first", async () => {
    renderHome("owner", {
      "/communications/callie": () => json({ items: [{ id: "c1", phone: "+12025550101", state: "open", overdue: true, dueAt: null, createdAt: longAgo }] }),
      "/next-best-action/today-actions": () =>
        json({ actions: [{ leadId: "l1", actionType: "call_now", title: "Call now", reasons: ["New roof lead"], priority: 90, contactName: "Sarah Lee" }] }),
      "/invoices": (url) =>
        url.searchParams.get("status") === "issued"
          ? json({ items: [{ id: "i1", status: "issued", title: "Roof repair", customerName: "James", totalCents: 1240000, dueDate: "2020-01-01", balanceDueCents: 1240000, paymentState: "unpaid" }], total: 1, page: 0, pageSize: 25 })
          : json({ items: [], total: 2, page: 0, pageSize: 25 }),
      "/estimates": () => json([{ id: "e1", title: "Roof", status: "sent", totalCents: 1865000, leadLabel: "Ava", sentAt: longAgo, updatedAt: longAgo }]),
    });
    const needs = await screen.findByRole("region", { name: "What needs you today" });
    const callBack = await within(needs).findByRole("link", { name: "Call back: Call back (202) 555-0101" });
    expect(callBack.getAttribute("href")).toBe("/calls");
    const rows = within(needs).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector(".cc-need__who")?.textContent)).toEqual(["CALLIE", "BILL", "SCOUT", "ESTI"]);
    expect(within(needs).getByRole("link", { name: /Collect \$12,400 from James/ }).getAttribute("href")).toBe("/invoices/i1");
    expect(within(needs).getByRole("link", { name: /Call Sarah Lee/ }).getAttribute("href")).toBe("/leads/l1");
    expect(screen.getByText(/4 things need you today/)).toBeTruthy();

    const team = screen.getByRole("region", { name: "Your team" });
    expect(within(team).getByRole("link", { name: /^INVO, Invoices: 2 draft invoices ready to send/ }).getAttribute("href")).toBe("/invoices");
    expect(within(team).getAllByRole("link").filter((link) => link.className.includes("cc-agent"))).toHaveLength(8);
    expect(screen.getByRole("link", { name: "New invoice" }).getAttribute("href")).toBe("/invoices");
  });

  it("hides money from team members who can't see invoices and never asks for them", async () => {
    const requested = renderHome("sales_rep");
    const team = await screen.findByRole("region", { name: "Your team" });
    await screen.findByText("You're all caught up");
    expect(within(team).queryByText("BILL")).toBeNull();
    expect(within(team).queryByText("INVO")).toBeNull();
    expect(screen.queryByRole("link", { name: "New invoice" })).toBeNull();
    expect(requested.some((url) => url.includes("/invoices"))).toBe(false);
    expect(requested.find((url) => url.includes("/contractor/today"))).toContain("scope=mine");
  });

  it("gives field crews a big button into their own day", async () => {
    renderHome("production");
    const open = await screen.findByRole("link", { name: /Open my day/ });
    expect(open.getAttribute("href")).toBe("/tech");
  });

  it("says plainly when part of the team couldn't check in, and lets them try again", async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderHome("owner", {
      "/communications/callie": () => {
        calls += 1;
        return calls === 1 ? json({ error: "boom" }, 500) : json({ items: [] });
      },
    });
    const warning = await screen.findByRole("alert");
    expect(warning.textContent).toMatch(/couldn't check in just now/);
    await user.click(within(warning).getByRole("button", { name: "Try again" }));
    await screen.findByText("You're all caught up");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
