import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mockApi } from "@/test/mock-api";
import { callieMe as sampleMe, receptionView, savedPolicy } from "@/test/callie-fixtures";
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
    if (path === "/api/v1/me") return json(sampleMe(role));
    if (path === "/api/v1/communications/callie/reception") return json(receptionView());
    if (path === "/api/v1/users") return json([{ ...sampleMe(role), operationallyEligible: true }]);
    if (path === "/api/v1/communications/callie/policy") return json(savedPolicy());
    if (path === "/api/v1/communications/callie") return json({ scope: "attention", offset: 0, pageSize: 25, hasMore: false, items: [], companyHeld: false, boundary: "This page contains admitted requests only." });
    if (path === "/api/v1/communications/missed-call-care") return json({ policy, version: 1, body: "Thanks for calling. This does not confirm an appointment.", templateVersion: "missed-call-care.v1", items: [item(state)], companyPaused: false, environmentHeld: false });
    if (path === "/api/v1/communications/voice/call-1/care") return json({ caseId: "case-1", version: 1, snapshot, eligibility: { ready: true, reason: null } });
    if (req.method !== "GET" && path.includes("/care/")) return json({ state: "approved" }, 202);
    return fallback(input, init);
  });
  return requests;
}
async function renderCalls() { const value = renderWithQuery(<Router hook={memoryLocation({ path: "/calls" }).hook}><Calls /></Router>); fireEvent.click(await screen.findByText("Business calls and individually reviewed recovery")); return value; }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("CALLIE missed-call recovery controls", () => {
  it("shows an actionable access error instead of retaining sensitive call controls", async () => {
    let failed = false;
    const requests = server("owner", "needs_review", req => failed && req.path === "/api/v1/me" ? json({ error: "Unavailable" }, 503) : undefined);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><Router hook={memoryLocation({ path: "/calls" }).hook}><Calls /></Router></QueryClientProvider>);
    await screen.findByRole("region", { name: "CALLIE automatic intake" }); failed = true;
    await act(async () => { await client.refetchQueries({ queryKey: getGetMeQueryKey() }); });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Company access could not be verified"));
    expect(screen.queryByRole("region", { name: "CALLIE automatic intake" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Business calls" })).toBeNull();
    failed = false; fireEvent.click(screen.getByRole("button", { name: "Check call access" }));
    await screen.findByRole("region", { name: "CALLIE automatic intake" });
    expect(requests.every(req => req.method === "GET")).toBe(true); cleanup(); client.clear();
  });
  it("does not open call records or provider controls for inactive staff", async () => {
    const requests = server("owner", "needs_review", req => req.path === "/api/v1/me" ? json({ ...sampleMe("owner"), isActive: false }) : undefined);
    renderWithQuery(<Router hook={memoryLocation({ path: "/calls" }).hook}><Calls /></Router>);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Active company access is required to open calls.");
    expect(requests.some(req => req.path.startsWith("/api/v1/communications/"))).toBe(false);
  });
  it("preserves legacy voice drafts and care approvals through unchanged successful profile checks", async () => {
    const requests = server(), client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><Router hook={memoryLocation({ path: "/calls" }).hook}><Calls /></Router></QueryClientProvider>);
    fireEvent.click(await screen.findByText("Business calls and individually reviewed recovery")); await screen.findByText("Staff review needed");
    fireEvent.change(screen.getByLabelText("Contact record ID"), { target: { value: "saved-voice-contact" } });
    fireEvent.click(screen.getByLabelText("This contact asked us to call this number. I authorize this call."));
    fireEvent.click(screen.getByText("Owners, hours and message policy"));
    fireEvent.change(screen.getByLabelText("Follow-up deadline (minutes)"), { target: { value: "45" } });
    fireEvent.click(screen.getByLabelText("I approve these owners, hours and the customer-care template."));
    fireEvent.click(screen.getByRole("button", { name: "Preview one customer-care reply" }));
    const preview = await screen.findByRole("generic", { name: "Approve missed-call reply" }); fireEvent.click(within(preview).getByRole("checkbox"));
    for (let index = 0; index < 2; index++) await act(async () => { await client.invalidateQueries({ queryKey: getGetMeQueryKey() }); });
    expect((screen.getByLabelText("Contact record ID") as HTMLInputElement).value).toBe("saved-voice-contact");
    expect((screen.getByLabelText("This contact asked us to call this number. I authorize this call.") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Follow-up deadline (minutes)") as HTMLInputElement).value).toBe("45");
    expect((screen.getByLabelText("I approve these owners, hours and the customer-care template.") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("generic", { name: "Approve missed-call reply" })).toBe(preview); expect((within(preview).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect(requests.filter(req => req.path === "/api/v1/me")).toHaveLength(3); expect(requests.every(req => req.method === "GET")).toBe(true);
    cleanup(); client.clear();
  });
  it("loads a clear owner/deadline/canonical lead view without any automatic customer action", async () => {
    const requests = server(); await renderCalls();
    expect(await screen.findByText("Staff review needed")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open opportunity" }).getAttribute("href")).toBe("/leads/lead-1");
    expect(screen.getByRole("link", { name: "Open callback task" }).getAttribute("href")).toBe("/tasks?taskId=task-1");
    expect(screen.getByText(/A call does not grant SMS consent. Unknown callers/)).toBeTruthy();
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });
  it("requires a fresh exact preview and unchecked explicit approval before queuing once", async () => {
    const requests = server(); await renderCalls();
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
    const requests = server("owner", "needs_review", (req) => req.path.endsWith("/care/approve") ? json({ code: "stale_approval" }, 409) : undefined); await renderCalls();
    fireEvent.click(await screen.findByRole("button", { name: "Preview one customer-care reply" }));
    const preview = await screen.findByRole("generic", { name: "Approve missed-call reply" });
    fireEvent.click(within(preview).getByRole("checkbox")); fireEvent.click(within(preview).getByRole("button"));
    expect(await screen.findByText(/The call or policy changed/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve and queue one reply" })).toBeNull());
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });
  it("does not show send/close/policy controls to read-only staff", async () => {
    const requests = server("viewer"); await renderCalls(); await screen.findByText("Staff review needed");
    expect(screen.queryByRole("button", { name: "Preview one customer-care reply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark handled by staff" })).toBeNull();
    expect(screen.queryByText("Owners, hours and message policy")).toBeNull();
    expect(screen.getByRole("button", { name: "Call through staff phone" }).matches(":disabled")).toBe(true);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });
  it("cannot approve another send for an uncertain outcome and provides a real reconciliation route", async () => {
    server("owner", "indeterminate"); await renderCalls();
    expect(await screen.findByText("Outcome unknown · do not resend")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview one customer-care reply" })).toBeNull();
    expect(screen.getByRole("link", { name: "Revenue Desk" }).getAttribute("href")).toBe("/bie");
  });
  it("resets the policy approval checkbox after any settings edit", async () => {
    server(); await renderCalls(); await screen.findByText("Staff review needed");
    fireEvent.click(screen.getByText("Owners, hours and message policy"));
    const checkbox = screen.getByLabelText("I approve these owners, hours and the customer-care template.");
    fireEvent.click(checkbox); expect(screen.getByRole("button", { name: "Save recovery policy" }).matches(":disabled")).toBe(false);
    fireEvent.change(screen.getByLabelText("Follow-up deadline (minutes)"), { target: { value: "45" } });
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("button", { name: "Save recovery policy" }).matches(":disabled")).toBe(true);
  });
});
