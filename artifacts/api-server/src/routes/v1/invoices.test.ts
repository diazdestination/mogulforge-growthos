import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
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
import { eq } from "drizzle-orm";
import {
  db,
  organizationsTable,
  usersTable,
  contactsTable,
  leadsTable,
  invoicesTable,
  valueEntriesTable,
  invoiceOperationsTable,
} from "@workspace/db";
import app from "../../app";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import * as apiKeys from "../../services/api-keys";
import * as service from "../../services/invoices";
import type {
  InvoiceDetail,
  InvoiceMutation,
} from "../../services/invoice-contract";

let server: Server;
let origin: string;
const orgs: string[] = [];
const document = {
  title: "Synthetic invoice",
  currency: "USD",
  issuerName: "Synthetic contractor",
  customerName: "Synthetic customer",
  lineItems: [
    {
      description: "Authorized repair",
      quantity: "1.25",
      unitPriceCents: 8000,
    },
  ],
  taxCents: 100,
};
const command = (invoice: InvoiceDetail) => ({
  requestId: randomUUID(),
  expectedVersion: invoice.version,
  confirmed: true,
});
async function user(
  org: string,
  role: "owner" | "office" | "sales_manager" | "viewer" | "production",
  active = true,
) {
  const [row] = await db
    .insert(usersTable)
    .values({
      organizationId: org,
      role,
      isActive: active,
      emailVerifiedAt: new Date(),
      email: `invoice-${randomUUID()}@example.invalid`,
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
async function fixture() {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Synthetic invoice HTTP",
      slug: `invoice-http-${randomUUID()}`,
    })
    .returning();
  orgs.push(org!.id);
  const owner = await user(org!.id, "owner");
  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId: org!.id,
      firstName: "Synthetic",
      lastName: "Customer",
    })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: org!.id, contactId: contact!.id })
    .returning();
  return { org: org!.id, lead: lead!.id, ...owner };
}
function request(
  sid: string,
  path = "",
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  headers: Record<string, string> = {},
) {
  return fetch(`${origin}/api/v1/invoices${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(sid ? { cookie: `sid=${sid}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function created(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await request(f.sid, "", {
    requestId: randomUUID(),
    leadId: f.lead,
    document,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as InvoiceMutation).invoice;
}
beforeAll(async () => {
  const target = new URL(process.env.DATABASE_URL ?? "");
  if (
    process.env.NODE_ENV !== "test" ||
    !(
      target.pathname.endsWith("_test") ||
      (process.env.SCHEDULER_TEST_BACKEND === "pglite" &&
        target.pathname === "/postgres" &&
        ["localhost", "127.0.0.1"].includes(target.hostname))
    )
  )
    throw new Error("Use an isolated test database");
  server = await new Promise<Server>((resolve) => {
    const running = app.listen(0, "127.0.0.1", () => resolve(running));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "https://growth.example");
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

describe("native invoice HTTP authorization and request boundaries", () => {
  it("requires a current active staff role and allows sales managers to read only", async () => {
    const f = await fixture();
    const invoice = await created(f);
    expect((await request("", `/${invoice.id}`)).status).toBe(401);
    for (const role of ["viewer", "production"] as const) {
      const denied = await user(f.org, role);
      expect((await request(denied.sid, `/${invoice.id}`)).status).toBe(403);
      expect(
        (await request(denied.sid, `/${invoice.id}/issue`, command(invoice)))
          .status,
      ).toBe(403);
    }
    const sales = await user(f.org, "sales_manager"),
      office = await user(f.org, "office"),
      inactive = await user(f.org, "owner", false);
    expect((await request(sales.sid, `/${invoice.id}`)).status).toBe(200);
    expect(
      (await request(sales.sid, `/${invoice.id}/issue`, command(invoice)))
        .status,
    ).toBe(403);
    expect((await request(inactive.sid, `/${invoice.id}`)).status).toBe(403);
    expect(
      (await request(office.sid, `/${invoice.id}/issue`, command(invoice)))
        .status,
    ).toBe(200);
    await db
      .update(usersTable)
      .set({ role: "viewer" })
      .where(eq(usersTable.id, office.id));
    expect((await request(office.sid, `/${invoice.id}`)).status).toBe(403);
  });

  it("rejects keys before their resolver and requires JSON and an allowed request origin", async () => {
    const f = await fixture();
    const input = { requestId: randomUUID(), leadId: f.lead, document };
    const resolver = vi.spyOn(apiKeys, "resolveApiKey");
    expect(
      (
        await request(f.sid, "", input, "POST", {
          "x-api-key": "synthetic-not-a-live-key",
        })
      ).status,
    ).toBe(403);
    expect(resolver).not.toHaveBeenCalled();
    expect(
      (
        await request(f.sid, "", input, "POST", {
          "Content-Type": "text/plain",
        })
      ).status,
    ).toBe(415);
    const rejectedHeaders: Record<string, string>[] = [
      { Origin: "https://other.example" },
      { Origin: "null" },
      { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "same-site" },
    ];
    for (const headers of rejectedHeaders) {
      expect((await request(f.sid, "", input, "POST", headers)).status).toBe(
        403,
      );
    }
    expect(
      await db
        .select()
        .from(invoicesTable)
        .where(eq(invoicesTable.organizationId, f.org)),
    ).toHaveLength(0);
    const accepted = await request(f.sid, "", input, "POST", {
      Origin: "https://growth.example",
      "Sec-Fetch-Site": "same-origin",
    });
    expect(accepted.status).toBe(201);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    expect(accepted.headers.get("x-content-type-options")).toBe("nosniff");
    expect(
      (
        await request(f.sid, "", undefined, "GET", {
          Origin: "https://other.example",
        })
      ).status,
    ).toBe(403);
  });

  it("rejects tenant and server-field overrides, malformed values and unrelated tenant identifiers", async () => {
    const f = await fixture(),
      other = await fixture();
    const input = { requestId: randomUUID(), leadId: f.lead, document };
    for (const body of [
      { ...input, organizationId: other.org },
      { ...input, status: "issued" },
      { ...input, invoiceNumber: "INV-FORGED" },
      { ...input, document: { ...document, totalCents: 1 } },
      { ...input, document: { ...document, dueDate: "2026-02-30" } },
      {
        ...input,
        document: {
          ...document,
          lineItems: [
            {
              description: "Bad precision",
              quantity: "1.0001",
              unitPriceCents: 100,
            },
          ],
        },
      },
    ]) {
      const response = await request(f.sid, "", body);
      expect(response.status, await response.clone().text()).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "invoice_invalid_request",
      });
    }
    expect(
      (await request(f.sid, `?organizationId=${other.org}`, input)).status,
    ).toBe(400);
    expect((await request(f.sid, `?organizationId=${other.org}`)).status).toBe(
      400,
    );
    expect(
      (await request(f.sid, "", { ...input, leadId: other.lead })).status,
    ).toBe(404);
    const invoice = await created(f);
    for (const id of [invoice.id, randomUUID()]) {
      const response = await request(other.sid, `/${id}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        code: "invoice_not_found",
        error:
          "The invoice or related record is not available in this company.",
      });
    }
    expect(
      (await request(other.sid, `/${invoice.id}/issue`, command(invoice)))
        .status,
    ).toBe(404);
    expect(await (await request(other.sid)).json()).toMatchObject({
      items: [],
      total: 0,
    });
    expect(
      (await request(f.sid, `/${invoice.id}?organizationId=${other.org}`))
        .status,
    ).toBe(400);
    expect((await request(f.sid, "/not-an-id")).status).toBe(400);
    expect((await request(f.sid, "?page=10001")).status).toBe(400);
  });
});

describe("native invoice HTTP document and receipt actions", () => {
  it("preserves retry identity, requires reviewed current versions, and freezes issued snapshots", async () => {
    const f = await fixture();
    const input = { requestId: randomUUID(), leadId: f.lead, document };
    const first = await request(f.sid, "", input);
    let invoice = ((await first.json()) as InvoiceMutation).invoice;
    const replay = await request(f.sid, "", input);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      duplicate: true,
      invoice: { id: invoice.id },
    });
    expect(
      (
        await request(f.sid, "", {
          ...input,
          document: { ...document, title: "Changed request" },
        })
      ).status,
    ).toBe(409);
    const changed = await request(
      f.sid,
      `/${invoice.id}`,
      {
        requestId: randomUUID(),
        expectedVersion: 1,
        document: { ...document, notes: "Reviewed staff terms" },
      },
      "PATCH",
    );
    expect(changed.status).toBe(200);
    invoice = ((await changed.json()) as InvoiceMutation).invoice;
    const stale = await request(f.sid, `/${invoice.id}/issue`, {
      ...command(invoice),
      expectedVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: "invoice_version_changed",
    });
    expect(
      (
        await request(f.sid, `/${invoice.id}/issue`, {
          ...command(invoice),
          confirmed: false,
        })
      ).status,
    ).toBe(400);
    const issueInput = command(invoice);
    const issued = await request(f.sid, `/${invoice.id}/issue`, issueInput);
    expect(issued.status).toBe(200);
    invoice = ((await issued.json()) as InvoiceMutation).invoice;
    expect(invoice).toMatchObject({
      status: "issued",
      invoiceNumber: "INV-000001",
      subtotalCents: 10000,
      taxCents: 100,
      totalCents: 10100,
      paymentState: "unpaid",
      recordedPaidCents: 0,
      balanceDueCents: 10100,
    });
    expect(invoice.document).toMatchObject({
      notes: "Reviewed staff terms",
      lineItems: [{ quantity: "1.25", totalCents: 10000 }],
    });
    expect(
      await (await request(f.sid, `/${invoice.id}/issue`, issueInput)).json(),
    ).toMatchObject({ duplicate: true });
    expect(
      (
        await request(
          f.sid,
          `/${invoice.id}`,
          {
            requestId: randomUUID(),
            expectedVersion: invoice.version,
            document,
          },
          "PATCH",
        )
      ).status,
    ).toBe(409);
    expect(
      await db
        .select()
        .from(valueEntriesTable)
        .where(eq(valueEntriesTable.organizationId, f.org)),
    ).toHaveLength(0);
    expect(
      await (
        await request(f.sid, `?status=issued&leadId=${f.lead}&page=0`)
      ).json(),
    ).toMatchObject({
      total: 1,
      page: 0,
      pageSize: 25,
      items: [{ id: invoice.id }],
    });
  });

  it("records staff receipt evidence once, preserves cash through unallocation, and voids only after allocation resolution", async () => {
    const f = await fixture();
    let invoice = await created(f);
    invoice = (
      (await (
        await request(f.sid, `/${invoice.id}/issue`, command(invoice))
      ).json()) as InvoiceMutation
    ).invoice;
    const input = {
      ...command(invoice),
      amountCents: 3000,
      sourceReference: `staff-receipt-${randomUUID()}`,
      occurredAt: new Date(Date.now() - 1000).toISOString(),
    };
    for (const invalid of [
      { ...input, amountCents: 0.5 },
      { ...input, occurredAt: new Date(Date.now() + 86400000).toISOString() },
      { ...input, kind: "refund" },
    ])
      expect(
        (await request(f.sid, `/${invoice.id}/payments`, invalid)).status,
      ).toBe(400);
    const saved = await request(f.sid, `/${invoice.id}/payments`, input);
    expect(saved.status).toBe(200);
    invoice = ((await saved.json()) as InvoiceMutation).invoice;
    expect(invoice).toMatchObject({
      recordedPaidCents: 3000,
      balanceDueCents: 7100,
      paymentState: "partial",
    });
    expect(
      await (await request(f.sid, `/${invoice.id}/payments`, input)).json(),
    ).toMatchObject({ duplicate: true });
    expect(
      (
        await request(f.sid, `/${invoice.id}/void`, {
          ...command(invoice),
          reason: "Attempting to void applied cash.",
        })
      ).status,
    ).toBe(409);
    const reversed = await request(
      f.sid,
      `/${invoice.id}/allocations/${invoice.allocations[0]!.id}/reverse`,
      {
        ...command(invoice),
        reason: "Receipt belongs to a different invoice.",
      },
    );
    expect(reversed.status).toBe(200);
    invoice = ((await reversed.json()) as InvoiceMutation).invoice;
    expect(invoice).toMatchObject({
      recordedPaidCents: 0,
      balanceDueCents: 10100,
      availableValueEntries: [
        { kind: "payment", amountCents: 3000, availableCents: 3000 },
      ],
    });
    const available = invoice.availableValueEntries[0]!;
    invoice = (
      (await (
        await request(f.sid, `/${invoice.id}/allocations`, {
          ...command(invoice),
          valueEntryId: available.id,
          amountCents: 3000,
        })
      ).json()) as InvoiceMutation
    ).invoice;
    expect(invoice.recordedPaidCents).toBe(3000);
    const active = invoice.allocations.find(
      (allocation) => allocation.reversedAt === null,
    )!;
    invoice = (
      (await (
        await request(
          f.sid,
          `/${invoice.id}/allocations/${active.id}/reverse`,
          {
            ...command(invoice),
            reason: "Reviewed allocation correction only.",
          },
        )
      ).json()) as InvoiceMutation
    ).invoice;
    const voided = await request(f.sid, `/${invoice.id}/void`, {
      ...command(invoice),
      reason: "Scope replaced by a new agreement.",
    });
    expect(voided.status).toBe(200);
    expect(await voided.json()).toMatchObject({
      invoice: {
        status: "void",
        invoiceNumber: "INV-000001",
        balanceDueCents: 0,
      },
    });
    const cash = await db
      .select()
      .from(valueEntriesTable)
      .where(eq(valueEntriesTable.organizationId, f.org));
    expect(cash.map((entry) => [entry.kind, entry.amountCents])).toEqual([
      ["payment", 3000],
    ]);
  });

  it("returns a bounded retry path without exposing database details", async () => {
    const f = await fixture();
    const invoice = await created(f);
    const before = await db
      .select()
      .from(invoiceOperationsTable)
      .where(eq(invoiceOperationsTable.organizationId, f.org));
    vi.spyOn(service, "getInvoice").mockRejectedValueOnce(
      new Error("synthetic internal SQL detail must stay private"),
    );
    const response = await request(f.sid, `/${invoice.id}`);
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain("invoice_unavailable");
    expect(body).toContain("same request identity");
    expect(body).not.toContain("internal SQL");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await request(f.sid, `/${invoice.id}`)).status).toBe(200);
    expect(
      await db
        .select()
        .from(invoiceOperationsTable)
        .where(eq(invoiceOperationsTable.organizationId, f.org)),
    ).toHaveLength(before.length);
  });
});
