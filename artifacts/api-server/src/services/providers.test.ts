import { afterEach, describe, expect, it, vi } from "vitest";
import * as providers from "./providers";
import {
  isSafeMailbox,
  transactionalEmailProvider,
  resendEmailProvider,
} from "./providers";

describe("isSafeMailbox", () => {
  it("accepts plain mailboxes", () => {
    expect(isSafeMailbox("homeowner@example.com")).toBe(true);
    expect(isSafeMailbox("first.last+tag@sub.domain.co")).toBe(true);
  });
  it("rejects header injection, multiple recipients, and display names", () => {
    for (const value of [
      "victim@example.com\r\nBcc: evil@evil.com",
      "a@example.com,b@example.com",
      "Evil <a@example.com>",
      " a@example.com",
      "not-an-email",
      "",
    ]) {
      expect(isSafeMailbox(value)).toBe(false);
    }
  });
});

describe("platform transactional email", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  it("rejects recipient injection before touching the provider", async () => {
    await expect(
      resendEmailProvider.send(
        "victim@example.com\r\nBcc: evil@evil.com",
        "Subject",
        "Body",
      ),
    ).rejects.toThrow(/invalid recipient/i);
  });
  it("fails closed without Resend even when a global Gmail connector exists", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("RESEND_FROM_EMAIL", "");
    vi.stubEnv("REPLIT_CONNECTORS_HOSTNAME", "connector.example.com");
    vi.stubEnv("REPL_IDENTITY", "customer-gmail");
    await expect(
      transactionalEmailProvider.send("user@example.com", "Subject", "Body"),
    ).rejects.toThrow(/transactional email is not configured/i);
  });
  it("uses the platform Resend channel without invoking customer routing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "test-resend-key");
    vi.stubEnv("RESEND_FROM_EMAIL", "MogulForge <account@mogulforge.ai>");
    const customerSend = vi.spyOn(providers.customerEmailProvider, "send");
    vi.spyOn(providers.resendEmailProvider, "send").mockResolvedValue({
      id: "resend-identity-123",
      provider: "resend",
    });
    const result = await transactionalEmailProvider.send(
      "user@example.com",
      "Subject",
      "Body",
    );
    expect(result).toEqual({ id: "resend-identity-123", provider: "resend" });
    expect(customerSend).not.toHaveBeenCalled();
  });
});
