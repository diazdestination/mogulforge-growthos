import { createHash } from "node:crypto";
import { z } from "zod/v4";

export class SourceAdoptionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function adoptionDeny(code: string, message: string, status = 409): never {
  throw new SourceAdoptionError(status, code, message);
}
function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const sourceFingerprint = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export const sourceOutreachKey = (leadId: string) => `source-outreach:${leadId}:email`;
export const SOURCE_EMAIL_DISCLOSURE = "source-email-marketing.v1";
export const SOURCE_BATCH_MAX = 10;
export const SOURCE_DAILY_MAX = 25;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const evidence = z.string().trim().min(20).max(2000);
const version = z.number().int().nonnegative();
export const adoptionReviewSchema = z.object({
  expectedVersion: version, sourceAsOf: z.iso.datetime(), cutoverAt: z.iso.datetime(), expiresAt: z.iso.datetime(), evidence,
  sourceWriterStopped: z.literal(true), currentStatusVerified: z.literal(true), noUnreviewedReplies: z.literal(true),
}).strict();
export const sourceApprovalSchema = z.object({ previewId: z.uuid(), payloadSha256: digest, confirmed: z.literal(true) }).strict();
export const sourceRevokeSchema = z.object({ expectedVersion: version, reason: evidence }).strict();
export const sourcePermissionSchema = z.object({
  expectedSourceSha256: digest, expectedRecipient: z.email(), expectedConsentId: z.uuid().nullable(), granted: z.boolean(),
  observedAt: z.iso.datetime(), evidence, marketingPermissionConfirmed: z.literal(true),
}).strict();
export const outreachDraftSchema = z.object({
  leadIds: z.array(z.uuid()).min(1).max(SOURCE_BATCH_MAX).refine(ids => new Set(ids).size === ids.length),
  businessName: z.string().trim().min(2).max(150).refine(s => !/[\r\n]/.test(s)),
  mailingAddress: z.string().trim().min(10).max(400),
  subject: z.string().trim().min(3).max(180).refine(s => !/[\r\n]/.test(s)),
  body: z.string().trim().min(10).max(4000),
  timezone: z.string().min(1).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; } }),
  days: z.array(z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])).min(1).max(7).refine(days => new Set(days).size === days.length),
  startHour: z.number().int().min(8).max(19), endHour: z.number().int().min(9).max(20),
  dailyLimit: z.number().int().min(1).max(SOURCE_DAILY_MAX), expiresAt: z.iso.datetime(),
}).strict().refine(v => v.endHour > v.startHour && v.leadIds.length <= v.dailyLimit);
export const outreachApproveSchema = z.object({ expectedVersion: version, payloadSha256: digest, confirmed: z.literal(true) }).strict();
