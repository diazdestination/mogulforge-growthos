import {
  activitiesTable,
  consentRecordsTable,
  contactsTable,
  db,
  leadsTable,
  playbookEnrollmentsTable,
  playbooksTable,
  scheduledActionsTable,
  type EnrollmentHistoryEntry,
  type Lead,
  type Playbook,
  type PlaybookCategory,
  type PlaybookEnrollment,
  type PlaybookStep,
  type SendingHoursSettings,
  type StageBehavior,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { isLegacyDefaultOrg } from "../lib/orgFlavor";
import { recordAudit } from "./audit";
import { needsSourceVerification } from "./source-history";
import { hasCustomerReplyHold, lockReplyLead } from "./response-correlation";
import {
  engagementLinkUrl,
  getOrCreateEngagementLink,
} from "./engagement-links";
import { getUserEmailStatus, sendEmailForUser, emailAcceptanceEvidence } from "./user-email";
import { EmailDispatchBlockedError } from "./email-dispatch-guard";
import { acceptContactTouch, assertContactTouchCurrent, ContactTouchDeferredError, ContactTouchError, markContactTouchDispatchStarted, reserveContactTouch, type ContactTouchClaim } from "./contact-touch-claim";
import { acquireNurtureLocks } from "./source-outreach-ownership";
import { sourceFingerprint } from "./source-adoption-contract";
import {
  adjustSendTime,
  chooseVariant,
  recordTouch,
} from "./playbook-learning";
import { draftOutreachMessage, providers } from "./providers";
import {
  checkSendEligibility,
  handleProviderFailure,
  nextAllowedSendTime,
  recordBlockedSend,
  unsubscribeFooter,
} from "./send-gate";
import {
  getBusinessName,
  getOrgSettings,
  getPlaybookStageBehaviors,
  getSendingHours,
} from "./settings";

/**
 * Closer Engine playbooks: every new lead is auto-enrolled in a matching
 * outreach playbook — an ordered sequence of email/SMS steps with delays —
 * that runs until the lead replies, books an inspection, advances past the
 * outreach stages, or the sequence is exhausted. Steps are executed by the
 * existing scheduled-actions engine (action type "playbook_step").
 */

/** Lead statuses where automated outreach is still appropriate. */
export const OUTREACH_ACTIVE_STATUSES = [
  "new",
  "ai_qualified",
  "contact_attempted",
  "follow_up",
  "nurture",
] as const;

/** Statuses in which a post-sale (review/referral/maintenance) sequence may keep sending. */
export const POST_SALE_ACTIVE_STATUSES = [
  "won",
  "production_scheduled",
  "in_progress",
  "final_walkthrough",
  "completed",
  "review_requested",
] as const;

export const DEFAULT_PLAYBOOK_SEED_KEY = "default.new_lead_outreach";
export const DEFAULT_PLAYBOOK_NAME = "New lead outreach";

const DEFAULT_STEPS: PlaybookStep[] = [
  {
    channel: "email",
    delayMinutes: 5,
    subject: "About your roof — we're on it",
    prompt:
      "First touch, minutes after the homeowner asked for help. Warmly confirm we received their request, set the expectation that a real person will reach out shortly, and invite them to reply with any details or photos. Short and human, no pressure.",
  },
  {
    channel: "sms",
    delayMinutes: 60 * 4,
    prompt:
      "Same-day text follow-up. One or two sentences: we're ready to schedule their free inspection and they can reply to this text to pick a time.",
  },
  {
    channel: "email",
    delayMinutes: 60 * 24,
    subject: "Your free roof inspection — ready when you are",
    prompt:
      "Day-two follow-up. Gently remind them their free inspection is ready to book, mention the specific concern they reported, and give an easy next step. Helpful, not salesy.",
  },
  {
    channel: "sms",
    delayMinutes: 60 * 24 * 3,
    prompt:
      "Day-five nudge. Brief, friendly check-in: still happy to help whenever they're ready; weather damage tends to get worse, so an early look saves money.",
  },
  {
    channel: "email",
    delayMinutes: 60 * 24 * 4,
    subject: "Should we keep your spot open?",
    prompt:
      "Final touch of the sequence, about nine days in. Politely close the loop: we'll stop reaching out but they can reply any time; include a one-line recap of what we can do for them.",
  },
];

/** Industry-neutral default sequence for orgs created via self-serve signup. */
const GENERIC_STEPS: PlaybookStep[] = [
  {
    channel: "email",
    delayMinutes: 5,
    subject: "We got your request — we're on it",
    prompt:
      "First touch, minutes after the prospect asked for help. Warmly confirm we received their request, set the expectation that a real person will reach out shortly, and invite them to reply with any details. Short and human, no pressure.",
  },
  {
    channel: "sms",
    delayMinutes: 60 * 4,
    prompt:
      "Same-day text follow-up. One or two sentences: we're ready to schedule a time to talk and they can reply to this text to pick a time.",
  },
  {
    channel: "email",
    delayMinutes: 60 * 24,
    subject: "Ready when you are",
    prompt:
      "Day-two follow-up. Gently remind them we're ready to help, mention the specific request they made, and give an easy next step. Helpful, not salesy.",
  },
  {
    channel: "sms",
    delayMinutes: 60 * 24 * 3,
    prompt:
      "Day-five nudge. Brief, friendly check-in: still happy to help whenever they're ready.",
  },
  {
    channel: "email",
    delayMinutes: 60 * 24 * 4,
    subject: "Should we keep your spot open?",
    prompt:
      "Final touch of the sequence, about nine days in. Politely close the loop: we'll stop reaching out but they can reply any time; include a one-line recap of what we can do for them.",
  },
];

/**
 * Idempotently seed the default playbook for an org. Keys on
 * (organizationId, seedKey) under a per-org advisory lock, so a renamed,
 * edited, or deactivated default is never re-seeded and concurrent calls
 * can't duplicate it.
 */
export async function ensureDefaultPlaybook(
  organizationId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`default-playbook:${organizationId}`}))`,
    );
    const [existing] = await tx
      .select({ id: playbooksTable.id })
      .from(playbooksTable)
      .where(
        and(
          eq(playbooksTable.organizationId, organizationId),
          eq(playbooksTable.seedKey, DEFAULT_PLAYBOOK_SEED_KEY),
        ),
      );
    if (existing) return;
    const legacy = await isLegacyDefaultOrg(organizationId, tx);
    await tx.insert(playbooksTable).values({
      organizationId,
      name: DEFAULT_PLAYBOOK_NAME,
      seedKey: DEFAULT_PLAYBOOK_SEED_KEY,
      isActive: true,
      enrollmentRules: {},
      steps: legacy ? DEFAULT_STEPS : GENERIC_STEPS,
    });
  });
}

function rulesMatch(playbook: Playbook, lead: Lead): boolean {
  const rules = playbook.enrollmentRules ?? {};
  if (typeof rules.minScore === "number" && lead.score < rules.minScore) {
    return false;
  }
  if (rules.urgencies?.length && !rules.urgencies.includes(lead.urgency)) {
    return false;
  }
  if (
    rules.serviceTypes?.length &&
    (!lead.serviceType || !rules.serviceTypes.includes(lead.serviceType))
  ) {
    return false;
  }
  if (
    rules.sources?.length &&
    (!lead.source || !rules.sources.includes(lead.source))
  ) {
    return false;
  }
  return true;
}

/**
 * Auto-enroll a newly created lead into the first matching active playbook.
 * No-ops (never throws) when no playbook matches, the lead already has a
 * live enrollment, or the lead is past the outreach stages.
 */
export async function autoEnrollLead(
  organizationId: string,
  leadId: string,
): Promise<PlaybookEnrollment | null> {
  try {
    await ensureDefaultPlaybook(organizationId);
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.id, leadId),
          eq(leadsTable.organizationId, organizationId),
        ),
      );
    if (!lead) return null;
    if (!OUTREACH_ACTIVE_STATUSES.includes(lead.status as never)) return null;

    const playbooks = await db
      .select()
      .from(playbooksTable)
      .where(
        and(
          eq(playbooksTable.organizationId, organizationId),
          eq(playbooksTable.isActive, true),
          // Post-sale playbooks are milestone-gated: they enroll only via
          // handlePostSaleTransition, never at lead creation.
          eq(playbooksTable.kind, "outreach"),
        ),
      )
      .orderBy(desc(playbooksTable.createdAt));
    // New-lead auto-enrollment only considers acquisition sequences; other
    // categories (review requests, reactivation…) are entered by explicit
    // stage-behavior hand-offs or dedicated flows.
    const match = playbooks.find(
      (p) =>
        p.category === "acquisition" &&
        p.steps.length > 0 &&
        rulesMatch(p, lead),
    );
    if (!match) return null;

    return await enrollLead(organizationId, leadId, match);
  } catch (err) {
    // Enrollment must never break lead capture.
    console.error("[playbooks] auto-enroll failed:", err);
    return null;
  }
}

/** Create the enrollment row and schedule step 0. Skips if one is live.
 * Exported for the reactivation campaign drainer, which enrolls a chosen
 * playbook explicitly rather than via auto-enroll rules. */
export async function enrollLead(
  organizationId: string,
  leadId: string,
  playbook: Playbook,
  options?: {
    /** Reuse the campaign's transaction so progress and the first step commit together. */
    transaction?: Parameters<Parameters<typeof db.transaction>[0]>[0];
    skipAudit?: boolean;
    sendingHours?: SendingHoursSettings;
  },
): Promise<PlaybookEnrollment | null> {
  const firstStep = playbook.steps[0];
  if (!firstStep) return null;
  let runAt = new Date(Date.now() + firstStep.delayMinutes * 60_000);
  // Never schedule the first touch outside the org's permitted sending
  // window (e.g. a lead captured at 2am waits until 8am local).
  const sendingHours = options?.sendingHours ?? (await getSendingHours(organizationId));
  runAt = nextAllowedSendTime(sendingHours, runAt) ?? runAt;
  try {
    const create = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
      await lockReplyLead(tx, organizationId, leadId);
      if (await hasCustomerReplyHold(organizationId, leadId, tx)) return null;
      const [enrollment] = await tx
        .insert(playbookEnrollmentsTable)
        .values({
          organizationId,
          playbookId: playbook.id,
          leadId,
          kind: playbook.kind,
          category: playbook.category,
          status: "active",
          currentStep: 0,
          nextRunAt: runAt,
        })
        .onConflictDoNothing()
        .returning();
      if (!enrollment) return null;
      await tx.insert(scheduledActionsTable).values({
        organizationId,
        action: {
          type: "playbook_step",
          params: { enrollmentId: enrollment.id, stepIndex: 0 },
        },
        context: { leadId },
        runAt,
      });
      return enrollment;
    };
    const enrollment = options?.transaction
      ? await create(options.transaction)
      : await db.transaction(create);
    if (!enrollment) return null;
    if (!options?.skipAudit) {
      try {
        await recordAudit({
          organizationId,
          action: "playbook.enrolled",
          entityType: "lead",
          entityId: leadId,
          metadata: { playbookId: playbook.id, playbookName: playbook.name },
        });
      } catch (err) {
        // Audit availability must not make a committed enrollment look failed
        // to callers and prompt them to create a second sequence.
        console.error("[playbooks] enrollment audit failed:", err);
      }
    }
    return enrollment;
  } catch (err) {
    // Unique partial index: another live enrollment (same category, or same
    // lead+playbook) already exists. Drizzle may wrap the pg error, so check
    // the cause too.
    const messages = [
      err instanceof Error ? err.message : "",
      err instanceof Error && err.cause instanceof Error
        ? err.cause.message
        : "",
    ].join(" ");
    if (/playbook_enrollments_lead_(playbook_)?active_idx/.test(messages)) {
      return null;
    }
    throw err;
  }
}

async function scheduleStep(
  enrollment: PlaybookEnrollment,
  stepIndex: number,
  runAt: Date,
  writer: Pick<typeof db, "insert"> = db,
): Promise<void> {
  await writer.insert(scheduledActionsTable).values({
    organizationId: enrollment.organizationId,
    action: {
      type: "playbook_step",
      params: { enrollmentId: enrollment.id, stepIndex },
    },
    context: { leadId: enrollment.leadId },
    runAt,
  });
}

async function appendHistory(
  enrollmentId: string,
  entry: EnrollmentHistoryEntry,
): Promise<void> {
  await db
    .update(playbookEnrollmentsTable)
    .set({
      history: sql`${playbookEnrollmentsTable.history} || ${JSON.stringify([entry])}::jsonb`,
    })
    .where(eq(playbookEnrollmentsTable.id, enrollmentId));
}

/**
 * Execute one due playbook step (called by the scheduled-actions engine).
 * Returns a short status string used as the action result detail.
 * Stale-guards: enrollment must still be active at exactly this step, and
 * the lead must still be in an outreach-appropriate stage.
 */
export async function executePlaybookStep(
  organizationId: string,
  params: { enrollmentId?: string; stepIndex?: number },
): Promise<{ status: "success" | "skipped"; detail: string }> {
  const { customerWorkHeld } = await import("./customer-lifecycle-runtime");
  const { enrollmentId, stepIndex } = params;
  if (typeof enrollmentId !== "string" || typeof stepIndex !== "number") {
    return { status: "skipped", detail: "missing enrollment params" };
  }
  const [enrollment] = await db
    .select()
    .from(playbookEnrollmentsTable)
    .where(
      and(
        eq(playbookEnrollmentsTable.id, enrollmentId),
        eq(playbookEnrollmentsTable.organizationId, organizationId),
      ),
    );
  if (!enrollment) return { status: "skipped", detail: "enrollment not found" };
  if (enrollment.status !== "active") {
    return { status: "skipped", detail: `enrollment ${enrollment.status}` };
  }
  if (enrollment.currentStep !== stepIndex) {
    return { status: "skipped", detail: "step already handled" };
  }
  if (await customerWorkHeld(organizationId)) {
    // A scheduler can already own the action when the company hold lands.
    // Expose the retained step for explicit resumption instead of stranding an
    // active enrollment after its scheduled receipt has been closed.
    const reason = "Company work paused during step preparation; review before resuming";
    const entry: EnrollmentHistoryEntry = { at: new Date().toISOString(), kind: "paused", stepIndex, detail: reason };
    await db.update(playbookEnrollmentsTable).set({ status: "paused", pauseReason: reason, nextRunAt: null,
      history: sql`${playbookEnrollmentsTable.history} || ${JSON.stringify([entry])}::jsonb`,
    }).where(and(eq(playbookEnrollmentsTable.id, enrollment.id), eq(playbookEnrollmentsTable.organizationId, organizationId),
      eq(playbookEnrollmentsTable.status, "active"), eq(playbookEnrollmentsTable.currentStep, stepIndex)));
    return { status: "skipped", detail: "paused: customer_lifecycle_paused" };
  }

  if (await hasCustomerReplyHold(organizationId, enrollment.leadId)) {
    await pauseEnrollment(enrollment.id, "Customer replied; resolve the reply review before resuming");
    return { status: "skipped", detail: "paused: customer_reply_requires_review" };
  }

  const [playbook] = await db
    .select()
    .from(playbooksTable)
    .where(eq(playbooksTable.id, enrollment.playbookId));
  const step = playbook?.steps[stepIndex];
  if (!playbook || !step) {
    await finishEnrollment(enrollment.id, "completed", "sequence exhausted");
    return { status: "skipped", detail: "no step at index" };
  }

  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.id, enrollment.leadId),
        eq(leadsTable.organizationId, organizationId),
      ),
    );
  if (!lead) {
    await finishEnrollment(enrollment.id, "completed", "lead deleted");
    return { status: "skipped", detail: "lead deleted" };
  }
  // Stage guards. Post-sale playbooks stay live through the won→completed
  // stages. For pre-sale playbooks, the org's stage→behavior map decides
  // whether an ACQUISITION sequence keeps running at this pipeline stage
  // (defaults preserve the old outreach-stages-only behavior); other
  // non-acquisition sequences (estimate follow-up…) run regardless of stage.
  if (playbook.kind === "post_sale") {
    if (
      !(POST_SALE_ACTIVE_STATUSES as readonly string[]).includes(lead.status)
    ) {
      await finishEnrollment(
        enrollment.id,
        "completed",
        `lead moved to ${lead.status}`,
      );
      return { status: "skipped", detail: "lead past playbook stages" };
    }
  } else if (playbook.category === "acquisition") {
    const behaviors = await getPlaybookStageBehaviors(organizationId);
    const behavior = behaviors[lead.status] ?? { action: "complete" };
    const continues =
      behavior.action === "continue" ||
      // An "enroll into this very playbook" stage must not complete itself.
      (behavior.action === "enroll" &&
        behavior.enrollPlaybookId === playbook.id);
    if (!continues) {
      if (behavior.action === "pause") {
        await pauseEnrollment(enrollment.id, `lead moved to ${lead.status}`);
        return { status: "skipped", detail: "paused by stage behavior" };
      }
      await finishEnrollment(
        enrollment.id,
        behavior.action === "cancel" ? "stopped" : "completed",
        `lead moved to ${lead.status}`,
      );
      return { status: "skipped", detail: "lead past outreach stages" };
    }
  }
  const [contact] = await db
    .select()
    .from(contactsTable)
    .where(
      and(
        eq(contactsTable.id, lead.contactId),
        eq(contactsTable.organizationId, organizationId),
      ),
    );
  if (!contact) {
    await finishEnrollment(enrollment.id, "stopped", "contact missing");
    return { status: "skipped", detail: "contact missing" };
  }

  // Unified pre-send eligibility gate (suppressions, DNC, consent, quiet
  // hours, frequency caps) — evaluated BEFORE the step is claimed so a
  // deferral re-queues this same step instead of consuming it.
  const sendingHours = await getSendingHours(organizationId);
  const gate = await checkSendEligibility({
    organizationId,
    leadId: lead.id,
    contact,
    channel: step.channel,
    kind: "outreach",
    sendingHours,
  });
  const permanentStop = !gate.ok && gate.outcome === "blocked" &&
    (gate.reason.startsWith("suppressed:") || gate.reason === "do_not_contact");
  if (!gate.ok && gate.reason === "customer_lifecycle_paused") {
    // The company may have paused after this step's entry check. Retain the
    // same step for explicit review instead of consuming it as a channel skip.
    const reason = "Company work paused during step preparation; review before resuming";
    const entry: EnrollmentHistoryEntry = { at: new Date().toISOString(), kind: "paused", stepIndex, channel: step.channel, detail: reason };
    await db.update(playbookEnrollmentsTable).set({ status: "paused", pauseReason: reason, nextRunAt: null,
      history: sql`${playbookEnrollmentsTable.history} || ${JSON.stringify([entry])}::jsonb`,
    }).where(and(eq(playbookEnrollmentsTable.id, enrollment.id), eq(playbookEnrollmentsTable.organizationId, organizationId),
      eq(playbookEnrollmentsTable.status, "active"), eq(playbookEnrollmentsTable.currentStep, stepIndex)));
    return { status: "skipped", detail: "paused: customer_lifecycle_paused" };
  }
  if (!permanentStop && (needsSourceVerification(lead) ||
      (!gate.ok && gate.reason === "imported_source_requires_current_review"))) {
    // Source review takes priority over a missing address, SMS consent or send
    // window. None of those channel conditions can consume a source-held step.
    // Explicit suppression/DNC still uses the existing permanent-stop path.
    const reason = "Imported source needs current review before outreach";
    const entry: EnrollmentHistoryEntry = {
      at: new Date().toISOString(), kind: "paused", stepIndex,
      channel: step.channel, detail: reason,
    };
    await db.update(playbookEnrollmentsTable).set({
      status: "paused", pauseReason: reason, nextRunAt: null,
      history: sql`${playbookEnrollmentsTable.history} || ${JSON.stringify([entry])}::jsonb`,
    }).where(and(
      eq(playbookEnrollmentsTable.id, enrollment.id),
      eq(playbookEnrollmentsTable.organizationId, organizationId),
      eq(playbookEnrollmentsTable.status, "active"),
      eq(playbookEnrollmentsTable.currentStep, stepIndex),
    ));
    await recordBlockedSend({ organizationId, channel: step.channel,
      reason: "imported_source_requires_current_review", outcome: "blocked",
      source: "playbook", leadId: lead.id, contactId: contact.id });
    return { status: "skipped", detail: "paused: imported_source_requires_current_review" };
  }
  let gateSkipReason: string | null = null;
  let emailSenderUserId: string | null = null;
  let expectedEmailSender: { provider: "gmail" | "microsoft"; senderEmail: string } | undefined;
  if (!gate.ok) {
    if (gate.outcome === "deferred") {
      // Quiet hours / frequency cap: pause, never drop. Re-queue the exact
      // same step; the currentStep CAS makes duplicate queue rows harmless.
      await db.insert(scheduledActionsTable).values({
        organizationId,
        action: {
          type: "playbook_step",
          params: { enrollmentId: enrollment.id, stepIndex },
        },
        context: { leadId: enrollment.leadId },
        runAt: gate.resumeAt,
      });
      await db
        .update(playbookEnrollmentsTable)
        .set({ nextRunAt: gate.resumeAt })
        .where(eq(playbookEnrollmentsTable.id, enrollment.id));
      await appendHistory(enrollment.id, {
        at: new Date().toISOString(),
        kind: "deferred",
        stepIndex,
        channel: step.channel,
        detail: `${gate.reason} until ${gate.resumeAt.toISOString()}`,
      });
      await recordBlockedSend({
        organizationId,
        channel: step.channel,
        reason: gate.reason,
        outcome: "deferred",
        source: "playbook",
        leadId: lead.id,
        contactId: contact.id,
        resumeAt: gate.resumeAt,
      });
      return { status: "skipped", detail: `deferred: ${gate.reason}` };
    }
    await recordBlockedSend({
      organizationId,
      channel: step.channel,
      reason: gate.reason,
      outcome: "blocked",
      source: "playbook",
      leadId: lead.id,
      contactId: contact.id,
    });
    if (
      gate.reason.startsWith("suppressed:") ||
      gate.reason === "do_not_contact"
    ) {
      // The recipient opted out (or is flagged do-not-contact): exit the
      // whole sequence rather than skipping one step.
      await finishEnrollment(
        enrollment.id,
        "stopped",
        `send blocked: ${gate.reason}`,
      );
      return { status: "skipped", detail: `blocked: ${gate.reason}` };
    }
    // Non-fatal (missing/invalid address, no SMS consent): claim + skip the
    // touch and let the sequence continue on other channels.
    gateSkipReason = gate.reason;
  }

  // Automated email must have an explicit, user-owned sender. Never fall
  // back to the organization's generic provider (or a platform mailbox).
  // Check this before claiming the step so assigning a rep / connecting
  // Gmail can resume the same touch instead of silently consuming it.
  if (step.channel === "email" && !gateSkipReason) {
    if (!lead.assignedUserId) {
      const reason = "automated_sender_unassigned";
      await pauseEnrollment(
        enrollment.id,
        "Automated email paused: assign this lead to a user with a connected selected email account",
      );
      await recordBlockedSend({
        organizationId,
        channel: "email",
        reason,
        outcome: "blocked",
        source: "playbook",
        mode: "automated",
        leadId: lead.id,
        contactId: contact.id,
      });
      return { status: "skipped", detail: `paused: ${reason}` };
    }
    const gmail = await getUserEmailStatus(organizationId, lead.assignedUserId);
    if (!gmail.senderActive) {
      const reason = "assigned_sender_inactive";
      await pauseEnrollment(
        enrollment.id,
        "Automated email paused: the assigned user is no longer active",
      );
      await recordBlockedSend({
        organizationId,
        channel: "email",
        reason,
        outcome: "blocked",
        source: "playbook",
        mode: "automated",
        leadId: lead.id,
        contactId: contact.id,
      });
      return { status: "skipped", detail: `paused: ${reason}` };
    }
    if (!gmail.configured || !gmail.connected || !gmail.provider || !gmail.email) {
      const reason = gmail.configured
        ? "assigned_sender_email_not_connected"
        : "email_provider_not_configured";
      await pauseEnrollment(
        enrollment.id,
        gmail.configured
          ? "Automated email paused: the assigned user must connect their selected email account"
          : "Automated email paused: the selected email provider is not configured or selected",
      );
      await recordBlockedSend({
        organizationId,
        channel: "email",
        reason,
        outcome: "blocked",
        source: "playbook",
        mode: "automated",
        leadId: lead.id,
        contactId: contact.id,
      });
      return { status: "skipped", detail: `paused: ${reason}` };
    }
    emailSenderUserId = lead.assignedUserId;
    expectedEmailSender = { provider: gmail.provider, senderEmail: gmail.email.trim().toLowerCase() };
  }

  // Atomically CLAIM this step before any external side effect: advance
  // currentStep (and schedule the next step / complete the sequence) in one
  // transaction, guarded by a compare-and-set on (status, currentStep).
  // A concurrent worker, a scheduler retry after a partial failure, or a
  // duplicate queued action will fail the claim and no-op — the worst case
  // is a skipped touch, never a double send.
  const nextStep = playbook.steps[stepIndex + 1];
  let nextRunAt: Date | null = null;
  let windowDeferred = false;
  if (nextStep) {
    // Learning loop: nudge the follow-up into the org's best-performing
    // send window once there's enough outcome data (no-op before that).
    const tentative = new Date(Date.now() + nextStep.delayMinutes * 60_000);
    nextRunAt = (await adjustSendTime(organizationId, tentative, sendingHours))
      .runAt;
    // Never schedule the follow-up outside the org's permitted sending
    // window: defer it to the next valid local send time.
    const clamped = nextAllowedSendTime(sendingHours, nextRunAt);
    if (clamped) {
      nextRunAt = clamped;
      windowDeferred = true;
    }
  }
  const touchLogicalKey = `playbook:${enrollment.id}:${stepIndex}`;
  const contactTouch: ContactTouchClaim = { organizationId, logicalKey: touchLogicalKey, contactId: contact.id,
    address: (step.channel === "email" ? contact.email : contact.phone) ?? "", channel: step.channel, sourceKind: "playbook", leadId: lead.id,
    // This reserves the original playbook effect, not a new approval of AI copy.
    payload: { enrollmentId: enrollment.id, stepIndex, playbookId: playbook.id, step, leadId: lead.id, contactId: contact.id,
      recipient: (step.channel === "email" ? contact.email : contact.phone) ?? "" } };
  let claimed: PlaybookEnrollment | null;
  try {
    claimed = await db.transaction(async (tx) => {
    await acquireNurtureLocks(tx, organizationId, [lead.id]);
    const [current] = await tx.select().from(playbookEnrollmentsTable).where(and(eq(playbookEnrollmentsTable.organizationId, organizationId),
      eq(playbookEnrollmentsTable.id, enrollment.id))).for("update");
    if (!current || current.status !== "active" || current.currentStep !== stepIndex) return null;
    if (!gateSkipReason) {
      const reservation = await reserveContactTouch(tx, contactTouch);
      // A reservation without this original CAS can be a crash, never permission
      // to recreate the effect after a retry, restore or operator reconciliation.
      if (!reservation.created) throw new ContactTouchError("playbook_touch_already_owned");
    }
    const [row] = await tx
      .update(playbookEnrollmentsTable)
      .set(
        nextStep
          ? { currentStep: stepIndex + 1, nextRunAt }
          : {
              currentStep: stepIndex + 1,
              nextRunAt: null,
              status: "completed",
              pauseReason: "sequence exhausted",
            },
      )
      .where(
        and(
          eq(playbookEnrollmentsTable.id, enrollment.id),
          eq(playbookEnrollmentsTable.organizationId, organizationId),
          eq(playbookEnrollmentsTable.status, "active"),
          eq(playbookEnrollmentsTable.currentStep, stepIndex),
        ),
      )
      .returning();
    if (!row) return null;
    if (nextStep && nextRunAt) {
      await tx.insert(scheduledActionsTable).values({
        organizationId,
        action: {
          type: "playbook_step",
          params: { enrollmentId: enrollment.id, stepIndex: stepIndex + 1 },
        },
        context: { leadId: enrollment.leadId },
        runAt: nextRunAt,
      });
    }
    return row;
    });
  } catch (error) {
    if (error instanceof ContactTouchDeferredError) {
      await db.transaction(async tx => {
        await acquireNurtureLocks(tx, organizationId, [lead.id]);
        const [current] = await tx.select().from(playbookEnrollmentsTable).where(and(eq(playbookEnrollmentsTable.organizationId, organizationId),
          eq(playbookEnrollmentsTable.id, enrollment.id))).for("update");
        if (!current || current.status !== "active" || current.currentStep !== stepIndex) return;
        await tx.insert(scheduledActionsTable).values({ organizationId, action: { type: "playbook_step", params: { enrollmentId: enrollment.id, stepIndex } },
          context: { leadId: enrollment.leadId }, runAt: error.resumeAt });
        await tx.update(playbookEnrollmentsTable).set({ nextRunAt: error.resumeAt,
          history: sql`${playbookEnrollmentsTable.history} || ${JSON.stringify([{ at: new Date().toISOString(), kind: "deferred", stepIndex, channel: step.channel, detail: `shared contact allowance until ${error.resumeAt.toISOString()}` }])}::jsonb`,
        }).where(and(eq(playbookEnrollmentsTable.organizationId, organizationId), eq(playbookEnrollmentsTable.id, enrollment.id)));
      });
      return { status: "skipped", detail: "deferred: shared_contact_allowance" };
    }
    if (error instanceof ContactTouchError) {
      await pauseEnrollment(enrollment.id, "Original touch ownership requires review; no replacement key or automatic replay.");
      return { status: "skipped", detail: "paused: original_touch_owned" };
    }
    throw error;
  }
  if (!claimed) {
    return { status: "skipped", detail: "step already claimed" };
  }
  const claimExpiresAt = Date.now() + 15 * 60_000;
  if (windowDeferred && nextRunAt) {
    await appendHistory(enrollment.id, {
      at: new Date().toISOString(),
      kind: "deferred",
      stepIndex: stepIndex + 1,
      channel: nextStep?.channel,
      detail: `outside sending window; scheduled for ${nextRunAt.toISOString()}`,
    });
  }

  // Channel reachability + SMS consent gate.
  let sendResult: {
    id: string | null;
    provider: string;
    senderEmail?: string;
    providerRequestId?: string | null;
    clientRequestId?: string;
  } | null = null;
  let skipDetail: string | null = null;
  const settings = await getOrgSettings(organizationId);
  const businessName = await getBusinessName(organizationId);

  // Learning loop: bandit-allocated message variant (pinned wins; even
  // split while exploring; Thompson sampling on reply rate afterwards).
  const variant = await chooseVariant(
    organizationId,
    playbook,
    stepIndex,
    step,
  );

  const draft = await draftOutreachMessage({
    channel: step.channel,
    prompt: variant.prompt,
    businessName,
    contactFirstName: contact.firstName,
    leadSummary: lead.summary ?? undefined,
    serviceType: lead.serviceType ?? undefined,
    urgency: lead.urgency,
    stepNumber: stepIndex + 1,
    totalSteps: playbook.steps.length,
  });

  // Post-sale review/referral steps carry the contact's tokenized
  // engagement link (click/submission tracked, org-scoped by token).
  let linkSuffix = "";
  if (step.linkKind === "review" || step.linkKind === "referral") {
    const link = await getOrCreateEngagementLink(
      organizationId,
      contact.id,
      step.linkKind,
      lead.id,
    );
    linkSuffix =
      step.linkKind === "review"
        ? `\n\nLeave us a review: ${engagementLinkUrl(link)}`
        : `\n\nRefer a friend or neighbor here: ${engagementLinkUrl(link)}`;
  }

  if (gateSkipReason) {
    skipDetail = `blocked: ${gateSkipReason}`;
  } else {
    try {
      if (step.channel === "email") {
        const beforeDispatch = async () => {
          try {
            const [currentEnrollment] = await db.select().from(playbookEnrollmentsTable).where(and(eq(playbookEnrollmentsTable.organizationId, organizationId), eq(playbookEnrollmentsTable.id, enrollment.id)));
            const [currentLead] = await db.select().from(leadsTable).where(and(eq(leadsTable.organizationId, organizationId), eq(leadsTable.id, lead.id)));
            const [currentContact] = await db.select().from(contactsTable).where(and(eq(contactsTable.organizationId, organizationId), eq(contactsTable.id, contact.id)));
            const [currentPlaybook] = await db.select().from(playbooksTable).where(and(eq(playbooksTable.organizationId, organizationId), eq(playbooksTable.id, playbook.id)));
            // The claimed final step is already completed; require its exact
            // claimed state rather than pretending it is still unclaimed work.
            if (Date.now() >= claimExpiresAt || !currentEnrollment || currentEnrollment.status !== claimed.status || currentEnrollment.currentStep !== claimed.currentStep ||
                currentEnrollment.playbookId !== playbook.id || currentEnrollment.leadId !== lead.id || currentEnrollment.pauseReason !== claimed.pauseReason ||
                !currentLead || currentLead.contactId !== contact.id || currentLead.assignedUserId !== emailSenderUserId ||
                currentLead.status !== lead.status || currentLead.updatedAt.getTime() !== lead.updatedAt.getTime() ||
                !currentContact || currentContact.email !== contact.email || currentContact.firstName !== contact.firstName ||
                !currentPlaybook?.isActive || !isDeepStrictEqual(currentPlaybook.steps, playbook.steps) || currentPlaybook.kind !== playbook.kind || currentPlaybook.category !== playbook.category ||
                await customerWorkHeld(organizationId) || needsSourceVerification(currentLead) || await hasCustomerReplyHold(organizationId, lead.id) ||
                await getBusinessName(organizationId) !== businessName) throw new EmailDispatchBlockedError();
            if (currentPlaybook.kind !== "post_sale" && currentPlaybook.category === "acquisition") {
              const behavior = (await getPlaybookStageBehaviors(organizationId))[currentLead.status] ?? { action: "complete" };
              if (behavior.action !== "continue" && !(behavior.action === "enroll" && behavior.enrollPlaybookId === playbook.id)) throw new EmailDispatchBlockedError();
            }
            const sender = await getUserEmailStatus(organizationId, emailSenderUserId!);
            if (!sender.senderActive || !sender.configured || !sender.connected || sender.provider !== expectedEmailSender?.provider ||
                sender.email?.trim().toLowerCase() !== expectedEmailSender?.senderEmail ||
                !(await checkSendEligibility({ organizationId, leadId: lead.id, contact: currentContact, channel: "email", kind: "outreach", touchLogicalKey })).ok) throw new EmailDispatchBlockedError();
            await assertContactTouchCurrent(db, contactTouch);
          } catch { throw new EmailDispatchBlockedError(); }
        };
        sendResult = await sendEmailForUser({
          organizationId,
          userId: emailSenderUserId!,
          to: contact.email!,
          subject:
            variant.subject ?? step.subject ?? `${businessName} — following up`,
          body:
            draft.body +
            linkSuffix +
            unsubscribeFooter(organizationId, contact.id),
          expectedSender: expectedEmailSender,
          beforeDispatch: async () => {
            await beforeDispatch();
            await markContactTouchDispatchStarted(organizationId, touchLogicalKey);
          },
        });
      } else {
        await assertContactTouchCurrent(db, contactTouch);
        sendResult = await providers.sms.send(
          contact.phone!,
          draft.body + linkSuffix,
          { organizationId, contactId: contact.id, purpose: 'marketing', idempotencyKey: touchLogicalKey,
            contactTouch: { logicalKey: touchLogicalKey, payloadHash: sourceFingerprint(contactTouch.payload) } },
        );
      }
    } catch (err) {
      if (err instanceof EmailDispatchBlockedError) {
        const reason = "Final email guard changed before dispatch; this claimed touch is retained and will not replay";
        const entry: EnrollmentHistoryEntry = { at: new Date().toISOString(), kind: "paused", stepIndex, channel: step.channel, detail: reason };
        await db.update(playbookEnrollmentsTable).set({ status: "paused", pauseReason: reason, nextRunAt: null,
          history: sql`${playbookEnrollmentsTable.history} || ${JSON.stringify([entry])}::jsonb`,
        }).where(and(eq(playbookEnrollmentsTable.organizationId, organizationId), eq(playbookEnrollmentsTable.id, enrollment.id),
          eq(playbookEnrollmentsTable.status, claimed.status), eq(playbookEnrollmentsTable.currentStep, claimed.currentStep)));
        await recordBlockedSend({ organizationId, channel: "email", reason: "final_email_guard_changed", outcome: "blocked", source: "playbook", leadId: lead.id, contactId: contact.id });
        return { status: "skipped", detail: "blocked: final_email_guard_changed; claimed step cannot replay" };
      }
      // Permanently bad address → suppress it and stop the sequence so
      // nothing keeps hammering a dead mailbox/number. Transient/provider
      // config failures rethrow (step is already claimed; no double send).
      const address =
        step.channel === "email" ? contact.email! : contact.phone!;
      const suppressed = await handleProviderFailure({
        organizationId,
        channel: step.channel,
        address,
        err,
        source: "playbook",
      });
      if (!suppressed) throw err;
      await recordBlockedSend({
        organizationId,
        channel: step.channel,
        reason: `suppressed:${suppressed}`,
        outcome: "blocked",
        source: "playbook",
        leadId: lead.id,
        contactId: contact.id,
      });
      await finishEnrollment(
        enrollment.id,
        "stopped",
        `send failed permanently: ${suppressed}`,
      );
      skipDetail = `provider rejected address (${suppressed})`;
    }
  }

  const now = new Date().toISOString();
  if (sendResult) {
    await acceptContactTouch(organizationId, touchLogicalKey);
    // Learning loop: record the touch so downstream outcomes (reply,
    // booking, won/lost) can be attributed to this step + variant.
    await recordTouch({
      organizationId,
      playbookId: playbook.id,
      enrollmentId: enrollment.id,
      leadId: lead.id,
      stepIndex,
      variantKey: variant.key,
      channel: step.channel,
      provider: sendResult.provider,
      providerMessageId: sendResult.id,
    });
    await db.insert(activitiesTable).values({
      organizationId,
      leadId: lead.id,
      contactId: contact.id,
      type: "playbook_touch_sent",
      title: `Playbook ${step.channel === "email" ? "email" : "text"} sent (step ${stepIndex + 1} of ${playbook.steps.length})`,
      body: draft.body,
      metadata: {
        playbookId: playbook.id,
        playbookName: playbook.name,
        enrollmentId: enrollment.id,
        stepIndex,
        channel: step.channel,
        touchLogicalKey,
        ...(step.channel === "email" ? emailAcceptanceEvidence(sendResult, { organizationId, leadId: lead.id, recipientEmail: contact.email! }) : { provider: sendResult.provider, providerMessageId: sendResult.id }),
        senderUserId: emailSenderUserId,
        from: sendResult.senderEmail ?? null,
        aiProvider: draft.provider,
      },
    });
    await appendHistory(enrollment.id, {
      at: now,
      kind: "sent",
      stepIndex,
      channel: step.channel,
      detail: `${sendResult.provider}`,
    });
    await recordAudit({
      organizationId,
      action: "playbook.step_sent",
      entityType: "lead",
      entityId: lead.id,
      metadata: {
        playbookId: playbook.id,
        stepIndex,
        channel: step.channel,
        ...(step.channel === "email" ? emailAcceptanceEvidence(sendResult, { organizationId, leadId: lead.id, recipientEmail: contact.email! }) : { provider: sendResult.provider, providerMessageId: sendResult.id }),
        senderUserId: emailSenderUserId,
        from: sendResult.senderEmail ?? null,
        mock: sendResult.provider.startsWith("mock-"),
      },
    });
  } else {
    await appendHistory(enrollment.id, {
      at: now,
      kind: "step_skipped",
      stepIndex,
      channel: step.channel,
      detail: skipDetail ?? "unreachable",
    });
  }

  return sendResult
    ? { status: "success", detail: `${step.channel}:${sendResult.provider}` }
    : { status: "skipped", detail: skipDetail ?? "unreachable" };
}

async function pauseEnrollment(
  enrollmentId: string,
  reason: string,
): Promise<void> {
  await db
    .update(playbookEnrollmentsTable)
    .set({ status: "paused", pauseReason: reason })
    .where(
      and(
        eq(playbookEnrollmentsTable.id, enrollmentId),
        eq(playbookEnrollmentsTable.status, "active"),
      ),
    );
  await appendHistory(enrollmentId, {
    at: new Date().toISOString(),
    kind: "paused",
    detail: reason,
  });
}
async function finishEnrollment(
  enrollmentId: string,
  status: "completed" | "stopped",
  reason: string,
): Promise<void> {
  await db
    .update(playbookEnrollmentsTable)
    .set({ status, pauseReason: reason, nextRunAt: null })
    .where(eq(playbookEnrollmentsTable.id, enrollmentId));
  await appendHistory(enrollmentId, {
    at: new Date().toISOString(),
    kind: status,
    detail: reason,
  });
}

/**
 * Stop or pause every live enrollment for a lead. Used by conversion
 * triggers (reply received, inspection booked, stage advanced) and the
 * rep-facing pause control. Never throws.
 */
export async function stopEnrollmentsForLead(
  organizationId: string,
  leadId: string,
  reason: string,
  status: "paused" | "completed" | "stopped" = "completed",
  /** When set, only enrollments of this kind are affected. */
  kind?: "outreach" | "post_sale",
  /** When set, only enrollments of this category are affected. */
  category?: PlaybookCategory,
): Promise<void> {
  try {
    const live = await db
      .select()
      .from(playbookEnrollmentsTable)
      .where(
        and(
          eq(playbookEnrollmentsTable.organizationId, organizationId),
          eq(playbookEnrollmentsTable.leadId, leadId),
          inArray(playbookEnrollmentsTable.status, ["active", "paused"]),
          ...(kind ? [eq(playbookEnrollmentsTable.kind, kind)] : []),
          ...(category
            ? [eq(playbookEnrollmentsTable.category, category)]
            : []),
        ),
      );
    for (const enrollment of live) {
      await db
        .update(playbookEnrollmentsTable)
        .set({
          status,
          pauseReason: reason,
          nextRunAt: status === "paused" ? enrollment.nextRunAt : null,
        })
        .where(eq(playbookEnrollmentsTable.id, enrollment.id));
      await appendHistory(enrollment.id, {
        at: new Date().toISOString(),
        kind: status === "paused" ? "paused" : status,
        detail: reason,
      });
    }
  } catch (err) {
    console.error("[playbooks] stopEnrollmentsForLead failed:", err);
  }
}

/** Stop exactly one linked sequence (for campaign cancellation). */
export async function stopEnrollmentById(
  organizationId: string,
  enrollmentId: string,
  reason: string,
): Promise<void> {
  const [stopped] = await db
    .update(playbookEnrollmentsTable)
    .set({ status: "stopped", pauseReason: reason, nextRunAt: null })
    .where(
      and(
        eq(playbookEnrollmentsTable.id, enrollmentId),
        eq(playbookEnrollmentsTable.organizationId, organizationId),
        inArray(playbookEnrollmentsTable.status, ["active", "paused"]),
      ),
    )
    .returning({ id: playbookEnrollmentsTable.id });
  if (stopped) {
    await appendHistory(enrollmentId, {
      at: new Date().toISOString(), kind: "stopped", detail: reason,
    });
  }
}

/**
 * Enroll a lead into a specific playbook by id (stage-behavior hand-off).
 * Bypasses enrollment rules and the outreach-stage check — the admin picked
 * the target explicitly. No-ops when the playbook is missing/inactive/empty
 * or a live enrollment of the same category already exists.
 */
export async function enrollLeadInPlaybookById(
  organizationId: string,
  leadId: string,
  playbookId: string,
): Promise<PlaybookEnrollment | null> {
  const [playbook] = await db
    .select()
    .from(playbooksTable)
    .where(
      and(
        eq(playbooksTable.id, playbookId),
        eq(playbooksTable.organizationId, organizationId),
        eq(playbooksTable.isActive, true),
      ),
    );
  if (!playbook || playbook.steps.length === 0) return null;
  return enrollLead(organizationId, leadId, playbook);
}
/** Rep controls serialize with reply confirmation before changing a step. */
async function changeEnrollmentStep(organizationId: string, enrollmentId: string, operation: "resume" | "skip"): Promise<PlaybookEnrollment | null> {
  return db.transaction(async tx => {
    const [initial] = await tx.select().from(playbookEnrollmentsTable).where(and(
      eq(playbookEnrollmentsTable.id, enrollmentId), eq(playbookEnrollmentsTable.organizationId, organizationId),
    ));
    if (!initial) return null;
    await lockReplyLead(tx, organizationId, initial.leadId);
    const [enrollment] = await tx.select().from(playbookEnrollmentsTable).where(and(
      eq(playbookEnrollmentsTable.id, enrollmentId), eq(playbookEnrollmentsTable.organizationId, organizationId),
    )).for("update");
    if (!enrollment || (operation === "resume" ? enrollment.status !== "paused" : !["active", "paused"].includes(enrollment.status))) return null;
    if (await hasCustomerReplyHold(organizationId, enrollment.leadId, tx)) return enrollment;
    const [playbook] = await tx.select().from(playbooksTable).where(and(eq(playbooksTable.id, enrollment.playbookId), eq(playbooksTable.organizationId, organizationId)));
    if (!playbook) return null;
    const nextIndex = enrollment.currentStep + (operation === "skip" ? 1 : 0);
    const step = playbook.steps[nextIndex];
    if (!step && operation === "resume") return null;
    const entries: EnrollmentHistoryEntry[] = [{ at: new Date().toISOString(), kind: operation === "resume" ? "resumed" : "skipped", ...(operation === "skip" ? { stepIndex: enrollment.currentStep } : {}) }];
    if (!step) entries.push({ at: new Date().toISOString(), kind: "completed", detail: "skipped past final step" });
    const runAt = step ? new Date(Date.now() + (operation === "resume" ? Math.min(step.delayMinutes, 60) : step.delayMinutes) * 60_000) : null;
    const [updated] = await tx.update(playbookEnrollmentsTable).set({
      currentStep: step ? nextIndex : enrollment.currentStep,
      status: step ? "active" : "completed", nextRunAt: runAt,
      pauseReason: step ? null : "skipped past final step",
      history: sql`${playbookEnrollmentsTable.history} || ${JSON.stringify(entries)}::jsonb`,
    }).where(eq(playbookEnrollmentsTable.id, enrollment.id)).returning();
    if (step && runAt) await scheduleStep(updated, nextIndex, runAt, tx);
    return updated;
  });
}

/** Rep control: resume a paused enrollment (reschedules the current step). */
export async function resumeEnrollment(organizationId: string, enrollmentId: string): Promise<PlaybookEnrollment | null> {
  return changeEnrollmentStep(organizationId, enrollmentId, "resume");
}

/** Rep control: skip the current step and schedule the next one now. */
export async function skipEnrollmentStep(organizationId: string, enrollmentId: string): Promise<PlaybookEnrollment | null> {
  return changeEnrollmentStep(organizationId, enrollmentId, "skip");
}

/** The lead-detail panel: live (or most recent) enrollment for a lead. */
export async function getLeadEnrollment(
  organizationId: string,
  leadId: string,
): Promise<
  (PlaybookEnrollment & { playbookName: string; totalSteps: number }) | null
> {
  const [row] = await db
    .select({
      enrollment: playbookEnrollmentsTable,
      playbookName: playbooksTable.name,
      steps: playbooksTable.steps,
    })
    .from(playbookEnrollmentsTable)
    .innerJoin(
      playbooksTable,
      eq(playbookEnrollmentsTable.playbookId, playbooksTable.id),
    )
    .where(
      and(
        eq(playbookEnrollmentsTable.organizationId, organizationId),
        eq(playbookEnrollmentsTable.leadId, leadId),
      ),
    )
    .orderBy(desc(playbookEnrollmentsTable.createdAt))
    .limit(1);
  if (!row) return null;
  return {
    ...row.enrollment,
    playbookName: row.playbookName,
    totalSteps: row.steps.length,
  };
}

/**
 * Apply the org's configured stage→behavior to a lead's live ACQUISITION
 * enrollment after a pipeline-stage change. Defaults preserve the historical
 * behavior (outreach stages continue; everything else completes). Never
 * throws — stage changes must never break CRM flows.
 */
export async function applyStageBehaviorToLead(
  organizationId: string,
  leadId: string,
  status: string,
  allowEnrollment = true,
): Promise<void> {
  try {
    const behaviors = await getPlaybookStageBehaviors(organizationId);
    const behavior: StageBehavior = behaviors[status] ?? { action: "complete" };
    switch (behavior.action) {
      case "continue":
        return;
      case "pause":
        await stopEnrollmentsForLead(
          organizationId,
          leadId,
          `lead moved to ${status}`,
          "paused",
          undefined,
          "acquisition",
        );
        return;
      case "cancel":
        await stopEnrollmentsForLead(
          organizationId,
          leadId,
          `lead moved to ${status}`,
          "stopped",
          undefined,
          "acquisition",
        );
        return;
      case "enroll": {
        const target = behavior.enrollPlaybookId;
        // Don't hand off to itself: if the lead's live acquisition enrollment
        // is already the target playbook, leave it running.
        if (target) {
          const [live] = await db
            .select({ playbookId: playbookEnrollmentsTable.playbookId })
            .from(playbookEnrollmentsTable)
            .where(
              and(
                eq(playbookEnrollmentsTable.organizationId, organizationId),
                eq(playbookEnrollmentsTable.leadId, leadId),
                inArray(playbookEnrollmentsTable.status, ["active", "paused"]),
                eq(playbookEnrollmentsTable.category, "acquisition"),
              ),
            );
          if (live?.playbookId === target) return;
        }
        await stopEnrollmentsForLead(
          organizationId,
          leadId,
          `lead moved to ${status} — handed off`,
          "completed",
          undefined,
          "acquisition",
        );
        if (target && allowEnrollment) {
          await enrollLeadInPlaybookById(organizationId, leadId, target);
        }
        return;
      }
      case "complete":
      default:
        await stopEnrollmentsForLead(
          organizationId,
          leadId,
          `lead moved to ${status}`,
          "completed",
          undefined,
          "acquisition",
        );
    }
  } catch (err) {
    console.error("[playbooks] applyStageBehaviorToLead failed:", err);
  }
}

/**
 * Rep control: pause ONE live enrollment by id (org-scoped). Other live
 * enrollments the lead holds in different categories are unaffected.
 */
export async function pauseEnrollmentById(
  organizationId: string,
  enrollmentId: string,
  reason: string,
): Promise<PlaybookEnrollment | null> {
  const [updated] = await db
    .update(playbookEnrollmentsTable)
    .set({ status: "paused", pauseReason: reason })
    .where(
      and(
        eq(playbookEnrollmentsTable.id, enrollmentId),
        eq(playbookEnrollmentsTable.organizationId, organizationId),
        eq(playbookEnrollmentsTable.status, "active"),
      ),
    )
    .returning();
  if (!updated) return null;
  await appendHistory(updated.id, {
    at: new Date().toISOString(),
    kind: "paused",
    detail: reason,
  });
  return updated;
}
