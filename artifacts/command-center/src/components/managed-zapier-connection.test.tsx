import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ManagedZapierConnection } from "./managed-zapier-connection";

function envelope(organizationId: string, connectionFingerprint: string | null, connected = Boolean(connectionFingerprint), limit = connectionFingerprint ? 20 : null) {
  return {
    organizationId,
    status: { provisioning: connectionFingerprint ? "mogulforge" : "unassigned", connected, connectionFingerprint, monthlyActionLimit: limit },
    serverReference: connectionFingerprint ? organizationId + "-server" : null,
    usage: { monthStartUtc: "2026-11-01T00:00:00.000Z", successfulActions: 3, indeterminateActions: 1, estimatedTasksFromRecordedActions: 6, monthlyActionLimit: limit, monthlyActionsUsed: 4, monthlyActionsRemaining: limit === null ? null : Math.max(0, limit - 4) },
  };
}

const response = (body: unknown, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status });
const fetchMock = vi.fn<typeof fetch>();
const setup = (actorId = "operator", organizationId = "org-a") =>
  <ManagedZapierConnection actorId={actorId} organizationId={organizationId} companyName={organizationId === "org-a" ? "First Company" : "Second Company"} />;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function form() {
  return {
    reference: screen.getByLabelText("Server reference") as HTMLInputElement,
    monthlyLimit: screen.getByLabelText("Monthly action ceiling") as HTMLInputElement,
    token: screen.getByLabelText("Private connection token") as HTMLInputElement,
    ownership: screen.getByRole("checkbox", { name: /MogulForge owns/ }) as HTMLInputElement,
    dedicated: screen.getByRole("checkbox", { name: /apps are dedicated/ }) as HTMLInputElement,
    save: screen.getByRole("button", { name: "Save connection" }) as HTMLButtonElement,
  };
}

function fill(reference: string, token: string) {
  const fields = form();
  fireEvent.change(fields.reference, { target: { value: reference } });
  fireEvent.change(fields.token, { target: { value: token } });
  fireEvent.click(fields.ownership);
  fireEvent.click(fields.dedicated);
  return fields;
}

it("requires both attestations, saves the selected organization and clears the token and confirmations", async () => {
  fetchMock.mockResolvedValueOnce(response(envelope("org-a", null)));
  fetchMock.mockResolvedValueOnce(response(envelope("org-a", "opaque-v1")));
  render(setup());
  await screen.findByText("No connection assigned");
  const fields = form();
  fireEvent.change(fields.reference, { target: { value: "org-a-server" } });
  fireEvent.change(fields.token, { target: { value: "fixture-token" } });
  expect(fields.token.type).toBe("password");
  expect(fields.save.disabled).toBe(true);
  fireEvent.click(fields.ownership);
  expect(fields.save.disabled).toBe(true);
  fireEvent.click(fields.dedicated);
  expect(fields.monthlyLimit.value).toBe("1000");
  fireEvent.change(fields.monthlyLimit, { target: { value: "0" } });
  fireEvent.click(fields.save);
  expect(fields.token.value).toBe("");
  await screen.findByText("Managed by MogulForge");
  expect(fetchMock.mock.calls[1]).toMatchObject([
    "/api/v1/platform/clients/org-a/integrations/zapier",
    { method: "PUT", cache: "no-store", body: JSON.stringify({ monthlyActionLimit: 0, serverReference: "org-a-server", connectionToken: "fixture-token", ownershipConfirmed: true, dedicatedConnectionConfirmed: true, expectedConnectionFingerprint: null }) },
  ]);
  expect(form().token.value).toBe("");
  expect(form().monthlyLimit.value).toBe("20");
  expect(form().ownership.checked).toBe(false);
  expect(form().dedicated.checked).toBe(false);
  expect(screen.getByText(/Estimated tasks from successful actions: 6/)).toBeTruthy();
  expect(document.body.textContent).not.toContain("fixture-token");
});

it("resets attestations and the token when the reference changes", async () => {
  fetchMock.mockResolvedValueOnce(response(envelope("org-a", "opaque-v1")));
  render(setup());
  await screen.findByText("Managed by MogulForge");
  const fields = fill("org-a-server", "fixture-token");
  fireEvent.change(fields.reference, { target: { value: "different-server" } });
  expect(fields.token.value).toBe("");
  expect(fields.ownership.checked).toBe(false);
  expect(fields.dedicated.checked).toBe(false);
  expect(fields.save.disabled).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([
  ["target", "operator", "org-b"],
  ["actor", "another-operator", "org-a"],
])("ignores a pending save response after a %s switch", async (_kind, actorId, organizationId) => {
  let resolve!: (result: Response) => void;
  fetchMock.mockResolvedValueOnce(response(envelope("org-a", "opaque-v1")));
  fetchMock.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
  fetchMock.mockResolvedValueOnce(response(envelope(organizationId, null)));
  const view = render(setup());
  await screen.findByText("Managed by MogulForge");
  const oldForm = fill("org-a-server", "old-private-token");
  fireEvent.click(oldForm.save);
  expect(oldForm.token.value).toBe("");
  view.rerender(setup(actorId, organizationId));
  await screen.findByText("No connection assigned");
  const newForm = form();
  expect(newForm.token.value).toBe("");
  expect(newForm.monthlyLimit.value).toBe("1000");
  fill(organizationId + "-fresh", "new-private-token");
  await act(async () => resolve(response(envelope("org-a", "opaque-v2"))));
  expect(newForm.token.value).toBe("new-private-token");
  expect(newForm.reference.value).toBe(organizationId + "-fresh");
  expect(newForm.ownership.checked).toBe(true);
  expect(newForm.dedicated.checked).toBe(true);
  expect(screen.queryByText("Managed by MogulForge")).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("reads back after a wrong-organization save response and requires fresh confirmations", async () => {
  fetchMock.mockResolvedValueOnce(response(envelope("org-a", "opaque-v1")));
  fetchMock.mockResolvedValueOnce(response(envelope("org-b", "opaque-other")));
  fetchMock.mockResolvedValueOnce(response(envelope("org-a", "opaque-readback")));
  render(setup());
  await screen.findByText("Managed by MogulForge");
  fireEvent.click(fill("org-a-server", "fixture-token").save);
  await screen.findByText(/Could not confirm the update/);
  expect(fetchMock.mock.calls[2]?.[1]?.method).toBe("GET");
  expect(form().reference.value).toBe("org-a-server");
  expect(form().token.value).toBe("");
  expect(form().save.disabled).toBe(true);
  expect(screen.queryByText(/Connection saved/)).toBeNull();
});

it("confirms revocation for the selected company and uses the last read connection version", async () => {
  fetchMock.mockResolvedValueOnce(response(envelope("org-a", "opaque-v1")));
  fetchMock.mockResolvedValueOnce(response({ error: "fixture-secret-should-not-render" }, 409));
  fetchMock.mockResolvedValueOnce(response(envelope("org-a", "opaque-v2")));
  fetchMock.mockResolvedValueOnce(response(null, 204));
  fetchMock.mockResolvedValueOnce(response(envelope("org-a", "opaque-v3", false)));
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(setup());
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("First Company"));
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  await screen.findByText(/The connection changed or these details conflict/);
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE", body: JSON.stringify({ expectedConnectionFingerprint: "opaque-v1" }) });
  expect(document.body.textContent).not.toContain("fixture-secret-should-not-render");
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  await screen.findByText("Disconnected");
  expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ method: "DELETE", body: JSON.stringify({ expectedConnectionFingerprint: "opaque-v2" }) });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull());
});

it.each([
  ["missing ceiling", { monthlyActionLimit: undefined }, {}],
  ["null ceiling", { monthlyActionLimit: null }, {}],
  ["out-of-range ceiling", { monthlyActionLimit: 100001 }, { monthlyActionLimit: 100001 }],
  ["missing attempt count", { monthlyActionsUsed: undefined }, {}],
  ["malformed attempt count", { monthlyActionsUsed: 0.5 }, {}],
  ["negative attempt count", { monthlyActionsUsed: -1 }, {}],
  ["missing remaining count", { monthlyActionsRemaining: undefined }, {}],
  ["inconsistent remaining count", { monthlyActionsRemaining: 1 }, {}],
  ["inconsistent status ceiling", {}, { monthlyActionLimit: 1000 }],
])("blocks writes after a managed GET with %s until verified readback", async (_reason, usageOverride, statusOverride) => {
  const verified = envelope("org-a", "opaque-v1", true, 0);
  fetchMock.mockResolvedValueOnce(response({
    ...verified,
    status: { ...verified.status, ...statusOverride },
    usage: { ...verified.usage, ...usageOverride },
  }));
  fetchMock.mockResolvedValueOnce(response(verified));
  fetchMock.mockResolvedValueOnce(response(envelope("org-a", "opaque-v2", true, 0)));
  render(setup());
  await screen.findByText(/Could not verify the current connection/);
  expect(screen.queryByRole("button", { name: "Save connection" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh connection" }));
  await screen.findByText("Managed by MogulForge");
  const fields = fill("org-a-server", "fixture-rotation-token");
  expect(fields.monthlyLimit.value).toBe("0");
  fireEvent.click(fields.save);
  await screen.findByText(/Connection saved/);
  expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({ monthlyActionLimit: 0 });
});

it("requires verified readback after a managed PUT with a missing ceiling", async () => {
  const original = envelope("org-a", "opaque-v1", true, 0);
  const updated = envelope("org-a", "opaque-v2", true, 0);
  const malformed = { ...updated, usage: { ...updated.usage, monthlyActionLimit: undefined } };
  fetchMock.mockResolvedValueOnce(response(original));
  fetchMock.mockResolvedValueOnce(response(malformed));
  fetchMock.mockResolvedValueOnce(response(malformed));
  fetchMock.mockResolvedValueOnce(response(updated));
  render(setup());
  await screen.findByText("Managed by MogulForge");
  fireEvent.click(fill("org-a-server", "fixture-rotation-token").save);
  await screen.findByText(/Could not verify the current connection/);
  expect(fetchMock.mock.calls[2]?.[1]?.method).toBe("GET");
  expect(screen.queryByText(/Connection saved/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Save connection" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh connection" }));
  await screen.findByText("Managed by MogulForge");
  expect(form().monthlyLimit.value).toBe("0");
  expect(form().token.value).toBe("");
  expect(form().save.disabled).toBe(true);
});
