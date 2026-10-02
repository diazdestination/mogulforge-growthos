import { afterEach, describe, expect, it, vi } from "vitest";

import { billingReturnUrls } from "./billing";

afterEach(() => vi.unstubAllEnvs());

describe("billing provider return URLs", () => {
  it("uses the configured staging origin, not a request Host or forwarded host", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", "https://growthos-staging.example.test/");
    vi.stubEnv("APP_URL", "https://different.example.test");

    // The URL builder has no Request input by design: caller-controlled Host
    // and X-Forwarded-Host headers cannot influence the Stripe destination.
    expect(billingReturnUrls()).toEqual({
      successUrl:
        "https://growthos-staging.example.test/settings?billing=success",
      cancelUrl:
        "https://growthos-staging.example.test/settings?billing=cancel",
      portalUrl: "https://growthos-staging.example.test/settings",
    });
  });

  it("fails closed in production without a canonical origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("APP_URL", "");
    expect(() => billingReturnUrls()).toThrow("APP_ORIGIN is required");
  });

  it.each([
    "http://growthos.example.test",
    "javascript:alert(1)",
    "https://user:password@growthos.example.test",
    "https://growthos.example.test/?next=https://other.example.test",
    "https://growthos.example.test/#fragment",
    "not-a-url",
  ])("rejects unsafe production configuration %s", (configured) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", configured);
    expect(() => billingReturnUrls()).toThrow();
  });

  it("allows a loopback fallback only for local development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("APP_URL", "");
    expect(billingReturnUrls().portalUrl).toBe(
      "http://localhost:5000/settings",
    );
  });
});
