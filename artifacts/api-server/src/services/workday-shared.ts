import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { auditEventsTable, db, usersTable, type UserRole } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { hasPermission, type Permission } from "../lib/permissions";
import { lockContractorSchedule } from "./contractor-scheduling";
import { WorkdayError } from "./contractor-workday-contract";

export type WorkdayTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type WorkdayReader = typeof db | WorkdayTx;
export type WorkdayActor = { userId: string; effectiveRole?: UserRole };
export function workdayFail(code: string, message = "This saved work changed or is unavailable. Refresh and review before continuing.", status = 409): never { throw new WorkdayError(status, code, message); }
function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const workdayHash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export async function lockWorkday(tx: WorkdayTx, org: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`customer-lifecycle:${org}`},0))`);
  await lockContractorSchedule(tx, org);
}
export async function workdayActor(reader: WorkdayReader, org: string, actor: WorkdayActor, permission: Permission = "crm.read", locked = false) {
  const query = reader.select().from(usersTable).where(and(eq(usersTable.organizationId, org), eq(usersTable.id, actor.userId)));
  const [user] = await (locked ? query.for("share") : query);
  if (!user || !user.isActive || !user.emailVerifiedAt || user.id.startsWith("invite:") || !hasPermission(user.role, permission) || !hasPermission(actor.effectiveRole ?? user.role, permission)) workdayFail("workday_access_denied", "An active, accepted and verified staff session with permission is required.", 403);
  return user;
}
export const workdayVersion = (actual: number, expected: number) => { if (actual !== expected) workdayFail("workday_stale_version"); };
export async function workdayReplay(tx: WorkdayTx, org: string, action: string, requestId: string, payload: unknown) {
  const [event] = await tx.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, org), eq(auditEventsTable.action, action), sql`${auditEventsTable.metadata}->>'requestId'=${requestId}`)).limit(1);
  if (!event) return null;
  if (event.metadata.payloadSha256 !== workdayHash(payload)) workdayFail("workday_request_conflict", "This request ID already owns different saved work.");
  return event.metadata.result as Record<string, unknown>;
}
export async function workdayAudit(tx: WorkdayTx, org: string, actor: string, action: string, entityId: string, requestId: string, payload: unknown, result: Record<string, unknown>) {
  await tx.insert(auditEventsTable).values({ organizationId: org, actorUserId: actor, action, entityType: "contractor_workday", entityId, metadata: { requestId, payloadSha256: workdayHash(payload), result } });
}
const TOKEN_MS = 10 * 60_000;
function signingKey() { const key = process.env.SESSION_SECRET; if (!key || key.length < 16) workdayFail("workday_review_unavailable", "Review signing is not configured. No work was changed.", 503); return key; }
export function signWorkdayReview<T>(kind: string, org: string, actor: string, value: T) {
  const expiresAt = new Date(Date.now() + TOKEN_MS).toISOString();
  const encoded = Buffer.from(JSON.stringify({ v: 1, kind, org, actor, expiresAt, value })).toString("base64url");
  const signature = createHmac("sha256", signingKey()).update(`growthos-workday-v1:${encoded}`).digest("base64url");
  return { previewToken: `${encoded}.${signature}`, expiresAt };
}
export function readWorkdayReview<T>(token: string, kind: string, org: string, actor: string): T {
  const parts = token.split("."); if (parts.length !== 2) return workdayFail("workday_review_invalid");
  const expected = createHmac("sha256", signingKey()).update(`growthos-workday-v1:${parts[0]}`).digest();
  let value: { v: number; kind: string; org: string; actor: string; expiresAt: string; value: T };
  try {
    const actual = Buffer.from(parts[1], "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return workdayFail("workday_review_invalid");
    value = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch { return workdayFail("workday_review_invalid"); }
  if (value.v !== 1 || value.kind !== kind || value.org !== org || value.actor !== actor || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) return workdayFail("workday_review_expired", "This exact review is expired or belongs to another staff context. Prepare a fresh review.");
  return value.value;
}
