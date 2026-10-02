import { afterEach, describe, expect, it, vi } from "vitest";

import { oidcAppOrigin, oidcCallbackUrl } from "./auth";

afterEach(() => vi.unstubAllEnvs());

describe("OIDC redirect origin", () => {
  it("keeps a provider callback on the configured origin even with an absolute request URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", "https://growthos-staging.example.test/");
    expect(
      oidcCallbackUrl(
        "https://spoofed.example.test/api/callback?code=abc&state=xyz",
      ).href,
    ).toBe(
      "https://growthos-staging.example.test/api/callback?code=abc&state=xyz",
    );
  });

  it("uses the configured app URL or Replit domain for existing deployment styles", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("APP_URL", "https://app.example.test/crm/");
    expect(oidcAppOrigin()).toBe("https://app.example.test");
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("REPLIT_DOMAINS", "demo.replit.app,secondary.replit.app");
    expect(oidcCallbackUrl().href).toBe("https://demo.replit.app/api/callback");
  });

  it("fails closed when production has no trusted origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("REPLIT_DOMAINS", "");
    expect(() => oidcAppOrigin()).toThrow("APP_ORIGIN is required");
  });

  it.each([
    "http://growthos.example.test",
    "javascript:alert(1)",
    "https://user:password@growthos.example.test",
    "https://growthos.example.test/?redirect=https://other.example.test",
    "https://growthos.example.test/#fragment",
    "not-a-url",
  ])("rejects an unsafe production origin %s", (configured) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", configured);
    expect(() => oidcAppOrigin()).toThrow();
  });

  it("rejects malformed Replit domain fallback", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("REPLIT_DOMAINS", "demo.replit.app/redirect");
    expect(() => oidcAppOrigin()).toThrow("OIDC app origin is invalid");
  });

  it("keeps a local-only fallback for development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("REPLIT_DOMAINS", "");
    expect(oidcCallbackUrl("/api/callback?code=local").href).toBe(
      "http://localhost:5000/api/callback?code=local",
    );
  });
});
