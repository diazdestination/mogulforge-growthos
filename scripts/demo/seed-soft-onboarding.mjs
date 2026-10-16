// October 17 soft-onboarding demo seeder for the two TEST Demo companies.
//
//   node scripts/demo/seed-soft-onboarding.mjs --base-url <url> [--company css|painless|both]
//        [--apply] [--verify] [--demo-date YYYY-MM-DD (local only)]
//        (--local-manifest <file> | --execution-manifest <file> [--auth-module <file>])
//        [--receipt-dir <dir>] [--lock-dir <dir>]
//
// Dry-run by default: signs in, admits the target, reads what already exists
// and prints the plan. --apply writes, using only existing product API routes,
// as the reviewed owner of each TEST Demo company. --verify opens the real UI
// and requires every expected fixture to be visible.
//
// Safety (each point is enforced before the first write):
//  * Target: only loopback ports 4192/4193 (the disposable demo runtime) or
//    exactly https://mogulforge-growthos-staging.fly.dev. Production and every
//    other host are refused before any network call. Every API call compares
//    the page's parsed origin exactly and only accepts relative /api/ paths.
//  * Reviewed execution manifest: local runs use the runtime's own instance
//    manifest; staging requires --execution-manifest naming the exact
//    organization ID, name, slug, time zone, owner and staff user IDs, site ID,
//    release SHA, frozen demo date and a fresh hold attestation. Admission
//    checks /api/readyz, /me and /users against it; a 403 or missing staff
//    member BLOCKS (nothing is ever reassigned to the signed-in user). The
//    session is re-checked before every write.
//  * Holds: the local runtime starts with communications disabled, outbound
//    hold on and schedulers off and records that in its manifest. An owner
//    session cannot read hosted holds, so staging requires a reviewed hold
//    attestation no older than 6 hours plus an exact release-SHA match.
//  * Fail closed: any unsuccessful, malformed or possibly-truncated read stops
//    the company; absence is never inferred from a failed lookup. A write with
//    an unknown outcome (network error/5xx) stops with UNKNOWN.
//  * Exclusive claim: one run per target+organization at a time (exclusive
//    lock file; never stolen automatically).
//  * Reuse is exact: an existing record is reused only when every reviewed
//    fixture field matches (parents, amounts, dates, assignee). Ambiguity or
//    any difference (including staff edits) is a HOLD; nothing is issued, paid
//    or completed on the strength of a title or note alone.
//  * Success is graded: every required fixture must be created/existing, then
//    read back and re-matched. Anything else exits nonzero.
//  * No send, delivery-preview or provider endpoint is ever called.
//  * Receipts: each run gets its own directory (receipt, screenshots, SHA-256
//    hash list and source custody). Only IDs, outcomes and allowlisted status
//    codes are stored: no credentials, cookies, tokens, site keys or response text.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEMO_COMPANIES, DEMO_DATE } from "./demo-data.mjs";

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
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const LOCAL_HOLDS = Object.freeze({ COMMUNICATIONS_ENABLED: "false", GROWTHOS_OUTBOUND_HOLD: "true", SCHEDULER_AUTOSTART: "false" });
export const HOLD_ATTESTATION_MAX_AGE_MS = 6 * 3600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// ---------- errors and safe text ----------
/** A deliberate stop. `status` grades the company; `code`/`detail` are built by this script only. */
export class SeedHalt extends Error {
  constructor(status, code, detail = undefined) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}
const blocked = (code, detail) => new SeedHalt("BLOCKED", code, detail);
const SAFE_CODE = /^[a-z][a-z0-9_.-]{0,63}$/i;
/** HTTP status plus an allowlisted machine code; never response prose or payload. */
export function safeBrief(r) {
  const status = Number.isInteger(r?.status) ? r.status : 0;
  const code = [r?.json?.code, r?.json?.error].find((v) => typeof v === "string" && SAFE_CODE.test(v));
  return status === 0 ? "no response (network/timeout)" : `HTTP ${status}${code ? ` ${code}` : ""}`;
}
/** Persistable description of an unexpected exception: its class name only. */
export function safeError(error) {
  if (error instanceof SeedHalt) return { status: error.status, code: error.code, ...(error.detail ? { detail: error.detail } : {}) };
  const name = typeof error?.name === "string" && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "Error";
  return { status: "ERROR", code: "unexpected", detail: name };
}

// ---------- target guard ----------
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

/** Exact parsed-origin equality (never a string prefix). */
export function sameOrigin(pageUrl, origin) {
  try { return new URL(pageUrl).origin === origin; } catch { return false; }
}

/** Only relative same-origin API paths. */
export function assertApiPath(p) {
  if (typeof p !== "string" || !/^\/api\/[A-Za-z0-9/_\-.?=&%:@+]*$/.test(p) || p.startsWith("//") || p.includes("//") || p.includes(".."))
    throw new SeedHalt("BLOCKED", "unsafe_api_path");
  return p;
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
    else if (a === "--execution-manifest") args.executionManifest = next();
    else if (a === "--auth-module") args.authModule = next();
    else if (a === "--receipt-dir") args.receiptDir = next();
    else if (a === "--lock-dir") args.lockDir = next();
    else throw new Error(`Unknown option ${a}`);
  }
  if (!args.baseUrl) throw new Error("--base-url is required");
  if (!["css", "painless", "both"].includes(args.company)) throw new Error("--company must be css, painless or both");
  if (args.demoDate && !/^\d{4}-\d{2}-\d{2}$/.test(args.demoDate)) throw new Error("--demo-date must be YYYY-MM-DD");
  return args;
}

// ---------- time helpers (company wall clock -> instant) ----------
function partsIn(tz, date) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(date).map((x) => [x.type, x.value]));
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
const ok = (r) => r.status >= 200 && r.status < 300;
const digits = (v) => (typeof v === "string" ? v.replace(/\D/g, "") : v);
const lower = (v) => (typeof v === "string" ? v.toLowerCase() : v);
const ymdIn = (iso, tz) => (typeof iso === "string" && Number.isFinite(Date.parse(iso)) ? todayIn(tz, new Date(iso)) : null);

// ---------- execution plans ----------
function fixtureCompanies(keys) {
  return keys.map((key) => {
    const company = DEMO_COMPANIES[key];
    if (!company) throw blocked("unknown_company");
    return company;
  });
}
function checkStaffMap(company, staff) {
  const out = {};
  for (const s of company.staff) {
    const id = staff?.[s.key];
    if (typeof id !== "string" || !UUID.test(id)) throw blocked("manifest_staff_missing", `${company.key}.${s.key}`);
    out[s.key] = id;
  }
  return out;
}

/** Local plan from the runtime's own instance manifest. Secrets stay in `secrets`, never in the plan. */
export function planFromLocalManifest(manifest, { origin, keys, demoDate }) {
  if (manifest?.kind !== "growthos-soft-onboarding-local-manifest") throw blocked("local_manifest_invalid");
  const loopback = origin.replace("//localhost:", "//127.0.0.1:");
  if (manifest.origin !== loopback || manifest.origin !== `http://127.0.0.1:${manifest.port}`) throw blocked("local_manifest_origin_mismatch");
  if (typeof manifest.instanceId !== "string" || !UUID.test(manifest.instanceId)) throw blocked("local_manifest_invalid");
  for (const [k, v] of Object.entries(LOCAL_HOLDS)) if (manifest.holds?.[k] !== v) throw blocked("holds_unverified", k);
  const companies = {};
  const secrets = {};
  for (const company of fixtureCompanies(keys)) {
    const entry = (manifest.companies ?? []).find((c) => c.key === company.key);
    if (!entry) throw blocked("manifest_company_missing", company.key);
    if (entry.name !== company.name || entry.slug !== company.slug || entry.timezone !== company.timezone) throw blocked("manifest_company_mismatch", company.key);
    if (!UUID.test(entry.organizationId ?? "") || (entry.siteId !== null && !UUID.test(entry.siteId ?? ""))) throw blocked("manifest_company_mismatch", company.key);
    const staff = {};
    for (const s of company.staff) {
      const m = (entry.staff ?? []).find((x) => x.key === s.key && lower(x.email) === lower(s.email) && x.role === s.role);
      staff[s.key] = m?.id;
    }
    companies[company.key] = { organizationId: entry.organizationId, name: entry.name, slug: entry.slug, timezone: entry.timezone, siteId: entry.siteId ?? null, staff: checkStaffMap(company, staff) };
    const owner = entry.staff.find((x) => x.key === "owner");
    secrets[company.key] = { email: owner.email, password: owner.password, siteKey: entry.siteKey ?? null };
  }
  return {
    plan: { target: "local", origin, demoDate: demoDate ?? DEMO_DATE, release: null, instanceId: manifest.instanceId, holds: { source: "local-runtime-manifest", ...LOCAL_HOLDS }, companies },
    secrets,
  };
}

/** Staging plan from a reviewed execution manifest. Nothing is guessed or defaulted. */
export function planFromExecutionManifest(m, { origin, keys, demoDate, now = Date.now() }) {
  if (m?.kind !== "growthos-soft-onboarding-execution-manifest" || m.target !== "staging" || m.origin !== STAGING_ORIGIN || origin !== STAGING_ORIGIN)
    throw blocked("execution_manifest_invalid");
  if (m.demoDate !== DEMO_DATE) throw blocked("demo_date_not_reviewed");
  if (demoDate && demoDate !== m.demoDate) throw blocked("demo_date_not_reviewed");
  if (typeof m.reviewedBy !== "string" || !m.reviewedBy.trim() || !ISO.test(m.reviewedAt ?? "")) throw blocked("execution_manifest_unreviewed");
  if (!/^[a-f0-9]{40}$/.test(m.release?.sha ?? "") || m.release.environment !== "staging") throw blocked("release_not_pinned");
  const h = m.holds ?? {};
  if (h.outboundHold !== true || h.communicationsEnabled !== false || h.schedulerAutostart !== false || typeof h.evidence !== "string" || !h.evidence.trim())
    throw blocked("holds_unverified");
  const verifiedAt = ISO.test(h.verifiedAt ?? "") ? Date.parse(h.verifiedAt) : NaN;
  if (!Number.isFinite(verifiedAt) || verifiedAt > now + 5 * 60_000 || now - verifiedAt > HOLD_ATTESTATION_MAX_AGE_MS) throw blocked("holds_attestation_stale");
  const companies = {};
  for (const company of fixtureCompanies(keys)) {
    const c = m.companies?.[company.key];
    if (!c || c.name !== company.name || c.slug !== company.slug || c.timezone !== company.timezone || !UUID.test(c.organizationId ?? "") || (c.siteId !== null && !UUID.test(c.siteId ?? "")))
      throw blocked("manifest_company_mismatch", company.key);
    companies[company.key] = { organizationId: c.organizationId, name: c.name, slug: c.slug, timezone: c.timezone, siteId: c.siteId, staff: checkStaffMap(company, c.staff) };
  }
  return {
    plan: { target: "staging", origin, demoDate: m.demoDate, release: { sha: m.release.sha, environment: "staging" }, instanceId: null,
      holds: { source: "reviewed-attestation", outboundHold: true, communicationsEnabled: false, schedulerAutostart: false, evidence: h.evidence, verifiedAt: h.verifiedAt }, reviewedBy: m.reviewedBy, reviewedAt: m.reviewedAt, companies },
    secrets: {},
  };
}

/** The optional site credential an auth module may return. Anything else is refused. */
export function validateAuthResult(result, expectedSiteId) {
  if (result === undefined || result === null) return { siteId: null, siteKey: null };
  if (typeof result !== "object" || Array.isArray(result)) throw blocked("auth_module_contract");
  const extra = Object.keys(result).filter((k) => !["siteId", "siteKey"].includes(k));
  if (extra.length) throw blocked("auth_module_contract");
  const { siteId = null, siteKey = null } = result;
  if ((siteId === null) !== (siteKey === null)) throw blocked("auth_module_contract");
  if (siteId === null) return { siteId: null, siteKey: null };
  if (!UUID.test(String(siteId)) || typeof siteKey !== "string" || !/^\S{16,512}$/.test(siteKey)) throw blocked("auth_module_contract");
  if (siteId !== expectedSiteId) throw blocked("site_mismatch");
  return { siteId, siteKey };
}

// ---------- exclusive run claim ----------
export function lockPath(lockDir, origin, organizationId) {
  return path.join(lockDir, `${createHash("sha256").update(`${origin}|${organizationId}`).digest("hex").slice(0, 24)}.lock`);
}
/** Exclusive create; an existing claim is never stolen (remove it by hand after confirming no run is active). */
export async function acquireRunLock(lockDir, origin, organizationId, runId) {
  await mkdir(lockDir, { recursive: true });
  const file = lockPath(lockDir, origin, organizationId);
  try {
    await writeFile(file, JSON.stringify({ runId, pid: process.pid, origin, organizationId, startedAt: new Date().toISOString() }) + "\n", { flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw blocked("concurrent_run", "another run holds this organization's claim");
    throw blocked("lock_unavailable");
  }
  return { file, runId };
}
export async function releaseRunLock(lock) {
  if (!lock) return;
  try {
    const current = JSON.parse(await readFile(lock.file, "utf8"));
    if (current.runId === lock.runId) await rm(lock.file);
  } catch {}
}

// ---------- fail-closed reads ----------
const MAX_PAGES = 25;
function rowsOf(r, label, key) {
  const list = Array.isArray(r.json) ? r.json : key ? r.json?.[key] : undefined;
  if (!Array.isArray(list)) throw new SeedHalt("INCOMPLETE", "read_shape", label);
  for (const row of list) if (!row || typeof row !== "object" || typeof (row.obligation ?? row).id !== "string") throw new SeedHalt("INCOMPLETE", "read_shape", label);
  return list;
}
function readOk(r, label) {
  if (!ok(r)) throw new SeedHalt("INCOMPLETE", "read_failed", `${label} ${safeBrief(r)}`);
  return r;
}
/**
 * Read a whole list or stop. Modes match the product's list contracts:
 *  offset  - plain array with limit/offset (page until a short page)
 *  capped  - plain array with a fixed server cap of 200 (a full page is possibly truncated)
 *  header  - plain array with X-Result-Limit-Reached (must be "false")
 *  pages   - { items, total, page, pageSize } (page until total is collected)
 *  cursor  - { items, hasMore, nextCursor }
 */
export async function readList(call, label, pathname, mode) {
  const join = (p, q) => `${p}${p.includes("?") ? "&" : "?"}${q}`;
  if (mode === "offset") {
    const out = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = readOk(await call("GET", join(pathname, `limit=200&offset=${page * 200}`)), label);
      const rows = rowsOf(r, label);
      out.push(...rows);
      if (rows.length < 200) return out;
    }
    throw new SeedHalt("INCOMPLETE", "read_incomplete", label);
  }
  if (mode === "capped") {
    const rows = rowsOf(readOk(await call("GET", pathname), label), label);
    if (rows.length >= 200) throw new SeedHalt("INCOMPLETE", "read_incomplete", label);
    return rows;
  }
  if (mode === "header") {
    const r = readOk(await call("GET", pathname), label);
    if (r.limitReached !== "false") throw new SeedHalt("INCOMPLETE", "read_incomplete", label);
    return rowsOf(r, label);
  }
  if (mode === "pages") {
    const out = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = readOk(await call("GET", join(pathname, `page=${page}`)), label);
      const rows = rowsOf(r, label, "items");
      if (!Number.isInteger(r.json.total) || r.json.page !== page) throw new SeedHalt("INCOMPLETE", "read_shape", label);
      out.push(...rows);
      if (out.length >= r.json.total) { if (out.length !== r.json.total) throw new SeedHalt("INCOMPLETE", "read_incomplete", label); return out; }
      if (!rows.length) throw new SeedHalt("INCOMPLETE", "read_incomplete", label);
    }
    throw new SeedHalt("INCOMPLETE", "read_incomplete", label);
  }
  if (mode === "cursor") {
    const out = [];
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = readOk(await call("GET", cursor ? join(pathname, `cursor=${encodeURIComponent(cursor)}`) : pathname), label);
      out.push(...rowsOf(r, label, "items"));
      if (r.json.hasMore === false) return out;
      if (r.json.hasMore !== true || typeof r.json.nextCursor !== "string") throw new SeedHalt("INCOMPLETE", "read_shape", label);
      cursor = r.json.nextCursor;
    }
    throw new SeedHalt("INCOMPLETE", "read_incomplete", label);
  }
  throw new Error(`unknown read mode ${mode}`);
}
async function readOne(call, label, pathname) {
  const r = readOk(await call("GET", pathname), label);
  if (!r.json || typeof r.json !== "object" || typeof r.json.id !== "string") throw new SeedHalt("INCOMPLETE", "read_shape", label);
  return r.json;
}

// ---------- matching ----------
/** Field names (only) whose values differ from the reviewed fixture. */
export function diffFields(expected, row) {
  return Object.keys(expected).filter((k) => JSON.stringify(row?.[k] ?? null) !== JSON.stringify(expected[k] ?? null));
}
const normLines = (items) => (Array.isArray(items) ? items.map((x) => [x.description, Number(x.quantity), Number(x.unitPriceCents)]) : null);
const fixtureLines = (lines) => lines.map(([d, q, u]) => [d, Number(q), u]);

// ---------- ledger ----------
const SATISFIED = new Set(["created", "existing", "updated"]);
const DRY_SATISFIED = new Set(["existing", "would-create", "would-update"]);
class Ledger {
  constructor(quiet = false) { this.records = []; this.quiet = quiet; }
  add(kind, key, outcome, id = null, detail = undefined) {
    const entry = { kind, key, outcome, id, ...(detail ? { detail } : {}) };
    this.records.push(entry);
    if (!this.quiet) console.log(`  ${outcome.padEnd(14)} ${kind.padEnd(16)} ${key}${id ? ` ${id}` : ""}${detail ? ` - ${detail}` : ""}`);
    return entry;
  }
}

/** Every fixture record the walkthrough needs, as [kind, key]. */
export function requiredRecords(company) {
  const out = [];
  for (const c of company.customers) out.push(["customer", c.key], ["property", c.key]);
  if (company.smartSiteLead) out.push(["smart-site-lead", company.smartSiteLead.customer]);
  for (const l of company.leads) out.push(["lead", l.key]);
  for (const e of company.estimates) out.push(["estimate", e.key]);
  for (const a of company.assets) out.push(["asset", a.key]);
  for (const a of company.appointments) { out.push(["appointment", a.key]); if (a.complete) out.push(["visit-complete", a.key]); }
  for (const t of company.tasks) out.push(["task", t.key]);
  for (const i of company.invoices) { out.push(["invoice", i.key]); if (i.issue) out.push(["invoice-issue", i.key]); if (i.paidInFull) out.push(["invoice-payment", i.key]); }
  for (const s of company.serviceAgreements) out.push(["service-plan", s.key], ["service-recurrence", s.key]);
  for (const w of company.returningWork) out.push(["returning-work", w.key]);
  return out;
}

/** Grade a ledger against the required fixture list. */
export function gradeRecords(company, records, apply) {
  const good = apply ? SATISFIED : DRY_SATISFIED;
  const missing = [];
  const unsatisfied = [];
  for (const [kind, key] of requiredRecords(company)) {
    const rs = records.filter((r) => r.kind === kind && r.key === key);
    if (!rs.length) missing.push(`${kind}:${key}`);
    else if (!good.has(rs[rs.length - 1].outcome)) unsatisfied.push(`${kind}:${key}`);
  }
  return { required: requiredRecords(company).length, missing, unsatisfied, complete: !missing.length && !unsatisfied.length };
}

// ---------- admission ----------
/** Verify target, identity, staff and holds against the reviewed plan before any write. */
export async function admit({ call, company, cplan, plan }) {
  const ready = await call("GET", "/api/readyz");
  if (!ok(ready) || ready.json?.status !== "ready") throw blocked("target_not_ready", safeBrief(ready));
  const release = ready.json?.release ?? {};
  if (plan.target === "staging") {
    if (release.environment !== "staging" || release.sha !== plan.release.sha) throw blocked("release_mismatch");
  } else if (["staging", "production"].includes(release.environment)) throw blocked("release_mismatch");
  const me = await call("GET", "/api/v1/me");
  if (!ok(me)) throw blocked("session_unverified", safeBrief(me));
  const org = me.json?.organization;
  const mismatches = [
    org?.id !== cplan.organizationId && "organizationId",
    org?.name !== company.name && "name",
    org?.slug !== company.slug && "slug",
    org?.timezone !== company.timezone && "timezone",
    me.json?.id !== cplan.staff.owner && "ownerUserId",
    me.json?.role !== "owner" && "role",
    me.json?.isActive !== true && "isActive",
  ].filter(Boolean);
  if (mismatches.length) throw blocked("identity_mismatch", mismatches.join(","));
  const users = await call("GET", "/api/v1/users");
  if (!ok(users)) throw blocked("staff_unverified", safeBrief(users));
  if (!Array.isArray(users.json)) throw blocked("staff_unverified", "shape");
  const userIds = {};
  for (const s of company.staff) {
    const matches = users.json.filter((u) => lower(u?.email) === lower(s.email));
    const u = matches[0];
    if (matches.length !== 1 || u.id !== cplan.staff[s.key] || u.role !== s.role || u.isActive !== true || u.operationallyEligible === false)
      throw blocked("staff_unverified", s.key);
    userIds[s.key] = u.id;
  }
  return { ownerId: me.json.id, organizationId: org.id, userIds, release: { sha: release.sha ?? null, environment: release.environment ?? null, builtAt: release.builtAt ?? null } };
}

// ---------- seeding ----------
/**
 * Seed (or, with apply=false, plan / read back) one company. `call(method, path, body)` is a
 * same-session API call returning { status, json, limitReached }. `publicPost(path, body, siteKey)`
 * calls the public smart-site API. Throws nothing: halts are returned as a graded result.
 */
export async function seedCompany({ call, publicPost, company, cplan, plan, demoDate, apply, session = {}, now = () => Date.now(), quiet = false }) {
  const L = new Ledger(quiet);
  const result = { status: null, organizationId: cplan.organizationId, organizationName: company.name, demoDate, timezone: company.timezone, records: L.records };
  try {
    const admission = await admit({ call, company, cplan, plan });
    result.release = admission.release;
    await seedRecords({ call, publicPost, company, demoDate, apply, session, now, L, admission });
    const grade = gradeRecords(company, L.records, apply);
    result.grade = grade;
    result.status = grade.complete ? (apply ? "APPLIED" : "DRY-RUN") : apply ? "INCOMPLETE" : "DRY-RUN-INCOMPLETE";
  } catch (error) {
    const e = safeError(error);
    result.status = e.status;
    result.halt = { code: e.code, ...(e.detail ? { detail: e.detail } : {}) };
    result.grade = gradeRecords(company, L.records, apply);
    if (!(error instanceof SeedHalt) && process.env.DEMO_SEED_DEBUG) console.error(error);
  }
  return result;
}

async function seedRecords({ call, publicPost, company, demoDate, apply, session, now, L, admission }) {
  const tz = company.timezone;
  const day = (n) => addDays(demoDate, n);
  const orgId = admission.organizationId;
  const userByKey = admission.userIds;
  const ids = { contacts: {}, properties: {}, leads: {}, estimates: {}, appointments: {}, tasks: {}, assets: {}, invoices: {}, service: {} };
  const customer = (key) => company.customers.find((c) => c.key === key);

  /** Re-check the session before each write; a changed identity stops the run. */
  const guard = async () => {
    const me = await call("GET", "/api/v1/me");
    if (!ok(me) || me.json?.id !== admission.ownerId || me.json?.organization?.id !== orgId) throw new SeedHalt("BLOCKED", "session_changed");
  };
  const write = async (kind, key, method, pathname, body) => {
    await guard();
    const r = await call(method, pathname, body);
    if (r.status === 0 || r.status >= 500) { L.add(kind, key, "unknown", null, safeBrief(r)); throw new SeedHalt("UNKNOWN", "unknown_outcome", `${kind}:${key}`); }
    if (!ok(r)) { L.add(kind, key, "failed", null, safeBrief(r)); throw new SeedHalt("INCOMPLETE", "write_failed", `${kind}:${key}`); }
    return r;
  };
  const conflict = (kind, key, id, fields) => {
    L.add(kind, key, "conflict", id ?? null, `differs from reviewed fixture: ${fields}`);
    return new SeedHalt("HOLD", "fixture_conflict", `${kind}:${key}`);
  };
  /** Zero -> null; one exact match -> row; ambiguity or any field difference -> HOLD. */
  const pick = (kind, key, candidates, expectedOf) => {
    if (candidates.length > 1) throw conflict(kind, key, null, `ambiguous (${candidates.length} candidates)`);
    if (!candidates.length) return null;
    const row = candidates[0];
    const diff = diffFields(expectedOf(row), row);
    if (diff.length) throw conflict(kind, key, row.id, diff.join(","));
    return row;
  };
  const idOf = (r, ...keys) => { for (const k of keys.length ? keys : [""]) { const v = k ? r.json?.[k]?.id : r.json?.id; if (typeof v === "string" && UUID.test(v)) return v; } return null; };
  const created = (kind, key, r, ...keys) => {
    const id = idOf(r, ...keys);
    if (!id) { L.add(kind, key, "unknown", null, "write accepted without an ID"); throw new SeedHalt("UNKNOWN", "unknown_outcome", `${kind}:${key}`); }
    return id;
  };

  // Customers + properties
  const ensureProperty = async (c) => {
    const contactId = ids.contacts[c.key];
    const [addressLine1, city, state, postalCode] = c.address;
    const props = (await readList(call, "properties", `/api/v1/properties?contactId=${contactId}`, "offset")).filter((p) => p.contactId === contactId);
    const exact = props.filter((p) => p.addressLine1 === addressLine1);
    const found = pick("property", c.key, exact, () => ({ contactId, addressLine1, city, state, postalCode }));
    if (found) { ids.properties[c.key] = found.id; L.add("property", c.key, "existing", found.id); return; }
    // A different property on our customer means someone edited it: hold, do not add a second one.
    if (props.length) throw conflict("property", c.key, props[0].id, "address");
    if (!apply) { L.add("property", c.key, "would-create"); return; }
    const r = await write("property", c.key, "POST", "/api/v1/properties", { contactId, addressLine1, city, state, postalCode, propertyType: "residential" });
    ids.properties[c.key] = created("property", c.key, r);
    L.add("property", c.key, "created", ids.properties[c.key]);
  };
  const smartKey = company.smartSiteLead?.customer;
  for (const c of company.customers) {
    const list = await readList(call, "contacts", `/api/v1/contacts?search=${encodeURIComponent(c.email)}`, "offset");
    // Phones compare by digits: the website inquiry stores them normalized.
    const found = pick("customer", c.key, list.filter((x) => lower(x.email) === lower(c.email)).map((x) => ({ ...x, phone: digits(x.phone) })), () => ({ firstName: c.first, lastName: c.last, phone: digits(c.phone) }));
    if (found) { ids.contacts[c.key] = found.id; L.add("customer", c.key, "existing", found.id); await ensureProperty(c); continue; }
    if (c.key === smartKey) continue; // created by the website inquiry below
    if (!apply) { L.add("customer", c.key, "would-create"); L.add("property", c.key, "would-create"); continue; }
    const r = await write("customer", c.key, "POST", "/api/v1/contacts", { firstName: c.first, lastName: c.last, email: c.email, phone: c.phone, preferredContactMethod: "phone" });
    ids.contacts[c.key] = created("customer", c.key, r);
    L.add("customer", c.key, "created", ids.contacts[c.key]);
    await ensureProperty(c);
  }

  // Smart-site inquiry through the TEST site flow
  const ss = company.smartSiteLead;
  if (ss) {
    const cust = customer(ss.customer);
    const source = `${company.slug}-website`;
    if (ids.contacts[ss.customer]) {
      const leads = (await readList(call, "leads", `/api/v1/leads?search=${encodeURIComponent(cust.last.split(" ")[0])}`, "offset"))
        .filter((l) => l.contactId === ids.contacts[ss.customer] && l.creationMethod === "smart-site");
      const lead = pick("smart-site-lead", ss.customer, leads, () => ({ summary: ss.summary, source }));
      if (lead) { ids.leads["smart-site"] = lead.id; L.add("smart-site-lead", ss.customer, "existing", lead.id); }
      else throw conflict("smart-site-lead", ss.customer, null, "customer exists without its website inquiry");
    } else if (!session.siteKey || !session.siteId) {
      // Required for the walkthrough; recorded as not satisfied rather than skipped silently.
      L.add("customer", ss.customer, apply ? "blocked" : "would-create", null, "via website inquiry");
      L.add("property", ss.customer, apply ? "blocked" : "would-create", null, "via website inquiry");
      L.add("smart-site-lead", ss.customer, "blocked", null, "no TEST smart-site key for this target");
    } else if (!apply) {
      L.add("customer", ss.customer, "would-create", null, "via website inquiry");
      L.add("property", ss.customer, "would-create", null, "via website inquiry");
      L.add("smart-site-lead", ss.customer, "would-create");
    } else {
      const check = await publicPost(`/api/v1/public/smart-sites/${session.siteId}/check`, { schemaVersion: 1 }, session.siteKey);
      if (!ok(check)) { L.add("smart-site", "credential-check", check.status === 0 || check.status >= 500 ? "unknown" : "failed", null, safeBrief(check)); throw new SeedHalt("INCOMPLETE", "smart_site_check_failed"); }
      await write("smart-site", "activate", "PATCH", `/api/v1/smart-sites/${session.siteId}`, { isActive: true, confirmedLaunch: true });
      const profiles = readOk(await call("GET", "/api/v1/smart-sites/profiles"), "smart-site-profiles");
      const profile = (Array.isArray(profiles.json) ? profiles.json : profiles.json?.profiles ?? []).find((p) => p.id === company.profile);
      const s0 = profile?.services?.[0];
      const serviceCode = Array.isArray(s0) ? s0[0] : s0?.slug ?? s0?.code;
      if (typeof serviceCode !== "string") throw new SeedHalt("INCOMPLETE", "read_shape", "smart-site-profiles");
      const [address, city, state, postalCode] = cust.address;
      await guard();
      const response = await publicPost(`/api/v1/public/smart-sites/${session.siteId}/intake`, {
        schemaVersion: 1, requestId: stableId(orgId, "smart-site", ss.customer),
        contact: { name: `${cust.first} ${cust.last}`, email: cust.email, phone: cust.phone },
        project: { serviceCode, address, city, state, postalCode, summary: ss.summary, timing: ss.timing },
        consent: { contact: true, policyVersion: "test-demo-2026-10-17", analytics: false, channels: ["email"] },
      }, session.siteKey);
      if (response.status === 0 || response.status >= 500) { L.add("smart-site-lead", ss.customer, "unknown", null, safeBrief(response)); throw new SeedHalt("UNKNOWN", "unknown_outcome", "smart-site-lead"); }
      if (!ok(response) || !UUID.test(response.json?.leadId ?? "")) { L.add("smart-site-lead", ss.customer, "failed", null, safeBrief(response)); throw new SeedHalt("INCOMPLETE", "write_failed", "smart-site-lead"); }
      const lead = await readOne(call, "lead", `/api/v1/leads/${response.json.leadId}`);
      const leadRow = lead.lead ?? lead;
      const contact = UUID.test(leadRow.contactId ?? "") ? await readOne(call, "contact", `/api/v1/contacts/${leadRow.contactId}`) : null;
      const cdiff = contact ? diffFields({ email: cust.email, firstName: cust.first, lastName: cust.last }, { ...contact, email: lower(contact.email) }) : ["contactId"];
      const ldiff = diffFields({ summary: ss.summary, source, creationMethod: "smart-site" }, leadRow);
      if (cdiff.length || ldiff.length) throw conflict("smart-site-lead", ss.customer, response.json.leadId, [...cdiff, ...ldiff].join(","));
      ids.contacts[ss.customer] = contact.id;
      L.add("customer", ss.customer, response.json.duplicate ? "existing" : "created", contact.id, "via website inquiry");
      L.add("smart-site-lead", ss.customer, response.json.duplicate ? "existing" : "created", response.json.leadId, "TEST website inquiry");
      ids.leads["smart-site"] = response.json.leadId;
      await ensureProperty(cust);
    }
  }

  // Leads
  for (const l of company.leads) {
    const contactId = ids.contacts[l.customer];
    const propertyId = ids.properties[l.customer] ?? null;
    if (!contactId) { L.add("lead", l.key, apply ? "blocked" : "would-create", null, apply ? "customer missing" : undefined); continue; }
    const last = customer(l.customer).last.split(" ")[0];
    const rows = (await readList(call, "leads", `/api/v1/leads?search=${encodeURIComponent(last)}`, "offset")).filter((x) => x.contactId === contactId && x.serviceType === l.serviceType);
    const found = pick("lead", l.key, rows, () => ({ propertyId, assignedUserId: userByKey.owner, status: l.status, urgency: l.urgency, source: l.source, summary: l.summary, estimatedValueCents: l.valueCents }));
    if (found) { ids.leads[l.key] = found.id; L.add("lead", l.key, "existing", found.id); continue; }
    if (!apply) { L.add("lead", l.key, "would-create"); continue; }
    const r = await write("lead", l.key, "POST", "/api/v1/leads", {
      contactId, ...(propertyId ? { propertyId } : {}), assignedUserId: userByKey.owner,
      status: l.status, urgency: l.urgency, serviceType: l.serviceType, source: l.source, summary: l.summary, estimatedValueCents: l.valueCents,
    });
    ids.leads[l.key] = created("lead", l.key, r);
    L.add("lead", l.key, "created", ids.leads[l.key]);
  }

  // Estimates (good/better/best are three option estimates on one lead)
  for (const e of company.estimates) {
    const leadId = ids.leads[e.lead];
    if (!leadId) { L.add("estimate", e.key, apply ? "blocked" : "would-create", null, apply ? "lead missing" : undefined); continue; }
    const rows = (await readList(call, "estimates", `/api/v1/estimates?leadId=${leadId}`, "offset")).filter((x) => x.leadId === leadId && x.title === e.title);
    const found = pick("estimate", e.key, rows, () => ({ status: e.status, notes: e.notes, taxCents: 0, totalCents: cents(e.lines) }));
    if (found) {
      const ldiff = diffFields({ lines: fixtureLines(e.lines) }, { lines: normLines(found.lineItems) });
      if (ldiff.length) throw conflict("estimate", e.key, found.id, "lineItems");
      ids.estimates[e.key] = found.id; L.add("estimate", e.key, "existing", found.id); continue;
    }
    if (!apply) { L.add("estimate", e.key, "would-create"); continue; }
    const r = await write("estimate", e.key, "POST", "/api/v1/estimates", {
      leadId, title: e.title, status: e.status, taxCents: 0, notes: e.notes,
      lineItems: e.lines.map(([description, quantity, unitPriceCents]) => ({ description, quantity, unitPriceCents, totalCents: Math.round(quantity * unitPriceCents) })),
    });
    ids.estimates[e.key] = created("estimate", e.key, r);
    L.add("estimate", e.key, "created", ids.estimates[e.key], `$${(cents(e.lines) / 100).toFixed(2)}`);
  }

  // Equipment / roof assets (with warranty dates)
  for (const a of company.assets) {
    const contactId = ids.contacts[a.customer];
    if (!contactId) { L.add("asset", a.key, apply ? "blocked" : "would-create"); continue; }
    const { key, customer: custKey, ...fields } = a;
    const propertyId = ids.properties[custKey] ?? null;
    const rows = (await readList(call, "assets", `/api/v1/contacts/${contactId}/assets`, "cursor")).filter((x) => x.label === a.label);
    const found = pick("asset", key, rows, () => ({ ...fields, contactId, propertyId, status: "active" }));
    if (found) { ids.assets[key] = found.id; L.add("asset", key, "existing", found.id); continue; }
    if (!apply) { L.add("asset", key, "would-create"); continue; }
    const r = await write("asset", key, "POST", `/api/v1/contacts/${contactId}/assets`, {
      requestId: stableId(orgId, "asset", key), propertyId, ...fields,
      location: company.trade === "hvac" ? "TEST equipment location" : "TEST whole roof", notes: "TEST demo record", attributes: [],
    });
    ids.assets[key] = created("asset", key, r, "asset", "");
    L.add("asset", key, "created", ids.assets[key]);
  }

  // Appointments for the demo week: exact reviewed instants, never relabeled
  for (const a of company.appointments) {
    const contactId = ids.contacts[a.customer];
    const start = zonedInstant(day(a.day), a.start, tz);
    const end = new Date(start.getTime() + a.minutes * 60_000);
    const label = `${day(a.day)} ${a.start} ${tz}`;
    if (!contactId) { L.add("appointment", a.key, apply ? "blocked" : "would-create", null, label); if (a.complete) L.add("visit-complete", a.key, apply ? "blocked" : "would-update"); continue; }
    const leadId = a.lead ? ids.leads[a.lead] ?? null : null;
    const rows = (await readList(call, "appointments", `/api/v1/appointments?contactId=${contactId}`, "capped")).filter((x) => x.notes === a.notes && x.status !== "cancelled");
    const allowed = a.complete ? ["scheduled", "confirmed", "completed"] : ["scheduled", "confirmed"];
    const found = pick("appointment", a.key, rows, (x) => ({
      contactId, propertyId: ids.properties[a.customer] ?? null, assignedUserId: userByKey[a.staff], type: a.type,
      scheduledStart: start.toISOString(), scheduledEnd: end.toISOString(), ...(a.lead ? { leadId } : {}), status: allowed.includes(x.status) ? x.status : allowed[0],
    }));
    let current = found;
    if (found) { ids.appointments[a.key] = found.id; L.add("appointment", a.key, "existing", found.id, `${label} ${found.status}`); }
    else if (!apply) { L.add("appointment", a.key, "would-create", null, label); if (a.complete) L.add("visit-complete", a.key, "would-update"); continue; }
    else if (start.getTime() <= now() + 60_000) { L.add("appointment", a.key, "blocked", null, `${label} is in the past; the reviewed demo date has passed`); throw new SeedHalt("HOLD", "demo_date_passed", a.key); }
    else {
      const r = await write("appointment", a.key, "POST", "/api/v1/appointments", {
        ...(leadId ? { leadId } : {}), contactId, propertyId: ids.properties[a.customer] ?? null,
        assignedUserId: userByKey[a.staff], type: a.type, scheduledStart: start.toISOString(), scheduledEnd: end.toISOString(), notes: a.notes,
      });
      ids.appointments[a.key] = created("appointment", a.key, r);
      current = r.json;
      L.add("appointment", a.key, "created", ids.appointments[a.key], label);
    }
    if (a.complete) {
      if (current.status === "completed") L.add("visit-complete", a.key, "existing", current.id);
      else if (!apply) L.add("visit-complete", a.key, "would-update", current.id);
      else {
        await write("visit-complete", a.key, "PATCH", `/api/v1/appointments/${current.id}`, { status: "completed", expectedUpdatedAt: current.updatedAt });
        L.add("visit-complete", a.key, "updated", current.id, "marked completed");
      }
    }
  }

  // Follow-up tasks for the Today list
  const taskList = await readList(call, "tasks", "/api/v1/tasks", "capped");
  for (const t of company.tasks) {
    const contactId = ids.contacts[t.customer] ?? null;
    const leadId = ids.leads[t.lead] ?? null;
    if (!contactId) { L.add("task", t.key, apply ? "blocked" : "would-create"); continue; }
    const dueAt = zonedInstant(day(t.day), t.due, tz).toISOString();
    const found = pick("task", t.key, taskList.filter((x) => x.title === t.title), () => ({ contactId, ...(leadId ? { leadId } : {}), assignedUserId: userByKey[t.staff], priority: t.priority, dueAt, status: "open" }));
    if (found) { ids.tasks[t.key] = found.id; L.add("task", t.key, "existing", found.id); continue; }
    if (!apply) { L.add("task", t.key, "would-create"); continue; }
    const r = await write("task", t.key, "POST", "/api/v1/tasks", {
      title: t.title, ...(leadId ? { leadId } : {}), contactId, assignedUserId: userByKey[t.staff], priority: t.priority, dueAt, status: "open",
    });
    ids.tasks[t.key] = created("task", t.key, r);
    L.add("task", t.key, "created", ids.tasks[t.key]);
  }

  // Invoices: exact lineage before issue/payment. Same title alone is never enough.
  const listInvoices = () => readList(call, "invoices", "/api/v1/invoices", "pages");
  let invoices = await listInvoices();
  for (const inv of company.invoices) {
    const contactId = ids.contacts[inv.customer];
    if (!contactId) {
      L.add("invoice", inv.key, apply ? "blocked" : "would-create");
      if (inv.issue) L.add("invoice-issue", inv.key, apply ? "blocked" : "would-update");
      if (inv.paidInFull) L.add("invoice-payment", inv.key, apply ? "blocked" : "would-create");
      continue;
    }
    const cust = customer(inv.customer);
    const total = cents(inv.lines);
    const expectInvoice = (x) => ({ contactId, propertyId: ids.properties[inv.customer] ?? null, totalCents: total, taxCents: 0, currency: "USD", customerName: `${cust.first} ${cust.last}`,
      status: ["draft", "issued"].includes(x.status) ? x.status : "issued", reconciliationRequired: false });
    const verifyDocument = async (id) => {
      const detail = await readOne(call, "invoice", `/api/v1/invoices/${id}`);
      const d = diffFields({ lines: fixtureLines(inv.lines), title: inv.title }, { lines: normLines(detail.document?.lineItems), title: detail.document?.title });
      if (detail.organizationId !== orgId) d.push("organizationId");
      if (d.length) throw conflict("invoice", inv.key, id, d.join(","));
      return detail;
    };
    let invoice = pick("invoice", inv.key, invoices.filter((x) => x.title === inv.title), expectInvoice);
    if (invoice) { invoice = await verifyDocument(invoice.id); L.add("invoice", inv.key, "existing", invoice.id, `$${(total / 100).toFixed(2)} ${invoice.status}`); }
    else if (!apply) {
      L.add("invoice", inv.key, "would-create");
      if (inv.issue) L.add("invoice-issue", inv.key, "would-update");
      if (inv.paidInFull) L.add("invoice-payment", inv.key, "would-create");
      continue;
    } else {
      const r = await write("invoice", inv.key, "POST", "/api/v1/invoices", {
        requestId: stableId(orgId, "invoice", inv.key),
        source: { kind: "existing_customer", contactId, propertyId: ids.properties[inv.customer] ?? null },
        document: {
          title: inv.title, currency: "USD", issuerName: company.name, customerName: `${cust.first} ${cust.last}`,
          dueDate: addDays(demoDate, 14), notes: "TEST demo record - not a real bill. Email delivery is held in this demo.",
          lineItems: inv.lines.map(([description, quantity, unitPriceCents]) => ({ description, quantity: String(quantity), unitPriceCents })), taxCents: 0,
        },
      });
      const id = created("invoice", inv.key, r, "invoice", "");
      invoice = await verifyDocument(id);
      const d = diffFields(expectInvoice(invoice), invoice);
      if (d.length) throw conflict("invoice", inv.key, id, d.join(","));
      L.add("invoice", inv.key, r.json?.duplicate ? "existing" : "created", id, `$${(total / 100).toFixed(2)} ${invoice.status}`);
    }
    ids.invoices[inv.key] = invoice.id;
    if (inv.issue) {
      if (invoice.status === "issued") L.add("invoice-issue", inv.key, "existing", invoice.id);
      else if (!apply) L.add("invoice-issue", inv.key, "would-update", invoice.id);
      else {
        await write("invoice-issue", inv.key, "POST", `/api/v1/invoices/${invoice.id}/issue`, { requestId: stableId(orgId, "invoice-issue", inv.key), expectedVersion: invoice.version, confirmed: true });
        invoice = await verifyDocument(invoice.id);
        if (invoice.status !== "issued") throw conflict("invoice-issue", inv.key, invoice.id, "status");
        L.add("invoice-issue", inv.key, "updated", invoice.id, "issued (not emailed)");
      }
    }
    const paid = Number(invoice.recordedPaidCents ?? 0);
    if (inv.paidInFull) {
      if (invoice.paymentState === "paid" && paid === total) L.add("invoice-payment", inv.key, "existing", invoice.id, "already paid");
      else if (paid !== 0) throw conflict("invoice-payment", inv.key, invoice.id, "recordedPaidCents");
      else if (!apply) L.add("invoice-payment", inv.key, "would-create", invoice.id);
      else if (invoice.status !== "issued") throw conflict("invoice-payment", inv.key, invoice.id, "status");
      else {
        await write("invoice-payment", inv.key, "POST", `/api/v1/invoices/${invoice.id}/payments`, {
          requestId: stableId(orgId, "invoice-payment", inv.key), expectedVersion: invoice.version, confirmed: true,
          amountCents: total, sourceReference: inv.payRef, occurredAt: new Date(now() - 60 * 60_000).toISOString(),
        });
        invoice = await verifyDocument(invoice.id);
        if (invoice.paymentState !== "paid" || Number(invoice.recordedPaidCents) !== total) throw conflict("invoice-payment", inv.key, invoice.id, "paymentState");
        L.add("invoice-payment", inv.key, "created", invoice.id, `staff-recorded ${inv.payRef} $${(total / 100).toFixed(2)}`);
      }
    } else if (paid !== 0) throw conflict("invoice", inv.key, invoice.id, "recordedPaidCents");
  }

  // Maintenance / service agreements (service date + recurrence). Reminders stay held.
  const obligations = (await readList(call, "service-obligations", "/api/v1/service-obligations", "header")).map((x) => x.obligation ?? x);
  for (const s of company.serviceAgreements) {
    const contactId = ids.contacts[s.customer];
    if (!contactId) { L.add("service-plan", s.key, apply ? "blocked" : "would-create"); L.add("service-recurrence", s.key, apply ? "blocked" : "would-create"); continue; }
    const dueDate = day(s.dueInDays);
    let ob = pick("service-plan", s.key, obligations.filter((o) => o.contactId === contactId && o.notes === s.note && o.status !== "cancelled"), () => ({
      propertyId: ids.properties[s.customer] ?? null, kind: s.kind, equipmentLabel: s.equipmentLabel, noticeDays: s.noticeDays, status: "active",
    }));
    // Service dates are stored as a UTC-noon instant of the due day.
    if (ob && ymdIn(ob.dueAt, "UTC") !== dueDate) throw conflict("service-plan", s.key, ob.id, `dueAt (existing ${ymdIn(ob.dueAt, "UTC")}, reviewed ${dueDate})`);
    if (ob) { L.add("service-plan", s.key, "existing", ob.id); }
    else if (!apply) { L.add("service-plan", s.key, "would-create"); L.add("service-recurrence", s.key, "would-create"); continue; }
    else {
      const r = await write("service-plan", s.key, "POST", "/api/v1/service-obligations", {
        contactId, propertyId: ids.properties[s.customer] ?? null, kind: s.kind, equipmentLabel: s.equipmentLabel,
        dueDate, noticeDays: s.noticeDays, assignedUserId: userByKey[s.staff], notes: s.note,
      });
      const id = created("service-plan", s.key, r);
      ob = r.json;
      L.add("service-plan", s.key, "created", id);
    }
    ids.service[s.key] = ob.id;
    const rec = ob.recurrence;
    if (rec && rec.intervalMonths === s.intervalMonths && rec.agreementNote === s.note) L.add("service-recurrence", s.key, "existing", ob.id, `repeats every ${s.intervalMonths} months`);
    else if (rec) throw conflict("service-recurrence", s.key, ob.id, "recurrence");
    else if (!apply) L.add("service-recurrence", s.key, "would-create", ob.id);
    else {
      await write("service-recurrence", s.key, "POST", `/api/v1/service-obligations/${ob.id}/recurrence`, {
        expectedUpdatedAt: ob.updatedAt, intervalMonths: s.intervalMonths, endDate: addDays(demoDate, 730), agreementNote: s.note,
      });
      L.add("service-recurrence", s.key, "created", ob.id, `repeats every ${s.intervalMonths} months`);
    }
  }

  // Returning-customer work (estimate on an existing customer, no invented lead)
  for (const w of company.returningWork) {
    const contactId = ids.contacts[w.customer];
    if (!contactId) { L.add("returning-work", w.key, apply ? "blocked" : "would-create"); continue; }
    const rows = (await readList(call, "estimates", `/api/v1/estimates?contactId=${contactId}`, "offset")).filter((x) => x.title === w.title);
    const found = pick("returning-work", w.key, rows, () => ({ contactId, propertyId: ids.properties[w.customer] ?? null, notes: w.notes, taxCents: 0, totalCents: cents(w.lines), sourceKind: "customer_work" }));
    if (found) {
      if (diffFields({ lines: fixtureLines(w.lines) }, { lines: normLines(found.lineItems) }).length) throw conflict("returning-work", w.key, found.id, "lineItems");
      ids.estimates[w.key] = found.id; L.add("returning-work", w.key, "existing", found.id); continue;
    }
    if (!apply) { L.add("returning-work", w.key, "would-create"); continue; }
    const r = await write("returning-work", w.key, "POST", "/api/v1/customer-work/estimates", {
      requestId: stableId(orgId, "returning-work", w.key), confirmed: true,
      source: { kind: "existing_customer", contactId, propertyId: ids.properties[w.customer] ?? null },
      title: w.title, lineItems: w.lines.map(([description, quantity, unitPriceCents]) => ({ description, quantity, unitPriceCents })), taxCents: 0, notes: w.notes,
    });
    ids.estimates[w.key] = created("returning-work", w.key, r, "estimate", "");
    L.add("returning-work", w.key, "created", ids.estimates[w.key]);
  }
}

/** Seed, then (after an apply) re-read every fixture in a fresh read-only pass that must re-match all of them exactly. */
export async function runCompany(args) {
  const result = await seedCompany(args);
  if (args.apply && result.status === "APPLIED") {
    const back = await seedCompany({ ...args, apply: false, quiet: true });
    const notExisting = back.records.filter((r) => r.outcome !== "existing").length;
    result.readBack = {
      status: back.status, reMatched: back.records.length - notExisting, required: back.grade.required, pass: back.status === "DRY-RUN" && notExisting === 0,
      ...(back.halt ? { halt: back.halt } : {}), ...(notExisting ? { issues: back.records.filter((r) => r.outcome !== "existing") } : {}),
    };
    if (!result.readBack.pass) result.status = "INCOMPLETE";
    if (!args.quiet) console.log(`  read-back: ${result.readBack.pass ? "PASS" : "FAIL"} (${result.readBack.reMatched} records re-matched)`);
  }
  return result;
}

// ---------- UI verification ----------
/** Fixture verification: every expected item must be visible, separately from the page-load smoke check. */
export function gradeUiPage(name, url, expected, text, loaded) {
  const seen = expected.filter((e) => text.includes(e));
  const missing = expected.filter((e) => !text.includes(e));
  return { page: name, url, smoke: loaded, expected: expected.length, seen: seen.length, missing, pass: loaded && missing.length === 0 };
}
export function uiExpectations(company) {
  const lastOf = (key) => company.customers.find((c) => c.key === key).last;
  return [
    ["today", "/today", company.appointments.filter((a) => a.day === 0).map((a) => lastOf(a.customer)).concat(company.tasks.filter((t) => t.day === 0).map((t) => t.title))],
    ["customers", "/contacts", company.customers.map((c) => c.last)],
    ["estimates", "/estimates", company.estimates.map((e) => e.title).concat(company.returningWork.map((w) => w.title))],
    ["appointments", "/appointments", company.appointments.map((a) => lastOf(a.customer))],
    ["invoices", "/invoices", company.invoices.map((i) => i.title)],
    ["service", "/service", company.serviceAgreements.map((s) => lastOf(s.customer))],
    ["pipeline", "/pipeline", company.leads.map((l) => lastOf(l.customer))],
  ];
}
async function verifyUi(page, origin, company, demoDate, shotDir, prefix) {
  await mkdir(shotDir, { recursive: true });
  const checks = [];
  for (const [name, url, expected] of uiExpectations(company)) {
    let loaded = false;
    try {
      const response = await page.goto(`${origin}${url}`);
      await page.waitForLoadState("networkidle").catch(() => {});
      if (name === "today") {
        const input = page.locator('input[type="date"]').first();
        if (await input.count()) { await input.fill(demoDate); await page.waitForLoadState("networkidle").catch(() => {}); await page.waitForTimeout(1200); }
      }
      await page.waitForTimeout(800);
      loaded = Boolean(response && response.status() < 400) && sameOrigin(page.url(), origin) && !new URL(page.url()).pathname.startsWith("/login");
    } catch { loaded = false; }
    const text = await page.locator("body").innerText().catch(() => "");
    const file = path.join(shotDir, `${prefix}-${String(checks.length + 1).padStart(2, "0")}-${name}.png`);
    await page.screenshot({ path: file, fullPage: true }).catch(() => {});
    const check = { ...gradeUiPage(name, url, expected, text, loaded), screenshot: path.basename(file) };
    checks.push(check);
    console.log(`  ${check.pass ? "PASS" : "FAIL"} ${name}: ${check.seen}/${check.expected} fixtures visible${check.missing.length ? ` (missing ${check.missing.length})` : ""}`);
  }
  return { pass: checks.every((c) => c.pass), pages: checks };
}

// ---------- custody and run paths ----------
export function newRunId(target, mode, company, now = new Date()) {
  return `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${target}-${mode}-${company}-${randomBytes(3).toString("hex")}`;
}
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
export async function collectCustody(repoRoot = REPO_ROOT) {
  const git = (...a) => { try { return execFileSync("git", ["-C", repoRoot, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
  const files = {};
  for (const rel of ["scripts/demo/seed-soft-onboarding.mjs", "scripts/demo/demo-data.mjs", "scripts/demo/demo-runtime.mjs", "scripts/demo/runtime-manifest.mjs", "docs/demo/SOFT-ONBOARDING-WALKTHROUGH.md"]) {
    try { files[rel] = sha256(await readFile(path.join(repoRoot, rel))); } catch { files[rel] = null; }
  }
  let playwright = null;
  try { playwright = JSON.parse(await readFile("C:/Forge/tools/shipping-kit/node_modules/playwright/package.json", "utf8")).version; } catch {}
  return {
    head: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    schemaTree: git("rev-parse", "HEAD:lib/db/src/schema"),
    uncommittedDemoFiles: (git("status", "--porcelain", "--", "scripts/demo", "docs/demo") ?? "").split("\n").filter(Boolean).length,
    files,
    node: process.version,
    playwright,
  };
}
export async function writeHashList(runDir) {
  const out = {};
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name !== "hashes.json") out[path.relative(runDir, full).replace(/\\/g, "/")] = sha256(await readFile(full));
    }
  };
  await walk(runDir);
  await writeFile(path.join(runDir, "hashes.json"), JSON.stringify({ algorithm: "sha256", files: out }, null, 2) + "\n");
  return out;
}

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
  assertApiPath(pathname);
  if (!sameOrigin(page.url(), origin)) await page.goto(`${origin}/`);
  if (!sameOrigin(page.url(), origin)) throw new SeedHalt("BLOCKED", "origin_changed");
  if (process.env.DEMO_SEED_DEBUG) console.log(`    > ${method} ${pathname}`);
  return page.evaluate(async ({ method, pathname, body }) => {
    try {
      const response = await fetch(pathname, {
        method,
        signal: AbortSignal.timeout(90_000),
        credentials: "same-origin",
        redirect: "error",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: response.status, json, limitReached: response.headers.get("x-result-limit-reached") };
    } catch {
      return { status: 0, json: null, limitReached: null };
    }
  }, { method, pathname, body });
}

async function publicPostFor(origin, pathname, body, siteKey) {
  assertApiPath(pathname);
  try {
    const response = await fetch(`${origin}${pathname}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(90_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${siteKey}` },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => null);
    return { status: response.status, json };
  } catch {
    return { status: 0, json: null };
  }
}

async function signIn(page, origin, target, company, cplan, options, secrets) {
  if (target === "local") {
    const login = secrets[company.key];
    await page.goto(`${origin}/login`);
    await page.getByPlaceholder("Email", { exact: true }).fill(login.email);
    await page.getByPlaceholder("Password", { exact: true }).fill(login.password);
    await page.getByRole("button", { name: "SIGN IN", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20000 });
    return login.siteKey && cplan.siteId ? { siteId: cplan.siteId, siteKey: login.siteKey } : { siteId: null, siteKey: null };
  }
  // Staging: a credential module that keeps secrets in memory only. It signs
  // the page in and may return { siteId, siteKey } for the TEST site; any
  // other return shape, or a site other than the reviewed one, is refused.
  const mod = await import(pathToFileURL(options.authModule ?? DEFAULT_AUTH_MODULE).href);
  let result;
  if (typeof mod.signInDemoOwner === "function") result = await mod.signInDemoOwner(page, company.key);
  else if (typeof mod.signInTestOwner === "function") result = await mod.signInTestOwner(page);
  else throw blocked("auth_module_contract");
  return validateAuthResult(result, cplan.siteId);
}

// ---------- main ----------
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const { target, origin } = classifyBaseUrl(options.baseUrl);
  const keys = options.company === "both" ? ["css", "painless"] : [options.company];
  const mode = options.apply ? "apply" : "dryrun";
  let built;
  if (target === "local") {
    if (!options.localManifest) throw new Error("--local-manifest is required for the local runtime (the path the runtime printed).");
    if (options.executionManifest) throw new Error("--execution-manifest is for staging only.");
    built = planFromLocalManifest(JSON.parse(await readFile(options.localManifest, "utf8")), { origin, keys, demoDate: options.demoDate });
  } else {
    if (!options.executionManifest) throw new Error("--execution-manifest (reviewed, exact IDs, release SHA and hold attestation) is required for staging.");
    built = planFromExecutionManifest(JSON.parse(await readFile(options.executionManifest, "utf8")), { origin, keys, demoDate: options.demoDate });
  }
  const { plan, secrets } = built;
  const runId = newRunId(target, mode, options.company);
  const runDir = path.join(options.receiptDir ?? RECEIPT_DIR, "runs", runId);
  const lockDir = options.lockDir ?? path.join(os.tmpdir(), "growthos-soft-onboarding-locks");
  if (existsSync(runDir)) throw new Error("Run directory already exists; refusing to overwrite evidence.");
  await mkdir(runDir, { recursive: true });
  console.log(`[demo-seed] run=${runId} target=${target} origin=${origin} companies=${keys.join(",")} mode=${mode.toUpperCase()}${options.verify ? " +verify" : ""} demo-date=${plan.demoDate}`);
  const receipt = {
    kind: "growthos-soft-onboarding-demo-seed",
    schemaVersion: 2,
    runId,
    startedAt: new Date().toISOString(),
    target, origin, mode,
    demoDate: plan.demoDate,
    options: { company: options.company, apply: options.apply, verify: options.verify, demoDateOverride: options.demoDate ?? null },
    plan: { ...plan, companies: plan.companies },
    custody: await collectCustody(),
    note: "IDs, outcomes and allowlisted status codes only. No credentials, cookies, tokens, site keys or response text. All records are fictional TEST data. Earlier receipts in the parent folder were producer-recorded under the weaker 7fb2b33 assertions and are not re-graded by this run.",
    companies: {},
  };
  const { chromium } = await loadPlaywright();
  const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
  try {
    for (const key of keys) {
      const company = DEMO_COMPANIES[key];
      const cplan = plan.companies[key];
      console.log(`[demo-seed] ${company.name} (demo day ${plan.demoDate} ${company.timezone})`);
      let lock = null;
      // Ephemeral context: no tracing, video, HAR or saved storage state.
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      try {
        lock = await acquireRunLock(lockDir, origin, cplan.organizationId, runId);
        const session = await signIn(page, origin, target, company, cplan, options, secrets);
        const call = (method, p, body) => api(page, origin, method, p, body);
        const publicPost = (p, body, siteKey) => publicPostFor(origin, p, body, siteKey);
        const result = await runCompany({ call, publicPost, company, cplan, plan, demoDate: plan.demoDate, apply: options.apply, session });
        if (options.verify && !["BLOCKED", "ERROR"].includes(result.status)) {
          result.ui = await verifyUi(page, origin, company, plan.demoDate, path.join(runDir, "screenshots"), `${target}-${key}`);
          result.ui.kind = "fixture visibility (every expected item must appear); smoke = page loaded on the exact origin without a login redirect";
        }
        receipt.companies[key] = result;
        console.log(`[demo-seed] ${company.name}: ${result.status}${result.halt ? ` - ${result.halt.code}${result.halt.detail ? ` ${result.halt.detail}` : ""}` : ""}`);
      } catch (error) {
        const e = safeError(error);
        receipt.companies[key] = { status: e.status, halt: { code: e.code, ...(e.detail ? { detail: e.detail } : {}) } };
        console.error(`[demo-seed] ${company.name}: ${e.status} ${e.code}${e.detail ? ` ${e.detail}` : ""}`);
        if (process.env.DEMO_SEED_DEBUG) console.error(error);
      } finally {
        await releaseRunLock(lock);
        await context.close();
      }
    }
  } finally {
    await browser.close();
    receipt.completedAt = new Date().toISOString();
    await writeFile(path.join(runDir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    await writeHashList(runDir);
    console.log(`[demo-seed] receipt ${path.join(runDir, "receipt.json")}`);
  }
  process.exitCode = exitCodeFor(receipt, options);
  return receipt;
}

/** 0 only when every company reached its success status (and, with --verify, every UI fixture check passed). */
export function exitCodeFor(receipt, options) {
  const companies = Object.values(receipt.companies);
  const want = options.apply ? "APPLIED" : "DRY-RUN";
  if (!companies.length || companies.some((c) => c.status !== want)) return 2;
  if (options.verify && companies.some((c) => !c.ui?.pass)) return 3;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { const e = safeError(error); console.error(`[demo-seed] ${e.status} ${e.code}${error instanceof SeedHalt ? "" : `: ${String(error.message).split("\n")[0]}`}`); process.exitCode = 1; });
}
