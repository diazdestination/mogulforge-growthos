import { db, organizationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import { crmAppUrl, sendInviteEmail } from "./invite-email";
import { verifyInviteToken } from "./invite-token";
import { providers } from "./providers";

let org: { id: string };

beforeAll(async () => {
  const slug = `test-invite-email-${Date.now()}`;
  await db.delete(organizationsTable).where(eq(organizationsTable.slug, slug));
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "Invite Email Test Org", slug })
    .returning();
  org = row;
});

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "invite-email-test-secret");
  vi.stubEnv("APP_URL", "https://crm.example.com");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

describe("crmAppUrl", () => {
  it("prefers APP_URL and strips trailing slash", () => {
    vi.stubEnv("APP_URL", "https://crm.example.com/");
    expect(crmAppUrl()).toBe("https://crm.example.com");
    vi.unstubAllEnvs();
  });

  it("falls back to the first Replit domain with the /crm/ path", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("REPLIT_DOMAINS", "myapp.repl.co,other.repl.co");
    expect(crmAppUrl()).toBe("https://myapp.repl.co/crm/");
    vi.unstubAllEnvs();
  });

  it("uses the portable APP_ORIGIN as the root-hosted CRM URL", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("APP_ORIGIN", "https://mogulforge.ai/");
    expect(crmAppUrl()).toBe("https://mogulforge.ai");
    vi.unstubAllEnvs();
  });
});

describe("sendInviteEmail", () => {
  it("sends a branded email with inviter, role, and sign-in link", async () => {
    const send = vi
      .spyOn(providers.email, "send")
      .mockResolvedValue({ id: "x", provider: "mock-email" });
    const result = await sendInviteEmail({
      invitedUserId: "invite:newbie",
      organizationId: org.id,
      to: "newbie@example.com",
      inviteeFirstName: "Nia",
      inviterName: "Ava Admin",
      role: "sales_rep",
    });
    expect(result).toEqual({ sent: true, error: null });
    expect(send).toHaveBeenCalledOnce();
    const [to, subject, body] = send.mock.calls[0];
    expect(to).toBe("newbie@example.com");
    // Branding comes from org settings: fresh orgs default to the org name.
    expect(subject).toContain("Invite Email Test Org");
    expect(body).toContain("Hi Nia,");
    expect(body).toContain("Ava Admin invited you");
    expect(body).toContain("sales rep");
    expect(body).toContain("expires in 7 days");
    const invitationUrl = body.split("\n").find((line) => /^https?:\/\//.test(line));
    expect(invitationUrl).toBeTruthy();
    const parsedUrl = new URL(invitationUrl!);
    expect(parsedUrl.pathname).toBe("/signup");
    expect(parsedUrl.searchParams.get("email")).toBe("newbie@example.com");
    expect(
      verifyInviteToken(parsedUrl.searchParams.get("invite")!, {
        inviteId: "invite:newbie",
        organizationId: org.id,
        email: "newbie@example.com",
      }),
    ).toBe(true);
  });

  it("reports failures instead of throwing so the admin sees them", async () => {
    vi.spyOn(providers.email, "send").mockRejectedValue(
      new Error("Gmail send failed: 500"),
    );
    const result = await sendInviteEmail({
      invitedUserId: "invite:failure",
      organizationId: org.id,
      to: "newbie@example.com",
      inviterName: "Ava Admin",
      role: "admin",
    });
    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/Gmail send failed/);
  });

  it("rejects unsafe recipient addresses without calling the provider", async () => {
    const send = vi.spyOn(providers.email, "send");
    const result = await sendInviteEmail({
      invitedUserId: "invite:unsafe",
      organizationId: org.id,
      to: "victim@example.com\r\nBcc: evil@evil.com",
      inviterName: "Ava Admin",
      role: "viewer",
    });
    expect(result.sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
