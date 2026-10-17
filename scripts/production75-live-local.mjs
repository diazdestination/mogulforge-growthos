/** Explicit local-only fake provider with real owned PG16 source/copy SQL. */
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, types } from "node:util";
import {
  withWslDockerSession,
  localEnvironment,
  parseLoopbackPort,
} from "./local-dev.mjs";
import { cleanupProduction75Container } from "./production75-local.mjs";
import {
  legacyRoleSql,
  assertLegacyReaderCapabilities,
} from "./production75-legacy-model.mjs";
import {
  createProduction75Observer,
  captureProduction75Extras,
} from "./production75-observer.mjs";
import {
  prepareProduction75,
  deriveProduction75Catalogs,
  captureProduction75Policy,
  captureProduction75State,
  IDENTITY_SQL,
} from "./production75-core.mjs";
import { PINNED_FILES } from "./production75-pins.mjs";
import { buildProduction75Source } from "./production75-source.mjs";
import {
  collectSchemaCatalog,
  catalogDigest,
} from "../reports/release-preparation-2026-10-09/schema-catalog.mjs";
import {
  prepareOperatorPlan,
  prepareCombinedOperatorPlan,
  operatorPlanDigest,
  production75ReaderName,
} from "./production75-custody.mjs";
import {
  createProduction75V1Client,
  useProduction75Credentials,
  mergeV1OwnershipEvidence,
} from "./production75-fly-v1.mjs";
import {
  expectedProduction75ReaderProfile,
  production75ProfileDigest,
  production75SnapshotDigest,
} from "./production75-reader-delta.mjs";
import { EventEmitter } from "node:events";
import { createLiveTransport } from "./production75-live-transport.mjs";
import { captureLiveSnapshot } from "./production75-live-observation.mjs";
import {
  deriveLivePolicies,
  deriveLiveScheduling0019Policy,
} from "./production75-live-policy.mjs";
import {
  executeLivePacket,
  executeSuppliedCombinedPacket,
  validateCombinedLiveOracle,
} from "./production75-live-runner.mjs";
import {
  production75RuntimeHashes,
  combinedManifestDigest,
} from "./production75-live-manifest.mjs";
import {
  buildScheduling0019Source,
  prepareScheduling0019,
  captureScheduling0019State,
  assertScheduling0019Preserved,
  runScheduling0019Verification,
} from "./production75-scheduling0019.mjs";
import { createScheduling0019Observer } from "./production75-scheduling0019-observer.mjs";
import { projectLiveReader } from "./production75-live-observation.mjs";
import { assertProduction75ReaderDelta } from "./production75-reader-delta.mjs";
import {
  runProduction75Operator,
  createOperatorResources,
} from "./production75-operator.mjs";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  BASE = "8df64dc72009832f93b2b491031acd1bb2afb903";
const sha = (b) => createHash("sha256").update(b).digest("hex"),
  hashes = () =>
    production75RuntimeHashes((p) => readFileSync(resolve(ROOT, p), "utf8"));
const check = (ok, code) => {
  if (!ok) throw Object.assign(new Error(code), { safeCode: code });
};
const q = (v) => {
  check(
    /^[a-z_][a-z0-9_-]{0,62}$/.test(v),
    "production75_operator_local_identifier",
  );
  return `"${v}"`;
};
const git = (p) =>
  execFileSync("git", ["show", `${BASE}:${p}`], {
    cwd: ROOT,
    windowsHide: true,
    maxBuffer: 4000000,
  });
const json = (p) => JSON.parse(git(p));
export function selectLocalAction(args) {
  check(
    args.length === 1 &&
      ["--run-local", "--run-combined-local"].includes(args[0]),
    "production75_operator_local_action",
  );
  return args[0] === "--run-local" ? "legacy" : "combined";
}
export function finalizeCombinedLocalProof({
  proof,
  oracle,
  currentHashes,
  candidate,
}) {
  check(
    proof &&
      typeof proof === "object" &&
      !types.isProxy(proof) &&
      Object.getPrototypeOf(proof) === Object.prototype,
    "production75_operator_local_unfinished",
  );
  const descriptors = Object.getOwnPropertyDescriptors(proof);
  check(
    Reflect.ownKeys(descriptors).every(
      (key) =>
        typeof key === "string" &&
        descriptors[key].enumerable &&
        Object.hasOwn(descriptors[key], "value"),
    ) && descriptors.status?.value === "EXECUTED",
    "production75_operator_local_unfinished",
  );
  const completed = {
    ...Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [
        key,
        descriptor.value,
      ]),
    ),
    status: "PASS",
  };
  validateCombinedLiveOracle(oracle, completed, currentHashes, candidate);
  return completed;
}
/** Local fault fixture only: six exact ALTER chunks, never provider wire proof. */
export function splitScheduling0019FaultFixture(sql) {
  check(
    typeof sql === "string" &&
      Buffer.byteLength(sql) === 8126 &&
      sha(sql) ===
        "76e88d3410235f1b6a8a20e595b126455fd5711b46f87055b586786b28f81ca9",
    "production75_operator_local_late_source",
  );
  const starts = [...sql.matchAll(/^ALTER TABLE /gm)].map((m) => m.index);
  check(starts.length === 6, "production75_operator_local_late_source");
  const chunks = starts.map((start, i) =>
    sql.slice(i === 0 ? 0 : start, starts[i + 1] ?? sql.length),
  );
  check(
    chunks.join("") === sql &&
      chunks[5].startsWith(
        'ALTER TABLE "projects" ADD CONSTRAINT "projects_scheduling_reservation_ck"',
      ),
    "production75_operator_local_late_source",
  );
  return chunks;
}
/** Monotonic run boundary: cleanup can start once and cannot rearm work. */
export function createCombinedLocalBudget(now = Date.now) {
  const workUntil = now() + 1200000;
  let cleanupUntil = workUntil + 240000,
    cleaning = false;
  const remaining = () => {
    const ms = (cleaning ? cleanupUntil : workUntil) - now();
    check(
      Number.isFinite(ms) && ms > 0,
      "production75_operator_local_deadline",
    );
    return ms;
  };
  return Object.freeze({
    remaining,
    beginCleanup() {
      if (!cleaning) {
        cleanupUntil = Math.min(cleanupUntil, now() + 240000);
        cleaning = true;
      }
    },
  });
}
export async function cleanupCombinedLocalContainer(identity, command) {
  if (identity.__cleanupAttempted) return null;
  // Read-only ownership checks may resume in the cleanup reserve. Only the
  // executor's actual removal dispatch consumes the one removal opportunity.
  return cleanupProduction75Container(identity, (args) =>
    command(
      args,
      args[0] === "rm"
        ? () => {
            identity.__cleanupAttempted = true;
          }
        : undefined,
    ),
  );
}
const PGDATA = "/var/lib/postgresql/data",
  TMPFS_BYTES = 536870912;
export function production75LocalStorageArguments(combined) {
  return combined
    ? [
        "--mount",
        "type=tmpfs,destination=/var/lib/postgresql/data,tmpfs-size=536870912,tmpfs-mode=0700",
      ]
    : [];
}
export function inspectCombinedLocalStorage(inspection, identity) {
  const code = "production75_operator_local_storage";
  check(
    inspection?.Id === identity.id &&
      inspection.Name === `/${identity.name}` &&
      inspection.Config?.Labels?.["com.forge.local-test"] === identity.runId &&
      inspection.Config.Labels["com.forge.fixture-purpose"] ===
        "production75-local",
    code,
  );
  check(
    Array.isArray(inspection.Mounts) &&
      inspection.Mounts.length === 1 &&
      Array.isArray(inspection.HostConfig?.Mounts) &&
      inspection.HostConfig.Mounts.length === 1,
    code,
  );
  const mount = inspection.Mounts[0],
    configured = inspection.HostConfig.Mounts[0];
  check(
    mount?.Type === "tmpfs" &&
      mount.Destination === PGDATA &&
      mount.RW === true &&
      configured?.Type === "tmpfs" &&
      configured.Target === PGDATA &&
      (configured.ReadOnly === undefined || configured.ReadOnly === false) &&
      configured.TmpfsOptions?.SizeBytes === TMPFS_BYTES &&
      configured.TmpfsOptions.Mode === 448,
    code,
  );
  return {
    storage: {
      type: mount.Type,
      destination: mount.Destination,
      sizeBytes: configured.TmpfsOptions.SizeBytes,
      writable: mount.RW,
      volumeMounts: inspection.Mounts.filter((m) => m.Type === "volume").length,
    },
    mountEvidence: {
      Mounts: [
        { Type: mount.Type, Destination: mount.Destination, RW: mount.RW },
      ],
      HostConfig: {
        Mounts: [
          {
            Type: configured.Type,
            Target: configured.Target,
            ...(configured.ReadOnly === undefined
              ? {}
              : { ReadOnly: configured.ReadOnly }),
            TmpfsOptions: {
              SizeBytes: configured.TmpfsOptions.SizeBytes,
              Mode: configured.TmpfsOptions.Mode,
            },
          },
        ],
      },
    },
  };
}
const volumeName = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(value);
const volumeNamesValid = (names) =>
  Array.isArray(names) &&
  names.length <= 10000 &&
  Object.keys(names).length === names.length &&
  names.every(
    (name, i) => volumeName(name) && (i === 0 || names[i - 1] < name),
  );
export function readCombinedLocalVolumeNames(output) {
  const code = "production75_operator_local_storage_inventory";
  check(
    typeof output === "string" && Buffer.byteLength(output) <= 1048576,
    code,
  );
  const names =
    output === "" ? [] : output.replace(/\r?\n$/, "").split(/\r?\n/);
  check(
    names.length <= 10000 &&
      names.every(volumeName) &&
      new Set(names).size === names.length,
    code,
  );
  return names.sort();
}
export function assertCombinedLocalStorageInventory(before, after) {
  check(
    volumeNamesValid(before) &&
      volumeNamesValid(after) &&
      isDeepStrictEqual(before, after),
    "production75_operator_local_storage_inventory",
  );
  return { before: [...before], after: [...after], unchanged: true };
}
export function handleOperatorClientErrors(client, onFailure) {
  client.on("error", () => {
    try {
      onFailure();
    } catch {}
  });
  return client;
}
async function docker(args, input, timeoutMs = 60000, onDispatch) {
  let executable = "docker";
  if (
    process.platform === "win32" &&
    existsSync("C:/Forge/tools/local-dev/docker-wsl.mjs")
  ) {
    executable = process.execPath;
    args = ["C:/Forge/tools/local-dev/docker-wsl.mjs", ...args];
  }
  return new Promise((done, reject) => {
    const child = spawn(executable, args, {
      env: localEnvironment(),
      windowsHide: true,
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    onDispatch?.();
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("local docker deadline"));
    }, timeoutMs);
    child.stdout.on("data", (b) => {
      size += b.length;
      if (size > 8000000) child.kill();
      else chunks.push(b);
    });
    child.stderr.resume();
    if (input) child.stdin.end(input);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("local docker failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? done(Buffer.concat(chunks))
        : reject(new Error("local docker failed"));
    });
  });
}
async function seed(c) {
  for (let n = 1; n <= 2; n++) {
    const org = (
        await c.query(
          "INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING id",
          [`Fictional operator tenant ${n}`, `operator-fictional-${n}`],
        )
      ).rows[0].id,
      user = `fictional-${n}`;
    await c.query("INSERT INTO users(id,organization_id) VALUES($1,$2)", [
      user,
      org,
    ]);
    await c.query(
      "INSERT INTO org_settings(organization_id,business_profile,lead_scoring,ai_instructions) VALUES($1,$2,NULL,$3)",
      [
        org,
        JSON.stringify({ fictional: true, unicode: "Ω", items: [1, null] }),
        `Fictional preserved note ${n}`,
      ],
    );
    const contact = (
      await c.query(
        "INSERT INTO contacts(organization_id,first_name,last_name,do_not_contact_email) VALUES($1,$2,NULL,$3) RETURNING id",
        [org, `Fictional ${n}`, n === 2],
      )
    ).rows[0].id;
    const lead = (
      await c.query(
        "INSERT INTO leads(organization_id,contact_id,score_reasons,summary) VALUES($1,$2,$3,NULL) RETURNING id",
        [org, contact, JSON.stringify([{ fictional: true }])],
      )
    ).rows[0].id;
    await c.query(
      "INSERT INTO lead_imports(organization_id,file_name,total_rows,errors) VALUES($1,$2,$3,$4)",
      [org, "fictional.csv", n, JSON.stringify([{ row: n, error: "fixture" }])],
    );
    await c.query(
      "INSERT INTO estimates(organization_id,lead_id,title,line_items,total_cents,notes) VALUES($1,$2,$3,$4,$5,NULL)",
      [
        org,
        lead,
        "Fictional estimate",
        JSON.stringify([{ quantity: n }]),
        n * 100,
      ],
    );
    await c.query(
      "INSERT INTO projects(organization_id,lead_id,name,crew_notes) VALUES($1,$2,$3,NULL)",
      [org, lead, "Fictional project"],
    );
    for (const status of ["pending", "failed", "done"])
      await c.query(
        "INSERT INTO scheduled_actions(organization_id,action,context,run_at,status,attempts,last_error) VALUES($1,$2,$3,'2026-01-01T00:00:00Z',$4,0,NULL)",
        [
          org,
          JSON.stringify({ type: "held-fixture" }),
          JSON.stringify({ unknownExternalOutcome: status === "failed" }),
          status,
        ],
      );
  }
}
async function runLocal(combined = false, context = {}) {
  const gitText = (...args) =>
    execFileSync("git", args, { cwd: ROOT, windowsHide: true })
      .toString()
      .trim();
  const candidate = combined
    ? {
        repository: "diazdestination/mogulforge-growthos",
        commit: gitText("rev-parse", "HEAD"),
        tree: gitText("rev-parse", "HEAD^{tree}"),
      }
    : null;
  if (combined)
    check(
      gitText("status", "--porcelain", "--untracked-files=normal") === "",
      "production75_operator_local_dirty",
    );
  const runId = randomUUID(),
    out = combined
      ? resolve(ROOT, "work", `production75-combined-${runId}`)
      : resolve(ROOT, "reports/authenticated-driver-2026-10-12", runId);
  if (combined) {
    // Check before mkdir: evidence must never dirty the frozen candidate.
    check(
      gitText(
        "check-ignore",
        "--",
        `work/production75-combined-${runId}/native-result.json`,
      ).length > 0,
      "production75_operator_local_ignore",
    );
  }
  await mkdir(out, { recursive: true });
  const receipt = {
    kind: combined
      ? "SYNTHETIC_PROXY_REAL_DRIVER_SQL_COMBINED"
      : "SYNTHETIC_PROXY_REAL_DRIVER_SQL",
    runId,
    status: "FAILED",
    startedAt: new Date().toISOString(),
    sourceCandidate: BASE,
    liveProviderCalls: false,
    proxyOwnershipSynthetic: true,
    realOwnerOrCapabilityAdmission: false,
    providerAuthenticationProof: false,
    providerExtensionBinaryProof: false,
    opaqueSourceSettingsProof: false,
    rawRowsRecorded: false,
    moduleHashesBefore: hashes(),
    cases: {},
    cleanup: { clients: 0, sockets: 0, containers: 0 },
    ...(combined
      ? { candidate, schedulingCases: [], ownedContainers: [] }
      : {}),
  };
  context.out = out;
  context.receipt = receipt;
  const containers = [],
    clients = [];
  let storageBefore = null;
  let failed = false;
  const budget = combined ? createCombinedLocalBudget() : null;
  const active = () => {
    budget?.remaining();
  };
  const boundedQuery = async (operation, expire) => {
    if (!combined) return operation();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => {
              expire();
              reject(
                Object.assign(Error("production75_operator_local_deadline"), {
                  safeCode: "production75_operator_local_deadline",
                }),
              );
            },
            Math.min(15000, budget.remaining()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const runDocker = async (args, input, onDispatch) => {
    active();
    return docker(
      args,
      input,
      combined ? Math.min(60000, budget.remaining()) : 60000,
      onDispatch,
    );
  };
  const { Client } = createRequire(
    resolve(ROOT, "artifacts/api-server/package.json"),
  )("pg");
  const image = JSON.parse(
    (await runDocker(["image", "inspect", "postgres:16-alpine"])).toString(),
  )[0];
  check(
    /^sha256:[a-f0-9]{64}$/.test(image.Id),
    "production75_operator_local_image",
  );
  receipt.imageId = image.Id;
  if (combined)
    check(
      image.Id ===
        "sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea",
      "production75_operator_local_image_drift",
    );
  const canonical95 = json(
      "reports/staging-observation-2026-10-10/fixtures/catalog-95.json",
    ),
    canonical142 = json(
      "reports/staging-observation-2026-10-10/fixtures/catalog-142.json",
    );
  const catalog75 = json(
      "reports/production75-recovery-2026-10-11/catalog75-fly-db.json",
    ),
    otherCatalog = json(
      "reports/production75-recovery-2026-10-11/catalog75-growthos_staging.json",
    ),
    derived = deriveProduction75Catalogs(catalog75, canonical95, canonical142),
    otherDerived = deriveProduction75Catalogs(
      otherCatalog,
      canonical95,
      canonical142,
    );
  const source = buildProduction75Source(
    PINNED_FILES.map((p) => ({ ...p, bytes: git(p.path) })),
  );
  if (combined)
    for (const p of PINNED_FILES) {
      const candidateBytes = execFileSync("git", ["show", `HEAD:${p.path}`], {
        cwd: ROOT,
        windowsHide: true,
        maxBuffer: 4000000,
      });
      check(
        candidateBytes.length === p.bytes && sha(candidateBytes) === p.sha256,
        "production75_operator_local_source_drift",
      );
    }
  const schedulingSource = combined
    ? buildScheduling0019Source({
        sourceCommit: "91b7fd2c1fd98d441848e0357954e35c9f65d688",
        path: "reports/staging-schema-preview-2026-10-01/0019_saved-scheduling-policy.sql",
        bytes: execFileSync(
          "git",
          [
            "show",
            "HEAD:reports/staging-schema-preview-2026-10-01/0019_saved-scheduling-policy.sql",
          ],
          { cwd: ROOT, windowsHide: true },
        ),
      })
    : null;
  const legacySource = {
    sourceCommit: source.sourceCommit,
    sourceFiles: source.sourceFiles,
    steps: source.steps.map(({ sql, ...step }) => step),
  };
  let combinedOracle, combinedCatalogs, combinedManifest;
  async function box() {
    active();
    if (combined)
      check(
        containers.length < 8 && storageBefore !== null,
        "production75_operator_local_inventory",
      );
    const nonce = randomUUID(),
      owned = {
        runId: nonce,
        name: `production75-local-${process.pid}-${nonce.slice(0, 8)}`,
        id: null,
      };
    containers.push(owned);
    owned.id = (
      await runDocker([
        "run",
        "--detach",
        "--rm",
        "--pull=never",
        "--name",
        owned.name,
        "--label",
        `com.forge.local-test=${nonce}`,
        "--label",
        "com.forge.fixture-purpose=production75-local",
        "--memory",
        "2g",
        "--cpus",
        "2",
        ...production75LocalStorageArguments(combined),
        "--publish",
        "127.0.0.1::5432",
        "--env",
        "POSTGRES_USER=postgres",
        "--env",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        "--env",
        "POSTGRES_DB=postgres",
        image.Id,
      ])
    )
      .toString()
      .trim();
    check(
      /^[a-f0-9]{64}$/.test(owned.id),
      "production75_operator_local_container",
    );
    if (combined) {
      const inspection = JSON.parse(
        (await runDocker(["inspect", owned.id])).toString(),
      );
      check(
        Array.isArray(inspection) && inspection.length === 1,
        "production75_operator_local_storage",
      );
      Object.assign(owned, inspectCombinedLocalStorage(inspection[0], owned));
    }
    let ready = false;
    for (let i = 0; i < 45; i++) {
      try {
        await runDocker([
          "exec",
          owned.id,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "postgres",
        ]);
        ready = true;
        break;
      } catch {
        active();
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    check(ready, "production75_operator_local_ready");
    owned.port = parseLoopbackPort(
      (await runDocker(["port", owned.id, "5432/tcp"])).toString(),
    );
    owned.loopbackOnly = true;
    return owned;
  }
  async function connect(
    b,
    database,
    user = "postgres",
    readonly = false,
    resources = null,
  ) {
    const factory = async () => {
      active();
      const c = new Client({
        host: "127.0.0.1",
        port: b.port,
        database,
        user,
        password: "local-fixture",
        ssl: false,
        connectionTimeoutMillis: 10000,
        query_timeout: 15000,
        options: `-c TimeZone=UTC -c search_path=pg_catalog,public${readonly ? " -c default_transaction_read_only=on" : ""}`,
      });
      clients.push(c);
      handleOperatorClientErrors(c, () => {
        c.__idleFailed = true;
        resources?.abort();
        c.connection?.stream?.destroy();
      });
      const query = c.query.bind(c);
      if (resources || combined)
        c.query = async (...args) => {
          active();
          resources?.assertActive();
          check(!c.__idleFailed, "production75_operator_local_client");
          const value = await boundedQuery(
            () => query(...args),
            () => c.connection?.stream?.destroy(),
          );
          resources?.assertActive();
          return value;
        };
      try {
        await c.connect();
        return c;
      } catch {
        await end(c);
        throw Object.assign(new Error("production75_operator_local_client"), {
          safeCode: "production75_operator_local_client",
        });
      }
    };
    return resources
      ? resources.acquire(factory, async (c) => {
          c.connection?.stream?.destroy();
          await end(c);
        })
      : factory();
  }
  async function end(c) {
    if (c.__closing) return c.__closing;
    c.__closing = (async () => {
      let timer;
      try {
        await Promise.race([
          c.end(),
          new Promise((resolve) => {
            timer = setTimeout(() => {
              c.connection?.stream?.destroy();
              resolve();
            }, 1000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        c.connection?.stream?.destroy();
        if (!c.__closed) {
          c.__closed = true;
          receipt.cleanup.clients++;
          if (c.connection?.stream?.destroyed) receipt.cleanup.sockets++;
        }
      }
    })();
    return c.__closing;
  }
  async function roleBase(b) {
    const c = await connect(b, "postgres");
    try {
      await c.query(legacyRoleSql());
      await c.query(
        'ALTER ROLE "fly-user" SET role TO schema_admin; ALTER ROLE "growthos-staging-live" SET role TO schema_admin; ALTER ROLE schema_admin SET search_path TO public,pg_catalog',
      );
    } finally {
      await end(c);
    }
  }
  async function initialize(b, layout = 0) {
    await roleBase(b);
    const control = await connect(b, "postgres");
    try {
      for (const name of [
        "fly-db",
        "growthos_staging",
        "mogulforge-growthos-db",
      ]) {
        await control.query(`CREATE DATABASE ${q(name)} OWNER postgres`);
        const c = await connect(b, name);
        try {
          await c.query(
            `REVOKE ALL ON DATABASE ${q(name)} FROM PUBLIC; GRANT ALL ON DATABASE ${q(name)} TO schema_admin; GRANT CONNECT ON DATABASE ${q(name)} TO _crunchypgbouncer,_crunchyrepl,writer,reader${name === "fly-db" ? `; GRANT ALL ON DATABASE ${q(name)} TO "fly-user"` : ""}`,
          );
          await c.query(
            "CREATE SCHEMA pgbouncer AUTHORIZATION postgres; GRANT USAGE ON SCHEMA pgbouncer TO PUBLIC; ALTER SCHEMA public OWNER TO pg_database_owner; REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE,CREATE ON SCHEMA public TO schema_admin; GRANT USAGE ON SCHEMA public TO PUBLIC",
          );
          if (name === "fly-db")
            await c.query(
              'ALTER DEFAULT PRIVILEGES FOR ROLE "fly-user" IN SCHEMA public GRANT ALL ON TABLES TO schema_admin; ALTER DEFAULT PRIVILEGES FOR ROLE "fly-user" IN SCHEMA public GRANT ALL ON SEQUENCES TO schema_admin',
            );
          if (name !== "mogulforge-growthos-db") {
            await c.query("SET ROLE schema_admin");
            await c.query(
              git(
                `reports/production75-recovery-2026-10-11/fixture75-${name === "fly-db" && layout === 0 ? "fly-db" : "growthos_staging"}.sql`,
              ).toString(),
            );
            await seed(c);
            await c.query("RESET ROLE");
          }
          await c.query(
            `CREATE VIEW public.pg_stat_monitor AS SELECT ${Array.from({ length: 65 }, (_, i) => `NULL::integer AS metric_${i}`).join(",")}; GRANT SELECT ON public.pg_stat_monitor TO PUBLIC`,
          );
          for (let i = 1; i <= 16; i++)
            await c.query(
              `CREATE FUNCTION public.legacy_provider_function_${String(i).padStart(2, "0")}() RETURNS integer LANGUAGE sql VOLATILE ${i <= 2 ? "SECURITY DEFINER" : ""} AS 'SELECT 1'; ${i > 9 ? `REVOKE EXECUTE ON FUNCTION public.legacy_provider_function_${String(i).padStart(2, "0")}() FROM PUBLIC` : ""}`,
            );
        } finally {
          await end(c);
        }
      }
    } finally {
      await end(control);
    }
  }
  const liveTransports = [];
  const combinedTransportProofs = [];
  async function capture(
    b,
    readerName = null,
    selectedNames = ["fly-db", "growthos_staging", "mogulforge-growthos-db"],
    resources = null,
  ) {
    const ownedScope =
      resources ??
      createOperatorResources({
        until:
          Date.now() +
          (combined ? Math.min(600000, budget.remaining()) : 600000),
      });
    let child = null,
      exited = false;
    const fakePid = 1000 + liveTransports.length;
    class DriverClient extends Client {
      constructor(config) {
        super(config);
        clients.push(this);
      }
      async query(...args) {
        active();
        return boundedQuery(
          () => super.query(...args),
          () => this.connection?.stream?.destroy(),
        );
      }
      async end() {
        await super.end();
        this.connection?.stream?.destroy();
        if (!this.__closed) {
          this.__closed = true;
          receipt.cleanup.clients++;
          if (this.connection?.stream?.destroyed) receipt.cleanup.sockets++;
        }
      }
    }
    const transport = createLiveTransport({
      runFile: async () => "diazdestination@gmail.com",
      readCredentialConfig: async () => "access_token: " + "A".repeat(40),
      choosePort: () => b.port,
      Client: DriverClient,
      pause: async () => {},
      spawnChild: () => {
        child = new EventEmitter();
        child.pid = fakePid;
        child.stdout = { resume() {} };
        child.stderr = { resume() {} };
        child.kill = () => {
          exited = true;
          queueMicrotask(() => child.emit("close", 0));
        };
        return child;
      },
      inspect: async (kind, id) =>
        kind === "listener"
          ? child && !exited
            ? [{ pid: fakePid, address: "127.0.0.1" }]
            : []
          : kind === "children"
            ? []
            : exited
              ? null
              : {
                  pid: id,
                  created: "synthetic",
                  executable: "synthetic-proxy",
                },
    });
    liveTransports.push(transport);
    await transport.verifyIdentity();
    try {
      return await captureLiveSnapshot({
        transport,
        cluster: "abcdefghijklmnop",
        credentials: {
          user: readerName ?? "fly-user",
          password: "local-fixture",
        },
        readerName,
        resources: ownedScope,
        catalogs: {
          fly75: catalog75,
          other75: otherCatalog,
          canonical95,
          canonical142,
        },
        databases: selectedNames,
      });
    } finally {
      if (!resources)
        check(
          (await ownedScope.drain()).closed,
          "production75_operator_local_cleanup",
        );
    }
  }
  async function createFixtureReader(b, readerName) {
    const c = await connect(b, "postgres");
    try {
      await c.query(
        `CREATE ROLE ${q(readerName)} LOGIN INHERIT NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1; GRANT reader TO ${q(readerName)} WITH ADMIN FALSE; GRANT reader TO ${q(readerName)} WITH INHERIT TRUE; GRANT reader TO ${q(readerName)} WITH SET TRUE`,
      );
    } finally {
      await end(c);
    }
  }
  async function seedPost75(c) {
    const parent = (
      await c.query(
        "SELECT o.id AS org,c.id AS contact,u.id AS actor FROM organizations o JOIN contacts c ON c.organization_id=o.id JOIN users u ON u.organization_id=o.id ORDER BY o.slug LIMIT 1",
      )
    ).rows[0];
    check(parent, "production75_operator_local_seed");
    const { org, contact, actor } = parent;
    const task = (
      await c.query(
        "INSERT INTO crm_tasks(organization_id,contact_id,title) VALUES($1,$2,'Fictional obligation') RETURNING id",
        [org, contact],
      )
    ).rows[0].id;
    const visit = (
      await c.query(
        "INSERT INTO appointments(organization_id,contact_id,scheduled_start) VALUES($1,$2,'2026-01-01T00:00:00Z') RETURNING id",
        [org, contact],
      )
    ).rows[0].id;
    const obligation = (
      await c.query(
        "INSERT INTO service_obligations(organization_id,contact_id,appointment_id,task_id,kind,equipment_label,due_at) VALUES($1,$2,$3,$4,'maintenance','Fictional unit','2026-01-02T00:00:00Z') RETURNING id",
        [org, contact, visit, task],
      )
    ).rows[0].id;
    const execution = (
      await c.query(
        "INSERT INTO revenue_executions(organization_id,action_key,fingerprint,kind,state,expires_at) VALUES($1,'fictional-action','fictional-fingerprint','fixture','completed','2026-01-03T00:00:00Z') RETURNING id",
        [org],
      )
    ).rows[0].id;
    await c.query(
      "INSERT INTO revenue_execution_events(organization_id,execution_id,state,detail) VALUES($1,$2,'completed','Fictional Ω event')",
      [org, execution],
    );
    const template = (
      await c.query(
        "INSERT INTO work_checklist_templates(organization_id,created_by_user_id) VALUES($1,$2) RETURNING id",
        [org, actor],
      )
    ).rows[0].id;
    const revision = (
      await c.query(
        "INSERT INTO work_checklist_revisions(organization_id,template_id,version,definition,definition_sha256,created_by_user_id) VALUES($1,$2,1,'{}',$3,$4) RETURNING id",
        [org, template, "a".repeat(64), actor],
      )
    ).rows[0].id;
    await c.query(
      "INSERT INTO appointment_work_entries(organization_id,appointment_id,contact_id,service_obligation_id,checklist_revision_id,parent_snapshot,created_by_user_id,notes) VALUES($1,$2,$3,$4,$5,'{}',$6,'Fictional original Ω')",
      [org, visit, contact, obligation, revision, actor],
    );
  }
  const nativeLayouts = [];
  const principalsFor = (reader) => [
    "fly-user",
    "growthos-staging-live",
    "reader",
    reader,
  ];
  const targetFor = (reader) => ({
    database: "fly-db",
    writerLogin: "fly-user",
    writerInitialRoles: ["fly-user", "schema_admin"],
    writerRole: "schema_admin",
    readerLogin: reader,
    readerRole: reader,
    principals: principalsFor(reader),
  });
  function deltaPlan(layout) {
    return prepareScheduling0019({
      source: schedulingSource,
      catalogs: layout.catalogs,
      target: targetFor(layout.templateReader),
      policyBefore: layout.policies.before,
      policyAfter: layout.policies.after,
      sourceBinding: { candidate, moduleManifestSha256: combinedManifest },
    });
  }
  async function readDelta(layout, plan) {
    const c = await connect(layout.box, "fly-db", layout.templateReader, true);
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const observer = createScheduling0019Observer({
        client: c,
        principals: plan.target.principals,
        catalogs: plan.catalogs,
        identity: {
          database: "fly-db",
          login: layout.templateReader,
          role: layout.templateReader,
        },
      });
      return await captureScheduling0019State(observer, plan);
    } finally {
      try {
        await c.query("ROLLBACK");
      } finally {
        await end(c);
      }
    }
  }
  async function measureCombinedOracle() {
    const layouts = [];
    let legacy;
    for (let i = 0; i < 2; i++) {
      const b = await box(),
        reader = production75ReaderName(randomUUID());
      await initialize(b, i);
      await createFixtureReader(b, reader);
      const c = await connect(b, "fly-db", "fly-user");
      try {
        await c.query(
          "SET ROLE schema_admin; SET search_path=public,pg_catalog",
        );
        const p75 = await captureProduction75Policy(c, principalsFor(reader));
        for (const step of source.steps.slice(0, 3)) await c.query(step.sql);
        const p95 = await captureProduction75Policy(c, principalsFor(reader));
        for (const step of source.steps.slice(3)) await c.query(step.sql);
        const p142 = await captureProduction75Policy(c, principalsFor(reader));
        if (!legacy)
          legacy = {
            kind: "OWNED_NATIVE_POLICY_ORACLE",
            sourceCandidate: BASE,
            templateReader: reader,
            policies: { 75: p75, 95: p95, 142: p142 },
          };
        await seedPost75(c);
        const before = await collectSchemaCatalog(c),
          beforePolicy = await captureProduction75Policy(
            c,
            principalsFor(reader),
          );
        // Independently measure exact native DDL; never predict oracle catalogs.
        await c.query("BEGIN");
        await c.query(schedulingSource.sql);
        const after = await collectSchemaCatalog(c),
          afterPolicy = await captureProduction75Policy(
            c,
            principalsFor(reader),
          );
        await c.query("ROLLBACK");
        check(
          isDeepStrictEqual(await collectSchemaCatalog(c), before),
          "production75_operator_local_oracle_rollback",
        );
        const layout = {
          templateReader: reader,
          catalogs: { before, after },
          policies: { before: beforePolicy, after: afterPolicy },
        };
        layouts.push(layout);
        nativeLayouts.push({ ...layout, box: b });
      } finally {
        await end(c);
      }
    }
    const { sql, ...descriptor } = schedulingSource;
    combinedOracle = {
      kind: "OWNED_NATIVE_COMBINED_POLICY_ORACLE",
      candidate,
      legacy,
      scheduling: {
        source: descriptor,
        layouts,
        coverage: {
          tables: 142,
          columnsBefore: 1867,
          columnsAfter: 1870,
          layouts: 2,
        },
      },
    };
    combinedCatalogs = {
      legacy: {
        fly75: catalog75,
        other75: otherCatalog,
        canonical95,
        canonical142,
      },
      scheduling: layouts.map((l) => l.catalogs),
    };
    combinedManifest = combinedManifestDigest({
      modules: receipt.moduleHashesBefore,
      legacySource,
      schedulingSource: descriptor,
      catalogs: combinedCatalogs,
      oracle: combinedOracle,
      candidate,
    });
    Object.assign(receipt, {
      oracleSha256: sha(JSON.stringify(combinedOracle)),
      moduleManifestSha256: combinedManifest,
      legacySource,
      catalogs: combinedCatalogs,
    });
    await writeFile(
      resolve(out, "oracle.json"),
      JSON.stringify(combinedOracle, null, 2) + "\n",
      { flag: "wx" },
    );
  }
  async function verifyNativeLayout(layout, index) {
    const initialPlan = deltaPlan(layout),
      baseline = await readDelta(layout, initialPlan);
    const stateEvidence = (state) => ({
      phase: state.phase,
      identity: state.identity,
      catalogSha256: catalogDigest(state.catalog, { physical: true }),
      policySha256: sha(JSON.stringify(state.policy)),
      fingerprints: state.fingerprints,
      nullCounts: state.nullCounts,
    });
    await writeFile(
      resolve(out, `layout-${index}-baseline.json`),
      JSON.stringify(stateEvidence(baseline), null, 2) + "\n",
      { flag: "wx" },
    );
    for (const table of [
      "service_obligations",
      "revenue_execution_events",
      "appointment_work_entries",
    ])
      check(
        BigInt(baseline.fingerprints.find((r) => r.table === table).rows) > 0n,
        "production75_operator_local_seed",
      );
    const caseProof = {
      beforeCatalogSha256: catalogDigest(layout.catalogs.before, {
        physical: true,
      }),
      afterCatalogSha256: catalogDigest(layout.catalogs.after, {
        physical: true,
      }),
      coverage: { tables: 142, columnsBefore: 1867, columnsAfter: 1870 },
      sourceDispatches: { rollback: 0, lateFailure: 0, commit: 0 },
    };
    receipt.schedulingCases.push(caseProof);
    const reader = await connect(
      layout.box,
      "fly-db",
      layout.templateReader,
      false,
    );
    try {
      try {
        await reader.query(
          "UPDATE public.appointment_work_entries SET notes=notes WHERE false",
        );
      } catch (e) {
        caseProof.readerWriteDenied = e.code === "42501";
      }
      check(
        caseProof.readerWriteDenied,
        "production75_operator_local_reader_write",
      );
    } finally {
      await end(reader);
    }
    // Every table has a PK: valid duplicate full tuples are impossible. Exercise
    // identical native row multiplicity in the original projection without DDL.
    const admin = await connect(layout.box, "fly-db");
    try {
      const multiplicity = (
        await admin.query(
          `WITH original AS (SELECT * FROM public.appointment_work_entries LIMIT 1), duplicates AS (SELECT * FROM original UNION ALL SELECT * FROM original) SELECT (SELECT count(*) FROM original)::text AS one,(SELECT count(*) FROM duplicates)::text AS two,(SELECT md5(string_agg(md5(row_to_json(original)::text),'' ORDER BY md5(row_to_json(original)::text) COLLATE "C")) FROM original) AS single,(SELECT md5(string_agg(md5(row_to_json(duplicates)::text),'' ORDER BY md5(row_to_json(duplicates)::text) COLLATE "C")) FROM duplicates) AS multiple`,
        )
      ).rows[0];
      const duplicateState = structuredClone(baseline);
      const duplicateFingerprint = duplicateState.fingerprints.find(
        (r) => r.table === "appointment_work_entries",
      );
      duplicateFingerprint.rows = multiplicity.two;
      duplicateFingerprint.bytes = String(
        BigInt(duplicateFingerprint.bytes) * 2n,
      );
      duplicateFingerprint.digest = multiplicity.multiple;
      let duplicateRefused = false;
      try {
        assertScheduling0019Preserved(
          baseline,
          duplicateState,
          initialPlan,
          "pre0019",
        );
      } catch {
        duplicateRefused = true;
      }
      caseProof.duplicateMultiplicityVerified =
        duplicateRefused &&
        multiplicity.one === "1" &&
        multiplicity.two === "2" &&
        multiplicity.single !== multiplicity.multiple;
      caseProof.duplicateEvidence = {
        kind: "NATIVE_ORIGINAL_ROW_UNION_ALL_PROJECTION",
        ...multiplicity,
        preservationRefused: duplicateRefused,
        physicalDuplicatePkRows: false,
      };
      check(
        caseProof.duplicateMultiplicityVerified,
        "production75_operator_local_multiplicity",
      );
      // Commit data drift before verification, then restore only the owned row.
      const original = (
        await admin.query(
          "SELECT id,notes FROM public.appointment_work_entries ORDER BY id LIMIT 1",
        )
      ).rows[0];
      await admin.query(
        "UPDATE public.appointment_work_entries SET notes='Fictional drift Ω' WHERE id=$1",
        [original.id],
      );
      const drift = await readDelta(layout, initialPlan);
      try {
        assertScheduling0019Preserved(baseline, drift, initialPlan, "pre0019");
      } catch {
        caseProof.sameCountDriftRejected = isDeepStrictEqual(
          baseline.fingerprints.map((r) => r.rows),
          drift.fingerprints.map((r) => r.rows),
        );
      }
      await admin.query(
        "UPDATE public.appointment_work_entries SET notes=$2 WHERE id=$1",
        [original.id, original.notes],
      );
      check(
        caseProof.sameCountDriftRejected,
        "production75_operator_local_drift",
      );
      // Native concurrent change is injected immediately before LOCK acquisition.
      const concurrent = await connect(layout.box, "fly-db", "fly-user"),
        plan = deltaPlan(layout);
      let sourceDispatched = 0,
        changed = false;
      const writer = {
        query: async (sql, args) => {
          if (sql.startsWith("LOCK TABLE ") && !changed) {
            changed = true;
            await admin.query(
              "UPDATE public.appointment_work_entries SET notes='Fictional concurrent Ω' WHERE id=$1",
              [original.id],
            );
          }
          if (sql === schedulingSource.sql) sourceDispatched++;
          return concurrent.query(sql, args);
        },
      };
      try {
        const result = await runScheduling0019Verification({
          writer,
          plan,
          baseline,
          outcome: "rollback",
          attemptId: randomUUID(),
          reserve: async () => true,
          persist: async () => {},
          readFresh: () => readDelta(layout, plan),
        });
        caseProof.preLockConcurrentDriftRejected =
          changed &&
          sourceDispatched === 0 &&
          result.proof.rollbackAcknowledged &&
          !result.proof.sourceDispatched;
        await writeFile(
          resolve(out, `layout-${index}-concurrent-drift.json`),
          JSON.stringify(result, null, 2) + "\n",
          { flag: "wx" },
        );
      } finally {
        await end(concurrent);
        await admin.query(
          "UPDATE public.appointment_work_entries SET notes=$2 WHERE id=$1",
          [original.id, original.notes],
        );
      }
      check(
        caseProof.preLockConcurrentDriftRejected,
        "production75_operator_local_concurrent_drift",
      );
    } finally {
      await end(admin);
    }
    for (const kind of ["rollback", "lateFailure", "commit"]) {
      const plan = deltaPlan(layout),
        c = await connect(layout.box, "fly-db", "fly-user"),
        events = [],
        reservations = [],
        observations = [];
      let actualError = null,
        postimage = false,
        ddlAfterPostimage = 0;
      const writer = {
        query: async (sql, args) => {
          if (/^(?:ALTER|CREATE|DROP)\b/.test(sql.trim()) && postimage)
            ddlAfterPostimage++;
          if (sql === schedulingSource.sql) {
            caseProof.sourceDispatches[kind]++;
            if (kind === "lateFailure") {
              const chunks = splitScheduling0019FaultFixture(sql);
              for (const chunk of chunks.slice(0, 5)) await c.query(chunk);
              const update = await c.query(
                "UPDATE public.projects SET scheduling_reservation='{}'::jsonb",
              );
              caseProof.faultFixture = {
                kind: "LOCAL_SPLIT_EXACT_SIX_ALTER_FAULT_FIXTURE",
                chunks: chunks.map((chunk) => ({
                  bytes: Buffer.byteLength(chunk),
                  sha256: sha(chunk),
                })),
                joinedSourceSha256: sha(chunks.join("")),
                injectedUpdates: 1,
                injectedRows: update.rowCount,
                providerWireEquivalence: false,
              };
              check(
                update.rowCount > 0,
                "production75_operator_local_late_seed",
              );
              try {
                return await c.query(chunks[5]);
              } catch (e) {
                actualError = {
                  sqlState: e.code,
                  failedConstraint: e.constraint,
                };
                throw e;
              }
            }
          }
          const result = await c.query(sql, args);
          if (sql === schedulingSource.sql) postimage = true;
          if (index === 1 && kind === "commit" && sql === "COMMIT") {
            await end(c); // server ACK was observed here; caller deliberately loses it.
            throw Error("synthetic lost scheduling COMMIT acknowledgment");
          }
          return result;
        },
      };
      try {
        const result = await runScheduling0019Verification({
          writer,
          plan,
          baseline: await readDelta(layout, plan),
          outcome: kind === "commit" ? "commit" : "rollback",
          attemptId: randomUUID(),
          reserve: async (intent) => {
            reservations.push(intent);
            return reservations.length === 1;
          },
          persist: async (event) => {
            events.push(event);
          },
          readFresh: async () => {
            const state = await readDelta(layout, plan);
            observations.push(stateEvidence(state));
            postimage ||= state.phase === "post0019";
            return state;
          },
        });
        if (kind === "lateFailure") {
          const restored = await readDelta(layout, plan);
          assertScheduling0019Preserved(baseline, restored, plan, "pre0019");
          caseProof.lateFailure = {
            result,
            rollbackAcknowledged: result.proof.rollbackAcknowledged,
            preimagePreserved: true,
            ...actualError,
          };
          check(
            actualError?.sqlState === "23514" &&
              actualError.failedConstraint ===
                "projects_scheduling_reservation_ck" &&
              result.proof.rollbackAcknowledged,
            "production75_operator_local_late_failure",
          );
        } else {
          caseProof[kind] = result;
          check(
            result.status ===
              (kind === "commit" && index === 1
                ? "reconciled-commit-no-replay"
                : `verified-${kind}`),
            "production75_operator_local_delta_outcome",
          );
        }
        await writeFile(
          resolve(out, `layout-${index}-${kind}.json`),
          JSON.stringify(
            { result, events, reservations, observations },
            null,
            2,
          ) + "\n",
          { flag: "wx" },
        );
        if (kind === "commit")
          caseProof.noDdlAfterPostimage = ddlAfterPostimage === 0;
      } finally {
        await end(c);
      }
    }
  }
  try {
    if (combined) {
      storageBefore = readCombinedLocalVolumeNames(
        (await runDocker(["volume", "ls", "--format", "{{.Name}}"])).toString(),
      );
      await measureCombinedOracle();
      for (let i = 0; i < nativeLayouts.length; i++)
        await verifyNativeLayout(nativeLayouts[i], i);
    }
    for (const scenario of ["normal", "lost-commit", "idle-client-error"]) {
      active();
      const transportStart = liveTransports.length;
      const sourceBox = await box();
      await initialize(sourceBox);
      const before = await capture(sourceBox),
        caseId = randomUUID(),
        readerName = production75ReaderName(caseId),
        profile = expectedProduction75ReaderProfile(readerName),
        manifest = combined
          ? combinedManifest
          : sha(JSON.stringify(receipt.moduleHashesBefore));
      let scheduling;
      if (combined) {
        const projected = projectLiveReader(before, profile),
          policies = deriveLivePolicies({
            baseline: projected.databases.find((d) => d.name === "fly-db")
              .policy,
            oracle: combinedOracle.legacy.policies,
            readerName,
            templateReader: combinedOracle.legacy.templateReader,
          });
        scheduling = {
          source: combinedOracle.scheduling.source,
          coverage: combinedOracle.scheduling.coverage,
          layouts: combinedOracle.scheduling.layouts.map((l) => {
            const p = deriveLiveScheduling0019Policy({
              baseline142: policies.policy142,
              oracle: l.policies,
              readerName,
              templateReader: l.templateReader,
            });
            return {
              beforeCatalogSha256: catalogDigest(l.catalogs.before, {
                physical: true,
              }),
              afterCatalogSha256: catalogDigest(l.catalogs.after, {
                physical: true,
              }),
              beforePolicySha256: sha(JSON.stringify(p.before)),
              afterPolicySha256: sha(JSON.stringify(p.after)),
            };
          }),
        };
      }
      const plan = (
          combined ? prepareCombinedOperatorPlan : prepareOperatorPlan
        )({
          runId: caseId,
          backupId: "backup_local_fixture",
          sourceSnapshotSha256: production75SnapshotDigest(before),
          profileSha256: production75ProfileDigest(profile),
          moduleManifestSha256: manifest,
          preparedAt: Date.now(),
          workMs: combined ? Math.min(600000, budget.remaining()) : 600000,
          cleanupMs: combined ? 240000 : 300000,
          maxCostUsdMicros: 150000,
          ...(combined ? { candidate, scheduling } : {}),
        }),
        digest = operatorPlanDigest(plan);
      let copyBox = null,
        deleted = false,
        copyVisible = false;
      const counts = { create: 0, reader: 0, delete: 0 },
        meta = (id, name, version = 1) => ({
          id,
          name,
          region: "iad",
          plan: "basic",
          version,
          status: "ready",
          organization: { Slug: "adam-diaz" },
          attached_apps: [],
        }),
        copyId = "abcdefghijklmnop";
      // Observed legacy detail/restore omit version and attachment evidence.
      const detailMeta = (id, name) => {
        const { version, attached_apps, ...detail } = meta(id, name);
        return detail;
      };
      // Build the owned native clone before the bounded fake HTTP response.
      copyBox = await box();
      await roleBase(copyBox);
      for (const name of [
        "fly-db",
        "growthos_staging",
        "mogulforge-growthos-db",
      ]) {
        const dump = await runDocker([
          "exec",
          sourceBox.id,
          "pg_dump",
          "-U",
          "postgres",
          "--create",
          name,
        ]);
        await runDocker(
          [
            "exec",
            "-i",
            copyBox.id,
            "psql",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
          ],
          dump,
        );
      }

      const fetchFn = async (url, options) => {
        active();
        check(
          new URL(url).origin === "https://api.fly.io",
          "production75_operator_local_origin",
        );
        const endpoint = new URL(url).pathname;
        let value;
        if (options.method === "POST" && endpoint.endsWith("/restore")) {
          counts.create++;
          check(counts.create === 1, "production75_operator_local_replay");
          copyVisible = true;
          value = { data: detailMeta(copyId, plan.copyName) };
        } else if (options.method === "POST" && endpoint.endsWith("/users")) {
          counts.reader++;
          check(counts.reader === 1, "production75_operator_local_replay");
          const c = await connect(copyBox, "postgres");
          try {
            await c.query(
              `CREATE ROLE ${q(readerName)} LOGIN INHERIT NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1; GRANT reader TO ${q(readerName)} WITH ADMIN FALSE; GRANT reader TO ${q(readerName)} WITH INHERIT TRUE; GRANT reader TO ${q(readerName)} WITH SET TRUE`,
            );
          } finally {
            await end(c);
          }
          value = { data: { name: readerName, role: "reader" } };
        } else if (options.method === "DELETE") {
          counts.delete++;
          check(counts.delete === 1, "production75_operator_local_replay");
          deleted = true;
          value = {};
        } else if (endpoint.endsWith("/credentials")) {
          const user = endpoint.includes(readerName) ? readerName : "fly-user";
          value = { data: { user, password: "local-fixture" } };
        } else if (endpoint.endsWith("/backups"))
          value = {
            data: [
              {
                id: plan.backupId,
                status: "completed",
                type: "full",
                start: new Date(plan.preparedAt - 120000).toISOString(),
                stop: new Date(plan.preparedAt - 60000).toISOString(),
              },
            ],
          };
        else if (endpoint.endsWith("/users"))
          value = { data: [{ name: "fly-user", role: "schema_admin" }] };
        else if (endpoint.endsWith(`/${copyId}`)) {
          if (deleted) return new Response("", { status: 404 });
          value = { data: detailMeta(copyId, plan.copyName) };
        } else
          value = {
            data: [
              meta(plan.sourceCluster, "mogulforge-growthos-db"),
              meta(plan.protectedClusters[1], "growthos-staging", 2),
              ...(copyVisible && !deleted ? [meta(copyId, plan.copyName)] : []),
            ],
          };
        return new Response(JSON.stringify(value), {
          status:
            options.method === "DELETE"
              ? 202
              : options.method === "POST"
                ? 201
                : 200,
        });
      };
      const api = createProduction75V1Client({
        fetchFn,
        getAuthorization: async () => "Bearer local-only-fixture",
        organization: plan.organization,
      });
      let refusalEvidence;
      if (combined && scenario === "normal") {
        const inventory = await api.listClusters();
        let metadataRefused = false,
          nonTargetRefused = false;
        try {
          mergeV1OwnershipEvidence(
            { ...inventory[0], region: "sfo" },
            inventory,
          );
        } catch {
          metadataRefused = true;
        }
        const changedObservation = structuredClone(
          projectLiveReader(before, profile),
        );
        const nonTarget = changedObservation.databases.find(
          (d) => d.name === "growthos_staging",
        ).fingerprints[0];
        nonTarget.digest =
          nonTarget.digest === "f".repeat(32) ? "e".repeat(32) : "f".repeat(32);
        try {
          assertProduction75ReaderDelta({
            before,
            after: changedObservation,
            readerName,
            expectedProfile: profile,
          });
        } catch {
          nonTargetRefused = true;
        }
        check(
          metadataRefused &&
            nonTargetRefused &&
            Object.values(counts).every((n) => n === 0),
          "production75_operator_local_refusal",
        );
        refusalEvidence = {
          kind: "SUPPLIED_METADATA_AND_NATIVE_OBSERVATION_FAULTS",
          metadataRefused,
          nonTargetRefused,
          nativeNonTargetDatabaseMutated: false,
          mutationCountsAtRefusal: { ...counts },
          sourceSnapshotSha256: production75SnapshotDigest(before),
        };
      }
      // Owned local oracle transaction precedes every operator invocation. No hosted SQL oracle.
      const oracleClient = combined ? null : await connect(sourceBox, "fly-db");
      let oracle;
      if (combined) oracle = combinedOracle;
      else
        try {
          await oracleClient.query("BEGIN");
          await oracleClient.query(
            `CREATE ROLE ${q(readerName)} LOGIN INHERIT NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1; GRANT reader TO ${q(readerName)} WITH ADMIN FALSE; GRANT reader TO ${q(readerName)} WITH INHERIT TRUE; GRANT reader TO ${q(readerName)} WITH SET TRUE`,
          );
          await oracleClient.query(
            "SET LOCAL ROLE schema_admin; SET LOCAL search_path=public,pg_catalog",
          );
          const principals = [
              "fly-user",
              "growthos-staging-live",
              "reader",
              readerName,
            ],
            p75 = await captureProduction75Policy(oracleClient, principals);
          for (const step of source.steps.slice(0, 3))
            await oracleClient.query(step.sql);
          const p95 = await captureProduction75Policy(oracleClient, principals);
          for (const step of source.steps.slice(3))
            await oracleClient.query(step.sql);
          const p142 = await captureProduction75Policy(
            oracleClient,
            principals,
          );
          oracle = {
            kind: "OWNED_NATIVE_POLICY_ORACLE",
            sourceCandidate: BASE,
            templateReader: readerName,
            policies: { 75: p75, 95: p95, 142: p142 },
          };
          await oracleClient.query("ROLLBACK");
        } finally {
          await end(oracleClient);
        }
      if (scenario === "normal" && !combined) {
        await writeFile(
          resolve(out, "oracle.json"),
          JSON.stringify(oracle, null, 2) + "\n",
          { flag: "wx" },
        );
        receipt.oracleSha256 = sha(JSON.stringify(oracle));
      }
      let idleErrorHandled = false,
        lostInjected = false;
      const owners = new WeakMap();
      const transport = {
        verifyIdentity: async () => ({
          account: plan.account,
          organization: plan.organization,
        }),
        withSourceCredentials: (fn) =>
          fn({ user: "fly-user", password: "local-fixture" }),
        protectedApps: async () => ({ localProtected: "unchanged" }),
        metadata: () => ({ synthetic: true }),
        openProxy: async (id, resources) => {
          active();
          const b = id === plan.sourceCluster ? sourceBox : copyBox;
          let alive = false;
          const child = new EventEmitter();
          child.pid = 2000 + liveTransports.length;
          child.stdout = { resume() {} };
          child.stderr = { resume() {} };
          child.kill = () => {
            alive = false;
            queueMicrotask(() => child.emit("close", 0));
            return true;
          };
          class DriverClient extends Client {
            constructor(options) {
              super(options);
              clients.push(this);
              this.__reader = options.user === readerName;
            }
            async connect() {
              await super.connect();
              if (
                scenario === "idle-client-error" &&
                id !== plan.sourceCluster &&
                this.__reader
              ) {
                idleErrorHandled = true;
                this.emit("error", new Error("synthetic idle connection loss"));
              }
            }
            async query(...args) {
              active();
              const result = await boundedQuery(
                () => super.query(...args),
                () => this.connection?.stream?.destroy(),
              );
              if (
                scenario === "lost-commit" &&
                id !== plan.sourceCluster &&
                args[0] === "COMMIT" &&
                !lostInjected
              ) {
                lostInjected = true;
                this.emit(
                  "error",
                  new Error("synthetic lost COMMIT connection"),
                );
                throw new Error("synthetic lost COMMIT reply");
              }
              return result;
            }
            async end() {
              try {
                return await super.end();
              } finally {
                this.connection.stream.destroy();
                if (!this.__closed) {
                  this.__closed = true;
                  receipt.cleanup.clients++;
                  receipt.cleanup.sockets++;
                }
              }
            }
          }
          const t = createLiveTransport({
            runFile: async () => plan.account,
            spawnChild: () => {
              alive = true;
              return child;
            },
            readCredentialConfig: async () => `access_token: ${"A".repeat(40)}`,
            choosePort: () => b.port,
            pause: async () => {},
            inspect: async (kind, pid) =>
              kind === "listener"
                ? alive
                  ? [{ pid: child.pid, address: "127.0.0.1" }]
                  : []
                : kind === "children"
                  ? []
                  : alive
                    ? {
                        pid,
                        created: "synthetic",
                        executable: "synthetic-fly",
                      }
                    : null,
            Client: DriverClient,
          });
          liveTransports.push(t);
          await t.verifyIdentity();
          const proxy = await t.openProxy(id, resources);
          owners.set(proxy, t);
          return proxy;
        },
        connect: (p, d, c, options) => owners.get(p).connect(p, d, c, options),
        closeResources: async () => {
          for (const t of liveTransports)
            check(
              (await t.closeResources()).closed,
              "production75_operator_local_cleanup",
            );
          return { closed: true };
        },
        close: async () => {
          for (const t of liveTransports)
            check(
              (await t.close()).closed,
              "production75_operator_local_cleanup",
            );
          return { closed: true };
        },
      };
      const projected = projectLiveReader(before, profile),
        delta = assertProduction75ReaderDelta({
          before,
          after: projected,
          readerName,
          expectedProfile: profile,
        });
      const protectedApps = { localProtected: "unchanged" },
        pricing = {
          status: "verified-applicable-legacy-v1",
          evidenceSha256: "a".repeat(64),
          account: plan.account,
          organization: plan.organization,
          providerVersion: 1,
          plan: "basic",
          region: "iad",
          currency: "USD",
          hourlyUsdMicros: 1,
          meteringQuantumMs: 3600000,
          coveredMs: plan.workMs + plan.cleanupMs,
          maximumUsdMicros: 1,
        };
      const admission = (kind) => ({
        pricingSha256: sha(JSON.stringify(pricing)),
        protectedAppsSha256: sha(JSON.stringify(protectedApps)),
        version: 1,
        kind,
        planSha256: digest,
        issuedAt: plan.preparedAt,
        expiresAt: plan.cleanupUntil,
        sourceSnapshotSha256: plan.sourceSnapshotSha256,
        profileSha256: plan.profileSha256,
        moduleManifestSha256: plan.moduleManifestSha256,
        maxCostUsdMicros: plan.maxCostUsdMicros,
        maxCopies: 1,
        sourceWritesAuthorized: false,
        provenance: {
          type:
            kind === "owner-approval"
              ? "direct-human-priced-approval"
              : "independent-capability-review",
          evidenceSha256: "d".repeat(64),
          reference: "synthetic-local-provenance",
        },
      });
      const deps = {
        transport,
        api,
        source,
        catalogs: {
          fly75: catalog75,
          other75: otherCatalog,
          canonical95,
          canonical142,
        },
        oracle,
        custodyRoot: out,
        manifestSha256: async () =>
          combined
            ? combinedManifestDigest({
                modules: hashes(),
                legacySource,
                schedulingSource: combinedOracle.scheduling.source,
                catalogs: combinedCatalogs,
                oracle: combinedOracle,
                candidate,
              })
            : sha(JSON.stringify(hashes())),
        ...(combined
          ? { candidate, schedulingSource, currentHashes: hashes }
          : {}),
        unprotect: async (blob) =>
          Buffer.from(
            JSON.stringify(
              admission(
                blob[0] === 1
                  ? "owner-approval"
                  : "independent-capability-review",
              ),
            ),
          ),
      };
      const result = await (
        combined ? executeSuppliedCombinedPacket : executeLivePacket
      )(
        deps,
        {
          kind: combined
            ? "UNADMITTED_COMBINED_LIVE_PREPARATION"
            : "UNADMITTED_LIVE_PREPARATION",
          plan,
          planSha256: digest,
          sourceBefore: before,
          protectedApps,
          oracleSha256: sha(JSON.stringify(oracle)),
          capabilities: delta.capabilities,
          pricing,
        },
        { owner: Buffer.alloc(80, 1), review: Buffer.alloc(80, 2) },
      );
      receipt.cases[scenario] = {
        result,
        mutationCounts: counts,
        idleErrorHandled,
        sourceTables: before.databases.map((d) => ({
          name: d.name,
          tables: d.catalog.tables.length,
          rows: d.fingerprints.reduce((a, r) => a + r.rows, 0),
          physicalSha256: catalogDigest(d.catalog, { physical: true }),
        })),
      };
      if (refusalEvidence) {
        const unchanged = await capture(sourceBox);
        refusalEvidence.sourceSnapshotAfterSha256 =
          production75SnapshotDigest(unchanged);
        check(
          refusalEvidence.sourceSnapshotAfterSha256 ===
            refusalEvidence.sourceSnapshotSha256,
          "production75_operator_local_originals",
        );
        receipt.refusalEvidence = refusalEvidence;
      }
      if (combined) {
        const observed = liveTransports
          .slice(transportStart)
          .map((t) => t.metadata());
        const counters = [
          "clients",
          "clientsClosed",
          "socketsClosed",
          "proxies",
          "proxiesClosed",
        ];
        combinedTransportProofs.push(
          Object.fromEntries(
            counters.map((key) => [
              key,
              observed.reduce((sum, t) => sum + t[key], 0),
            ]),
          ),
        );
      }
      check(
        result.status ===
          (scenario === "idle-client-error"
            ? "held-and-cleaned"
            : "verified-and-cleaned") &&
          counts.create === 1 &&
          counts.reader === 1 &&
          counts.delete === 1 &&
          (scenario !== "idle-client-error" ||
            (idleErrorHandled && Object.keys(result.outcomes).length === 0)) &&
          result.resourcesClosed &&
          result.originalsPreserved,
        "production75_operator_local_lifecycle",
      );
      for (const b of [copyBox, sourceBox])
        if (b && !b.__removed) {
          const proof = await (
            combined
              ? cleanupCombinedLocalContainer
              : cleanupProduction75Container
          )(b, async (args, onDispatch) => ({
            output: (await runDocker(args, undefined, onDispatch))
              .toString()
              .trim(),
          }));
          check(proof.containerRemoved, "production75_operator_local_cleanup");
          b.__removed = true;
          if (combined) b.__cleanupEvidence = proof;
          receipt.cleanup.containers++;
        }
    }
  } catch (e) {
    failed = true;
    receipt.failureCode = /^production75_[a-z0-9_]+$/.test(e?.safeCode ?? "")
      ? e.safeCode
      : "production75_operator_local_failure";
    receipt.sqlState = /^[A-Z0-9]{5}$/.test(e.code ?? "") ? e.code : undefined;
  } finally {
    budget?.beginCleanup();
    for (const c of clients.filter((c) => !c.__closed))
      try {
        active();
        await end(c);
      } catch {
        c.connection?.stream?.destroy();
        failed = true;
      }
    for (const b of containers.filter((b) => !b.__removed))
      try {
        const p = await (
          combined
            ? cleanupCombinedLocalContainer
            : cleanupProduction75Container
        )(b, async (args, onDispatch) => ({
          output: (await runDocker(args, undefined, onDispatch))
            .toString()
            .trim(),
        }));
        if (p?.containerRemoved) {
          b.__removed = true;
          if (combined) b.__cleanupEvidence = p;
          receipt.cleanup.containers++;
        } else failed = true;
      } catch {
        failed = true;
      }
    if (combined) {
      try {
        const after = readCombinedLocalVolumeNames(
          (
            await runDocker(["volume", "ls", "--format", "{{.Name}}"])
          ).toString(),
        );
        receipt.storageInventory = {
          before: storageBefore,
          after,
          unchanged: false,
        };
        receipt.storageInventory = assertCombinedLocalStorageInventory(
          storageBefore,
          after,
        );
      } catch {
        failed = true;
        receipt.failureCode ??= "production75_operator_local_storage_inventory";
      }
    }
  }
  receipt.transportProofs = combined
    ? combinedTransportProofs
    : liveTransports.map((t) => t.metadata());
  if (
    receipt.transportProofs.some(
      (t) =>
        t.clients !== t.clientsClosed ||
        t.clients !== t.socketsClosed ||
        t.proxies !== t.proxiesClosed,
    )
  )
    failed = true;
  receipt.moduleHashesAfter = hashes();
  receipt.cleanup.expectedClients = clients.length;
  receipt.cleanup.expectedContainers = containers.length;
  if (
    !isDeepStrictEqual(receipt.moduleHashesBefore, receipt.moduleHashesAfter) ||
    receipt.cleanup.clients !== clients.length ||
    receipt.cleanup.sockets !== clients.length ||
    receipt.cleanup.containers !== containers.length
  )
    failed = true;
  receipt.status = failed ? "FAILED" : "PASS";
  receipt.finishedAt = new Date().toISOString();
  if (combined) {
    receipt.storageMountEvidence = containers.map((b) => ({
      runId: b.runId,
      name: b.name,
      id: b.id,
      ...b.mountEvidence,
    }));
    receipt.containerCleanupEvidence = containers.map((b) => ({
      runId: b.runId,
      attempted: b.__cleanupAttempted === true,
      proof: b.__cleanupEvidence ?? null,
    }));
    receipt.ownedContainers = containers.map((b) => ({
      runId: b.runId,
      name: b.name,
      id: b.id,
      removed: b.__removed === true,
      loopbackOnly: b.loopbackOnly === true,
      storage: b.storage,
    }));
    if (!failed) {
      try {
        check(
          gitText("status", "--porcelain", "--untracked-files=normal") === "" &&
            candidate.commit === gitText("rev-parse", "HEAD") &&
            candidate.tree === gitText("rev-parse", "HEAD^{tree}"),
          "production75_operator_local_candidate_drift",
        );
        Object.assign(
          receipt,
          finalizeCombinedLocalProof({
            proof: { ...receipt, status: "EXECUTED" },
            oracle: combinedOracle,
            currentHashes: receipt.moduleHashesAfter,
            candidate,
          }),
        );
      } catch (e) {
        receipt.status = "FAILED";
        receipt.failureCode =
          e.safeCode ?? "production75_operator_local_finalization";
      }
    }
  }
  await writeFile(
    resolve(out, "native-result.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx" },
  );
  return receipt;
}
async function run(combined = false) {
  const context = {};
  try {
    return await runLocal(combined, context);
  } catch (error) {
    const { receipt, out } = context;
    if (!receipt || !out) throw error;
    // Setup errors occur before any container is created; execution failures
    // already passed through the exact-ownership finally block above.
    receipt.status = "FAILED";
    receipt.failureCode = /^(production75|scheduling0019)_[a-z0-9_]+$/.test(
      error?.safeCode ?? "",
    )
      ? error.safeCode
      : "production75_operator_local_failure";
    receipt.finishedAt = new Date().toISOString();
    if (!existsSync(resolve(out, "native-result.json")))
      await writeFile(
        resolve(out, "native-result.json"),
        JSON.stringify(receipt, null, 2) + "\n",
        { flag: "wx" },
      );
    return receipt;
  }
}
export async function main(args = process.argv.slice(2)) {
  const action = selectLocalAction(args);
  return withWslDockerSession(() => run(action === "combined"));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main()
    .then((r) => {
      console.log(JSON.stringify(r));
      if (r.status !== "PASS") process.exitCode = 1;
    })
    .catch(() => {
      console.error("production75_operator_local_failure");
      process.exitCode = 1;
    });
