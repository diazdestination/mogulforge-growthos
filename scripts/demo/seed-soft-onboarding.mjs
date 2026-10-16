// October 17 soft-onboarding demo seeder for the two TEST Demo companies.
//
//   node scripts/demo/seed-soft-onboarding.mjs --base-url <url> [--company css|painless|both]
//        [--apply] [--verify] [--demo-date YYYY-MM-DD] [--local-manifest <file>] [--auth-module <file>]
//
// Dry-run by default: signs in, reads what already exists and prints the plan.
// --apply writes, using only existing product API routes, as the signed-in
// owner of each TEST Demo company. --verify opens the real UI (Today,
// customers, estimates, appointments, invoices, service) and saves screenshots.
//
// Safety:
//  * Only loopback ports 4192/4193 (the disposable demo runtime) or exactly
//    https://mogulforge-growthos-staging.fly.dev are accepted. Production
//    (mogulforge-growthos / mogulforge-growthos.fly.dev and its aliases) and
//    every other host are refused before any network call.
//  * The seeder never creates companies or users. It only writes into a
//    company whose exact name is the TEST Demo name and whose signed-in
//    account owns it; anything else stops with BLOCKED and no writes.
//  * No send, delivery-preview or provider endpoint is ever called. Outbound
//    holds stay as the target has them.
//  * Idempotent: every record is looked up by its natural key first, and
//    request-ID routes use deterministic request IDs, so re-runs create nothing new.
//  * The JSON receipt holds IDs and outcomes only: no credentials, cookies,
//    tokens or site keys. Screenshots are taken after sign-in completes.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEMO_COMPANIES } from "./demo-data.mjs";

export const STAGING_ORIGIN = "https://mogulforge-growthos-staging.fly.dev";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
const LOCAL_PORTS = new Set(["4192", "4193"]);
const PRODUCTION_PATTERNS = [
  /^mogulforge-growthos\.fly\.dev$/i,
  /^mogulforge-growthos\.(internal|flycast)$/i,
  /(^|\.)mogulforge-growthos\.(internal|flycast)$/i,
  /(^|\.)mogulforge\.(com|app|io|co)$/i,
  /(^|\.)growthos\.(com|app|io|co)$/i,
];
export const RECEIPT_DIR = "C:/Forge/artifacts/growthos-launch-claude-20261016/soft-onboarding";
const DEFAULT_AUTH_MODULE = "C:/Forge/artifacts/growthos-staging-acceptance-20261016/test-owner-auth.mjs";
const DEFAULT_LOCAL_MANIFEST = path.join(os.tmpdir(), "growthos-soft-onboarding-local-manifest.json");

/** Refuse anything that is not the local demo runtime or the exact staging origin. */
export function classifyBaseUrl(raw) {
  let url;
  try { url = new URL(String(raw ?? "")); } catch { throw new Error("Refusing: --base-url is not a valid URL."); }
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname))
    throw new Error("Refusing: --base-url must be a bare origin (no credentials, path, query or fragment).");
  const host = url.hostname.toLowerCase();
  if (PRODUCTION_PATTERNS.some((p) => p.test(host)) || (/mogulforge|growthos/i.test(host) && !/staging/i.test(host)))
    throw new Error(`Refusing ${host}: this looks like production. The demo seeder only runs on staging or the local demo runtime.`);
  if (url.protocol === "http:" && LOCAL_HOSTS.has(host) && LOCAL_PORTS.has(url.port))
    return { target: "local", origin: `http://${host}:${url.port}` };
  if (url.origin === STAGING_ORIGIN) return { target: "staging", origin: STAGING_ORIGIN };
  throw new Error(`Refusing ${url.origin}: only ${STAGING_ORIGIN} or http://127.0.0.1:4192/4193 are allowed.`);
}

export function parseArgs(argv) {
  const args = { company: "both", apply: false, verify: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`); return v; };
    if (a === "--base-url") args.baseUrl = next();
    else if (a === "--company") args.company = next();
    else if (a === "--apply") args.apply = true;
    else if (a === "--verify") args.verify = true;
    else if (a === "--demo-date") args.demoDate = next();
    else if (a === "--local-manifest") args.localManifest = next();
    else if (a === "--auth-module") args.authModule = next();
    else if (a === "--receipt-dir") args.receiptDir = next();
    else throw new Error(`Unknown option ${a}`);
  }
  if (!args.baseUrl) throw new Error("--base-url is required");
  if (!["css", "painless", "both"].includes(args.company)) throw new Error("--company must be css, painless or both");
  if (args.demoDate && !/^\d{4}-\d{2}-\d{2}$/.test(args.demoDate)) throw new Error("--demo-date must be YYYY-MM-DD");
  return args;
}

// ---------- time helpers (company wall clock -> instant) ----------
function partsIn(tz, date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return p;
}
export function todayIn(tz, now = new Date()) { const p = partsIn(tz, now); return `${p.year}-${p.month}-${p.day}`; }
export function addDays(ymd, n) { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function zonedInstant(ymd, hm, tz) {
  const [y, m, d] = ymd.split("-").map(Number);
  const [h, min] = hm.split(":").map(Number);
  let guess = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 2; i++) {
    const p = partsIn(tz, new Date(guess));
    const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
    guess -= asUtc - Date.UTC(y, m - 1, d, h, min);
  }
  return new Date(guess);
}
/** Deterministic UUID (v4 layout) so request-ID routes replay instead of duplicating. */
export function stableId(...parts) {
  const h = createHash("sha256").update(["growthos-soft-onboarding-20261017", ...parts].join(":")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const cents = (lines) => lines.reduce((sum, [, q, u]) => sum + Math.round(q * u), 0);
const rows = (json, ...keys) => (Array.isArray(json) ? json : keys.map((k) => json?.[k]).find(Array.isArray) ?? json?.data ?? []);
const ok = (r) => r.status >= 200 && r.status < 300;
const brief = (r) => `${r.status} ${JSON.stringify(r.json ?? null).slice(0, 180)}`;

// ---------- browser + API ----------
async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PACKAGE_JSON,
    "C:/Forge/tools/shipping-kit/node_modules/playwright/package.json",
    path.join(process.env.APPDATA ?? "", "npm/node_modules/@playwright/cli/package.json"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const req = createRequire(candidate);
    try { return req(candidate.includes("@playwright/cli") ? "playwright" : candidate.replace(/package\.json$/, "")); } catch {}
  }
  throw new Error("Playwright not found (tried shipping-kit and @playwright/cli).");
}

/** Same-session JSON call made by the signed-in page itself, like the Command Center. */
async function api(page, origin, method, pathname, body) {
  if (!page.url().startsWith(origin)) await page.goto(`${origin}/`);
  if (process.env.DEMO_SEED_DEBUG) console.log(`    > ${method} ${pathname}`);
  return page.evaluate(async ({ method, pathname, body }) => {
    const response = await fetch(pathname, {
      method,
      signal: AbortSignal.timeout(90_000),
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 300) }; }
    return { status: response.status, json };
  }, { method, pathname, body });
}

async function signIn(page, origin, target, company, options) {
  if (target === "local") {
    const manifestFile = options.localManifest ?? process.env.DEMO_LOCAL_MANIFEST ?? DEFAULT_LOCAL_MANIFEST;
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    if (manifest.origin !== origin.replace("localhost", "127.0.0.1")) throw new Error(`Local manifest is for ${manifest.origin}, not ${origin}`);
    const entry = manifest.companies.find((c) => c.key === company.key);
    if (!entry) throw new Error(`Local manifest has no ${company.key} company`);
    const owner = entry.staff.find((s) => s.key === "owner");
    await page.goto(`${origin}/login`);
    await page.getByPlaceholder("Email", { exact: true }).fill(owner.email);
    await page.getByPlaceholder("Password", { exact: true }).fill(owner.password);
    await page.getByRole("button", { name: "SIGN IN", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20000 });
    return { siteId: entry.siteId, siteKey: entry.siteKey };
  }
  // Staging: a credential module that keeps secrets in memory only. A
  // per-company module may export signInDemoOwner(page, companyKey); the
  // acceptance owner module exports signInTestOwner(page).
  const mod = await import(pathToFileURL(options.authModule ?? DEFAULT_AUTH_MODULE).href);
  if (typeof mod.signInDemoOwner === "function") await mod.signInDemoOwner(page, company.key);
  else if (typeof mod.signInTestOwner === "function") await mod.signInTestOwner(page);
  else throw new Error("Auth module exports neither signInDemoOwner nor signInTestOwner");
  return { siteId: null, siteKey: null };
}

// ---------- seeding ----------
class Ledger {
  constructor(apply) { this.apply = apply; this.records = []; }
  add(kind, key, outcome, id = null, detail = undefined) {
    const entry = { kind, key, outcome, id, ...(detail ? { detail } : {}) };
    this.records.push(entry);
    console.log(`  ${outcome.padEnd(14)} ${kind.padEnd(16)} ${key}${id ? ` ${id}` : ""}${detail ? ` - ${detail}` : ""}`);
    return entry;
  }
}

async function seedCompany(page, origin, company, demoDate, apply, session) {
  const L = new Ledger(apply);
  const call = (method, p, body) => api(page, origin, method, p, body);
  const tz = company.timezone;
  const day = (n) => addDays(demoDate, n);

  const me = await call("GET", "/api/v1/me");
  if (!ok(me)) return { status: "BLOCKED", reason: `GET /api/v1/me -> ${me.status}`, records: L.records };
  const org = me.json.organization;
  if (org?.name !== company.name || !["owner", "admin"].includes(me.json.role))
    return {
      status: "BLOCKED",
      reason: `Signed-in account belongs to "${org?.name ?? "no company"}" as ${me.json.role}; it is not an owner of "${company.name}". The seeder never creates companies or users, so nothing was written.`,
      organizationId: org?.id ?? null,
      records: L.records,
    };
  const orgId = org.id;
  const users = await call("GET", "/api/v1/users");
  const userByKey = {};
  for (const s of company.staff) userByKey[s.key] = rows(users.json).find((u) => u.email?.toLowerCase() === s.email.toLowerCase())?.id ?? me.json.id;

  const ids = { contacts: {}, properties: {}, leads: {}, estimates: {}, appointments: {}, tasks: {}, assets: {}, invoices: {}, service: {} };

  // Customers + properties
  for (const c of company.customers) {
    const found = rows((await call("GET", `/api/v1/contacts?search=${encodeURIComponent(c.email)}`)).json, "contacts")
      .find((x) => x.email?.toLowerCase() === c.email.toLowerCase());
    if (found) { ids.contacts[c.key] = found.id; L.add("customer", c.key, "existing", found.id); }
    else if (c.key === company.smartSiteLead?.customer && session.siteKey) { L.add("customer", c.key, apply ? "via-smart-site" : "would-create", null, "created by the website inquiry"); continue; }
    else if (!apply) { L.add("customer", c.key, "would-create"); continue; }
    else {
      const r = await call("POST", "/api/v1/contacts", { firstName: c.first, lastName: c.last, email: c.email, phone: c.phone, preferredContactMethod: "phone" });
      if (!ok(r)) { L.add("customer", c.key, "failed", null, brief(r)); continue; }
      ids.contacts[c.key] = r.json.id; L.add("customer", c.key, "created", r.json.id);
    }
    const contactId = ids.contacts[c.key];
    const props = rows((await call("GET", `/api/v1/properties?contactId=${contactId}`)).json, "properties");
    const prop = props.find((p) => p.addressLine1 === c.address[0]) ?? props.find((p) => p.contactId === contactId);
    if (prop) { ids.properties[c.key] = prop.id; L.add("property", c.key, "existing", prop.id); }
    else if (!apply) L.add("property", c.key, "would-create");
    else {
      const [addressLine1, city, state, postalCode] = c.address;
      const r = await call("POST", "/api/v1/properties", { contactId, addressLine1, city, state, postalCode, propertyType: "residential" });
      if (ok(r)) { ids.properties[c.key] = r.json.id; L.add("property", c.key, "created", r.json.id); } else L.add("property", c.key, "failed", null, brief(r));
    }
  }

  // Smart-site inquiry through the TEST site flow (only when a TEST site key is available)
  const ss = company.smartSiteLead;
  if (ss) {
    const cust = company.customers.find((c) => c.key === ss.customer);
    if (!session.siteKey || !session.siteId) {
      L.add("smart-site-lead", ss.customer, "skipped", null, "no TEST smart-site key for this target; a platform admin must issue one");
    } else if (ids.contacts[ss.customer]) {
      const lead = rows((await call("GET", `/api/v1/leads?search=${encodeURIComponent(cust.last.split(" ")[0])}&limit=200`)).json, "leads").find((l) => l.contactId === ids.contacts[ss.customer]);
      ids.leads["smart-site"] = lead?.id ?? null;
      L.add("smart-site-lead", ss.customer, lead ? "existing" : "missing", lead?.id ?? null);
    } else if (!apply) L.add("smart-site-lead", ss.customer, "would-create");
    else {
      // Credential check first (public, Bearer TEST site key), then activation.
      const check = await fetch(`${origin}/api/v1/public/smart-sites/${session.siteId}/check`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${session.siteKey}` },
        body: JSON.stringify({ schemaVersion: 1 }),
      });
      if (check.status >= 300) L.add("smart-site", "credential-check", "failed", null, String(check.status));
      const activate = await call("PATCH", `/api/v1/smart-sites/${session.siteId}`, { isActive: true, confirmedLaunch: true });
      if (!ok(activate)) L.add("smart-site", "activate", "failed", null, brief(activate));
      const profiles = await call("GET", "/api/v1/smart-sites/profiles");
      const profile = rows(profiles.json, "profiles").find((p) => p.id === company.profile);
      const s0 = profile?.services?.[0];
      const serviceCode = Array.isArray(s0) ? s0[0] : s0?.slug ?? s0?.code ?? "repair";
      const [address, city, state, postalCode] = cust.address;
      const response = await fetch(`${origin}/api/v1/public/smart-sites/${session.siteId}/intake`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${session.siteKey}` },
        body: JSON.stringify({
          schemaVersion: 1, requestId: stableId(orgId, "smart-site", ss.customer),
          contact: { name: `${cust.first} ${cust.last}`, email: cust.email, phone: cust.phone },
          project: { serviceCode, address, city, state, postalCode, summary: ss.summary, timing: ss.timing },
          consent: { contact: true, policyVersion: "test-demo-2026-10-17", analytics: false, channels: ["email"] },
        }),
      });
      const json = await response.json().catch(() => null);
      if (response.status < 300 && json?.leadId) {
        ids.leads["smart-site"] = json.leadId;
        L.add("smart-site-lead", ss.customer, json.duplicate ? "existing" : "created", json.leadId, "TEST website inquiry");
        const lead = await call("GET", `/api/v1/leads/${json.leadId}`);
        ids.contacts[ss.customer] = lead.json?.contactId ?? lead.json?.lead?.contactId ?? null;
        ids.properties[ss.customer] = lead.json?.propertyId ?? lead.json?.lead?.propertyId ?? null;
      } else L.add("smart-site-lead", ss.customer, "failed", null, `${response.status} ${JSON.stringify(json).slice(0, 160)}`);
    }
  }

  // Leads
  for (const l of company.leads) {
    const contactId = ids.contacts[l.customer];
    if (!contactId) { L.add("lead", l.key, apply ? "skipped" : "would-create", null, apply ? "customer missing" : undefined); continue; }
    const last = company.customers.find((c) => c.key === l.customer).last.split(" ")[0];
    const found = rows((await call("GET", `/api/v1/leads?search=${encodeURIComponent(last)}&limit=200`)).json, "leads")
      .find((x) => x.contactId === contactId && x.serviceType === l.serviceType);
    if (found) { ids.leads[l.key] = found.id; L.add("lead", l.key, "existing", found.id); continue; }
    if (!apply) { L.add("lead", l.key, "would-create"); continue; }
    const r = await call("POST", "/api/v1/leads", {
      contactId, ...(ids.properties[l.customer] ? { propertyId: ids.properties[l.customer] } : {}), assignedUserId: userByKey.owner,
      status: l.status, urgency: l.urgency, serviceType: l.serviceType, source: l.source, summary: l.summary, estimatedValueCents: l.valueCents,
    });
    if (ok(r)) { ids.leads[l.key] = r.json.id; L.add("lead", l.key, "created", r.json.id); } else L.add("lead", l.key, "failed", null, brief(r));
  }

  // Estimates (good/better/best are three option estimates on one lead: the
  // product has no native option-group, so each tier is its own estimate)
  for (const e of company.estimates) {
    const leadId = ids.leads[e.lead];
    if (!leadId) { L.add("estimate", e.key, apply ? "skipped" : "would-create", null, apply ? "lead missing" : undefined); continue; }
    const found = rows((await call("GET", `/api/v1/estimates?leadId=${leadId}`)).json, "estimates").find((x) => x.title === e.title);
    if (found) { ids.estimates[e.key] = found.id; L.add("estimate", e.key, "existing", found.id); continue; }
    if (!apply) { L.add("estimate", e.key, "would-create"); continue; }
    const r = await call("POST", "/api/v1/estimates", {
      leadId, title: e.title, status: e.status, taxCents: 0, notes: e.notes,
      lineItems: e.lines.map(([description, quantity, unitPriceCents]) => ({ description, quantity, unitPriceCents, totalCents: Math.round(quantity * unitPriceCents) })),
    });
    if (ok(r)) { ids.estimates[e.key] = r.json.id; L.add("estimate", e.key, "created", r.json.id, `$${(cents(e.lines) / 100).toFixed(2)}`); } else L.add("estimate", e.key, "failed", null, brief(r));
  }

  // Equipment / roof assets (with warranty dates)
  for (const a of company.assets) {
    const contactId = ids.contacts[a.customer];
    if (!contactId) { L.add("asset", a.key, apply ? "skipped" : "would-create"); continue; }
    const found = rows((await call("GET", `/api/v1/contacts/${contactId}/assets`)).json, "items", "assets").find((x) => x.label === a.label);
    if (found) { ids.assets[a.key] = found.id; L.add("asset", a.key, "existing", found.id); continue; }
    if (!apply) { L.add("asset", a.key, "would-create"); continue; }
    const { key, customer, ...fields } = a;
    const r = await call("POST", `/api/v1/contacts/${contactId}/assets`, {
      requestId: stableId(orgId, "asset", key), propertyId: ids.properties[customer] ?? null, ...fields,
      location: company.trade === "hvac" ? "TEST equipment location" : "TEST whole roof", notes: "TEST demo record", attributes: [],
    });
    const id = r.json?.asset?.id ?? r.json?.id;
    if (ok(r) && id) { ids.assets[key] = id; L.add("asset", key, "created", id); } else L.add("asset", key, "failed", null, brief(r));
  }

  // Appointments for the demo week
  for (const a of company.appointments) {
    const contactId = ids.contacts[a.customer];
    if (!contactId) { L.add("appointment", a.key, apply ? "skipped" : "would-create"); continue; }
    const existing = rows((await call("GET", `/api/v1/appointments?contactId=${contactId}`)).json, "appointments").find((x) => x.notes === a.notes && x.status !== "cancelled");
    const start = zonedInstant(day(a.day), a.start, tz);
    if (existing) { ids.appointments[a.key] = existing.id; L.add("appointment", a.key, "existing", existing.id, `${day(a.day)} ${a.start} ${existing.status}`); }
    else if (!apply) { L.add("appointment", a.key, "would-create", null, `${day(a.day)} ${a.start}`); continue; }
    else if (start.getTime() <= Date.now() + 60_000) { L.add("appointment", a.key, "skipped", null, `${day(a.day)} ${a.start} is already in the past; re-run with a later --demo-date`); continue; }
    else {
      const r = await call("POST", "/api/v1/appointments", {
        ...(a.lead && ids.leads[a.lead] ? { leadId: ids.leads[a.lead] } : {}), contactId, propertyId: ids.properties[a.customer] ?? null,
        assignedUserId: userByKey[a.staff], type: a.type, scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + a.minutes * 60_000).toISOString(), notes: a.notes,
      });
      if (!ok(r)) { L.add("appointment", a.key, "failed", null, brief(r)); continue; }
      ids.appointments[a.key] = r.json.id; L.add("appointment", a.key, "created", r.json.id, `${day(a.day)} ${a.start}`);
    }
    if (a.complete && apply) {
      const cur = rows((await call("GET", `/api/v1/appointments?contactId=${contactId}`)).json).find((x) => x.id === ids.appointments[a.key]);
      if (cur && cur.status !== "completed") {
        const r = await call("PATCH", `/api/v1/appointments/${cur.id}`, { status: "completed", expectedUpdatedAt: cur.updatedAt });
        L.add("visit-complete", a.key, ok(r) ? "updated" : "failed", cur.id, ok(r) ? "marked completed" : brief(r));
      }
    }
  }

  // Follow-up tasks for the Today list
  const taskList = rows((await call("GET", "/api/v1/tasks")).json, "tasks");
  for (const t of company.tasks) {
    const found = taskList.find((x) => x.title === t.title);
    if (found) { ids.tasks[t.key] = found.id; L.add("task", t.key, "existing", found.id); continue; }
    if (!apply) { L.add("task", t.key, "would-create"); continue; }
    const r = await call("POST", "/api/v1/tasks", {
      title: t.title, ...(ids.leads[t.lead] ? { leadId: ids.leads[t.lead] } : {}), ...(ids.contacts[t.customer] ? { contactId: ids.contacts[t.customer] } : {}),
      assignedUserId: userByKey[t.staff], priority: t.priority, dueAt: zonedInstant(day(t.day), t.due, tz).toISOString(), status: "open",
    });
    if (ok(r)) { ids.tasks[t.key] = r.json.id; L.add("task", t.key, "created", r.json.id); } else L.add("task", t.key, "failed", null, brief(r));
  }

  // Invoices: create (deterministic request ID), issue, record staff-entered payment
  for (const inv of company.invoices) {
    const contactId = ids.contacts[inv.customer];
    if (!contactId) { L.add("invoice", inv.key, apply ? "skipped" : "would-create"); continue; }
    const listInvoices = async () => rows((await call("GET", "/api/v1/invoices")).json, "items", "invoices");
    const listed = await listInvoices();
    const found = listed.find((x) => (x.title ?? x.draftDocument?.title ?? x.document?.title) === inv.title);
    if (!apply) { L.add("invoice", inv.key, found ? "existing" : "would-create", found?.id ?? null); continue; }
    const cust = company.customers.find((c) => c.key === inv.customer);
    const total = cents(inv.lines);
    let r = found ? { status: 200, json: found } : await call("POST", "/api/v1/invoices", {
      requestId: stableId(orgId, "invoice", inv.key),
      source: { kind: "existing_customer", contactId, propertyId: ids.properties[inv.customer] ?? null },
      document: {
        title: inv.title, currency: "USD", issuerName: company.name, customerName: `${cust.first} ${cust.last}`,
        dueDate: addDays(demoDate, 14), notes: "TEST demo record - not a real bill. Email delivery is held in this demo.",
        lineItems: inv.lines.map(([description, quantity, unitPriceCents]) => ({ description, quantity: String(quantity), unitPriceCents })), taxCents: 0,
      },
    });
    let invoice = r.json?.invoice ?? r.json;
    if (!ok(r) || !invoice?.id) { L.add("invoice", inv.key, "failed", null, brief(r)); continue; }
    ids.invoices[inv.key] = invoice.id;
    L.add("invoice", inv.key, found || r.json?.duplicate ? "existing" : "created", invoice.id, `$${(total / 100).toFixed(2)} ${invoice.status}`);
    if (inv.issue && invoice.status === "draft") {
      const issued = await call("POST", `/api/v1/invoices/${invoice.id}/issue`, { requestId: stableId(orgId, "invoice-issue", inv.key), expectedVersion: invoice.version, confirmed: true });
      if (ok(issued)) { invoice = issued.json?.invoice ?? invoice; L.add("invoice-issue", inv.key, "updated", invoice.id, "issued (not emailed)"); }
      else L.add("invoice-issue", inv.key, "failed", invoice.id, brief(issued));
    }
    if (inv.paidInFull && invoice.status !== "draft") {
      const cur = (await listInvoices()).find((x) => x.id === invoice.id);
      const paid = Number(cur?.recordedPaidCents ?? 0);
      if (!cur) { L.add("invoice-payment", inv.key, "failed", invoice.id, "issued invoice not found in list"); continue; }
      if (cur.paymentState === "paid" || paid >= total) { L.add("invoice-payment", inv.key, "existing", invoice.id, "already paid"); continue; }
      const pay = await call("POST", `/api/v1/invoices/${invoice.id}/payments`, {
        requestId: stableId(orgId, "invoice-payment", inv.key), expectedVersion: cur?.version ?? invoice.version, confirmed: true,
        amountCents: total - paid, sourceReference: inv.payRef, occurredAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      });
      L.add("invoice-payment", inv.key, ok(pay) ? "created" : "failed", invoice.id, ok(pay) ? `staff-recorded ${inv.payRef} $${((total - paid) / 100).toFixed(2)}` : brief(pay));
    }
  }

  // Maintenance / service agreements (service date + recurrence). Reminders stay held.
  const obligations = rows((await call("GET", "/api/v1/service-obligations")).json, "obligations").map((x) => x.obligation ?? x);
  for (const s of company.serviceAgreements) {
    const contactId = ids.contacts[s.customer];
    if (!contactId) { L.add("service-plan", s.key, apply ? "skipped" : "would-create"); continue; }
    const found = obligations.find((o) => o.contactId === contactId && o.notes === s.note);
    if (found) { ids.service[s.key] = found.id; L.add("service-plan", s.key, "existing", found.id); continue; }
    if (!apply) { L.add("service-plan", s.key, "would-create"); continue; }
    const r = await call("POST", "/api/v1/service-obligations", {
      contactId, propertyId: ids.properties[s.customer] ?? null, kind: s.kind, equipmentLabel: s.equipmentLabel,
      dueDate: day(s.dueInDays), noticeDays: s.noticeDays, assignedUserId: userByKey[s.staff], notes: s.note,
    });
    if (!ok(r)) { L.add("service-plan", s.key, "failed", null, brief(r)); continue; }
    ids.service[s.key] = r.json.id;
    const rec = await call("POST", `/api/v1/service-obligations/${r.json.id}/recurrence`, {
      expectedUpdatedAt: r.json.updatedAt, intervalMonths: s.intervalMonths, endDate: addDays(demoDate, 730), agreementNote: s.note,
    });
    L.add("service-plan", s.key, "created", r.json.id, ok(rec) ? `repeats every ${s.intervalMonths} months` : `recurrence ${brief(rec)}`);
  }

  // Returning-customer work (estimate on an existing customer, no invented lead)
  for (const w of company.returningWork) {
    const contactId = ids.contacts[w.customer];
    if (!contactId) { L.add("returning-work", w.key, apply ? "skipped" : "would-create"); continue; }
    const found = rows((await call("GET", `/api/v1/estimates?contactId=${contactId}`)).json, "estimates").find((x) => x.title === w.title);
    if (found) { ids.estimates[w.key] = found.id; L.add("returning-work", w.key, "existing", found.id); continue; }
    if (!apply) { L.add("returning-work", w.key, "would-create"); continue; }
    const r = await call("POST", "/api/v1/customer-work/estimates", {
      requestId: stableId(orgId, "returning-work", w.key), confirmed: true,
      source: { kind: "existing_customer", contactId, propertyId: ids.properties[w.customer] ?? null },
      title: w.title, lineItems: w.lines.map(([description, quantity, unitPriceCents]) => ({ description, quantity, unitPriceCents })), taxCents: 0, notes: w.notes,
    });
    const id = r.json?.estimate?.id ?? r.json?.id;
    if (ok(r) && id) { ids.estimates[w.key] = id; L.add("returning-work", w.key, "created", id); } else L.add("returning-work", w.key, "failed", null, brief(r));
  }

  const failed = L.records.filter((r) => r.outcome === "failed").length;
  return { status: failed ? "PARTIAL" : apply ? "APPLIED" : "DRY-RUN", organizationId: orgId, organizationName: org.name, failed, records: L.records };
}

// ---------- UI verification ----------
async function verifyUi(page, origin, company, demoDate, shotDir, prefix) {
  await mkdir(shotDir, { recursive: true });
  const checks = [];
  const lastNames = company.customers.map((c) => c.last.split(" ")[0]);
  const visit = async (name, url, expect, prepare) => {
    await page.goto(`${origin}${url}`);
    await page.waitForLoadState("networkidle").catch(() => {});
    if (prepare) await prepare();
    await page.waitForTimeout(800);
    const text = await page.locator("body").innerText().catch(() => "");
    const seen = expect.filter((e) => text.includes(e));
    const file = path.join(shotDir, `${prefix}-${String(checks.length + 1).padStart(2, "0")}-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    checks.push({ page: name, url, expected: expect, seen, pass: seen.length > 0, screenshot: file.replace(/\\/g, "/") });
    console.log(`  ${seen.length ? "PASS" : "CHECK"} ${name}: saw ${seen.length}/${expect.length} expected names -> ${file}`);
  };
  const dayNames = company.appointments.filter((a) => a.day === 0).map((a) => company.customers.find((c) => c.key === a.customer).last.split(" ")[0]);
  await visit("today", "/today", dayNames, async () => {
    const input = page.locator('input[type="date"]').first();
    if (await input.count()) { await input.fill(demoDate); await page.waitForLoadState("networkidle").catch(() => {}); await page.waitForTimeout(1200); }
  });
  await visit("customers", "/contacts", lastNames);
  await visit("estimates", "/estimates", company.estimates.map((e) => e.title).concat(company.returningWork.map((w) => w.title)));
  await visit("appointments", "/appointments", company.appointments.map((a) => company.customers.find((c) => c.key === a.customer).last.split(" ")[0]));
  await visit("invoices", "/invoices", company.invoices.map((i) => i.title));
  await visit("service", "/service", company.serviceAgreements.map((s) => company.customers.find((c) => c.key === s.customer).last.split(" ")[0]));
  await visit("pipeline", "/pipeline", lastNames);
  return checks;
}

// ---------- main ----------
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const { target, origin } = classifyBaseUrl(options.baseUrl);
  const keys = options.company === "both" ? ["css", "painless"] : [options.company];
  const receiptDir = options.receiptDir ?? RECEIPT_DIR;
  console.log(`[demo-seed] target=${target} origin=${origin} companies=${keys.join(",")} mode=${options.apply ? "APPLY" : "DRY-RUN"}${options.verify ? " +verify" : ""}`);
  const { chromium } = await loadPlaywright();
  const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
  const receipt = {
    kind: "growthos-soft-onboarding-demo-seed",
    startedAt: new Date().toISOString(),
    target, origin, mode: options.apply ? "apply" : "dry-run",
    note: "IDs and outcomes only. No credentials, cookies, tokens or site keys. All records are fictional TEST data.",
    companies: {},
  };
  try {
    for (const key of keys) {
      const company = DEMO_COMPANIES[key];
      const demoDate = options.demoDate ?? addDays(todayIn(company.timezone), 1);
      console.log(`[demo-seed] ${company.name} (demo day ${demoDate})`);
      // Ephemeral context: no tracing, video, HAR or saved storage state.
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      try {
        const session = await signIn(page, origin, target, company, options);
        const result = await seedCompany(page, origin, company, demoDate, options.apply, session);
        result.demoDate = demoDate;
        if (options.verify && result.status !== "BLOCKED")
          result.ui = await verifyUi(page, origin, company, demoDate, path.join(receiptDir, "screenshots"), `${target}-${key}`);
        receipt.companies[key] = result;
        console.log(`[demo-seed] ${company.name}: ${result.status}${result.reason ? ` - ${result.reason}` : ""}`);
      } catch (error) {
        receipt.companies[key] = { status: "ERROR", reason: String(error.message).split("\n")[0] };
        console.error(`[demo-seed] ${company.name}: ERROR ${String(error.message).split("\n")[0]}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    receipt.completedAt = new Date().toISOString();
    await mkdir(receiptDir, { recursive: true });
    const file = path.join(receiptDir, `receipt-${target}-${options.apply ? "apply" : "dryrun"}-${options.company}.json`);
    await writeFile(file, JSON.stringify(receipt, null, 2) + "\n");
    console.log(`[demo-seed] receipt ${file}`);
  }
  const statuses = Object.values(receipt.companies).map((c) => c.status);
  if (statuses.some((s) => s === "ERROR" || s === "BLOCKED" || s === "PARTIAL")) process.exitCode = 2;
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`[demo-seed] ${String(error.message).split("\n")[0]}`); process.exitCode = 1; });
}
