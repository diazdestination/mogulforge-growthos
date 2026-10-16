import { createECDH, type ECDH } from "node:crypto";

/**
 * Test-only VAPID key pair whose private scalar always encodes to exactly 32
 * bytes. Node's ECDH#getPrivateKey() drops leading zero bytes, so a random
 * P-256 scalar comes back as 31 (or fewer) bytes about 1 time in 256. The
 * production check in staff-push-policy.ts requires a canonical 32-byte key
 * and must stay fail-closed, so the fixture retries instead of padding.
 */
export function createVapidTestKeyPair(): { ecdh: ECDH; publicKey: string; privateKey: string } {
  for (let attempt = 0; attempt < 64; attempt++) {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const privateBytes = ecdh.getPrivateKey();
    if (privateBytes.length !== 32) continue;
    return {
      ecdh,
      publicKey: ecdh.getPublicKey().toString("base64url"),
      privateKey: privateBytes.toString("base64url"),
    };
  }
  throw new Error("Could not generate a canonical 32-byte VAPID test key.");
}
