import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const STAGING_APP = "mogulforge-growthos-staging";
const STAGING_DATABASE = "growthos_staging";
const STAGING_LOGIN = "growthos-staging-live";
// The owner-approved, separate Managed Postgres cluster. The previous shared
// production/staging cluster must never satisfy this preflight again.
const STAGING_HOST = "pgbouncer.zp2wjrejd2zodn4q.flympg.net";

/** Return only non-secret connection identity. Never log the full URL. */
export function parseStagingTarget(connectionString, appName) {
  if (appName !== STAGING_APP || !connectionString)
    throw new Error("staging_identity_missing");
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("database_url_invalid");
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  const login = decodeURIComponent(url.username);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    database !== STAGING_DATABASE ||
    login !== STAGING_LOGIN ||
    url.hostname !== STAGING_HOST
  )
    throw new Error("staging_database_target_mismatch");
  return { database, login, host: url.hostname, port: url.port || "default" };
}

const checks = [
  ["organizations", "SELECT slug FROM organizations ORDER BY slug"],
  [
    "contacts",
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE email IS NOT NULL)::int AS with_email,
            count(*) FILTER (WHERE phone IS NOT NULL)::int AS with_phone
       FROM contacts`,
  ],
  [
    "contact_email_domains",
    `SELECT lower(split_part(email, '@', 2)) AS domain, count(*)::int AS total
       FROM contacts WHERE email IS NOT NULL GROUP BY 1 ORDER BY 1`,
  ],
  [
    "staff_email_domains",
    `SELECT lower(split_part(email, '@', 2)) AS domain, count(*)::int AS total
       FROM users WHERE email IS NOT NULL GROUP BY 1 ORDER BY 1`,
  ],
  [
    "scheduled_actions",
    `SELECT status, coalesce(action->>'type', 'unknown') AS kind,
            count(*)::int AS total,
            count(*) FILTER (WHERE run_at <= now())::int AS due
       FROM scheduled_actions GROUP BY status, kind ORDER BY status, kind`,
  ],
  [
    "reactivation_campaigns",
    "SELECT status, count(*)::int AS total FROM reactivation_campaigns GROUP BY status ORDER BY status",
  ],
  [
    "webhook_deliveries",
    "SELECT status, count(*)::int AS total FROM webhook_deliveries GROUP BY status ORDER BY status",
  ],
  [
    "abandoned_chat_candidates",
    `SELECT count(*)::int AS total FROM conversations
      WHERE status = 'active' AND updated_at < now() - interval '30 minutes'`,
  ],
  [
    "api_key_reminder_candidates",
    `SELECT count(*)::int AS total FROM api_keys
      WHERE is_active = true AND revoked_at IS NULL
        AND expiry_reminder_sent_at IS NULL
        AND expires_at > now() AND expires_at <= now() + interval '7 days'`,
  ],
  [
    "active_webhook_endpoints",
    "SELECT count(*)::int AS total FROM webhook_endpoints WHERE is_active = true",
  ],
];

export async function runStagingPreflight(env = process.env) {
  const target = parseStagingTarget(env.DATABASE_URL, env.FLY_APP_NAME);
  const requireFromApi = createRequire(
    new URL("../artifacts/api-server/package.json", import.meta.url),
  );
  const { Client } = requireFromApi("pg");
  const client = new Client({ connectionString: env.DATABASE_URL });
  let inTransaction = false;
  try {
    await client.connect();
    await client.query("BEGIN TRANSACTION READ ONLY");
    inTransaction = true;
    const identity = await client.query(
      "SELECT current_database() AS database, session_user AS login, current_user AS role",
    );
    if (
      identity.rows[0]?.database !== STAGING_DATABASE ||
      identity.rows[0]?.login !== STAGING_LOGIN
    )
      throw new Error("staging_database_identity_mismatch");
    console.log(
      JSON.stringify({
        check: "connection_identity",
        target,
        actual: identity.rows[0],
        poolModeVerified: false,
      }),
    );
    for (const [name, query] of checks) {
      const result = await client.query(query);
      console.log(JSON.stringify({ check: name, rows: result.rows }));
    }
  } finally {
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
  }
}

const isDirectExecution =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  runStagingPreflight().catch((error) => {
    // Database/provider exceptions can include connection material. Print only
    // fixed internal failure labels or PostgreSQL error codes, never messages.
    const label =
      error.message?.startsWith("staging_") || error.message === "database_url_invalid"
        ? error.message
        : error.code || "unknown";
    console.error(`STAGING_READONLY_PREFLIGHT_FAILED:${label}`);
    process.exitCode = 1;
  });
}
