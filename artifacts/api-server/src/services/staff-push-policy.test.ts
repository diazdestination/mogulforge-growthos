import { createVapidTestKeyPair } from "../test-helpers/vapid-test-keys";
import { describe, expect, it } from "vitest";
import { isPushEndpointAllowed, pushConfiguration, pushSubscriptionSchema, staffLeadPayload, staffPushAllowed,
  staffPushPolicySchema, staffPushRecipients } from "./staff-push-policy";

const policy = { enabled: true, timezone: "America/New_York", days: [1, 2, 3, 4, 5, 6], opensAt: "09:00", closesAt: "18:00",
  businessHoursUserIds: ["owner-a", "owner-b"], afterHoursUserIds: ["owner-a"] };
const key = createVapidTestKeyPair().ecdh;
const configured: NodeJS.ProcessEnv = { WEB_PUSH_ENABLED: "true", GROWTHOS_OUTBOUND_HOLD: "false",
  WEB_PUSH_VAPID_PUBLIC_KEY: key.getPublicKey().toString("base64url"), WEB_PUSH_VAPID_PRIVATE_KEY: key.getPrivateKey().toString("base64url"),
  WEB_PUSH_VAPID_SUBJECT: "mailto:operator@example.invalid", OAUTH_TOKEN_ENCRYPTION_KEY: "a".repeat(64) };

describe("staff notification hours and opt-in configuration", () => {
  it.each([
    ["2026-10-01T12:59:00Z", ["owner-a"]], ["2026-10-01T13:00:00Z", ["owner-a", "owner-b"]],
    ["2026-10-01T21:59:00Z", ["owner-a", "owner-b"]], ["2026-10-01T22:00:00Z", ["owner-a"]],
    ["2026-10-03T14:00:00Z", ["owner-a", "owner-b"]], ["2026-10-04T14:00:00Z", ["owner-a"]],
    ["2026-12-01T13:59:00Z", ["owner-a"]], ["2026-12-01T14:00:00Z", ["owner-a", "owner-b"]],
  ])("routes the actual local day/time at %s", (at, ids) => expect(staffPushRecipients(policy, new Date(at))).toEqual(ids));
  it.each([{ days: [] }, { businessHoursUserIds: [] }, { afterHoursUserIds: [] }, { timezone: "fake/zone" },
    { opensAt: "18:00", closesAt: "09:00" }, { days: [1, 1] }, { businessHoursUserIds: ["a", "a"] }, { organizationId: "forged" }])(
    "fails closed on incomplete, ambiguous or unknown fields %j", (change) => {
      expect(staffPushPolicySchema.safeParse({ ...policy, ...change }).success).toBe(false);
      expect(staffPushRecipients({ ...policy, ...change }, new Date())).toEqual([]);
    });
  it("does not assume weekdays for an absent policy or dispatch disabled policy", () => {
    expect(staffPushRecipients(undefined, new Date())).toEqual([]);
    expect(staffPushRecipients({ ...policy, enabled: false }, new Date())).toEqual([]);
  });
  it("requires explicit enable, matching VAPID pair and encryption config", () => {
    expect(staffPushAllowed("owner-a", configured)).toBe(true);
    for (const change of [{ WEB_PUSH_ENABLED: undefined }, { WEB_PUSH_ENABLED: "yes" }, { GROWTHOS_OUTBOUND_HOLD: "true" },
      { GROWTHOS_OUTBOUND_HOLD: "no" }, { WEB_PUSH_VAPID_PRIVATE_KEY: "not-a-key" }, { OAUTH_TOKEN_ENCRYPTION_KEY: "" }]) {
      expect(staffPushAllowed("owner-a", { ...configured, ...change })).toBe(false);
    }
    const other = createVapidTestKeyPair().ecdh;
    expect(pushConfiguration({ ...configured, WEB_PUSH_VAPID_PRIVATE_KEY: other.getPrivateKey().toString("base64url") })).toBe(null);
  });
  it.each(["FLY_APP_NAME", "APP_ORIGIN", "GROWTHOS_ENVIRONMENT"])("staging is exact-user allowlisted through %s", (flag) => {
    const staging = { ...configured, [flag]: flag === "FLY_APP_NAME" ? "mogulforge-growthos-staging" : flag === "APP_ORIGIN" ? "https://mogulforge-growthos-staging.fly.dev" : "staging" };
    expect(staffPushAllowed("owner-a", staging)).toBe(false);
    const approved = { ...staging, STAGING_OUTBOUND_APPROVED: "true", STAGING_PUSH_USER_ALLOWLIST: "owner-a" };
    expect(staffPushAllowed("owner-a", approved)).toBe(true);
    expect(staffPushAllowed("owner-b", approved)).toBe(false);
    for (const allowlist of ["", "*", "owner-a,", "owner@example.invalid", "owner-a, *"]) {
      expect(staffPushAllowed("owner-a", { ...approved, STAGING_PUSH_USER_ALLOWLIST: allowlist })).toBe(false);
    }
  });
});

describe("push input and lock-screen privacy", () => {
  const token = "a".repeat(32);
  it.each([`https://web.push.apple.com/${token}`, `https://fcm.googleapis.com/fcm/send/${token}`,
    `https://updates.push.services.mozilla.com/wpush/v2/${token}`])("allows a supported provider shape %s", (endpoint) => {
    expect(isPushEndpointAllowed(endpoint)).toBe(true);
  });
  it.each([`http://web.push.apple.com/${token}`, `https://user:secret@web.push.apple.com/${token}`, `https://web.push.apple.com:444/${token}`,
    `https://web.push.apple.com.evil.test/${token}`, `https://web.push.apple.com./${token}`, `https://127.0.0.1/${token}`,
    `https://web.push.apple.com/${token}?x=y`, `https://web.push.apple.com/${token}#secret`, "https://web.push.apple.com/",
    `https://web.push.apple.com/a/../${token}`, `https://web.push.apple.com/%2f${token}`, `https://WEB.push.apple.com/${token}`,
    `https://fcm.googleapis.com/v1/projects/${token}`, `https://web.push.apple.com\\@127.0.0.1/${token}`])(
    "rejects SSRF, URL tricks or unsupported provider paths %s", (endpoint) => expect(isPushEndpointAllowed(endpoint)).toBe(false));
  it("requires real canonical curve/auth keys and never accepts client user/tenant fields", () => {
    const valid = { endpoint: `https://web.push.apple.com/${token}`, keys: { p256dh: key.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") } };
    expect(pushSubscriptionSchema.safeParse(valid).success).toBe(true);
    expect(pushSubscriptionSchema.safeParse({ ...valid, userId: "another" }).success).toBe(false);
    expect(pushSubscriptionSchema.safeParse({ ...valid, keys: { ...valid.keys, p256dh: Buffer.alloc(65).toString("base64url") } }).success).toBe(false);
    expect(pushSubscriptionSchema.safeParse({ ...valid, keys: { ...valid.keys, auth: "short" } }).success).toBe(false);
  });
  it("only places opaque navigation IDs and generic text in the payload", () => {
    expect(staffLeadPayload("org-id", "lead-id")).toEqual({ title: "GrowthOS", body: "A new lead is ready for your team.",
      organizationId: "org-id", leadId: "lead-id", url: "/leads/lead-id?organizationId=org-id", tag: "lead-lead-id" });
  });
});
