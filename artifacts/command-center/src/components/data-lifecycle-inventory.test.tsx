import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DataLifecycleInventory } from "./data-lifecycle-inventory";

const fixture = () => ({
  catalogVersion: "2026-10-01.inventory-v1", status: "bounded_preview",
  complete: false, exportReady: false, deletionReady: false,
  coverage: { classifiedTables: 3, sourceSchemaHash: "a".repeat(64), deployedSchema: "matched", reasons: [], countedTables: 2, excludedTables: 1, providerMetadataExclusions: [] as string[] },
  limits: { rowsPerTable: 10_000, countQueryMs: 5_000, totalMs: 12_000 },
  tables: [
    { table: "leads", category: "crm", ownership: "direct_org", selector: "organization_id", rowCount: 4, countStatus: "exact_in_snapshot" },
    { table: "activities", category: "crm", ownership: "direct_org", selector: "organization_id", rowCount: 10_000, countStatus: "at_least_limit" },
    { table: "sessions", category: "account_access", ownership: "shared_exception", selector: "excluded", rowCount: null, countStatus: "excluded" },
  ],
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const click = () => fireEvent.click(screen.getByRole("button", { name: "Check data inventory" }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("requires a manual read and displays bounded counts without claiming a complete lifecycle", async () => {
  const fetch = vi.fn().mockResolvedValue(json(fixture()));
  vi.stubGlobal("fetch", fetch);
  render(<DataLifecycleInventory accountKey="owner:org-a" />);
  expect(fetch).not.toHaveBeenCalled();
  click();
  await screen.findByRole("region", { name: "Inventory preview" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith("/api/v1/data-lifecycle/inventory", {
    method: "GET", credentials: "include", cache: "no-store", signal: expect.any(AbortSignal),
  });
  expect(screen.getByText("At least 10,000")).toBeTruthy();
  expect(screen.getByText("Not counted")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("2 tables counted; 1 shared or unscoped tables excluded");
  expect(screen.getByText(/not a total number of customers/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /export|delete/i })).toBeNull();
});

it.each([
  [401, "Please sign in again"], [403, "Only a signed-in company owner"],
  [409, "Counts are hidden"], [503, "No data was changed"], [500, "No data was changed"],
])("uses a safe, actionable message for status %s", async (status, expected) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "private-provider-token", ...fixture() }, status)));
  render(<DataLifecycleInventory accountKey="owner:org-a" />);
  click();
  expect((await screen.findByRole("alert")).textContent).toContain(expected);
  expect(screen.queryByText(/private-provider-token/)).toBeNull();
  expect(screen.queryByRole("region", { name: "Inventory preview" })).toBeNull();
});

it.each(["complete", "exportReady", "deletionReady"])("rejects a response claiming %s", async (flag) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ ...fixture(), [flag]: true })));
  render(<DataLifecycleInventory accountKey="owner:org-a" />);
  click();
  expect((await screen.findByRole("alert")).textContent).toContain("could not be checked");
  expect(screen.queryByRole("region", { name: "Inventory preview" })).toBeNull();
});

it("rejects inconsistent coverage and duplicate table names", async () => {
  const bad = fixture();
  bad.tables[1]!.table = "leads";
  bad.coverage.countedTables = 1;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(bad)));
  render(<DataLifecycleInventory accountKey="owner:org-a" />);
  click();
  await screen.findByRole("alert");
  expect(screen.queryByRole("region", { name: "Inventory preview" })).toBeNull();
});

it("discards previous results before a later check fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(fixture())).mockRejectedValueOnce(new Error("secret transport detail")));
  render(<DataLifecycleInventory accountKey="owner:org-a" />);
  click();
  await screen.findByRole("region", { name: "Inventory preview" });
  click();
  await screen.findByRole("alert");
  expect(screen.queryByRole("region", { name: "Inventory preview" })).toBeNull();
  expect(screen.queryByText(/secret transport detail/)).toBeNull();
});

it("clears completed counts when the signed-in account changes", async () => {
  const fetch = vi.fn().mockResolvedValue(json(fixture()));
  vi.stubGlobal("fetch", fetch);
  const view = render(<DataLifecycleInventory accountKey="owner:org-a" />);
  click();
  await screen.findByRole("region", { name: "Inventory preview" });
  view.rerender(<DataLifecycleInventory accountKey="owner:org-b" />);
  expect(screen.queryByRole("region", { name: "Inventory preview" })).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("aborts an old account's request and ignores even a non-cooperative late response", async () => {
  let resolve!: (value: Response) => void;
  const fetch = vi.fn().mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
  vi.stubGlobal("fetch", fetch);
  const view = render(<DataLifecycleInventory accountKey="owner:org-a" />);
  click();
  const signal = fetch.mock.calls[0]![1].signal as AbortSignal;
  view.rerender(<DataLifecycleInventory accountKey="owner:org-b" />);
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(json(fixture())));
  expect(screen.queryByRole("region", { name: "Inventory preview" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("aborts on unmount without starting any replacement request", () => {
  const fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetch);
  const view = render(<DataLifecycleInventory accountKey="owner:org-a" />);
  click();
  view.unmount();
  expect((fetch.mock.calls[0]![1].signal as AbortSignal).aborted).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("bounds a hung request and does not retry it automatically", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetch);
  render(<DataLifecycleInventory accountKey="owner:org-a" />);
  click();
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(screen.getByRole("alert").textContent).toContain("could not be checked");
  expect((fetch.mock.calls[0]![1].signal as AbortSignal).aborted).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Check data inventory" }).hasAttribute("disabled")).toBe(false);
});

it("bounds the response body as well as the initial request", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) }));
  render(<DataLifecycleInventory accountKey="owner:org-a" />);
  click();
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(screen.getByRole("alert").textContent).toContain("could not be checked");
});

it("shows reviewed provider metadata exclusions separately from company record counts", async () => {
  const data = fixture();
  data.coverage.providerMetadataExclusions = ["docker_parity_provider_monitor_v1"];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(data)));
  render(<DataLifecycleInventory accountKey="owner:org-a" />);
  click();
  await screen.findByText(/One reviewed provider-monitoring view was excluded/);
  expect(screen.getByRole("status").textContent).toContain("2 tables counted");
});
