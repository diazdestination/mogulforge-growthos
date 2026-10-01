import pg from "pg";
import type { NextFunction, Request, Response } from "express";
import { getSessionId } from "../lib/auth";
import type { RequireMemberGuard } from "../middlewares/requireMember";
import type { InventoryClient } from "./data-lifecycle-inventory";

export function isDataLifecycleInventoryRead(req: Pick<Request, "method" | "path">): boolean {
  return (req.method === "GET" || req.method === "HEAD") &&
    /^\/api\/v1\/data-lifecycle\/inventory\/?$/i.test(req.path);
}

type InventoryMember = { userId: string; organizationId: string; role: "owner" | "admin" };
export type InventoryMembershipResult =
  | { status: "authenticated"; member: InventoryMember }
  | { status: "unauthenticated" | "forbidden" | "unavailable" };

declare global {
  namespace Express {
    interface Request { dataLifecycleInventoryMember?: InventoryMember }
  }
}

export const DATA_LIFECYCLE_AUTH_LIMITS = {
  connectMs: 1_000, queryMs: 1_000, totalMs: 2_000, closeMs: 250, maxConnections: 4,
} as const;

// One current session/member projection, without passwords, OAuth credentials,
// session contents, email addresses or other tenant data. No shared-pool jobs.
// Drizzle writes sessions.expire as UTC into a timestamp-without-zone column;
// make that interpretation explicit instead of using the Node host's timezone.
const MEMBERSHIP_QUERY = `SELECT
  s.expire AT TIME ZONE 'UTC' AS "sessionExpiresAt", s.sess->'expires_at' AS "tokenExpiresAt",
  s.sess->'user'->>'id' AS "sessionUserId",
  jsonb_typeof(s.sess->'user'->'id') AS "identityType",
  u.id AS "userId", u.organization_id AS "organizationId", u.role,
  u.is_active AS active
FROM public.sessions s LEFT JOIN public.users u ON u.id = s.sess->'user'->>'id'
WHERE s.sid = $1 LIMIT 1`;

function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Inventory authentication unavailable")), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

/** Bounded, read-only identity check; stale sessions require ordinary sign-in. */
export function createDataLifecycleMembershipReader({
  createClient = () => new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: DATA_LIFECYCLE_AUTH_LIMITS.connectMs,
    query_timeout: DATA_LIFECYCLE_AUTH_LIMITS.queryMs + 100,
  }),
}: { createClient?: () => InventoryClient } = {}) {
  // Failed cleanup retains its slot; a late successful close frees it. Never
  // open unlimited replacement clients for a stuck or failed connection.
  let activeConnections = 0;
  return async (sid: unknown): Promise<InventoryMembershipResult> => {
    if (typeof sid !== "string" || !sid || sid.length > 512) return { status: "unauthenticated" };
    if (activeConnections >= DATA_LIFECYCLE_AUTH_LIMITS.maxConnections) return { status: "unavailable" };
    activeConnections++;
    let client: InventoryClient | undefined, expired = false, failed = false, closed = false;
    let result: InventoryMembershipResult = { status: "unavailable" };
    try {
      client = createClient();
      client.on("error", () => { failed = true; });
      const selected = client;
      const query = async (text: string, values?: unknown[]) => {
        if (expired || failed) throw new Error("Inventory authentication unavailable");
        const response = await selected.query({ text, values, query_timeout: DATA_LIFECYCLE_AUTH_LIMITS.queryMs + 100 });
        if (expired || failed) throw new Error("Inventory authentication unavailable");
        return response;
      };
      result = await bounded((async (): Promise<InventoryMembershipResult> => {
        await selected.connect();
        await query("BEGIN TRANSACTION READ ONLY");
        await query("SET LOCAL statement_timeout = '1000ms'");
        await query("SET LOCAL lock_timeout = '250ms'");
        await query("SET LOCAL idle_in_transaction_session_timeout = '2500ms'");
        const { rows } = await query(MEMBERSHIP_QUERY, [sid]);
        await query("ROLLBACK");
        if (rows.length > 1) return { status: "unavailable" };
        const row = rows[0] as Record<string, unknown> | undefined;
        if (!row || !(row.sessionExpiresAt instanceof Date) || !Number.isFinite(row.sessionExpiresAt.getTime()) ||
            row.sessionExpiresAt.getTime() <= Date.now() || row.identityType !== "string" ||
            typeof row.sessionUserId !== "string" || !row.sessionUserId) return { status: "unauthenticated" };
        if (row.tokenExpiresAt != null && (typeof row.tokenExpiresAt !== "number" || !Number.isFinite(row.tokenExpiresAt) ||
            row.tokenExpiresAt <= Math.floor(Date.now() / 1000))) return { status: "unauthenticated" };
        if (row.active !== true || row.userId !== row.sessionUserId || typeof row.organizationId !== "string" ||
            (row.role !== "owner" && row.role !== "admin")) return { status: "forbidden" };
        return { status: "authenticated", member: { userId: row.sessionUserId, organizationId: row.organizationId, role: row.role } };
      })(), DATA_LIFECYCLE_AUTH_LIMITS.totalMs);
      if (failed) result = { status: "unavailable" };
    } catch {
      // Never return/log raw connection, SQL, identity or credential details.
      result = { status: "unavailable" };
    } finally {
      expired = true;
      if (client) {
        const closing = Promise.resolve().then(() => client!.end()).then(() => {
          closed = true; activeConnections--;
        }, () => undefined);
        try { await bounded(closing, DATA_LIFECYCLE_AUTH_LIMITS.closeMs); } catch { /* Slot remains occupied. */ }
      } else { activeConnections--; closed = true; }
    }
    return closed ? result : { status: "unavailable" };
  };
}

export const readDataLifecycleMembership = createDataLifecycleMembershipReader();

/** Same active owner/admin boundary as settings.manage, with no pool/refresh. */
export function createDataLifecycleInventoryGuard(
  readMembership = readDataLifecycleMembership,
): RequireMemberGuard {
  const guard: RequireMemberGuard = Object.assign(async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    // Reject before session lookup, API-key resolution, throttles or usage writes.
    if (req.headers["x-api-key"] !== undefined) {
      res.status(403).json({ error: "An owner or administrator session is required" });
      return;
    }
    let result: InventoryMembershipResult;
    try { result = await readMembership(getSessionId(req)); }
    catch { result = { status: "unavailable" }; }
    if (result.status === "unauthenticated") { res.status(401).json({ error: "Not authenticated" }); return; }
    if (result.status === "forbidden") { res.status(403).json({ error: "Active owner or administrator membership is required" }); return; }
    if (result.status !== "authenticated") {
      res.status(503).json({ error: "Data lifecycle inventory is unavailable", code: "inventory_unavailable" }); return;
    }
    req.dataLifecycleInventoryMember = result.member;
    req.user = { id: result.member.userId, email: null, firstName: null, lastName: null, profileImageUrl: null };
    next();
  }, { requiredPermission: "settings.manage" as const });
  return guard;
}

export const requireDataLifecycleInventoryMember = createDataLifecycleInventoryGuard();
