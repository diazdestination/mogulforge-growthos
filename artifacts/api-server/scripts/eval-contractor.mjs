/**
 * Launcher for the contractor eval harness (src/evals/contractor-eval-runner.ts).
 * Bundles the TypeScript entry with the existing esbuild configuration into a
 * disposable directory, runs it with the dataset/results paths, then removes
 * the bundle. Live model calls happen only with an explicit `--live` and an
 * OPENAI_API_KEY; the runner itself refuses live runs under CI.
 *
 *   pnpm --filter @workspace/api-server run eval:contractor -- --check
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAll } from "../build.mjs";

const artifactRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forwarded = process.argv.slice(2).filter((arg) => arg !== "--");
if (forwarded.length === 0) forwarded.push("--check");
if (forwarded.includes("--dataset") || forwarded.includes("--results")) {
  console.error("--dataset and --results are fixed by the launcher.");
  process.exit(2);
}

const output = await mkdtemp(join(artifactRoot, ".eval-contractor-"));
if (dirname(output) !== artifactRoot || !basename(output).startsWith(".eval-contractor-")) {
  throw new Error("eval_build_path_invalid");
}
let code = 1;
try {
  await buildAll({ entryPoint: join(artifactRoot, "src/evals/contractor-eval-runner.ts"), outDir: output });
  code = await new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--enable-source-maps",
        join(output, "contractor-eval-runner.mjs"),
        "--dataset",
        join(artifactRoot, "evals/contractor"),
        "--results",
        join(artifactRoot, "evals/results"),
        ...forwarded,
      ],
      {
        cwd: artifactRoot,
        stdio: "inherit",
        env: { ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? "silent", NODE_ENV: process.env.NODE_ENV ?? "production" },
      },
    );
    child.once("error", reject);
    child.once("exit", (exitCode) => done(exitCode ?? 1));
  });
} finally {
  await rm(output, { recursive: true, force: true });
}
process.exit(code);
