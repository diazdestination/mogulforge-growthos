import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mockApi, sampleMe } from "@/test/mock-api";
import { renderWithQuery } from "@/test/render";
import Calls from "./calls";

const policy = { enabled: true, timezone: "America/New_York", days: [1, 2, 3, 4, 5, 6], opensAt: "09:00", closesAt: "18:00", businessHoursOwnerId: "u1", afterHoursOwnerId: "u1", responseMinutes: 30 };
const item = (state = "needs_review") => ({ care: { id: "case-1", state, version: 1, reason: "staff_review_required", dueAt: "2026-10-02T17:30:00Z", ownerUserId: "u1" }, call: { id: "call-1", phone: "+12025550101", createdAt: "2026-10-02T17:00:00Z" }, handoff: { reviewedAt: "2026-10-02T17:01:00Z", taskId: "task-1", leadId: "lead-1" }, delivery: null, replies: [] });
const snapshot = { renderedMessage: "Synthetic Contractor: Thanks for calling. Reply STOP to opt out. HELP for help.", phone: "+12025550101", templateVersion: "missed-call-care.v1" };
const json = (data: unknown, status = 200) => Response.json(data, { status });
type Request = { path: string; method: string; body: Record<string, unknown> };
function server(role = "owner", state = "needs_review", override?: (req: Request) => Response | undefined) {
  const requests: Request[] = [], mock = mockApi(role), fallback = mock.getMockImplementation()!;
  mock.mockImplementation(async (input, init) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost").pathname;
    const req = { path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : {} }; requests.push(req);
    const custom = override?.(req); if (custom) return custom;
    if (path === "/api/v1/users") return json([{ ...sampleMe(role), operationallyEligible: true }]);
    if (path === "/api/v1/communications/missed-call-care") return json({ policy, version: 1, body: "Thanks for calling. This does not confirm an appointment.", templateVersion: "missed-call-care.v1", items: [item(state)], companyPaused: false, environmentHeld: false });
    if (path === "/api/v1/communications/voice/call-1/care") return json({ caseId: "case-1", version: 1, snapshot, eligibility: { ready: true, reason: null } });
    if (req.method !== "GET" && path.includes("/care/")) return json({ state: "approved" }, 202);
    return fallback(input, init);
  });
  return requests;
}
function renderCalls() { return renderWithQuery(<Router hook={memoryLocation({ path: "/calls" }).hook}><Calls /></Router>); }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("CALLIE missed-call recovery controls", () => {
  it("loads a clear owner/deadline/canonical lead view without any automatic customer action", async () => {
    const requests = server(); renderCalls();
    expect(await screen.findByText("Staff review needed")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open opportunity" }).getAttribute("href")).toBe("/leads/lead-1");
    expect(screen.getByRole("link", { name: "Open callback task" }).getAttribute("href")).toBe("/tasks?taskId=task-1");
    expect(screen.getByText(/A call does not grant SMS consent. Unknown callers/)).toBeTruthy();
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });
  it("requires a fresh exact preview and unchecked explicit approval before queuing once", async () => {
    const requests = server(); renderCalls();
    fireEvent.click(await screen.findByRole("button", { name: "Preview one customer-care reply" }));
    const preview = await screen.findByRole("generic", { name: "Approve missed-call reply" });
    const approve = within(preview).getByRole("button", { name: "Approve and queue one reply" });
    expect(approve.matches(":disabled")).toBe(true);
    expect(within(preview).getByText(snapshot.renderedMessage)).toBeTruthy();
    fireEvent.click(within(preview).getByRole("checkbox")); fireEvent.click(approve);
    await screen.findByText(/Reply approved and queued for guarded processing/);
    const writes = requests.filter((r) => r.method === "POST"); expect(writes).toHaveLength(1);
    expect(writes[0].body).toEqual({ expectedVersion: 1, expectedSnapshot: snapshot, approve: true });
    expect(screen.queryByRole("button", { name: "Approve and queue one reply" })).toBeNull();
  });
  it("discards stale previews after a conflict and makes no automatic retry", async () => {
    const requests = server("owner", "needs_review", (req) => req.path.endsWith("/care/approve") ? json({ code: "stale_approval" }, 409) : undefined); renderCalls();
    fireEvent.click(await screen.findByRole("button", { name: "Preview one customer-care reply" }));
    const preview = await screen.findByRole("generic", { name: "Approve missed-call reply" });
    fireEvent.click(within(preview).getByRole("checkbox")); fireEvent.click(within(preview).getByRole("button"));
    expect(await screen.findByText(/The call or policy changed/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve and queue one reply" })).toBeNull());
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });
  it("does not show send/close/policy controls to read-only staff", async () => {
    const requests = server("viewer"); renderCalls(); await screen.findByText("Staff review needed");
    expect(screen.queryByRole("button", { name: "Preview one customer-care reply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark handled by staff" })).toBeNull();
    expect(screen.queryByText("Owners, hours and message policy")).toBeNull();
    expect(screen.getByRole("button", { name: "Call through staff phone" }).matches(":disabled")).toBe(true);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });
  it("cannot approve another send for an uncertain outcome and provides a real reconciliation route", async () => {
    server("owner", "indeterminate"); renderCalls();
    expect(await screen.findByText("Outcome unknown · do not resend")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview one customer-care reply" })).toBeNull();
    expect(screen.getByRole("link", { name: "Revenue Desk" }).getAttribute("href")).toBe("/bie");
  });
  it("resets the policy approval checkbox after any settings edit", async () => {
    server(); renderCalls(); await screen.findByText("Staff review needed");
    fireEvent.click(screen.getByText("Owners, hours and message policy"));
    const checkbox = screen.getByLabelText("I approve these owners, hours and the customer-care template.");
    fireEvent.click(checkbox); expect(screen.getByRole("button", { name: "Save recovery policy" }).matches(":disabled")).toBe(false);
    fireEvent.change(screen.getByLabelText("Follow-up deadline (minutes)"), { target: { value: "45" } });
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("button", { name: "Save recovery policy" }).matches(":disabled")).toBe(true);
  });
});
