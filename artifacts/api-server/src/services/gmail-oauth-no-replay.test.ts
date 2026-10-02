import { randomUUID } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  db,
  gmailConnectionsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { encryptSecret } from "../lib/token-encryption";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { sendGmailForUser } from "./gmail-oauth";

// Use the installed real OAuth2Client implementation, not a fake request method.
// Only token preparation and the bare transport are stubbed; no network exists.
const transporterPrototype = Object.getPrototypeOf(
  new OAuth2Client().transporter,
);
const orgs: string[] = [];
beforeEach(() => {
  vi.stubEnv(
    "OAUTH_TOKEN_ENCRYPTION_KEY",
    Buffer.alloc(32, 27).toString("base64"),
  );
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "synthetic-client");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv(
    "GOOGLE_OAUTH_REDIRECT_URI",
    "https://growth.example/api/v1/integrations/gmail/callback",
  );
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await deleteTestOrgs(...orgs);
});
async function fixture() {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic Gmail no replay",
      slug: `gmail-once-${randomUUID()}`,
    })
    .returning();
  orgs.push(org!.id);
  const [user] = await db
    .insert(usersTable)
    .values({ organizationId: org!.id, role: "owner", isActive: true })
    .returning();
  await db
    .insert(gmailConnectionsTable)
    .values({
      organizationId: org!.id,
      userId: user!.id,
      email: "sender@example.invalid",
      encryptedRefreshToken: encryptSecret(
        "synthetic-refresh",
        `${org!.id}:${user!.id}:gmail`,
      ),
      grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
    });
  return {
    organizationId: org!.id,
    userId: user!.id,
    to: "recipient@example.invalid",
    subject: "Synthetic invoice",
    body: "Synthetic only",
  };
}
it.each([401, 403, 500])(
  "never enters OAuth refresh/replay for a %s send response, including absent token expiry",
  async (status) => {
    const input = await fixture();
    const token = vi
      .spyOn(OAuth2Client.prototype, "getAccessToken")
      .mockImplementation(async function (this: OAuth2Client) {
        // This is exactly the credentials shape for which OAuth2Client.request
        // retries a 401/403 even when Gaxios retry:false is set.
        this.setCredentials({
          access_token: "synthetic-frozen-access",
          refresh_token: "synthetic-refresh",
        });
        return { token: "synthetic-frozen-access" };
      });
    const wrapper = vi.spyOn(OAuth2Client.prototype, "request");
    const transport = vi
      .spyOn(transporterPrototype, "request")
      .mockRejectedValue(
        Object.assign(new Error("Synthetic send rejected"), {
          response: {
            status,
            config: { data: { raw: "synthetic" } },
            data: { error: { code: status } },
          },
        }),
      );
    const guard = vi.fn(async () => {
      expect(token).toHaveBeenCalledOnce();
    });
    await expect(
      sendGmailForUser({ ...input, beforeDispatch: guard }),
    ).rejects.toBeDefined();
    expect(guard).toHaveBeenCalledOnce();
    expect(token).toHaveBeenCalledOnce();
    expect(wrapper).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        method: "POST",
        headers: { Authorization: "Bearer synthetic-frozen-access" },
        retry: false,
        maxRedirects: 0,
        timeout: 10_000,
      }),
    );
  },
);
it("does not reach the bare transport when the final workflow approval is withdrawn", async () => {
  const input = await fixture();
  vi.spyOn(OAuth2Client.prototype, "getAccessToken").mockImplementation(async () => ({
    token: "synthetic-frozen-access",
  }));
  const transport = vi
    .spyOn(transporterPrototype, "request")
    .mockRejectedValue(new Error("Unexpected provider dispatch"));
  await expect(
    sendGmailForUser({
      ...input,
      beforeDispatch: async () => {
        throw new Error("Withdrawn approval");
      },
    }),
  ).rejects.toMatchObject({
    code: "email_dispatch_blocked",
    effectNotAttempted: true,
  });
  expect(transport).not.toHaveBeenCalled();
});
it("fails closed when token preparation does not produce an access token", async () => {
  const input = await fixture();
  vi.spyOn(OAuth2Client.prototype, "getAccessToken").mockImplementation(async () => ({
    token: null,
  }));
  const transport = vi
    .spyOn(transporterPrototype, "request")
    .mockRejectedValue(new Error("Unexpected provider dispatch"));
  await expect(sendGmailForUser(input)).rejects.toMatchObject({
    code: "email_dispatch_blocked",
    effectNotAttempted: true,
  });
  expect(transport).not.toHaveBeenCalled();
});
