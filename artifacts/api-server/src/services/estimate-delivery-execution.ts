import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  auditEventsTable,
  revenueExecutionsTable,
  revenueExecutionEventsTable,
  estimatesTable,
  activitiesTable,
  usersTable,
  userRoleEnum,
  type AuditEvent,
} from "@workspace/db";
import { lockCustomerWork, type CustomerWorkTx } from "./customer-work-lineage";
import {
  readEstimateEmailAuthority,
  assertEstimateEmailEligibility,
} from "./estimate-delivery-authority";
import {
  estimateSavedStateDigest,
  recordEstimateSavedState,
} from "./estimate-delivery-history";
import {
  EstimateDeliveryError,
  estimateDeliveryFingerprint,
  estimateDeliverySendSchema,
  estimateEmailSnapshotSchema,
  estimateEmailReviewMetadataSchema,
  ESTIMATE_EMAIL_REVIEW_ACTION,
  ESTIMATE_EMAIL_PREVIEW_MS,
  type EstimateDeliveryActor,
  type EstimateEmailSnapshot,
} from "./estimate-delivery-contract";
import type { UserEmailResult } from "./user-email";

export {
  estimateEmailReviewMetadataSchema,
  ESTIMATE_EMAIL_REVIEW_ACTION,
  ESTIMATE_EMAIL_PREVIEW_MS,
} from "./estimate-delivery-contract";
export const ESTIMATE_EMAIL_ADMISSION_ACTION = "estimate_delivery.admitted";
export const ESTIMATE_EMAIL_PROOF_ACTION =
  "estimate_delivery.provider_accepted";
const executionMs = 900_000;
const executionStates = [
  "processing",
  "succeeded",
  "blocked",
  "indeterminate",
  "confirmed_succeeded",
  "confirmed_not_performed",
] as const;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime({ offset: true });
const actorSchema = z
  .object({
    userId: z.uuid(),
    effectiveRole: z.enum(["office", "admin", "owner"]).optional(),
  })
  .strict();
export const estimateEmailAdmissionMetadataSchema = z
  .object({
    version: z.literal(1),
    executionId: z.uuid(),
    previewId: z.uuid(),
    payloadSha256: sha,
    actionKey: z.string(),
    actor: actorSchema,
    snapshot: estimateEmailSnapshotSchema,
    estimateSha256: sha,
  })
  .strict();
const providerId = z
  .string()
  .min(1)
  .max(1000)
  .regex(/^[^\r\n\x00-\x1f\x7f]+$/);
const receiptSchema = z
  .object({
    id: providerId.nullable(),
    provider: z.enum(["gmail", "microsoft"]),
    senderEmail: z.email(),
    acceptance: z.literal("accepted"),
    providerRequestId: providerId.nullable().optional(),
    clientRequestId: providerId.optional(),
  })
  .strict();
export const estimateEmailProofMetadataSchema =
  estimateEmailAdmissionMetadataSchema
    .extend({ receipt: receiptSchema, acceptedAt: timestamp })
    .strict();
export type EstimateEmailClaim = {
  executionId: string;
  snapshot: EstimateEmailSnapshot;
  payloadSha256: string;
  actor: EstimateDeliveryActor;
};
export type EstimateEmailOutcome =
  | { state: "accepted"; receipt: UserEmailResult; acceptedAt: Date }
  | { state: "held" | "uncertain"; reason: string };
function fail(
  code = "estimate_delivery_integrity",
  message = "The retained estimate delivery evidence is unavailable or inconsistent.",
): never {
  throw new EstimateDeliveryError(409, code, message);
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) fail();
  return result.data;
}
export const estimateEmailActionKey = (estimateId: string) =>
  `estimate-delivery:${estimateId}:email`;
function auditMatches(a: AuditEvent, s: EstimateEmailSnapshot, action: string) {
  return (
    a.organizationId === s.organizationId &&
    a.entityType === "estimate" &&
    a.entityId === s.estimateId &&
    a.actorUserId === s.actorUserId &&
    a.action === action
  );
}
function validateReview(
  a: AuditEvent,
  s: EstimateEmailSnapshot,
  hash: string,
  live: boolean,
) {
  const m = parse(estimateEmailReviewMetadataSchema, a.metadata);
  const expires = Date.parse(m.expiresAt);
  if (
    !auditMatches(a, s, ESTIMATE_EMAIL_REVIEW_ACTION) ||
    m.payloadSha256 !== hash ||
    estimateDeliveryFingerprint(m.snapshot) !== hash ||
    estimateDeliveryFingerprint(s) !== hash ||
    expires !== a.createdAt.getTime() + ESTIMATE_EMAIL_PREVIEW_MS
  )
    fail();
  if (live && (Date.now() >= expires || a.createdAt.getTime() > Date.now()))
    fail("estimate_review_expired", "This estimate review has expired.");
  return m;
}
async function effectLock(tx: CustomerWorkTx, org: string, id: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${org}:${estimateEmailActionKey(id)}`},0))`,
  );
}
/** A permanent unique key is never deleted, recycled or leased to a second executor. */
export async function claimEstimateEmail(
  org: string,
  actor: EstimateDeliveryActor,
  estimateId: string,
  send: { previewId: string; payloadSha256: string; confirmed: true },
): Promise<EstimateEmailClaim> {
  const input = parse(estimateDeliverySendSchema, send),
    parsedActor = parse(
      z
        .object({
          userId: z.uuid(),
          effectiveRole: z.enum(userRoleEnum.enumValues).optional(),
        })
        .strict(),
      actor,
    );
  // JSON drops undefined optional fields; return the same durable actor shape.
  const approvedActor: EstimateDeliveryActor = {
    userId: parsedActor.userId,
    ...(parsedActor.effectiveRole
      ? { effectiveRole: parsedActor.effectiveRole }
      : {}),
  };
  return db.transaction(async (tx) => {
    // Resolve PostgreSQL UUIDs to their canonical stored spelling before any text keys.
    const [target] = await tx
      .select({
        id: estimatesTable.id,
        organizationId: estimatesTable.organizationId,
      })
      .from(estimatesTable)
      .where(
        and(
          eq(estimatesTable.id, estimateId),
          eq(estimatesTable.organizationId, org),
        ),
      );
    if (!target)
      fail("estimate_not_found", "The saved estimate is unavailable.");
    await lockCustomerWork(tx, target.organizationId);
    await effectLock(tx, target.organizationId, target.id);
    const key = estimateEmailActionKey(target.id);
    const reserved = await tx
      .select()
      .from(revenueExecutionsTable)
      .where(
        and(
          eq(revenueExecutionsTable.organizationId, target.organizationId),
          sql`lower(${revenueExecutionsTable.actionKey}) = lower(${key})`,
        ),
      )
      .for("update");
    if (reserved.length)
      fail(
        "estimate_delivery_reserved",
        "This initial estimate email already has a permanent delivery reservation.",
      );
    // Audit retention outlives generic execution rows. An orphan is a hold, never
    // proof of no effect; inspect all tenant links so a corrupt tenant cannot hide it.
    const retainedEffects = await tx
      .select({ id: auditEventsTable.id })
      .from(auditEventsTable)
      .where(
        and(
          or(
            eq(auditEventsTable.action, ESTIMATE_EMAIL_ADMISSION_ACTION),
            eq(auditEventsTable.action, ESTIMATE_EMAIL_PROOF_ACTION),
          ),
          or(
            eq(auditEventsTable.entityId, target.id),
            sql`lower(${auditEventsTable.metadata}->'snapshot'->>'estimateId') = ${target.id}`,
            sql`lower(${auditEventsTable.metadata}->>'actionKey') = lower(${key})`,
          ),
        ),
      )
      .for("share");
    if (retainedEffects.length)
      fail(
        "estimate_delivery_reserved",
        "Retained delivery evidence permanently holds this estimate email.",
      );
    const snapshot = await readEstimateEmailAuthority(
      tx,
      target.organizationId,
      approvedActor,
      target.id,
      true,
    );
    await assertEstimateEmailEligibility(tx, snapshot);
    const [review] = await tx
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.id, input.previewId))
      .for("update");
    if (!review) fail();
    validateReview(review, snapshot, input.payloadSha256, true);
    const [estimate] = await tx
      .select()
      .from(estimatesTable)
      .where(
        and(
          eq(estimatesTable.organizationId, target.organizationId),
          eq(estimatesTable.id, target.id),
        ),
      )
      .for("share");
    if (!estimate) fail();
    const savedStates = await tx
      .select({ id: auditEventsTable.id })
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, target.organizationId),
          eq(auditEventsTable.entityId, target.id),
          eq(auditEventsTable.action, "estimate.saved_state"),
        ),
      );
    if (!savedStates.length) {
      // Authority already proved the exact legacy returning-v1 creation command.
      // Bridge that known baseline inside admission, without editing the estimate
      // or inventing a new command/creation claim. Failure rolls this back too.
      await recordEstimateSavedState(
        tx,
        target.organizationId,
        estimate,
        snapshot.actorUserId,
        null,
        { previousEstimate: estimate },
      );
    }
    const now = new Date();
    const [execution] = await tx
      .insert(revenueExecutionsTable)
      .values({
        organizationId: snapshot.organizationId,
        actionKey: key,
        fingerprint: input.payloadSha256,
        kind: "estimate_email",
        actorUserId: snapshot.actorUserId,
        state: "processing",
        detail: "Estimate email admitted.",
        createdAt: now,
        expiresAt: new Date(now.getTime() + executionMs),
      })
      .onConflictDoNothing()
      .returning();
    if (!execution)
      fail(
        "estimate_delivery_reserved",
        "This initial estimate email already has a permanent delivery reservation.",
      );
    const admission = parse(estimateEmailAdmissionMetadataSchema, {
      version: 1,
      executionId: execution.id,
      previewId: review.id,
      payloadSha256: input.payloadSha256,
      actionKey: key,
      actor: approvedActor,
      snapshot,
      estimateSha256: estimateSavedStateDigest(estimate),
    });
    await tx.insert(auditEventsTable).values({
      organizationId: snapshot.organizationId,
      actorUserId: snapshot.actorUserId,
      action: ESTIMATE_EMAIL_ADMISSION_ACTION,
      entityType: "estimate",
      entityId: snapshot.estimateId,
      metadata: admission,
      createdAt: now,
    });
    await tx.insert(revenueExecutionEventsTable).values({
      organizationId: snapshot.organizationId,
      executionId: execution.id,
      state: "processing",
      actorUserId: snapshot.actorUserId,
      detail: "Estimate email admitted.",
      createdAt: now,
    });
    return {
      executionId: execution.id,
      snapshot,
      payloadSha256: input.payloadSha256,
      actor: approvedActor,
    };
  });
}
function validateClaim(c: EstimateEmailClaim) {
  const s = parse(estimateEmailSnapshotSchema, c.snapshot);
  parse(z.uuid(), c.executionId);
  parse(actorSchema, c.actor);
  if (
    c.actor.userId !== s.actorUserId ||
    estimateDeliveryFingerprint(s) !== c.payloadSha256
  )
    fail();
  return s;
}
/** Validate every ledger link explicitly: these generic tables do not have estimate/tenant FKs. */
async function retained(tx: CustomerWorkTx, c: EstimateEmailClaim) {
  const s = validateClaim(c);
  const [execution] = await tx
    .select()
    .from(revenueExecutionsTable)
    .where(eq(revenueExecutionsTable.id, c.executionId))
    .for("update");
  if (
    !execution ||
    execution.organizationId !== s.organizationId ||
    execution.kind !== "estimate_email" ||
    !executionStates.includes(execution.state) ||
    execution.actorUserId !== s.actorUserId ||
    execution.actionKey !== estimateEmailActionKey(s.estimateId) ||
    execution.fingerprint !== c.payloadSha256
  )
    fail();
  const rows = await tx
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, ESTIMATE_EMAIL_ADMISSION_ACTION),
        or(
          eq(auditEventsTable.entityId, s.estimateId),
          sql`${auditEventsTable.metadata}->>'executionId' = ${execution.id}`,
        ),
      ),
    )
    .for("share");
  if (
    rows.length !== 1 ||
    !auditMatches(rows[0]!, s, ESTIMATE_EMAIL_ADMISSION_ACTION)
  )
    fail();
  const admission = parse(
    estimateEmailAdmissionMetadataSchema,
    rows[0]!.metadata,
  );
  if (
    admission.executionId !== execution.id ||
    admission.actionKey !== execution.actionKey ||
    admission.payloadSha256 !== execution.fingerprint ||
    estimateDeliveryFingerprint(admission.snapshot) !== c.payloadSha256 ||
    estimateDeliveryFingerprint(admission.actor) !==
      estimateDeliveryFingerprint(c.actor) ||
    admission.actor.userId !== s.actorUserId
  )
    fail();
  const [review] = await tx
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.id, admission.previewId))
    .for("share");
  if (!review) fail();
  validateReview(review, s, c.payloadSha256, false);
  const events = await tx
    .select()
    .from(revenueExecutionEventsTable)
    .where(eq(revenueExecutionEventsTable.executionId, execution.id))
    .for("share");
  if (
    !events.length ||
    !events.some(
      (e) =>
        e.state === "processing" &&
        e.actorUserId === s.actorUserId &&
        e.detail === "Estimate email admitted.",
    )
  )
    fail();
  for (const event of events) {
    if (
      event.organizationId !== s.organizationId ||
      !executionStates.includes(event.state)
    )
      fail();
    if (event.actorUserId) {
      const [actor] = await tx
        .select({ org: usersTable.organizationId })
        .from(usersTable)
        .where(eq(usersTable.id, event.actorUserId));
      if (actor?.org !== s.organizationId) fail();
    }
  }
  return { execution, admission, review, events };
}
/** Called by the provider adapter after OAuth refresh and immediately before its one POST. */
export async function assertEstimateEmailDispatch(
  c: EstimateEmailClaim,
): Promise<void> {
  const s = validateClaim(c);
  const checked = await db.transaction(async (tx) => {
    await lockCustomerWork(tx, s.organizationId);
    await effectLock(tx, s.organizationId, s.estimateId);
    const { execution, review, events } = await retained(tx, c);
    if (
      execution.state !== "processing" ||
      events.length !== 1 ||
      execution.expiresAt.getTime() <= Date.now()
    )
      fail(
        "estimate_delivery_reserved",
        "This estimate execution cannot dispatch.",
      );
    validateReview(review, s, c.payloadSha256, true);
    const current = await readEstimateEmailAuthority(
      tx,
      s.organizationId,
      c.actor,
      s.estimateId,
      true,
    );
    await assertEstimateEmailEligibility(tx, current);
    if (estimateDeliveryFingerprint(current) !== c.payloadSha256)
      fail(
        "estimate_review_changed",
        "The reviewed saved quote, original participants, staff or sender changed.",
      );
    return { review, executionExpiresAt: execution.expiresAt.getTime() };
  });
  // Source-row waits, eligibility reads and even commit may cross a deadline.
  // These final checks have no awaits between them and successful guard return.
  validateReview(checked.review, s, c.payloadSha256, true);
  if (checked.executionExpiresAt <= Date.now())
    fail(
      "estimate_delivery_reserved",
      "This estimate execution cannot dispatch.",
    );
}
function validateReceipt(receipt: UserEmailResult, s: EstimateEmailSnapshot) {
  const r = parse(receiptSchema, receipt);
  if (
    r.provider !== s.sender.provider ||
    r.senderEmail !== s.sender.senderEmail ||
    (r.provider === "gmail" && r.id === null)
  )
    fail();
  return r;
}
/** No fresh send authority or mutable participant joins may suppress truthful acceptance. */
export async function finalizeEstimateEmail(
  c: EstimateEmailClaim,
  outcome: EstimateEmailOutcome,
): Promise<void> {
  const s = validateClaim(c);
  await db.transaction(async (tx) => {
    await lockCustomerWork(tx, s.organizationId);
    await effectLock(tx, s.organizationId, s.estimateId);
    const { execution, admission } = await retained(tx, c);
    const proofRows = await tx
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.action, ESTIMATE_EMAIL_PROOF_ACTION),
          or(
            eq(auditEventsTable.entityId, s.estimateId),
            sql`${auditEventsTable.metadata}->>'executionId' = ${execution.id}`,
          ),
        ),
      )
      .for("share");
    if (proofRows.length > 1) fail();
    let existing: z.infer<typeof estimateEmailProofMetadataSchema> | undefined;
    if (proofRows.length) {
      if (!auditMatches(proofRows[0]!, s, ESTIMATE_EMAIL_PROOF_ACTION)) fail();
      existing = parse(
        estimateEmailProofMetadataSchema,
        proofRows[0]!.metadata,
      );
      const { receipt, acceptedAt, ...link } = existing;
      validateReceipt(receipt, s);
      if (
        estimateDeliveryFingerprint(link) !==
        estimateDeliveryFingerprint(admission)
      )
        fail();
    }
    if (outcome.state === "accepted") {
      const receipt = validateReceipt(outcome.receipt, s);
      if (
        !(outcome.acceptedAt instanceof Date) ||
        !Number.isFinite(outcome.acceptedAt.getTime())
      )
        fail();
      if (existing) {
        if (
          estimateDeliveryFingerprint(existing.receipt) !==
          estimateDeliveryFingerprint(receipt)
        )
          fail();
        return;
      }
      const proof = parse(estimateEmailProofMetadataSchema, {
        ...admission,
        receipt,
        acceptedAt: outcome.acceptedAt.toISOString(),
      });
      await tx.insert(auditEventsTable).values({
        organizationId: s.organizationId,
        actorUserId: s.actorUserId,
        action: ESTIMATE_EMAIL_PROOF_ACTION,
        entityType: "estimate",
        entityId: s.estimateId,
        metadata: proof,
      });
      await tx.insert(activitiesTable).values({
        organizationId: s.organizationId,
        actorUserId: s.actorUserId,
        leadId: s.leadId,
        contactId: s.contactId,
        type: "estimate_email_accepted",
        title: "Estimate email accepted by provider",
        body: "The provider accepted the original reviewed estimate email. Inbox delivery and customer acceptance are not confirmed.",
        metadata: {
          estimateId: s.estimateId,
          provider: receipt.provider,
          deliveryConfirmed: false,
        },
        occurredAt: outcome.acceptedAt,
      });
      const [current] = await tx
        .select()
        .from(estimatesTable)
        .where(
          and(
            eq(estimatesTable.organizationId, s.organizationId),
            eq(estimatesTable.id, s.estimateId),
          ),
        )
        .for("update");
      // A changed quote/root/version, even if returned to draft, never inherits the old send.
      if (
        current &&
        current.status === "draft" &&
        current.sentAt === null &&
        current.acceptedAt === null &&
        estimateSavedStateDigest(current) === admission.estimateSha256 &&
        current.leadId === s.leadId &&
        current.customerWorkId === s.customerWorkId &&
        current.workVersion === s.workVersion &&
        current.updatedAt.toISOString() === s.estimateUpdatedAt
      ) {
        const [updated] = await tx
          .update(estimatesTable)
          .set({
            status: "sent",
            sentAt: outcome.acceptedAt,
            updatedAt: new Date(),
            ...(current.workVersion !== null
              ? { workVersion: current.workVersion + 1 }
              : {}),
          })
          .where(
            and(
              eq(estimatesTable.organizationId, s.organizationId),
              eq(estimatesTable.id, s.estimateId),
            ),
          )
          .returning();
        await recordEstimateSavedState(
          tx,
          s.organizationId,
          updated!,
          s.actorUserId,
          null,
          { previousEstimate: current },
        );
      }
      const detail =
        "Provider accepted the original estimate email; delivery is unconfirmed.";
      if (execution.state === "processing")
        await tx
          .update(revenueExecutionsTable)
          .set({ state: "succeeded", detail, completedAt: new Date() })
          .where(eq(revenueExecutionsTable.id, execution.id));
      await tx.insert(revenueExecutionEventsTable).values({
        organizationId: s.organizationId,
        executionId: execution.id,
        actorUserId: s.actorUserId,
        state: execution.state === "processing" ? "succeeded" : execution.state,
        detail:
          execution.state === "processing"
            ? detail
            : "Late provider acceptance retained for the original estimate email; terminal ownership preserved.",
      });
    } else {
      if (outcome.state !== "held" && outcome.state !== "uncertain") fail();
      if (existing || execution.state !== "processing") return;
      // Caller/provider exception strings can contain message bodies or capabilities.
      const state = outcome.state === "held" ? "blocked" : "indeterminate";
      const detail =
        outcome.state === "held"
          ? "Estimate email held before provider dispatch."
          : "Estimate email outcome is uncertain; do not retry.";
      await tx
        .update(revenueExecutionsTable)
        .set({ state, detail, completedAt: new Date() })
        .where(eq(revenueExecutionsTable.id, execution.id));
      await tx.insert(revenueExecutionEventsTable).values({
        organizationId: s.organizationId,
        executionId: execution.id,
        actorUserId: s.actorUserId,
        state,
        detail,
      });
    }
  });
}
