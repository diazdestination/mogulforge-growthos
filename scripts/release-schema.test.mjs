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

describe("staging release schema gate", () => {
  const env = {
    FLY_APP_NAME: "mogulforge-growthos-staging",
    APP_ORIGIN: "https://mogulforge-growthos-staging.fly.dev",
    DATABASE_URL:
      "postgresql://growthos-staging-live:private-value@pgbouncer.example.test/growthos_staging",
    GROWTHOS_OUTBOUND_HOLD: "true",
  };

  it("requires a reviewed, explicitly approved staging schema push", () => {
    expect(() => assertStagingSchemaPushGate(env)).toThrow(
      "requires reviewed delta",
    );
    expect(() =>
      assertStagingSchemaPushGate({ ...env, STAGING_SCHEMA_PUSH_APPROVED: "true" }),
    ).not.toThrow();
  });

  it("rejects a wrong database, login, or missing outbound hold", () => {
    expect(() =>
      assertStagingSchemaPushGate({
        ...env,
        STAGING_SCHEMA_PUSH_APPROVED: "true",
        DATABASE_URL: env.DATABASE_URL.replace("growthos_staging", "fly-db"),
      }),
    ).toThrow("staging_database_target_mismatch");
    expect(() =>
      assertStagingSchemaPushGate({
        ...env,
        STAGING_SCHEMA_PUSH_APPROVED: "true",
        GROWTHOS_OUTBOUND_HOLD: "false",
      }),
    ).toThrow("outbound safety hold");
  });

  it("does not alter the existing non-staging release path", () => {
    expect(() => assertStagingSchemaPushGate({ FLY_APP_NAME: "mogulforge-growthos" })).not.toThrow();
  });
});
