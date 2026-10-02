import { createHmac, timingSafeEqual } from "node:crypto";

export const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type InviteTokenBinding = {
  inviteId: string;
  organizationId: string;
  email: string;
  tokenRevision?: string;
};

type InviteTokenPayload = {
  v: 1;
  inviteId: string;
  organizationId: string;
  email: string;
  tokenRevision?: string;
  issuedAt: number;
  expiresAt: number;
};

function signingSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) {
    throw new Error("SESSION_SECRET is required to sign team invitations");
  }
  return secret;
}

function signature(encodedPayload: string): string {
  return createHmac("sha256", signingSecret())
    .update(encodedPayload, "utf8")
    .digest("base64url");
}

export function createInviteToken(
  binding: InviteTokenBinding,
  now = Date.now(),
): string {
  const payload: InviteTokenPayload = {
    v: 1,
    inviteId: binding.inviteId,
    organizationId: binding.organizationId,
    email: binding.email.trim().toLowerCase(),
    ...(binding.tokenRevision ? { tokenRevision: binding.tokenRevision } : {}),
    issuedAt: now,
    expiresAt: now + INVITE_TOKEN_TTL_MS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${encodedPayload}.${signature(encodedPayload)}`;
}

export function verifyInviteToken(
  token: string,
  binding: InviteTokenBinding,
  now = Date.now(),
): boolean {
  try {
    if (!token || token.length > 4096) return false;
    const parts = token.split(".");
    if (parts.length !== 2) return false;
    const [encodedPayload, suppliedSignature] = parts;
    if (!encodedPayload || !suppliedSignature) return false;

    const expectedSignature = signature(encodedPayload);
    const supplied = Buffer.from(suppliedSignature, "utf8");
    const expected = Buffer.from(expectedSignature, "utf8");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      return false;
    }

    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<InviteTokenPayload>;
    if (
      payload.v !== 1 ||
      payload.inviteId !== binding.inviteId ||
      payload.organizationId !== binding.organizationId ||
      payload.email !== binding.email.trim().toLowerCase() ||
      payload.tokenRevision !== binding.tokenRevision ||
      !Number.isSafeInteger(payload.issuedAt) ||
      !Number.isSafeInteger(payload.expiresAt) ||
      payload.issuedAt! > now + 5 * 60 * 1000 ||
      payload.expiresAt! <= now ||
      payload.expiresAt! - payload.issuedAt! !== INVITE_TOKEN_TTL_MS
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
