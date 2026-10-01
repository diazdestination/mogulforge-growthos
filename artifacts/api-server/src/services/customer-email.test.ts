import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import {
  auditEventsTable,
  contactsTable,
  db,
  gmailConnectionsTable,
  leadsTable,
  organizationsTable,
  orgSettingsTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
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

const gmailSend = vi.hoisted(() => vi.fn());
vi.mock("./gmail-oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gmail-oauth")>()),
  sendGmailForUser: gmailSend,
}));
import { getCustomerEmailStatus, sendCustomerEmail } from "./customer-email";
import {
  customerEmailProvider,
  resendEmailProvider,
  transactionalEmailProvider,
} from "./providers";
import settingsRouter from "../routes/v1/settings";
import {
  notifyAssignedRepOfPortalMessage,
  notifyAssignedRepOfPortalPhotos,
  notifyHomeownerOfTeamReply,
} from "./portal-message-email";

let orgA: string;
let orgB: string;
let userA: string;
let defaultA: string;
let userB: string;
let viewerA: string;
let leadA: string;
let leadB: string;
let server: Server;
let base: string;
const scope = "https://www.googleapis.com/auth/gmail.send";
const content = {
  to: "synthetic-customer@example.test",
  subject: "Synthetic appointment",
  body: "No real message is sent.",
};

beforeAll(async () => {
  const stamp = randomUUID();
  const [a, b] = await db
    .insert(organizationsTable)
    .values([
      { name: "Email isolation A", slug: `email-a-${stamp}` },
      { name: "Email isolation B", slug: `email-b-${stamp}` },
    ])
    .returning();
  orgA = a.id;
  orgB = b.id;
  const [a1, a2, b1, viewer] = await db
    .insert(usersTable)
    .values([
      {
        organizationId: orgA,
        role: "admin",
        email: `sender-a-${stamp}@example.test`,
      },
      {
        organizationId: orgA,
        role: "office",
        email: `default-a-${stamp}@example.test`,
      },
      {
        organizationId: orgB,
        role: "admin",
        email: `sender-b-${stamp}@example.test`,
      },
      {
        organizationId: orgA,
        role: "viewer",
        email: `viewer-a-${stamp}@example.test`,
      },
    ])
    .returning();
  userA = a1.id;
  defaultA = a2.id;
  userB = b1.id;
  viewerA = viewer.id;
  for (const user of [a1, a2, b1, viewer]) {
    await db.insert(gmailConnectionsTable).values({
      organizationId: user.organizationId!,
      userId: user.id,
      email: user.email!,
      encryptedRefreshToken: "synthetic-never-decrypted",
      grantedScopes: [scope],
    });
  }
  await db.insert(orgSettingsTable).values([
    { organizationId: orgA, customerEmailSenderUserId: defaultA },
    { organizationId: orgB, customerEmailSenderUserId: userB },
  ]);
  const [contactA, contactB] = await db
    .insert(contactsTable)
    .values([
      { organizationId: orgA, firstName: "Synthetic A", email: content.to },
      {
        organizationId: orgB,
        firstName: "Synthetic B",
        email: "other@example.test",
      },
    ])
    .returning();
  const [la, lb] = await db
    .insert(leadsTable)
    .values([
      { organizationId: orgA, contactId: contactA.id, assignedUserId: userA },
      { organizationId: orgB, contactId: contactB.id },
    ])
    .returning();
  leadA = la.id;
  leadB = lb.id;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.isAuthenticated = (() => true) as typeof req.isAuthenticated;
    req.user = { id: userA } as Express.User;
    next();
  });
  app.use(settingsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "synthetic-client");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "synthetic-test-only");
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  gmailSend.mockReset().mockResolvedValue({
    id: "synthetic-gmail-receipt",
    provider: "gmail",
    senderEmail: "synthetic-sender@example.test",
  });
  await db
    .update(orgSettingsTable)
    .set({
      customerEmailSenderUserId: defaultA,
      fallbackNotificationInbox: null,
    })
    .where(eq(orgSettingsTable.organizationId, orgA));
  await db
    .update(leadsTable)
    .set({ assignedUserId: userA })
    .where(eq(leadsTable.id, leadA));
  await db
    .update(usersTable)
    .set({ isActive: true, role: "admin" })
    .where(eq(usersTable.id, userA));
  await db
    .update(usersTable)
    .set({ isActive: true, role: "office" })
    .where(eq(usersTable.id, defaultA));
  await db
    .update(gmailConnectionsTable)
    .set({ revokedAt: null, grantedScopes: [scope] })
    .where(eq(gmailConnectionsTable.userId, userA));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await deleteTestOrgs(orgA, orgB);
});

describe("customer email identity isolation", () => {
  it("uses each tenant's selected identity and preserves an assigned lead's sender", async () => {
    await sendCustomerEmail({
      ...content,
      organizationId: orgA,
      leadId: leadA,
    });
    expect(gmailSend).toHaveBeenLastCalledWith({
      ...content,
      organizationId: orgA,
      userId: userA,
    });
    await sendCustomerEmail({
      ...content,
      organizationId: orgB,
      leadId: leadB,
    });
    expect(gmailSend).toHaveBeenLastCalledWith({
      ...content,
      organizationId: orgB,
      userId: userB,
    });
    await sendCustomerEmail({ ...content, organizationId: orgA });
    expect(gmailSend).toHaveBeenLastCalledWith({
      ...content,
      organizationId: orgA,
      userId: defaultA,
    });
    const receipt = await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, orgA),
          eq(auditEventsTable.action, "customer_email.provider_accepted"),
        ),
      );
    expect(
      receipt.some(
        (entry) =>
          entry.metadata?.providerMessageId === "synthetic-gmail-receipt",
      ),
    ).toBe(true);
  });

  it("rejects foreign leads, assignments, and stored defaults without revealing the foreign mailbox", async () => {
    await expect(
      sendCustomerEmail({ ...content, organizationId: orgA, leadId: leadB }),
    ).rejects.toThrow(/not available in this company/);
    await db
      .update(leadsTable)
      .set({ assignedUserId: userB })
      .where(eq(leadsTable.id, leadA));
    await expect(
      sendCustomerEmail({ ...content, organizationId: orgA, leadId: leadA }),
    ).rejects.toThrow(/active staff member of this company/);
    await db
      .update(orgSettingsTable)
      .set({ customerEmailSenderUserId: userB })
      .where(eq(orgSettingsTable.organizationId, orgA));
    const status = await getCustomerEmailStatus(orgA);
    expect(status).toMatchObject({ provider: "disabled", senderEmail: null });
    await expect(
      sendCustomerEmail({ ...content, organizationId: orgA }),
    ).rejects.toThrow(/active staff member of this company/);
    expect(gmailSend).not.toHaveBeenCalled();
  });

  it("does not choose another member or platform sender when no sender is designated", async () => {
    vi.stubEnv("RESEND_API_KEY", "synthetic-resend");
    vi.stubEnv("RESEND_FROM_EMAIL", "platform@example.test");
    vi.stubEnv("REPLIT_CONNECTORS_HOSTNAME", "synthetic-connector");
    vi.stubEnv("REPL_IDENTITY", "synthetic-global-identity");
    const resend = vi.spyOn(resendEmailProvider, "send");
    const platform = vi.spyOn(transactionalEmailProvider, "send");
    await db
      .update(orgSettingsTable)
      .set({ customerEmailSenderUserId: null })
      .where(eq(orgSettingsTable.organizationId, orgA));
    await expect(
      customerEmailProvider.send(content.to, content.subject, content.body, {
        organizationId: orgA,
      }),
    ).rejects.toThrow(/Choose a customer email sender/);
    expect(gmailSend).not.toHaveBeenCalled();
    expect(resend).not.toHaveBeenCalled();
    expect(platform).not.toHaveBeenCalled();
  });

  it("blocks a revoked assigned sender even while the explicit company default is healthy", async () => {
    await db
      .update(gmailConnectionsTable)
      .set({ revokedAt: new Date() })
      .where(eq(gmailConnectionsTable.userId, userA));
    await expect(
      sendCustomerEmail({ ...content, organizationId: orgA, leadId: leadA }),
    ).rejects.toThrow(/connect or reconnect Gmail/);
    expect(gmailSend).not.toHaveBeenCalled();
  });

  it("blocks inactive, read-only and insufficient-scope identities", async () => {
    await db
      .update(usersTable)
      .set({ isActive: false })
      .where(eq(usersTable.id, userA));
    await expect(
      sendCustomerEmail({ ...content, organizationId: orgA, leadId: leadA }),
    ).rejects.toThrow(/active staff/);
    await db
      .update(usersTable)
      .set({ isActive: true, role: "viewer" })
      .where(eq(usersTable.id, userA));
    await expect(
      sendCustomerEmail({ ...content, organizationId: orgA, leadId: leadA }),
    ).rejects.toThrow(/permission to contact/);
    await db
      .update(usersTable)
      .set({ role: "admin" })
      .where(eq(usersTable.id, userA));
    await db
      .update(gmailConnectionsTable)
      .set({ grantedScopes: ["openid", "email"] })
      .where(eq(gmailConnectionsTable.userId, userA));
    await expect(
      sendCustomerEmail({ ...content, organizationId: orgA, leadId: leadA }),
    ).rejects.toThrow(/permission to send email/);
    expect(gmailSend).not.toHaveBeenCalled();
  });

  it("propagates Gmail failure without trying an alternate identity or Resend", async () => {
    gmailSend.mockRejectedValue(new Error("Gmail authorization revoked"));
    const resend = vi.spyOn(resendEmailProvider, "send");
    await expect(
      sendCustomerEmail({ ...content, organizationId: orgA, leadId: leadA }),
    ).rejects.toThrow(/revoked/);
    expect(gmailSend).toHaveBeenCalledTimes(1);
    expect(resend).not.toHaveBeenCalled();
  });
});

describe("portal staff notifications use the explicit company default", () => {
  it("notifies the configured fallback inbox and admins when the assigned rep is inactive", async () => {
    await db
      .update(usersTable)
      .set({ isActive: false })
      .where(eq(usersTable.id, userA));
    await db
      .update(orgSettingsTable)
      .set({ fallbackNotificationInbox: "office-alerts@example.test" })
      .where(eq(orgSettingsTable.organizationId, orgA));
    const message = await notifyAssignedRepOfPortalMessage({
      organizationId: orgA,
      leadId: leadA,
      messageContent: "Synthetic customer update",
    });
    expect(message).toMatchObject({
      sent: true,
      reason: "assigned rep is deactivated; notified fallback inbox",
    });
    expect(gmailSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        organizationId: orgA,
        userId: defaultA,
        to: "office-alerts@example.test",
        body: expect.stringContaining(`/leads/${leadA}`),
      }),
    );
    await db
      .update(usersTable)
      .set({ role: "admin" })
      .where(eq(usersTable.id, defaultA));
    const [admin] = await db
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, defaultA));
    const photos = await notifyAssignedRepOfPortalPhotos({
      organizationId: orgA,
      leadId: leadA,
      photoCount: 2,
    });
    expect(photos).toMatchObject({
      sent: true,
      reason: "assigned rep is deactivated; notified org admins",
    });
    expect(gmailSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        organizationId: orgA,
        userId: defaultA,
        to: admin.email,
      }),
    );
  });

  it("still alerts the active rep from the company default after their Gmail is revoked, while homeowner email remains blocked", async () => {
    await db
      .update(gmailConnectionsTable)
      .set({ revokedAt: new Date() })
      .where(eq(gmailConnectionsTable.userId, userA));
    const [rep] = await db
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, userA));
    const staff = await notifyAssignedRepOfPortalMessage({
      organizationId: orgA,
      leadId: leadA,
      messageContent: "Synthetic update",
    });
    expect(staff.sent).toBe(true);
    expect(gmailSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        organizationId: orgA,
        userId: defaultA,
        to: rep.email,
      }),
    );
    gmailSend.mockClear();
    const homeowner = await notifyHomeownerOfTeamReply({
      organizationId: orgA,
      leadId: leadA,
      messageContent: "Synthetic reply",
    });
    expect(homeowner).toMatchObject({
      sent: false,
      reason: expect.stringContaining("connect or reconnect Gmail"),
    });
    expect(gmailSend).not.toHaveBeenCalled();
  });

  it("never sends staff alerts to a foreign assigned member or uses a foreign default", async () => {
    await db
      .update(leadsTable)
      .set({ assignedUserId: userB })
      .where(eq(leadsTable.id, leadA));
    const [ownAdmin] = await db
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, userA));
    const result = await notifyAssignedRepOfPortalMessage({
      organizationId: orgA,
      leadId: leadA,
      messageContent: "Private company A update",
    });
    expect(result.sent).toBe(true);
    expect(gmailSend).toHaveBeenCalledTimes(1);
    expect(gmailSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        organizationId: orgA,
        userId: defaultA,
        to: ownAdmin.email,
      }),
    );
    gmailSend.mockClear();
    await db
      .update(orgSettingsTable)
      .set({ customerEmailSenderUserId: userB })
      .where(eq(orgSettingsTable.organizationId, orgA));
    const blocked = await notifyAssignedRepOfPortalPhotos({
      organizationId: orgA,
      leadId: leadA,
      photoCount: 1,
    });
    expect(blocked.sent).toBe(false);
    expect(gmailSend).not.toHaveBeenCalled();
  });
});

it("lets an admin save or clear only an authorized sender within their own company", async () => {
  const put = (sender: string | null) =>
    fetch(`${base}/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerEmailSenderUserId: sender }),
    });
  expect((await put(userB)).status).toBe(400);
  expect((await put(viewerA)).status).toBe(400);
  await db
    .update(gmailConnectionsTable)
    .set({ revokedAt: new Date() })
    .where(eq(gmailConnectionsTable.userId, userA));
  expect((await put(userA)).status).toBe(400);
  expect((await put(defaultA)).status).toBe(200);
  const [other] = await db
    .select()
    .from(orgSettingsTable)
    .where(eq(orgSettingsTable.organizationId, orgB));
  expect(other.customerEmailSenderUserId).toBe(userB);
  expect((await put(null)).status).toBe(200);
  expect(await getCustomerEmailStatus(orgA)).toMatchObject({
    provider: "disabled",
    senderUserId: null,
  });
});
