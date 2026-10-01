import pg from "pg";

export const READINESS_CONNECT_MS = 1000;
export const READINESS_QUERY_MS = 750;
export const READINESS_CHECK_MS = 1500;
export const READINESS_CLOSE_MS = 300;
export const READINESS_CACHE_MS = 1000;

export type ReadinessClient = {
  connect(): Promise<unknown>;
  query(config: {
    text: string;
    query_timeout: number;
  }): Promise<{ rows: Array<{ ready?: unknown }> }>;
  end(): Promise<unknown>;
  on(event: "error", callback: () => void): unknown;
};

function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Readiness deadline")),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Read-only, provider-free probe isolated from the application's shared pool. */
export function createReadinessProbe({
  createClient = () => {
    if (!process.env.DATABASE_URL)
      throw new Error("Database configuration unavailable");
    return new pg.Client({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: READINESS_CONNECT_MS,
      query_timeout: READINESS_QUERY_MS,
    });
  },
  now = Date.now,
}: { createClient?: () => ReadinessClient; now?: () => number } = {}) {
  let inFlight: Promise<boolean> | undefined;
  let cached: { ready: boolean; expires: number } | undefined;
  let cleanupBlocked = false;

  const check = async () => {
    let client: ReadinessClient | undefined,
      expired = false,
      failed = false,
      ready = false;
    try {
      client = createClient();
      client.on("error", () => {
        failed = true;
      });
      const selected = client;
      ready = await bounded(
        (async () => {
          await selected.connect();
          if (expired) return false;
          const result = await selected.query({
            text: "SELECT 1 AS ready",
            query_timeout: READINESS_QUERY_MS,
          });
          return !expired && result.rows[0]?.ready === 1;
        })(),
        READINESS_CHECK_MS,
      );
    } catch {
      // Driver exceptions may contain credentials/hostnames. They never leave
      // this helper; the public endpoint exposes only ready/not_ready.
      ready = false;
    } finally {
      expired = true;
    }

    if (client) {
      cleanupBlocked = true;
      // Client.end() destroys an active/hung pg query's socket. Unlike an
      // unbounded shared-pool acquisition, this client also has a connect limit.
      const closing = Promise.resolve()
        .then(() => client!.end())
        .then(
          () => {
            cleanupBlocked = false;
            return true;
          },
          () => false,
        );
      try {
        ready = (await bounded(closing, READINESS_CLOSE_MS)) && ready;
      } catch {
        ready = false;
      }
      // Never create another client while cleanup is pending/failed. A late
      // successful close permits recovery; a failed close requires restart.
    }
    return ready && !failed;
  };

  return (): Promise<boolean> => {
    if (inFlight) return inFlight;
    if (cleanupBlocked) return Promise.resolve(false);
    if (cached && now() < cached.expires) return Promise.resolve(cached.ready);
    inFlight = check()
      .then((ready) => {
        cached = { ready, expires: now() + READINESS_CACHE_MS };
        return ready;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}

export const checkReadiness = createReadinessProbe();
