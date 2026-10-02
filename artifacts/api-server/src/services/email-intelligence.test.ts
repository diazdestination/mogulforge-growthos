import { createHmac } from "node:crypto";

import {
  db,
  emailIntelligenceFactsTable,
  emailIntelligenceMessagesTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  createEmailIntelligenceSource,
  deleteEmailIntelligenceMessage,
  deriveEmailFacts,
  EmailIntelligenceError,
  getEmailIntelligenceStatus,
  ingestEmailByAlias,
  ingestSyntheticEmail,
  listEmailIntelligenceMessages,
  purgeExpiredEmailContent,
  purgeEmailMessageRawContent,
  redactEmailText,
  reviewEmailIntelligenceFact,
  updateEmailIntelligenceSource,
  verifyEmailWebhookSignature,
} from "./email-intelligence";

const previousEnvironment = {
  key: process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY,
  domain: process.env.EMAIL_INGESTION_DOMAIN,
  webhook: process.env.EMAIL_INGESTION_WEBHOOK_SECRET,
};
const orgIds: string[] = [];
const userIds: string[] = [];

beforeAll(async () => {
  process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY = Buffer.alloc(32, 29).toString("base64");
  delete process.env.EMAIL_INGESTION_DOMAIN;
  delete process.env.EMAIL_INGESTION_WEBHOOK_SECRET;
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (const suffix of ["a", "b"]) {
    const [org] = await db.insert(organizationsTable).values({
      name: `Email intelligence tenant ${suffix}`,
      slug: `test-email-intelligence-${suffix}-${nonce}`,
    }).returning();
    const userId = `email-intelligence-user-${suffix}-${nonce}`;
    await db.insert(usersTable).values({
      id: userId,
      email: `owner-${suffix}@example.test`,
      organizationId: org!.id,
      role: "owner",
    });
    orgIds.push(org!.id);
    userIds.push(userId);
    await createEmailIntelligenceSource({
      organizationId: org!.id,
      userId,
      allowedForwarders: [`owner-${suffix}@example.test`],
    });
  }
});

afterAll(async () => {
  for (let index = 0; index < userIds.length; index += 1) {
    await db.update(usersTable).set({ organizationId: null }).where(eq(usersTable.id, userIds[index]!));
    await deleteTestOrgs(orgIds[index]!);
    await db.delete(usersTable).where(eq(usersTable.id, userIds[index]!));
  }
  if (previousEnvironment.key === undefined) delete process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY;
  else process.env.EMAIL_INTELLIGENCE_ENCRYPTION_KEY = previousEnvironment.key;
  if (previousEnvironment.domain === undefined) delete process.env.EMAIL_INGESTION_DOMAIN;
  else process.env.EMAIL_INGESTION_DOMAIN = previousEnvironment.domain;
  if (previousEnvironment.webhook === undefined) delete process.env.EMAIL_INGESTION_WEBHOOK_SECRET;
  else process.env.EMAIL_INGESTION_WEBHOOK_SECRET = previousEnvironment.webhook;
});

describe("email intelligence safety primitives", () => {
  it("redacts direct identifiers and derives only review-required deterministic facts", () => {
    const redacted = redactEmailText(
      "Email jane@example.com or call (404) 555-0112. password: hunter2. Card 4242 4242 4242 4242.",
    );
    expect(redacted).not.toContain("jane@example.com");
    expect(redacted).not.toContain("404");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("4242");

    const facts = deriveEmailFacts(
      "Quote request",
      "Please send an estimate. We are ready to move forward, but the last option was too expensive.",
    );
    expect(facts.map((fact) => fact.kind)).toEqual(
      expect.arrayContaining(["estimate_request", "buying_signal", "price_objection"]),
    );
    expect(facts.every((fact) => fact.confidence < 100)).toBe(true);
  });

  it("preserves buying signals split by provider MIME line wrapping", () => {
    const facts = deriveEmailFacts(
      "Provider-delivered request",
      "Please send an estimate. We are ready to move\nforward, and I will follow\nup tomorrow.",
    );

    expect(facts.map((fact) => fact.kind)).toEqual(
      expect.arrayContaining(["estimate_request", "buying_signal", "follow_up_commitment"]),
    );
    expect(facts.every((fact) => !fact.evidenceExcerpt.includes("\n"))).toBe(true);
  });

  it("rejects tampered and stale provider signatures", () => {
    process.env.EMAIL_INGESTION_WEBHOOK_SECRET = "test-webhook-secret";
    const body = Buffer.from('{"message":"safe"}');
    const now = Date.now();
    const timestamp = Math.floor(now / 1000);
    const signature = createHmac("sha256", "test-webhook-secret")
      .update(`${timestamp}.`)
      .update(body)
      .digest("hex");
    expect(verifyEmailWebhookSignature(body, `t=${timestamp},v1=${signature}`, now)).toBe(true);
    expect(verifyEmailWebhookSignature(Buffer.from("tampered"), `t=${timestamp},v1=${signature}`, now)).toBe(false);
    expect(verifyEmailWebhookSignature(body, `t=${timestamp - 1_000},v1=${signature}`, now)).toBe(false);
  });
});

describe("tenant-scoped Email Intelligence Inbox", () => {
  it("keeps source status and messages isolated by organization", async () => {
    const statusA = await getEmailIntelligenceStatus(orgIds[0]!);
    const statusB = await getEmailIntelligenceStatus(orgIds[1]!);
    expect(statusA.source?.organizationId).toBe(orgIds[0]);
    expect(statusB.source?.organizationId).toBe(orgIds[1]);
    expect(statusA.source?.intakeAddress).not.toBe(statusB.source?.intakeAddress);
    expect(statusA.source?.retentionDays).toBe(7);
    expect(statusA.providerConfigured).toBe(false);

    const result = await ingestSyntheticEmail(orgIds[0]!, userIds[0]!);
    expect(result.duplicate).toBe(false);
    expect(result.facts.map((fact) => fact.kind)).toEqual(
      expect.arrayContaining(["estimate_request", "buying_signal", "follow_up_commitment"]),
    );
    const messagesA = await listEmailIntelligenceMessages(orgIds[0]!);
    const messagesB = await listEmailIntelligenceMessages(orgIds[1]!);
    expect(messagesA).toHaveLength(1);
    expect(messagesA[0]?.rawAvailable).toBe(true);
    expect(messagesA[0]?.facts.every((fact) => fact.status === "needs_review")).toBe(true);
    expect(messagesA[0]?.facts.map((fact) => fact.evidenceExcerpt).join(" ")).not.toContain("555-555-0199");
    expect(messagesA[0]?.facts.map((fact) => fact.evidenceExcerpt).join(" ")).not.toContain("prospect@example.test");
    expect(messagesB).toHaveLength(0);
  });

  it("requires an authorized forwarder and makes provider deliveries idempotent", async () => {
    process.env.EMAIL_INGESTION_DOMAIN = "intake.example.test";
    process.env.EMAIL_INGESTION_WEBHOOK_SECRET = "test-webhook-secret";
    const status = await getEmailIntelligenceStatus(orgIds[0]!);
    await updateEmailIntelligenceSource({
      organizationId: orgIds[0]!,
      sourceId: status.source!.id,
      userId: userIds[0]!,
      status: "active",
    });
    const payload = {
      externalMessageId: "provider-message-1",
      forwardedBy: "owner-a@example.test",
      from: "customer@example.test",
      to: ["sales@example.test"],
      subject: "Need a proposal",
      text: "Please send a proposal.",
      attachmentCount: 0,
    };
    const first = await ingestEmailByAlias(status.source!.intakeAlias, payload);
    const duplicate = await ingestEmailByAlias(status.source!.intakeAlias, payload);
    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);

    await expect(ingestEmailByAlias(status.source!.intakeAlias, {
      ...payload,
      externalMessageId: "provider-message-2",
      forwardedBy: "attacker@example.test",
    })).rejects.toMatchObject({ statusCode: 403, code: "forwarder_not_allowed" });
    await expect(ingestEmailByAlias(status.source!.intakeAlias, {
      ...payload,
      externalMessageId: "provider-message-3",
      attachmentCount: 1,
    })).rejects.toMatchObject({ statusCode: 422, code: "attachments_disabled" });
  });

  it("allows tenant-scoped review and irreversible raw-content purge", async () => {
    const [message] = await db
      .select()
      .from(emailIntelligenceMessagesTable)
      .where(eq(emailIntelligenceMessagesTable.organizationId, orgIds[0]!))
      .limit(1);
    const [fact] = await db
      .select()
      .from(emailIntelligenceFactsTable)
      .where(and(
        eq(emailIntelligenceFactsTable.organizationId, orgIds[0]!),
        eq(emailIntelligenceFactsTable.messageId, message!.id),
      ))
      .limit(1);
    await expect(reviewEmailIntelligenceFact({
      organizationId: orgIds[1]!,
      factId: fact!.id,
      userId: userIds[1]!,
      status: "verified",
    })).rejects.toBeInstanceOf(EmailIntelligenceError);
    const reviewed = await reviewEmailIntelligenceFact({
      organizationId: orgIds[0]!,
      factId: fact!.id,
      userId: userIds[0]!,
      status: "verified",
    });
    expect(reviewed.status).toBe("verified");

    await expect(purgeEmailMessageRawContent(orgIds[1]!, message!.id, userIds[1]!))
      .rejects.toBeInstanceOf(EmailIntelligenceError);
    await purgeEmailMessageRawContent(orgIds[0]!, message!.id, userIds[0]!);
    const [purged] = await db
      .select()
      .from(emailIntelligenceMessagesTable)
      .where(eq(emailIntelligenceMessagesTable.id, message!.id));
    expect(purged?.encryptedRawText).toBeNull();
    expect(purged?.status).toBe("raw_purged");

    await deleteEmailIntelligenceMessage(orgIds[0]!, message!.id, userIds[0]!);
    const [deletedMessage] = await db
      .select({ id: emailIntelligenceMessagesTable.id })
      .from(emailIntelligenceMessagesTable)
      .where(eq(emailIntelligenceMessagesTable.id, message!.id));
    const [deletedFact] = await db
      .select({ id: emailIntelligenceFactsTable.id })
      .from(emailIntelligenceFactsTable)
      .where(eq(emailIntelligenceFactsTable.id, fact!.id));
    expect(deletedMessage).toBeUndefined();
    expect(deletedFact).toBeUndefined();
  });

  it("purges encrypted raw content after its retention deadline", async () => {
    const ingested = await ingestSyntheticEmail(orgIds[0]!, userIds[0]!);
    const expiredAt = new Date(Date.now() - 60_000);
    await db
      .update(emailIntelligenceMessagesTable)
      .set({ rawExpiresAt: expiredAt })
      .where(eq(emailIntelligenceMessagesTable.id, ingested.message.id!));

    const purgedCount = await purgeExpiredEmailContent(new Date());
    expect(purgedCount).toBe(1);

    const [purged] = await db
      .select()
      .from(emailIntelligenceMessagesTable)
      .where(eq(emailIntelligenceMessagesTable.id, ingested.message.id!));
    expect(purged?.encryptedRawText).toBeNull();
    expect(purged?.rawPurgedAt).toBeInstanceOf(Date);
    expect(purged?.status).toBe("raw_purged");
  });
});
