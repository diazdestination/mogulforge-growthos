import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  contactsTable,
  db,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import app from "../../app";
import { createApiKey } from "../../services/api-keys";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

let server: Server;
let base: string;
let orgA: string;
let orgB: string;
let keyA: string;
let foreignContact: { id: string; firstName: string };

const request = (path: string, init: RequestInit = {}) =>
  fetch(`${base}/api/v1${path}`, {
    ...init,
    headers: {
      "x-api-key": keyA,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

beforeAll(async () => {
  const suffix = randomUUID().slice(0, 12);
  const [a, b] = await db
    .insert(organizationsTable)
    .values([
      { name: "API key isolation A", slug: `key-isolation-a-${suffix}` },
      { name: "API key isolation B", slug: `key-isolation-b-${suffix}` },
    ])
    .returning();
  orgA = a.id;
  orgB = b.id;
  const [creator] = await db
    .insert(usersTable)
    .values({ organizationId: orgA, role: "admin", isActive: true })
    .returning();
  keyA = (
    await createApiKey({
      organizationId: orgA,
      name: "Isolation QA office key",
      role: "office",
      createdByUserId: creator.id,
    })
  ).key;
  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId: orgB,
      firstName: `PrivateB${suffix}`,
      lastName: "Synthetic",
    })
    .returning();
  foreignContact = contact;

  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await deleteTestOrgs(orgA, orgB);
});

it("keeps an office API key inside its own tenant for contact search, direct read and write", async () => {
  const ownCreate = await request("/contacts", {
    method: "POST",
    body: JSON.stringify({ firstName: "Own", lastName: "Synthetic" }),
  });
  expect(ownCreate.status).toBe(201);
  const own = (await ownCreate.json()) as {
    id: string;
    organizationId: string;
  };
  expect(own.organizationId).toBe(orgA);
  expect((await request(`/contacts/${own.id}`)).status).toBe(200);

  const search = await request(
    `/contacts?search=${encodeURIComponent(foreignContact.firstName)}`,
  );
  expect(search.status).toBe(200);
  expect(await search.json()).toEqual([]);
  expect((await request(`/contacts/${foreignContact.id}`)).status).toBe(404);

  const update = await request(`/contacts/${foreignContact.id}`, {
    method: "PATCH",
    body: JSON.stringify({ firstName: "CrossTenantEdit" }),
  });
  expect(update.status).toBe(404);
  const [unchanged] = await db
    .select({ firstName: contactsTable.firstName })
    .from(contactsTable)
    .where(eq(contactsTable.id, foreignContact.id));
  expect(unchanged.firstName).toBe(foreignContact.firstName);
});
