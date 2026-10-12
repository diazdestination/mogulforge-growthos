import { createRequire } from "node:module";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { tsImport } from "tsx/esm/api";
import {
  FAKE_REFRESH_TOKEN,
  fixtureIds,
  seedRestoreFixture,
} from "./restore-drill-fixture.mjs";
import { verifyRestoreFixture } from "./restore-drill-acceptance.mjs";
import { runRestoreDrillReadOnly } from "./restore-drill-readonly.mjs";

const requireFromApi = createRequire(
  new URL("../artifacts/api-server/package.json", import.meta.url),
);
const requireFromDb = createRequire(
  new URL("../lib/db/package.json", import.meta.url),
);
const { PGlite } = requireFromApi("@electric-sql/pglite");
// The current schema has a pgvector column; open working copies with it loaded.
const { createVectorPGlite } = await import(
  new URL("../artifacts/api-server/scripts/pglite-vector.mjs", import.meta.url).href,
);
const { generateDrizzleJson, generateMigration } =
  requireFromDb("drizzle-kit/api");
const key = Buffer.alloc(32, 47).toString("base64");
const slug = "restore-drill-integration-a";

function environment(login = "growthos-staging-live", fixtureSlug = slug) {
  return {
    RESTORE_DRILL_MODE: "source",
    RESTORE_DRILL_DATABASE_URL: `postgresql://${login}:synthetic-never-connect@pgbouncer.zp2wjrejd2zodn4q.flympg.net/growthos_staging`,
    RESTORE_DRILL_EXPECTED_LOGIN: login,
    RESTORE_DRILL_SYNTHETIC_SLUG: fixtureSlug,
    RESTORE_DRILL_SEED_APPROVED: "true",
    GROWTHOS_OUTBOUND_HOLD: "true",
    STAGING_OUTBOUND_APPROVED: "false",
    SCHEDULER_AUTOSTART: "false",
    OAUTH_TOKEN_ENCRYPTION_KEY: key,
  };
}

describe("synthetic restore fixture against current PostgreSQL schema", () => {
  let pg;
  const output = [];
  const client = (login) => ({
    async connect() {
      await pg.exec(`SET SESSION AUTHORIZATION "${login}"`);
    },
    query: (sql, params) => pg.query(sql, params),
    async end() {
      await pg.exec("SET SESSION AUTHORIZATION postgres");
    },
  });
  const options = (login) => ({
    createClient: () => client(login),
    emit: (line) => output.push(line),
  });

  beforeAll(async () => {
    // No environment database/provider/hosting credentials are read or used.
    const bootstrap = await PGlite.create();
    let initial;
    try {
      await bootstrap.exec(
        'CREATE ROLE "growthos-staging-live" LOGIN SUPERUSER',
      );
      await bootstrap.exec(
        'CREATE DATABASE growthos_staging OWNER "growthos-staging-live"',
      );
      initial = await bootstrap.dumpDataDir();
    } finally {
      await bootstrap.close();
    }
    pg = await createVectorPGlite({
      loadDataDir: initial,
      database: "growthos_staging",
    });
    const schema = await tsImport(
      "../lib/db/src/schema/index.ts",
      import.meta.url,
    );
    const statements = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson(schema),
    );
    await pg.exec(statements.join(";\n"));
    await pg.exec(
      'CREATE ROLE "growthos-restore-reader" LOGIN; GRANT USAGE ON SCHEMA public TO "growthos-restore-reader"; GRANT SELECT ON ALL TABLES IN SCHEMA public TO "growthos-restore-reader";',
    );
  }, 60000);

  afterAll(async () => {
    await pg?.close();
  });

  it("creates every required FK-linked record, real encrypted fake credential and inert private media", async () => {
    const result = await seedRestoreFixture(
      environment(),
      options("growthos-staging-live"),
    );
    expect(result.inserted).toBe(true);
    expect(result.recordCount).toBe(19);
    expect(result.credentialDecryptVerified).toBe(true);
    expect(result.wrongKeyRejected).toBe(true);
    expect(result.wrongContextRejected).toBe(true);
    expect(result.fixtureOutboundInert).toBe(true);
    expect(result.providerCalled).toBe(false);
    const token = await pg.query(
      "SELECT encrypted_refresh_token FROM gmail_connections WHERE id = $1",
      [fixtureIds(slug).gmail],
    );
    expect(token.rows[0].encrypted_refresh_token).toMatch(/^v1\./);
    expect(token.rows[0].encrypted_refresh_token).not.toContain(
      FAKE_REFRESH_TOKEN,
    );
  });

  it("is idempotent without changing ciphertext, timestamps, receipt trail or fingerprint", async () => {
    const reader = environment("growthos-restore-reader");
    const baseline = await runRestoreDrillReadOnly(
      reader,
      options("growthos-restore-reader"),
    );
    const repeated = await seedRestoreFixture(
      environment(),
      options("growthos-staging-live"),
    );
    const after = await runRestoreDrillReadOnly(
      reader,
      options("growthos-restore-reader"),
    );
    expect(repeated.inserted).toBe(false);
    expect(after.fingerprint).toBe(baseline.fingerprint);
    expect(after.tableCounts).toMatchObject({
      estimates: 1,
      decision_rooms: 1,
      revenue_executions: 1,
      revenue_execution_events: 1,
      service_obligations: 1,
      stored_objects: 1,
    });
  });

  it("can prepare a secret-only short-lived inspection session before backup without extending it on retry", async () => {
    const token = "dc".repeat(32);
    const config = { ...environment(), RESTORE_DRILL_SESSION_BEARER: token };
    const seeded = await seedRestoreFixture(
      config,
      options("growthos-staging-live"),
    );
    expect(seeded.syntheticInspectionSessionPrepared).toBe(true);
    const first = await pg.query("SELECT expire FROM sessions WHERE sid = $1", [
      token,
    ]);
    await seedRestoreFixture(config, options("growthos-staging-live"));
    const second = await pg.query(
      "SELECT expire FROM sessions WHERE sid = $1",
      [token],
    );
    expect(second.rows[0].expire).toEqual(first.rows[0].expire);
    expect(output.join("\n")).not.toContain(token);
    await expect(
      seedRestoreFixture(
        {
          ...config,
          RESTORE_DRILL_SYNTHETIC_SLUG: "restore-drill-session-collision",
        },
        options("growthos-staging-live"),
      ),
    ).rejects.toThrow("restore_fixture_session_conflict_or_expired");
    expect(
      (
        await pg.query(
          "SELECT count(*)::int AS total FROM organizations WHERE slug = 'restore-drill-session-collision'",
        )
      ).rows[0].total,
    ).toBe(0);
  });

  it("proves positive and negative credential context checks with the actual reader role", async () => {
    const result = await verifyRestoreFixture(
      environment("growthos-restore-reader"),
      options("growthos-restore-reader"),
    );
    expect(result.applicationRecordGraphVerified).toBe(true);
    expect(result.storedObjectVerified).toBe(true);
    expect(result.wrongKeyRejected).toBe(true);
    expect(result.wrongContextRejected).toBe(true);
    expect(result.appBootVerified).toBe(false);
    await expect(
      verifyRestoreFixture(
        {
          ...environment("growthos-restore-reader"),
          OAUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 99).toString("base64"),
        },
        options("growthos-restore-reader"),
      ),
    ).rejects.toThrow();
  });

  it("supports a second isolated synthetic tenant without changing the first", async () => {
    const baseline = await runRestoreDrillReadOnly(
      environment("growthos-restore-reader"),
      options("growthos-restore-reader"),
    );
    const b = await seedRestoreFixture(
      environment("growthos-staging-live", "restore-drill-integration-b"),
      options("growthos-staging-live"),
    );
    expect(b.inserted).toBe(true);
    const after = await runRestoreDrillReadOnly(
      environment("growthos-restore-reader"),
      options("growthos-restore-reader"),
    );
    expect(after.fingerprint).toBe(baseline.fingerprint);
  });

  it("verifies an independent recovered in-memory database copy and detects altered recovery data", async () => {
    const baseline = await runRestoreDrillReadOnly(
      environment("growthos-restore-reader"),
      options("growthos-restore-reader"),
    );
    const restored = await createVectorPGlite({
      loadDataDir: await pg.dumpDataDir(),
      database: "growthos_staging",
    });
    const restoredOptions = {
      createClient: () => ({
        connect: () =>
          restored.exec('SET SESSION AUTHORIZATION "growthos-restore-reader"'),
        query: (sql, params) => restored.query(sql, params),
        end: () => restored.exec("SET SESSION AUTHORIZATION postgres"),
      }),
      emit: (line) => output.push(line),
    };
    const restoredEnv = {
      ...environment("growthos-restore-reader"),
      RESTORE_DRILL_MODE: "managed",
      RESTORE_DRILL_EXPECTED_CLUSTER_ID: "syntheticrestore123",
      RESTORE_DRILL_EXPECTED_FINGERPRINT: baseline.fingerprint,
      RESTORE_DRILL_DATABASE_URL: environment(
        "growthos-restore-reader",
      ).RESTORE_DRILL_DATABASE_URL.replace(
        "zp2wjrejd2zodn4q",
        "syntheticrestore123",
      ),
    };
    try {
      expect(
        (await runRestoreDrillReadOnly(restoredEnv, restoredOptions))
          .sourceFingerprintMatched,
      ).toBe(true);
      expect(
        (await verifyRestoreFixture(restoredEnv, restoredOptions))
          .credentialDecryptVerified,
      ).toBe(true);
      const { assertRestoreDatabaseIdentity } = await tsImport(
        "../artifacts/api-server/src/lib/restore-mode.ts",
        import.meta.url,
      );
      await restored.exec(
        'SET SESSION AUTHORIZATION "growthos-restore-reader"',
      );
      expect(
        await assertRestoreDatabaseIdentity(restored, {
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
          SESSION_SECRET: "synthetic-restore-secret",
          DATABASE_URL: restoredEnv.RESTORE_DRILL_DATABASE_URL,
        }),
      ).toBe(true);
      await restored.exec("SET SESSION AUTHORIZATION postgres");
      await restored.query(
        "UPDATE leads SET summary = 'altered restore' WHERE id = $1",
        [fixtureIds(slug).lead],
      );
      await expect(
        runRestoreDrillReadOnly(restoredEnv, restoredOptions),
      ).rejects.toThrow("restore_fingerprint_mismatch");
    } finally {
      await restored.close();
    }
  });

  it("refuses changed data rather than overwriting or repairing it silently", async () => {
    await pg.query("UPDATE contacts SET do_not_contact = false WHERE id = $1", [
      fixtureIds(slug).contact,
    ]);
    await expect(
      seedRestoreFixture(environment(), options("growthos-staging-live")),
    ).rejects.toThrow("restore_fixture_record_changed");
    const result = await pg.query(
      "SELECT do_not_contact FROM contacts WHERE id = $1",
      [fixtureIds(slug).contact],
    );
    expect(result.rows[0].do_not_contact).toBe(false);
    await pg.query("UPDATE contacts SET do_not_contact = true WHERE id = $1", [
      fixtureIds(slug).contact,
    ]);
  });

  it("rolls back a partially built fixture on a conflicting identity", async () => {
    const brokenSlug = "restore-drill-integration-conflict";
    await pg.query("INSERT INTO users(id,email) VALUES($1,$2)", [
      fixtureIds(brokenSlug).user,
      `${brokenSlug}@example.invalid`,
    ]);
    await expect(
      seedRestoreFixture(
        environment("growthos-staging-live", brokenSlug),
        options("growthos-staging-live"),
      ),
    ).rejects.toThrow();
    const result = await pg.query(
      "SELECT count(*)::int AS total FROM organizations WHERE slug = $1",
      [brokenSlug],
    );
    expect(result.rows[0].total).toBe(0);
  });

  it("refuses missing holds, production/malformed targets, the wrong session and writer use for acceptance", async () => {
    await expect(
      seedRestoreFixture(
        { ...environment(), GROWTHOS_OUTBOUND_HOLD: "false" },
        options("growthos-staging-live"),
      ),
    ).rejects.toThrow("restore_fixture_outbound_hold_required");
    await expect(
      seedRestoreFixture(
        { ...environment(), RESTORE_DRILL_SEED_APPROVED: "false" },
        options("growthos-staging-live"),
      ),
    ).rejects.toThrow("restore_fixture_seed_approval_required");
    await expect(
      seedRestoreFixture(
        {
          ...environment(),
          RESTORE_DRILL_DATABASE_URL:
            environment().RESTORE_DRILL_DATABASE_URL.replace(
              "zp2wjrejd2zodn4q",
              "kzpwm0j18eg04nv3",
            ),
        },
        options("growthos-staging-live"),
      ),
    ).rejects.toThrow("restore_production_target_forbidden");
    await expect(
      seedRestoreFixture(environment(), options("growthos-restore-reader")),
    ).rejects.toThrow("restore_fixture_session_mismatch");
    await expect(
      verifyRestoreFixture(environment(), options("growthos-staging-live")),
    ).rejects.toThrow("restore_reader_privilege_required");
    await expect(
      seedRestoreFixture(
        {
          ...environment(),
          RESTORE_DRILL_DATABASE_URL:
            environment().RESTORE_DRILL_DATABASE_URL +
            "?host=production.example",
        },
        options("growthos-staging-live"),
      ),
    ).rejects.toThrow("restore_target_invalid");
  });

  it("refuses a database containing nonfixture organizations and emits only safe evidence", async () => {
    await pg.exec(
      "INSERT INTO organizations(name,slug) VALUES('Non-fixture org','customer-org')",
    );
    await expect(
      seedRestoreFixture(environment(), options("growthos-staging-live")),
    ).rejects.toThrow("restore_fixture_database_not_synthetic");
    const text = output.join("\n");
    for (const secret of [
      key,
      FAKE_REFRESH_TOKEN,
      "synthetic-never-connect",
      "@example.invalid",
      "v1.",
    ])
      expect(text).not.toContain(secret);
  });
});
