import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertStagingSchemaPushGate,
  detectSchemaPushFailure,
} from "./release-schema.mjs";

describe("release schema output guard", () => {
  it("accepts ordinary successful drizzle output", () => {
    expect(
      detectSchemaPushFailure(
        "[✓] Pulling schema from database...\nChanges applied",
      ),
    ).toBeNull();
  });

  it("detects a database error even when drizzle exits successfully", () => {
    expect(
      detectSchemaPushFailure(
        "\u001b[34minfo\u001b[0m error: insert or update violates foreign key constraint",
      ),
    ).toBe("database error reported by drizzle-kit");
  });

  it("detects the PostgreSQL error object emitted by drizzle", () => {
    expect(detectSchemaPushFailure("severity: 'ERROR',\ncode: '23503'")).toBe(
      "PostgreSQL reported ERROR severity",
    );
  });
});

const refusal =
  "Automatic schema reconciliation is retired. Use the reviewed SQL, exact source and target, and approved recovery procedure.";
const approvalFlags = {
  STAGING_SCHEMA_PUSH_APPROVED: "true",
  PRODUCTION_SCHEMA_PUSH_APPROVED: "true",
  SCHEMA_PUSH_APPROVED: "true",
  GROWTHOS_OUTBOUND_HOLD: "true",
};
const scenarios = [
  { name: "missing identity", env: {} },
  {
    name: "production",
    env: {
      FLY_APP_NAME: "mogulforge-growthos",
      APP_ORIGIN: "https://app.mogulforge.ai",
    },
  },
  {
    name: "staging",
    env: {
      FLY_APP_NAME: "mogulforge-growthos-staging",
      APP_ORIGIN: "https://mogulforge-growthos-staging.fly.dev",
    },
  },
  {
    name: "unknown hosted identity",
    env: {
      FLY_APP_NAME: "renamed-production",
      APP_ORIGIN: "https://unknown.example.invalid",
    },
  },
  {
    name: "contradictory identity",
    env: {
      FLY_APP_NAME: "mogulforge-growthos",
      APP_ORIGIN: "https://mogulforge-growthos-staging.fly.dev",
    },
  },
  {
    name: "local-looking identity",
    env: { NODE_ENV: "test", APP_ORIGIN: "http://localhost:18080" },
  },
];

// A regression cannot actually start a schema tool or a database connection.
// The CLI runs with a synthetic environment and this guard installed first.
const ioGuard = `
  import childProcess from "node:child_process";
  import net from "node:net";
  import { syncBuiltinESMExports } from "node:module";
  const forbidden = () => {
    process.stderr.write("FORBIDDEN_RELEASE_SIDE_EFFECT\\n");
    throw new Error("FORBIDDEN_RELEASE_SIDE_EFFECT");
  };
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    childProcess[name] = forbidden;
  net.Socket.prototype.connect = forbidden;
  syncBuiltinESMExports();
`;

describe("retired generic schema release command", () => {
  it.each(scenarios)(
    "refuses $name regardless of approval flags",
    ({ env }) => {
      expect(() => assertStagingSchemaPushGate(env)).toThrow(refusal);
      expect(() =>
        assertStagingSchemaPushGate({ ...env, ...approvalFlags }),
      ).toThrow(refusal);
    },
  );

  it.each(scenarios)(
    "exits unsuccessfully for $name before any child or database access",
    ({ env }) => {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          `data:text/javascript,${encodeURIComponent(ioGuard)}`,
          fileURLToPath(new URL("./release-schema.mjs", import.meta.url)),
        ],
        {
          encoding: "utf8",
          timeout: 5000,
          env: {
            ...(process.env.SystemRoot
              ? { SystemRoot: process.env.SystemRoot }
              : {}),
            ...env,
            ...approvalFlags,
            DATABASE_URL:
              "postgresql://synthetic:RELEASE_CANARY@database.example.invalid/synthetic",
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe(`Schema release refused: ${refusal}`);
      expect(result.stderr).not.toContain("FORBIDDEN_RELEASE_SIDE_EFFECT");
      expect(result.stderr).not.toContain("RELEASE_CANARY");
    },
  );
});
