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
  stripeConnectAccountsTable,
  usersTable,
} from "@workspace/db";

import { eq } from "drizzle-orm";

import app from "../../app";
import { createSession, deleteSession } from "../../lib/auth";
import { createInvoice, issueInvoice } from "../../services/invoices";
import { setConnectStripeForTests } from "../../services/stripe-connect";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

const orgs: string[] = [];
const sessions: string[] = [];
const transport = globalThis.fetch;
let server: Server, base: string;

/** In-memory sandbox Stripe: records Checkout creations; no network. */
const checkouts: unknown[] = [];
const fakeStripe = {
  checkout: {
    sessions: {
      create: vi.fn(async (...args: unknown[]) => {
        checkouts.push(args);
        const live = process.env.STRIPE_CONNECT_MODE === "live";
        return { id: `cs_${live ? "live" : "test"}_field${checkouts.length}`, livemode: live, url: `https://checkout.stripe.test/c/field${checkouts.length}`, expires_at: Math.floor(Date.now() / 1000) + 86_400 };
      }),
    },
  },
};

beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "synthetic-field-day-route-secret");
  vi.stubEnv("APP_ORIGIN", "https://field-day.example");
  vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_synthetic");
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "false");
  setConnectStripeForTests(fakeStripe as never);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
});
afterAll(async () => {
  setConnectStripeForTests(undefined);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const sid of sessions) await deleteSession(sid);
  await deleteTestOrgs(...orgs);
  vi.unstubAllEnvs();
});

async function member(org: string, role: "owner" | "production" | "viewer") {
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
    expect(body.today[0]!.invoices).toEqual([]);
    expect(body.canCollectPayments).toBe(true);
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

  it("lets a tech collect on their own job only: link, QR and text, refused elsewhere and across companies", async () => {
    const f = await company();
    await db.insert(stripeConnectAccountsTable).values({ organizationId: f.orgId, stripeAccountId: "acct_field_synthetic", chargesEnabled: true, detailsSubmitted: true });
    const draft = (await createInvoice(f.orgId, f.owner.user.id, { requestId: randomUUID(), leadId: f.lead.id, document: { title: "Synthetic repair", currency: "USD", issuerName: "Synthetic", customerName: "Dana", lineItems: [{ description: "Work", quantity: "1", unitPriceCents: 15000 }], taxCents: 0 } })).invoice;
    const invoice = (await issueInvoice(f.orgId, f.owner.user.id, draft.id, { requestId: randomUUID(), expectedVersion: draft.version, confirmed: true })).invoice;
    const visit = async (assignedUserId: string, leadId = f.lead.id) =>
      (await db.insert(appointmentsTable).values({ organizationId: f.orgId, leadId, contactId: f.contact.id, assignedUserId, scheduledStart: new Date(Date.now() - 30 * 60_000) }).returning())[0]!;
    const mine = await visit(f.tech.user.id);
    const base = `/appointments/${mine.id}/invoices/${invoice.id}`;

    // The office-only paths stay closed to the tech.
    expect((await f.tech.call(`/invoices/${invoice.id}/payment-links`, { method: "POST", body: {} })).status).toBe(403);
    expect((await f.tech.call(`/invoices/${invoice.id}`)).status).toBe(403);

    expect(await (await f.tech.call(`${base}/payment-links`)).json()).toMatchObject({ links: [], readiness: { configured: true, mode: "test", onboarding: "ready", canCreateLinks: true, message: null } });
    const created = await f.tech.call(`${base}/payment-links`, { method: "POST", body: {} });
    expect(created.status).toBe(201);
    const { link } = await created.json() as { link: { id: string; amountCents: number; url: string } };
    expect(link).toMatchObject({ amountCents: 15000, url: "https://checkout.stripe.test/c/field1" });
    // Reuse, not a second Checkout.
    expect((await (await f.tech.call(`${base}/payment-links`, { method: "POST", body: {} })).json() as { link: { id: string } }).link.id).toBe(link.id);
    expect(checkouts).toHaveLength(1);
    const qr = await f.tech.call(`${base}/payment-links/${link.id}/qr`);
    expect(qr.status).toBe(200);
    expect((await qr.json() as { qrDataUrl: string }).qrDataUrl).toMatch(/^data:image\/png;base64,/);
    // The text request passes the job scope and then hits the customer's text consent (none recorded here).
    const text = await f.tech.call(`/integrations/zapier/flows${base}/pay-link-text`, { method: "POST", body: {} });
    expect(text.status).toBe(400);
    expect((await text.json() as { error: string }).error).toMatch(/not agreed to receive texts/);

    // Someone else's job, a job for a different lead, a viewer and another company are refused.
    const theirs = await visit(f.owner.user.id);
    expect((await f.tech.call(`/appointments/${theirs.id}/invoices/${invoice.id}/payment-links`, { method: "POST", body: {} })).status).toBe(404);
    const [otherLead] = await db.insert(leadsTable).values({ organizationId: f.orgId, contactId: f.contact.id }).returning();
    const unlinked = await visit(f.tech.user.id, otherLead!.id);
    for (const path of [`/appointments/${unlinked.id}/invoices/${invoice.id}/payment-links`, `/appointments/${unlinked.id}/invoices/${invoice.id}/payment-links/${link.id}/qr`]) {
      expect((await f.tech.call(path)).status).toBe(403);
    }
    expect((await f.tech.call(`/integrations/zapier/flows/appointments/${unlinked.id}/invoices/${invoice.id}/pay-link-text`, { method: "POST", body: {} })).status).toBe(403);
    const viewer = await member(f.orgId, "viewer");
    expect((await viewer.call(`${base}/payment-links`)).status).toBe(403);
    const other = await company();
    expect((await other.tech.call(`${base}/payment-links`)).status).toBe(404);
    expect((await other.tech.call(`${base}/payment-links/${link.id}/qr`)).status).toBe(404);
    expect(checkouts).toHaveLength(1);
  });

  it("keeps field collection scoped to the tech's own job in live mode, and explains an unready account", async () => {
    vi.stubEnv("STRIPE_CONNECT_MODE", "live");
    checkouts.length = 0;
    try {
      const f = await company();
      // A test-mode account does not count in live mode.
      await db.insert(stripeConnectAccountsTable).values({ organizationId: f.orgId, stripeAccountId: `acct_field_test_${f.orgId}`, mode: "test", chargesEnabled: true, detailsSubmitted: true });
      const draft = (await createInvoice(f.orgId, f.owner.user.id, { requestId: randomUUID(), leadId: f.lead.id, document: { title: "Synthetic repair", currency: "USD", issuerName: "Synthetic", customerName: "Dana", lineItems: [{ description: "Work", quantity: "1", unitPriceCents: 12000 }], taxCents: 0 } })).invoice;
      const invoice = (await issueInvoice(f.orgId, f.owner.user.id, draft.id, { requestId: randomUUID(), expectedVersion: draft.version, confirmed: true })).invoice;
      const [mine] = await db.insert(appointmentsTable).values({ organizationId: f.orgId, leadId: f.lead.id, contactId: f.contact.id, assignedUserId: f.tech.user.id, scheduledStart: new Date(Date.now() - 30 * 60_000) }).returning();
      const base = `/appointments/${mine!.id}/invoices/${invoice.id}`;

      const notConnected = await (await f.tech.call(`${base}/payment-links`)).json() as { readiness: { mode: string; onboarding: string; canCreateLinks: boolean; message: string } };
      expect(notConnected.readiness).toMatchObject({ mode: "live", onboarding: "not_started", canCreateLinks: false });
      expect(notConnected.readiness.message).toMatch(/Stripe is not connected/);
      const refused = await f.tech.call(`${base}/payment-links`, { method: "POST", body: {} });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: "not_connected" });

      const [live] = await db.insert(stripeConnectAccountsTable).values({ organizationId: f.orgId, stripeAccountId: `acct_field_live_${f.orgId}`, mode: "live", detailsSubmitted: false, requirements: { currentlyDue: ["external_account"], pastDue: [], pendingVerification: [], disabledReason: "requirements.past_due", currentDeadline: null } }).returning();
      const notReady = await f.tech.call(`${base}/payment-links`, { method: "POST", body: {} });
      expect(notReady.status).toBe(409);
      expect(await notReady.json()).toMatchObject({ code: "not_ready" });
      expect(((await (await f.tech.call(`${base}/payment-links`)).json()) as { readiness: { onboarding: string } }).readiness.onboarding).toBe("needs_info");

      await db.update(stripeConnectAccountsTable).set({ chargesEnabled: true, detailsSubmitted: true, requirements: null }).where(eq(stripeConnectAccountsTable.id, live!.id));
      const created = await f.tech.call(`${base}/payment-links`, { method: "POST", body: {} });
      expect(created.status).toBe(201);
      const { link } = await created.json() as { link: { id: string; mode: string; url: string } };
      expect(link).toMatchObject({ mode: "live", url: "https://checkout.stripe.test/c/field1" });
      expect((checkouts[0] as [unknown, { stripeAccount: string }])[1].stripeAccount).toBe(`acct_field_live_${f.orgId}`);

      // Still only the tech's own job, in live mode too.
      const [theirs] = await db.insert(appointmentsTable).values({ organizationId: f.orgId, leadId: f.lead.id, contactId: f.contact.id, assignedUserId: f.owner.user.id, scheduledStart: new Date(Date.now() - 30 * 60_000) }).returning();
      expect((await f.tech.call(`/appointments/${theirs!.id}/invoices/${invoice.id}/payment-links`, { method: "POST", body: {} })).status).toBe(404);
      expect((await f.tech.call(`/appointments/${theirs!.id}/invoices/${invoice.id}/payment-links/${link.id}/qr`)).status).toBe(404);
      const other = await company();
      expect((await other.tech.call(`${base}/payment-links`)).status).toBe(404);
      expect(checkouts).toHaveLength(1);
    } finally {
      vi.stubEnv("STRIPE_CONNECT_MODE", "test");
    }
  });
});
