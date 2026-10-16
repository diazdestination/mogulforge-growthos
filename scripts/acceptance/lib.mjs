// Shared helpers for the package C contractor acceptance automation.
// No recording, tracing, video, saved auth or remote browsers. Screenshots go
// to the private evidence folder outside Git.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const EVIDENCE_DIR =
  process.env.ACCEPTANCE_EVIDENCE_DIR ??
  "C:/Forge/artifacts/growthos-launch-claude-20261016/acceptance";
export const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:4192").replace(/\/$/, "");
export const IS_LOCAL = /^http:\/\/127\.0\.0\.1:419[23]$/.test(BASE_URL);

// Production guard: refuse anything that is not loopback or an explicitly
// declared staging host. Staging must be passed via STAGING_HOST_ALLOW.
export function assertSafeTarget() {
  const host = new URL(BASE_URL).hostname;
  if (IS_LOCAL) return "local";
  const allowed = (process.env.STAGING_HOST_ALLOW ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (!allowed.includes(host)) throw new Error(`Refusing ${host}: set STAGING_HOST_ALLOW to the exact staging host Codex published.`);
  if (/(^|\.)(app\.)?mogulforge\.(com|app)$/i.test(host) && !/staging/i.test(host))
    throw new Error(`Refusing ${host}: looks like production.`);
  return "staging";
}

export async function loadPlaywright() {
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

export async function launch() {
  const { chromium } = await loadPlaywright();
  const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
  return browser;
}

export async function readManifest() {
  if (process.env.ACCEPTANCE_MANIFEST) return JSON.parse(await readFile(process.env.ACCEPTANCE_MANIFEST, "utf8"));
  return JSON.parse(await readFile(path.join(EVIDENCE_DIR, "local-runtime-manifest.json"), "utf8"));
}

/** Result recorder: PASS / FAIL / BLOCKED / NOT_RUN with evidence references. */
export class Recorder {
  constructor(name) {
    this.name = name;
    this.results = [];
    this.startedAt = new Date().toISOString();
  }
  record(caseId, status, observed, evidence = [], extra = {}) {
    const entry = { caseId, status, observed, evidence, at: new Date().toISOString(), ...extra };
    this.results.push(entry);
    console.log(`${status.padEnd(8)} ${caseId} — ${observed}`);
    return entry;
  }
  async save(extra = {}) {
    await mkdir(EVIDENCE_DIR, { recursive: true });
    const file = path.join(EVIDENCE_DIR, `${this.name}-results.json`);
    await writeFile(file, JSON.stringify({ name: this.name, baseUrl: BASE_URL, startedAt: this.startedAt, completedAt: new Date().toISOString(), results: this.results, ...extra }, null, 2) + "\n");
    return file;
  }
}

export async function shot(page, name) {
  await mkdir(path.join(EVIDENCE_DIR, "screenshots"), { recursive: true });
  const file = path.join(EVIDENCE_DIR, "screenshots", `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return path.relative(EVIDENCE_DIR, file).replace(/\\/g, "/");
}

export async function login(page, email, password) {
  await page.goto(`${BASE_URL}/login`);
  await page.getByPlaceholder("Email", { exact: true }).fill(email);
  await page.getByPlaceholder("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "SIGN IN", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20000 });
  await page.waitForLoadState("networkidle").catch(() => {});
}

/**
 * Signs in one manifest staff entry. LOCAL entries carry disposable
 * email/password. STAGING entries carry `credentialModule` (a file URL to a
 * Codex-provided module) and `signInExport` (default "signInTestOwner"); the
 * module reads the secret into memory, so nothing is printed or persisted.
 */
export async function loginStaff(page, staff) {
  if (staff.credentialModule) {
    const mod = await import(staff.credentialModule);
    await mod[staff.signInExport ?? "signInTestOwner"](page);
    await page.waitForLoadState("networkidle").catch(() => {});
    return;
  }
  await login(page, staff.email, staff.password);
}

/**
 * Same-session JSON API call made by the signed-in page itself (window.fetch),
 * exactly like the Command Center does: same origin, browser-set Origin and
 * Sec-Fetch-Site, and the session cookie (which is Secure, so Playwright's
 * out-of-browser request context would not send it over loopback http).
 */
export async function api(page, method, pathname, body) {
  if (!page.url().startsWith(BASE_URL)) await page.goto(`${BASE_URL}/`);
  return page.evaluate(async ({ method, pathname, body }) => {
    const response = await fetch(pathname, {
      method,
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
