import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as providers from "./providers";
import {
  adaptiveEmailProvider,
  gmailEmailProvider,
  isSafeMailbox,
  transactionalEmailProvider,
} from "./providers";

describe("isSafeMailbox", () => {
  it("accepts plain mailboxes", () => {
    expect(isSafeMailbox("homeowner@example.com")).toBe(true);
    expect(isSafeMailbox("first.last+tag@sub.domain.co")).toBe(true);
  });

  it("rejects CRLF header-injection payloads", () => {
    expect(isSafeMailbox("victim@example.com\r\nBcc: evil@evil.com")).toBe(
      false,
    );
    expect(isSafeMailbox("victim@example.com\nX-Injected: 1")).toBe(false);
  });

  it("rejects multiple recipients, display names, and whitespace", () => {
    expect(isSafeMailbox("a@example.com,b@example.com")).toBe(false);
    expect(isSafeMailbox("Evil <a@example.com>")).toBe(false);
    expect(isSafeMailbox(" a@example.com")).toBe(false);
    expect(isSafeMailbox("not-an-email")).toBe(false);
    expect(isSafeMailbox("")).toBe(false);
  });
});

describe("gmailEmailProvider", () => {
  it("refuses to send to an unsafe recipient before touching the network", async () => {
    await expect(
      gmailEmailProvider.send(
        "victim@example.com\r\nBcc: evil@evil.com",
        "s",
        "b",
      ),
    ).rejects.toThrow(/invalid recipient/i);
  });
});

describe("adaptiveEmailProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("uses the explicit mock provider when no real email provider is configured", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("RESEND_FROM_EMAIL", "");
    // An unbound Gmail connector is not a configured provider and therefore
    // must not turn local/self-hosted development into an email outage.
    vi.spyOn(providers.gmailEmailProvider, "send").mockRejectedValue(
      new Error("connector not bound"),
    );
    const result = await adaptiveEmailProvider.send(
      "user@example.com",
      "Subject",
      "Body",
    );
    expect(result.provider).toBe("mock-email");
  });

  it("fails closed in production when no real provider is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("RESEND_FROM_EMAIL", "");
    vi.stubEnv("REPLIT_CONNECTORS_HOSTNAME", "");
    vi.stubEnv("REPL_IDENTITY", "");
    vi.stubEnv("WEB_REPL_RENEWAL", "");

    await expect(
      adaptiveEmailProvider.send("user@example.com", "Subject", "Body"),
    ).rejects.toThrow(/not configured/i);
  });

  it("falls back to Resend when Gmail fails and Resend succeeds", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-resend-key");
    vi.stubEnv("RESEND_FROM_EMAIL", "MogulForge <account@mogulforge.ai>");
    vi.stubEnv("REPLIT_CONNECTORS_HOSTNAME", "connector.example.com");
    vi.stubEnv("REPL_IDENTITY", "test-identity");
    vi.spyOn(providers.gmailEmailProvider, "send").mockRejectedValue(
      new Error("gmail down"),
    );
    vi.spyOn(providers.resendEmailProvider, "send").mockResolvedValue({
      id: "resend-123",
      provider: "resend",
    });
    const result = await adaptiveEmailProvider.send(
      "user@example.com",
      "Subject",
      "Body",
    );
    expect(result.provider).toBe("resend");
  });

  it("isSafeMailbox blocks header-injection before touching the network", () => {
    expect(isSafeMailbox("ok@example.com")).toBe(true);
    expect(isSafeMailbox("bad\r\nX-Header: injected@example.com")).toBe(false);
  });
});

describe("transactionalEmailProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("fails closed in production without a dedicated Resend sender", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("RESEND_FROM_EMAIL", "");
    vi.stubEnv("REPLIT_CONNECTORS_HOSTNAME", "connector.example.com");
    vi.stubEnv("REPL_IDENTITY", "customer-gmail");

    await expect(
      transactionalEmailProvider.send("user@example.com", "Subject", "Body"),
    ).rejects.toThrow(/transactional email is not configured/i);
  });

  it("uses the platform Resend channel and never a connected Gmail account", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "test-resend-key");
    vi.stubEnv("RESEND_FROM_EMAIL", "MogulForge <account@mogulforge.ai>");
    vi.stubEnv("REPLIT_CONNECTORS_HOSTNAME", "connector.example.com");
    vi.stubEnv("REPL_IDENTITY", "customer-gmail");
    const gmailSend = vi.spyOn(providers.gmailEmailProvider, "send");
    vi.spyOn(providers.resendEmailProvider, "send").mockResolvedValue({
      id: "resend-identity-123",
      provider: "resend",
    });

    const result = await transactionalEmailProvider.send(
      "user@example.com",
      "Subject",
      "Body",
    );
    expect(result.provider).toBe("resend");
    expect(gmailSend).not.toHaveBeenCalled();
  });
});
