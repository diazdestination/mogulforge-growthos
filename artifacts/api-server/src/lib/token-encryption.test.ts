import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret, sha256Base64Url } from "./token-encryption";

const previous = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;

describe("OAuth credential encryption", () => {
  beforeEach(() => {
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
    else process.env.OAUTH_TOKEN_ENCRYPTION_KEY = previous;
  });

  it("round-trips a token only with the same tenant/user context", () => {
    const encrypted = encryptSecret("refresh-token", "org-1:user-1:gmail");
    expect(encrypted).not.toContain("refresh-token");
    expect(decryptSecret(encrypted, "org-1:user-1:gmail")).toBe("refresh-token");
    expect(() => decryptSecret(encrypted, "org-2:user-1:gmail")).toThrow();
  });

  it("uses randomized nonces and stable state hashes", () => {
    expect(encryptSecret("same", "context")).not.toBe(encryptSecret("same", "context"));
    expect(sha256Base64Url("state")).toBe(sha256Base64Url("state"));
  });
});

