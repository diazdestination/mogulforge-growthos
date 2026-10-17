import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CustomerLifecycle } from "./customer-lifecycle";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const status = (state: "active" | "paused" | "offboarding_requested" = "active", version = 0) => ({
  state, version, automationAllowed: state === "active", requestId: state === "offboarding_requested" ? "87663a1f-ecf5-45b0-aae3-9d5d71f06888" : null,
  requestedAt: state === "offboarding_requested" ? "2026-10-01T10:00:00.000Z" : null, updatedAt: null, reason: null, deletionPerformed: false, billingChanged: false,
});
const exported = () => {
  const tables = ["contacts", "properties", "leads", "estimates", "projects", "crm_tasks", "appointments", "activities", "consent_records", "suppressions", "value_entries", "revenue_executions", "revenue_execution_events", "stored_objects", "service_obligations", "invoices", "invoice_receipt_allocations", "invoice_operations", "customer_work_roots", "service_watch_cases", "financial_migration_items", "property_assets", "work_checklist_templates", "work_checklist_revisions", "appointment_work_completions", "appointment_work_entries", "appointment_work_photos", "estimate_email_receipts"];
  return {
    format: "growthos-core-customer-export", version: 1, exportId: "eec65dde-1d8c-4e04-b0a0-437cfb62c742", generatedAt: "2026-10-01T10:00:00.000Z",
    organization: { id: "919c9194-5267-4871-aed5-7470b0a7251b", name: "Synthetic company", slug: "synthetic-company", schedulingPolicy: null, schedulingHistory: [], created_at: "2026-10-01T10:00:00.000Z" },
    manifest: { scope: "core_customer_records", completeAccountExport: false, deletionPerformed: false, rowsPerTableLimit: 2000, byteLimit: 10 * 1024 * 1024,
      tables: tables.map((table) => ({ table, fields: ["id", "first_name"], count: table === "contacts" ? 1 : 0, withheldInvalidLinks: table === "estimates" ? 1 : 0 })),
      schedulingPolicy: { state: "unconfigured" }, schedulingHistory: { count: 0, withheldInvalidLinks: 0, withheldInvalidRecords: 0 }, schedulingPolicySha256: "b".repeat(64), schedulingHistorySha256: "c".repeat(64), exclusions: ["Credentials excluded"], dataSha256: "a".repeat(64), followUp: "Ask your operator" },
    data: Object.fromEntries(tables.map((table) => [table, table === "contacts" ? [{ id: "own-contact", first_name: "Synthetic contact" }] : []])),
  };
};
const review = () => fireEvent.click(screen.getByRole("button", { name: "Review company status" }));
const reason = (text = "Owner reviewed pending company work") => fireEvent.change(screen.getByLabelText("Reason for this change"), { target: { value: text } });
function downloads() {
  const createObjectURL = vi.fn((_blob: Blob) => "blob:synthetic-download"), revokeObjectURL = vi.fn();
  const OriginalURL = URL;
  vi.stubGlobal("URL", class extends OriginalURL { static createObjectURL = createObjectURL; static revokeObjectURL = revokeObjectURL; });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  return { createObjectURL, revokeObjectURL, click };
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("requires a manual review and keeps tenant selectors out of the request", async () => {
  const fetch = vi.fn().mockResolvedValue(json(status())); vi.stubGlobal("fetch", fetch);
  render(<CustomerLifecycle accountKey="owner:company-a" />);
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Pause company work" })).toBeNull();
  review();
  await screen.findByRole("region", { name: "Company operating status" });
  expect(fetch).toHaveBeenCalledWith("/api/v1/customer-lifecycle", { method: "GET", credentials: "include", cache: "no-store", signal: expect.any(AbortSignal) });
  expect(screen.getByRole("button", { name: "Pause company work" }).hasAttribute("disabled")).toBe(true);
  reason("short");
  expect(screen.getByRole("button", { name: "Pause company work" }).hasAttribute("disabled")).toBe(true);
  reason();
  expect(screen.getByRole("button", { name: "Pause company work" }).hasAttribute("disabled")).toBe(false);
  expect(screen.getByText(/do not cancel billing, revoke provider access or erase data/)).toBeTruthy();
});

it("downloads a manually requested validated core export with coverage and without saving customer records in the page", async () => {
  const download = downloads(), fetch = vi.fn().mockResolvedValue(json(exported())); vi.stubGlobal("fetch", fetch);
  render(<CustomerLifecycle accountKey="owner:company-a" />);
  fireEvent.click(screen.getByRole("button", { name: "Download core records" }));
  expect((await screen.findByRole("status")).textContent).toContain("1 record across 28 datasets");
  expect(screen.getByRole("status").textContent).toContain("1 record was withheld");
  expect(fetch.mock.calls[0][0]).toBe("/api/v1/customer-lifecycle/export");
  expect(download.createObjectURL).toHaveBeenCalledTimes(1);
  expect(download.click).toHaveBeenCalledTimes(1);
  expect(download.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-download");
  expect(screen.queryByText("Synthetic contact")).toBeNull();
});

it.each(["complete", "mismatched-count", "undeclared-field"])("does not download an export with invalid %s coverage", async (kind) => {
  const fixture = exported();
  if (kind === "complete") fixture.manifest.completeAccountExport = true;
  if (kind === "mismatched-count") fixture.manifest.tables[0].count = 2;
  if (kind === "undeclared-field") fixture.manifest.tables[0].fields = ["id"];
  const download = downloads(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(fixture)));
  render(<CustomerLifecycle accountKey="owner:company-a" />);
  fireEvent.click(screen.getByRole("button", { name: "Download core records" }));
  expect((await screen.findByRole("alert")).textContent).toContain("export could not be prepared");
  expect(download.click).not.toHaveBeenCalled();
});

it("records offboarding, preserves its reference, cancels to paused and requires explicit queue review before resuming", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(json(status())).mockResolvedValueOnce(json(status("offboarding_requested", 1)))
    .mockResolvedValueOnce(json(status("paused", 2))).mockResolvedValueOnce(json(status("active", 3)));
  vi.stubGlobal("fetch", fetch); render(<CustomerLifecycle accountKey="owner:company-a" />);
  review(); await screen.findByText("Active"); reason();
  fireEvent.click(screen.getByRole("button", { name: "Request offboarding review" }));
  await screen.findByText(/Request reference: 87663a1f/);
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ action: "request_offboarding", expectedVersion: 0, reason: "Owner reviewed pending company work" });
  reason("Owner decided to continue with this company");
  fireEvent.click(screen.getByRole("button", { name: "Cancel offboarding request" }));
  await screen.findByText("Paused");
  expect(screen.getByRole("status").textContent).toContain("Company work remains paused");
  reason();
  const resume = screen.getByRole("button", { name: "Resume company work" });
  expect(resume.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(resume);
  await screen.findByText("Active");
  expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual({ action: "resume", expectedVersion: 2, reason: "Owner reviewed pending company work", resumeQueuedWork: true });
  expect((screen.getByLabelText("Reason for this change") as HTMLTextAreaElement).value).toBe("");
});

it("disables duplicate actions while pending and keeps reason plus previous version after an uncertain result until a fresh review", async () => {
  let reject!: (error: Error) => void;
  const fetch = vi.fn().mockResolvedValueOnce(json(status("active", 4)))
    .mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }))
    .mockResolvedValueOnce(json(status("active", 4))).mockResolvedValueOnce(json(status("paused", 5)));
  vi.stubGlobal("fetch", fetch); render(<CustomerLifecycle accountKey="owner:company-a" />);
  review(); await screen.findByText("Active"); reason();
  fireEvent.click(screen.getByRole("button", { name: "Pause company work" }));
  for (const button of screen.getAllByRole("button")) expect(button.hasAttribute("disabled")).toBe(true);
  await act(async () => reject(new Error("SECRET_TRANSPORT_DETAIL")));
  expect((await screen.findByRole("alert")).textContent).toContain("It may have been recorded");
  expect(screen.queryByText(/SECRET_TRANSPORT_DETAIL/)).toBeNull();
  expect(screen.getByText("Previously checked: Active")).toBeTruthy();
  expect((screen.getByLabelText("Reason for this change") as HTMLTextAreaElement).value).toBe("Owner reviewed pending company work");
  expect(screen.getByRole("button", { name: "Pause company work" }).hasAttribute("disabled")).toBe(true);
  review(); await screen.findByText("Active");
  fireEvent.click(screen.getByRole("button", { name: "Pause company work" }));
  await screen.findByText("Paused");
  expect(JSON.parse(fetch.mock.calls[3][1].body)).toMatchObject({ expectedVersion: 4, reason: "Owner reviewed pending company work" });
});

it.each([[401, "sign in again"], [403, "active company owner"], [413, "No partial file was produced"], [503, "export could not be prepared"]])("shows an actionable export error for %s without exposing response details", async (code, expected) => {
  const download = downloads(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "SECRET_PROVIDER_RESPONSE" }, Number(code))));
  render(<CustomerLifecycle accountKey="owner:company-a" />);
  fireEvent.click(screen.getByRole("button", { name: "Download core records" }));
  expect((await screen.findByRole("alert")).textContent).toContain(expected);
  expect(screen.queryByText(/SECRET_PROVIDER_RESPONSE/)).toBeNull();
  expect(download.click).not.toHaveBeenCalled();
});

it("clears account-specific operating status and reasons when the signed-in company changes", async () => {
  const fetch = vi.fn().mockResolvedValue(json(status("paused", 6))); vi.stubGlobal("fetch", fetch);
  const view = render(<CustomerLifecycle accountKey="owner:company-a" />);
  review(); await screen.findByText("Paused"); reason();
  view.rerender(<CustomerLifecycle accountKey="owner:company-b" />);
  expect(screen.queryByRole("region", { name: "Company operating status" })).toBeNull();
  expect(screen.queryByLabelText("Reason for this change")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("aborts an old account's export and ignores a late response without triggering a download", async () => {
  let resolve!: (response: Response) => void;
  const download = downloads(), fetch = vi.fn().mockImplementation(() => new Promise<Response>((done) => { resolve = done; })); vi.stubGlobal("fetch", fetch);
  const view = render(<CustomerLifecycle accountKey="owner:company-a" />);
  fireEvent.click(screen.getByRole("button", { name: "Download core records" }));
  const signal = fetch.mock.calls[0][1].signal as AbortSignal;
  view.rerender(<CustomerLifecycle accountKey="owner:company-b" />);
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(json(exported())));
  expect(download.click).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).toBeNull();
});

it("bounds stalled response bodies and requires another manual action", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) }); vi.stubGlobal("fetch", fetch);
  render(<CustomerLifecycle accountKey="owner:company-a" />); review();
  await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
  expect(screen.getByRole("alert").textContent).toContain("status could not be checked");
  expect((fetch.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});

const currentExport = exported;
const readBlob = (blob: Blob) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob); });
it('downloads the current 28 approved datasets with scheduling envelopes and checksums in the actual Blob', async () => {
  const fixture = currentExport(), download = downloads(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(fixture)));
  render(<CustomerLifecycle accountKey="owner:company-a" />);
  fireEvent.click(screen.getByRole('button', { name: 'Download core records' }));
  expect((await screen.findByRole('status')).textContent).toContain('28 datasets');
  const downloaded = JSON.parse(await readBlob(download.createObjectURL.mock.calls[0][0]));
  expect(downloaded.organization).toEqual(fixture.organization);
  expect(downloaded.manifest).toEqual(fixture.manifest);
  expect(downloaded.data).toEqual(fixture.data);
});
it.each(['historical18', 'foreign-table', 'policy-state', 'policy-digest', 'history-count', 'history-extra', 'history-overflow'])('rejects invalid %s scheduling export coverage before creating a Blob', async (kind) => {
  const fixture: any = currentExport();
  if (kind === 'historical18') { fixture.manifest.tables = fixture.manifest.tables.slice(0, 18); fixture.data = Object.fromEntries(fixture.manifest.tables.map(({table}: any) => [table, fixture.data[table]])); }
  if (kind === 'foreign-table') { const old = fixture.manifest.tables[0].table; fixture.manifest.tables[0].table = 'private_provider_credentials'; fixture.data.private_provider_credentials = fixture.data[old]; delete fixture.data[old]; }
  if (kind === 'policy-state') fixture.manifest.schedulingPolicy.state = 'versioned';
  if (kind === 'policy-digest') fixture.manifest.schedulingPolicySha256 = 'not-a-digest';
  if (kind === 'history-count') fixture.manifest.schedulingHistory.count = 1;
  if (kind === 'history-extra') fixture.manifest.schedulingHistory.actorUserId = 'private-actor';
  if (kind === 'history-overflow') fixture.organization.schedulingHistory = Array(2001).fill({});
  const download = downloads(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(fixture)));
  render(<CustomerLifecycle accountKey="owner:company-a" />); fireEvent.click(screen.getByRole('button', { name: 'Download core records' }));
  expect((await screen.findByRole('alert')).textContent).toContain('export could not be prepared');
  expect(download.createObjectURL).not.toHaveBeenCalled();
});
