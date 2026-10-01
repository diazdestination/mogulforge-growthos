import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("./gmail-connection-card", () => ({
  GmailConnectionCard: () => <div>Existing Gmail connection</div>,
}));
import { EmailConnectionsCard } from "./email-connections-card";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
const status = () => ({
  provider: null as "gmail" | "microsoft" | null,
  connected: false,
  reason: "Choose your sending account.",
  gmail: { configured: true, connected: true, email: "gmail@example.invalid" },
  microsoft: {
    configured: true,
    connected: true,
    email: "outlook@example.invalid",
  },
});
const mailbox = () => ({
  configured: true,
  connected: true,
  email: "outlook@example.invalid",
  lastErrorAt: null,
  lastErrorCode: null,
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/account");
});

it("requires explicit sender selection and sends only that provider choice", async () => {
  const sender = status();
  const requests = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/microsoft")) return json(mailbox());
    if (init?.method === "PUT") {
      expect(JSON.parse(String(init.body))).toEqual({ provider: "microsoft" });
      sender.provider = "microsoft";
      sender.connected = true;
    }
    return json(sender);
  });
  vi.stubGlobal("fetch", requests);
  render(<EmailConnectionsCard callbackState={null} returnPath="/account" />);
  await screen.findByText("Choose your sending account.");
  expect(
    screen
      .getByRole("button", { name: "Save sending account" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Send your customer emails with"), {
    target: { value: "microsoft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save sending account" }));
  await waitFor(() =>
    expect(requests.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(
      true,
    ),
  );
  await screen.findByText(/Selected account is connected/);
  expect(
    screen.getByText(/Yahoo and other unconnected providers/),
  ).toBeTruthy();
});

it("disconnects locally, preserves Microsoft selection, and explains remote consent and uncertain sends", async () => {
  const sender = status();
  sender.provider = "microsoft";
  sender.connected = true;
  const connected = mailbox();
  const requests = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      connected.connected = false;
      sender.connected = false;
      sender.microsoft.connected = false;
      sender.reason =
        "Reconnect the selected Microsoft account; no other mailbox will be used.";
      return json({ disconnected: true, remoteConsentRevoked: false });
    }
    return json(String(url).endsWith("/microsoft") ? connected : sender);
  });
  vi.stubGlobal("fetch", requests);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<EmailConnectionsCard callbackState={null} returnPath="/account" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Disconnect Microsoft locally" }),
  );
  await screen.findByText(/Reconnect the selected Microsoft account/);
  expect(
    (
      screen.getByLabelText(
        "Send your customer emails with",
      ) as HTMLSelectElement
    ).value,
  ).toBe("microsoft");
  expect(screen.getByText(/does not revoke Microsoft consent/)).toBeTruthy();
  expect(requests.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(
    false,
  );
});

it("does not treat a callback hint as proof of connection and disables unconfigured authorization", async () => {
  window.history.replaceState({}, "", "/account?microsoft=connected");
  const sender = status();
  sender.microsoft.connected = false;
  sender.microsoft.configured = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) =>
      json(
        String(url).endsWith("/microsoft")
          ? { ...mailbox(), configured: false, connected: false, email: null }
          : sender,
      ),
    ),
  );
  render(<EmailConnectionsCard callbackState={null} returnPath="/account" />);
  await screen.findByText(/must configure Microsoft OAuth/);
  expect(
    screen
      .getByRole("button", { name: "Connect Microsoft" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.queryByText("Connected: outlook@example.invalid")).toBeNull();
});

it("shows status-load errors rather than enabling an unverified sender", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 503 })),
  );
  render(<EmailConnectionsCard callbackState={null} returnPath="/account" />);
  await screen.findByRole("alert");
  expect(
    screen
      .getByRole("button", { name: "Save sending account" })
      .hasAttribute("disabled"),
  ).toBe(true);
});

it("fails closed on an unexpected sender response without crashing account settings", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ connected: true })),
  );
  render(<EmailConnectionsCard callbackState={null} returnPath="/account" />);
  await screen.findByRole("alert");
  expect(
    screen
      .getByRole("button", { name: "Save sending account" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByText("Existing Gmail connection")).toBeTruthy();
});
