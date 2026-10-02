import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createInviteToken,
  INVITE_TOKEN_TTL_MS,
  verifyInviteToken,
} from "./invite-token";

const binding = {
  inviteId: "invite:8fb8fbc7-1933-462f-a9c1-a086462444ca",
  organizationId: "d41565db-6ca0-42ee-a926-70c82770fe6f",
  email: "Invitee@Example.com",
};

describe("signed team invitation tokens", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "invite-token-test-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("binds an invitation to the exact row, organization, and normalized email", () => {
    const now = Date.parse("2026-08-14T13:30:00Z");
    const token = createInviteToken(binding, now);

    expect(verifyInviteToken(token, binding, now)).toBe(true);
    expect(
      verifyInviteToken(token, { ...binding, inviteId: "invite:other" }, now),
    ).toBe(false);
    expect(
      verifyInviteToken(token, { ...binding, organizationId: "other-org" }, now),
    ).toBe(false);
    expect(
      verifyInviteToken(token, { ...binding, email: "other@example.com" }, now),
    ).toBe(false);
  });

  it("rejects tampering and expiry", () => {
    const now = Date.parse("2026-08-14T13:30:00Z");
    const token = createInviteToken(binding, now);
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    expect(verifyInviteToken(tampered, binding, now)).toBe(false);
    expect(
      verifyInviteToken(token, binding, now + INVITE_TOKEN_TTL_MS),
    ).toBe(false);
  });

  it("fails closed when the signing secret is missing", () => {
    vi.stubEnv("SESSION_SECRET", "");
    expect(() => createInviteToken(binding)).toThrow(/SESSION_SECRET/);
  });
});
