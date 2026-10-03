import { afterEach, describe, expect, it, vi } from "vitest";

import {
  identityActionUrl,
  sendEmailVerification,
  sendPasswordReset,
} from "./identity-email";
import * as ledger from "./platform-email-delivery";
import { randomUUID } from "node:crypto";
import { reportIdentityEmailFailure } from "./identity-email";
import { logger } from "../lib/logger";
const receipt = () => ({ dispatchId: randomUUID(), outcome: "accepted" as const, outcomeCode: "provider_accepted", providerMessageId: randomUUID(), duplicate: false });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("identity email", () => {
  it("builds HTTPS action links from APP_ORIGIN without leaking tokens elsewhere", () => {
    vi.stubEnv("APP_ORIGIN", "https://app.mogulforge.ai/");
    const url = new URL(identityActionUrl("/verify-email", "opaque-secret"));
    expect(url.origin).toBe("https://app.mogulforge.ai");
    expect(url.pathname).toBe("/verify-email");
    expect(url.searchParams.get("token")).toBe("opaque-secret");
  });

  it("sends verification through the platform transactional channel", async () => {
    vi.stubEnv("APP_ORIGIN", "https://app.mogulforge.ai");
    const send = vi
      .spyOn(ledger, "sendPlatformIdentityEmail")
      .mockResolvedValue(receipt());

    await sendEmailVerification({
      to: "member@example.com",
      token: "verification-secret",
      tokenRecordId: randomUUID(),
      firstName: "Ray",
    });

    expect(send).toHaveBeenCalledOnce();
    const { to, subject, body } = send.mock.calls[0][0];
    expect(to).toBe("member@example.com");
    expect(subject).toMatch(/verify/i);
    expect(body).toContain("Hi Ray,");
    expect(body).toContain(
      "https://app.mogulforge.ai/verify-email?token=verification-secret",
    );
    expect(body).toContain("expires in 24 hours");
  });

  it("sends reset links with the 60-minute single-use warning", async () => {
    vi.stubEnv("APP_ORIGIN", "https://app.mogulforge.ai");
    const send = vi
      .spyOn(ledger, "sendPlatformIdentityEmail")
      .mockResolvedValue(receipt());

    await sendPasswordReset({
      to: "member@example.com",
      token: "reset-secret",
      tokenRecordId: randomUUID(),
    });

    const body = send.mock.calls[0][0].body;
    expect(body).toContain(
      "https://app.mogulforge.ai/reset-password?token=reset-secret",
    );
    expect(body).toContain("expires in 60 minutes");
    expect(body).toContain("single-use");
  });

  it("rejects unsafe recipients before calling a provider", async () => {
    const send = vi.spyOn(ledger, "sendPlatformIdentityEmail");
    await expect(
      sendPasswordReset({
        to: "victim@example.com\r\nBcc: attacker@example.com",
        token: "reset-secret",
        tokenRecordId: randomUUID(),
      }),
    ).rejects.toThrow(/invalid mailbox/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("never logs a raw provider error name, body, token or action link", () => {
    const log = vi.spyOn(logger, "error").mockImplementation(() => {});
    const error = new Error("token=private-reset-token");
    error.name = "https://private.example/reset?token=private-reset-token";
    reportIdentityEmailFailure("password_reset", error);
    expect(log).toHaveBeenCalledWith({ purpose: "password_reset", errorCode: "identity_delivery_unconfirmed" }, expect.any(String));
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-reset-token");
  });
});
