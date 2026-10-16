import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postSmsOnce, SmsCarrierUnsupportedError, type SmsCarrierAttempt, type TwilioSmsCarrierIdentity } from "./sms-carrier-transport";

const holdTrace = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock("./outbound-hold", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./outbound-hold")>();
  return { ...actual, assertOutboundDeliveryAllowed: (...args: Parameters<typeof actual.assertOutboundDeliveryAllowed>) => {
    holdTrace.events.push("hold");
    return actual.assertOutboundDeliveryAllowed(...args);
  } };
});

function twilioIdentity(overrides: Partial<TwilioSmsCarrierIdentity> = {}): TwilioSmsCarrierIdentity {
  return { accountSid: `AC${"a".repeat(32)}`, apiKeySid: `SK${"b".repeat(32)}`, apiKeySecret: "test", messagingServiceSid: `MG${"c".repeat(32)}`, to: "+15555550101", message: "A + & % ✓", callbackUrl: "https://example.invalid/status?operation=fixture", ...overrides };
}
const fetchMock = vi.fn<typeof fetch>();
const attempt = (overrides: Partial<TwilioSmsCarrierIdentity> = {}): SmsCarrierAttempt => ({ provider: "twilio", current: vi.fn(async () => twilioIdentity(overrides)), onDispatch: vi.fn() });

beforeEach(() => {
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  vi.stubEnv("FLY_APP_NAME", "test");
  vi.stubEnv("APP_ORIGIN", "https://example.invalid");
  vi.stubEnv("STAGING_OUTBOUND_APPROVED", undefined);
  holdTrace.events.length = 0;
  fetchMock.mockReset().mockImplementation(async () => { throw new Error("Unexpected external request"); });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("one-attempt SMS carrier boundary", () => {
  it.each([201, 429, 503])("returns the exact unconsumed HTTP %i response", async (status) => {
    const response = new Response('{"fixture":true}', { status });
    const readers = [vi.spyOn(response, "json"), vi.spyOn(response, "text"), vi.spyOn(response, "clone")];
    fetchMock.mockResolvedValueOnce(response);
    const input = attempt();
    expect(await postSmsOnce(input)).toBe(response);
    expect(response.bodyUsed).toBe(false);
    for (const reader of readers) expect(reader).not.toHaveBeenCalled();
    if (input.provider === "twilio") { expect(input.current).toHaveBeenCalledTimes(1); expect(input.onDispatch).toHaveBeenCalledTimes(1); }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["telnyx", "unknown-carrier-with-private-data"])("refuses %s before touching resolver or marker getters", async (provider) => {
    const current = vi.fn(() => { throw new Error("must not read secrets"); });
    const onDispatch = vi.fn();
    const input = { provider, get current() { current(); return current; }, get onDispatch() { onDispatch(); return onDispatch; } } as unknown as SmsCarrierAttempt;
    const error = await postSmsOnce(input).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(SmsCarrierUnsupportedError);
    expect(error).toMatchObject({ code: "sms_carrier_unsupported", message: "SMS carrier is unsupported" });
    expect(String(error)).not.toContain(provider);
    expect(error).not.toHaveProperty("cause");
    expect(current).not.toHaveBeenCalled(); expect(onDispatch).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, "+15555550202"])("preserves exact form encoding and optional sender %s", async (from) => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));
    await postSmsOnce(attempt({ from }));
    expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/AC${"a".repeat(32)}/Messages.json`);
    expect(init).toMatchObject({ method: "POST", redirect: "error", signal });
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Buffer.from(headers.get("authorization")!.slice(6), "base64").toString()).toBe(`SK${"b".repeat(32)}:test`);
    expect(headers.get("authorization")!.startsWith("Basic ")).toBe(true);
    expect(init?.body).toBe(`To=%2B15555550101&MessagingServiceSid=MG${"c".repeat(32)}${from ? "&From=%2B15555550202" : ""}&Body=A+%2B+%26+%25+%E2%9C%93&StatusCallback=https%3A%2F%2Fexample.invalid%2Fstatus%3Foperation%3Dfixture`);
  });

  it("resolver_then_final_hold_then_sync_marker_then_fetch without a microtask gap", async () => {
    fetchMock.mockImplementationOnce(async () => { holdTrace.events.push("fetch"); return new Response(null, { status: 201 }); });
    await postSmsOnce({ provider: "twilio", current: async () => { holdTrace.events.push("resolver"); return twilioIdentity(); }, onDispatch: () => { holdTrace.events.push("marker"); queueMicrotask(() => holdTrace.events.push("microtask")); } });
    expect(holdTrace.events).toEqual(["resolver", "hold", "marker", "fetch", "microtask"]);
  });

  it("honors a hold raised by the current-identity resolver", async () => {
    const onDispatch = vi.fn();
    await expect(postSmsOnce({ provider: "twilio", current: async () => { vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true"); return twilioIdentity(); }, onDispatch })).rejects.toThrow("staging safety hold");
    expect(onDispatch).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, "false"])("refuses an unapproved staging hold value %s", async (hold) => {
    vi.stubEnv("FLY_APP_NAME", "mogulforge-growthos-staging");
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", hold);
    const input = attempt();
    await expect(postSmsOnce(input)).rejects.toThrow("staging safety hold");
    if (input.provider === "twilio") expect(input.onDispatch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  for (const stage of ["resolver", "marker", "fetch"] as const) {
    it.each([new Error("synthetic original failure"), 0, null, undefined])(`preserves ${stage} rejection identity %s without retry`, async (value) => {
      const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
      const current = vi.fn(async () => { if (stage === "resolver") throw value; return twilioIdentity(); });
      const onDispatch = vi.fn(() => { if (stage === "marker") throw value; });
      if (stage === "fetch") fetchMock.mockRejectedValueOnce(value);
      await expect(postSmsOnce({ provider: "twilio", current, onDispatch })).rejects.toBe(value);
      expect(current).toHaveBeenCalledTimes(1);
      expect(onDispatch).toHaveBeenCalledTimes(stage === "resolver" ? 0 : 1);
      expect(fetchMock).toHaveBeenCalledTimes(stage === "fetch" ? 1 : 0);
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    });
  }
});
