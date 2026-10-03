import { createHash } from "node:crypto";
import { z } from "zod";
import { encryptEmailContent } from "../lib/email-content-encryption";

export class ServiceSmsReplyStorageError extends Error {
  readonly code = "sms_reply_storage_unavailable";
  readonly status = 409;
  readonly effectNotAttempted = true;
  constructor() { super("Encrypted service SMS reply storage is not configured. No reminder was sent."); }
}
/** Local capability probe only. Never stores, returns or logs key material. */
export function assertServiceSmsReplyStorageReady() {
  try { encryptEmailContent("readiness", "growthos-service-sms-storage-readiness:v1"); }
  catch { throw new ServiceSmsReplyStorageError(); }
}

/** Routing reference only: not a secret, identity check, consent or booking. */
export const serviceSmsReplyReference = (org: string, obligationId: string) => createHash("sha256")
  .update(`growthos-service-sms-v1:${org}:${obligationId}`).digest("hex").slice(0, 16);
export const serviceSmsReplySuffix = (org: string, obligationId: string) =>
  `Reply SERVICE ${serviceSmsReplyReference(org, obligationId)} followed by your message.`;

export function parseServiceSmsReference(text: string): { reference: string | null; explicit: boolean } {
  const match = /^SERVICE\s+([a-f0-9]{16})(?:\s|$)/i.exec(text.trim());
  return { reference: match?.[1].toLowerCase() ?? null, explicit: /^SERVICE(?:\s|$)/i.test(text.trim()) };
}
export const serviceSmsReplyQuery = z.object({ offset: z.coerce.number().int().min(0).max(100_000).default(0) }).strict();
export const serviceSmsReplyReviewInput = z.object({ requestId: z.uuid(), expectedVersion: z.number().int().positive(),
  decision: z.enum(["office_follow_up", "not_service_reply", "handled"]), note: z.string().trim().min(10).max(1000), reviewed: z.literal(true) }).strict();
