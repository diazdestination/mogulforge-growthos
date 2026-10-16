// October 17 soft-onboarding demo: LOCAL disposable runtime.
//
//   node scripts/demo/demo-runtime.mjs
//
// Same isolation model as scripts/acceptance/acceptance-runtime.mjs (package C)
// and artifacts/api-server/scripts/preview-runtime-isolated.mjs: in-memory
// PGlite database, loopback-only listener, no .env, no inherited provider keys,
// COMMUNICATIONS_ENABLED=false, GROWTHOS_OUTBOUND_HOLD=true, scheduler
// autostart off. Nothing here touches staging or production.
//
// After the API is up it provisions the two TEST Demo companies through the
// normal platform-admin API (POST /api/v1/platform/clients), issues each TEST
// smart-site key through the normal API, and inserts one owner and one staff
// login per company directly as a LOCAL stand-in for invitation acceptance
// (invitation email is held). It then writes a local manifest (IDs plus
// disposable local logins and site keys) to the OS temp folder, never to Git
// or to the shared artifacts folder. Everything is destroyed when it exits.
//
// The product's synthetic preview server only permits loopback ports 4192 and
// 4193. This runner takes the first free one (or DEMO_PORT) and refuses to
// start if neither is free.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEMO_COMPANIES } from "./demo-data.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const api = path.join(root, "artifacts/api-server");
const database = path.join(root, "lib/db");
const apiRequire = createRequire(path.join(api, "package.json"));
const load = (name) => import(pathToFileURL(apiRequire.resolve(name)).href);
const { PGlite } = await load("@electric-sql/pglite");
const { PGLiteSocketServer } = await load("@electric-sql/pglite-socket");
const pg = (await load("pg")).default;
const { buildAll } = await import(pathToFileURL(path.join(api, "build.mjs")).href);

export const LOCAL_MANIFEST =
  process.env.DEMO_LOCAL_MANIFEST ?? path.join(os.tmpdir(), "growthos-soft-onboarding-local-manifest.json");
// Disposable, local-only credentials. They exist only inside this process's
// in-memory database and are never valid anywhere else.
const PLATFORM_LOGIN = { email: "demo-platform-local@example.com", password: `Local-${randomBytes(9).toString("hex")}!` };
const LOCAL_STAFF_PASSWORD = `Local-${randomBytes(9).toString("hex")}!`;

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

async function choosePort() {
  const wanted = process.env.DEMO_PORT ? [Number(process.env.DEMO_PORT)] : [4192, 4193];
  for (const port of wanted) {
    if (![4192, 4193].includes(port)) throw new Error("Only loopback ports 4192 and 4193 are permitted by the synthetic preview server.");
    if (await portFree(port)) return port;
  }
  throw new Error(`Ports ${wanted.join(" and ")} are busy; refusing to start (not reusing another runner's port).`);
}

const PORT = await choosePort();
const ORIGIN = `http://127.0.0.1:${PORT}`;

async function http(pathname, { method = "GET", body, cookie, headers = {} } = {}) {
  const response = await fetch(ORIGIN + pathname, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: response.status, json, setCookie: response.headers.getSetCookie?.() ?? [] };
}

async function provisionDemoCompanies(connectionString) {
  const login = await http("/api/auth/login", { method: "POST", body: PLATFORM_LOGIN });
  if (login.status !== 200) throw new Error(`Local platform admin login failed: ${login.status}`);
  const cookie = login.setCookie.map((c) => c.split(";")[0]).join("; ");
  const companies = [];
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    for (const company of Object.values(DEMO_COMPANIES)) {
      const draft = await http("/api/v1/platform/clients", {
        method: "POST",
        cookie,
        headers: { origin: ORIGIN },
        body: {
          requestId: randomUUID(),
          name: company.name,
          slug: company.slug,
          profile: company.profile,
          timezone: company.timezone,
          responseTargetMinutes: 30,
          confirmed: true,
        },
      });
      if (![200, 201].includes(draft.status)) throw new Error(`Provisioning ${company.name} failed: ${draft.status} ${JSON.stringify(draft.json)}`);
      const { organizationId, siteId } = draft.json;
      const key = await http(`/api/v1/platform/clients/${organizationId}/sites/${siteId}/key`, {
        method: "POST",
        cookie,
        headers: { origin: ORIGIN },
        body: { confirmed: true, expectedVersion: 1 },
      });
      const staff = [];
      for (const member of company.staff) {
        const salt = randomBytes(16).toString("hex");
        const hash = `scrypt$${salt}$${scryptSync(LOCAL_STAFF_PASSWORD, salt, 64).toString("hex")}`;
        const { rows: [user] } = await client.query(
          "INSERT INTO users(email,first_name,last_name,password_hash,email_verified_at,organization_id,role,is_platform_admin) VALUES ($1,$2,$3,$4,now(),$5,$6,false) RETURNING id",
          [member.email, member.first, member.last, hash, organizationId, member.role],
        );
        staff.push({ key: member.key, email: member.email, role: member.role, id: user.id, password: LOCAL_STAFF_PASSWORD });
      }
      // LOCAL-only workaround: the synthetic preview server pins the pool to
      // one PGlite connection, and ensureDefaultPlaybook (first lead.created
      // in an org) runs a non-transaction query inside its transaction, which
      // deadlocks a one-connection pool. Pre-creating the seeded default row
      // (inactive, no steps) makes that path return early. Real PostgreSQL
      // pools are unaffected; this row never exists outside this process.
      await client.query(
        "INSERT INTO playbooks(organization_id,name,seed_key,is_active,enrollment_rules,steps) VALUES ($1,'New lead outreach','default.new_lead_outreach',false,'{}'::jsonb,'[]'::jsonb)",
        [organizationId],
      );
      companies.push({
        key: company.key,
        name: company.name,
        organizationId,
        siteId,
        siteKey: key.json?.apiKey ?? key.json?.key ?? key.json?.secret ?? null,
        siteKeyIssueStatus: key.status,
        staff,
      });
    }
  } finally {
    await client.end();
  }
  return companies;
}

const storage = await PGlite.create();
const socket = new PGLiteSocketServer({ db: storage, host: "127.0.0.1", port: 0, maxConnections: 20 });
let child;
const cacheRoot = path.join(api, "node_modules/.cache");
await mkdir(cacheRoot, { recursive: true });
const buildDir = await mkdtemp(path.join(cacheRoot, "demo-runtime-"));
try {
  await socket.start();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|TEMP|TMP|PATHEXT|COMSPEC)$/i.test(key)),
  );
  Object.assign(env, {
    DATABASE_URL: `postgresql://postgres:synthetic@${socket.getServerConn()}/postgres`,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(PORT),
    APP_ORIGIN: ORIGIN,
    STATIC_DIR: path.join(api, "../command-center/dist/public"),
    SESSION_SECRET: randomBytes(32).toString("hex"),
    OBJECT_STORAGE_PROVIDER: "postgres",
    AUTO_MIGRATE: "false",
    LOG_LEVEL: "warn",
    COMMUNICATIONS_ENABLED: "false",
    GROWTHOS_OUTBOUND_HOLD: "true",
    SCHEDULER_AUTOSTART: "false",
    RUNTIME_SYNTHETIC_PREVIEW: "loopback-only",
    EMAIL_INTELLIGENCE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  });
  await buildAll({ entryPoint: path.join(api, "src/test-helpers/runtime-preview-server.ts"), outDir: buildDir });
  const code = await new Promise((resolve, reject) => {
    const schema = spawn(process.execPath, [path.join(database, "node_modules/drizzle-kit/bin.cjs"), "push", "--force", "--config", "drizzle.config.ts"], { cwd: database, env, stdio: "inherit", windowsHide: true });
    schema.once("error", reject);
    schema.once("exit", resolve);
  });
  if (code !== 0) throw new Error("Synthetic schema setup failed");
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const { rows: [org] } = await client.query("INSERT INTO organizations(name,slug) VALUES ('LOCAL DEMO PLATFORM - fictional','local-demo-platform') RETURNING id");
    const salt = randomBytes(16).toString("hex");
    const hash = `scrypt$${salt}$${scryptSync(PLATFORM_LOGIN.password, salt, 64).toString("hex")}`;
    await client.query(
      "INSERT INTO users(email,first_name,last_name,password_hash,email_verified_at,organization_id,role,is_platform_admin) VALUES ($1,'LOCAL','DEMO OPERATOR',$2,now(),$3,'owner',true)",
      [PLATFORM_LOGIN.email, hash, org.id],
    );
  } finally {
    await client.end();
  }
  child = spawn(process.execPath, [path.join(buildDir, "runtime-preview-server.mjs")], { cwd: api, env, stdio: "inherit", windowsHide: true });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child?.kill(signal));
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    try { healthy = (await fetch(`${ORIGIN}/api/healthz`)).status < 500; } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  if (!healthy) throw new Error("Demo runtime did not become healthy");
  const companies = await provisionDemoCompanies(env.DATABASE_URL);
  await writeFile(LOCAL_MANIFEST, JSON.stringify({
    environment: "LOCAL disposable runtime (in-memory PGlite, loopback only, outbound hold on, communications disabled)",
    createdAt: new Date().toISOString(),
    origin: ORIGIN,
    companies,
    note: "Local disposable logins and site keys only; destroyed when the runtime exits. Do not copy into artifacts or Git.",
  }, null, 2) + "\n");
  console.log(`[demo-runtime] READY ${ORIGIN} manifest=${LOCAL_MANIFEST}`);
  for (const c of companies) console.log(`[demo-runtime] ${c.name}: org=${c.organizationId} site=${c.siteId} key=${c.siteKeyIssueStatus}`);
  const status = await exited;
  if (status) process.exitCode = status;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
  await rm(LOCAL_MANIFEST, { force: true }).catch(() => {});
  await socket.stop().catch(() => {});
  await storage.close().catch(() => {});
  if (path.dirname(buildDir) !== cacheRoot) throw new Error("Unexpected runtime artifact path");
  await rm(buildDir, { recursive: true, force: true });
}
