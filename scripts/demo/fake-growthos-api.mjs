// In-memory stand-in for the GrowthOS routes the demo seeder uses. Test-only:
// no network, no database. Shapes follow the product list contracts the
// seeder relies on (plain arrays, { items,total,page }, cursor pages and the
// X-Result-Limit-Reached header). `faults` lets a test replace any response.
import { randomUUID } from "node:crypto";
import { DEMO_COMPANIES } from "./demo-data.mjs";

export function fakePlan(key = "css", overrides = {}) {
  const company = DEMO_COMPANIES[key];
  const staff = Object.fromEntries(company.staff.map((s) => [s.key, randomUUID()]));
  return {
    plan: { target: "local", origin: "http://127.0.0.1:4192", demoDate: "2026-10-17", release: null, instanceId: randomUUID(), holds: {}, companies: {} },
    cplan: { organizationId: randomUUID(), name: company.name, slug: company.slug, timezone: company.timezone, siteId: randomUUID(), staff, ...overrides },
    company,
  };
}

export class FakeGrowthOS {
  constructor({ company, cplan }) {
    this.company = company;
    this.cplan = cplan;
    this.org = { id: cplan.organizationId, name: company.name, slug: company.slug, timezone: company.timezone };
    this.users = company.staff.map((s) => ({ id: cplan.staff[s.key], email: s.email, firstName: s.first, lastName: s.last, role: s.role, isActive: true, operationallyEligible: true }));
    this.meId = cplan.staff.owner;
    this.db = { contacts: [], properties: [], leads: [], estimates: [], assets: [], appointments: [], tasks: [], invoices: [], obligations: [] };
    this.faults = [];
    this.writes = [];
    this.requestIds = new Map();
    this.siteKey = "test-site-key-0123456789abcdef";
  }
  fault(method, pattern, respond) { this.faults.push({ method, pattern, respond }); return this; }
  session() { return { siteId: this.cplan.siteId, siteKey: this.siteKey }; }
  get call() { return (method, p, body) => this.handle(method, p, body); }
  get publicPost() { return (p, body, key) => this.handle("POST", p, body, key); }

  async handle(method, p, body, siteKey) {
    for (const f of this.faults) if (f.method === method && f.pattern.test(p)) { const r = f.respond(p, body, this); if (r) return r; }
    if (method !== "GET") this.writes.push(`${method} ${p.split("?")[0]}`);
    const url = new URL(p, "http://fake.local");
    const q = Object.fromEntries(url.searchParams);
    const seg = url.pathname.split("/").filter(Boolean).slice(2); // drop api, v1
    const res = (status, json, extra = {}) => ({ status, json, limitReached: null, ...extra });
    const now = new Date().toISOString();
    const page = (rows) => { const limit = Number(q.limit ?? 200); const offset = Number(q.offset ?? 0); return rows.slice(offset, offset + limit); };
    const add = (table, row) => { const r = { id: randomUUID(), organizationId: this.org.id, createdAt: now, updatedAt: now, ...row }; this.db[table].push(r); return r; };
    const replay = (kind, requestId, make) => { const k = `${kind}:${requestId}`; if (requestId && this.requestIds.has(k)) return { ...this.requestIds.get(k), duplicate: true }; const out = make(); if (requestId) this.requestIds.set(k, out); return out; };

    if (url.pathname === "/api/readyz") return res(200, { status: "ready", database: "reachable", release: { sha: null, builtAt: null, environment: "unknown" } });
    if (url.pathname.startsWith("/api/v1/public/smart-sites/")) {
      if (siteKey !== this.siteKey || seg[2] !== this.cplan.siteId) return res(401, { code: "unauthorized" });
      if (seg[3] === "check") return res(200, { ok: true });
      const out = replay("intake", body.requestId, () => {
        const [first, ...rest] = body.contact.name.split(" ");
        const contact = add("contacts", { firstName: first, lastName: rest.join(" "), email: body.contact.email, phone: body.contact.phone.replace(/\D/g, "") });
        const prop = add("properties", { contactId: contact.id, addressLine1: body.project.address, city: body.project.city, state: body.project.state, postalCode: body.project.postalCode });
        const lead = add("leads", { contactId: contact.id, propertyId: prop.id, summary: body.project.summary, source: `${this.org.slug}-website`, creationMethod: "smart-site", status: "new", serviceType: "Repair" });
        return { leadId: lead.id };
      });
      return res(201, out);
    }
    const [a, b, c] = seg;
    if (a === "me") return res(200, { id: this.meId, role: this.users.find((u) => u.id === this.meId)?.role ?? "owner", isActive: true, organization: this.org });
    if (a === "users") return res(200, this.users);
    if (a === "smart-sites") return b === "profiles" ? res(200, [{ id: this.company.profile, services: [{ slug: "repair" }] }]) : res(200, { id: b, isActive: true });
    if (a === "contacts" && !b) {
      if (method === "POST") return res(201, add("contacts", body));
      const s = (q.search ?? "").toLowerCase();
      return res(200, page(this.db.contacts.filter((x) => !s || [x.firstName, x.lastName, x.email, x.phone].some((v) => (v ?? "").toLowerCase().includes(s)))));
    }
    if (a === "contacts" && c === "assets") {
      if (method === "POST") { const { requestId, ...rest } = body; return res(201, replay("asset", requestId, () => ({ asset: add("assets", { ...rest, contactId: b, status: "active", version: 1 }) }))); }
      return res(200, { items: this.db.assets.filter((x) => x.contactId === b), hasMore: false, nextCursor: null, limit: 25 });
    }
    if (a === "contacts" && b) { const x = this.db.contacts.find((r) => r.id === b); return x ? res(200, x) : res(404, { error: "Contact not found" }); }
    if (a === "properties") {
      if (method === "POST") { const { propertyType, ...rest } = body; return res(201, add("properties", rest)); }
      return res(200, page(this.db.properties.filter((x) => !q.contactId || x.contactId === q.contactId)));
    }
    if (a === "leads" && b) { const x = this.db.leads.find((r) => r.id === b); return x ? res(200, x) : res(404, {}); }
    if (a === "leads") {
      if (method === "POST") return res(201, add("leads", body));
      const s = (q.search ?? "").toLowerCase();
      return res(200, page(this.db.leads.filter((x) => { const ct = this.db.contacts.find((y) => y.id === x.contactId); return !s || (ct && [ct.firstName, ct.lastName].some((v) => v.toLowerCase().includes(s))); })));
    }
    if (a === "estimates") {
      if (method === "POST") { const lead = this.db.leads.find((l) => l.id === body.leadId); return res(201, add("estimates", { ...body, contactId: lead?.contactId ?? null, propertyId: lead?.propertyId ?? null, sourceKind: "lead", totalCents: body.lineItems.reduce((s, l) => s + l.totalCents, 0) })); }
      return res(200, page(this.db.estimates.filter((x) => (!q.leadId || x.leadId === q.leadId) && (!q.contactId || x.contactId === q.contactId))));
    }
    if (a === "customer-work") {
      const { requestId, confirmed, source, ...rest } = body;
      return res(201, replay("cw", requestId, () => ({ estimate: add("estimates", { ...rest, status: "draft", contactId: source.contactId, propertyId: source.propertyId, sourceKind: "customer_work", totalCents: rest.lineItems.reduce((s, l) => s + Math.round(l.quantity * l.unitPriceCents), 0) }) })));
    }
    if (a === "appointments") {
      if (method === "POST") return res(201, add("appointments", { ...body, status: "scheduled", leadId: body.leadId ?? null }));
      if (method === "PATCH") { const x = this.db.appointments.find((r) => r.id === b); if (!x || x.updatedAt !== body.expectedUpdatedAt) return res(409, { code: "stale" }); x.status = body.status; x.updatedAt = new Date(Date.now() + 1).toISOString(); return res(200, x); }
      return res(200, this.db.appointments.filter((x) => !q.contactId || x.contactId === q.contactId).slice(0, 200));
    }
    if (a === "tasks") {
      if (method === "POST") return res(201, add("tasks", { leadId: null, ...body }));
      return res(200, this.db.tasks.slice(0, 200));
    }
    if (a === "invoices" && !b) {
      if (method === "POST") {
        const out = replay("invoice", body.requestId, () => {
          const d = body.document;
          const lineItems = d.lineItems.map((l) => ({ ...l, totalCents: Math.round(Number(l.quantity) * l.unitPriceCents) }));
          const inv = add("invoices", { contactId: body.source.contactId, propertyId: body.source.propertyId, status: "draft", version: 1, title: d.title, customerName: d.customerName, currency: d.currency, taxCents: 0,
            totalCents: lineItems.reduce((s, l) => s + l.totalCents, 0), recordedPaidCents: 0, paymentState: "unpaid", reconciliationRequired: false, document: { ...d, lineItems } });
          return { invoice: inv };
        });
        return res(201, out);
      }
      const pageNo = Number(q.page ?? 0);
      const items = this.db.invoices.slice(pageNo * 25, pageNo * 25 + 25).map(({ document, ...x }) => x);
      return res(200, { items, total: this.db.invoices.length, page: pageNo, pageSize: 25 });
    }
    if (a === "invoices" && b) {
      const inv = this.db.invoices.find((x) => x.id === b);
      if (!inv) return res(404, {});
      if (method === "GET") return res(200, inv);
      if (c === "issue") { inv.status = "issued"; inv.version++; return res(200, { invoice: inv }); }
      if (c === "payments") return res(200, replay("payment", body.requestId, () => { inv.recordedPaidCents += body.amountCents; inv.paymentState = inv.recordedPaidCents >= inv.totalCents ? "paid" : "partial"; inv.version++; return { invoice: inv }; }));
    }
    if (a === "service-obligations") {
      if (method === "POST" && !b) { const { dueDate, assignedUserId, ...rest } = body; return res(201, add("obligations", { ...rest, dueAt: `${dueDate}T12:00:00.000Z`, status: "active", recurrence: null })); }
      if (method === "POST" && c === "recurrence") { const o = this.db.obligations.find((x) => x.id === b); o.recurrence = { intervalMonths: body.intervalMonths, agreementNote: body.agreementNote }; return res(200, o); }
      return res(200, this.db.obligations.map((o) => ({ obligation: o })), { limitReached: "false" });
    }
    return res(404, { code: "not_found" });
  }
}
