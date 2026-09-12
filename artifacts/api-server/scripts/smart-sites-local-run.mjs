/** Isolated local verification only. Never inherits provider keys or a production DB. */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const mode = process.argv[2];
if (!["api", "test"].includes(mode))
  throw new Error("Usage: node scripts/smart-sites-local-run.mjs api|test");
const env = {};
for (const key of [
  "PATH",
  "SystemRoot",
  "windir",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
]) {
  if (process.env[key]) env[key] = process.env[key];
}
Object.assign(env, {
  DATABASE_URL:
    "postgresql://postgres:local-smart-sites-only@127.0.0.1:55432/mogulforge_smart_sites_test",
  SESSION_SECRET: "local-smart-sites-preview-only-never-production",
  NODE_ENV: mode === "test" ? "test" : "development",
  PORT: "3001",
  HOST: "127.0.0.1",
  APP_ORIGIN: "http://127.0.0.1:5173",
  OBJECT_STORAGE_PROVIDER: "postgres",
  LOG_LEVEL: mode === "test" ? "silent" : "warn",
  AUTO_MIGRATE: "false",
});
const tests = [
  "src/routes/v1/client-onboarding.test.ts",
  "src/routes/v1/onboarding-org.test.ts",
  "src/routes/v1/route-inventory.test.ts",
  "src/routes/v1/smart-sites.test.ts",
  "src/routes/v1/capture.test.ts",
  "src/services/tenant-isolation.test.ts",
  "src/routes/v1/tenant-list-scoping.test.ts",
  "src/services/attribution.test.ts",
  "src/services/next-best-action.test.ts",
];
const args =
  mode === "api"
    ? ["dist/index.mjs"]
    : ["node_modules/vitest/vitest.mjs", "run", ...tests];
const child = spawn(process.execPath, args, {
  cwd: apiRoot,
  env,
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
