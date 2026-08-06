// Optional schema push at boot.
//
// The canonical way to apply the schema is fly.toml's `release_command`, which
// runs drizzle-kit push on a temp machine before the new version goes live.
// That's the right place for it — but it only happens on deploy paths that
// actually carry our fly.toml. Fly's dashboard "launch from GitHub" flow can
// regenerate config and silently drop `[deploy]`, which deploys an app against
// an EMPTY database: the landing page renders, then every API call 500s.
//
// AUTO_MIGRATE=true closes that gap — the app pushes its own schema on startup,
// so any deploy path converges on a correct database. It stays OFF by default
// because migrating from inside the serving process is not what you want once
// there are real tenants and real data.
//
// Safe to leave on for a single-machine beta; prefer release_command after that.

import { spawn } from "node:child_process";
import path from "node:path";
import { pool } from "@workspace/db";
import { logger } from "./logger";

// Arbitrary but STABLE app-wide key. Every booting machine contends on this
// one lock, so only one runs drizzle-kit at a time.
const ADVISORY_LOCK_KEY = 4207120260806;

const MIGRATE_TIMEOUT_MS = 5 * 60 * 1000;

function isEnabled(): boolean {
  const raw = process.env["AUTO_MIGRATE"]?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Repo root, from which the db package is addressable by pnpm filter.
 * In the production image WORKDIR is /app/artifacts/api-server, so ../.. is /app.
 */
function migrateCwd(): string {
  return process.env["MIGRATE_CWD"] ?? path.resolve(process.cwd(), "../..");
}

/** Runs the same command as fly.toml's release_command. */
function pushSchema(cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      ["--filter", "@workspace/db", "exec", "drizzle-kit", "push", "--force"],
      { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] },
    );

    let output = "";
    child.stdout?.on("data", (c: Buffer) => (output += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (output += c.toString()));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Schema push timed out after ${MIGRATE_TIMEOUT_MS}ms`));
    }, MIGRATE_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        logger.info({ output: output.trim() }, "Auto-migrate: schema push complete");
        resolve();
      } else {
        reject(new Error(`drizzle-kit push exited ${code}: ${output.trim()}`));
      }
    });
  });
}

/**
 * No-op unless AUTO_MIGRATE is set. Throws on failure — the caller should abort
 * startup rather than serve traffic against a half-applied schema.
 */
export async function runAutoMigrate(): Promise<void> {
  if (!isEnabled()) return;

  const cwd = migrateCwd();
  logger.info({ cwd }, "Auto-migrate: enabled, acquiring lock");

  // A dedicated client: pg advisory locks are session-scoped, so the lock and
  // the unlock must run on the same connection (a pool round-robin would leak it).
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    await pushSchema(cwd);
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY])
      .catch((err: unknown) =>
        logger.error({ err }, "Auto-migrate: releasing advisory lock failed"),
      );
    client.release();
  }
}
