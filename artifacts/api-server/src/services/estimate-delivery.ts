import { projectEstimateEmailRetainedEvidence } from "./estimate-delivery-projections";
import { z } from "zod/v4";
import { and, eq, or, sql, inArray } from "drizzle-orm";
import {
  db,
  auditEventsTable,
  estimatesTable,
  revenueExecutionsTable,
  revenueExecutionEventsTable,
  usersTable,
} from "@workspace/db";
import {
  EstimateDeliveryError,
  estimateDeliveryFingerprint,
  estimateDeliveryPreviewRequestSchema,
  estimateDeliverySendSchema,
  estimateEmailPreviewSchema,
  estimateEmailReviewMetadataSchema,
  ESTIMATE_EMAIL_REVIEW_ACTION,
  ESTIMATE_EMAIL_PREVIEW_MS,
  type EstimateDeliveryActor,
  type EstimateEmailPreview,
  type EstimateEmailEvidence,
} from "./estimate-delivery-contract";
import {
  readEstimateEmailAuthority,
  assertEstimateEmailEligibility,
} from "./estimate-delivery-authority";
import {
  claimEstimateEmail,
  assertEstimateEmailDispatch,
  finalizeEstimateEmail,
  estimateEmailActionKey,
  estimateEmailAdmissionMetadataSchema,
  ESTIMATE_EMAIL_ADMISSION_ACTION,
  ESTIMATE_EMAIL_PROOF_ACTION,
} from "./estimate-delivery-execution";
import { sendEmailForUser } from "./user-email";
import { EmailDispatchBlockedError } from "./email-dispatch-guard";

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success)
    throw new EstimateDeliveryError(
      409,
      "estimate_delivery_integrity",
      "The estimate review or retained evidence is unavailable.",
    );
  return r.data;
}
export async function previewEstimateEmail(
  org: string,
  actor: EstimateDeliveryActor,
  estimateId: string,
  raw: unknown,
): Promise<EstimateEmailPreview> {
  const request = parse(estimateDeliveryPreviewRequestSchema, raw);
  return db.transaction(async (tx) => {
    const snapshot = await readEstimateEmailAuthority(
      tx,
      org,
      actor,
      estimateId,
      true,
    );
    await assertEstimateEmailEligibility(tx, snapshot);
    const key = estimateEmailActionKey(snapshot.estimateId);
    const permanent = await tx
      .select({ id: revenueExecutionsTable.id })
      .from(revenueExecutionsTable)
      .where(sql`lower(${revenueExecutionsTable.actionKey}) = lower(${key})`);
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
            eq(auditEventsTable.entityId, snapshot.estimateId),
            sql`lower(${auditEventsTable.metadata}->'snapshot'->>'estimateId') = ${snapshot.estimateId}`,
            sql`lower(${auditEventsTable.metadata}->>'actionKey') = lower(${key})`,
          ),
        ),
      );
    if (permanent.length || retainedEffects.length)
      throw new EstimateDeliveryError(
        409,
        "estimate_delivery_reserved",
        "This initial estimate email already has permanent delivery evidence or ownership.",
      );
    if (
      snapshot.estimateUpdatedAt !== request.expectedUpdatedAt ||
      snapshot.workVersion !== request.expectedWorkVersion
    )
      throw new EstimateDeliveryError(
        409,
        "estimate_review_changed",
        "The saved estimate changed. Refresh it before review.",
      );
    // One timestamp anchors both the retained audit and the exact approval lifetime.
    const createdAt = new Date(),
      expiresAt = new Date(
        createdAt.getTime() + ESTIMATE_EMAIL_PREVIEW_MS,
      ).toISOString(),
      payloadSha256 = estimateDeliveryFingerprint(snapshot);
    const metadata = parse(estimateEmailReviewMetadataSchema, {
      version: 1,
      snapshot,
      expiresAt,
      payloadSha256,
    });
    const [review] = await tx
      .insert(auditEventsTable)
      .values({
        organizationId: snapshot.organizationId,
        actorUserId: snapshot.actorUserId,
        entityType: "estimate",
        entityId: snapshot.estimateId,
        action: ESTIMATE_EMAIL_REVIEW_ACTION,
        createdAt,
        metadata,
      })
      .returning();
    return parse(estimateEmailPreviewSchema, {
      estimateId: snapshot.estimateId,
      previewId: review.id,
      payloadSha256,
      expiresAt,
      document: snapshot.document,
      message: snapshot.message,
      sender: {
        provider: snapshot.sender.provider,
        senderEmail: snapshot.sender.senderEmail,
        source: snapshot.sender.source,
      },
    });
  });
}
const baseEvidence = (id: string): EstimateEmailEvidence => ({
  estimateId: id,
  integrity: "valid",
  state: "not_sent",
  executionId: null,
  canPrepare: false,
  detail: "No provider acceptance has been retained.",
  document: null,
  message: null,
  provider: null,
  providerMessageId: null,
  providerRequestId: null,
  acceptedAt: null,
  deliveryConfirmed: false,
});
const unavailable = (id: string): EstimateEmailEvidence => ({
  ...baseEvidence(id),
  integrity: "unavailable",
  state: "held",
  detail:
    "Retained estimate delivery evidence is unavailable or inconsistent. Office verification is required.",
});
export async function sendEstimateEmail(
  org: string,
  actor: EstimateDeliveryActor,
  estimateId: string,
  raw: unknown,
): Promise<EstimateEmailEvidence> {
  const input = parse(estimateDeliverySendSchema, raw);
  // A successful original claim is the only entry into dispatch. Never rebuild or replay it.
  const claim = await claimEstimateEmail(org, actor, estimateId, input);
  let finalizationFailed = false;
  try {
    const s = claim.snapshot;
    const receipt = await sendEmailForUser({
      organizationId: s.organizationId,
      userId: s.sender.userId,
      to: s.message.recipient,
      subject: s.message.subject,
      body: s.message.body,
      expectedSender: {
        provider: s.sender.provider,
        senderEmail: s.sender.senderEmail,
      },
      beforeDispatch: () => assertEstimateEmailDispatch(claim),
      beforeFinalDispatch: () => assertEstimateEmailDispatch(claim),
    });
    try {
      await finalizeEstimateEmail(claim, {
        state: "accepted",
        receipt,
        acceptedAt: new Date(),
      });
    } catch {
      finalizationFailed = true;
      // The send itself is never repeated. If acceptance retention rolled back,
      // retain an uncertain terminal marker using the same permanent claim.
      try {
        await finalizeEstimateEmail(claim, {
          state: "uncertain",
          reason: "acceptance_retention_failed",
        });
      } catch {
        // A database failure may prevent even this safe marker; ownership remains.
      }
    }
  } catch (error) {
    const state =
      error instanceof EmailDispatchBlockedError ? "held" : "uncertain";
    try {
      await finalizeEstimateEmail(claim, { state, reason: state });
    } catch {
      finalizationFailed = true;
    }
  }
  const evidence = await getEstimateEmailEvidence(
    claim.snapshot.organizationId,
    claim.snapshot.estimateId,
  );
  if (
    finalizationFailed &&
    evidence.integrity === "valid" &&
    evidence.acceptedAt === null
  )
    return {
      ...evidence,
      state: "uncertain",
      canPrepare: false,
      detail:
        "Provider outcome could not be retained. Verify the original mailbox; do not resend.",
    };
  return evidence;
}
/** SELECT-only projection: retained participants are never replaced by current customer joins. */
export async function getEstimateEmailEvidence(
  org: string,
  estimateId: string,
): Promise<EstimateEmailEvidence> {
  parse(z.uuid(), org);
  parse(z.uuid(), estimateId);
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(estimatesTable)
      .where(
        and(
          eq(estimatesTable.organizationId, org),
          eq(estimatesTable.id, estimateId),
        ),
      );
    if (!target)
      throw new EstimateDeliveryError(
        404,
        "estimate_not_found",
        "The saved estimate is unavailable.",
      );
    const id = target.id,
      key = estimateEmailActionKey(id);
    try {
      // Include corrupt/orphan links across tenants so they cannot disguise a prior effect.
      const executions = await tx
        .select()
        .from(revenueExecutionsTable)
        .where(sql`lower(${revenueExecutionsTable.actionKey}) = lower(${key})`);
      const audits = await tx
        .select()
        .from(auditEventsTable)
        .where(
          and(
            or(
              eq(auditEventsTable.action, ESTIMATE_EMAIL_ADMISSION_ACTION),
              eq(auditEventsTable.action, ESTIMATE_EMAIL_PROOF_ACTION),
            ),
            or(
              eq(auditEventsTable.entityId, id),
              sql`lower(${auditEventsTable.metadata}->'snapshot'->>'estimateId') = ${id}`,
              sql`lower(${auditEventsTable.metadata}->>'actionKey') = lower(${key})`,
            ),
          ),
        );
      if (!executions.length) {
        if (audits.length) return unavailable(id);
        const result = baseEvidence(id);
        if (target.status !== "draft" || target.sentAt || target.acceptedAt)
          return {
            ...result,
            state: "held",
            detail:
              "This estimate has saved delivery or customer decision history. No provider acceptance is inferred.",
          };
        const actors = await tx
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(
            and(
              eq(usersTable.organizationId, org),
              eq(usersTable.isActive, true),
              sql`${usersTable.role} in ('owner','admin','office')`,
            ),
          );
        for (const actor of actors) {
          try {
            const s = await readEstimateEmailAuthority(
              tx,
              org,
              { userId: actor.id },
              id,
              false,
            );
            await assertEstimateEmailEligibility(tx, s);
            return {
              ...result,
              canPrepare: true,
              detail:
                "The initial saved estimate is currently eligible for office review.",
            };
          } catch {
            /* This read is a hint, never send authority. */
          }
        }
        return {
          ...result,
          state: "held",
          detail:
            "Current saved quote, sender, history or email eligibility requires office review.",
        };
      }
      const admission = estimateEmailAdmissionMetadataSchema.safeParse(
        audits.find((a) => a.action === ESTIMATE_EMAIL_ADMISSION_ACTION)
          ?.metadata,
      );
      const execution = executions[0];
      const linkedAudits = await tx
        .select()
        .from(auditEventsTable)
        .where(
          and(
            or(
              eq(auditEventsTable.action, ESTIMATE_EMAIL_ADMISSION_ACTION),
              eq(auditEventsTable.action, ESTIMATE_EMAIL_PROOF_ACTION),
            ),
            sql`${auditEventsTable.metadata}->>'executionId' = ${execution?.id ?? ""}`,
          ),
        );
      const [review] = admission.success
        ? await tx
            .select()
            .from(auditEventsTable)
            .where(eq(auditEventsTable.id, admission.data.previewId))
        : [];
      const events = execution
        ? await tx
            .select()
            .from(revenueExecutionEventsTable)
            .where(eq(revenueExecutionEventsTable.executionId, execution.id))
        : [];
      const memberIds = [
        ...new Set(
          [
            ...events.map((e) => e.actorUserId),
            ...(admission.success
              ? [
                  admission.data.snapshot.actorUserId,
                  admission.data.snapshot.sender.userId,
                ]
              : []),
          ].filter((id): id is string => !!id),
        ),
      ];
      const participants = memberIds.length
        ? await tx
            .select({ id: usersTable.id, org: usersTable.organizationId })
            .from(usersTable)
            .where(inArray(usersTable.id, memberIds))
        : [];
      return projectEstimateEmailRetainedEvidence({
        org,
        id,
        executions,
        audits,
        linkedAudits,
        review,
        events,
        participants,
      });
    } catch {
      return unavailable(id);
    }
  });
}
