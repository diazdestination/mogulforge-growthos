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
