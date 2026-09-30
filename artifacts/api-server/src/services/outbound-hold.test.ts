import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendGmailForUser } from "./gmail-oauth";
import { outboundDeliveryHeld } from "./outbound-hold";
import {
  adaptiveEmailProvider,
  gmailEmailProvider,
  providers,
  resendEmailProvider,
  transactionalEmailProvider,
} from "./providers";
import { sendTwilioSms } from "./twilio-delivery";
import { attemptDelivery, processPendingDeliveries } from "./webhooks";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("staging outbound delivery hold", () => {
  it("defaults to existing production behavior and rejects ambiguous settings", () => {
    expect(outboundDeliveryHeld(undefined, {})).toBe(false);
    expect(outboundDeliveryHeld("false", {})).toBe(false);
    expect(outboundDeliveryHeld("true", {})).toBe(true);
    for (const invalid of ["", "TRUE", "0", "off"])
      expect(() => outboundDeliveryHeld(invalid, {})).toThrow(
        "GROWTHOS_OUTBOUND_HOLD",
      );
  });

  it("fails closed for staging even if the hold flag is absent or false", () => {
    const staging = { FLY_APP_NAME: "mogulforge-growthos-staging" };
    expect(outboundDeliveryHeld(undefined, staging)).toBe(true);
    expect(outboundDeliveryHeld("false", staging)).toBe(true);
    expect(outboundDeliveryHeld("false", {
      ...staging,
      STAGING_OUTBOUND_APPROVED: "true",
    })).toBe(false);
  });

  it("blocks email, SMS, Gmail, and webhook dispatch before any network call", async () => {
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        throw new Error("Unexpected network request during hold test");
      });
    const blocked = /staging safety hold/;

    await expect(
      resendEmailProvider.send("qa@example.test", "subject", "body"),
    ).rejects.toThrow(blocked);
    await expect(
      gmailEmailProvider.send("qa@example.test", "subject", "body"),
    ).rejects.toThrow(blocked);
    await expect(
      transactionalEmailProvider.send("qa@example.test", "subject", "body"),
    ).rejects.toThrow(blocked);
    await expect(
      adaptiveEmailProvider.send("qa@example.test", "subject", "body"),
    ).rejects.toThrow(blocked);
    await expect(providers.sms.send("+12025550100", "hello")).rejects.toThrow(
      blocked,
    );
    await expect(sendTwilioSms("+12025550100", "hello")).rejects.toThrow(
      blocked,
    );
    await expect(
      sendGmailForUser({
        organizationId: randomUUID(),
        userId: randomUUID(),
        to: "qa@example.test",
        subject: "subject",
        body: "body",
      }),
    ).rejects.toThrow(blocked);
    await expect(attemptDelivery(randomUUID())).resolves.toBeUndefined();
    await expect(processPendingDeliveries()).resolves.toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
