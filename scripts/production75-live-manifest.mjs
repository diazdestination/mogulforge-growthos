/** Shared full executable dependency coverage. Supplied reads only, import-safe. */
import { createHash } from "node:crypto";
export const PRODUCTION75_RUNTIME_FILES = Object.freeze([
  ...[
    "live-manifest",
    "live-transport",
    "live-observation",
    "live-policy",
    "live-local",
    "live-admission",
    "live-runner",
    "operator",
    "custody",
    "reader-delta",
    "fly-v1",
    "observer",
    "verification",
    "core",
    "legacy-model",
    "source",
    "pins",
    "local",
  ].map((name) => `scripts/production75-${name}.mjs`),
  "scripts/local-dev.mjs",
  "scripts/staging-observation-core.mjs",
  "reports/release-preparation-2026-10-09/schema-catalog.mjs",
  "pnpm-lock.yaml",
  "artifacts/api-server/package.json",
]);
export function production75RuntimeHashes(readText) {
  if (typeof readText !== "function")
    throw new Error("production75_live_manifest");
  return Object.fromEntries(
    PRODUCTION75_RUNTIME_FILES.map((p) => [
      p,
      createHash("sha256")
        .update(readText(p).replaceAll("\r\n", "\n"))
        .digest("hex"),
    ]),
  );
}
