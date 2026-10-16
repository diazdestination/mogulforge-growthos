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
// (invitation email is held). It then writes an instance-owned local manifest
// (IDs plus disposable local logins and site keys) into a fresh private temp
// directory bound to this runtime's port, never to Git or to the shared
// artifacts folder. The file is created exclusively (never overwritten) and
// only this instance's own file is removed when it exits. DEMO_LOCAL_MANIFEST
// may name an exact path, which must not already exist.
//
// The product's synthetic preview server only permits loopback ports 4192 and
// 4193. This runner takes the first free one (or DEMO_PORT) and refuses to
// start if neither is free.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID, scryptSync,createHash } from "node:crypto";
import { mkdir, mkdtemp, rm,readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEMO_COMPANIES } from "./demo-data.mjs";
import { createOwnedManifest, removeOwnedManifest } from "./runtime-manifest.mjs";
import { proofHash,fingerprintFrontend } from "./execution-proof.mjs";
import { safeError } from "./seed-soft-onboarding.mjs";
import { collectSchemaCatalog,catalogDigest } from "../../reports/release-preparation-2026-10-09/schema-catalog.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const api = path.join(root, "artifacts/api-server");
const database = path.join(root, "lib/db");
const apiRequire = createRequire(path.join(api, "package.json"));
const load = (name) => import(pathToFileURL(apiRequire.resolve(name)).href);
const { PGlite } = await load("@electric-sql/pglite");
const { PGLiteSocketServer } = await load("@electric-sql/pglite-socket");
const pg = (await load("pg")).default;
const { buildAll } = await import(pathToFileURL(path.join(api, "build.mjs")).href);

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
        slug: company.slug,
        timezone: company.timezone,
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
let manifest = null;
const HOLDS = { COMMUNICATIONS_ENABLED: "false", GROWTHOS_OUTBOUND_HOLD: "true", SCHEDULER_AUTOSTART: "false" };
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
    GROWTHOS_ENVIRONMENT:"test",
    HOST: "127.0.0.1",
    PORT: String(PORT),
    APP_ORIGIN: ORIGIN,
    STATIC_DIR: path.join(api, "../command-center/dist/public"),
    SESSION_SECRET: randomBytes(32).toString("hex"),
    OBJECT_STORAGE_PROVIDER: "postgres",
    AUTO_MIGRATE: "false",
    LOG_LEVEL: "warn",
    ...HOLDS,
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
  manifest = await createOwnedManifest({
    port: PORT,
    origin: ORIGIN,
    file: process.env.DEMO_LOCAL_MANIFEST,
    payload: async({instanceId})=>{
      const observer=new pg.Client({connectionString:env.DATABASE_URL});let catalog;
      await observer.connect();try{await observer.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");await observer.query("SET LOCAL statement_timeout='20s'");await observer.query("SET LOCAL search_path=pg_catalog,public,pg_temp");catalog=await collectSchemaCatalog(observer);await observer.query("ROLLBACK");}finally{await observer.end();}
      if(catalog.tables.length!==142||catalog.columns.length!==1870)throw Error("Local schema proof unavailable");
      const ready=await http("/api/readyz"),page=await fetch(ORIGIN+"/",{redirect:"error",signal:AbortSignal.timeout(20000)});
      if(ready.status!==200||page.status!==200)throw Error("Local deployment proof unavailable");
      const frontendIndexSha256=await fingerprintFrontend(page);
      const fixtures=Object.fromEntries(companies.map(c=>[c.key,{organizationId:c.organizationId,name:c.name,slug:c.slug,timezone:c.timezone,siteId:c.siteId,staff:Object.fromEntries(c.staff.map(s=>[s.key,s.id]))}]));
      const observed=Date.now(),executionProof={kind:"LOCAL_DEMO_EXECUTION_PROOF_V1",origin:ORIGIN,fixturesSha256:proofHash(fixtures),observedAt:new Date(observed).toISOString(),expiresAt:new Date(observed+300000).toISOString(),configSha256:proofHash({origin:ORIGIN,holds:HOLDS,autoMigrate:env.AUTO_MIGRATE,environment:env.GROWTHOS_ENVIRONMENT}),imageSha256:createHash("sha256").update(await readFile(path.join(buildDir,"runtime-preview-server.mjs"))).digest("hex"),frontendIndexSha256,release:ready.json.release,schema:{database:"postgres",cluster:null,tables:142,columns:1870,catalogSha256:catalogDigest(catalog)},holds:{outbound:true,scheduler:false,communications:false,stagingOutboundApproved:false,recipientAllowlistEmpty:true},runtime:{instanceId,processId:process.pid}};
      return {
      kind: "growthos-soft-onboarding-local-manifest",
      environment: "LOCAL disposable runtime (in-memory PGlite, loopback only, outbound hold on, communications disabled)",
      createdAt: new Date().toISOString(),
      // Set by this process itself; these are the holds the API child runs with.
      holds: HOLDS,
      companies,
      executionProof,executionProofSha256:proofHash(executionProof),
      note: "Local disposable logins and site keys only; destroyed when the runtime exits. Do not copy into artifacts or Git.",
    };},
  });
  console.log(`[demo-runtime] READY ${ORIGIN} manifest=${manifest.file}`);
  for (const c of companies) console.log(`[demo-runtime] ${c.name}: org=${c.organizationId} site=${c.siteId} key=${c.siteKeyIssueStatus}`);
  const status = await exited;
  if (status) process.exitCode = status;
} catch(error) {
  const e=safeError(error);console.error(`[demo-runtime] ${e.status} ${e.code}`);process.exitCode=2;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
  // Only this instance's own manifest; never another runtime's file.
  if (manifest) await removeOwnedManifest(manifest).catch(() => {});
  await socket.stop().catch(() => {});
  await storage.close().catch(() => {});
  if (path.dirname(buildDir) !== cacheRoot) throw new Error("Unexpected runtime artifact path");
  await rm(buildDir, { recursive: true, force: true });
}
