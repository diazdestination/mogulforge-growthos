import { createHmac, timingSafeEqual } from "node:crypto";

export type OutboundReplyContext = { organizationId: string; leadId: string; recipientEmail: string };
type AcceptedMessage = { id: string | null; provider: string; senderEmail?: string };

/** Domain-separated authentication of provider acceptance evidence. No secret or
 * raw content is stored. Missing/rotated keys leave old messages staff-review-only. */
function proofKey() {
  const configured = process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY?.trim();
  if (!configured) return null;
  const key = /^[a-f\d]{64}$/i.test(configured) ? Buffer.from(configured, "hex") : Buffer.from(configured, "base64");
  return key.length === 32 ? createHmac("sha256", key).update("growthos/outbound-reply-evidence/v1").digest() : null;
}
function signature(result: AcceptedMessage, context: OutboundReplyContext, acceptedAt: string) {
  const key = proofKey();
  if (!key || !result.id || !["gmail", "microsoft"].includes(result.provider) || !result.senderEmail) return null;
  return createHmac("sha256", key).update(JSON.stringify([
    context.organizationId, context.leadId, result.provider, result.id,
    result.senderEmail.trim().toLowerCase(), context.recipientEmail.trim().toLowerCase(), acceptedAt,
  ])).digest("hex");
}
export function signOutboundReplyEvidence(result: AcceptedMessage, context: OutboundReplyContext, acceptedAt = new Date().toISOString()) {
  const proof = signature(result, context, acceptedAt);
  return proof ? { replyEvidenceVersion: 1, replyEvidenceAcceptedAt: acceptedAt, replyEvidenceRecipient: context.recipientEmail.trim().toLowerCase(), replyEvidenceProof: proof } : {};
}
export function verifyOutboundReplyEvidence(metadata: Record<string, unknown>, context: Omit<OutboundReplyContext, "recipientEmail">): Date | null {
  if (metadata.replyEvidenceVersion !== 1 || typeof metadata.replyEvidenceProof !== "string" ||
    !/^[a-f\d]{64}$/i.test(metadata.replyEvidenceProof) || typeof metadata.replyEvidenceAcceptedAt !== "string" ||
    typeof metadata.provider !== "string" || typeof metadata.providerMessageId !== "string" || typeof metadata.senderEmail !== "string" || typeof metadata.replyEvidenceRecipient !== "string") return null;
  const at = new Date(metadata.replyEvidenceAcceptedAt);
  if (!Number.isFinite(at.getTime()) || at.getTime() > Date.now() + 60_000) return null;
  const expected = signature({ id: metadata.providerMessageId, provider: metadata.provider, senderEmail: metadata.senderEmail }, { ...context, recipientEmail: metadata.replyEvidenceRecipient }, metadata.replyEvidenceAcceptedAt);
  if (!expected || !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(metadata.replyEvidenceProof, "hex"))) return null;
  return at;
}
