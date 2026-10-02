import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import app from "../../app";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { createInvoice, issueInvoice } from "../../services/invoices";
import * as delivery from "../../services/invoice-delivery";
import * as apiKeys from "../../services/api-keys";

let server: Server, origin: string;
const orgs: string[] = [];
async function fixture() {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic invoice mail HTTP",
      slug: `invoice-delivery-http-${randomUUID()}`,
    })
    .returning();
  orgs.push(org!.id);
  const actor = await user(org!.id, "owner");
  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId: org!.id,
      firstName: "Synthetic",
      email: "customer@example.invalid",
    })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: org!.id, contactId: contact!.id })
    .returning();
  const draft = (
    await createInvoice(org!.id, actor.id, {
      requestId: randomUUID(),
      leadId: lead!.id,
      document: {
        title: "Synthetic bill",
        currency: "USD",
        issuerName: "Synthetic contractor",
        customerName: "Synthetic customer",
        lineItems: [
          { description: "Work", quantity: "1", unitPriceCents: 10000 },
        ],
        taxCents: 0,
      },
    })
  ).invoice;
  const invoice = (
    await issueInvoice(org!.id, actor.id, draft.id, {
      requestId: randomUUID(),
      expectedVersion: 1,
      confirmed: true,
    })
  ).invoice;
  return { org: org!.id, ...actor, invoice };
}
async function user(org: string, role: "owner" | "sales_manager" | "viewer") {
  const [row] = await db
    .insert(usersTable)
    .values({
      organizationId: org,
      role,
      isActive: true,
      emailVerifiedAt: new Date(),
      email: `invoice-http-${randomUUID()}@example.invalid`,
    })
    .returning();
  const sid = await createSession({
    user: {
      id: row!.id,
      email: row!.email,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "synthetic-session",
  });
  return { id: row!.id, sid };
}
function request(
  sid: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${origin}/api/v1/invoices/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sid ? { cookie: `sid=${sid}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeAll(async () => {
  const target = new URL(process.env.DATABASE_URL ?? "");
  if (
    process.env.NODE_ENV !== "test" ||
    !["localhost", "127.0.0.1"].includes(target.hostname) ||
    !(
      target.pathname.endsWith("_test") ||
      (process.env.SCHEDULER_TEST_BACKEND === "pglite" &&
        target.pathname === "/postgres")
    )
  )
    throw new Error("Use the isolated test runner");
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await deleteTestOrgs(...orgs);
});
describe("invoice email HTTP boundary", () => {
  it("allows invoice read roles to inspect evidence but restricts preview/send to session invoice managers", async () => {
    const f = await fixture(),
      sales = await user(f.org, "sales_manager"),
      viewer = await user(f.org, "viewer");
    expect((await request("", `${f.invoice.id}/delivery`)).status).toBe(401);
    expect((await request(viewer.sid, `${f.invoice.id}/delivery`)).status).toBe(
      403,
    );
    const read = await request(sales.sid, `${f.invoice.id}/delivery`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      state: "not_sent",
      invoiceId: f.invoice.id,
      deliveryConfirmed: false,
    });
    expect(read.headers.get("cache-control")).toBe("no-store");
    for (const action of ["preview", "send"])
      expect(
        (await request(sales.sid, `${f.invoice.id}/delivery/${action}`, {}))
          .status,
      ).toBe(403);
    const resolver = vi.spyOn(apiKeys, "resolveApiKey");
    expect(
      (
        await request(
          f.sid,
          `${f.invoice.id}/delivery/send`,
          {},
          { "x-api-key": "synthetic" },
        )
      ).status,
    ).toBe(403);
    expect(resolver).not.toHaveBeenCalled();
  });
  it("derives company context from membership and rejects foreign invoices, query overrides and malformed contracts", async () => {
    const f = await fixture(),
      other = await fixture();
    expect((await request(other.sid, `${f.invoice.id}/delivery`)).status).toBe(
      404,
    );
    expect(
      (
        await request(
          f.sid,
          `${f.invoice.id}/delivery?organizationId=${other.org}`,
        )
      ).status,
    ).toBe(400);
    expect((await request(f.sid, `bad-id/delivery`)).status).toBe(400);
    for (const body of [
      {},
      { expectedVersion: 2, organizationId: other.org },
      { expectedVersion: 2, to: "arbitrary@example.invalid" },
    ])
      expect(
        (await request(f.sid, `${f.invoice.id}/delivery/preview`, body)).status,
      ).toBe(400);
    for (const body of [
      {},
      {
        previewId: randomUUID(),
        payloadSha256: "a".repeat(64),
        confirmed: false,
      },
      {
        previewId: randomUUID(),
        payloadSha256: "a".repeat(64),
        confirmed: true,
        requestId: randomUUID(),
      },
    ])
      expect(
        (await request(f.sid, `${f.invoice.id}/delivery/send`, body)).status,
      ).toBe(400);
  });
  it("rejects unsafe origins and non-JSON before preview/send services", async () => {
    const f = await fixture();
    const preview = vi.spyOn(delivery, "previewInvoiceDelivery");
    for (const [headers, status] of [
      [{ Origin: "https://foreign.example" }, 403],
      [{ "Sec-Fetch-Site": "cross-site" }, 403],
      [{ "Content-Type": "text/plain" }, 415],
    ] as const) {
      expect(
        (
          await request(
            f.sid,
            `${f.invoice.id}/delivery/preview`,
            { expectedVersion: 2 },
            headers,
          )
        ).status,
      ).toBe(status);
    }
    expect(preview).not.toHaveBeenCalled();
  });
  it.each(["http://localhost:3001", "https://growth.example"])(
    "passes only member-scoped identity and the exact reviewed send body with configured origin %s",
    async (appOrigin) => {
      vi.stubEnv("APP_ORIGIN", appOrigin);
      const f = await fixture();
      const input = {
        previewId: randomUUID(),
        payloadSha256: "a".repeat(64),
        confirmed: true as const,
      };
      const current = await delivery.getInvoiceDelivery(
        f.org,
        f.id,
        f.invoice.id,
      );
      const send = vi
        .spyOn(delivery, "sendInvoiceDelivery")
        .mockResolvedValue(current);
      expect(
        (
          await request(f.sid, `${f.invoice.id}/delivery/send`, input, {
            Origin: appOrigin,
          })
        ).status,
      ).toBe(200);
      expect(send).toHaveBeenCalledExactlyOnceWith(
        f.org,
        f.id,
        f.invoice.id,
        input,
      );
    },
  );
});
