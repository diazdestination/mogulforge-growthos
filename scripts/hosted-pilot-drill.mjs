/** Upload this code-only file into the pinned release image. No secrets in argv/output. */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RELEASE_SHA = "c050067000f3ea1f2d94aa53b3a9c4f71f0d3b41";
export const IMAGE_REF =
  "registry.fly.io/mogulforge-growthos-staging@sha256:0111edc86aaf844e83b0250be7a9deb7accf604d983a66dfbe876f7cd03a42ce";
export const RELEASE_FILES = {
  "scripts/restore-drill-fixture.mjs":
    "accce40ebfb38f6aa69d9e335ff99707cfc3abef8557f4924843e269e796b185",
  "scripts/restore-drill-readonly.mjs":
    "811153afd3848d6879f50e98c2cfdccb45444e3a6fea80d2ee23bfa685fd906b",
  "scripts/restore-drill-acceptance.mjs":
    "ff3559f1b31d493f10a3beab0d8c9c25daec2c6b0b6183f60a3993e3859b2c74",
  "scripts/restore-drill-connection.mjs":
    "70d8a0396fb6b85ab787919dc6b9d82ffb1754e9c78d6a157d77be892aa12558",
  "artifacts/api-server/src/lib/token-encryption.ts":
    "6b17db99dff3eafe9ad85a599022af4ba8d972197234ffdeadbf760b95df0fd5",
  "artifacts/api-server/src/lib/restore-mode.ts":
    "112623d2708c243264f895b9e35de3474f22c5718bcdb5da53333a5234a40166",
  "artifacts/api-server/src/index.ts":
    "3afcf97711b43e83c37e929a7272941cb572eecbbc81eca8cbc5d92488d3c242",
  "artifacts/api-server/src/app.ts":
    "9ea0d5845888d8e1569b783158bce7e66e97e2a10a0e8ed068046e5fb97b13b8",
};

const fail = (label) => {
  throw new Error(label);
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const modes = [
  "--seed-source",
  "--verify-source",
  "--verify-restored",
  "--inspect-restored-app",
];

// Fixed labels/templates only: diagnostics never include concrete fixture IDs,
// query strings, response bodies, bearer tokens, or a caller-provided URL.
const inspectionRoutes = {
  auth_user: ["GET", "/api/auth/user", 200],
  contact_a: ["GET", "/api/v1/contacts/:fixtureAContact", 200],
  lead_a: ["GET", "/api/v1/leads/:fixtureALead", 200],
  project_a: ["GET", "/api/v1/projects/:fixtureAProject", 200],
  decision_room_a: ["GET", "/api/v1/revenue/rooms/:fixtureALead", 200],
  value_ledger_a: ["GET", "/api/v1/revenue/value", 200],
  execution_a: ["GET", "/api/v1/revenue/executions/:fixtureAExecution", 200],
  lead_evidence_a: ["GET", "/api/v1/revenue/evidence/:fixtureALead", 200],
  revenue_desk_a: ["GET", "/api/v1/revenue/desk", 200],
  private_object_a: [
    "GET",
    "/api/v1/storage/objects/uploads/:fixtureAObject",
    200,
  ],
  deny_contact_b: ["GET", "/api/v1/contacts/:fixtureBContact", 404],
  deny_lead_b: ["GET", "/api/v1/leads/:fixtureBLead", 404],
  deny_decision_room_b: ["GET", "/api/v1/revenue/rooms/:fixtureBLead", 404],
  deny_private_object_b: [
    "GET",
    "/api/v1/storage/objects/uploads/:fixtureBObject",
    404,
  ],
  deny_contact_write: ["PATCH", "/api/v1/contacts/:fixtureAContact", 405],
  deny_login: ["GET", "/api/login", 405],
  deny_logout: ["GET", "/api/logout", 405],
  deny_google_callback: ["GET", "/api/v1/integrations/google/callback", 405],
  deny_public_intake: ["GET", "/api/v1/public/assessments", 405],
};
const inspectionFailureCategories = new Set([
  "transport_error",
  "request_timeout",
  "unexpected_http_status",
  "invalid_json",
  "record_mismatch",
  "response_body_read_failed",
  "private_object_mismatch",
]);

export function hostedFailure(error) {
  const sqlstate = /^[A-Z0-9]{5}$/.test(error?.code || "") ? error.code : null;
  const label = /^(hosted|restore)_[a-z_]+$/.test(error?.message || "")
    ? error.message
    : sqlstate || "operation_failed";
  const phase =
    /^(attest_release|load_runtime|validate_configuration|validate_targets|seed_tenant_[ab]|fingerprint_tenant_[ab]|acceptance_tenant_[ab]|session_locks|inspect_private_app|post_inspection_fingerprint_[ab])$/.test(
      error?.hostedPhase || "",
    )
      ? error.hostedPhase
      : "unknown";
  const evidence = {
    check: "hosted_pilot_drill_failure",
    phase,
    label,
    sqlstate,
  };
  const routeCheck = error?.hostedHttpCheck;
  if (
    Object.hasOwn(inspectionRoutes, routeCheck) &&
    inspectionFailureCategories.has(error?.hostedHttpCategory)
  ) {
    const [method, route, expectedHttpStatus] = inspectionRoutes[routeCheck];
    Object.assign(evidence, {
      routeCheck,
      route: `${method} ${route}`,
      httpStatus:
        Number.isInteger(error.hostedHttpStatus) &&
        error.hostedHttpStatus >= 100 &&
        error.hostedHttpStatus <= 599
          ? error.hostedHttpStatus
          : null,
      expectedHttpStatus,
      failureCategory: error.hostedHttpCategory,
    });
  }
  return evidence;
}

async function duringPhase(phase, action) {
  try {
    return await action();
  } catch (error) {
    const safe = hostedFailure(error);
    const failure = new Error(safe.label);
    failure.hostedPhase = phase;
    if (safe.sqlstate) failure.code = safe.sqlstate;
    if (safe.routeCheck) {
      failure.hostedHttpCheck = safe.routeCheck;
      failure.hostedHttpStatus = safe.httpStatus;
      failure.hostedHttpCategory = safe.failureCategory;
    }
    throw failure;
  }
}

function inspectionFailure(label, routeCheck, httpStatus, category) {
  const failure = new Error(label);
  failure.hostedHttpCheck = routeCheck;
  failure.hostedHttpStatus = httpStatus;
  failure.hostedHttpCategory = category;
  throw failure;
}

export async function attestRelease(
  root = "/app",
  env = process.env,
  read = readFile,
  manifest = RELEASE_FILES,
) {
  if (
    env.RESTORE_DRILL_IMAGE_REF !== IMAGE_REF ||
    env.RESTORE_DRILL_RELEASE_SHA !== RELEASE_SHA
  )
    fail("hosted_release_reference_mismatch");
  for (const [path, expected] of Object.entries(manifest)) {
    const text = await read(resolve(root, path), "utf8");
    if (digest(text.replace(/\r\n/g, "\n")) !== expected)
      fail("hosted_release_source_mismatch");
  }
  const apiBundleSha256 = digest(
    await read(resolve(root, "artifacts/api-server/dist/index.mjs")),
  );
  if (
    env.RESTORE_DRILL_EXPECTED_BUNDLE_SHA256 &&
    env.RESTORE_DRILL_EXPECTED_BUNDLE_SHA256 !== apiBundleSha256
  )
    fail("hosted_release_bundle_mismatch");
  return {
    releaseSha: RELEASE_SHA,
    imageReference: IMAGE_REF,
    sourceFileManifestVerified: true,
    apiBundleSha256,
    imageDigestEvidence:
      "operator-pinned; correlate with the Fly Machine record",
  };
}

export function restoredReaderUrl(mode, env, parseTarget) {
  const flag = env.RESTORE_DRILL_USE_RESTORED_SOURCE_CREDENTIAL;
  const recovered = env.RESTORE_DRILL_USE_RECOVERED_READER;
  if (![undefined, "false", "true"].includes(recovered))
    fail("hosted_recovered_reader_mode_invalid");
  if (flag === "true" && recovered === "true")
    fail("hosted_restore_credential_modes_conflict");
  if ((flag === undefined || flag === "false") && recovered !== "true")
    return env.RESTORE_DRILL_READER_DATABASE_URL;
  if (
    ![undefined, "false", "true"].includes(flag) ||
    !["--verify-restored", "--inspect-restored-app"].includes(mode) ||
    env.RESTORE_DRILL_MODE !== "managed"
  )
    fail("hosted_restored_credential_mode_invalid");
  const cluster = env.RESTORE_DRILL_EXPECTED_CLUSTER_ID;
  if (
    !/^[a-z0-9]+$/.test(cluster || "") ||
    ["zp2wjrejd2zodn4q", "kzpwm0j18eg04nv3"].includes(cluster)
  )
    fail("hosted_restored_cluster_forbidden");
  if (typeof parseTarget !== "function")
    fail("hosted_restored_source_validation_required");
  if (recovered === "true") {
    // Fly managed restore regenerated the Reader credential in the witnessed
    // drill. Accept only a separately secured, exact-target Reader URL; keep
    // both source secrets untouched. Never infer the source password survived.
    if (!env.RESTORE_DRILL_RECOVERED_READER_DATABASE_URL)
      fail("hosted_recovered_reader_missing");
    parseTarget({
      RESTORE_DRILL_MODE: "managed",
      RESTORE_DRILL_EXPECTED_CLUSTER_ID: cluster,
      RESTORE_DRILL_DATABASE_URL:
        env.RESTORE_DRILL_RECOVERED_READER_DATABASE_URL,
      RESTORE_DRILL_EXPECTED_LOGIN: "growthos-restore-reader",
      RESTORE_DRILL_SYNTHETIC_SLUG: "restore-drill-recovered-reader",
      RESTORE_DRILL_EXPECTED_FINGERPRINT:
        env.RESTORE_DRILL_SOURCE_FINGERPRINT_A,
    });
    return env.RESTORE_DRILL_RECOVERED_READER_DATABASE_URL;
  }
  // The staged secret must still be the exact source Reader. Reuse the
  // existing canonical guard before changing only the hostname in memory.
  parseTarget({
    RESTORE_DRILL_MODE: "source",
    RESTORE_DRILL_EXPECTED_CLUSTER_ID: "zp2wjrejd2zodn4q",
    RESTORE_DRILL_DATABASE_URL: env.RESTORE_DRILL_READER_DATABASE_URL,
    RESTORE_DRILL_EXPECTED_LOGIN: "growthos-restore-reader",
    RESTORE_DRILL_SYNTHETIC_SLUG: "restore-drill-source-credential",
  });
  const target = new URL(env.RESTORE_DRILL_READER_DATABASE_URL);
  target.hostname = `pgbouncer.${cluster}.flympg.net`;
  return target.toString();
}

export function hostedConfiguration(mode, env = process.env, parseTarget) {
  if (!modes.includes(mode)) fail("hosted_mode_invalid");
  if (
    env.FLY_APP_NAME !== "mogulforge-growthos-staging" ||
    env.GROWTHOS_OUTBOUND_HOLD !== "true" ||
    env.STAGING_OUTBOUND_APPROVED !== "false" ||
    env.SCHEDULER_AUTOSTART !== "false"
  )
    fail("hosted_console_identity_or_holds_missing");
  const source = mode.endsWith("source");
  const tenantSlugs = [
    env.RESTORE_DRILL_TENANT_A_SLUG || "restore-drill-pilot-a",
    env.RESTORE_DRILL_TENANT_B_SLUG || "restore-drill-pilot-b",
  ];
  if (
    tenantSlugs[0] === tenantSlugs[1] ||
    tenantSlugs.some((slug) => !/^restore-drill-[a-z0-9-]{3,50}$/.test(slug))
  )
    fail("hosted_tenant_slugs_invalid");
  if (!env.OAUTH_TOKEN_ENCRYPTION_KEY || !env.RESTORE_DRILL_READER_DATABASE_URL)
    fail("hosted_secure_environment_incomplete");
  if (
    mode === "--seed-source" &&
    (env.RESTORE_DRILL_SEED_APPROVED !== "true" || !env.DATABASE_URL)
  )
    fail("hosted_fixture_seed_not_enabled");
  if (
    (mode === "--seed-source" || mode === "--inspect-restored-app") &&
    !/^[a-f0-9]{64,128}$/.test(env.RESTORE_DRILL_SESSION_BEARER || "")
  )
    fail("hosted_inspection_session_missing");
  if (
    !source &&
    (!["logical", "managed"].includes(env.RESTORE_DRILL_MODE) ||
      !env.RESTORE_DRILL_EXPECTED_CLUSTER_ID ||
      !/^[a-f0-9]{64}$/.test(env.RESTORE_DRILL_EXPECTED_BUNDLE_SHA256 || ""))
  )
    fail("hosted_restore_identity_incomplete");
  const readerUrl = restoredReaderUrl(mode, env, parseTarget);
  const readerEnvironments = tenantSlugs.map((slug, index) => ({
    RESTORE_DRILL_MODE: source ? "source" : env.RESTORE_DRILL_MODE,
    RESTORE_DRILL_EXPECTED_CLUSTER_ID: source
      ? "zp2wjrejd2zodn4q"
      : env.RESTORE_DRILL_EXPECTED_CLUSTER_ID,
    RESTORE_DRILL_DATABASE_URL: readerUrl,
    RESTORE_DRILL_EXPECTED_LOGIN: "growthos-restore-reader",
    RESTORE_DRILL_SYNTHETIC_SLUG: slug,
    ...(!source
      ? {
          RESTORE_DRILL_EXPECTED_FINGERPRINT:
            env[
              index === 0
                ? "RESTORE_DRILL_SOURCE_FINGERPRINT_A"
                : "RESTORE_DRILL_SOURCE_FINGERPRINT_B"
            ],
        }
      : {}),
    OAUTH_TOKEN_ENCRYPTION_KEY: env.OAUTH_TOKEN_ENCRYPTION_KEY,
  }));
  const seedEnvironments = tenantSlugs.map((slug, index) => ({
    RESTORE_DRILL_MODE: "source",
    RESTORE_DRILL_EXPECTED_CLUSTER_ID: "zp2wjrejd2zodn4q",
    RESTORE_DRILL_DATABASE_URL: env.DATABASE_URL,
    RESTORE_DRILL_EXPECTED_LOGIN: "growthos-staging-live",
    RESTORE_DRILL_SYNTHETIC_SLUG: slug,
    RESTORE_DRILL_SEED_APPROVED: env.RESTORE_DRILL_SEED_APPROVED,
    GROWTHOS_OUTBOUND_HOLD: "true",
    STAGING_OUTBOUND_APPROVED: "false",
    SCHEDULER_AUTOSTART: "false",
    OAUTH_TOKEN_ENCRYPTION_KEY: env.OAUTH_TOKEN_ENCRYPTION_KEY,
    ...(index === 0
      ? { RESTORE_DRILL_SESSION_BEARER: env.RESTORE_DRILL_SESSION_BEARER }
      : {}),
  }));
  return { mode, source, tenantSlugs, readerEnvironments, seedEnvironments };
}

async function loadRuntime(root) {
  const load = (path) => import(pathToFileURL(resolve(root, path)).href);
  const [fixture, readonly, acceptance] = await Promise.all([
    load("scripts/restore-drill-fixture.mjs"),
    load("scripts/restore-drill-readonly.mjs"),
    load("scripts/restore-drill-acceptance.mjs"),
  ]);
  const require = createRequire(
    resolve(root, "artifacts/api-server/package.json"),
  );
  return {
    ...fixture,
    ...readonly,
    ...acceptance,
    Client: require("pg").Client,
  };
}

export async function proveSessionLockExclusion(connectionString, Client) {
  const clients = [0, 1].map(
    () => new Client({ connectionString, connectionTimeoutMillis: 10000 }),
  );
  const connected = [false, false];
  const lock =
    "SELECT pg_try_advisory_lock(hashtext('growthos_restore_drill_session_proof_v1')) AS acquired, pg_backend_pid() AS pid";
  const unlock =
    "SELECT pg_advisory_unlock(hashtext('growthos_restore_drill_session_proof_v1')) AS released";
  try {
    const opened = await Promise.allSettled(
      clients.map(async (client, index) => {
        await client.connect();
        connected[index] = true;
      }),
    );
    if (opened.some((result) => result.status === "rejected"))
      fail("hosted_session_connections_failed");
    const first = (await clients[0].query(lock)).rows[0];
    const second = (await clients[1].query(lock)).rows[0];
    if (
      first?.acquired !== true ||
      second?.acquired !== false ||
      first.pid === second.pid
    )
      fail("hosted_session_lock_exclusion_failed");
    const identities = await Promise.all(
      clients.map(
        async (client) =>
          (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
      ),
    );
    if (identities[0] !== first.pid || identities[1] !== second.pid)
      fail("hosted_session_backend_changed");
    if ((await clients[0].query(unlock)).rows[0]?.released !== true)
      fail("hosted_session_lock_release_failed");
    if ((await clients[1].query(lock)).rows[0]?.acquired !== true)
      fail("hosted_session_lock_transfer_failed");
    if ((await clients[1].query(unlock)).rows[0]?.released !== true)
      fail("hosted_session_lock_release_failed");
    return {
      independentConnections: 2,
      stableSessionBackends: true,
      competingLockExcluded: true,
      releaseAndReacquireVerified: true,
      schedulerRestartVerified: false,
    };
  } finally {
    // The dedicated key is not the application's scheduler lock. Always clean
    // only this drill key, including a partially failed test, before closing.
    await Promise.allSettled(
      clients
        .filter((_, index) => connected[index])
        .map((client) => client.query(unlock)),
    );
    await Promise.allSettled(clients.map((client) => client.end()));
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveDone, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveDone);
  });
  const port = server.address().port;
  await new Promise((resolveDone, reject) =>
    server.close((error) => (error ? reject(error) : resolveDone())),
  );
  return port;
}

export function inspectionEnvironment(parent, config, port) {
  const selected = Object.fromEntries(
    Object.entries(parent).filter(([key]) =>
      /^(PATH|SystemRoot|WINDIR|TEMP|TMP|PATHEXT|COMSPEC|LANG|TZ)$/i.test(key),
    ),
  );
  return {
    ...selected,
    NODE_ENV: "production",
    LOG_LEVEL: "silent",
    FLY_APP_NAME: "mogulforge-growthos-restore-drill",
    RESTORE_DRILL_ONLY: "true",
    RESTORE_DRILL_MODE: config.readerEnvironments[0].RESTORE_DRILL_MODE,
    RESTORE_DRILL_EXPECTED_CLUSTER_ID:
      config.readerEnvironments[0].RESTORE_DRILL_EXPECTED_CLUSTER_ID,
    DATABASE_URL: config.readerEnvironments[0].RESTORE_DRILL_DATABASE_URL,
    HOST: "127.0.0.1",
    PORT: String(port),
    APP_ORIGIN: `http://127.0.0.1:${port}`,
    AUTO_MIGRATE: "false",
    SCHEDULER_AUTOSTART: "false",
    GROWTHOS_OUTBOUND_HOLD: "true",
    STAGING_OUTBOUND_APPROVED: "false",
    OBJECT_STORAGE_PROVIDER: "postgres",
    SESSION_SECRET: randomBytes(32).toString("hex"),
    OAUTH_TOKEN_ENCRYPTION_KEY: parent.OAUTH_TOKEN_ENCRYPTION_KEY,
  };
}

export async function verifyInspectionHttp(
  base,
  bearer,
  slugs,
  runtime,
  request = fetch,
) {
  const a = runtime.fixtureIds(slugs[0]);
  const b = runtime.fixtureIds(slugs[1]);
  const call = async (routeCheck, path) => {
    try {
      return await request(`${base}${path}`, {
        method: inspectionRoutes[routeCheck][0],
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: { authorization: `Bearer ${bearer}` },
      });
    } catch (error) {
      inspectionFailure(
        "hosted_app_request_failed",
        routeCheck,
        null,
        ["TimeoutError", "AbortError"].includes(error?.name)
          ? "request_timeout"
          : "transport_error",
      );
    }
  };
  const checkStatus = (response, routeCheck, label) => {
    if (response.status !== inspectionRoutes[routeCheck][2])
      inspectionFailure(
        label,
        routeCheck,
        response.status,
        "unexpected_http_status",
      );
  };
  const checks = [
    ["auth_user", "/api/auth/user", (body) => body.user?.id === a.user],
    [
      "contact_a",
      `/api/v1/contacts/${a.contact}`,
      (body) => body.id === a.contact,
    ],
    ["lead_a", `/api/v1/leads/${a.lead}`, (body) => body.id === a.lead],
    [
      "project_a",
      `/api/v1/projects/${a.project}`,
      (body) => body.id === a.project,
    ],
    [
      "decision_room_a",
      `/api/v1/revenue/rooms/${a.lead}`,
      (body) =>
        body.leadId === a.lead &&
        body.versions?.some((row) => row.id === a.room),
    ],
    [
      "value_ledger_a",
      "/api/v1/revenue/value",
      (body) => body.entries?.some((row) => row.id === a.value),
    ],
    [
      "execution_a",
      `/api/v1/revenue/executions/${a.execution}`,
      (body) =>
        body.execution?.id === a.execution &&
        body.events?.some((row) => row.id === a.executionEvent),
    ],
    [
      "lead_evidence_a",
      `/api/v1/revenue/evidence/${a.lead}`,
      (body) => body.leadId === a.lead,
    ],
    [
      "revenue_desk_a",
      "/api/v1/revenue/desk",
      (body) =>
        body.records?.some((row) => row.id === a.lead) &&
        body.executions?.some((row) => row.id === a.execution),
    ],
  ];
  for (const [routeCheck, path, validate] of checks) {
    const response = await call(routeCheck, path);
    checkStatus(response, routeCheck, "hosted_app_record_read_failed");
    let body;
    try {
      body = await response.json();
    } catch {
      inspectionFailure(
        "hosted_app_record_read_failed",
        routeCheck,
        response.status,
        "invalid_json",
      );
    }
    let matches = false;
    try {
      matches = validate(body) === true;
    } catch {
      /* Any malformed response shape is a record mismatch; never emit it. */
    }
    if (!matches)
      inspectionFailure(
        "hosted_app_record_read_failed",
        routeCheck,
        response.status,
        "record_mismatch",
      );
  }
  const object = await call(
    "private_object_a",
    `/api/v1/storage/objects/uploads/${a.object}`,
  );
  checkStatus(object, "private_object_a", "hosted_app_private_object_failed");
  let bytes;
  try {
    bytes = Buffer.from(await object.arrayBuffer());
  } catch {
    inspectionFailure(
      "hosted_app_private_object_failed",
      "private_object_a",
      object.status,
      "response_body_read_failed",
    );
  }
  if (!bytes.equals(runtime.fixtureObject(slugs[0])))
    inspectionFailure(
      "hosted_app_private_object_failed",
      "private_object_a",
      object.status,
      "private_object_mismatch",
    );
  for (const [routeCheck, path] of [
    ["deny_contact_b", `/api/v1/contacts/${b.contact}`],
    ["deny_lead_b", `/api/v1/leads/${b.lead}`],
    ["deny_decision_room_b", `/api/v1/revenue/rooms/${b.lead}`],
    ["deny_private_object_b", `/api/v1/storage/objects/uploads/${b.object}`],
  ]) {
    checkStatus(
      await call(routeCheck, path),
      routeCheck,
      "hosted_app_tenant_denial_failed",
    );
  }
  for (const [routeCheck, path] of [
    ["deny_contact_write", `/api/v1/contacts/${a.contact}`],
    ["deny_login", "/api/login"],
    ["deny_logout", "/api/logout"],
    ["deny_google_callback", "/api/v1/integrations/google/callback"],
    ["deny_public_intake", "/api/v1/public/assessments"],
  ]) {
    checkStatus(
      await call(routeCheck, path),
      routeCheck,
      "hosted_app_mutation_guard_failed",
    );
  }
  return {
    authenticatedReadChecks: checks.length,
    privateObjectBytesMatched: true,
    crossTenantReadDenials: 4,
    writeAndAuthenticationDenials: 5,
  };
}

async function inspectApplication(root, env, config, runtime) {
  const port = await freePort();
  const childEnv = inspectionEnvironment(env, config, port);
  const child = spawn(
    process.execPath,
    [resolve(root, "artifacts/api-server/dist/index.mjs")],
    {
      cwd: resolve(root, "artifacts/api-server"),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.resume();
  child.stderr.resume();
  let exited = false;
  child.once("error", () => {
    exited = true;
  });
  const complete = new Promise((resolveDone) =>
    child.once("close", (code) => {
      exited = true;
      resolveDone(code);
    }),
  );
  const stop = () => {
    if (!exited) child.kill("SIGTERM");
  };
  process.once("exit", stop);
  try {
    const base = childEnv.APP_ORIGIN;
    const deadline = Date.now() + 30000;
    let healthy = false;
    while (Date.now() < deadline && !exited) {
      try {
        const response = await fetch(`${base}/api/healthz`, {
          redirect: "error",
          signal: AbortSignal.timeout(1000),
        });
        healthy =
          response.status === 200 && (await response.json()).status === "ok";
        if (healthy) break;
      } catch {
        /* A not-yet-listening private child is expected during startup. */
      }
      await new Promise((resolveDone) => setTimeout(resolveDone, 250));
    }
    if (!healthy || exited) fail("hosted_private_app_boot_failed");
    const checks = await verifyInspectionHttp(
      base,
      env.RESTORE_DRILL_SESSION_BEARER,
      config.tenantSlugs,
      runtime,
    );
    return {
      appBootVerified: true,
      sameImageApiBundleUsed: true,
      loopbackOnly: true,
      ...checks,
    };
  } finally {
    stop();
    const timeout = setTimeout(() => {
      if (!exited) child.kill("SIGKILL");
    }, 27000);
    timeout.unref();
    await complete;
    clearTimeout(timeout);
    process.removeListener("exit", stop);
  }
}

export async function runHostedDrill(
  mode,
  env = process.env,
  {
    root = "/app",
    attest = attestRelease,
    load = loadRuntime,
    inspect = inspectApplication,
    emit = console.log,
  } = {},
) {
  const startedAt = new Date().toISOString();
  const release = await duringPhase("attest_release", () => attest(root, env));
  const runtime = await duringPhase("load_runtime", () => load(root));
  const config = await duringPhase("validate_configuration", () =>
    hostedConfiguration(mode, env, runtime.parseRestoreDrillTarget),
  );
  await duringPhase("validate_targets", () => {
    // Validate every canonical reader/writer URL before the first source insert.
    for (const reader of config.readerEnvironments)
      runtime.parseRestoreDrillTarget(reader);
    if (mode === "--seed-source")
      for (const seed of config.seedEnvironments)
        runtime.parseRestoreDrillTarget(seed);
  });
  const fixtureEvidence = [];
  if (mode === "--seed-source") {
    for (const [index, seed] of config.seedEnvironments.entries())
      fixtureEvidence.push(
        await duringPhase(`seed_tenant_${index === 0 ? "a" : "b"}`, () =>
          runtime.seedRestoreFixture(seed, { emit: () => {} }),
        ),
      );
  }
  const tenants = [];
  for (const [index, reader] of config.readerEnvironments.entries()) {
    tenants.push({
      fingerprint: await duringPhase(
        `fingerprint_tenant_${index === 0 ? "a" : "b"}`,
        () =>
          runtime.runRestoreDrillReadOnly(reader, {
            emit: () => {},
          }),
      ),
      acceptance: await duringPhase(
        `acceptance_tenant_${index === 0 ? "a" : "b"}`,
        () =>
          runtime.verifyRestoreFixture(reader, {
            emit: () => {},
          }),
      ),
    });
  }
  let lockProof = null;
  if (env.RESTORE_DRILL_CHECK_SESSION_LOCKS === "true")
    lockProof = await duringPhase("session_locks", () =>
      proveSessionLockExclusion(
        config.readerEnvironments[0].RESTORE_DRILL_DATABASE_URL,
        runtime.Client,
      ),
    );
  let app = { appBootVerified: false };
  if (mode === "--inspect-restored-app") {
    app = await duringPhase("inspect_private_app", () =>
      inspect(root, env, config, runtime),
    );
    for (let index = 0; index < config.readerEnvironments.length; index++) {
      await duringPhase(
        `post_inspection_fingerprint_${index === 0 ? "a" : "b"}`,
        async () => {
          const after = await runtime.runRestoreDrillReadOnly(
            config.readerEnvironments[index],
            { emit: () => {} },
          );
          if (after.fingerprint !== tenants[index].fingerprint.fingerprint)
            fail("hosted_app_changed_recovery_data");
        },
      );
    }
    app.tenantFingerprintsUnchanged = true;
  }
  const evidence = {
    check: "hosted_pilot_drill",
    mode,
    ...release,
    startedAt,
    completedAt: new Date().toISOString(),
    fixtureEvidence,
    tenants,
    sessionLockProof: lockProof,
    app,
    providerCalled: false,
    managedBackupRestoreVerified:
      "correlate separately with recorded Fly restore operation",
  };
  emit(JSON.stringify(evidence, null, 2));
  return evidence;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length > 3) fail("hosted_arguments_invalid");
  runHostedDrill(process.argv[2] || "--verify-source").catch((error) => {
    const failure = hostedFailure(error);
    console.error(`HOSTED_PILOT_DRILL_FAILED:${failure.label}`);
    console.error(JSON.stringify(failure, null, 2));
    process.exitCode = 1;
  });
}
