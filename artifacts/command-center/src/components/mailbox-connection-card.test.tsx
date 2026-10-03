import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MailboxConnectionCard } from "./mailbox-connection-card";
const status = (extra = {}) => ({
  enabled: true,
  configured: true,
  version: 0,
  state: "disabled",
  usable: false,
  mailboxEmail: null,
  startedAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  reason: null,
  pendingParentCount: 0,
  reviewCount: 0,
  leadMonitoringEnabled: false,
  leadMonitoringVersion: 0,
  leadMonitoringApprovedAt: null,
  leadMonitoringChangedAt: null,
  ...extra,
});
const json = (value: unknown, code = 200) =>
  new Response(JSON.stringify(value), { status: code });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("requires both read and retention approvals and sends only the frozen versioned opt-in", async () => {
  const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST" ? json({}, 409) : json(status()),
  );
  vi.stubGlobal("fetch", request);
  render(<MailboxConnectionCard returnPath="/account" />);
  const button = await screen.findByRole("button", {
    name: "Review Microsoft read permission",
  });
  expect(button.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByLabelText(/I authorize read-only/));
  expect(button.hasAttribute("disabled")).toBe(true);
  fireEvent.click(
    screen.getByLabelText(/I reviewed the company's inbound retention/),
  );
  fireEvent.click(button);
  await screen.findByText(/The change was not confirmed/);
  const post = request.mock.calls.find(([, init]) => init?.method === "POST");
  expect(JSON.parse(String(post?.[1]?.body))).toEqual({
    expectedVersion: 0,
    readAcknowledged: true,
    retentionAcknowledged: true,
    returnPath: "/account",
  });
  expect(screen.getByText(/No Mail.ReadWrite/)).toBeTruthy();
});
it("shows global hold, pending evidence and historical gap without claiming coverage", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json(
        status({
          enabled: false,
          state: "gap",
          version: 2,
          reason: "mailbox_cursor_gap",
          reviewCount: 1,
          pendingParentCount: 2,
        }),
      ),
    ),
  );
  render(<MailboxConnectionCard returnPath="/settings" />);
  await screen.findByText(/Platform mailbox reading is disabled/);
  expect(screen.getByText(/cannot recover or silently skip/)).toBeTruthy();
  expect(
    screen.getByText(/2 replies await exact parent observation/),
  ).toBeTruthy();
  expect(
    (
      screen.getByLabelText(/I authorize read-only/) as HTMLInputElement
    ).closest("fieldset")?.disabled,
  ).toBe(true);
});
it("disables locally with exact version even when global read is held, preserving evidence", async () => {
  let current = status({ enabled: false, version: 4, state: "active" });
  const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      current = status({ enabled: false, version: 5 });
      return json({ disabled: true, remoteConsentRevoked: false });
    }
    return json(current);
  });
  vi.stubGlobal("fetch", request);
  render(<MailboxConnectionCard returnPath="/account" />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Disable reply monitoring locally",
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", {
        name: "Disable reply monitoring locally",
      }),
    ).toBeNull(),
  );
  expect(
    JSON.parse(
      String(
        request.mock.calls.find(([, init]) => init?.method === "POST")?.[1]
          ?.body,
      ),
    ),
  ).toEqual({ expectedVersion: 4, confirmed: true });
  expect(
    screen.getByText(/Revoke remote consent in Microsoft separately/),
  ).toBeTruthy();
});
it("fails closed on invalid status and refuses an arbitrary authorization URL", async () => {
  const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST"
      ? json({ authorizationUrl: "https://foreign.invalid/login" })
      : json(status()),
  );
  vi.stubGlobal("fetch", request);
  render(<MailboxConnectionCard returnPath="/account" />);
  await screen.findByRole("button", {
    name: "Review Microsoft read permission",
  });
  fireEvent.click(screen.getByLabelText(/I authorize read-only/));
  fireEvent.click(
    screen.getByLabelText(/I reviewed the company's inbound retention/),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Review Microsoft read permission" }),
  );
  await screen.findByText(/The change was not confirmed/);
  request.mockImplementation(async () => json({ state: "active" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh reply-monitoring status" }),
  );
  await screen.findByText(/Reply-monitoring status could not be loaded/);
  expect(
    screen.queryByRole("button", { name: "Review Microsoft read permission" }),
  ).toBeNull();
});
it("requires separate tracked-lead acknowledgement and freezes both current versions", async () => {
  const before = status({
    state: "active",
    usable: true,
    version: 4,
    mailboxEmail: "staff@example.invalid",
    leadMonitoringVersion: 2,
  });
  const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST"
      ? json({
          ...before,
          leadMonitoringEnabled: true,
          leadMonitoringVersion: 3,
          leadMonitoringApprovedAt: "2026-10-02T12:00:00Z",
          leadMonitoringChangedAt: "2026-10-02T12:00:00Z",
        })
      : json(before),
  );
  vi.stubGlobal("fetch", request);
  render(<MailboxConnectionCard returnPath="/account" />);
  const enable = await screen.findByRole("button", {
    name: "Enable tracked lead replies",
  });
  expect(enable.hasAttribute("disabled")).toBe(true);
  fireEvent.click(
    screen.getByLabelText(/I explicitly approve tracked BIE lead replies/),
  );
  fireEvent.click(enable);
  await screen.findByText(/Lead context approved at version 3/);
  const post = request.mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(post[0]).toBe("/api/v1/mailbox/microsoft/lead-monitoring");
  expect(JSON.parse(String(post[1]?.body))).toEqual({
    expectedConnectorVersion: 4,
    expectedLeadMonitoringVersion: 2,
    enabled: true,
    leadContextAcknowledged: true,
  });
  expect(screen.getByText(/adds no Microsoft scope/)).toBeTruthy();
});
it("permits local lead revoke while global reading is held without reconnecting the sender", async () => {
  const before = status({
    enabled: false,
    state: "active",
    version: 5,
    leadMonitoringEnabled: true,
    leadMonitoringVersion: 7,
  });
  const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    json(
      init?.method === "POST"
        ? { ...before, leadMonitoringEnabled: false, leadMonitoringVersion: 8 }
        : before,
    ),
  );
  vi.stubGlobal("fetch", request);
  render(<MailboxConnectionCard returnPath="/settings" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Stop tracked lead replies" }),
  );
  await screen.findByText(/Lead context is off/);
  expect(
    JSON.parse(
      String(
        request.mock.calls.find(([, init]) => init?.method === "POST")?.[1]
          ?.body,
      ),
    ),
  ).toEqual({
    expectedConnectorVersion: 5,
    expectedLeadMonitoringVersion: 7,
    enabled: false,
    leadContextAcknowledged: true,
  });
  expect(
    screen
      .getByRole("button", { name: "Enable tracked lead replies" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
it("requires explicit refresh and renewed acknowledgement after a stale approval", async () => {
  let version = 1;
  const request = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST"
      ? json({}, 409)
      : json(
          status({
            state: "active",
            usable: true,
            version,
            mailboxEmail: "staff@example.invalid",
          }),
        ),
  );
  vi.stubGlobal("fetch", request);
  render(<MailboxConnectionCard returnPath="/account" />);
  await screen.findByRole("button", { name: "Enable tracked lead replies" });
  fireEvent.click(screen.getByLabelText(/I explicitly approve/));
  fireEvent.click(
    screen.getByRole("button", { name: "Enable tracked lead replies" }),
  );
  await screen.findByText(/approval was not confirmed or its version changed/);
  expect(
    screen
      .getByRole("button", { name: "Enable tracked lead replies" })
      .hasAttribute("disabled"),
  ).toBe(true);
  version = 2;
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh reply-monitoring status" }),
  );
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(
    (screen.getByLabelText(/I explicitly approve/) as HTMLInputElement).checked,
  ).toBe(false);
  expect(
    request.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(1);
});
