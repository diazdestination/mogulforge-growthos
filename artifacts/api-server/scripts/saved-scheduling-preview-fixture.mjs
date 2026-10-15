/** Disposable prerequisites and read-only evidence for native browser acceptance.
 * No saved reservations, policy snapshots, receipt digests or targets are seeded.
 * PGlite here proves single-client UI behavior, never PostgreSQL contention. */
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import pg from "pg";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes, randomUUID, scryptSync, createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAll } from "../build.mjs";
import { runSavedSchedulingBrowserQA } from "../../../scripts/growthos-saved-scheduling-browser-qa.mjs";

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(api, "../..");
const ownedSources = [
  "artifacts/api-server/scripts/preview-runtime-isolated.mjs",
  "artifacts/api-server/scripts/saved-scheduling-preview-fixture.mjs",
  "scripts/growthos-saved-scheduling-browser-qa.mjs",
];
export const cleanEnvironment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|SystemRoot|WINDIR|TEMP|TMP|PATHEXT|COMSPEC)$/i.test(key),
    ),
  );
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).trim();

export function assertOwnedSourceStatus(raw) {
  for (const entry of raw.split("\0").filter(Boolean)) {
    const name = entry.slice(3);
    assert.ok(
      ownedSources.includes(name),
      `Dirty source outside the three owned paths: ${name}`,
    );
    assert.ok(
      !/[RC]/.test(entry.slice(0, 2)),
      "Renamed/copied sources require a new ROOT pin",
    );
  }
}

export function loopbackListeners(port) {
  const script = `[System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object Port -eq ${Number(port)} | ForEach-Object { $_.ToString() }`;
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, env: cleanEnvironment() },
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
}
export async function stopOwned(child) {
  if (
    !child ||
    !child.pid ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exited;
}
export async function removeOwned(directory, parent) {
  assert.equal(
    path.dirname(path.resolve(directory)),
    path.resolve(parent),
    "Exact owned temp parent",
  );
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 150,
  });
}
export async function assertFictional(client, manifest, actorKey = "primary") {
  assert.ok(
    ["primary", "sameOrganization", "otherOrganization"].includes(actorKey),
  );
  const expected = manifest.actors[actorKey];
  assert.ok(expected);
  const {
    rows: [actor],
  } = await client.query(
    `SELECT o.id AS org,u.id AS actor,o.slug,o.name,o.timezone,u.email,u.organization_id,u.role,u.is_active,u.is_platform_admin
    FROM organizations o JOIN users u ON u.organization_id=o.id WHERE o.id=$1 AND u.id=$2`,
    [expected.organizationId, expected.actorUserId],
  );
  assert.ok(actor);
  assert.equal(actor.org, expected.organizationId);
  assert.equal(actor.actor, expected.actorUserId);
  assert.equal(actor.slug, expected.slug);
  assert.equal(actor.name, expected.name);
  assert.equal(actor.email, expected.email);
  assert.equal(actor.organization_id, expected.organizationId);
  assert.equal(actor.role, "owner");
  assert.equal(actor.is_active, true);
  assert.equal(actor.is_platform_admin, expected.isPlatformAdmin);
  return actor;
}
async function seed(client, org, user, runId) {
  const manifest = {
    organizationId: org,
    actorUserId: user,
    runId,
    companyZone: "America/New_York",
    inspectionZone: "America/Chicago",
    actors: {
      primary: {
        organizationId: org,
        actorUserId: user,
        slug: "local-runtime-qa",
        name: "LOCAL RUNTIME QA - fictional",
        email: "runtime-qa@example.invalid",
        isPlatformAdmin: true,
      },
    },
  };
  await assertFictional(client, manifest);
  await client.query("UPDATE organizations SET timezone=$1 WHERE id=$2", [
    manifest.companyZone,
    org,
  ]);
  await client.query(
    "INSERT INTO org_settings(organization_id,scheduling_policy,inspection_availability) VALUES($1,NULL,$2)",
    [
      org,
      JSON.stringify({
        timezone: manifest.inspectionZone,
        days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
        windows: [{ startHour: 0, endHour: 24 }],
        maxBookingsPerWindow: 1,
        blackoutDates: [],
      }),
    ],
  );
  const {
    rows: [contact],
  } = await client.query(
    "INSERT INTO contacts(organization_id,first_name,last_name,email,do_not_contact) VALUES($1,$2,$3,$4,true) RETURNING id",
    [
      org,
      "FICTIONAL",
      "SCHEDULING CUSTOMER",
      "scheduling-customer@example.invalid",
    ],
  );
  const {
    rows: [property],
  } = await client.query(
    "INSERT INTO properties(organization_id,contact_id,address_line_1,city,state,postal_code) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
    [
      org,
      contact.id,
      "12 FICTIONAL Scheduling Lane",
      "Synthetic City",
      "NY",
      "00000",
    ],
  );
  const {
    rows: [other],
  } = await client.query(
    "INSERT INTO users(organization_id,email,first_name,last_name,role,is_active,email_verified_at) VALUES($1,$2,'FICTIONAL','SECOND RESOURCE','production',true,now()) RETURNING id",
    [org, "scheduling-resource@example.invalid"],
  );
  Object.assign(manifest, {
    contactId: contact.id,
    propertyId: property.id,
    otherResourceId: other.id,
    resources: [
      { id: user, label: "LOCAL QA OPERATOR" },
      { id: other.id, label: "FICTIONAL SECOND RESOURCE" },
    ],
  });
  const {
    rows: [settings],
  } = await client.query(
    "SELECT scheduling_policy,inspection_availability FROM org_settings WHERE organization_id=$1",
    [org],
  );
  assert.equal(settings.scheduling_policy, null);
  assert.equal(
    settings.inspection_availability.timezone,
    manifest.inspectionZone,
  );
  await assertFictional(client, manifest);
  const {
    rows: [foreignOrg],
  } = await client.query(
    "INSERT INTO organizations(name,slug,timezone) VALUES($1,$2,$3) RETURNING id",
    [
      "LOCAL SCHEDULING SCOPE QA - fictional",
      `local-scheduling-scope-qa-${runId}`,
      manifest.companyZone,
    ],
  );
  for (const [key, organizationId, email, firstName, slug, name] of [
    [
      "sameOrganization",
      org,
      "runtime-same-org@example.invalid",
      "SAME ORG",
      manifest.actors.primary.slug,
      manifest.actors.primary.name,
    ],
    [
      "otherOrganization",
      foreignOrg.id,
      "runtime-other-org@example.invalid",
      "OTHER ORG",
      `local-scheduling-scope-qa-${runId}`,
      "LOCAL SCHEDULING SCOPE QA - fictional",
    ],
  ]) {
    const salt = randomBytes(16).toString("hex");
    const hash = `scrypt$${salt}$${scryptSync("Local-QA-only-2026!", salt, 64).toString("hex")}`;
    const {
      rows: [actor],
    } = await client.query(
      "INSERT INTO users(organization_id,email,first_name,last_name,password_hash,role,is_active,email_verified_at,is_platform_admin) VALUES($1,$2,$3,'FICTIONAL OWNER',$4,'owner',true,now(),false) RETURNING id",
      [organizationId, email, firstName, hash],
    );
    manifest.actors[key] = {
      organizationId,
      actorUserId: actor.id,
      email,
      slug,
      name,
      isPlatformAdmin: false,
    };
    await assertFictional(client, manifest, key);
  }
  return manifest;
}
function observer(client, manifest) {
  return async ({ operationId = null, targetId = null } = {}) => {
    await assertFictional(client, manifest);
    const result = {
      organizationId: manifest.organizationId,
      operationId,
      targetId,
    };
    // All table names are constant; every data selection has an exact org guard.
    for (const table of [
      "appointments",
      "projects",
      "scheduled_actions",
      "crm_tasks",
      "audit_events",
      "automations",
    ]) {
      result[table] = (
        await client.query(
          `SELECT * FROM ${table} WHERE organization_id=$1 ORDER BY id`,
          [manifest.organizationId],
        )
      ).rows;
    }
    result.settings = (
      await client.query(
        "SELECT scheduling_policy,inspection_availability FROM org_settings WHERE organization_id=$1",
        [manifest.organizationId],
      )
    ).rows;
    result.target = targetId
      ? (
          await client.query(
            "SELECT * FROM appointments WHERE organization_id=$1 AND id=$2",
            [manifest.organizationId, targetId],
          )
        ).rows
      : [];
    result.receipt = operationId
      ? (
          await client.query(
            "SELECT * FROM audit_events WHERE organization_id=$1 AND id=$2",
            [manifest.organizationId, operationId],
          )
        ).rows
      : [];
    return JSON.parse(JSON.stringify(result));
  };
}
export async function runSavedSchedulingPreview({
  scopeSwitchOnly = false,
} = {}) {
  assert.equal(typeof scopeSwitchOnly, "boolean");
  const runId = randomUUID(),
    reportDir = path.join(
      root,
      `reports/saved-scheduling-browser-2026-10-14-${runId}`,
    );
  await mkdir(reportDir, { recursive: false });
  await writeFile(path.join(reportDir, ".gitignore"), "*\n");
  const receipt = {
    runId,
    startedAt: new Date().toISOString(),
    engine: "PGlite/socket/API + owned Playwright; no race proof",
    mode: scopeSwitchOnly
      ? "FOCUSED scope-switch-only, not full Task12 acceptance"
      : "full-matrix",
    base: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    dirty: git("status", "--short"),
    sourceHashes: {},
    cleanup: {},
    status: "starting",
  };
  const cacheRoot = path.join(api, "node_modules/.cache");
  let storage, socket, client, child, schema, buildDir, manifest;
  const env = cleanEnvironment();
  const signal = () => {
    child?.kill();
    schema?.kill();
  };
  try {
    for (const name of ownedSources)
      receipt.sourceHashes[name] = sha(await readFile(path.join(root, name)));
    receipt.knownIntegratedAncestor =
      "1260d40ba42e833757535ad32e3c11f8c5222b61";
    // Ancestry establishes provenance only. ROOT independently approves the
    // actual integrated checkpoint before its final acceptance execution.
    git("merge-base", "--is-ancestor", receipt.knownIntegratedAncestor, "HEAD");
    const dirtyStatus = execFileSync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: root, encoding: "utf8", windowsHide: true },
    );
    assertOwnedSourceStatus(dirtyStatus);
    receipt.sourceInputHashes = {};
    for (const name of git(
      "ls-files",
      "artifacts/api-server/src",
      "lib/scheduling-core/src",
      "lib/db/src",
      "lib/api-client-react/src",
    )
      .split(/\r?\n/)
      .filter(Boolean))
      receipt.sourceInputHashes[name] = sha(
        await readFile(path.join(root, name)),
      );
    assert.deepEqual(
      loopbackListeners(4193),
      [],
      "4193 must be free; no occupant is stopped",
    );
    await mkdir(cacheRoot, { recursive: true });
    buildDir = await mkdtemp(path.join(cacheRoot, "saved-scheduling-"));
    storage = await PGlite.create();
    socket = new PGLiteSocketServer({
      db: storage,
      host: "127.0.0.1",
      port: 0,
      maxConnections: 20,
    });
    await socket.start();
    Object.assign(env, {
      DATABASE_URL: `postgresql://postgres:synthetic@${socket.getServerConn()}/postgres`,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "4193",
      APP_ORIGIN: "http://127.0.0.1:4193",
      STATIC_DIR: path.join(root, "artifacts/command-center/dist/public"),
      SESSION_SECRET: "synthetic-runtime-preview-never-deploy",
      OBJECT_STORAGE_PROVIDER: "postgres",
      AUTO_MIGRATE: "false",
      LOG_LEVEL: "warn",
      COMMUNICATIONS_ENABLED: "false",
      GROWTHOS_OUTBOUND_HOLD: "true",
      SCHEDULER_AUTOSTART: "false",
      RUNTIME_SYNTHETIC_PREVIEW: "loopback-only",
    });
    receipt.guards = {
      HOST: env.HOST,
      PORT: env.PORT,
      AUTO_MIGRATE: env.AUTO_MIGRATE,
      COMMUNICATIONS_ENABLED: env.COMMUNICATIONS_ENABLED,
      GROWTHOS_OUTBOUND_HOLD: env.GROWTHOS_OUTBOUND_HOLD,
      SCHEDULER_AUTOSTART: env.SCHEDULER_AUTOSTART,
      envKeys: Object.keys(env).sort(),
    };
    receipt.buildHashes = {};
    for (const name of [
      "index.html",
      ...(await readdir(path.join(env.STATIC_DIR, "assets"))).map(
        (n) => `assets/${n}`,
      ),
    ])
      receipt.buildHashes[name] = sha(
        await readFile(path.join(env.STATIC_DIR, name)),
      );
    await buildAll({
      entryPoint: path.join(api, "src/test-helpers/runtime-preview-server.ts"),
      outDir: buildDir,
    });
    receipt.apiBuildHashes = {};
    for (const name of await readdir(buildDir))
      receipt.apiBuildHashes[name] = sha(
        await readFile(path.join(buildDir, name)),
      );
    process.once("SIGINT", signal);
    process.once("SIGTERM", signal);
    const database = path.join(root, "lib/db");
    const code = await new Promise((resolve, reject) => {
      schema = spawn(
        process.execPath,
        [
          path.join(database, "node_modules/drizzle-kit/bin.cjs"),
          "push",
          "--force",
          "--config",
          "drizzle.config.ts",
        ],
        {
          cwd: database,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let log = "";
      schema.stdout.on("data", (b) => (log += b));
      schema.stderr.on("data", (b) => (log += b));
      schema.once("error", reject);
      schema.once("exit", async (c) => {
        await writeFile(path.join(reportDir, "schema.log"), log);
        resolve(c);
      });
    });
    assert.equal(code, 0, "Disposable schema push");
    client = new pg.Client({ connectionString: env.DATABASE_URL });
    await client.connect();
    const {
      rows: [org],
    } = await client.query(
      "INSERT INTO organizations(name,slug) VALUES('LOCAL RUNTIME QA - fictional','local-runtime-qa') RETURNING id",
    );
    const salt = randomBytes(16).toString("hex"),
      hash = `scrypt$${salt}$${scryptSync("Local-QA-only-2026!", salt, 64).toString("hex")}`;
    const {
      rows: [user],
    } = await client.query(
      "INSERT INTO users(email,first_name,last_name,password_hash,email_verified_at,organization_id,role,is_platform_admin) VALUES($1,'LOCAL','QA OPERATOR',$2,now(),$3,'owner',true) RETURNING id",
      ["runtime-qa@example.invalid", hash, org.id],
    );
    manifest = await seed(client, org.id, user.id, runId);
    receipt.manifest = manifest;
    child = spawn(
      process.execPath,
      [path.join(buildDir, "runtime-preview-server.mjs")],
      { cwd: api, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    receipt.apiPid = child.pid;
    let apiLog = "";
    child.stdout.on("data", (b) => (apiLog += b));
    child.stderr.on("data", (b) => (apiLog += b));
    try {
      const deadline = Date.now() + 30000;
      let ready = false;
      while (Date.now() < deadline && !ready) {
        try {
          ready = (await fetch(`${env.APP_ORIGIN}/login`)).ok;
        } catch {}
        if (!ready) await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(ready, "Owned API startup");
      receipt.result = await runSavedSchedulingBrowserQA({
        origin: env.APP_ORIGIN,
        manifest,
        scopeSwitchOnly,
        observe: observer(client, manifest),
        reportDir,
        cacheRoot,
        cleanEnv: env,
        ownedSentinel: "saved-scheduling-local-only",
        assertFictional: async (actorKey = "primary") => {
          assert.equal(env.HOST, "127.0.0.1");
          assert.equal(env.COMMUNICATIONS_ENABLED, "false");
          assert.equal(env.GROWTHOS_OUTBOUND_HOLD, "true");
          assert.equal(env.SCHEDULER_AUTOSTART, "false");
          assert.equal(env.AUTO_MIGRATE, "false");
          await assertFictional(client, manifest);
          return assertFictional(client, manifest, actorKey);
        },
        observeAuth: async () => {
          const result = {};
          for (const [key, actor] of Object.entries(manifest.actors)) {
            await assertFictional(client, manifest, key);
            result[key] = {
              actorUserId: actor.actorUserId,
              organizationId: actor.organizationId,
              sessionCount: Number(
                (
                  await client.query(
                    "SELECT count(*) AS n FROM sessions WHERE sess->'user'->>'id'=$1",
                    [actor.actorUserId],
                  )
                ).rows[0].n,
              ),
              auditIdentities: (
                await client.query(
                  "SELECT id,action,actor_user_id,entity_type,entity_id FROM audit_events WHERE organization_id=$1 ORDER BY id",
                  [actor.organizationId],
                )
              ).rows,
            };
          }
          return result;
        },
      });
      receipt.status = receipt.result.status;
    } finally {
      await writeFile(path.join(reportDir, "api.log"), apiLog);
    }
  } catch (error) {
    receipt.status = "failed";
    receipt.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", signal);
    process.removeListener("SIGTERM", signal);
    for (const [name, fn] of [
      ["api", () => stopOwned(child)],
      ["schema", () => stopOwned(schema)],
      ["observer", () => client?.end()],
      ["socket", () => socket?.stop()],
      ["storage", () => storage?.close()],
      ["buildDir", () => buildDir && removeOwned(buildDir, cacheRoot)],
    ]) {
      try {
        await fn();
        receipt.cleanup[name] = "closed";
      } catch (e) {
        receipt.cleanup[name] = e.message;
        receipt.status = "failed";
        process.exitCode = 1;
      }
    }
    receipt.cleanup.listener4193 = loopbackListeners(4193);
    if (receipt.cleanup.listener4193.length) {
      receipt.status = "failed";
      process.exitCode = 1;
    }
    receipt.finishedAt = new Date().toISOString();
    await writeFile(
      path.join(reportDir, "runtime-receipt.json"),
      JSON.stringify(receipt, null, 2),
    );
    console.log(
      JSON.stringify({
        status: receipt.status,
        reportDir,
        error: receipt.error?.message,
      }),
    );
  }
}
