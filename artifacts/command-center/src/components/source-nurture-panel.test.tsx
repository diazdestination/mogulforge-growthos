import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { SourceNurturePanel } from "./source-nurture-panel";
import { nurtureFixture, nurtureId, nurtureListFixture } from "./source-nurture-fixtures";
import { parseNurtureDetail, type NurtureDetail } from "./source-nurture-types";
function renderWithQuery(ui: ReactElement) { const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); return render(ui, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> }); }

const props = { organizationId: nurtureId(1), actorUserId: "owner-one", businessName: "Synthetic Contractor", timezone: "America/New_York", canManage: true, scopeKey: '["owner-one","company-one","owner",true]' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); window.history.replaceState({}, "", "/"); });
function stub(getDetail: () => NurtureDetail, post?: (path: string, body: Record<string, unknown>) => Promise<Response>, listExtra = {}) {
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url), parsed = new URL(path, "https://example.invalid");
    if (init?.method === "POST") return post ? post(path, JSON.parse(String(init.body))) : json({}, 409);
    if (parsed.pathname.endsWith("/users")) return json([{ id: "office-one", firstName: "Synthetic", lastName: "Office" }]);
    if (parsed.pathname.endsWith("/source-adoption")) return json({ candidates: [{ id: nurtureId(5), status: "lost", importSourceKey: "synthetic-export", externalOpportunityId: "opportunity-1" }], page: Number(parsed.searchParams.get("page") ?? 0), hasMore: false });
    if (parsed.pathname.endsWith("/source-nurture")) return json(nurtureListFixture(getDetail(), { bucket: (parsed.searchParams.get("bucket") ?? "attention") as "attention", offset: Number(parsed.searchParams.get("offset") ?? 0), ...listExtra }));
    return json(getDetail());
  });
  vi.stubGlobal("fetch", request); return request;
}
async function openPlan() { fireEvent.click(await screen.findByRole("button", { name: /Review .* plan · 1 recipient/ })); await screen.findByText(/Saved plan:/); }
async function approve() { fireEvent.click(screen.getByLabelText(/I reviewed every exact recipient/)); fireEvent.click(screen.getByRole("button", { name: "Approve exact nurture plan — does not start" })); }

it("shows both complete escaped messages, named office ownership, exact reader and truthful bounded evidence", async () => {
  const detail = nurtureFixture(); detail.items[0].steps[0].body += '\n<img src=x onerror="alert(1)">';
  detail.items[0].outcomes = { leadStatus: "contacted", replyIds: [nurtureId(21)], taskIds: [nurtureId(22)], appointmentIds: [nurtureId(23)] };
  const request = stub(() => detail);
  const view = renderWithQuery(<SourceNurturePanel {...props} />); await openPlan();
  expect(screen.getByText(/Accountable office owner: Synthetic Office/)).toBeTruthy();
  expect(screen.getByText(/Approved reader: office@example.invalid/)).toBeTruthy();
  expect(screen.getAllByText(/Unsubscribe: https:\/\/example.invalid\/unsubscribe\/frozen-/)).toHaveLength(2);
  expect(view.container.querySelector("img")).toBeNull();
  expect(screen.getByText(/Mailbox progression held: Sent Items and Inbox/)).toBeTruthy();
  expect(screen.getByRole("link", { name: /Open lead and original replies/ }).getAttribute("href")).toBe(`/leads/${nurtureId(5)}?tab=messages`);
  expect(screen.getByRole("link", { name: "Open office task" }).getAttribute("href")).toBe(`/tasks?taskId=${nurtureId(22)}`);
  expect(screen.getByText(/Recorded appointment IDs:/)).toBeTruthy();
  expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});

it("separates exact approval from explicit start and keeps saved receipts visible through background list refresh", async () => {
  let detail = nurtureFixture();
  const request = stub(() => detail, async (path, body) => {
    const action = path.endsWith("/approve") ? "approve" : "start";
    expect(body.expectedVersion).toBe(detail.version); expect(body.payloadSha256).toBe(detail.payloadSha256);
    detail = { ...detail, version: detail.version + 1, state: action === "approve" ? "approved" : "running", approvedByUserId: "owner-one", approvedAt: new Date().toISOString(), ...(action === "start" ? { startedAt: new Date().toISOString() } : {}) };
    return json({ detail, command: { action, requestId: body.requestId ?? null, replayed: false, appliedVersion: detail.version } });
  });
  renderWithQuery(<SourceNurturePanel {...props} />); await openPlan();
  expect(screen.getByRole("button", { name: "Approve exact nurture plan — does not start" }).hasAttribute("disabled")).toBe(true);
  await approve(); await screen.findByText(/Exact plan approved. It has not started/);
  expect(screen.getByRole("button", { name: "Start approved two-message plan" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText(/Saved plan: approved/)).toBeTruthy();
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  fireEvent.click(screen.getByLabelText(/Explicitly start only these frozen recipients/));
  fireEvent.click(screen.getByRole("button", { name: "Start approved two-message plan" }));
  await screen.findByText(/Start receipt saved/);
  const writes = request.mock.calls.filter(([, init]) => init?.method === "POST"); expect(writes).toHaveLength(2);
  expect(JSON.parse(String(writes[0][1]?.body))).toEqual({ expectedVersion: 1, payloadSha256: "a".repeat(64), confirmed: true });
  expect(JSON.parse(String(writes[1][1]?.body))).toEqual({ expectedVersion: 2, payloadSha256: "a".repeat(64), confirmed: true, requestId: expect.any(String) });
  expect(screen.getByText(/Saved plan: running/)).toBeTruthy();
});

it("stops while held with a fresh reason and retains the original unknown result, without a resume or resend", async () => {
  let detail = nurtureFixture({ state: "running", version: 3 }); detail.items[0].steps[0].state = "uncertain";
  const request = stub(() => detail, async (_path, body) => { detail = { ...detail, version: 4, state: "stopped", stoppedAt: new Date().toISOString(), stopReason: String(body.reason) }; return json({ detail, command: { action: "stop", requestId: body.requestId, replayed: false, appliedVersion: 4 } }); });
  renderWithQuery(<SourceNurturePanel {...props} />); await openPlan();
  fireEvent.change(screen.getByLabelText("Nurture stop reason"), { target: { value: "Office wants this campaign stopped." } });
  fireEvent.click(screen.getByLabelText(/I want to stop remaining unclaimed work/));
  fireEvent.click(screen.getByRole("button", { name: "Stop this nurture plan" }));
  await screen.findByText(/Stop receipt saved/);
  expect(screen.getByText(/Unknown result — do not retry or advance/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /resume|resend/i })).toBeNull();
  expect(JSON.parse(String(request.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body))).toEqual({ expectedVersion: 3, payloadSha256: "a".repeat(64), confirmed: true, requestId: expect.any(String), reason: "Office wants this campaign stopped." });
});

it.each(["lost response", "invalid receipt"])("fails closed after %s and requires explicit saved-plan refresh", async mode => {
  const detail = nurtureFixture();
  const request = stub(() => detail, async () => { if (mode === "lost response") throw new Error("network result unknown"); return json({ detail, command: { action: "approve", requestId: null, appliedVersion: 99, replayed: false } }); });
  renderWithQuery(<SourceNurturePanel {...props} />); await openPlan(); await approve();
  await screen.findByText(/This result is unconfirmed. Refresh this exact saved plan/);
  expect(screen.getByRole("button", { name: "Approve exact nurture plan — does not start" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Prepare a new two-message review" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Refresh saved nurture work" }));
  await screen.findByText(/Saved plan: draft/);
  expect((screen.getByLabelText(/I reviewed every exact recipient/) as HTMLInputElement).checked).toBe(false);
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});

it("uses server buckets and stable bounded pagination without whole-company totals", async () => {
  const detail = nurtureFixture(); const request = stub(() => detail, undefined, { hasMore: true });
  renderWithQuery(<SourceNurturePanel {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "More nurture plans" }));
  await screen.findByText(/Page 2 · up to 25 plans/);
  fireEvent.click(screen.getByRole("button", { name: "Waiting", exact: true }));
  await screen.findByText(/Page 1 · up to 25 plans/);
  expect(request.mock.calls.some(([path]) => String(path).endsWith("bucket=attention&offset=25"))).toBe(true);
  expect(request.mock.calls.some(([path]) => String(path).endsWith("bucket=waiting&offset=0"))).toBe(true);
});

it("rejects wrong-company, wrong-step or wrong-page evidence instead of exposing approval", async () => {
  const detail = nurtureFixture({ organizationId: nurtureId(99) });
  stub(() => detail); renderWithQuery(<SourceNurturePanel {...props} />);
  await screen.findByText(/Nurture work is unavailable/);
  expect(screen.queryByRole("button", { name: /Approve exact nurture/ })).toBeNull();
  const invalid = nurtureFixture(); invalid.items[0].steps[1].stepIndex = 1;
  expect(() => parseNurtureDetail(invalid, props.organizationId)).toThrow();
});

it("preserves review on unchanged scope and ignores late approval after a changed member or role", async () => {
  const detail = nurtureFixture(); let finish!: (response: Response) => void;
  stub(() => detail, () => new Promise(resolve => { finish = resolve; }));
  const view = renderWithQuery(<SourceNurturePanel {...props} />); await openPlan();
  fireEvent.click(screen.getByLabelText(/I reviewed every exact recipient/));
  view.rerender(<SourceNurturePanel {...props} />);
  expect((screen.getByLabelText(/I reviewed every exact recipient/) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Approve exact nurture plan — does not start" }));
  view.rerender(<SourceNurturePanel {...props} actorUserId="viewer-two" canManage={false} scopeKey="different-member" />);
  await act(async () => finish(json({ detail: { ...detail, version: 2, state: "approved" }, command: { action: "approve", requestId: null, appliedVersion: 2, replayed: false } })));
  expect(screen.queryByText(/Exact plan approved/)).toBeNull();
  expect(screen.queryByLabelText(/I reviewed every exact recipient/)).toBeNull();
  expect(screen.getByText(/Read-only: an accepted active owner/)).toBeTruthy();
});

it("freezes the form after preview and a changed review never mutates the saved plan", async () => {
  const detail = nurtureFixture(); const request = stub(() => detail, async path => { expect(path).toBe("/api/v1/source-nurture/preview"); return json(detail); });
  renderWithQuery(<SourceNurturePanel {...props} />);
  await screen.findByRole("button", { name: /Review draft plan/ });
  fireEvent.click(screen.getByRole("button", { name: "Prepare a new two-message review" }));
  fireEvent.click(await screen.findByLabelText("synthetic-export / opportunity-1 · lost"));
  fireEvent.change(screen.getByLabelText("Nurture business mailing address"), { target: { value: "10 Fixture Road, Example GA 30301" } });
  for (const index of [1, 2]) { fireEvent.change(screen.getByLabelText(`Email ${index} subject`), { target: { value: `Subject ${index}` } }); fireEvent.change(screen.getByLabelText(`Email ${index} message`), { target: { value: `This is the complete email ${index} message.` } }); }
  fireEvent.click(within(screen.getByRole("group", { name: "Nurture sending days" })).getByLabelText("Mon"));
  fireEvent.click(screen.getByRole("button", { name: "Prepare exact two-message preview" }));
  await screen.findByText(/Exact review saved/);
  expect(screen.queryByLabelText("Email 1 message")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Prepare a new two-message review" }));
  await screen.findByLabelText("Email 1 message");
  expect((screen.getByLabelText("Email 1 message") as HTMLTextAreaElement).value).toBe("");
  expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect(screen.getByText(/Earlier plans and their permanent address reservations are unchanged/)).toBeTruthy();
});

it("does not approve an expired or another member's preview and exposes no write controls to viewers", async () => {
  const detail = nurtureFixture({ createdByUserId: "different-owner", previewExpiresAt: new Date(Date.now() - 1000).toISOString() });
  stub(() => detail); const view = renderWithQuery(<SourceNurturePanel {...props} />); await openPlan();
  expect(screen.getByRole("button", { name: "Approve exact nurture plan — does not start" }).hasAttribute("disabled")).toBe(true);
  view.rerender(<SourceNurturePanel {...props} canManage={false} />); await openPlan();
  expect(screen.queryByRole("button", { name: /Approve exact|Start approved|Stop this nurture/ })).toBeNull();
});

it("ignores a late detail read after navigation selects a different exact plan", async () => {
  const first = nurtureFixture(), second = nurtureFixture({ id: nurtureId(80) });
  let finish!: (response: Response) => void;
  const request = vi.fn(async (url: RequestInfo | URL) => {
    const path = String(url);
    if (path.endsWith("/users")) return json([]);
    if (path.includes("?bucket=")) return json(nurtureListFixture(first));
    if (path.endsWith(first.id)) return new Promise<Response>(resolve => { finish = resolve; });
    return json(second);
  });
  vi.stubGlobal("fetch", request);
  window.history.replaceState({}, "", `/reactivation?nurtureId=${first.id}`);
  renderWithQuery(<SourceNurturePanel {...props} />);
  await waitFor(() => expect(finish).toBeDefined());
  await act(async () => { window.history.pushState({}, "", `/reactivation?nurtureId=${second.id}`); });
  expect((await screen.findByRole("link", { name: "Open this saved plan directly" })).getAttribute("href")).toBe(`/reactivation?nurtureId=${second.id}`);
  await act(async () => finish(json(first)));
  expect(screen.getByRole("link", { name: "Open this saved plan directly" }).getAttribute("href")).toBe(`/reactivation?nurtureId=${second.id}`);
});
