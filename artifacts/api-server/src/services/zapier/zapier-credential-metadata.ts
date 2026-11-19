import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db/schema";
import { randomUUID } from "node:crypto";
import {
  db,
  zapierActionExecutionsTable as executions,
  type ZapierMcpConnection,
} from "@workspace/db";
import { sql, and, eq, gte, lt, count } from "drizzle-orm";
import { sha256Hex } from "./zapier-mcp-client";

export type ZapierTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

export async function lockZapierResource(
  tx: ZapierTransaction,
  resource: string,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${"zapier:" + resource}, 0))`,
  );
}

// A dispatch holds its org lock across provider I/O while the durable ledger
// uses the normal application pool. Queue lock contenders in a small separate
// pool so waiting dispatches cannot exhaust the connections they need to finish.
const fenceDb = drizzle(
  new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    allowExitOnIdle: true,
  }),
  { schema },
);

export function withZapierOrgTransaction<T>(
  organizationId: string,
  fn: (tx: ZapierTransaction) => Promise<T>,
) {
  return fenceDb.transaction(async (tx) => {
    await lockZapierResource(tx, "org:" + organizationId);
    return fn(tx);
  });
}

export function managedMetadata(fingerprint: string) {
  if (!fingerprint.startsWith("mf1:")) return null;
  const [, version, referenceHash, limit, tokenHash, extra] =
    fingerprint.split(":");
  if (
    !version ||
    !referenceHash ||
    !/^[a-f0-9]{64}$/.test(referenceHash) ||
    !tokenHash ||
    !/^[a-f0-9]{64}$/.test(tokenHash) ||
    !limit ||
    !/^\d{1,6}$/.test(limit) ||
    Number(limit) > 100000 ||
    extra !== undefined
  ) {
    throw new Error("Invalid managed connection metadata.");
  }
  return {
    version,
    referenceHash,
    monthlyActionLimit: Number(limit),
    tokenHash,
  };
}

export function newManagedFingerprint(
  reference: string,
  token: string,
  monthlyActionLimit: number,
) {
  return [
    "mf1",
    randomUUID(),
    sha256Hex(reference),
    String(monthlyActionLimit),
    sha256Hex(token),
  ].join(":");
}

export function publicVersion(row: ZapierMcpConnection | null) {
  return row
    ? sha256Hex(
        row.serverUrlFingerprint +
          "|" +
          (row.revokedAt?.toISOString() ?? "active"),
      )
    : null;
}

export function utcMonth(now = new Date()) {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

export async function monthlyStarted(
  tx: ZapierTransaction,
  organizationId: string,
  now = new Date(),
) {
  const { start, end } = utcMonth(now);
  const [result] = await tx
    .select({ total: count() })
    .from(executions)
    .where(
      and(
        eq(executions.organizationId, organizationId),
        gte(executions.startedAt, start),
        lt(executions.startedAt, end),
      ),
    );
  return result?.total ?? 0;
}
