import { createHmac, timingSafeEqual } from "node:crypto";
import { sourceFingerprint } from "./source-adoption-contract";
/** HTTP acceptance is not a provider message ID or delivery confirmation. */
export interface NurtureHttpAcceptance { organizationId: string; planId: string; itemId: string; stepId: string; actionKey: string; parentId: string;
  executionFingerprint: string; messageHash: string; recipient: string; acceptedAt: string; provider: "microsoft" }
function key() {
  const raw = process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const bytes = /^[a-f\d]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  return bytes.length === 32 ? createHmac("sha256", bytes).update("growthos/source-nurture-http-acceptance/v1").digest() : null;
}
export function signNurtureHttpAcceptance(input: NurtureHttpAcceptance) {
  const secret = key(); if (!secret) throw new Error("Nurture acceptance storage is unavailable.");
  return { nurtureAcceptanceVersion: 1 as const, nurtureHttpAcceptance: input, nurtureAcceptanceProof: createHmac("sha256", secret).update(sourceFingerprint(input)).digest("hex") };
}
export function verifyNurtureHttpAcceptance(metadata: Record<string, unknown>, expected: NurtureHttpAcceptance) {
  const secret = key(), proof = metadata.nurtureAcceptanceProof;
  if (!secret || metadata.nurtureAcceptanceVersion !== 1 || typeof proof !== "string" || !/^[a-f\d]{64}$/.test(proof) ||
    sourceFingerprint(metadata.nurtureHttpAcceptance) !== sourceFingerprint(expected)) return false;
  return timingSafeEqual(Buffer.from(proof, "hex"), createHmac("sha256", secret).update(sourceFingerprint(expected)).digest());
}
