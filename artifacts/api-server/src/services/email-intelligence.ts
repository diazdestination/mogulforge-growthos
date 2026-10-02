import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  db,
  auditEventsTable,
  emailResponseReviewsTable,
  emailIntelligenceFactsTable,
  emailIntelligenceMessagesTable,
  emailIntelligenceSourcesTable,
  type EmailIntelligenceFactKind,
  type EmailIntelligenceFactStatus,
  type EmailIntelligenceSource,
} from "@workspace/db";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod/v4";

import { encryptEmailContent } from "../lib/email-content-encryption";
import { recordAudit } from "./audit";
import { registerEmailResponse, type VerifiedReplyParent } from "./response-correlation";

const MAX_TEXT_BYTES = 256 * 1024;
const MAX_RECIPIENTS = 25;
const MAX_FORWARDERS = 50;
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
const DEFAULT_DOMAIN = "intake.mogulforge.ai";

export class EmailIntelligenceError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = "invalid_email_intelligence_request",
  ) {
    super(message);
  }
}

export interface EmailIntelligencePayload {
  externalMessageId: string;
  forwardedBy: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  sentAt?: string | null;
  attachmentCount?: number;
  /** Supplied only by the authenticated normalizer after resolving the original
   * provider message in its sending mailbox, never copied from email text. */
  replyTo?: VerifiedReplyParent | null;
}

export interface DerivedEmailFact {
  kind: EmailIntelligenceFactKind;
  statement: string;
  evidenceExcerpt: string;
  confidence: number;
}

const FACT_RULES: Array<{
  kind: EmailIntelligenceFactKind;
  pattern: RegExp;
  statement: string;
  confidence: number;
}> = [
  {
    kind: "estimate_request",
    pattern: /\b(estimate|quote|proposal|pricing)\b/i,
    statement: "The message contains an estimate, quote, proposal, or pricing request.",
    confidence: 78,
  },
  {
    kind: "follow_up_commitment",
    pattern: /\b(i(?:'ll| will)|we(?:'ll| will))\s+(follow up|call|email|send|check back)\b/i,
    statement: "The message contains an explicit follow-up commitment that should be reviewed.",
    confidence: 86,
  },
  {
    kind: "price_objection",
    pattern: /\b(too expensive|cost is high|price is high|over budget|cannot afford|can't afford)\b/i,
    statement: "The message contains language consistent with a price or budget objection.",
    confidence: 84,
  },
  {
    kind: "buying_signal",
    pattern: /\b(ready to (move forward|proceed|start)|let(?:'s| us) (move forward|proceed)|when can you start|send the contract)\b/i,
    statement: "The message contains language consistent with an intent to proceed.",
    confidence: 90,
  },
  {
    kind: "complaint",
    pattern: /\b(complaint|very upset|unhappy|disappointed|cancel(?:lation)?|not acceptable)\b/i,
    statement: "The message contains complaint, cancellation, or escalation language.",
    confidence: 82,
  },
  {
    kind: "appointment_risk",
    pattern: /\b(reschedule|cannot make (?:it|the appointment)|can't make (?:it|the appointment)|missed appointment|need to cancel)\b/i,
    statement: "The message contains language indicating an appointment or handoff may be at risk.",
    confidence: 86,
  },
];

function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254) {
    throw new EmailIntelligenceError("A valid email address is required.");
  }
  return normalized;
}

function normalizeForwarders(values: unknown): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_FORWARDERS) {
    throw new EmailIntelligenceError(`Provide between 1 and ${MAX_FORWARDERS} authorized forwarders.`);
  }
  return [...new Set(values.map((value) => {
    if (typeof value !== "string") throw new EmailIntelligenceError("Authorized forwarders must be email addresses or @domain entries.");
    const normalized = value.trim().toLowerCase();
    if (normalized.startsWith("@")) {
      if (!/^@[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized)) {
        throw new EmailIntelligenceError("An authorized forwarding domain is invalid.");
      }
      return normalized;
    }
    return normalizeEmail(normalized);
  }))];
}

function isAllowedForwarder(source: EmailIntelligenceSource, forwardedBy: string): boolean {
  const normalized = normalizeEmail(forwardedBy);
  return source.allowedForwarders.some((entry) =>
    entry.startsWith("@") ? normalized.endsWith(entry) : normalized === entry,
  );
}

function intakeDomain(): string {
  return process.env.EMAIL_INGESTION_DOMAIN?.trim().toLowerCase() || DEFAULT_DOMAIN;
}

function providerConfigured(): boolean {
  return Boolean(
    process.env.EMAIL_INGESTION_DOMAIN?.trim() &&
      process.env.EMAIL_INGESTION_WEBHOOK_SECRET?.trim() &&
      process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY?.trim(),
  );
}

function sourceView(source: EmailIntelligenceSource) {
  return {
    ...source,
    intakeAddress: `${source.intakeAlias}@${intakeDomain()}`,
  };
}

export function redactEmailText(value: string): string {
  return value
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "<payment-card>")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<email>")
    .replace(/(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g, "<phone>")
    .replace(/\b(api[_ -]?key|password|passcode|secret|token)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function excerptForMatch(text: string, matchIndex: number): string {
  const start = Math.max(0, matchIndex - 100);
  const end = Math.min(text.length, matchIndex + 220);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`.slice(0, 360);
}

export function deriveEmailFacts(subject: string, text: string): DerivedEmailFact[] {
  const redacted = redactEmailText(`${subject}\n${text}`).slice(0, MAX_TEXT_BYTES);
  // Email providers may insert hard line breaks while decoding MIME bodies.
  // Classify against whitespace-normalized text so phrases such as
  // "ready to move\nforward" keep their meaning after transport.
  const searchable = redacted.replace(/\s+/g, " ").trim();
  const facts: DerivedEmailFact[] = [];
  for (const rule of FACT_RULES) {
    const match = rule.pattern.exec(searchable);
    if (!match || match.index === undefined) continue;
    facts.push({
      kind: rule.kind,
      statement: rule.statement,
      evidenceExcerpt: excerptForMatch(searchable, match.index),
      confidence: rule.confidence,
    });
  }
  return facts;
}

export function verifyEmailWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  now = Date.now(),
): boolean {
  const secret = process.env.EMAIL_INGESTION_WEBHOOK_SECRET?.trim();
  if (!secret || !signatureHeader) return false;
  const values = Object.fromEntries(
    signatureHeader.split(",").map((part) => {
      const [key, ...rest] = part.trim().split("=");
      return [key, rest.join("=")];
    }),
  );
  const timestamp = Number(values.t);
  const supplied = values.v1;
  if (!Number.isFinite(timestamp) || !supplied) return false;
  if (Math.abs(Math.floor(now / 1000) - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest("hex");
  const suppliedBuffer = Buffer.from(supplied, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

export async function getEmailIntelligenceStatus(organizationId: string) {
  await purgeExpiredEmailContent();
  const [source] = await db
    .select()
    .from(emailIntelligenceSourcesTable)
    .where(eq(emailIntelligenceSourcesTable.organizationId, organizationId))
    .limit(1);
  if (!source) {
    return {
      source: null,
      providerConfigured: providerConfigured(),
      messagesAccepted: 0,
      factsAwaitingReview: 0,
      rawMessagesHeld: 0,
    };
  }
  const messages = await db
    .select({ id: emailIntelligenceMessagesTable.id, encryptedRawText: emailIntelligenceMessagesTable.encryptedRawText })
    .from(emailIntelligenceMessagesTable)
    .where(eq(emailIntelligenceMessagesTable.organizationId, organizationId));
  const pendingFacts = await db
    .select({ id: emailIntelligenceFactsTable.id })
    .from(emailIntelligenceFactsTable)
    .where(and(
      eq(emailIntelligenceFactsTable.organizationId, organizationId),
      eq(emailIntelligenceFactsTable.status, "needs_review"),
    ));
  return {
    source: sourceView(source),
    providerConfigured: providerConfigured(),
    messagesAccepted: messages.length,
    factsAwaitingReview: pendingFacts.length,
    rawMessagesHeld: messages.filter((message) => Boolean(message.encryptedRawText)).length,
  };
}

export async function createEmailIntelligenceSource(params: {
  organizationId: string;
  userId: string;
  allowedForwarders: unknown;
}) {
  const existing = await getEmailIntelligenceStatus(params.organizationId);
  if (existing.source) return existing;
  const allowedForwarders = normalizeForwarders(params.allowedForwarders);
  const intakeAlias = `mf-${randomBytes(15).toString("hex")}`;
  const [source] = await db
    .insert(emailIntelligenceSourcesTable)
    .values({
      organizationId: params.organizationId,
      intakeAlias,
      allowedForwarders,
      status: "pending",
      retentionDays: 7,
      attachmentsEnabled: false,
      createdByUserId: params.userId,
      updatedByUserId: params.userId,
    })
    .returning();
  await recordAudit({
    organizationId: params.organizationId,
    actorUserId: params.userId,
    action: "email_intelligence.source_created",
    entityType: "email_intelligence_source",
    entityId: source!.id,
    metadata: { retentionDays: 7, attachmentMode: "disabled", allowedForwarderCount: allowedForwarders.length },
  });
  return getEmailIntelligenceStatus(params.organizationId);
}

export async function updateEmailIntelligenceSource(params: {
  organizationId: string;
  sourceId: string;
  userId: string;
  allowedForwarders?: unknown;
  retentionDays?: unknown;
  status?: unknown;
}) {
  const patch: Partial<typeof emailIntelligenceSourcesTable.$inferInsert> = {
    updatedByUserId: params.userId,
  };
  if (params.allowedForwarders !== undefined) {
    patch.allowedForwarders = normalizeForwarders(params.allowedForwarders);
  }
  if (params.retentionDays !== undefined) {
    if (!Number.isInteger(params.retentionDays) || Number(params.retentionDays) < 1 || Number(params.retentionDays) > 30) {
      throw new EmailIntelligenceError("Raw retention must be between 1 and 30 days.");
    }
    patch.retentionDays = Number(params.retentionDays);
  }
  if (params.status !== undefined) {
    if (!(["pending", "active", "paused"] as const).includes(params.status as "pending" | "active" | "paused")) {
      throw new EmailIntelligenceError("The requested source status is invalid.");
    }
    if (params.status === "active" && !providerConfigured()) {
      throw new EmailIntelligenceError(
        "The inbound provider bridge, domain, and encryption key must be configured before activation.",
        409,
        "provider_not_configured",
      );
    }
    patch.status = params.status as "pending" | "active" | "paused";
  }
  const [updated] = await db
    .update(emailIntelligenceSourcesTable)
    .set(patch)
    .where(and(
      eq(emailIntelligenceSourcesTable.id, params.sourceId),
      eq(emailIntelligenceSourcesTable.organizationId, params.organizationId),
    ))
    .returning();
  if (!updated) throw new EmailIntelligenceError("Email intelligence source not found.", 404, "not_found");
  await recordAudit({
    organizationId: params.organizationId,
    actorUserId: params.userId,
    action: "email_intelligence.source_updated",
    entityType: "email_intelligence_source",
    entityId: updated.id,
    metadata: {
      status: updated.status,
      retentionDays: updated.retentionDays,
      attachmentMode: updated.attachmentsEnabled ? "enabled" : "disabled",
      allowedForwarderCount: updated.allowedForwarders.length,
    },
  });
  return getEmailIntelligenceStatus(params.organizationId);
}

function validatePayload(payload: EmailIntelligencePayload): EmailIntelligencePayload {
  if (!payload || typeof payload !== "object") throw new EmailIntelligenceError("Email payload is required.");
  if (typeof payload.externalMessageId !== "string" || !payload.externalMessageId.trim() || payload.externalMessageId.length > 500) {
    throw new EmailIntelligenceError("A bounded external message id is required.");
  }
  if (typeof payload.forwardedBy !== "string" || typeof payload.from !== "string") throw new EmailIntelligenceError("Email identities must be strings.");
  const forwardedBy = normalizeEmail(payload.forwardedBy);
  const from = normalizeEmail(payload.from);
  if (!Array.isArray(payload.to) || payload.to.length === 0 || payload.to.length > MAX_RECIPIENTS) {
    throw new EmailIntelligenceError(`Provide between 1 and ${MAX_RECIPIENTS} recipients.`);
  }
  if (payload.to.some(value => typeof value !== "string")) throw new EmailIntelligenceError("Recipients must be email strings.");
  const to = payload.to.map(normalizeEmail);
  if (typeof payload.subject !== "string" || payload.subject.length > 1_000) {
    throw new EmailIntelligenceError("The email subject is invalid.");
  }
  if (typeof payload.text !== "string" || Buffer.byteLength(payload.text, "utf8") > MAX_TEXT_BYTES) {
    throw new EmailIntelligenceError(`Plain-text email content must not exceed ${MAX_TEXT_BYTES} bytes.`);
  }
  if ((payload.attachmentCount ?? 0) > 0) {
    throw new EmailIntelligenceError("Attachments are disabled for the founding beta.", 422, "attachments_disabled");
  }
  if (payload.sentAt != null && !z.iso.datetime({ offset: true }).safeParse(payload.sentAt).success) {
    throw new EmailIntelligenceError("The sent timestamp is invalid.");
  }
  let replyTo: VerifiedReplyParent | null = null;
  if (payload.replyTo != null) {
    const parent = payload.replyTo;
    if (typeof parent !== "object" || !["gmail", "microsoft"].includes(parent.provider) ||
        typeof parent.outboundMessageId !== "string" || !parent.outboundMessageId.trim() || parent.outboundMessageId.length > 500 ||
        typeof parent.senderEmail !== "string" || Object.keys(parent).some(key => !["provider", "outboundMessageId", "senderEmail"].includes(key)))
      throw new EmailIntelligenceError("Reply parent requires the original provider, message ID, and sending mailbox.");
    replyTo = { provider: parent.provider, outboundMessageId: parent.outboundMessageId.trim(), senderEmail: normalizeEmail(parent.senderEmail) };
  }
  return { ...payload, externalMessageId: payload.externalMessageId.trim(), forwardedBy, from, to, replyTo };
}

async function ingestForSource(
  source: EmailIntelligenceSource,
  input: EmailIntelligencePayload,
  options: { synthetic?: boolean; actorUserId?: string | null } = {},
) {
  if (source.status === "paused" || source.status === "error") {
    throw new EmailIntelligenceError("This email intelligence source is not accepting messages.", 409, "source_inactive");
  }
  if (!options.synthetic && source.status !== "active") {
    throw new EmailIntelligenceError("This email intelligence source is not active.", 409, "source_inactive");
  }
  const payload = validatePayload(input);
  if (!isAllowedForwarder(source, payload.forwardedBy)) {
    await db.update(emailIntelligenceSourcesTable).set({
      lastErrorAt: new Date(),
      lastErrorCode: "forwarder_not_allowed",
    }).where(eq(emailIntelligenceSourcesTable.id, source.id));
    throw new EmailIntelligenceError("The forwarding identity is not authorized for this source.", 403, "forwarder_not_allowed");
  }

  const rawText = JSON.stringify({
    from: payload.from,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    sentAt: payload.sentAt ?? null,
  });
  const messageId = randomUUID();
  const contentSha256 = createHash("sha256").update(rawText, "utf8").digest("hex");
  const encryptedRawText = encryptEmailContent(
    rawText,
    `${source.organizationId}:${source.id}:${messageId}:email`,
  );
  const rawExpiresAt = new Date(Date.now() + source.retentionDays * 24 * 60 * 60 * 1000);
  const payloadSha256 = createHash("sha256").update(JSON.stringify({ rawText, forwardedBy: payload.forwardedBy, replyTo: payload.replyTo ?? null })).digest("hex");
  return db.transaction(async tx => {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`email-intake:${source.organizationId}:${source.id}:${payload.externalMessageId}`}, 0))`);
  const [prior] = await tx.select().from(emailResponseReviewsTable).where(and(
    eq(emailResponseReviewsTable.organizationId, source.organizationId), eq(emailResponseReviewsTable.sourceId, source.id),
    eq(emailResponseReviewsTable.externalMessageId, payload.externalMessageId),
  ));
  if (prior) {
    if (prior.payloadSha256 !== payloadSha256) throw new EmailIntelligenceError("This message ID was already received with different content or reply evidence.", 409, "message_conflict");
    return { duplicate: true, message: { id: prior.messageId }, facts: [], response: prior };
  }
  const [message] = await tx
    .insert(emailIntelligenceMessagesTable)
    .values({
      id: messageId,
      organizationId: source.organizationId,
      sourceId: source.id,
      externalMessageId: payload.externalMessageId,
      contentSha256,
      forwardedBy: payload.forwardedBy,
      fromEmail: payload.from,
      toEmails: payload.to,
      redactedSubject: redactEmailText(payload.subject),
      encryptedRawText,
      sentAt: payload.sentAt ? new Date(payload.sentAt) : null,
      rawExpiresAt,
    })
    .onConflictDoNothing({
      target: [emailIntelligenceMessagesTable.sourceId, emailIntelligenceMessagesTable.externalMessageId],
    })
    .returning();
  if (!message) {
    const [existing] = await tx
      .select()
      .from(emailIntelligenceMessagesTable)
      .where(and(
        eq(emailIntelligenceMessagesTable.sourceId, source.id),
        eq(emailIntelligenceMessagesTable.externalMessageId, payload.externalMessageId),
      ))
      .limit(1);
    if (!existing || existing.contentSha256 !== contentSha256) throw new EmailIntelligenceError("This message ID conflicts with its original content.", 409, "message_conflict");
    const response = await registerEmailResponse(tx, { organizationId: source.organizationId, sourceId: source.id, messageId: existing.id,
      externalMessageId: payload.externalMessageId, payloadSha256, from: payload.from, to: payload.to,
      sentAt: existing.sentAt, legacy: true });
    return { duplicate: true, message: existing, facts: [], response };
  }

  const derived = deriveEmailFacts(payload.subject, payload.text);
  const facts = derived.length
    ? await tx.insert(emailIntelligenceFactsTable).values(derived.map((fact) => ({
        organizationId: source.organizationId,
        sourceId: source.id,
        messageId: message.id,
        kind: fact.kind,
        statement: fact.statement,
        evidenceExcerpt: fact.evidenceExcerpt,
        confidence: fact.confidence,
      }))).returning()
    : [];
  await tx.update(emailIntelligenceSourcesTable).set({
    lastReceivedAt: new Date(),
    lastErrorAt: null,
    lastErrorCode: null,
  }).where(eq(emailIntelligenceSourcesTable.id, source.id));
  const response = await registerEmailResponse(tx, { organizationId: source.organizationId, sourceId: source.id, messageId: message.id,
    externalMessageId: payload.externalMessageId, payloadSha256, from: payload.from, to: payload.to,
    sentAt: message.sentAt, replyTo: payload.replyTo, synthetic: options.synthetic });
  await tx.insert(auditEventsTable).values({
    organizationId: source.organizationId,
    actorUserId: options.actorUserId ?? null,
    action: options.synthetic ? "email_intelligence.synthetic_message_processed" : "email_intelligence.message_processed",
    entityType: "email_intelligence_message",
    entityId: message.id,
    metadata: {
      sourceId: source.id,
      contentSha256,
      factCount: facts.length,
      retentionDays: source.retentionDays,
      attachmentCount: 0,
    },
  });
  return { duplicate: false, message, facts, response };
  });
}

export async function ingestEmailByAlias(alias: string, payload: EmailIntelligencePayload) {
  const [source] = await db
    .select()
    .from(emailIntelligenceSourcesTable)
    .where(eq(emailIntelligenceSourcesTable.intakeAlias, alias.toLowerCase()))
    .limit(1);
  if (!source) throw new EmailIntelligenceError("Email intelligence source not found.", 404, "not_found");
  return ingestForSource(source, payload);
}

export async function ingestSyntheticEmail(organizationId: string, userId: string) {
  const [source] = await db
    .select()
    .from(emailIntelligenceSourcesTable)
    .where(eq(emailIntelligenceSourcesTable.organizationId, organizationId))
    .limit(1);
  if (!source) throw new EmailIntelligenceError("Create an Email Intelligence Inbox first.", 409, "source_missing");
  return ingestForSource(source, {
    externalMessageId: `synthetic-${randomUUID()}`,
    forwardedBy: source.allowedForwarders[0]!,
    from: "prospect@example.test",
    to: ["sales@example.test"],
    subject: "Synthetic beta estimate request",
    text: "Please send an estimate. We are ready to move forward. I'll follow up tomorrow. Call 555-555-0199 or email prospect@example.test.",
    sentAt: new Date().toISOString(),
    attachmentCount: 0,
  }, { synthetic: true, actorUserId: userId });
}

export async function listEmailIntelligenceMessages(organizationId: string, limit = 25) {
  await purgeExpiredEmailContent();
  const messages = await db
    .select({
      id: emailIntelligenceMessagesTable.id,
      sourceId: emailIntelligenceMessagesTable.sourceId,
      fromEmail: emailIntelligenceMessagesTable.fromEmail,
      forwardedBy: emailIntelligenceMessagesTable.forwardedBy,
      redactedSubject: emailIntelligenceMessagesTable.redactedSubject,
      status: emailIntelligenceMessagesTable.status,
      receivedAt: emailIntelligenceMessagesTable.receivedAt,
      rawExpiresAt: emailIntelligenceMessagesTable.rawExpiresAt,
      rawPurgedAt: emailIntelligenceMessagesTable.rawPurgedAt,
      rawAvailable: emailIntelligenceMessagesTable.encryptedRawText,
    })
    .from(emailIntelligenceMessagesTable)
    .where(eq(emailIntelligenceMessagesTable.organizationId, organizationId))
    .orderBy(desc(emailIntelligenceMessagesTable.receivedAt))
    .limit(Math.max(1, Math.min(100, limit)));
  const messageIds = messages.map((message) => message.id);
  const facts = messageIds.length
    ? await db
        .select()
        .from(emailIntelligenceFactsTable)
        .where(and(
          eq(emailIntelligenceFactsTable.organizationId, organizationId),
          inArray(emailIntelligenceFactsTable.messageId, messageIds),
        ))
        .orderBy(desc(emailIntelligenceFactsTable.createdAt))
    : [];
  return messages.map(({ rawAvailable, ...message }) => ({
    ...message,
    rawAvailable: Boolean(rawAvailable),
    facts: facts.filter((fact) => fact.messageId === message.id),
  }));
}

export async function purgeExpiredEmailContent(now = new Date()): Promise<number> {
  const purged = await db
    .update(emailIntelligenceMessagesTable)
    .set({ encryptedRawText: null, rawPurgedAt: now, status: "raw_purged" })
    .where(and(
      lt(emailIntelligenceMessagesTable.rawExpiresAt, now),
      eq(emailIntelligenceMessagesTable.status, "processed"),
    ))
    .returning({ id: emailIntelligenceMessagesTable.id });
  return purged.length;
}

export async function purgeEmailMessageRawContent(
  organizationId: string,
  messageId: string,
  userId: string,
) {
  const [message] = await db
    .update(emailIntelligenceMessagesTable)
    .set({ encryptedRawText: null, rawPurgedAt: new Date(), status: "raw_purged" })
    .where(and(
      eq(emailIntelligenceMessagesTable.id, messageId),
      eq(emailIntelligenceMessagesTable.organizationId, organizationId),
    ))
    .returning({ id: emailIntelligenceMessagesTable.id });
  if (!message) throw new EmailIntelligenceError("Email message not found.", 404, "not_found");
  await recordAudit({
    organizationId,
    actorUserId: userId,
    action: "email_intelligence.raw_content_purged",
    entityType: "email_intelligence_message",
    entityId: message.id,
  });
  return { success: true, messageId: message.id };
}

export async function deleteEmailIntelligenceMessage(
  organizationId: string,
  messageId: string,
  userId: string,
) {
  const [message] = await db
    .delete(emailIntelligenceMessagesTable)
    .where(and(
      eq(emailIntelligenceMessagesTable.id, messageId),
      eq(emailIntelligenceMessagesTable.organizationId, organizationId),
    ))
    .returning({ id: emailIntelligenceMessagesTable.id, contentSha256: emailIntelligenceMessagesTable.contentSha256 });
  if (!message) throw new EmailIntelligenceError("Email message not found.", 404, "not_found");
  await recordAudit({
    organizationId,
    actorUserId: userId,
    action: "email_intelligence.message_deleted",
    entityType: "email_intelligence_message",
    entityId: message.id,
    metadata: { contentSha256: message.contentSha256, derivedFactsDeleted: true },
  });
  return { success: true, messageId: message.id };
}

export async function reviewEmailIntelligenceFact(params: {
  organizationId: string;
  factId: string;
  userId: string;
  status: EmailIntelligenceFactStatus;
}) {
  if (params.status !== "verified" && params.status !== "rejected") {
    throw new EmailIntelligenceError("Fact review must verify or reject the finding.");
  }
  const [fact] = await db
    .update(emailIntelligenceFactsTable)
    .set({ status: params.status, reviewedByUserId: params.userId, reviewedAt: new Date() })
    .where(and(
      eq(emailIntelligenceFactsTable.id, params.factId),
      eq(emailIntelligenceFactsTable.organizationId, params.organizationId),
    ))
    .returning();
  if (!fact) throw new EmailIntelligenceError("Email intelligence fact not found.", 404, "not_found");
  await recordAudit({
    organizationId: params.organizationId,
    actorUserId: params.userId,
    action: `email_intelligence.fact_${params.status}`,
    entityType: "email_intelligence_fact",
    entityId: fact.id,
    metadata: { kind: fact.kind, messageId: fact.messageId, confidence: fact.confidence },
  });
  return fact;
}
