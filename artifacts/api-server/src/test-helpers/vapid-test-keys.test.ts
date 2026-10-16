import { createECDH } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pushConfiguration } from "../services/staff-push-policy";
import { createVapidTestKeyPair } from "./vapid-test-keys";

const base = { WEB_PUSH_VAPID_SUBJECT: "mailto:operator@example.invalid", OAUTH_TOKEN_ENCRYPTION_KEY: "a".repeat(64) };

describe("createVapidTestKeyPair", () => {
  it("always yields a key pair the fail-closed push configuration accepts", () => {
    // 4096 draws would include ~16 short scalars if the helper did not filter them.
    for (let i = 0; i < 4096; i++) {
      const { publicKey, privateKey } = createVapidTestKeyPair();
      expect(Buffer.from(privateKey, "base64url")).toHaveLength(32);
      expect(Buffer.from(publicKey, "base64url")).toHaveLength(65);
      expect(pushConfiguration({ ...base, WEB_PUSH_VAPID_PUBLIC_KEY: publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: privateKey }))
        .toEqual({ publicKey, privateKey, subject: base.WEB_PUSH_VAPID_SUBJECT });
    }
  });

  it("production validation still rejects a short (31-byte) private scalar", () => {
    let short: ReturnType<typeof createECDH> | undefined;
    for (let i = 0; i < 100_000 && !short; i++) {
      const k = createECDH("prime256v1"); k.generateKeys();
      if (k.getPrivateKey().length < 32) short = k;
    }
    expect(short).toBeDefined();
    expect(pushConfiguration({ ...base, WEB_PUSH_VAPID_PUBLIC_KEY: short!.getPublicKey().toString("base64url"),
      WEB_PUSH_VAPID_PRIVATE_KEY: short!.getPrivateKey().toString("base64url") })).toBe(null);
  });
});
