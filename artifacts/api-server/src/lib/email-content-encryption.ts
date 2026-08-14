import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

function encryptionKey(): Buffer {
  const configured = process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY?.trim();
  if (!configured) {
    throw new Error("EMAIL_INTELLIGENCE_ENCRYPTION_KEY is not configured");
  }
  const key = /^[a-f\d]{64}$/i.test(configured)
    ? Buffer.from(configured, "hex")
    : Buffer.from(configured, "base64");
  if (key.length !== 32) {
    throw new Error("EMAIL_INTELLIGENCE_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

/** AES-256-GCM with tenant/source/message identity bound as authenticated data. */
export function encryptEmailContent(plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

export function decryptEmailContent(payload: string, context: string): string {
  const [version, ivValue, tagValue, ciphertextValue, extra] = payload.split(".");
  if (version !== VERSION || !ivValue || !tagValue || !ciphertextValue || extra) {
    throw new Error("Encrypted email content has an unsupported format");
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
