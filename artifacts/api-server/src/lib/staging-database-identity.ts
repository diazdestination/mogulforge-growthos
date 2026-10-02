type Queryable = {
  query: (text: string) => Promise<{
    rows: Array<{ database: string; login: string }>;
  }>;
};

const STAGING_HOST = "pgbouncer.zp2wjrejd2zodn4q.flympg.net";

/** Refuse to boot staging against the production database before any seeding. */
export async function assertStagingDatabaseIdentity(
  client: Queryable,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const staging =
    env.FLY_APP_NAME === "mogulforge-growthos-staging" ||
    env.APP_ORIGIN === "https://mogulforge-growthos-staging.fly.dev";
  if (!staging) return;
  if (env.FLY_APP_NAME !== "mogulforge-growthos-staging" || !env.DATABASE_URL)
    throw new Error("Staging database identity is missing");
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    throw new Error("Staging database URL is invalid");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    decodeURIComponent(url.pathname.slice(1)) !== "growthos_staging" ||
    decodeURIComponent(url.username) !== "growthos-staging-live" ||
    url.hostname !== STAGING_HOST
  )
    throw new Error("Staging database target does not match the required database");
  const { rows } = await client.query(
    "SELECT current_database() AS database, session_user AS login",
  );
  if (
    rows[0]?.database !== "growthos_staging" ||
    rows[0]?.login !== "growthos-staging-live"
  )
    throw new Error("Staging database session does not match the required database");
}
