import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { mockApi } from "@/test/mock-api";
import { id, otherId, contactId, propertyId, taskId, receiptId, organizationId, base, settings, snapshot, savedPolicy, policyPreview, item, detail, receptionView, callieMe as sampleMe } from "@/test/callie-fixtures";
import { CallieDesk } from "./callie-desk";
import type { CalliePolicyPreview, CallieSettings } from "./callie-contract";

const json = (value: unknown, status = 200) => Response.json(value, { status });
type Request = { path: string; query: URLSearchParams; method: string; body: Record<string, unknown> };
type Handler = (req: Request) => Response | Promise<Response> | undefined;
function server(role = "owner", currentDetail = detail(), handler?: Handler) {
  const requests: Request[] = [], mock = mockApi(role), fallback = mock.getMockImplementation()!;
  const state = { detail: currentDetail, policy: savedPolicy() };
  mock.mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    const req: Request = { path: url.pathname, query: url.searchParams, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : {} };
    requests.push(req); const custom = handler?.(req); if (custom) return custom;
    if (req.path === "/api/v1/me") return json(sampleMe(role));
    if (req.path === `${base}/reception`) return json(receptionView());
    if (req.path === "/api/v1/users") return json([{ ...sampleMe("owner"), firstName: "Accepted", lastName: "Owner", operationallyEligible: true }, { ...sampleMe("office"), id: "pending", firstName: "Pending", operationallyEligible: false }, { ...sampleMe("viewer"), id: "viewer", operationallyEligible: true }]);
    if (req.path === "/api/v1/contacts") return json([{ id: contactId, firstName: "Fictional", lastName: "Customer", phone: "+12025550101", email: null }]);
    if (req.path === `${base}/policy`) return json(state.policy);
    if (req.path === `${base}/policy/preview`) return json(policyPreview(req.body.policy as CallieSettings));
    if (req.path === `${base}/policy/approve`) { const next = (req.body.expectedSnapshot as CalliePolicyPreview["expectedSnapshot"]).policy; state.policy = { ...state.policy, version: state.policy.version + 1, snapshot: next, policy: Object.fromEntries(Object.keys(settings).map(key => [key, next[key as keyof CallieSettings]])) as CallieSettings, readiness: { ready: false, reason: "provider_not_approved" } }; return json(state.policy); }
    if (req.path === base) return json({ scope: req.query.get("scope"), offset: Number(req.query.get("offset")), pageSize: 25, hasMore: false, items: [item()], companyHeld: false, boundary: "This page contains admitted requests only; it is not a global count." });
    if (req.path === `${base}/${id}`) return json(state.detail);
    if (req.path === `${base}/${id}/review-caller`) { state.detail = detail(true, { version: 2, callerReviewed: true }); return json({ detail: state.detail, replayed: false }); }
    if (req.path === `${base}/${id}/book`) { state.detail = detail(true, { state: "booked", appointmentId: otherId, task: { id: taskId, status: "done" }, appointment: { id: otherId, status: "confirmed", scheduledStart: String(req.body.scheduledStart), scheduledEnd: String(req.body.scheduledEnd), assignedUserId: String(req.body.assignedUserId) }, actions: { canReviewCaller: false, canAssign: false, canClose: false, canBook: false, blockReason: "office_work_closed" } }); return json({ detail: state.detail, replayed: false }); }
    return fallback(input, init);
  });
  return { requests, state, writes: () => requests.filter(req => req.method !== "GET") };
}
const clients: QueryClient[] = [];
function mount(path = "/calls") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client);
  const result = render(<QueryClientProvider client={client}><Router hook={memoryLocation({ path }).hook}><CallieDesk /></Router></QueryClientProvider>);
  return { ...result, client };
}
function pending<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function openPolicy() { fireEvent.click(await screen.findByText("Review standing owners, hours and exact messages")); }
async function preparePolicy() { await openPolicy(); fireEvent.click(screen.getByRole("button", { name: "Prepare exact standing-policy review" })); return screen.findByRole("generic", { name: "Exact CALLIE policy review" }); }
function fillBooking() {
  fireEvent.change(screen.getByLabelText("Reviewed service property"), { target: { value: propertyId } });
  fireEvent.change(screen.getByLabelText(/Confirmed visit starts/), { target: { value: "2035-01-02T09:00" } });
  fireEvent.change(screen.getByLabelText(/Confirmed visit ends/), { target: { value: "2035-01-02T10:00" } });
  fireEvent.change(screen.getByLabelText("Accepted technician"), { target: { value: "tech" } });
  fireEvent.change(screen.getByLabelText("Actual customer agreement"), { target: { value: "The actual customer confirmed this exact visit with the office." } });
}
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("CALLIE contractor controls", () => {
  it("settles without a profile-refetch loop and never equates requests, caller ID or provider acceptance with booking", async () => {
    const api = server(); mount(`/calls?callieId=${id}`);
    await screen.findByText("Standing recovery is off"); await screen.findByText(/Caller identity not currently reviewed/);
    expect(screen.getAllByText(/Visit requested — not booked/)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Book CALLIE confirmed visit" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open original callback task" }).getAttribute("href")).toBe(`/tasks?taskId=${taskId}`);
    expect(api.requests.filter(req => req.path === "/api/v1/me")).toHaveLength(1);
    expect(api.writes()).toHaveLength(0);
    expect(screen.getByRole("region", { name: "CALLIE automatic intake" }).className).toContain("min-w-0");
    expect(screen.getByRole("button", { name: "Refresh CALLIE work" }).className).toContain("min-h-11");
  });
  it("previews exact finite messages, limits owners to accepted staff and requires unchecked explicit approval", async () => {
    const api = server(); mount(); await openPolicy();
    const owners = screen.getByLabelText("CALLIE daytime owner");
    expect(within(owners).getAllByRole("option").map(option => option.textContent)).toEqual(["Choose accepted staff", "Accepted Owner"]);
    fireEvent.click(screen.getByLabelText("Enable standing CALLIE intake for future eligible calls"));
    fireEvent.click(screen.getByRole("button", { name: "Prepare exact standing-policy review" }));
    const preview = await screen.findByRole("generic", { name: "Exact CALLIE policy review" });
    expect(within(preview).getByText(snapshot.acknowledgmentBody)).toBeTruthy();
    const approve = within(preview).getByRole("button", { name: "Approve standing policy" }); expect(approve.matches(":disabled")).toBe(true);
    fireEvent.click(within(preview).getByRole("checkbox")); fireEvent.click(approve);
    await screen.findByText("Approved, but held");
    expect(api.writes()).toHaveLength(2);
    expect(api.writes()[1].body).toMatchObject({ expectedVersion: 1, previewHash: "b".repeat(64), confirmed: true, expectedSnapshot: { organizationId, actorUserId: "u1", policy: { enabled: true } } });
    expect(screen.queryByRole("button", { name: "Approve standing policy" })).toBeNull();
  });
  it("invalidates both an approved preview and a delayed preview after settings change", async () => {
    const late = pending<Response>(); let delay = false;
    const api = server("owner", detail(), req => req.path.endsWith("/policy/preview") && delay ? late.promise : undefined); mount();
    const preview = await preparePolicy(); fireEvent.click(within(preview).getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText("Office response deadline (minutes)"), { target: { value: "45" } });
    expect(screen.queryByRole("button", { name: "Approve standing policy" })).toBeNull();
    delay = true; fireEvent.click(screen.getByRole("button", { name: "Prepare exact standing-policy review" }));
    fireEvent.change(screen.getByLabelText("CALLIE opens at"), { target: { value: "08:00" } });
    await act(async () => { late.resolve(json({ expectedVersion: 1, expectedSnapshot: { policy: snapshot }, previewHash: "b".repeat(64), expiresAt: new Date(Date.now() + 600_000).toISOString() })); await late.promise; });
    expect(screen.queryByRole("button", { name: "Approve standing policy" })).toBeNull();
    expect(api.writes().filter(req => req.path.endsWith("/approve"))).toHaveLength(0);
  });
  it("expires a policy preview without saving or silently retrying", async () => {
    const api = server("owner", detail(), req => req.path.endsWith("/policy/preview") ? json(policyPreview(req.body.policy as CallieSettings, new Date(Date.now() + 30).toISOString())) : undefined); mount(); await preparePolicy();
    await screen.findByText("This preview expired. Prepare a fresh review; nothing was approved.");
    expect(screen.getByRole("button", { name: "Approve standing policy" }).matches(":disabled")).toBe(true); expect(api.writes()).toHaveLength(1);
  });
  it("preserves an exact standing-policy preview and its approval across unchanged successful profile checks", async () => {
    const api = server(); const { client } = mount(); const preview = await preparePolicy(); fireEvent.click(within(preview).getByRole("checkbox"));
    for (let index = 0; index < 2; index++) await act(async () => { await client.invalidateQueries({ queryKey: getGetMeQueryKey() }); });
    expect(api.requests.filter(req => req.path === "/api/v1/me")).toHaveLength(3);
    expect(screen.getByRole("generic", { name: "Exact CALLIE policy review" })).toBe(preview);
    expect((within(preview).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect(within(preview).getByRole("button", { name: "Approve standing policy" }).matches(":disabled")).toBe(false);
    expect(api.requests.filter(req => req.path === `${base}/policy`)).toHaveLength(1); expect(api.writes()).toHaveLength(1);
  });
  it("preserves exact visit details and fresh customer confirmation across repeated unchanged profile checks", async () => {
    const api = server("owner", detail(true)); const { client } = mount(`/calls?callieId=${id}`); await screen.findByText("2. Confirm the agreed visit"); fillBooking();
    const confirmation = screen.getByLabelText(/The customer confirmed this exact time/); fireEvent.click(confirmation);
    for (let index = 0; index < 2; index++) await act(async () => { await client.invalidateQueries({ queryKey: getGetMeQueryKey() }); });
    expect(api.requests.filter(req => req.path === "/api/v1/me")).toHaveLength(3);
    expect((screen.getByLabelText("Reviewed service property") as HTMLSelectElement).value).toBe(propertyId);
    expect((screen.getByLabelText("Accepted technician") as HTMLSelectElement).value).toBe("tech");
    expect((screen.getByLabelText(/Confirmed visit starts/) as HTMLInputElement).value).toBe("2035-01-02T09:00");
    expect((screen.getByLabelText(/Confirmed visit ends/) as HTMLInputElement).value).toBe("2035-01-02T10:00");
    expect((screen.getByLabelText("Actual customer agreement") as HTMLTextAreaElement).value).toBe("The actual customer confirmed this exact visit with the office.");
    expect(screen.getByLabelText(/The customer confirmed this exact time/)).toBe(confirmation); expect((confirmation as HTMLInputElement).checked).toBe(true);
    expect(api.requests.filter(req => req.path === `${base}/${id}`)).toHaveLength(1); expect(api.writes()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Book CALLIE confirmed visit" })); await screen.findByText("Actual office appointment: confirmed");
    expect(api.writes()).toHaveLength(1); expect(api.writes()[0].body).toMatchObject({ expectedVersion: 1, expectedFingerprint: "a".repeat(64), customerConfirmed: true, propertyId, assignedUserId: "tech" });
  });
  it("uses bounded server pages and resets the offset when changing the attention/waiting/history scope", async () => {
    const api = server("owner", detail(), req => req.path === base ? json({ scope: req.query.get("scope"), offset: Number(req.query.get("offset")), pageSize: 25, hasMore: req.query.get("offset") === "0", items: [item({ phone: req.query.get("offset") === "25" ? "+12025550225" : "+12025550101" })], companyHeld: false, boundary: "Only this page; no global count." }) : undefined); mount();
    fireEvent.click(await screen.findByRole("button", { name: "Next CALLIE page" })); await screen.findByText("+12025550225");
    expect(screen.getByText("Page 2 · no whole-company count inferred")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("CALLIE worklist"), { target: { value: "waiting" } }); await screen.findByText("+12025550101");
    expect(api.requests.filter(req => req.path === base).map(req => `${req.query.get("scope")}:${req.query.get("offset")}`)).toEqual(["attention:0", "attention:25", "waiting:0"]);
    fireEvent.change(screen.getByLabelText("CALLIE worklist"), { target: { value: "history" } }); await screen.findByText(/Most recently changed first/);
  });
  it("keeps readonly staff readonly and resolves a request deep link outside the current list page", async () => {
    const api = server("viewer", detail(), req => req.path === base ? json({ scope: "attention", offset: 0, pageSize: 25, hasMore: false, items: [], companyHeld: false, boundary: "Bounded page." }) : undefined); mount(`/calls?callieId=${id}`);
    await screen.findByText(/Caller identity not currently reviewed/); await screen.findByText(/No CALLIE requests on this page/);
    expect(screen.queryByText("Review standing owners, hours and exact messages")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save CALLIE caller review" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Book CALLIE confirmed visit" })).toBeNull();
    expect(screen.queryByText("Assign or close office work")).toBeNull(); expect(api.writes()).toHaveLength(0);
  });
  it("requires actual staff caller review and does not grant consent when linking a customer", async () => {
    const api = server(); mount(`/calls?callieId=${id}`); await screen.findByTestId("callie-customer");
    await screen.findByRole("option", { name: "Fictional Customer" });
    const save = screen.getByRole("button", { name: "Save CALLIE caller review" }); expect(save.matches(":disabled")).toBe(true);
    fireEvent.change(screen.getByTestId("callie-customer"), { target: { value: contactId } });
    fireEvent.click(screen.getByLabelText(/I reviewed this actual caller/)); fireEvent.click(save);
    await screen.findByText(/Caller explicitly reviewed and linked/); expect(api.writes()).toHaveLength(1);
    expect(api.writes()[0].body).toMatchObject({ action: "link_contact", contactId, expectedVersion: 1, expectedFingerprint: "a".repeat(64), staffConfirmed: true });
    expect(screen.getByRole("button", { name: "Book CALLIE confirmed visit" }).matches(":disabled")).toBe(true);
  });
  it("clears exact visit confirmation after every edit and displays only the saved native appointment as booked", async () => {
    const api = server("owner", detail(true)); mount(`/calls?callieId=${id}`); await screen.findByText("2. Confirm the agreed visit"); fillBooking();
    const confirmation = screen.getByLabelText(/The customer confirmed this exact time/), book = screen.getByRole("button", { name: "Book CALLIE confirmed visit" });
    fireEvent.click(confirmation); expect(book.matches(":disabled")).toBe(false);
    for (const [label, value] of [["Reviewed service property", ""], ["Accepted technician", "u1"], ["CALLIE visit type", "other"], ["Actual customer agreement", "The customer confirmed these changed exact details with the office."]] as const) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } }); expect((confirmation as HTMLInputElement).checked).toBe(false); expect(book.matches(":disabled")).toBe(true); fireEvent.click(confirmation);
    }
    fireEvent.click(book); await screen.findByText("Actual office appointment: confirmed");
    expect(api.writes()).toHaveLength(1); expect(api.writes()[0].body).toMatchObject({ contactId, leadId: null, propertyId: null, assignedUserId: "u1", type: "other", customerConfirmed: true, expectedFingerprint: "a".repeat(64) });
    expect(screen.getByRole("link", { name: "Open Appointments to manage the saved visit" }).getAttribute("href")).toBe(`/appointments?appointmentId=${otherId}&organizationId=${organizationId}`);
    expect(screen.queryByRole("button", { name: "Book CALLIE confirmed visit" })).toBeNull();
  });
  it("blocks every repeat after stale booking until an explicit refresh and fresh confirmation", async () => {
    const api = server("owner", detail(true), req => req.path.endsWith("/book") ? json({ code: "stale_review" }, 409) : undefined); mount(`/calls?callieId=${id}`); await screen.findByText("2. Confirm the agreed visit"); fillBooking();
    fireEvent.click(screen.getByLabelText(/The customer confirmed this exact time/)); fireEvent.click(screen.getByRole("button", { name: "Book CALLIE confirmed visit" }));
    await screen.findByText(/Refresh the saved request before another action. No automatic retry was made/);
    expect(screen.getByRole("button", { name: "Book CALLIE confirmed visit" }).matches(":disabled")).toBe(true); expect(api.writes()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh CALLIE request" })); await screen.findByText("2. Confirm the agreed visit");
    expect((screen.getByLabelText(/The customer confirmed this exact time/) as HTMLInputElement).checked).toBe(false); expect(api.writes()).toHaveLength(1);
  });
  it("holds unknown send results without review, close, booking or resend and links the original reconciliation desk", async () => {
    const api = server("owner", detail(false, { state: "indeterminate", execution: { id: receiptId, state: "indeterminate" }, actions: { canReviewCaller: false, canAssign: false, canClose: false, canBook: false, blockReason: "provider_reconciliation_required" } })); mount(`/calls?callieId=${id}`);
    await screen.findByRole("link", { name: "Review original execution in Revenue Desk" }); expect(screen.getAllByText("Unknown send result — do not resend").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Review original execution in Revenue Desk" }).getAttribute("href")).toBe("/bie");
    expect(screen.queryByText("Assign or close office work")).toBeNull(); expect(screen.queryByRole("button", { name: /Save CALLIE|Book CALLIE|Send|Resend/ })).toBeNull(); expect(api.writes()).toHaveLength(0);
  });
  it.each(["identity", "company", "role", "logout"])("discards late approval and sensitive cached choices after a %s change", async kind => {
    const late = pending<Response>(); const api = server("owner", detail(), req => req.path.endsWith("/policy/preview") ? late.promise : undefined);
    const { client } = mount(`/calls?callieId=${id}`); await openPolicy(); fireEvent.click(screen.getByRole("button", { name: "Prepare exact standing-policy review" }));
    const nextProfile = { ...sampleMe(kind === "role" ? "viewer" : "owner"), ...(kind === "identity" ? { id: "different-member" } : {}), ...(kind === "company" ? { organization: { id: "o2", name: "Another Company", slug: "other", timezone: "UTC" } } : {}), ...(kind === "logout" ? { isActive: false, organization: null } : {}) };
    await act(async () => { client.setQueryData(getGetMeQueryKey(), nextProfile, { updatedAt: Date.now() + 1 }); });
    if (kind === "logout") await waitFor(() => expect(screen.queryByRole("region", { name: "CALLIE automatic intake" })).toBeNull());
    else await waitFor(() => expect(api.requests.filter(req => req.path === `${base}/reception` && req.method === "GET")).toHaveLength(2));
    await act(async () => { late.resolve(json(policyPreview())); await late.promise; });
    expect(screen.queryByRole("button", { name: "Approve standing policy" })).toBeNull();
    if (kind === "role" || kind === "logout") expect(screen.queryByRole("button", { name: "Save CALLIE caller review" })).toBeNull();
    expect(api.writes()).toHaveLength(1);
  });
  it("removes controls when a profile refetch fails, even if React Query retains its previous data", async () => {
    let signedOut = false; server("owner", detail(), req => signedOut && req.path === "/api/v1/me" ? json({ error: "Unauthorized" }, 401) : undefined);
    const { client } = mount(); await preparePolicy(); signedOut = true;
    await act(async () => { await client.invalidateQueries({ queryKey: getGetMeQueryKey() }); });
    await waitFor(() => expect(screen.queryByRole("region", { name: "CALLIE automatic intake" })).toBeNull());
    signedOut = false; await act(async () => { await client.invalidateQueries({ queryKey: getGetMeQueryKey() }); });
    await screen.findByText("Standing recovery is off"); expect(screen.queryByRole("button", { name: "Approve standing policy" })).toBeNull();
  });
});
