import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  appointmentsTable,
  contactsTable,
  db,
  invoicePaymentLinksTable,
  leadsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";

import app from "../../app";
import { createSession, deleteSession } from "../../lib/auth";
import { createInvoice, issueInvoice } from "../../services/invoices";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

const orgs: string[] = [];
const sessions: string[] = [];
const transport = globalThis.fetch;
let server: Server, base: string;

beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "synthetic-field-day-route-secret");
  vi.stubEnv("APP_ORIGIN", "https://field-day.example");
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const sid of sessions) await deleteSession(sid);
  await deleteTestOrgs(...orgs);
  vi.unstubAllEnvs();
});

async function member(org: string, role: "owner" | "production") {
  const [user] = await db.insert(usersTable).values({ organizationId: org, role, firstName: role === "owner" ? "Avery" : "Sam", emailVerifiedAt: new Date() }).returning();
  const sid = await createSession({ user: { id: user!.id, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic" });
  sessions.push(sid);
  const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
    transport(base + path, {
      method: init.method ?? "GET",
      headers: { origin: "https://field-day.example", cookie: `sid=${sid}`, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  return { user: user!, call };
}

async function company() {
  const [org] = await db.insert(organizationsTable).values({ name: "Synthetic Field Routes", slug: `test-field-routes-${randomUUID()}`, timezone: "UTC" }).returning();
  orgs.push(org!.id);
  const owner = await member(org!.id, "owner");
  const tech = await member(org!.id, "production");
  const [contact] = await db.insert(contactsTable).values({ organizationId: org!.id, firstName: "Dana", phone: "+15125550142" }).returning();
  const [lead] = await db.insert(leadsTable).values({ organizationId: org!.id, contactId: contact!.id, assignedUserId: owner.user.id }).returning();
  return { orgId: org!.id, owner, tech, contact: contact!, lead: lead! };
}

describe("field day routes", () => {
  it("returns only the signed-in member's own appointments, scoped to their company", async () => {
    const a = await company();
    const b = await company();
    const now = Date.now();
    const [mine] = await db.insert(appointmentsTable).values({ organizationId: a.orgId, leadId: a.lead.id, contactId: a.contact.id, assignedUserId: a.tech.user.id, scheduledStart: new Date(now - 30 * 60_000), scheduledEnd: new Date(now + 60 * 60_000) }).returning();
    await db.insert(appointmentsTable).values({ organizationId: a.orgId, leadId: a.lead.id, contactId: a.contact.id, assignedUserId: a.owner.user.id, scheduledStart: new Date(now - 30 * 60_000), scheduledEnd: new Date(now + 60 * 60_000) });
    const response = await a.tech.call("/contractor/my-day");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { organizationId: string; today: { id: string; invoices: unknown }[]; upcoming: unknown[]; canCollectPayments: boolean };
    expect(body.organizationId).toBe(a.orgId);
    expect(body.today.map((job) => job.id)).toEqual([mine!.id]);
    expect(body.today[0]!.invoices).toBeNull();
    expect(body.canCollectPayments).toBe(false);
    const other = await (await b.tech.call("/contractor/my-day")).json() as { today: unknown[]; upcoming: unknown[] };
    expect([...other.today, ...other.upcoming]).toEqual([]);
    expect((await a.tech.call("/contractor/my-day?date=not-a-date")).status).toBe(400);
  });

  it("serves a QR of an open pay link to invoice readers only, and refuses closed links", async () => {
    const f = await company();
    const draft = (await createInvoice(f.orgId, f.owner.user.id, { requestId: randomUUID(), leadId: f.lead.id, document: { title: "Synthetic repair", currency: "USD", issuerName: "Synthetic", customerName: "Dana", lineItems: [{ description: "Work", quantity: "1", unitPriceCents: 10000 }], taxCents: 0 } })).invoice;
    const invoice = (await issueInvoice(f.orgId, f.owner.user.id, draft.id, { requestId: randomUUID(), expectedVersion: draft.version, confirmed: true })).invoice;
    const insertLink = async (state: "open" | "expired") => (await db.insert(invoicePaymentLinksTable).values({ organizationId: f.orgId, invoiceId: invoice.id, invoiceVersion: invoice.version, amountCents: 10000, stripeAccountId: "acct_synthetic", checkoutSessionId: `cs_test_${randomUUID().replace(/-/g, "")}`, checkoutUrl: "https://checkout.stripe.test/c/qr", state, createdByUserId: f.owner.user.id, expiresAt: new Date(Date.now() + 86_400_000) }).returning())[0]!;
    const closed = await insertLink("expired");
    const open = await insertLink("open");

    const ok = await f.owner.call(`/invoices/${invoice.id}/payment-links/${open.id}/qr`);
    expect(ok.status).toBe(200);
    const body = await ok.json() as { linkId: string; url: string; qrDataUrl: string };
    expect(body).toMatchObject({ linkId: open.id, url: "https://checkout.stripe.test/c/qr" });
    expect(body.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    expect((await f.owner.call(`/invoices/${invoice.id}/payment-links/${closed.id}/qr`)).status).toBe(409);
    expect((await f.owner.call(`/invoices/${invoice.id}/payment-links/${randomUUID()}/qr`)).status).toBe(404);
    expect((await f.tech.call(`/invoices/${invoice.id}/payment-links/${open.id}/qr`)).status).toBe(403);
    expect((await f.tech.call(`/integrations/zapier/flows/invoices/${invoice.id}/pay-link-text`, { method: "POST", body: {} })).status).toBe(403);
  });

  it("validates the On My Way ETA before anything is requested", async () => {
    const f = await company();
    const [visit] = await db.insert(appointmentsTable).values({ organizationId: f.orgId, leadId: f.lead.id, contactId: f.contact.id, assignedUserId: f.tech.user.id, scheduledStart: new Date(Date.now() - 30 * 60_000) }).returning();
    expect((await f.tech.call(`/integrations/zapier/flows/appointments/${visit!.id}/on-my-way`, { method: "POST", body: { etaMinutes: 999 } })).status).toBe(400);
    expect((await f.tech.call(`/integrations/zapier/flows/appointments/not-a-uuid/on-my-way`, { method: "POST", body: {} })).status).toBe(400);
  });
});
