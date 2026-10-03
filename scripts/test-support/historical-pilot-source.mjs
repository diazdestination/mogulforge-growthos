// Unit-test support only. Hosted harness readers NEVER import this module.
// The c050067 attestation is immutable; evolving code must not be relabelled
// as that release. Freeze only the files that diverged, with exact old hashes.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_FILES } from "../hosted-pilot-drill.mjs";
import { IDLE_SOURCE_HASHES } from "../pilot-scheduler-idle.mjs";
import { CRASH_SOURCE_HASHES } from "../pilot-crash-drill.mjs";
import { prepareRuntimePool } from "../pilot-scheduler-probe.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const frozen = new Map([
  [resolve(root, "scripts/restore-drill-fixture.mjs"), "restore-drill-fixture.mjs"],
  [resolve(root, "artifacts/api-server/src/index.ts"), "index.ts"],
  [resolve(root, "artifacts/api-server/src/app.ts"), "app.ts"],
  [resolve(root, "artifacts/api-server/src/services/automation.ts"), "automation.ts"],
  [resolve(root, "artifacts/api-server/src/services/scheduler-runtime.ts"), "scheduler-runtime.ts"],
  [resolve(root, "artifacts/api-server/src/services/reactivation.ts"), "reactivation.ts"],
  [resolve(root, "artifacts/api-server/src/services/durable-execution.ts"), "durable-execution.ts"],
  [resolve(root, "lib/db/src/schema/automations.ts"), "schema-automations.ts"],
  [resolve(root, "lib/db/src/schema/revenue-workspace.ts"), "schema-revenue-workspace.ts"],
]);
export const historicalSourcePath = (path) => frozen.has(path)
  ? fileURLToPath(new URL(`./fixtures/c050067/${frozen.get(path)}.txt`, import.meta.url)) : path;
export const readHistoricalSource = (path, encoding) => readFile(historicalSourcePath(path), encoding);

export async function verifyHistoricalFixtures() {
  const manifest = { ...RELEASE_FILES, ...IDLE_SOURCE_HASHES, ...CRASH_SOURCE_HASHES };
  for (const [relative, expected] of Object.entries(manifest)) {
    const path = resolve(root, relative);
    if (!frozen.has(path)) continue;
    const text = await readHistoricalSource(path, "utf8");
    if (createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex") !== expected)
      throw new Error("historical_pilot_fixture_hash_mismatch");
  }
}

/**
 * Local compatibility test for a HISTORICAL scheduler stage contract and its
 * old reviewed schema. Current scheduler/new-push tests use current source and
 * current schema elsewhere. This is not an attestation of a new image.
 */
export async function loadHistoricalPilotRuntime(kind) {
  if (!["idle", "crash"].includes(kind) || process.env.NODE_ENV !== "test" ||
    new URL(process.env.DATABASE_URL ?? "invalid:").hostname !== "127.0.0.1")
    throw new Error("historical_runtime_requires_test_loopback");
  await verifyHistoricalFixtures();
  const api = resolve(root, "artifacts/api-server");
  const require = createRequire(resolve(api, "package.json"));
  const cache = resolve(api, "node_modules/.cache");
  await mkdir(cache, { recursive: true });
  const folder = await mkdtemp(resolve(cache, "historical-pilot-"));
  const output = resolve(folder, "runtime.cjs");
  const remove = async () => {
    await unlink(output).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(folder);
  };
  try {
    const entry = kind === "idle" ? "pilot-scheduler-idle-runtime.ts" : "pilot-crash-runtime.ts";
    await require("esbuild").build({
      entryPoints: [resolve(root, "scripts", entry)], outfile: output,
      platform: "node", format: "cjs", bundle: true, packages: "external", logLevel: "silent",
      plugins: [{ name: "historical-unit-test-sources-only", setup(builder) {
        builder.onResolve({ filter: /^(@workspace\/|drizzle-zod$)/ },
          (args) => ({ path: require.resolve(args.path, { paths: [args.resolveDir] }) }));
        builder.onLoad({ filter: /\.ts$/ }, async (args) => frozen.has(args.path)
          ? { contents: await readHistoricalSource(args.path, "utf8"), loader: "ts", resolveDir: dirname(args.path) }
          : undefined);
      } }],
    });
    const runtime = require(output);
    prepareRuntimePool(runtime.pool);
    return { ...runtime, async dispose() {
      try { await runtime.pool.end(); }
      finally { delete require.cache[output]; await remove(); }
    } };
  } catch (error) { await remove().catch(() => {}); throw error; }
}
