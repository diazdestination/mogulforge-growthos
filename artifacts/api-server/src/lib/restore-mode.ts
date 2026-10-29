import type { RequestHandler } from "express";

const RESTORE_APP = "mogulforge-growthos-restore-drill";
const STAGING_CLUSTER = "zp2wjrejd2zodn4q";
const PRODUCTION_CLUSTER = "kzpwm0j18eg04nv3";
const READER_LOGIN = "growthos-restore-reader";

export function restoreModeRequested(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.RESTORE_DRILL_ONLY !== undefined ||
    env.RESTORE_DRILL_EXPECTED_CLUSTER_ID !== undefined ||
    env.FLY_APP_NAME === RESTORE_APP ||
    Boolean(env.APP_ORIGIN?.includes("mogulforge-growthos-restore-drill"))
  );
}

export function validateRestoreMode(env: NodeJS.ProcessEnv = process.env): {
  database: string;
  login: string;
  clusterId: string;
} | null {
  if (!restoreModeRequested(env)) return null;
  const deny = (): never => {
    throw new Error("Restore-only environment is incomplete or unsafe");
  };
  if (
    env.RESTORE_DRILL_ONLY !== "true" ||
    env.FLY_APP_NAME !== RESTORE_APP ||
    env.AUTO_MIGRATE !== "false" ||
    env.SCHEDULER_AUTOSTART !== "false" ||
    env.GROWTHOS_OUTBOUND_HOLD !== "true" ||
    env.STAGING_OUTBOUND_APPROVED !== "false" ||
    env.OBJECT_STORAGE_PROVIDER !== "postgres" ||
    env.HOST !== "127.0.0.1" ||
    !env.SESSION_SECRET ||
    !env.DATABASE_URL
  )
    deny();
  let origin: URL;
  let url: URL;
  try {
    origin = new URL(env.APP_ORIGIN!);
    url = new URL(env.DATABASE_URL!);
  } catch {
    return deny();
  }
  // The restore listener has no public route. Use an SSH/tunnel into this
  // exact loopback listener when operating on a private Fly machine.
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    origin.port !== env.PORT ||
    !/^\d{2,5}$/.test(env.PORT || "")
  )
    deny();
  const match = /^pgbouncer\.([a-z0-9]+)\.flympg\.net$/.exec(url.hostname);
  if (
    !match ||
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hash ||
    (url.port && url.port !== "5432") ||
    [...url.searchParams].some(
      ([key, value]) =>
        !(
          (key === "sslmode" && value === "require") ||
          (key === "options" && value === "-c default_transaction_read_only=on")
        ),
    )
  )
    deny();
  const clusterId = match![1];
  const database = decodeURIComponent(url.pathname.slice(1));
  const login = decodeURIComponent(url.username);
  if (
    clusterId === PRODUCTION_CLUSTER ||
    login !== READER_LOGIN ||
    clusterId !== env.RESTORE_DRILL_EXPECTED_CLUSTER_ID ||
    !["logical", "managed"].includes(env.RESTORE_DRILL_MODE || "")
  )
    deny();
  if (
    env.RESTORE_DRILL_MODE === "logical" &&
    (clusterId !== STAGING_CLUSTER || database !== "growthos_restore_drill")
  )
    deny();
  if (
    env.RESTORE_DRILL_MODE === "managed" &&
    (clusterId === STAGING_CLUSTER || database !== "growthos_staging")
  )
    deny();
  // Restore ciphertext keys/session signing are local application secrets,
  // whereas provider credentials could contact an external account.
  const forbidden =
    /^(RESEND_|SENDGRID_|TWILIO_|STRIPE_|ZAPIER_|OPENAI_|ELEVENLABS_|ANTHROPIC_|GOOGLE_|GMAIL_|SMTP_|REPLIT_|AI_INTEGRATIONS_|AZURE_OPENAI_|MICROSOFT_|MS_GRAPH_|EMAIL_INGESTION_WEBHOOK_SECRET$|GOOGLE_APPLICATION_CREDENTIALS$)/;
  if (
    Object.entries(env).some(
      ([name, value]) => forbidden.test(name) && Boolean(value?.trim()),
    )
  )
    deny();
  return { database, login, clusterId };
}

export async function assertRestoreDatabaseIdentity(
  client: {
    query: (text: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const target = validateRestoreMode(env);
  if (!target) return false;
  const identity = await client.query(
    "SELECT current_database() AS database, session_user AS login",
  );
  if (
    identity.rows[0]?.database !== target.database ||
    identity.rows[0]?.login !== target.login
  )
    throw new Error(
      "Restore-only database session does not match the required reader",
    );
  const privilege = await client.query(`SELECT
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND
        (has_table_privilege(session_user, c.oid, 'INSERT') OR
         has_table_privilege(session_user, c.oid, 'UPDATE') OR
         has_table_privilege(session_user, c.oid, 'DELETE') OR
         has_table_privilege(session_user, c.oid, 'TRUNCATE'))) OR
    has_schema_privilege(session_user, 'public', 'CREATE') OR
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = session_user AND
      (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)) AS can_write`);
  if (privilege.rows[0]?.can_write !== false)
    throw new Error(
      "Restore-only database account must have read-only privileges",
    );
  return true;
}

/** Restrict the private restore app to inspection before authentication handlers. */
export const restoreReadOnlyRequests: RequestHandler = (req, res, next) => {
  if (restoreModeRequested()) {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      res
        .status(405)
        .json({ error: "Restore drill permits read-only inspection only" });
      return;
    }
    // OAuth/login/logout GETs can exchange tokens or mutate sessions. They are
    // unnecessary for restored-data inspection, which uses a prepared session.
    if (
      (/^\/api\/(auth|login|logout|callback|dev)(\/|$)/.test(req.path) &&
        req.path !== "/api/auth/user") ||
      /^\/api\/v1\/(integrations|billing|public|unsubscribe|webhooks|capture)(\/|$)/.test(
        req.path,
      )
    ) {
      res.status(405).json({
        error: "Authentication changes are disabled during restore inspection",
      });
      return;
    }
  }
  next();
};
