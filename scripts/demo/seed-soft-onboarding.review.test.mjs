// Regression tests for the Codex review of 7fb2b33 (6 Important / 3 Minor).
// Everything runs against the in-memory fake API: no network, browser or database.
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_DATE } from "./demo-data.mjs";
import { FakeGrowthOS, fakePlan } from "./fake-growthos-api.mjs";
import { createOwnedManifest, removeOwnedManifest } from "./runtime-manifest.mjs";
import {
  STAGING_ORIGIN, acquireRunLock, assertApiPath, collectCustody, exitCodeFor, gradeUiPage, newRunId, planFromExecutionManifest,
  planFromLocalManifest, releaseRunLock, readList, runCompany, safeBrief, safeError, sameOrigin, seedCompany, validateAuthResult, writeHashList, zonedInstant,
} from "./seed-soft-onboarding.mjs";

const NOW = () => Date.parse("2026-10-16T18:00:00Z");
function setup(key = "css") {
  const { plan, cplan, company } = fakePlan(key);
  const api = new FakeGrowthOS({ company, cplan });
  const args = { call: api.call, publicPost: api.publicPost, company, cplan, plan, demoDate: DEMO_DATE, apply: true, session: api.session(), now: NOW, quiet: true };
  return { api, args, company, cplan, plan };
}
const tmp = () => mkdtemp(path.join(os.tmpdir(), "soft-onboarding-test-"));

describe("baseline against the fake API", () => {
  it("applies both companies, re-reads every fixture, then re-runs with zero writes", async () => {
    for (const key of ["css", "painless"]) {
      const { api, args } = setup(key);
      const first = await runCompany(args);
      expect(first.status).toBe("APPLIED");
      expect(first.readBack.pass).toBe(true);
      const writes = api.writes.length;
      const second = await runCompany(args);
      expect(second.status).toBe("APPLIED");
      expect(second.records.every((r) => r.outcome === "existing")).toBe(true);
      expect(api.writes.length).toBe(writes);
    }
  });
  it("dry-run writes nothing and plans every required fixture", async () => {
    const { api, args } = setup();
    const r = await seedCompany({ ...args, apply: false });
    expect(r.status).toBe("DRY-RUN");
    expect(r.grade.complete).toBe(true);
    expect(api.writes).toEqual([]);
  });
});

describe("I1 write admission", () => {
  it("BLOCKS with zero writes when /users returns 403 (never assigns to the current user)", async () => {
    const { api, args } = setup();
    api.fault("GET", /^\/api\/v1\/users$/, () => ({ status: 403, json: { error: "Forbidden" } }));
    const r = await seedCompany(args);
    expect(r.status).toBe("BLOCKED");
    expect(r.halt.code).toBe("staff_unverified");
    expect(api.writes).toEqual([]);
  });
  it("BLOCKS when a staff member is missing or has a different ID than reviewed", async () => {
    const { api, args } = setup();
    api.users = api.users.filter((u) => u.role === "owner");
    expect((await seedCompany(args)).halt.code).toBe("staff_unverified");
    const s2 = setup();
    s2.api.users[1].id = "00000000-0000-4000-8000-000000000000";
    expect((await seedCompany(s2.args)).status).toBe("BLOCKED");
    expect(api.writes.length + s2.api.writes.length).toBe(0);
  });
  it.each([
    ["organization id", (api) => { api.org.id = "11111111-1111-4111-8111-111111111111"; }],
    ["slug", (api) => { api.org.slug = "some-other-slug"; }],
    ["timezone", (api) => { api.org.timezone = "America/Chicago"; }],
    ["owner identity (another member signed in)", (api) => { api.meId = api.users[1].id; }],
  ])("BLOCKS on unreviewed %s with zero writes", async (_label, mutate) => {
    const { api, args } = setup();
    mutate(api);
    const r = await seedCompany(args);
    expect(r.status).toBe("BLOCKED");
    expect(r.halt.code).toBe("identity_mismatch");
    expect(api.writes).toEqual([]);
  });
  it("stops when the session changes identity mid-run", async () => {
    const { api, args } = setup();
    let meCalls = 0;
    api.fault("GET", /^\/api\/v1\/me$/, () => (++meCalls > 3 ? { status: 200, json: { id: api.meId, organization: { id: "22222222-2222-4222-8222-222222222222" } } } : null));
    const r = await seedCompany(args);
    expect(r.status).toBe("BLOCKED");
    expect(r.halt.code).toBe("session_changed");
    expect(api.writes.length).toBeLessThanOrEqual(2);
  });
  it("compares parsed origins exactly and only allows relative /api paths", () => {
    expect(sameOrigin("https://mogulforge-growthos-staging.fly.dev.evil.example/x", STAGING_ORIGIN)).toBe(false);
    expect(sameOrigin("https://mogulforge-growthos-staging.fly.dev/today", STAGING_ORIGIN)).toBe(true);
    expect(sameOrigin("http://127.0.0.1:41920/", "http://127.0.0.1:4192")).toBe(false);
    for (const p of ["//evil.example/api/v1/x", "https://evil.example/api", "/api/../x", "api/v1/me", "/login"]) expect(() => assertApiPath(p)).toThrow();
    expect(assertApiPath("/api/v1/contacts?search=a%40example.com")).toBeTruthy();
  });
  it("requires a reviewed staging execution manifest with exact IDs, pinned release and a fresh hold attestation", () => {
    const now = Date.parse("2026-10-17T10:00:00Z");
    const { cplan } = fakePlan("css");
    const m = {
      kind: "growthos-soft-onboarding-execution-manifest", target: "staging", origin: STAGING_ORIGIN, demoDate: DEMO_DATE,
      reviewedBy: "Codex", reviewedAt: "2026-10-17T09:00:00Z", release: { sha: "a".repeat(40), environment: "staging" },
      holds: { outboundHold: true, communicationsEnabled: false, schedulerAutostart: false, evidence: "ROOT receipt ref", verifiedAt: "2026-10-17T09:30:00Z" },
      companies: { css: { organizationId: cplan.organizationId, name: cplan.name, slug: cplan.slug, timezone: cplan.timezone, siteId: cplan.siteId, staff: cplan.staff } },
    };
    const opts = { origin: STAGING_ORIGIN, keys: ["css"], now };
    expect(planFromExecutionManifest(m, opts).plan.companies.css.organizationId).toBe(cplan.organizationId);
    const bad = (patch) => () => planFromExecutionManifest({ ...structuredClone(m), ...patch }, opts);
    expect(bad({ holds: { ...m.holds, verifiedAt: "2026-10-16T09:30:00Z" } })).toThrow("holds_attestation_stale");
    expect(bad({ holds: { ...m.holds, outboundHold: false } })).toThrow("holds_unverified");
    expect(bad({ release: { sha: "abc", environment: "staging" } })).toThrow("release_not_pinned");
    expect(bad({ companies: { css: { ...m.companies.css, slug: "x" } } })).toThrow("manifest_company_mismatch");
    expect(bad({ companies: { css: { ...m.companies.css, staff: { owner: cplan.staff.owner } } } })).toThrow("manifest_staff_missing");
    expect(bad({ reviewedBy: "" })).toThrow("execution_manifest_unreviewed");
    expect(() => planFromExecutionManifest(m, { ...opts, keys: ["css", "painless"] })).toThrow("manifest_company_mismatch");
  });
  it("refuses a staging release whose SHA differs from the reviewed one", async () => {
    const { api, args } = setup();
    args.plan = { ...args.plan, target: "staging", release: { sha: "b".repeat(40), environment: "staging" } };
    api.fault("GET", /^\/api\/readyz$/, () => ({ status: 200, json: { status: "ready", release: { sha: "c".repeat(40), environment: "staging" } } }));
    const r = await seedCompany(args);
    expect(r.halt.code).toBe("release_mismatch");
    expect(api.writes).toEqual([]);
  });
  it("accepts a local manifest only with the runtime's own holds, origin and exact staff", () => {
    const { cplan, company } = fakePlan("css");
    const manifest = {
      kind: "growthos-soft-onboarding-local-manifest", origin: "http://127.0.0.1:4192", port: 4192, instanceId: "33333333-3333-4333-8333-333333333333",
      holds: { COMMUNICATIONS_ENABLED: "false", GROWTHOS_OUTBOUND_HOLD: "true", SCHEDULER_AUTOSTART: "false" },
      companies: [{ key: "css", name: company.name, slug: company.slug, timezone: company.timezone, organizationId: cplan.organizationId, siteId: cplan.siteId, siteKey: "k".repeat(20),
        staff: company.staff.map((s) => ({ key: s.key, email: s.email, role: s.role, id: cplan.staff[s.key], password: "local-secret-value" })) }],
    };
    const built = planFromLocalManifest(manifest, { origin: "http://127.0.0.1:4192", keys: ["css"] });
    expect(built.plan.companies.css.staff).toEqual(cplan.staff);
    expect(JSON.stringify(built.plan)).not.toContain("local-secret-value");
    expect(JSON.stringify(built.plan)).not.toContain("k".repeat(20));
    expect(() => planFromLocalManifest({ ...manifest, holds: { ...manifest.holds, GROWTHOS_OUTBOUND_HOLD: "false" } }, { origin: "http://127.0.0.1:4192", keys: ["css"] })).toThrow("holds_unverified");
    expect(() => planFromLocalManifest(manifest, { origin: "http://127.0.0.1:4193", keys: ["css"] })).toThrow("local_manifest_origin_mismatch");
  });
});

describe("I2 fail-closed discovery and exclusive claim", () => {
  it("contacts 500 stops before any create (absence is never inferred)", async () => {
    const { api, args } = setup();
    api.fault("GET", /^\/api\/v1\/contacts\?/, () => ({ status: 500, json: { error: "boom" } }));
    const r = await seedCompany(args);
    expect(r.status).toBe("INCOMPLETE");
    expect(r.halt.code).toBe("read_failed");
    expect(api.writes).toEqual([]);
  });
  it("a malformed list body stops", async () => {
    const { api, args } = setup();
    api.fault("GET", /^\/api\/v1\/contacts\?/, () => ({ status: 200, json: { unexpected: true } }));
    expect((await seedCompany(args)).halt.code).toBe("read_shape");
    expect(api.writes).toEqual([]);
  });
  it("a possibly-truncated capped list, a set or missing limit header, or a short page set stops", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: `t${i}` }));
    await expect(readList(async () => ({ status: 200, json: rows }), "tasks", "/api/v1/tasks", "capped")).rejects.toThrow("read_incomplete");
    await expect(readList(async () => ({ status: 200, json: [], limitReached: "true" }), "so", "/api/v1/service-obligations", "header")).rejects.toThrow("read_incomplete");
    await expect(readList(async () => ({ status: 200, json: [], limitReached: null }), "so", "/api/v1/service-obligations", "header")).rejects.toThrow("read_incomplete");
    await expect(readList(async () => ({ status: 200, json: { items: [], total: 3, page: 0 } }), "inv", "/api/v1/invoices", "pages")).rejects.toThrow("read_incomplete");
  });
  it("follows offset pages and cursor pages to the end", async () => {
    const all = Array.from({ length: 450 }, (_, i) => ({ id: `c${i}` }));
    const offsetCall = async (_m, p) => { const u = new URL(p, "http://x"); const o = Number(u.searchParams.get("offset")); return { status: 200, json: all.slice(o, o + Number(u.searchParams.get("limit"))) }; };
    expect((await readList(offsetCall, "contacts", "/api/v1/contacts?search=x", "offset")).length).toBe(450);
    const cursorCall = async (_m, p) => (p.includes("cursor=") ? { status: 200, json: { items: [{ id: "b" }], hasMore: false, nextCursor: null } } : { status: 200, json: { items: [{ id: "a" }], hasMore: true, nextCursor: "n1" } });
    expect((await readList(cursorCall, "assets", "/api/v1/contacts/x/assets", "cursor")).map((r) => r.id)).toEqual(["a", "b"]);
  });
  it("a write with no response is UNKNOWN, stops, and is not graded as success", async () => {
    const { api, args } = setup();
    api.fault("POST", /^\/api\/v1\/leads$/, () => ({ status: 0, json: null }));
    const r = await seedCompany(args);
    expect(r.status).toBe("UNKNOWN");
    expect(r.records.some((x) => x.kind === "lead" && x.outcome === "unknown")).toBe(true);
    expect(r.records.some((x) => x.kind === "estimate")).toBe(false);
  });
  it("two concurrent runs for one organization cannot both hold the claim; a held claim is never stolen", async () => {
    const dir = await tmp();
    const a = await acquireRunLock(dir, "http://127.0.0.1:4192", "org-1", "run-a");
    await expect(acquireRunLock(dir, "http://127.0.0.1:4192", "org-1", "run-b")).rejects.toThrow("concurrent_run");
    const other = await acquireRunLock(dir, "http://127.0.0.1:4192", "org-2", "run-c");
    await releaseRunLock({ ...a, runId: "run-b" }); // not the owner: no effect
    await expect(acquireRunLock(dir, "http://127.0.0.1:4192", "org-1", "run-d")).rejects.toThrow("concurrent_run");
    await releaseRunLock(a);
    const d = await acquireRunLock(dir, "http://127.0.0.1:4192", "org-1", "run-d");
    await releaseRunLock(d);
    await releaseRunLock(other);
  });
});

describe("I3 reuse requires exact ownership and lineage", () => {
  it("a same-title invoice for another contact/total is HELD and never issued or paid", async () => {
    const { api, args } = setup();
    const stranger = { id: "44444444-4444-4444-8444-444444444444", organizationId: api.org.id, contactId: "55555555-5555-4555-8555-555555555555", propertyId: null, status: "issued", version: 2,
      title: "TEST - Furnace repair: ignitor and flame sensor", customerName: "Someone Else", currency: "USD", taxCents: 0, totalCents: 99900, recordedPaidCents: 0, paymentState: "unpaid", reconciliationRequired: false,
      document: { title: "TEST - Furnace repair: ignitor and flame sensor", lineItems: [] } };
    api.db.invoices.push(stranger);
    const r = await seedCompany(args);
    expect(r.status).toBe("HOLD");
    expect(r.halt.code).toBe("fixture_conflict");
    expect(api.writes.filter((w) => w.includes(stranger.id))).toEqual([]);
    expect(stranger.recordedPaidCents).toBe(0);
  });
  it("a partially paid fixture invoice is HELD instead of topped up", async () => {
    const { api, args } = setup();
    expect((await runCompany(args)).status).toBe("APPLIED");
    const inv = api.db.invoices.find((i) => i.title.startsWith("TEST - AC condensate"));
    inv.recordedPaidCents = 500;
    inv.paymentState = "partial";
    expect((await seedCompany(args)).status).toBe("HOLD");
  });
  it("a staff-edited property or appointment is HELD, never duplicated or overwritten", async () => {
    const { api, args } = setup();
    expect((await runCompany(args)).status).toBe("APPLIED");
    const writes = api.writes.length;
    api.db.properties[0].addressLine1 = "1 Edited Rd";
    expect((await seedCompany(args)).status).toBe("HOLD");
    expect(api.writes.length).toBe(writes);
    const s2 = setup();
    expect((await runCompany(s2.args)).status).toBe("APPLIED");
    s2.api.db.appointments[0].assignedUserId = s2.cplan.staff.owner;
    expect((await seedCompany(s2.args)).status).toBe("HOLD");
  });
  it("ambiguous matches are HELD", async () => {
    const { api, args } = setup();
    expect((await runCompany(args)).status).toBe("APPLIED");
    api.db.tasks.push({ ...api.db.tasks.find((t) => t.title.startsWith("TEST: Text Dana")), id: "66666666-6666-4666-8666-666666666666" });
    const r = await seedCompany(args);
    expect(r.status).toBe("HOLD");
    expect(r.records.at(-1).detail).toMatch(/ambiguous/);
  });
});

describe("I4 failure is never graded as success", () => {
  it("recurrence 500 is UNKNOWN with a nonzero exit, not APPLIED", async () => {
    const { api, args } = setup();
    api.fault("POST", /\/recurrence$/, () => ({ status: 500, json: null }));
    const r = await runCompany(args);
    expect(r.status).toBe("UNKNOWN");
    expect(exitCodeFor({ companies: { css: r } }, { apply: true })).toBe(2);
  });
  it("a missing website-inquiry key leaves the run INCOMPLETE (required fixture), with nonzero exit", async () => {
    const { args } = setup();
    args.session = { siteId: null, siteKey: null };
    const r = await runCompany(args);
    expect(r.status).toBe("INCOMPLETE");
    expect(r.grade.unsatisfied).toContain("smart-site-lead:delgado");
    expect(exitCodeFor({ companies: { css: r } }, { apply: true })).toBe(2);
  });
  it("read-back failure demotes APPLIED", async () => {
    const { api, args } = setup();
    let lists = 0;
    api.fault("GET", /^\/api\/v1\/invoices\?page=0$/, () => (++lists > 1 ? { status: 503, json: null } : null));
    const r = await runCompany(args);
    expect(r.readBack.pass).toBe(false);
    expect(r.status).toBe("INCOMPLETE");
  });
  it("UI fixture checks need every expected item; a partial page fails and exits 3", () => {
    const partial = gradeUiPage("estimates", "/estimates", ["A", "B", "C", "D", "E"], "only A here", true);
    expect(partial.pass).toBe(false);
    expect(partial.missing).toEqual(["B", "C", "D", "E"]);
    expect(gradeUiPage("x", "/x", ["A"], "A", false).pass).toBe(false);
    expect(exitCodeFor({ companies: { css: { status: "APPLIED", ui: { pass: false } } } }, { apply: true, verify: true })).toBe(3);
    expect(exitCodeFor({ companies: { css: { status: "APPLIED", ui: { pass: true } } } }, { apply: true, verify: true })).toBe(0);
    expect(exitCodeFor({ companies: { css: { status: "DRY-RUN-INCOMPLETE" } } }, { apply: false })).toBe(2);
  });
});

describe("I5 frozen demo date; existing visits are never relabeled", () => {
  it("a rerun with a different date HOLDS on the existing October 17 visit and writes nothing", async () => {
    const { api, args } = setup();
    expect((await runCompany(args)).status).toBe("APPLIED");
    const before = JSON.stringify(api.db.appointments);
    const writes = api.writes.length;
    const r = await seedCompany({ ...args, demoDate: "2026-10-20" });
    expect(r.status).toBe("HOLD");
    expect(r.records.find((x) => x.outcome === "conflict").detail).toMatch(/scheduledStart/);
    expect(JSON.stringify(api.db.appointments)).toBe(before);
    expect(api.writes.length).toBe(writes);
  });
  it("refuses to create a visit once the reviewed date has passed", async () => {
    const { args } = setup();
    const r = await seedCompany({ ...args, now: () => Date.parse("2026-10-18T00:00:00Z") });
    expect(r.status).toBe("HOLD");
    expect(r.halt.code).toBe("demo_date_passed");
    expect(zonedInstant(DEMO_DATE, "07:30", "America/New_York").toISOString()).toBe("2026-10-17T11:30:00.000Z");
  });
  it("staging cannot override the reviewed date", () => {
    expect(DEMO_DATE).toBe("2026-10-17");
    const base = { kind: "growthos-soft-onboarding-execution-manifest", target: "staging", origin: STAGING_ORIGIN };
    expect(() => planFromExecutionManifest({ ...base, demoDate: "2026-10-20" }, { origin: STAGING_ORIGIN, keys: ["css"] })).toThrow("demo_date_not_reviewed");
    expect(() => planFromExecutionManifest({ ...base, demoDate: DEMO_DATE }, { origin: STAGING_ORIGIN, keys: ["css"], demoDate: "2026-10-20" })).toThrow("demo_date_not_reviewed");
  });
});

describe("I6 instance-owned runtime manifest", () => {
  it("two runtimes get distinct files; neither cleanup touches the other's", async () => {
    const base = await tmp();
    const a = await createOwnedManifest({ port: 4192, origin: "http://127.0.0.1:4192", payload: { x: 1 }, baseDir: base });
    const b = await createOwnedManifest({ port: 4193, origin: "http://127.0.0.1:4193", payload: { x: 2 }, baseDir: base });
    expect(a.file).not.toBe(b.file);
    expect(await removeOwnedManifest(a)).toEqual({ removed: true });
    expect(JSON.parse(await readFile(b.file, "utf8")).instanceId).toBe(b.instanceId);
    expect((await removeOwnedManifest(a)).removed).toBe(false);
    expect(await removeOwnedManifest(b)).toEqual({ removed: true });
  });
  it("never overwrites a pre-existing file and never deletes a file it does not own", async () => {
    const dir = await tmp();
    const file = path.join(dir, "manifest.json");
    await writeFile(file, '{"someone":"else"}');
    await expect(createOwnedManifest({ port: 4192, origin: "http://127.0.0.1:4192", payload: {}, file })).rejects.toThrow(/EEXIST/);
    expect(await readFile(file, "utf8")).toBe('{"someone":"else"}');
    expect((await removeOwnedManifest({ file, instanceId: "x", port: 4192 })).removed).toBe(false);
    expect(await readFile(file, "utf8")).toBe('{"someone":"else"}');
    await expect(createOwnedManifest({ port: 4194, origin: "http://127.0.0.1:4194", payload: {}, baseDir: dir })).rejects.toThrow();
  });
});

describe("Minor findings", () => {
  it("auth-module result contract: optional { siteId, siteKey } for the reviewed site only", () => {
    const site = "77777777-7777-4777-8777-777777777777";
    expect(validateAuthResult(undefined, site)).toEqual({ siteId: null, siteKey: null });
    expect(validateAuthResult({ siteId: site, siteKey: "s".repeat(24) }, site)).toEqual({ siteId: site, siteKey: "s".repeat(24) });
    expect(() => validateAuthResult({ siteId: site }, site)).toThrow("auth_module_contract");
    expect(() => validateAuthResult({ siteId: site, siteKey: "short" }, site)).toThrow("auth_module_contract");
    expect(() => validateAuthResult({ siteId: site, siteKey: "s".repeat(24), cookie: "x" }, site)).toThrow("auth_module_contract");
    expect(() => validateAuthResult({ siteId: "88888888-8888-4888-8888-888888888888", siteKey: "s".repeat(24) }, site)).toThrow("site_mismatch");
    expect(() => validateAuthResult("token", site)).toThrow("auth_module_contract");
  });
  it("run IDs are unique, and the hash list covers every file in the run directory", async () => {
    expect(newRunId("local", "apply", "both")).not.toBe(newRunId("local", "apply", "both"));
    const dir = await tmp();
    await writeFile(path.join(dir, "receipt.json"), "{}");
    const hashes = await writeHashList(dir);
    expect(Object.keys(hashes)).toEqual(["receipt.json"]);
    expect((await readdir(dir)).sort()).toEqual(["hashes.json", "receipt.json"]);
    const custody = await collectCustody();
    expect(custody.head).toMatch(/^[0-9a-f]{40}$/);
    expect(custody.schemaTree).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(custody.files)).toContain("scripts/demo/seed-soft-onboarding.mjs");
  });
  it("persists only status + allowlisted codes, never response or exception text", async () => {
    const marker = "PRIVATE-MARKER-sk_live_123 secret detail";
    expect(safeBrief({ status: 422, json: { error: marker, code: "invalid_contact" } })).toBe("HTTP 422 invalid_contact");
    expect(safeBrief({ status: 500, json: { error: marker } })).toBe("HTTP 500");
    expect(JSON.stringify(safeError(new Error(marker)))).not.toContain("PRIVATE");
    const { api, args } = setup();
    api.fault("POST", /^\/api\/v1\/contacts$/, () => ({ status: 400, json: { error: marker, raw: marker } }));
    const r = await seedCompany(args);
    expect(JSON.stringify(r)).not.toContain("PRIVATE");
    expect(r.halt.code).toBe("write_failed");
  });
});
