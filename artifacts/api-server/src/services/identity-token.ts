import { createHash, randomBytes } from "node:crypto";

import { db, identityTokensTable } from "@workspace/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";

export type IdentityTokenPurpose = "email_verification" | "password_reset";

export const IDENTITY_TOKEN_TTL_MS: Record<IdentityTokenPurpose, number> = {
  email_verification: 24 * 60 * 60 * 1000,
  password_reset: 60 * 60 * 1000,
};

function digestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Issue a new opaque token and revoke every unused predecessor for the same
 * user/purpose. Only the digest is persisted; the raw token exists only long
 * enough to place it in the outbound email.
 */
export async function issueIdentityToken(params: {
  userId: string;
  purpose: IdentityTokenPurpose;
  now?: Date;
}): Promise<string> {
  return (await issueIdentityTokenRecord(params)).token;
}

/** Stable record identity is the mail event key; the raw token never enters a ledger. */
export async function issueIdentityTokenRecord(params: {
  userId: string;
  purpose: IdentityTokenPurpose;
  now?: Date;
}): Promise<{ token: string; tokenRecordId: string }> {
  const now = params.now ?? new Date();
  return db.transaction(async tx => {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`identity-token:${params.userId}:${params.purpose}`}, 0))`);
  await tx
    .update(identityTokensTable)
    .set({ consumedAt: now })
    .where(
      and(
        eq(identityTokensTable.userId, params.userId),
        eq(identityTokensTable.purpose, params.purpose),
        isNull(identityTokensTable.consumedAt),
      ),
    );

  const token = randomBytes(32).toString("base64url");
  const [row] = await tx.insert(identityTokensTable).values({
    userId: params.userId,
    purpose: params.purpose,
    tokenDigest: digestToken(token),
    expiresAt: new Date(now.getTime() + IDENTITY_TOKEN_TTL_MS[params.purpose]),
  }).returning({ id: identityTokensTable.id });
  return { token, tokenRecordId: row.id };
  });
}

/**
 * Atomically consume a valid token. A replay, wrong-purpose token, or expired
 * token updates zero rows and returns null.
 */
export async function consumeIdentityToken(params: {
  token: string;
  purpose: IdentityTokenPurpose;
  now?: Date;
}): Promise<{ userId: string } | null> {
  if (!params.token || params.token.length > 512) return null;
  const now = params.now ?? new Date();
  const [consumed] = await db
    .update(identityTokensTable)
    .set({ consumedAt: now })
    .where(
      and(
        eq(identityTokensTable.tokenDigest, digestToken(params.token)),
        eq(identityTokensTable.purpose, params.purpose),
        isNull(identityTokensTable.consumedAt),
        gt(identityTokensTable.expiresAt, now),
      ),
    )
    .returning({ userId: identityTokensTable.userId });
  return consumed ?? null;
}
