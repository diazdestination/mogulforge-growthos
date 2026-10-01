import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRestoreDrillTarget } from "./restore-drill-readonly.mjs";
import { restoreClient } from "./restore-drill-connection.mjs";
import {
  assertFixtureRecords,
  credentialCodec,
} from "./restore-drill-fixture.mjs";

/** A read-only stored-app-data and credential check; does not claim HTTP/app boot acceptance. */
export async function verifyRestoreFixture(
  env = process.env,
  { createClient, emit = console.log } = {},
) {
  const target = parseRestoreDrillTarget(env);
  const codec = await credentialCodec(env.OAUTH_TOKEN_ENCRYPTION_KEY);
  const connection = await restoreClient(env, target, { createClient });
  const { client } = connection;
  let begun = false;
  try {
    await client.connect();
    await client.query("BEGIN TRANSACTION READ ONLY");
    begun = true;
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const identity = await client.query(
      "SELECT current_database() AS database, session_user AS login",
    );
    if (
      identity.rows[0]?.database !== target.database ||
      identity.rows[0]?.login !== target.login
    )
      throw new Error("restore_acceptance_session_mismatch");
    const privileges = await client.query(
      "SELECT has_table_privilege(session_user, 'public.organizations', 'INSERT') OR has_table_privilege(session_user, 'public.gmail_connections', 'UPDATE') AS can_write",
    );
    if (privileges.rows[0]?.can_write !== false)
      throw new Error("restore_reader_privilege_required");
    const checks = await assertFixtureRecords(client, target, codec);
    const evidence = {
      check: "restore_drill_application_data",
      mode: target.mode,
      syntheticSlug: target.syntheticSlug,
      target: {
        clusterId: target.clusterId,
        database: target.database,
        login: target.login,
      },
      ...checks,
      providerCalled: false,
      managedBackupRestoreVerified: "not_by_this_check",
    };
    emit(JSON.stringify(evidence));
    return evidence;
  } finally {
    if (begun) await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
    await connection.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  verifyRestoreFixture().catch((error) => {
    console.error(
      `RESTORE_ACCEPTANCE_FAILED:${/^restore_[a-z_]+$/.test(error.message || "") ? error.message : /^[A-Z0-9]{5}$/.test(error.code || "") ? error.code : "unknown"}`,
    );
    process.exitCode = 1;
  });
}
