import { describe, expect, it, vi } from "vitest";
import {
  assertRestoreDatabaseIdentity,
  restoreModeRequested,
  validateRestoreMode,
} from "./restore-mode";

const env = {
  RESTORE_DRILL_ONLY: "true",
  RESTORE_DRILL_MODE: "managed",
  RESTORE_DRILL_EXPECTED_CLUSTER_ID: "syntheticrestore123",
  FLY_APP_NAME: "mogulforge-growthos-restore-drill",
  APP_ORIGIN: "http://127.0.0.1:3001",
  HOST: "127.0.0.1",
  PORT: "3001",
  AUTO_MIGRATE: "false",
  SCHEDULER_AUTOSTART: "false",
  GROWTHOS_OUTBOUND_HOLD: "true",
  STAGING_OUTBOUND_APPROVED: "false",
  OBJECT_STORAGE_PROVIDER: "postgres",
  SESSION_SECRET: "synthetic-restore-session-only",
  DATABASE_URL:
    "postgresql://growthos-restore-reader:synthetic@pgbouncer.syntheticrestore123.flympg.net/growthos_staging",
};

describe("private restore-only boot identity", () => {
  it("leaves ordinary runtime identity unchanged and accepts a fully guarded restore", () => {
    expect(
      validateRestoreMode({ FLY_APP_NAME: "mogulforge-growthos-staging" }),
    ).toBeNull();
    expect(validateRestoreMode(env)).toEqual({
      clusterId: "syntheticrestore123",
      database: "growthos_staging",
      login: "growthos-restore-reader",
    });
  });
  it("rejects production, original source cluster, writable logins and unpinned target changes", () => {
    for (const DATABASE_URL of [
      env.DATABASE_URL.replace("syntheticrestore123", "kzpwm0j18eg04nv3"),
      env.DATABASE_URL.replace("syntheticrestore123", "zp2wjrejd2zodn4q"),
      env.DATABASE_URL.replace("growthos-restore-reader", "fly-user"),
      env.DATABASE_URL.replace("growthos_staging", "fly-db"),
      env.DATABASE_URL + "?host=production.example",
    ])
      expect(() => validateRestoreMode({ ...env, DATABASE_URL })).toThrow(
        "unsafe",
      );
  });
  it("requires every hold and cannot be bypassed by changing the app or origin", () => {
    for (const changes of [
      { FLY_APP_NAME: "another-app" },
      { APP_ORIGIN: "https://public.example" },
      { RESTORE_DRILL_ONLY: undefined },
      { GROWTHOS_OUTBOUND_HOLD: "false" },
      { STAGING_OUTBOUND_APPROVED: "true" },
      { SCHEDULER_AUTOSTART: "true" },
      { AUTO_MIGRATE: "true" },
      { HOST: "0.0.0.0" },
      { SESSION_SECRET: undefined },
    ])
      expect(() => validateRestoreMode({ ...env, ...changes })).toThrow(
        "unsafe",
      );
    expect(restoreModeRequested({ RESTORE_DRILL_ONLY: "false" })).toBe(true);
  });
  it("rejects provider credentials but permits the original application decryption keys", () => {
    for (const name of [
      "RESEND_API_KEY",
      "TWILIO_AUTH_TOKEN",
      "OPENAI_API_KEY",
      "STRIPE_SECRET_KEY",
      "GOOGLE_CLIENT_SECRET",
      "REPLIT_CONNECTORS_HOSTNAME",
      "SMTP_PASSWORD",
      "EMAIL_INGESTION_WEBHOOK_SECRET",
    ]) {
      expect(() =>
        validateRestoreMode({ ...env, [name]: "credential-present" }),
      ).toThrow("unsafe");
    }
    expect(
      validateRestoreMode({
        ...env,
        OAUTH_TOKEN_ENCRYPTION_KEY: "synthetic-key",
        EMAIL_INTELLIGENCE_ENCRYPTION_KEY: "synthetic-key",
      }),
    ).not.toBeNull();
  });
  it("validates both the actual session and database privileges before allowing startup", async () => {
    const client = {
      query: vi.fn(async (text: string) => ({
        rows: text.includes("current_database")
          ? [{ database: "growthos_staging", login: "growthos-restore-reader" }]
          : [{ can_write: false }],
      })),
    };
    await expect(assertRestoreDatabaseIdentity(client, env)).resolves.toBe(
      true,
    );
    client.query.mockImplementation(async () => ({
      rows: [{ can_write: true }],
    }));
    await expect(assertRestoreDatabaseIdentity(client, env)).rejects.toThrow(
      "session",
    );
    client.query.mockImplementation(async (text: string) => ({
      rows: text.includes("current_database")
        ? [{ database: "growthos_staging", login: "growthos-restore-reader" }]
        : [{ can_write: true }],
    }));
    await expect(assertRestoreDatabaseIdentity(client, env)).rejects.toThrow(
      "read-only privileges",
    );
  });
  it("permits a logical sibling restore but never the source staging database", () => {
    const logical = {
      ...env,
      RESTORE_DRILL_MODE: "logical",
      RESTORE_DRILL_EXPECTED_CLUSTER_ID: "zp2wjrejd2zodn4q",
      DATABASE_URL: env.DATABASE_URL.replace(
        "syntheticrestore123",
        "zp2wjrejd2zodn4q",
      ).replace("growthos_staging", "growthos_restore_drill"),
    };
    expect(validateRestoreMode(logical)?.database).toBe(
      "growthos_restore_drill",
    );
    expect(() =>
      validateRestoreMode({
        ...logical,
        DATABASE_URL: logical.DATABASE_URL.replace(
          "growthos_restore_drill",
          "growthos_staging",
        ),
      }),
    ).toThrow("unsafe");
  });
});
