import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import {
  activitiesTable,
  auditEventsTable,
  consentRecordsTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  smartSitesTable,
  suppressionsTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import manualSmsRouter from "../routes/v1/manual-sms";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  buildManualSmsTemplates,
  getManualSmsDrafts,
  normalizeManualSmsPhone,
  prepareManualSmsDraft,
  type ManualSmsDrafts,
} from "./manual-sms";
import { addSuppression, checkSendEligibility } from "./send-gate";
import { normalizeSmartSiteIntake } from "./smart-site-contract";
import { captureSmartSiteInquiry } from "./smart-sites";

describe("manual SMS recipient and template safety", () => {
  it.each([
    ["404-555-0199", "+14045550199"],
    ["(404) 555-0199", "+14045550199"],
    ["1 404 555 0199", "+14045550199"],
    ["+1 (404) 555-0199", "+14045550199"],
    ["+44 20 7946 0123", "+442079460123"],
  ])("normalizes one recipient: %s", (raw, expected) => {
    expect(normalizeManualSmsPhone(raw)).toBe(expected);
  });

  it.each([
    "", "0000000000", "1234", "+01234567890", "442079460123",
    "4045550199?body=injected", "4045550199&body=x", "sms:4045550199",
    "4045550199,4045550188", "4045550199;4045550188", "4045550199\n",
    "4045550199\r", "4045550199\t", "4045550199 ext 2", "+14045550199#2",
    "++14045550199", "+1+4045550199", "+1234567890123456", "４０４５５５０１９９",
  ])("rejects unsafe or ambiguous recipient: %j", (raw) => {
    expect(normalizeManualSmsPhone(raw)).toBeNull();
  });

  it("returns exactly three bounded requested-service templates without control characters", () => {
    const templates = buildManualSmsTemplates({
      companyName: `Service\r\nShop${"x".repeat(500)}`,
      customerFirstName: "Avery\u202e\n",
      staffFirstName: "Sam\u0000",
    });
    expect(templates.map((t) => t.id)).toEqual(["first-response", "arrange-visit", "follow-up"]);
    for (const template of templates) {
      expect(template.body).not.toMatch(/[\u0000-\u001f\u202a-\u202e]/);
      expect(template.body.length).toBeLessThan(400);
      expect(template.body).toContain("Avery");
      expect(template.body).toContain("Sam");
    }
    expect(templates[1].body).toContain("confirm availability");
    expect(templates[2].body).toContain("service request");
  });
});

describe("manual SMS session, policy and evidence boundary", () => {
  let orgA: string;
  let orgB: string;
  let userA: string;
  let userB: string;
  let viewerA: string;
  let contactA: string;
  let leadA: string;
  let leadB: string;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const stamp = randomUUID();
    const orgs = await db.insert(organizationsTable).values([
      { name: "Synthetic Service A", slug: `manual-sms-a-${stamp}` },
      { name: "Synthetic Service B", slug: `manual-sms-b-${stamp}` },
    ]).returning();
    [orgA, orgB] = orgs.map((o) => o.id);
    const users = await db.insert(usersTable).values([
      { organizationId: orgA, role: "owner", firstName: "Sam", email: `sms-a-${stamp}@example.test` },
      { organizationId: orgB, role: "owner", email: `sms-b-${stamp}@example.test` },
      { organizationId: orgA, role: "viewer", email: `sms-view-${stamp}@example.test` },
    ]).returning();
    [userA, userB, viewerA] = users.map((u) => u.id);
    const contacts = await db.insert(contactsTable).values([
      { organizationId: orgA, firstName: "Avery", phone: "404-555-0199" },
      { organizationId: orgB, firstName: "Other", phone: "404-555-0188" },
    ]).returning();
    contactA = contacts[0].id;
    const leads = await db.insert(leadsTable).values([
      { organizationId: orgA, contactId: contactA },
      { organizationId: orgB, contactId: contacts[1].id },
    ]).returning();
    [leadA, leadB] = leads.map((l) => l.id);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const id = req.get("x-test-user");
      req.isAuthenticated = (() => Boolean(id)) as typeof req.isAuthenticated;
      if (id) req.user = { id } as Express.User;
      next();
    });
    app.use(manualSmsRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    await db.update(usersTable).set({ isActive: true, role: "owner", organizationId: orgA }).where(eq(usersTable.id, userA));
    await db.update(contactsTable).set({ phone: "404-555-0199", doNotContact: false, doNotContactSms: false }).where(eq(contactsTable.id, contactA));
    await db.delete(suppressionsTable).where(eq(suppressionsTable.organizationId, orgA));
    await db.delete(consentRecordsTable).where(eq(consentRecordsTable.organizationId, orgA));
    await db.delete(auditEventsTable).where(eq(auditEventsTable.organizationId, orgA));
    await db.insert(consentRecordsTable).values({
      organizationId: orgA, contactId: contactA, channel: "sms", granted: true,
      disclosureVersion: "synthetic-requested-service-v1", recordedAt: new Date(Date.now() - 2_000),
    });
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await deleteTestOrgs(orgA, orgB);
  });

  async function request(path: string, options: { user?: string | null; body?: unknown; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...options.headers };
    const user = options.user === undefined ? userA : options.user;
    if (user) headers["x-test-user"] = user;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${base}${path}`, {
      method: options.body === undefined ? "GET" : "POST",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, headers: response.headers, data: await response.json() as ManualSmsDrafts };
  }
  const prepareBody = { templateId: "first-response", confirmedServiceReply: true };
  const getPath = () => `/leads/${leadA}/manual-sms`;
  const preparePath = () => `${getPath()}/draft-opened`;

  it("prepares under provider hold without Twilio and does not claim send, contact or stage progress", async () => {
    const beforeLead = await db.select().from(leadsTable).where(eq(leadsTable.id, leadA));
    const get = await request(getPath());
    expect(get.status).toBe(200);
    expect(get.headers.get("cache-control")).toContain("no-store");
    expect(get.data).toMatchObject({ allowed: true, phoneE164: "+14045550199", orgId: orgA });
    expect(get.data.templates).toHaveLength(3);
    expect(get.data.templates[0].body).toContain("Sam with Synthetic Service A");
    expect(await db.select().from(auditEventsTable).where(eq(auditEventsTable.organizationId, orgA))).toHaveLength(0);

    const prepared = await request(preparePath(), { body: prepareBody });
    expect(prepared.status).toBe(200);
    expect(prepared.data).toMatchObject({ allowed: true, prepared: true, templateId: "first-response" });
    const audit = await db.select().from(auditEventsTable).where(eq(auditEventsTable.organizationId, orgA));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "lead.manual_sms_prepared", entityId: leadA, actorUserId: userA });
    expect(audit[0].metadata).toEqual({
      templateId: "first-response", channel: "sms", outcome: "draft_prepared",
      requestedServiceReplyConfirmed: true, providerAttempted: false, sentVerified: false,
    });
    expect(JSON.stringify(audit[0])).not.toContain("4045550199");
    expect(JSON.stringify(audit[0])).not.toContain("Avery");
    expect(await db.select().from(activitiesTable).where(eq(activitiesTable.organizationId, orgA))).toHaveLength(0);
    expect(await db.select().from(consentRecordsTable).where(eq(consentRecordsTable.organizationId, orgA))).toHaveLength(1);
    expect(await db.select().from(leadsTable).where(eq(leadsTable.id, leadA))).toEqual(beforeLead);
  });

  it.each(["doNotContact", "doNotContactSms"] as const)("blocks %s without exposing draft contents", async (flag) => {
    await db.update(contactsTable).set({ [flag]: true }).where(eq(contactsTable.id, contactA));
    const result = await request(getPath());
    expect(result.data).toMatchObject({ allowed: false, phoneE164: null, templates: [] });
    expect((await request(preparePath(), { body: prepareBody })).status).toBe(409);
    expect(await db.select().from(auditEventsTable).where(eq(auditEventsTable.organizationId, orgA))).toHaveLength(0);
  });

  it("rechecks an address STOP suppression added after the preview", async () => {
    expect((await request(getPath())).data.allowed).toBe(true);
    await addSuppression({ organizationId: orgA, channel: "sms", value: "+1 (404) 555-0199", reason: "stop_keyword", source: "synthetic-test" });
    const result = await request(preparePath(), { body: prepareBody });
    expect(result.status).toBe(409);
    expect(result.data).toMatchObject({ allowed: false, reason: "suppressed:stop_keyword", phoneE164: null, templates: [] });
  });

  it("requires existing affirmative SMS consent and never creates it from confirmation", async () => {
    await db.delete(consentRecordsTable).where(eq(consentRecordsTable.organizationId, orgA));
    const result = await request(preparePath(), { body: prepareBody });
    expect(result.status).toBe(409);
    expect(result.data.reason).toBe("no_sms_consent");
    expect(await db.select().from(consentRecordsTable).where(eq(consentRecordsTable.organizationId, orgA))).toHaveLength(0);
  });

  it("honors latest consent revocation before preparation", async () => {
    expect((await request(getPath())).data.allowed).toBe(true);
    await db.insert(consentRecordsTable).values({
      organizationId: orgA, contactId: contactA, channel: "sms", granted: false,
      disclosureVersion: "synthetic-revoked", recordedAt: new Date(),
    });
    expect((await request(preparePath(), { body: prepareBody })).data.reason).toBe("no_sms_consent");
  });

  it("rejects unsafe changed phone and missing phone at the server", async () => {
    await db.update(contactsTable).set({ phone: "4045550199?body=evil" }).where(eq(contactsTable.id, contactA));
    expect((await request(preparePath(), { body: prepareBody })).data.reason).toBe("invalid_phone");
    await db.update(contactsTable).set({ phone: null }).where(eq(contactsTable.id, contactA));
    expect((await request(getPath())).data.reason).toBe("no_phone");
  });

  it.each([
    {}, { templateId: "first-response" }, { templateId: "first-response", confirmedServiceReply: false },
    { templateId: "marketing", confirmedServiceReply: true },
    { ...prepareBody, phoneE164: "+14045550188" },
    { ...prepareBody, organizationId: "injected" },
  ])("requires a valid template, confirmation and no caller-supplied recipient/context: %j", async (body) => {
    expect((await request(preparePath(), { body })).status).toBe(400);
  });

  it("requires a human session even when an API key header is present", async () => {
    expect((await request(getPath(), { user: null })).status).toBe(401);
    expect((await request(getPath(), { headers: { "x-api-key": "synthetic-no-lookup" } })).status).toBe(401);
    expect((await request(preparePath(), { body: prepareBody, user: null })).status).toBe(401);
  });

  it("blocks read-only and revoked staff", async () => {
    expect((await request(getPath(), { user: viewerA })).status).toBe(403);
    await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, userA));
    expect((await request(preparePath(), { body: prepareBody })).status).toBe(403);
  });

  it("does not expose another tenant or stale organization membership", async () => {
    expect((await request(getPath(), { user: userB })).status).toBe(404);
    expect((await request(`/leads/${leadB}/manual-sms`)).status).toBe(404);
    await db.update(usersTable).set({ organizationId: orgB }).where(eq(usersTable.id, userA));
    expect((await request(preparePath(), { body: prepareBody })).status).toBe(404);
  });

  it("validates IDs and hides mismatched contact tenant joins", async () => {
    expect((await request("/leads/not-a-uuid/manual-sms")).status).toBe(400);
    expect((await request(`/leads/${randomUUID()}/manual-sms`)).status).toBe(404);
    await db.update(contactsTable).set({ organizationId: orgB }).where(eq(contactsTable.id, contactA));
    try {
      expect((await request(getPath())).status).toBe(404);
    } finally {
      await db.update(contactsTable).set({ organizationId: orgA }).where(and(eq(contactsTable.id, contactA), eq(contactsTable.organizationId, orgB)));
    }
  });
});

// GAP-02: a website inquiry that explicitly consented to SMS may be answered by
// a staff member from their own phone, about THAT inquiry, to the number given
// in it. It never becomes contact-wide, automated, marketing or sequence consent.
describe("inquiry-scoped SMS consent from a website inquiry", () => {
  const orgs: string[] = [];
  afterAll(async () => { await deleteTestOrgs(...orgs.splice(0)); });

  async function inquiryFixture(channels: ("phone" | "email" | "sms")[], phone = "404-555-0177") {
    const stamp = randomUUID();
    const [org] = await db.insert(organizationsTable).values({ name: "Synthetic Inquiry Co", slug: `inquiry-sms-${stamp}` }).returning();
    orgs.push(org.id);
    const [owner] = await db.insert(usersTable).values({
      organizationId: org.id, role: "owner", firstName: "Sam", isActive: true,
      email: `inquiry-sms-${stamp}@example.test`, emailVerifiedAt: new Date(),
    }).returning();
    const [site] = await db.insert(smartSitesTable).values({
      organizationId: org.id, name: "Synthetic site", siteKey: stamp, profile: "hvac",
      source: "synthetic", keyHash: "0".repeat(64), isActive: true,
    }).returning();
    const saved = await captureSmartSiteInquiry(site, normalizeSmartSiteIntake({
      schemaVersion: 1, requestId: randomUUID(),
      contact: { name: "Avery Visitor", email: `visitor-${stamp}@example.invalid`, phone },
      project: { serviceCode: "repair", timing: "soon", summary: "Synthetic inquiry" },
      consent: { contact: true, analytics: false, policyVersion: "synthetic-test-v1", channels },
    }));
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, saved.leadId));
    const [contact] = await db.select().from(contactsTable).where(eq(contactsTable.id, lead.contactId!));
    return { orgId: org.id, owner, leadId: lead.id, contact };
  }
  const drafts = (f: { orgId: string; leadId: string }) =>
    getManualSmsDrafts({ organizationId: f.orgId, leadId: f.leadId, staffFirstName: "Sam" });

  it("allows a staff manual reply about the consented inquiry to the phone given in it", async () => {
    const f = await inquiryFixture(["phone", "sms"]);
    expect(await db.select().from(consentRecordsTable).where(eq(consentRecordsTable.organizationId, f.orgId))).toHaveLength(0);
    expect(await drafts(f)).toMatchObject({ allowed: true, reason: null, phoneE164: "+14045550177" });
    const prepared = await prepareManualSmsDraft({
      organizationId: f.orgId, actorUserId: f.owner.id, staffFirstName: "Sam", leadId: f.leadId, templateId: "first-response",
    });
    expect(prepared).toMatchObject({ allowed: true, prepared: true });
    // Nothing contact-wide is created from inquiry consent.
    expect(await db.select().from(consentRecordsTable).where(eq(consentRecordsTable.organizationId, f.orgId))).toHaveLength(0);
  });

  it("does not extend to another lead for the same contact or another contact with the same phone", async () => {
    const f = await inquiryFixture(["sms"]);
    const [sameContactLead] = await db.insert(leadsTable).values({ organizationId: f.orgId, contactId: f.contact.id }).returning();
    expect(await drafts({ orgId: f.orgId, leadId: sameContactLead.id })).toMatchObject({ allowed: false, reason: "no_sms_consent" });
    const [twin] = await db.insert(contactsTable).values({ organizationId: f.orgId, firstName: "Twin", phone: "404-555-0177" }).returning();
    const [twinLead] = await db.insert(leadsTable).values({ organizationId: f.orgId, contactId: twin.id }).returning();
    expect(await drafts({ orgId: f.orgId, leadId: twinLead.id })).toMatchObject({ allowed: false, reason: "no_sms_consent" });
  });

  it("does not follow the contact to a different phone number than the inquiry gave", async () => {
    const f = await inquiryFixture(["sms"]);
    await db.update(contactsTable).set({ phone: "404-555-0166" }).where(eq(contactsTable.id, f.contact.id));
    expect(await drafts(f)).toMatchObject({ allowed: false, reason: "no_sms_consent" });
  });

  it("never unlocks automated, sequence or marketing SMS for the consented lead", async () => {
    const f = await inquiryFixture(["sms"]);
    for (const kind of ["transactional", "outreach"] as const) {
      expect(await checkSendEligibility({ organizationId: f.orgId, leadId: f.leadId, contact: f.contact, channel: "sms", kind }))
        .toMatchObject({ ok: false, reason: "no_sms_consent" });
      expect(await checkSendEligibility({ organizationId: f.orgId, contact: f.contact, channel: "sms", kind }))
        .toMatchObject({ ok: false, reason: "no_sms_consent" });
    }
    // Even the explicit manual-reply marker cannot be combined with outreach.
    expect(await checkSendEligibility({
      organizationId: f.orgId, leadId: f.leadId, manualInquiryReplyLeadId: f.leadId, contact: f.contact, channel: "sms", kind: "outreach",
    })).toMatchObject({ ok: false, reason: "no_sms_consent" });
  });

  it("lets a later opt-out win over the inquiry consent", async () => {
    const f = await inquiryFixture(["sms"]);
    expect((await drafts(f))?.allowed).toBe(true);
    await db.insert(consentRecordsTable).values({
      organizationId: f.orgId, contactId: f.contact.id, channel: "sms", granted: false,
      disclosureVersion: "synthetic-opt-out", recordedAt: new Date(Date.now() + 1_000),
    });
    expect(await drafts(f)).toMatchObject({ allowed: false, reason: "no_sms_consent" });
  });

  it("lets a STOP suppression and do-not-text flag win over the inquiry consent", async () => {
    const f = await inquiryFixture(["sms"]);
    await addSuppression({ organizationId: f.orgId, channel: "sms", value: "4045550177", reason: "stop_keyword", source: "synthetic-test" });
    expect(await drafts(f)).toMatchObject({ allowed: false, reason: "suppressed:stop_keyword" });
    const g = await inquiryFixture(["sms"], "404-555-0155");
    await db.update(contactsTable).set({ doNotContactSms: true }).where(eq(contactsTable.id, g.contact.id));
    expect(await drafts(g)).toMatchObject({ allowed: false, reason: "do_not_contact_sms" });
  });

  it("stays blocked when the inquiry did not consent to SMS", async () => {
    const f = await inquiryFixture(["phone", "email"]);
    expect(await drafts(f)).toMatchObject({ allowed: false, reason: "no_sms_consent" });
  });
});
