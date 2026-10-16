// Package C: READ-ONLY staging smoke. Signs in the Codex-provisioned TEST owner
// (credential read into memory by Codex's helper; never printed or persisted),
// performs GET requests and page loads only, and records which acceptance
// cases a failing read blocks. No writes, no storageState, no tracing/video/HAR.
//
//   BASE_URL=https://mogulforge-growthos-staging.fly.dev \
//   STAGING_HOST_ALLOW=mogulforge-growthos-staging.fly.dev \
//   STAGING_AUTH_MODULE=file:///C:/Forge/artifacts/growthos-staging-acceptance-20261016/test-owner-auth.mjs \
//   node scripts/acceptance/staging-smoke.mjs
import { BASE_URL, Recorder, api, assertSafeTarget, launch, shot } from "./lib.mjs";

const target = assertSafeTarget();
if (target !== "staging") throw new Error("staging-smoke is for the staging target only");
const { signInTestOwner } = await import(process.env.STAGING_AUTH_MODULE ?? "file:///C:/Forge/artifacts/growthos-staging-acceptance-20261016/test-owner-auth.mjs");
const rec = new Recorder("staging-smoke");

// Read-only API probes and the acceptance cases each one gates.
const READS = [
  ["/api/v1/session", ["ALL"]],
  ["/api/v1/me", ["ALL"]],
  ["/api/v1/settings", ["P-B", "P-C", "H-J", "G04-01", "P-E", "H-E"]],
  ["/api/v1/onboarding", ["P-A", "H-A"]],
  ["/api/v1/contacts", ["P-E", "P-F", "H-I"]],
  ["/api/v1/leads", ["P-B", "H-J", "P-F"]],
  ["/api/v1/appointments", ["P-E", "H-E", "G04-02", "G04-03", "P-G", "H-F", "H-G"]],
  ["/api/v1/projects", ["P-E", "H-I", "G04-02"]],
  ["/api/v1/estimates", ["P-E", "G06-01"]],
  ["/api/v1/invoices", ["P-I", "H-I"]],
  ["/api/v1/work-checklists", ["P-G", "H-F", "H-G"]],
  ["/api/v1/smart-sites/launch-readiness", ["P-B", "H-J"]],
  ["/api/v1/staff-push/policy", ["P-B", "P-C", "H-J"]],
  ["/api/v1/staff-push/status", ["P-D", "H-K"]],
];
const PAGES = [
  ["/", "Today"], ["/appointments", "Appointments"], ["/settings", "Admin Settings"], ["/service", "Customer service desk"],
  ["/invoices", "Invoices"], ["/estimates", "Estimates"], ["/projects", "Projects"], ["/onboarding", null], ["/contacts", "Contacts"],
];

const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const failed = [];
page.on("response", (r) => { try { const u = new URL(r.url()); if (u.origin === BASE_URL && r.status() >= 500) failed.push(`${r.status()} ${r.request().method()} ${u.pathname}`); } catch {} });
try {
  await signInTestOwner(page);
  rec.record("SETUP", "PASS", "Staging TEST owner signed in (Codex helper; credential not printed or stored)");
  for (const [path, cases] of READS) {
    const r = await api(page, "GET", path);
    const status = r.status < 400 ? "PASS" : r.status >= 500 ? "BLOCKED" : "FAIL";
    rec.record(`READ ${path}`, status, `GET ${path} -> ${r.status}${r.status >= 400 ? ` ${JSON.stringify(r.json)?.slice(0, 160)}` : ""}`, [], { gates: cases });
  }
  for (const [path, heading] of PAGES) {
    const before = failed.length;
    await page.goto(BASE_URL + path);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(500);
    const text = await page.locator("body").innerText().catch(() => "");
    const errors = failed.slice(before);
    const ok = (!heading || text.includes(heading)) && errors.length === 0;
    rec.record(`PAGE ${path}`, ok ? "PASS" : "BLOCKED", `${path}: heading ${heading ? (text.includes(heading) ? "shown" : "missing") : "n/a"}; 5xx during load: ${errors.join(", ") || "none"}`,
      [await shot(page, `staging-smoke${path.replace(/\W/g, "_") || "_root"}`)]);
  }
} finally {
  await context.close();
  await browser.close();
  const file = await rec.save({ target, readOnly: true, serverErrors: [...new Set(failed)] });
  console.log(JSON.stringify({ file, serverErrors: [...new Set(failed)] }));
}
