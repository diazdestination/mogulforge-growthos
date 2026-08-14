import {
  db,
  gmailConnectionsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encryptSecret } from "../lib/token-encryption";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { getGmailConnection, getGmailStatus } from "./gmail-oauth";

const previousEncryptionKey = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
const orgIds: string[] = [];
const userIds: string[] = [];

beforeAll(async () => {
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (const suffix of ["a", "b"]) {
    const [org] = await db
      .insert(organizationsTable)
      .values({ name: `Gmail tenant ${suffix}`, slug: `test-gmail-${suffix}-${nonce}` })
      .returning();
    const userId = `gmail-user-${suffix}-${nonce}`;
    await db.insert(usersTable).values({
      id: userId,
      email: `gmail-${suffix}-${nonce}@example.test`,
      organizationId: org.id,
      role: "owner",
    });
    orgIds.push(org.id);
    userIds.push(userId);
  }
  await db.insert(gmailConnectionsTable).values({
    organizationId: orgIds[0],
    userId: userIds[0],
    email: "sender-a@example.test",
    encryptedRefreshToken: encryptSecret(
      "tenant-a-refresh-token",
      `${orgIds[0]}:${userIds[0]}:gmail`,
    ),
    grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
  });
});

afterAll(async () => {
  for (let index = 0; index < userIds.length; index += 1) {
    await db
      .update(usersTable)
      .set({ organizationId: null })
      .where(eq(usersTable.id, userIds[index]!));
    await deleteTestOrgs(orgIds[index]!);
    await db.delete(usersTable).where(eq(usersTable.id, userIds[index]!));
  }
  if (previousEncryptionKey === undefined) delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  else process.env.OAUTH_TOKEN_ENCRYPTION_KEY = previousEncryptionKey;
});

describe("per-user Gmail connection isolation", () => {
  it("returns only a connection matching both organization and user", async () => {
    expect(await getGmailConnection(orgIds[0]!, userIds[0]!)).toMatchObject({
      email: "sender-a@example.test",
      organizationId: orgIds[0],
      userId: userIds[0],
    });
    expect(await getGmailConnection(orgIds[1]!, userIds[0]!)).toBeNull();
    expect(await getGmailConnection(orgIds[0]!, userIds[1]!)).toBeNull();
  });

  it("does not report another tenant's sender in connection status", async () => {
    expect(await getGmailStatus(orgIds[0]!, userIds[0]!)).toMatchObject({
      connected: true,
      email: "sender-a@example.test",
    });
    expect(await getGmailStatus(orgIds[1]!, userIds[1]!)).toMatchObject({
      connected: false,
      email: null,
    });
  });
});

