/** Explicit local-only fake provider with real owned PG16 source/copy SQL. */
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
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
  operatorPlanDigest,
} from "./production75-custody.mjs";
import {
  createProduction75V1Client,
  useProduction75Credentials,
} from "./production75-fly-v1.mjs";
import {
  expectedProduction75ReaderProfile,
  production75ProfileDigest,
  production75SnapshotDigest,
} from "./production75-reader-delta.mjs";
import { EventEmitter } from "node:events";
import { createLiveTransport } from "./production75-live-transport.mjs";
import { captureLiveSnapshot } from "./production75-live-observation.mjs";
import { deriveLivePolicies } from "./production75-live-policy.mjs";
import { executeLivePacket } from "./production75-live-runner.mjs";
import { production75RuntimeHashes } from "./production75-live-manifest.mjs";
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
export function handleOperatorClientErrors(client, onFailure) {
  client.on("error", () => {
    try {
      onFailure();
    } catch {}
  });
  return client;
}
async function docker(args, input) {
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
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("local docker deadline"));
    }, 60000);
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
async function run() {
  const runId = randomUUID(),
    out = resolve(ROOT, "reports/authenticated-driver-2026-10-12", runId);
  await mkdir(out, { recursive: true });
  const receipt = {
    kind: "SYNTHETIC_PROXY_REAL_DRIVER_SQL",
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
  };
  const containers = [],
    clients = [];
  let failed = false;
  const { Client } = createRequire(
    resolve(ROOT, "artifacts/api-server/package.json"),
  )("pg");
  const image = JSON.parse(
    (await docker(["image", "inspect", "postgres:16-alpine"])).toString(),
  )[0];
  check(
    /^sha256:[a-f0-9]{64}$/.test(image.Id),
    "production75_operator_local_image",
  );
  receipt.imageId = image.Id;
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
  async function box() {
    const nonce = randomUUID(),
      owned = {
        runId: nonce,
        name: `production75-local-${process.pid}-${nonce.slice(0, 8)}`,
        id: null,
      };
    containers.push(owned);
    owned.id = (
      await docker([
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
    let ready = false;
    for (let i = 0; i < 45; i++) {
      try {
        await docker([
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
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    check(ready, "production75_operator_local_ready");
    owned.port = parseLoopbackPort(
      (await docker(["port", owned.id, "5432/tcp"])).toString(),
    );
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
      if (resources)
        c.query = async (...args) => {
          resources.assertActive();
          check(!c.__idleFailed, "production75_operator_local_client");
          const value = await query(...args);
          resources.assertActive();
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
  async function initialize(b) {
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
            "ALTER SCHEMA public OWNER TO pg_database_owner; REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE,CREATE ON SCHEMA public TO schema_admin; GRANT USAGE ON SCHEMA public TO PUBLIC",
          );
          if (name === "fly-db")
            await c.query(
              'ALTER DEFAULT PRIVILEGES FOR ROLE "fly-user" IN SCHEMA public GRANT ALL ON TABLES TO schema_admin; ALTER DEFAULT PRIVILEGES FOR ROLE "fly-user" IN SCHEMA public GRANT ALL ON SEQUENCES TO schema_admin',
            );
          if (name !== "mogulforge-growthos-db") {
            await c.query("SET ROLE schema_admin");
            await c.query(
              git(
                `reports/production75-recovery-2026-10-11/fixture75-${name === "fly-db" ? "fly-db" : "growthos_staging"}.sql`,
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
  async function capture(
    b,
    readerName = null,
    selectedNames = ["fly-db", "growthos_staging", "mogulforge-growthos-db"],
    resources = null,
  ) {
    const ownedScope =
      resources ?? createOperatorResources({ until: Date.now() + 600000 });
    let child = null,
      exited = false;
    const fakePid = 1000 + liveTransports.length;
    class DriverClient extends Client {
      constructor(config) {
        super(config);
        clients.push(this);
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
  try {
    for (const scenario of ["normal", "lost-commit", "idle-client-error"]) {
      const sourceBox = await box();
      await initialize(sourceBox);
      const before = await capture(sourceBox),
        caseId = randomUUID(),
        readerName = `growthos_reader_${caseId.replaceAll("-", "")}`,
        profile = expectedProduction75ReaderProfile(readerName),
        manifest = sha(JSON.stringify(receipt.moduleHashesBefore));
      const plan = prepareOperatorPlan({
          runId: caseId,
          backupId: "backup_local_fixture",
          sourceSnapshotSha256: production75SnapshotDigest(before),
          profileSha256: production75ProfileDigest(profile),
          moduleManifestSha256: manifest,
          preparedAt: Date.now(),
          workMs: 600000,
          cleanupMs: 300000,
          maxCostUsdMicros: 150000,
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
      // Build the owned native clone before the bounded fake HTTP response.
      copyBox = await box();
      await roleBase(copyBox);
      for (const name of [
        "fly-db",
        "growthos_staging",
        "mogulforge-growthos-db",
      ]) {
        const dump = await docker([
          "exec",
          sourceBox.id,
          "pg_dump",
          "-U",
          "postgres",
          "--create",
          name,
        ]);
        await docker(
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
          value = { data: meta(copyId, plan.copyName) };
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
          value = { data: meta(copyId, plan.copyName) };
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
      // Owned local oracle transaction precedes every operator invocation. No hosted SQL oracle.
      const oracleClient = await connect(sourceBox, "fly-db");
      let oracle;
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
        const p142 = await captureProduction75Policy(oracleClient, principals);
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
      if (scenario === "normal") {
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
              const result = await super.query(...args);
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
                    ? { pid, created: "synthetic", executable: "synthetic-fly" }
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
        manifestSha256: async () => sha(JSON.stringify(hashes())),
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
      const result = await executeLivePacket(
        deps,
        {
          kind: "UNADMITTED_LIVE_PREPARATION",
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
          const proof = await cleanupProduction75Container(b, async (args) => ({
            output: (await docker(args)).toString().trim(),
          }));
          check(proof.containerRemoved, "production75_operator_local_cleanup");
          b.__removed = true;
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
    for (const c of clients.filter((c) => !c.__closed))
      try {
        await end(c);
      } catch {
        c.connection?.stream?.destroy();
        failed = true;
      }
    for (const b of containers.filter((b) => !b.__removed))
      try {
        const p = await cleanupProduction75Container(b, async (args) => ({
          output: (await docker(args)).toString().trim(),
        }));
        if (p.containerRemoved) {
          b.__removed = true;
          receipt.cleanup.containers++;
        } else failed = true;
      } catch {
        failed = true;
      }
  }
  receipt.transportProofs = liveTransports.map((t) => t.metadata());
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
  await writeFile(
    resolve(out, "native-result.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx" },
  );
  return receipt;
}
export async function main(args = process.argv.slice(2)) {
  check(
    args.length === 1 && args[0] === "--run-local",
    "production75_operator_local_action",
  );
  return withWslDockerSession(run);
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
