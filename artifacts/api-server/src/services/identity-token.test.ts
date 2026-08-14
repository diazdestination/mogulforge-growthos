import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  consumeIdentityToken,
  IDENTITY_TOKEN_TTL_MS,
  issueIdentityToken,
} from "./identity-token";

let userId: string;

beforeEach(async () => {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `identity-token-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    })
    .returning();
  userId = user.id;
});

afterEach(async () => {
  if (userId) {
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  }
});

describe("identity tokens", () => {
  it("consumes a valid token exactly once", async () => {
    const token = await issueIdentityToken({
      userId,
      purpose: "email_verification",
    });

    await expect(
      consumeIdentityToken({ token, purpose: "email_verification" }),
    ).resolves.toEqual({ userId });
    await expect(
      consumeIdentityToken({ token, purpose: "email_verification" }),
    ).resolves.toBeNull();
  });

  it("does not consume a token under the wrong purpose", async () => {
    const token = await issueIdentityToken({
      userId,
      purpose: "password_reset",
    });

    await expect(
      consumeIdentityToken({ token, purpose: "email_verification" }),
    ).resolves.toBeNull();
    await expect(
      consumeIdentityToken({ token, purpose: "password_reset" }),
    ).resolves.toEqual({ userId });
  });

  it("rejects expired tokens", async () => {
    const issuedAt = new Date(
      Date.now() - IDENTITY_TOKEN_TTL_MS.password_reset - 1_000,
    );
    const token = await issueIdentityToken({
      userId,
      purpose: "password_reset",
      now: issuedAt,
    });

    await expect(
      consumeIdentityToken({ token, purpose: "password_reset" }),
    ).resolves.toBeNull();
  });

  it("revokes older unused tokens when a replacement is issued", async () => {
    const oldToken = await issueIdentityToken({
      userId,
      purpose: "password_reset",
    });
    const replacement = await issueIdentityToken({
      userId,
      purpose: "password_reset",
    });

    await expect(
      consumeIdentityToken({ token: oldToken, purpose: "password_reset" }),
    ).resolves.toBeNull();
    await expect(
      consumeIdentityToken({ token: replacement, purpose: "password_reset" }),
    ).resolves.toEqual({ userId });
  });
});
