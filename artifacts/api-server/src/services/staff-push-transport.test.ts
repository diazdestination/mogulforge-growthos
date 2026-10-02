import { createECDH } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));
import { isPublicPushAddress, sendStaffPush, StaffPushDispatchBlockedError } from "./staff-push-transport";

const key = createECDH("prime256v1"); key.generateKeys();
const device = { endpoint: `https://web.push.apple.com/${"a".repeat(32)}`, keys: {
  p256dh: key.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url"),
} };
beforeEach(() => {
  vi.stubEnv("WEB_PUSH_ENABLED", "true"); vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubEnv("WEB_PUSH_VAPID_PUBLIC_KEY", key.getPublicKey().toString("base64url"));
  vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", key.getPrivateKey().toString("base64url"));
  vi.stubEnv("WEB_PUSH_VAPID_SUBJECT", "mailto:operator@example.invalid"); vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "a".repeat(64));
  mocks.lookup.mockReset().mockResolvedValue([{ address: "17.57.144.1", family: 4 }]);
  mocks.request.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("bounded push transport (all DNS and HTTPS mocked)", () => {
  it.each(["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "224.0.0.1",
    "0.0.0.0", "198.18.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1",
    "2001:db8::1", "2002:7f00:1::", "not-an-ip"])("rejects non-public address %s", (address) => {
    expect(isPublicPushAddress(address)).toBe(false);
  });
  it("does not accept mixed public/private DNS records or empty resolution", async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: "17.57.144.1", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    await expect(sendStaffPush(device, "generic alert", "staff-user")).rejects.toThrow("push_destination_unavailable");
    mocks.lookup.mockResolvedValueOnce([]);
    await expect(sendStaffPush(device, "generic alert", "staff-user")).rejects.toThrow("push_destination_unavailable");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("pins validated DNS, preserves TLS hostname, encrypts payload and refuses redirects", async () => {
    let sent: Buffer | undefined;
    mocks.request.mockImplementation((options, callback) => {
      const req = new EventEmitter() as EventEmitter & { end: (body: Buffer) => void };
      req.end = (body) => {
        sent = body;
        const response = new EventEmitter() as EventEmitter & { statusCode: number };
        response.statusCode = 302; callback(response);
        queueMicrotask(() => response.emit("end"));
      };
      return req;
    });
    expect(await sendStaffPush(device, "generic alert", "staff-user")).toBe(302);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls[0][0]).toMatchObject({ hostname: "17.57.144.1", servername: "web.push.apple.com", method: "POST",
      port: 443, agent: false, path: `/${"a".repeat(32)}`, headers: { Host: "web.push.apple.com", TTL: 60 } });
    expect(sent).toBeInstanceOf(Buffer); expect(sent!.toString()).not.toContain("generic alert");
  });
  it("bounds a stuck DNS lookup without starting an eventual late network request", async () => {
    vi.useFakeTimers();
    let resolveDns!: (value: unknown) => void;
    mocks.lookup.mockImplementation(() => new Promise((resolve) => { resolveDns = resolve; }));
    const send = sendStaffPush(device, "generic alert", "staff-user");
    const outcome = expect(send).rejects.toThrow("push_timeout");
    await vi.advanceTimersByTimeAsync(5_001); await outcome;
    resolveDns([{ address: "17.57.144.1", family: 4 }]);
    await Promise.resolve(); expect(mocks.request).not.toHaveBeenCalled();
  });
  it("bounds the whole request rather than just socket inactivity", async () => {
    vi.useFakeTimers();
    mocks.request.mockImplementation((options) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void }; req.end = () => {};
      options.signal.addEventListener("abort", () => req.emit("error", new Error("provider details must not escape")), { once: true });
      return req;
    });
    const send = sendStaffPush(device, "generic alert", "staff-user");
    const outcome = expect(send).rejects.toThrow("push_request_unavailable");
    await vi.advanceTimersByTimeAsync(5_001); await outcome;
  });
  it("rejects unsupported endpoints without DNS or HTTPS", async () => {
    await expect(sendStaffPush({ ...device, endpoint: "https://127.0.0.1/" }, "generic alert", "staff-user")).rejects.toThrow();
    expect(mocks.lookup).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
  });
  it("checks current business authorization after DNS and never sends a superseded alert", async () => {
    let authorized = true;
    mocks.lookup.mockImplementationOnce(async () => {
      authorized = false;
      return [{ address: "17.57.144.1", family: 4 }];
    });
    const guard = vi.fn(async () => authorized);
    await expect(sendStaffPush(device, "generic service alert", "staff-user", guard)).rejects.toThrow("push_authorization_changed_before_dispatch");
    expect(guard).toHaveBeenCalledOnce();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each(["resolve", "reject"] as const)("bounds a stuck final authorization within the original deadline and safely consumes its late %s", async (lateOutcome) => {
    vi.useFakeTimers();
    let resolveDns!: (value: unknown) => void;
    let finishGuard!: () => void;
    mocks.lookup.mockImplementationOnce(() => new Promise(resolve => { resolveDns = resolve; }));
    const guard = vi.fn(() => new Promise<boolean>((resolve, reject) => {
      finishGuard = () => lateOutcome === "resolve" ? resolve(true) : reject(new Error("late private authorization failure"));
    }));
    let settled = false, error: unknown;
    const completion = sendStaffPush(device, "generic service alert", "staff-user", guard).then(
      () => { settled = true; },
      failure => { settled = true; error = failure; },
    );
    try {
      await vi.advanceTimersByTimeAsync(4_000);
      resolveDns([{ address: "17.57.144.1", family: 4 }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(guard).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(error).toBeInstanceOf(StaffPushDispatchBlockedError);
      expect(mocks.request).not.toHaveBeenCalled();
    } finally {
      finishGuard();
      await completion;
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("rechecks the global hold after an asynchronous business guard", async () => {
    await expect(sendStaffPush(device, "generic service alert", "staff-user", async () => {
      vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true"); return true;
    })).rejects.toThrow("push_authorization_changed_before_dispatch");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("enforces the kill switch at the actual transport, including a change during DNS", async () => {
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
    await expect(sendStaffPush(device, "generic alert", "staff-user")).rejects.toThrow("push_configuration_unavailable");
    expect(mocks.lookup).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
    mocks.lookup.mockImplementationOnce(async () => {
      vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true"); return [{ address: "17.57.144.1", family: 4 }];
    });
    await expect(sendStaffPush(device, "generic alert", "staff-user")).rejects.toThrow("push_destination_unavailable");
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
