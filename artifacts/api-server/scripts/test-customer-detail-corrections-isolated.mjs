// Local native PostgreSQL QA only. No .env, existing database, provider configuration or arguments.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, openSync, writeFileSync, fsyncSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { detectSchemaPushFailure } from "../../../scripts/release-schema.mjs";

const DOCKER = "C:/Program Files/Docker/Docker/resources/bin/docker.exe";
const HOST = "npipe:////./pipe/dockerDesktopLinuxEngine";
const IMAGE = "sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea";
const PLATFORM_IMAGE = "sha256:1a66d744c1b459e13b05a8fca341da84cb63383e99ce262210efee5a319d4551";
const runtimeImageAllowed = value => value === IMAGE || value === PLATFORM_IMAGE;
const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(api, "../..");
const database = path.join(repo, "lib/db");
const tests = [
  "src/services/customer-detail-correction-contract.test.ts",
  "src/services/customer-detail-corrections.test.ts",
  "src/routes/v1/customer-detail-corrections.test.ts",
  "src/routes/v1/route-inventory.test.ts",
  "src/routes/v1/contacts-search-scope.test.ts",
  "src/services/customer-workspace.test.ts",
  "src/routes/v1/customer-workspace.test.ts",
];
const osEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|TEMP|TMP|PATHEXT|COMSPEC)$/i.test(key)));
class QaError extends Error { constructor(code) { super(code); this.code = code; } }
const need = (value, code) => { if (!value) throw new QaError(code); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function main() {
  const runId = randomUUID(), nonce = randomBytes(32).toString("hex"), name = `growthos-detail-tests-${runId}`;
  const password = randomBytes(24).toString("hex"); // Synthetic disposable credential only; never included in receipt.
  const children = new Set(), pgClosures = []; let aborted = false, createAttempted = false, id = null, port = null, testExit = null, failure = null;
  const receipt = { kind: "LOCAL_CUSTOMER_DETAIL_NATIVE_PG_QA", runId, startedAt: new Date().toISOString(), nativePostgres: false, image: IMAGE, containerId: null, containerName: name, taskNonce: nonce, port: null, selectedTests: tests, schemaPrepared: false, testExit: null, cleanup: { removed: false, idAbsent: false, portVacant: false, ownershipUnknown: false }, status: "UNCONFIRMED", providerOrHostedAcceptance: false, credentialPersisted: false };
  const receiptPath = path.join(repo, "reports", `customer-detail-corrections-local-${runId}.json`);
  const redact = text => text.replaceAll(password, "[synthetic-credential-redacted]");
  const cancel = () => { aborted = true; for (const child of children) try { child.kill(); } catch {} };
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  function save() { writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" }); }
  async function command(file, args, { cwd = repo, env = osEnv(), timeout = 20000, output = false, allowFailure = false, cleanup = false, cap = 16 * 1024 * 1024 } = {}) {
    need(cleanup || !aborted, "CANCELLED");
    return new Promise((resolve, reject) => {
      let child, timer, drainTimer, settled = false, exit = null, closed = false, fault = null, count = 0, stdout = "", stderr = "";
      const kill = code => { fault ??= code; try { child?.kill(); } catch {} if (!drainTimer) drainTimer = setTimeout(() => { if (!settled) { settled = true; clearTimeout(timer); reject(new QaError("CHILD_CLOSURE_UNKNOWN")); } }, 2000); };
      try {
        child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); children.add(child);
        timer = setTimeout(() => kill("CHILD_TIMEOUT"), timeout);
        for (const [stream, label] of [[child.stdout, "stdout"], [child.stderr, "stderr"]]) stream.on("data", buffer => {
          if (settled) { buffer.fill(0); return; } count += buffer.length; if (count > cap) { buffer.fill(0); kill("CHILD_OUTPUT_CAP"); return; }
          const text = redact(buffer.toString("utf8")); buffer.fill(0);
          if (label === "stdout") stdout += text; else stderr += text;
          if (output) (label === "stdout" ? process.stdout : process.stderr).write(text);
        });
        child.once("error", () => kill("CHILD_START_UNKNOWN")); child.once("exit", code => { exit = code; });
        child.once("close", () => { closed = true; clearTimeout(timer); clearTimeout(drainTimer); children.delete(child); if (settled) return; settled = true; if (fault || !Number.isInteger(exit) || (!allowFailure && exit !== 0)) reject(new QaError(fault ?? "CHILD_EXIT_UNKNOWN")); else resolve({ code: exit, stdout, stderr, closed }); });
      } catch { clearTimeout(timer); if (child) children.delete(child); reject(new QaError("CHILD_START_UNKNOWN")); }
    });
  }
  const docker = (args, options) => command(DOCKER, ["-H", HOST, ...args], { cap: 262144, ...options });
  const inspectFormat = '{{json .Id}}|{{json .Name}}|{{json .Image}}|{{json .Config.Labels}}|{{json .NetworkSettings.Ports}}|{{json .HostConfig.PortBindings}}|{{json .HostConfig.Tmpfs}}|{{json .Mounts}}|{{json .Config.Image}}';
  async function inspect({ running = false, cleanup = false } = {}) {
    need(typeof id === "string" && /^[a-f0-9]{64}$/.test(id), "CONTAINER_ID_UNKNOWN");
    const result = await docker(["container", "inspect", "--format", inspectFormat, id], { cleanup });
    const parts = result.stdout.trim().split("|"); need(parts.length === 9, "CONTAINER_INSPECTION_UNKNOWN");
    let values; try { values = parts.map(value => JSON.parse(value)); } catch { throw new QaError("CONTAINER_INSPECTION_UNKNOWN"); }
    const [actualId, actualName, image, labels, ports, bindings, tmpfs, mounts, requestedImage] = values;
    need(actualId === id && actualName === "/" + name && runtimeImageAllowed(image) && requestedImage === IMAGE && labels?.["growthos.detail.task"] === nonce && labels?.["growthos.detail.run"] === runId, "CONTAINER_OWNERSHIP_UNKNOWN");
    if (cleanup) return; // Cleanup requires positive immutable ownership, not a valid SQL/storage setup.
    need(bindings && Object.keys(bindings).length === 1 && Array.isArray(bindings["5432/tcp"]) && bindings["5432/tcp"].length === 1 && bindings["5432/tcp"][0].HostIp === "127.0.0.1", "CONTAINER_BINDING_UNKNOWN");
    need(tmpfs && Object.keys(tmpfs).length === 1 && tmpfs["/var/lib/postgresql/data"] === "rw,noexec,nosuid,size=256m" && Array.isArray(mounts) && mounts.every(m => m.Type === "tmpfs" && m.Destination === "/var/lib/postgresql/data"), "CONTAINER_STORAGE_UNKNOWN");
    if (running) {
      need(ports && Object.keys(ports).length === 1 && Array.isArray(ports["5432/tcp"]) && ports["5432/tcp"].length === 1, "CONTAINER_PORT_UNKNOWN");
      const bound = ports["5432/tcp"][0]; need(bound.HostIp === "127.0.0.1" && /^[1-9][0-9]{0,4}$/.test(bound.HostPort), "CONTAINER_PORT_UNKNOWN");
      const measured = Number(bound.HostPort); need(measured <= 65535 && (port === null || port === measured), "CONTAINER_PORT_CHANGED"); port = measured; receipt.port = port;
    }
  }
  async function pgQuery(text, values = [], absoluteEnd = performance.now() + 2000) {
    need(!aborted && port !== null && performance.now() < absoluteEnd, "DATABASE_NOT_OWNED");
    const client = new pg.Client({ host: "127.0.0.1", port, database: "detail_synthetic", user: "detail_synthetic", password, connectionTimeoutMillis: 2000, query_timeout: 2000, statement_timeout: 2000 });
    const closure = { closed: false }; pgClosures.push(closure);
    const socket = client.connection.stream; const closed = new Promise(resolve => socket.once("close", () => { closure.closed = true; resolve(); }));
    let timer, drain;
    try {
      return await Promise.race([(async () => { await client.connect(); need(!aborted && performance.now() < absoluteEnd, "PG_QUERY_DEADLINE"); const result = await client.query(text, values); need(performance.now() < absoluteEnd, "PG_QUERY_DEADLINE"); return result; })(), new Promise((_, reject) => { timer = setTimeout(() => { socket.destroy(); reject(new QaError("PG_QUERY_DEADLINE")); }, Math.max(1, absoluteEnd - performance.now())); })]);
    } finally {
      clearTimeout(timer);
      const disposal = Promise.resolve().then(() => client.end()).catch(() => { socket.destroy(); });
      await Promise.race([Promise.all([disposal, closed]), new Promise(resolve => { drain = setTimeout(() => { socket.destroy(); resolve(); }, 2000); })]); clearTimeout(drain);
    }
  }  async function vacant() {
    if (port === null) return false;
    return new Promise(resolve => { const server = createServer(); let settled = false; const timer = setTimeout(() => { if (!settled) { settled = true; server.close(); resolve(false); } }, 2000); server.once("error", () => { if (!settled) { settled = true; clearTimeout(timer); resolve(false); } }); server.listen({ host: "127.0.0.1", port, exclusive: true }, () => { server.close(() => { if (!settled) { settled = true; clearTimeout(timer); resolve(true); } }); }); });
  }
  try {
    need(process.argv.length === 2 && process.execArgv.length === 0 && process.platform === "win32", "RUNNER_INVOCATION_REFUSED");
    need(process.env.DATABASE_URL === undefined, "EXISTING_DATABASE_REFUSED");
    need(![repo, api, database].some(dir => [".env", ".env.local", ".env.test", ".env.test.local", ".env.development", ".env.development.local"].some(file => existsSync(path.join(dir, file)))), "DOTENV_PRESENT_REFUSED");
    const image = await docker(["image", "inspect", "--format", '{{.Id}}|{{.Architecture}}|{{.Os}}', IMAGE]);
    const imageFields = image.stdout.trim().split("|");
    need(imageFields.length === 3 && runtimeImageAllowed(imageFields[0]) && imageFields[1] === "amd64" && imageFields[2] === "linux", "CACHED_IMAGE_REFUSED");
    // Public native-local intent is durable BEFORE the first Docker CREATE attempt.
    // It contains no password/URL/Config.Env, and is not automatic cleanup authority.
    const createIntent = { kind: "LOCAL_DETAIL_QA_CREATE_INTENT", runId, taskNonce: nonce, containerName: name, requestedImage: IMAGE, dockerHost: HOST, loopbackHost: "127.0.0.1", containerPort: 5432, hostPortRequest: "ephemeral", tmpfsPath: "/var/lib/postgresql/data", tmpfsBytes: 268435456, database: "detail_synthetic", databaseUser: "detail_synthetic", runnerPid: process.pid, earliestPossibleDispatchAt: Date.now(), credentialPersisted: false, mayRetry: false };
    const intentText = JSON.stringify(createIntent) + "\n";
    const intentPath = path.join(repo, "reports", `customer-detail-corrections-local-${runId}.intent.json`);
    const intentFd = openSync(intentPath, "wx");
    try { writeFileSync(intentFd, intentText); fsyncSync(intentFd); } finally { closeSync(intentFd); }
    receipt.createIntent = { path: intentPath, sha256: createHash("sha256").update(intentText).digest("hex"), earliestPossibleDispatchAt: createIntent.earliestPossibleDispatchAt, runnerPid: process.pid };
    createAttempted = true;
    const created = await docker(["create", "--pull=never", "--platform", "linux/amd64", "--name", name, "--label", `growthos.detail.task=${nonce}`, "--label", `growthos.detail.run=${runId}`, "--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=256m", "--env", "PGDATA=/var/lib/postgresql/data", "--env", "POSTGRES_DB=detail_synthetic", "--env", "POSTGRES_USER=detail_synthetic", "--env", `POSTGRES_PASSWORD=${password}`, IMAGE]);
    id = created.stdout.trim(); need(/^[a-f0-9]{64}$/.test(id), "CREATE_ID_UNKNOWN"); receipt.containerId = id;
    const creationFd = openSync(path.join(repo, "reports", `customer-detail-corrections-local-${runId}.creation.json`), "wx");
    try { writeFileSync(creationFd, JSON.stringify({ kind: "LOCAL_DETAIL_QA_CREATED_ID", runId, containerId: id, containerName: name, taskNonce: nonce, image: IMAGE, started: false, credentialPersisted: false }) + "\n"); fsyncSync(creationFd); } finally { closeSync(creationFd); }
    // Returned ID is retained before start; no name-only adoption or cleanup.
    await inspect(); await docker(["start", id]); await inspect({ running: true });
    const readyEnds = performance.now() + 30000; let ready = false;
    while (!ready && performance.now() < readyEnds) { need(!aborted, "CANCELLED"); try { const r = await pgQuery("SELECT current_database() AS database, current_user AS principal, current_setting('server_version_num')::int AS version, version() AS implementation", [], readyEnds); const row = r.rows[0]; need(row?.database === "detail_synthetic" && row.principal === "detail_synthetic" && row.version >= 160000 && row.version < 170000 && /^PostgreSQL 16\./.test(row.implementation), "NATIVE_PG_IDENTITY_REFUSED"); ready = true; receipt.nativePostgres = true; receipt.serverVersionNum = row.version; } catch { await sleep(150); } }
    need(ready && performance.now() < readyEnds, "NATIVE_PG_READINESS_UNKNOWN");
    await inspect({ running: true });
    const env = { ...osEnv(), NODE_ENV: "test", DATABASE_URL: `postgresql://detail_synthetic:${password}@127.0.0.1:${port}/detail_synthetic`, SESSION_SECRET: "synthetic-detail-test-session-never-deploy", APP_ORIGIN: "https://growth.example", OBJECT_STORAGE_PROVIDER: "postgres", DETAIL_CORRECTION_TEST_BACKEND: "native-postgresql", LOG_LEVEL: "silent", NO_COLOR: "1" };
    const schema = await command(process.execPath, [path.join(database, "node_modules/drizzle-kit/bin.cjs"), "push", "--force", "--config", "drizzle.config.ts"], { cwd: database, env, timeout: 180000, output: true });
    need(!detectSchemaPushFailure(schema.stdout + schema.stderr) && (schema.stdout + schema.stderr).includes("Changes applied"), "SCHEMA_PUSH_UNCONFIRMED");
    const core = await pgQuery("SELECT to_regclass('public.contacts') IS NOT NULL AND to_regclass('public.properties') IS NOT NULL AND to_regclass('public.users') IS NOT NULL AND to_regclass('public.audit_events') IS NOT NULL AS ready"); need(core.rows[0]?.ready === true, "SCHEMA_TABLES_MISSING"); receipt.schemaPrepared = true;
    const tested = await command(process.execPath, [path.join(api, "node_modules/vitest/vitest.mjs"), "run", "--pool=threads", "--maxWorkers", "1", "--no-file-parallelism", ...tests], { cwd: api, env, timeout: 300000, output: false, allowFailure: true });
    testExit = tested.code; receipt.testExit = testExit;
    // Redact the COMPLETE joined output again: a synthetic password can straddle stream chunks.
    const testLog = redact(tested.stdout + "\n" + tested.stderr);
    const testLogBytes = Buffer.byteLength(testLog);
    need(testLogBytes <= 16 * 1024 * 1024, "TEST_LOG_CAP");
    const testLogPath = path.join(repo, "reports", `customer-detail-corrections-local-${runId}.vitest.log`);
    const testLogFd = openSync(testLogPath, "wx");
    try { writeFileSync(testLogFd, testLog); fsyncSync(testLogFd); } finally { closeSync(testLogFd); }
    receipt.testLog = { path: testLogPath, sha256: createHash("sha256").update(testLog).digest("hex"), bytes: testLogBytes, credentialRedacted: true, syntheticOnly: true };
    need(testExit === 0 && tested.closed, "TESTS_FAILED");
  } catch (error) { failure = error instanceof QaError ? error.code : "RUNNER_UNKNOWN"; }
  finally {
    if (id && /^[a-f0-9]{64}$/.test(id)) {
      try {
        await inspect({ cleanup: true }); // Exact returned ID+name+nonce+image only; never adopt by name.
        await docker(["rm", "-f", id], { cleanup: true }); receipt.cleanup.removed = true;
        const missing = await docker(["container", "inspect", "--format", "{{.Id}}", id], { cleanup: true, allowFailure: true });
        const message = missing.stderr.trim(); receipt.cleanup.idAbsent = missing.code === 1 && missing.stdout.trim() === "" && ["Error: No such object: " + id, "Error response from daemon: No such container: " + id].includes(message);
        receipt.cleanup.portVacant = await vacant();
      } catch { receipt.cleanup.ownershipUnknown = true; }
    } else if (createAttempted) receipt.cleanup.ownershipUnknown = true;
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    receipt.endedAt = new Date().toISOString(); receipt.code = failure ?? (aborted ? "CANCELLED" : "LOCAL_QA_COMPLETE");
    receipt.remainingDirectChildren = children.size;
    receipt.pgConnectionsClosed = pgClosures.every(item => item.closed);
    receipt.status = !failure && !aborted && children.size === 0 && receipt.pgConnectionsClosed && testExit === 0 && receipt.cleanup.removed && receipt.cleanup.idAbsent && receipt.cleanup.portVacant ? "PASS" : "UNCONFIRMED";
    try { save(); console.log(JSON.stringify({ kind: receipt.kind, status: receipt.status, code: receipt.code, receiptPath })); } catch { console.error("LOCAL_QA_RECEIPT_UNKNOWN"); receipt.status = "UNCONFIRMED"; }
    if (receipt.status !== "PASS") process.exitCode = 1;
  }
  return Object.freeze(receipt);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
