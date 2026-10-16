// Contractor acceptance (package C, 2026-10-16): LOCAL disposable runtime.
//
// Same isolation model as artifacts/api-server/scripts/preview-runtime-isolated.mjs:
// in-memory PGlite database, loopback-only listener, no .env, no inherited
// provider keys, COMMUNICATIONS_ENABLED=false, GROWTHOS_OUTBOUND_HOLD=true,
// scheduler autostart off. Nothing here touches staging or production.
//
// Differences from the preview runner:
//  * Seeds the fictional QA organization with the contractor-workday,
//    customer-care, standing-service, CALLIE and returning-customer fixtures.
//  * After the API is up, provisions two TEST companies through the normal
//    platform-admin API (POST /api/v1/platform/clients) and issues each TEST
//    smart-site key through the normal API. Owner accounts for those TEST
//    companies are inserted directly as a LOCAL stand-in for invitation
//    acceptance (invitation email is held locally; on staging Codex supplies
//    the owner sign-in path instead).
//  * Writes only nonsecret identities and runtime/source attestations to a
//    unique private artifact folder. Credentials remain in process memory;
//    --run hands them to the workday runner through private closures.
//
// The product server only permits loopback ports 4192 and 4193. 4193 belongs
// to the existing preview, so this runner always uses 4192 and refuses to
// start if that port is already bound.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { sourceBinding, login, EVIDENCE_DIR as EVIDENCE_ROOT } from "./lib.mjs";
import { semanticHash } from "./guards.mjs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const api = path.join(root, "artifacts/api-server");
const database = path.join(root, "lib/db");
const apiRequire = createRequire(path.join(api, "package.json"));
const load = (name) => import(pathToFileURL(apiRequire.resolve(name)).href);
const { PGlite } = await load("@electric-sql/pglite");
const { PGLiteSocketServer } = await load("@electric-sql/pglite-socket");
const pg = (await load("pg")).default;
const scripts = (file) => pathToFileURL(path.join(api, "scripts", file)).href;
const { buildAll } = await import(
  pathToFileURL(path.join(api, "build.mjs")).href
);
const { seedCustomerCarePreview } = await import(
  scripts("customer-care-preview-fixture.mjs")
);
const { seedStandingServicePreview } = await import(
  scripts("standing-service-preview-fixture.mjs")
);
const { seedContractorWorkdayPreview } = await import(
  scripts("contractor-workday-preview-fixture.mjs")
);
const { seedCalliePreview } = await import(
  scripts("callie-preview-fixture.mjs")
);
const { seedSyntheticReturningCustomer } = await import(
  pathToFileURL(
    path.join(root, "scripts/returning-customer-recovery-fixture.mjs"),
  ).href
);

export const PORT = 4192;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const EVIDENCE_DIR = EVIDENCE_ROOT;
const source = sourceBinding();
if (!source.clean) throw Error("local_runtime_requires_committed_clean_source");
const runId = randomUUID(),
  siteSecrets = new Map(),
  staffSecrets = new Map();
// Disposable, local-only fixture credentials (same convention as the preview
// runner). They exist only inside this process's in-memory database.
export const PLATFORM_LOGIN = {
  email: "runtime-qa@example.invalid",
  password: "Local-QA-only-2026!",
};
const LOCAL_TEST_PASSWORD = "Local-TEST-owner-only-2026!";
export const TEST_COMPANIES = [
  {
    key: "painless",
    name: "TEST Painless Roofing",
    slug: "test-painless-roofing",
    profile: "roofing-exteriors",
    timezone: "America/New_York",
    responseTargetMinutes: 30,
    staff: [
      {
        email: "test-painless-owner-a@example.invalid",
        first: "TEST",
        last: "Painless Owner A",
        role: "owner",
      },
      {
        email: "test-painless-owner-b@example.invalid",
        first: "TEST",
        last: "Painless Owner B",
        role: "owner",
      },
    ],
  },
  {
    key: "css",
    name: "TEST Climate Simulation Solutions",
    slug: "test-climate-simulation-solutions",
    profile: "hvac",
    // Placeholder pending owner input O-15 (CSS hours/timezone). TEST only.
    timezone: "America/New_York",
    responseTargetMinutes: 30,
    staff: [
      {
        email: "test-css-owner-tech@example.invalid",
        first: "TEST",
        last: "CSS Owner-Tech",
        role: "owner",
      },
      {
        email: "test-css-office-lead@example.invalid",
        first: "TEST",
        last: "CSS Office Lead",
        role: "office",
      },
    ],
  },
];

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

async function http(
  pathname,
  { method = "GET", body, cookie, headers = {} } = {},
) {
  const response = await fetch(ORIGIN + pathname, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return {
    status: response.status,
    json,
    setCookie: response.headers.getSetCookie?.() ?? [],
  };
}

async function provisionTestCompanies(connectionString) {
  const login = await http("/api/auth/login", {
    method: "POST",
    body: PLATFORM_LOGIN,
  });
  if (login.status !== 200)
    throw new Error(`Platform admin login failed: ${login.status}`);
  const cookie = login.setCookie.map((c) => c.split(";")[0]).join("; ");
  const companies = [];
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    for (const company of TEST_COMPANIES) {
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
          responseTargetMinutes: company.responseTargetMinutes,
          confirmed: true,
        },
      });
      if (![200, 201].includes(draft.status))
        throw new Error(
          `Provisioning ${company.name} failed: ${draft.status} ${JSON.stringify(draft.json)}`,
        );
      const { organizationId, siteId } = draft.json;
      const key = await http(
        `/api/v1/platform/clients/${organizationId}/sites/${siteId}/key`,
        {
          method: "POST",
          cookie,
          headers: { origin: ORIGIN },
          body: { confirmed: true, expectedVersion: 1 },
        },
      );
      // LOCAL stand-in for invitation acceptance (invitation email is held).
      const staff = [];
      for (const member of company.staff) {
        const salt = randomBytes(16).toString("hex");
        const hash = `scrypt$${salt}$${scryptSync(LOCAL_TEST_PASSWORD, salt, 64).toString("hex")}`;
        const {
          rows: [user],
        } = await client.query(
          "INSERT INTO users(email,first_name,last_name,password_hash,email_verified_at,organization_id,role,is_platform_admin) VALUES ($1,$2,$3,$4,now(),$5,$6,false) RETURNING id",
          [
            member.email,
            member.first,
            member.last,
            hash,
            organizationId,
            member.role,
          ],
        );
        staffSecrets.set(user.id, {
          email: member.email,
          password: LOCAL_TEST_PASSWORD,
        });
        staff.push({ ...member, id: user.id });
      }
      const readiness = await http(
        `/api/v1/platform/clients/${organizationId}/readiness`,
        { cookie },
      );
      if (
        key.status !== 200 ||
        typeof (key.json?.apiKey ?? key.json?.key ?? key.json?.secret) !==
          "string"
      )
        throw Error("local_key_issue_failed");
      siteSecrets.set(
        siteId,
        key.json?.apiKey ?? key.json?.key ?? key.json?.secret,
      );
      const site = (
        await client.query(
          "SELECT name FROM smart_sites WHERE id=$1 AND organization_id=$2",
          [siteId, organizationId],
        )
      ).rows[0];
      companies.push({
        key: company.key,
        name: company.name,
        slug: company.slug,
        siteName: site?.name,
        organizationId,
        siteId,
        provisioning: {
          status: draft.status,
          apiPath: "POST /api/v1/platform/clients",
        },
        siteKeyIssue: {
          status: key.status,
          fields: key.json ? Object.keys(key.json) : [],
        },
        readiness: { status: readiness.status },
        staff,
      });
    }
  } finally {
    await client.end();
  }
  return companies;
}

const storage = await PGlite.create();
const socket = new PGLiteSocketServer({
  db: storage,
  host: "127.0.0.1",
  port: 0,
  maxConnections: 20,
});
let child;
const cacheRoot = path.join(api, "node_modules/.cache");
await mkdir(cacheRoot, { recursive: true });
const buildDir = await mkdtemp(path.join(cacheRoot, "acceptance-runtime-"));
try {
  if (!(await portFree(PORT)))
    throw new Error(
      `Port ${PORT} is already in use; refusing to start (4193 belongs to the existing preview).`,
    );
  await socket.start();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|SystemRoot|WINDIR|TEMP|TMP|PATHEXT|COMSPEC)$/i.test(key),
    ),
  );
  Object.assign(env, {
    DATABASE_URL: `postgresql://postgres:synthetic@${socket.getServerConn()}/postgres`,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(PORT),
    APP_ORIGIN: ORIGIN,
    STATIC_DIR: path.join(buildDir, "frontend"),
    GROWTHOS_ENVIRONMENT: "test",
    SESSION_SECRET: "synthetic-acceptance-runtime-never-deploy",
    OBJECT_STORAGE_PROVIDER: "postgres",
    AUTO_MIGRATE: "false",
    LOG_LEVEL: "warn",
    COMMUNICATIONS_ENABLED: "false",
    GROWTHOS_OUTBOUND_HOLD: "true",
    SCHEDULER_AUTOSTART: "false",
    STAGING_OUTBOUND_APPROVED: "false",
    STAGING_EMAIL_RECIPIENT_ALLOWLIST: "",
    WEB_PUSH_ENABLED: "false",
    RUNTIME_SYNTHETIC_PREVIEW: "loopback-only",
    EMAIL_INTELLIGENCE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  });
  await buildAll({
    entryPoint: path.join(api, "src/test-helpers/runtime-preview-server.ts"),
    outDir: buildDir,
  });
  const frontendRequire = createRequire(
    path.join(root, "artifacts/command-center/package.json"),
  );
  const vite = path.join(
    path.dirname(frontendRequire.resolve("vite/package.json")),
    "bin/vite.js",
  );
  const frontendExit = await new Promise((resolve, reject) => {
    const build = spawn(
      process.execPath,
      [vite, "build", "--outDir", env.STATIC_DIR],
      {
        cwd: path.join(root, "artifacts/command-center"),
        env,
        stdio: "inherit",
        windowsHide: true,
      },
    );
    build.once("error", reject);
    build.once("exit", resolve);
  });
  if (frontendExit !== 0) throw Error("local_frontend_build_failed");
  const code = await new Promise((resolve, reject) => {
    const schema = spawn(
      process.execPath,
      [
        path.join(database, "node_modules/drizzle-kit/bin.cjs"),
        "push",
        "--force",
        "--config",
        "drizzle.config.ts",
      ],
      { cwd: database, env, stdio: "inherit", windowsHide: true },
    );
    schema.once("error", reject);
    schema.once("exit", resolve);
  });
  if (code !== 0) throw new Error("Synthetic schema setup failed");
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  const seeded = {};
  try {
    const {
      rows: [org],
    } = await client.query(
      "INSERT INTO organizations(name,slug) VALUES ('LOCAL RUNTIME QA - fictional','local-runtime-qa') RETURNING id",
    );
    const salt = randomBytes(16).toString("hex");
    const hash = `scrypt$${salt}$${scryptSync(PLATFORM_LOGIN.password, salt, 64).toString("hex")}`;
    const {
      rows: [user],
    } = await client.query(
      "INSERT INTO users(email,first_name,last_name,password_hash,email_verified_at,organization_id,role,is_platform_admin) VALUES ($1,'LOCAL','QA OPERATOR',$2,now(),$3,'owner',true) RETURNING id",
      [PLATFORM_LOGIN.email, hash, org.id],
    );
    seeded.qaOrganizationId = org.id;
    const attempt = async (name, fn) => {
      try {
        seeded[name] = (await fn()) ?? "seeded";
      } catch {
        seeded[name] = "FAILED";
        console.error(
          `[acceptance-runtime] fixture ${name} failed (details withheld)`,
        );
      }
    };
    await attempt("customerCare", () =>
      seedCustomerCarePreview(client, org.id, user.id),
    );
    await attempt("standingService", () =>
      seedStandingServicePreview(client, org.id, user.id),
    );
    await attempt("callie", () => seedCalliePreview(client, org.id, user.id));
    await attempt("contractorWorkday", () =>
      seedContractorWorkdayPreview(client, org.id, user.id),
    );
    await attempt("returningCustomer", () =>
      seedSyntheticReturningCustomer(client, {
        namespace: "acceptance-returning-work",
        organizationId: org.id,
        actorUserId: user.id,
        preview: true,
      }),
    );
  } finally {
    await client.end();
  }
  child = spawn(
    process.execPath,
    [path.join(buildDir, "runtime-preview-server.mjs")],
    { cwd: api, env, stdio: "inherit", windowsHide: true },
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => child?.kill(signal));
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    try {
      healthy = (await fetch(`${ORIGIN}/api/healthz`)).status < 500;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!healthy) throw new Error("Acceptance runtime did not become healthy");
  const companies = await provisionTestCompanies(env.DATABASE_URL);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const catalogClient = new pg.Client({ connectionString: env.DATABASE_URL });
  await catalogClient.connect();
  let columns, tables;
  try {
    columns = (
      await catalogClient.query(
        "SELECT c.relname AS table_name,a.attname AS column_name,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=c.oid AND d.deptype='e') ORDER BY c.relname,a.attnum",
      )
    ).rows;
    tables = new Set(columns.map((c) => c.table_name)).size;
  } finally {
    await catalogClient.end();
  }
  const ready = await http("/api/readyz");
  if (ready.status !== 200 || ready.json?.release?.sha !== source.commit)
    throw Error("local_release_unbound");
  const observedAt = new Date().toISOString(),
    attestation = {
      kind: "LOCAL_RUNTIME_READ_ONLY",
      runtimeId: runId,
      observedAt,
      origin: ORIGIN,
      configSha256: semanticHash({
        origin: ORIGIN,
        holds: { outbound: true, scheduler: false, communications: false },
        runtimeId: runId,
      }),
      imageSha256: createHash("sha256")
        .update(
          await readFile(path.join(buildDir, "runtime-preview-server.mjs")),
        )
        .digest("hex"),
      release: ready.json.release,
      frontendIndexSha256: createHash("sha256")
        .update(await readFile(path.join(env.STATIC_DIR, "index.html")))
        .digest("hex"),
      schema: {
        database: "postgres",
        tables,
        columns: columns.length,
        catalogSha256: semanticHash(columns),
      },
      holds: {
        outbound: true,
        scheduler: false,
        communications: false,
        stagingOutboundApproved: false,
        recipientAllowlistEmpty: true,
      },
      fixturesSha256: semanticHash(companies),
    };
  const manifest = {
    kind: "GROWTHOS_ACCEPTANCE_EXECUTION_V1",
    runId,
    origin: ORIGIN,
    preparedAt: observedAt,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    reviewedBy: "ROOT",
    source,
    companies,
    attestation,
    attestationSha256: semanticHash(attestation),
  };
  const runtimeRun = path.join(EVIDENCE_DIR, `runtime-${runId}`);
  await mkdir(runtimeRun);
  await writeFile(
    path.join(runtimeRun, "public-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" },
  );
  console.log(
    `[acceptance-runtime] READY ${ORIGIN} public-manifest=${path.join(runtimeRun, "public-manifest.json")}; credentials remain in this process only`,
  );
  for (const c of companies)
    console.log(
      `[acceptance-runtime] ${c.name}: org=${c.organizationId} site=${c.siteId} provisioning=${c.provisioning.status} key=${c.siteKeyIssue.status}`,
    );
  if (process.argv.includes("--run")) {
    const { runWorkday } = await import("./run-workday-acceptance.mjs");
    await runWorkday({
      inputManifest: manifest,
      runtimeSecrets: {
        signIn: async (page, staff) => {
          const auth = staffSecrets.get(staff.id);
          if (!auth) throw Error("local_staff_secret_missing");
          await login(page, auth.email, auth.password);
        },
        siteKey: (id) => siteSecrets.get(id),
      },
    });
    child.kill();
  }
  const status = await exited;
  if (status) process.exitCode = status;
} finally {
  if (child && child.exitCode === null && child.signalCode === null)
    child.kill();
  await socket.stop().catch(() => {});
  await storage.close().catch(() => {});
  if (path.dirname(buildDir) !== cacheRoot)
    throw new Error("Unexpected runtime artifact path");
  await rm(buildDir, { recursive: true, force: true });
}
