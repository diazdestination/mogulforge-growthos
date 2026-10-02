import { db, organizationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { logger } from "../lib/logger";

import { crmAppUrl, sendInviteEmail } from "./invite-email";
import { verifyInviteToken } from "./invite-token";
import * as providers from "./providers";
import { ResendSendError } from "./resend-delivery";

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
      .spyOn(providers.transactionalEmailProvider, "send")
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
    const invitationUrl = body
      .split("\n")
      .find((line) => /^https?:\/\//.test(line));
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

  it("reports an unconfirmed send without exposing raw errors to the admin or logs", async () => {
    const privateDetails =
      "newbie@example.com token=private-invite-token re_test-key private message body";
    const failure = new Error(privateDetails, {
      cause: { body: privateDetails },
    });
    failure.name = privateDetails;
    const log = vi.spyOn(logger, "error").mockImplementation(() => {});
    const send = vi
      .spyOn(providers.transactionalEmailProvider, "send")
      .mockRejectedValue(failure);
    const result = await sendInviteEmail({
      invitedUserId: "invite:failure",
      organizationId: org.id,
      to: "newbie@example.com",
      inviterName: "Ava Admin",
      role: "admin",
    });
    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/Invitation email was not confirmed/);
    expect(result.error).toMatch(/before sending again/);
    expect(send).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      {
        errorCode: "invite_email_unconfirmed",
        outcome: "unknown",
        httpStatus: undefined,
      },
      "invite: email delivery was not confirmed",
    );
    for (const secret of [
      "newbie@example.com",
      "private-invite-token",
      "re_test-key",
      "private message body",
    ])
      expect(JSON.stringify({ result, logs: log.mock.calls })).not.toContain(
        secret,
      );
  });

  it.each(["rejected", "unknown"] as const)(
    "preserves a safe Resend %s outcome for the admin and operator",
    async (outcome) => {
      const failure = new ResendSendError(
        outcome,
        outcome === "rejected" ? 403 : 503,
      );
      const log = vi.spyOn(logger, "error").mockImplementation(() => {});
      const send = vi
        .spyOn(providers.transactionalEmailProvider, "send")
        .mockRejectedValue(failure);
      const result = await sendInviteEmail({
        invitedUserId: "invite:provider-failure",
        organizationId: org.id,
        to: "newbie@example.com",
        inviterName: "Ava Admin",
        role: "admin",
      });
      expect(result).toEqual({ sent: false, error: failure.message });
      expect(send).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledExactlyOnceWith(
        { errorCode: failure.code, outcome, httpStatus: failure.httpStatus },
        "invite: email delivery was not confirmed",
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(
        "newbie@example.com",
      );
    },
  );

  it("rejects unsafe recipient addresses without calling the provider", async () => {
    const send = vi.spyOn(providers.transactionalEmailProvider, "send");
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
