import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const VERSION = "v1";

function encryptionKey(): Buffer {
  const configured = process.env.OAUTH_TOKEN_ENCRYPTION_KEY?.trim();
  if (!configured) {
    throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY is not configured");
  }
  const key = /^[a-f\d]{64}$/i.test(configured)
    ? Buffer.from(configured, "hex")
    : Buffer.from(configured, "base64");
  if (key.length !== 32) {
    throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

/** AES-256-GCM with caller-supplied tenant/user context bound as AAD. */
export function encryptSecret(plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

export function decryptSecret(payload: string, context: string): string {
  const [version, ivValue, tagValue, ciphertextValue, extra] = payload.split(".");
  if (version !== VERSION || !ivValue || !tagValue || !ciphertextValue || extra) {
    throw new Error("Encrypted credential has an unsupported format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

