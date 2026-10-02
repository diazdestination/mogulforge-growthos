import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decryptEmailContent, encryptEmailContent } from "./email-content-encryption";

const previousKey = process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString("base64");
});

afterEach(() => {
  if (previousKey === undefined) delete process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY;
  else process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY = previousKey;
});

describe("email content encryption", () => {
  it("round trips content only with the exact tenant context", () => {
    const encrypted = encryptEmailContent("private message", "org-a:source-a:message-a:email");
    expect(encrypted).not.toContain("private message");
    expect(decryptEmailContent(encrypted, "org-a:source-a:message-a:email")).toBe("private message");
    expect(() => decryptEmailContent(encrypted, "org-b:source-a:message-a:email")).toThrow();
  });

  it("rejects missing or malformed keys", () => {
    delete process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY;
    expect(() => encryptEmailContent("message", "context")).toThrow(/not configured/i);
    process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY = "too-short";
    expect(() => encryptEmailContent("message", "context")).toThrow(/exactly 32 bytes/i);
  });
});
