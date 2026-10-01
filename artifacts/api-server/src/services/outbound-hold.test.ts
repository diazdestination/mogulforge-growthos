import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendGmailForUser } from "./gmail-oauth";
import {
  assertOutboundDeliveryAllowed,
  assertStagingEmailRecipientAllowed,
  outboundDeliveryHeld,
} from "./outbound-hold";
import {
  customerEmailProvider,
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
    expect(
      outboundDeliveryHeld("false", {
        ...staging,
        STAGING_OUTBOUND_APPROVED: "true",
      }),
    ).toBe(false);
    expect(
      outboundDeliveryHeld(undefined, {
        ...staging,
        STAGING_OUTBOUND_APPROVED: "true",
      }),
    ).toBe(true);
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
      transactionalEmailProvider.send("qa@example.test", "subject", "body"),
    ).rejects.toThrow(blocked);
    await expect(
      customerEmailProvider.send("qa@example.test", "subject", "body", {
        organizationId: randomUUID(),
      }),
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

  it("requires an exact approved email address in addition to both staging release flags", () => {
    vi.stubEnv("FLY_APP_NAME", "mogulforge-growthos-staging");
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
    vi.stubEnv("STAGING_OUTBOUND_APPROVED", "true");
    vi.stubEnv("STAGING_EMAIL_RECIPIENT_ALLOWLIST", "");
    expect(() =>
      assertOutboundDeliveryAllowed({
        channel: "email",
        recipient: "qa@example.test",
      }),
    ).toThrow("STAGING_EMAIL_RECIPIENT_ALLOWLIST");
    vi.stubEnv(
      "STAGING_EMAIL_RECIPIENT_ALLOWLIST",
      "qa@example.test,owner@example.test",
    );
    expect(() =>
      assertOutboundDeliveryAllowed({
        channel: "email",
        recipient: "QA@example.test",
      }),
    ).not.toThrow();
    expect(() =>
      assertOutboundDeliveryAllowed({
        channel: "email",
        recipient: "client@example.test",
      }),
    ).toThrow("not approved");
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
    expect(() =>
      assertOutboundDeliveryAllowed({
        channel: "email",
        recipient: "qa@example.test",
      }),
    ).toThrow("staging safety hold");
  });

  it.each([
    "*",
    "*@example.test",
    "example.test",
    "@example.test",
    "QA <qa@example.test>",
    "qa@example.test;other@example.test",
    "qa@example.test,",
    "qa@example.test\r\nBcc:other@example.test",
  ])("rejects malformed or broad staging allowlist %s", (allowlist) => {
    expect(() =>
      assertStagingEmailRecipientAllowed("qa@example.test", {
        FLY_APP_NAME: "mogulforge-growthos-staging",
        STAGING_EMAIL_RECIPIENT_ALLOWLIST: allowlist,
      }),
    ).toThrow("STAGING_EMAIL_RECIPIENT_ALLOWLIST");
  });

  it("does not turn staging's allowlist into a production send permission", () => {
    expect(() =>
      assertStagingEmailRecipientAllowed("client@example.test", {
        NODE_ENV: "production",
        FLY_APP_NAME: "mogulforge-growthos",
      }),
    ).not.toThrow();
    vi.stubEnv("FLY_APP_NAME", "mogulforge-growthos");
    vi.stubEnv("APP_ORIGIN", "https://growthos.example.test");
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
    vi.stubEnv("STAGING_EMAIL_RECIPIENT_ALLOWLIST", "qa@example.test");
    expect(() =>
      assertOutboundDeliveryAllowed({
        channel: "email",
        recipient: "qa@example.test",
      }),
    ).toThrow("staging safety hold");
  });

  it("blocks unapproved staging email at actual provider and Gmail dispatch points", async () => {
    vi.stubEnv("FLY_APP_NAME", "mogulforge-growthos-staging");
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
    vi.stubEnv("STAGING_OUTBOUND_APPROVED", "true");
    vi.stubEnv("STAGING_EMAIL_RECIPIENT_ALLOWLIST", "qa@example.test");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected network"));
    await expect(
      resendEmailProvider.send("client@example.test", "subject", "body"),
    ).rejects.toThrow("not approved");
    await expect(
      transactionalEmailProvider.send("client@example.test", "subject", "body"),
    ).rejects.toThrow("not approved");
    await expect(
      customerEmailProvider.send("client@example.test", "subject", "body", {
        organizationId: randomUUID(),
      }),
    ).rejects.toThrow("not approved");
    await expect(
      sendGmailForUser({
        organizationId: randomUUID(),
        userId: randomUUID(),
        to: "client@example.test",
        subject: "subject",
        body: "body",
      }),
    ).rejects.toThrow("not approved");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
