// Shared helpers for the package C contractor acceptance automation.
// No recording, tracing, video, saved auth or remote browsers. Screenshots go
// to the private evidence folder outside Git.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  canonicalOrigin,
  admitManifest,
  assertAdmission,
  verifyObservation,
  assertMutation,
} from "./guards.mjs";

export const EVIDENCE_DIR =
  "C:/Forge/artifacts/growthos-launch-codex-20261016/acceptance-guardfix";
export const BASE_URL = (
  process.env.BASE_URL ?? "http://127.0.0.1:4192"
).replace(/\/$/, "");
export const IS_LOCAL = /^http:\/\/127\.0\.0\.1:419[23]$/.test(BASE_URL);

// Fixed target allowlist; environment variables cannot widen these origins.
export function assertSafeTarget() {
  return canonicalOrigin(BASE_URL).startsWith("http:") ? "local" : "staging";
}
const hash = (b) => createHash("sha256").update(b).digest("hex");
const pages = new WeakMap();
let execution,
  clock = Date.now,
  activeRun;
export function configureExecution(admission, { now = Date.now } = {}) {
  execution = admission;
  clock = now;
  assertAdmission(admission, clock());
}
export function sourceBinding() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  return {
    commit: git(["rev-parse", "HEAD"]),
    tree: git(["rev-parse", "HEAD^{tree}"]),
    clean: git(["status", "--porcelain", "--untracked-files=normal"]) === "",
  };
}
export function admitExecution(manifest) {
  const a = admitManifest(manifest, {
    origin: BASE_URL,
    source: sourceBinding(),
  });
  configureExecution(a);
  return a;
}
export async function createEvidenceRun(
  runId,
  provenance,
  { io = { mkdir, writeFile }, root = EVIDENCE_DIR } = {},
) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runId)) throw Error("evidence_run_id");
  const directory = path.join(root, `run-${runId}`);
  await io.mkdir(directory);
  const write = async (name, value) => {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name.startsWith("."))
      throw Error("evidence_name");
    const file = path.join(directory, name);
    await io.writeFile(
      file,
      Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + "\n",
      { flag: "wx" },
    );
    return file;
  };
  return { directory, provenance, write };
}
export async function startEvidence(manifest) {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  activeRun = await createEvidenceRun(manifest.runId, {
    runId: manifest.runId,
    source: manifest.source,
    origin: manifest.origin,
    release: manifest.attestation.release,
    frontendIndexSha256: manifest.attestation.frontendIndexSha256,
    schema: manifest.attestation.schema,
    attestationSha256: manifest.attestationSha256,
    fixtureIds: manifest.companies.map((c) => ({
      organizationId: c.organizationId,
      siteId: c.siteId,
      staffIds: c.staff.map((s) => s.id),
    })),
  });
  return activeRun;
}
export function safeExtras(extra) {
  const allow = new Set([
    "company",
    "step",
    "partial",
    "note",
    "linkedCases",
    "gates",
    "apiStatus",
    "uiStatus",
    "target",
    "readOnly",
    "scriptError",
    "savedEntryVersion",
  ]);
  return Object.fromEntries(
    Object.entries(extra).filter(
      ([key, value]) =>
        allow.has(key) &&
        (["string", "number", "boolean"].includes(typeof value) ||
          (Array.isArray(value) && value.every((x) => typeof x === "string"))),
    ),
  );
}

export async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PACKAGE_JSON,
    "C:/Forge/tools/shipping-kit/node_modules/playwright/package.json",
    path.join(
      process.env.APPDATA ?? "",
      "npm/node_modules/@playwright/cli/package.json",
    ),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const req = createRequire(candidate);
    try {
      return req(
        candidate.includes("@playwright/cli")
          ? "playwright"
          : candidate.replace(/package\.json$/, ""),
      );
    } catch {}
  }
  throw new Error(
    "Playwright not found (tried shipping-kit and @playwright/cli).",
  );
}

export async function launch() {
  const { chromium } = await loadPlaywright();
  const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chrome) ? { executablePath: chrome } : {}),
  });
  return browser;
}

export async function readManifest() {
  if (
    !process.env.ACCEPTANCE_MANIFEST ||
    !/^[a-f0-9]{64}$/.test(process.env.ACCEPTANCE_MANIFEST_SHA256 ?? "")
  )
    throw Error("reviewed_manifest_required");
  const bytes = await readFile(process.env.ACCEPTANCE_MANIFEST);
  if (hash(bytes) !== process.env.ACCEPTANCE_MANIFEST_SHA256)
    throw Error("manifest_bytes_changed");
  return JSON.parse(bytes);
}

/** Result recorder: PASS / FAIL / BLOCKED / NOT_RUN with evidence references. */
export class Recorder {
  constructor(name) {
    this.name = name;
    this.results = [];
    this.startedAt = new Date().toISOString();
  }
  record(caseId, status, observed, evidence = [], extra = {}) {
    const entry = {
      caseId,
      status,
      observed,
      evidence,
      at: new Date().toISOString(),
      ...safeExtras(extra),
    };
    this.results.push(entry);
    console.log(`${status.padEnd(8)} ${caseId} — ${observed}`);
    return entry;
  }
  async save(extra = {}) {
    if (!activeRun) throw Error("evidence_run_required");
    return activeRun.write(`${this.name}-results.json`, {
      name: this.name,
      baseUrl: BASE_URL,
      startedAt: this.startedAt,
      completedAt: new Date().toISOString(),
      provenance: activeRun.provenance,
      results: this.results,
      ...safeExtras(extra),
    });
  }
}

export async function shot(page, name) {
  if (!activeRun) throw Error("evidence_run_required");
  const bytes = await page.screenshot({ fullPage: true });
  await activeRun.write(`${name}.png`, bytes);
  return `${name}.png`;
}

export async function login(page, email, password) {
  assertAdmission(execution, clock());
  await page.goto(`${BASE_URL}/login`);
  await page.getByPlaceholder("Email", { exact: true }).fill(email);
  await page.getByPlaceholder("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "SIGN IN", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 20000,
  });
  await page.waitForLoadState("networkidle").catch(() => {});
}

/**
 * Signs in a manifest staff entry through its hash-pinned credentialModule
 * and signInExport (default "signInTestOwner"). The module resolves credentials
 * in memory. The local runtime instead supplies its own private sign-in closure.
 */
export async function loginStaff(page, staff) {
  assertAdmission(execution, clock());
  if (staff.credentialModule) {
    if (
      !staff.credentialModule.startsWith("file:///") ||
      hash(await readFile(fileURLToPath(staff.credentialModule))) !==
        staff.credentialModuleSha256
    )
      throw Error("auth_module_changed");
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
  if (new URL(page.url()).origin !== canonicalOrigin(BASE_URL))
    throw Error("foreign_page_origin");
  if (
    typeof pathname !== "string" ||
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    new URL(pathname, BASE_URL).origin !== BASE_URL
  )
    throw Error("request_path");
  if (!["GET", "HEAD"].includes(method)) {
    const token = pages.get(page)?.token;
    await recheckSession(page);
    assertMutation({
      admission: execution,
      token,
      url: BASE_URL + pathname,
      method,
      now: clock(),
    });
  }
  return rawApi(page, method, pathname, body);
}
async function rawApi(page, method, pathname, body) {
  return page.evaluate(
    async ({ method, pathname, body }) => {
      const response = await fetch(pathname, {
        method,
        credentials: "same-origin",
        headers:
          body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: response.status, json };
    },
    { method, pathname, body },
  );
}
async function readObservation(page) {
  assertAdmission(execution, clock());
  if (new URL(page.url()).origin !== execution.origin)
    throw Error("foreign_page_origin");
  const paths = [
    "/api/readyz",
    "/api/v1/session",
    "/api/v1/me",
    "/api/v1/smart-sites",
    "/api/v1/users",
  ];
  const reads = [];
  for (const p of paths) {
    const r = await rawApi(page, "GET", p);
    if (r.status !== 200) throw Error("preflight_read_failed");
    reads.push(r.json);
  }
  const bytes = await page.evaluate(async () => {
    const r = await fetch("/", {
      credentials: "same-origin",
      redirect: "error",
    });
    if (r.status !== 200) throw Error("frontend_read");
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length > 2000000) throw Error("frontend_bound");
    return Array.from(bytes);
  });
  return {
    origin: new URL(page.url()).origin,
    release: reads[0]?.release,
    session: reads[1],
    me: reads[2],
    sites: reads[3],
    users: reads[4],
    frontendIndexSha256: hash(Buffer.from(bytes)),
  };
}
export async function recheckSession(page) {
  const state = pages.get(page);
  if (!state) throw Error("session_not_admitted");
  verifyObservation(
    execution,
    state.key,
    state.staffId,
    await readObservation(page),
  );
  return state.token;
}
export async function preflightPage(page, company, staff) {
  const observation = await readObservation(page);
  const token = verifyObservation(
    execution,
    company.key,
    staff.id,
    observation,
  );
  pages.set(page, { key: company.key, staffId: staff.id, token, observation });
  return token;
}
export async function installContextGuard(context) {
  assertAdmission(execution, clock());
  await context.route("**/*", async (route) => {
    try {
      const request = route.request(),
        u = new URL(request.url());
      if (u.origin !== execution.origin) throw Error("foreign_request");
      assertAdmission(execution, clock());
      if (!["GET", "HEAD"].includes(request.method())) {
        const page = request.frame().page();
        if (u.pathname !== "/api/auth/login" || pages.has(page)) {
          const token = await recheckSession(page);
          assertMutation({
            admission: execution,
            token,
            url: u.href,
            method: request.method(),
            now: clock(),
          });
        }
      }
      await route.continue();
    } catch {
      await route.abort("blockedbyclient");
    }
  });
}
export async function publicPost(page, pathname, secret, body) {
  const token = await recheckSession(page);
  if (!pathname.startsWith(`/api/v1/public/smart-sites/${token.siteId}/`))
    throw Error("public_site_mismatch");
  assertMutation({
    admission: execution,
    token,
    url: BASE_URL + pathname,
    method: "POST",
    now: clock(),
  });
  const response = await fetch(BASE_URL + pathname, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {}
  return { status: response.status, json };
}
