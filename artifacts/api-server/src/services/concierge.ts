/**
 * AI Roof Concierge — server-side dialogue orchestration.
 *
 * The engine is a deterministic slot-filling state machine (so intake is
 * reliable and testable), with the AI provider interface used to produce the
 * internal sales summary. Guardrails: the assistant never guarantees
 * insurance approval, pricing, damage conclusions, or structural safety, and
 * emits emergency safety language when danger is indicated.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { isoSchema, uuidSchema, digestSchema, manualSourceRefSchema, schedulingMutationReviewSchema, resolveWallTime, type ManualSourceRef, type SchedulingCandidate } from "@workspace/scheduling-core";
import { dispatchWebhookEvent } from "./webhooks";
import {
  DEFAULT_CONCIERGE_SETTINGS,
  type ConciergeIntent,
  type ConciergeSettings,
  activitiesTable,
  appointmentsTable,
  auditEventsTable,
  consentRecordsTable,
  contactsTable,
  conversationMessagesTable,
  conversationsTable,
  crmTasksTable,
  db,
  leadsTable,
  organizationsTable,
  propertiesTable,
  DEFAULT_LEAD_SCORING,
  type Conversation,
  type LeadScoringSettings,
  type Urgency,
} from "@workspace/db";
import { and, asc, eq, gt, gte, inArray, lt, lte, sql } from "drizzle-orm";

import {
  cancelScheduledFollowups,
  emitAutomationEvent,
  scheduleAppointmentReminder,
} from "./automation";
import {
  type AttributionInput,
  behaviorSignals,
  buildTouch,
  clampScore,
  leadAttributionColumns,
} from "./attribution";
import { insertInspectionInTransaction, prepareInspectionInTransaction } from "./inspection-booking";
import { appointmentCustomer, ScheduleError, type ScheduleTransaction } from "./contractor-scheduling";
import { lockSchedulingConfiguration, readSchedulingContext, SchedulingPolicyError } from "./scheduling-policy";
import { appendSchedulingTransition, unlinkedSchedulingSource, type ServerSchedulingAuthority } from "./scheduling-admission";
import { CustomerLifecycleHoldError, getCustomerLifecycleStatus } from "./customer-lifecycle";
import { stopEnrollmentsForLead } from "./playbooks";
import { recordLeadOutcome } from "./playbook-learning";
import { buildKnowledgeFacts, findKnowledgeAnswer } from "./knowledge";
import { isSafeMailbox, mockAiProvider, openAiProvider, providers, type AiProvider } from "./providers";
import { emailAcceptanceEvidence } from "./user-email";
import { getAiInstructions, getConciergeSettings, getLeadScoring, getOrgSettings } from "./settings";

/** Concierge-scoped provider selection: real OpenAI when a key is present. */
function conciergeAi(): AiProvider {
  return process.env.OPENAI_API_KEY ? openAiProvider : mockAiProvider;
}

export const CONCIERGE_DISCLOSURE_VERSION = "concierge-v1-2026-08";

/** Effective organization concierge config. */
export type ConciergeConfig = Required<ConciergeSettings>;

/** Intent catalog as a key-indexed map for a config. */
function intentMap(cfg: ConciergeConfig): Record<string, ConciergeIntent> {
  return Object.fromEntries(cfg.intents.map((i) => [i.key, i]));
}

const DEFAULT_CFG: ConciergeConfig = DEFAULT_CONCIERGE_SETTINGS;

type Step =
  | "intent"
  | "emergency_check"
  | "details"
  | "name"
  | "phone"
  | "email"
  | "address_street"
  | "address_city"
  | "property_type"
  | "contact_method"
  | "consent"
  | "scheduling"
  | "done";

export interface ConciergeState {
  step: Step;
  intent?: string;
  urgency: Urgency;
  emergencyFlag?: boolean;
  details?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string | null;
  addressLine1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  addressRaw?: string;
  addressRetries?: number;
  propertyType?: string;
  contactMethod?: string;
  consentGranted?: boolean;
  offeredSlots?: OfferedSlot[];
  appointmentId?: string;
  appointmentStart?: string;
  appointmentLabel?: string;
  confirmationSentVia?: string;
  slotDeclined?: boolean;
  contactId?: string;
  propertyId?: string;
  leadId?: string;
  [key: string]: unknown;
}

// Universal guardrails — deliberately NOT org-configurable: every industry
// gets the same protection against emergencies going unnoticed and against
// the assistant inventing pricing/insurance/safety conclusions.
const EMERGENCY_KEYWORDS = /collaps|sagging|sparking|pouring in|gushing|emergency/i;
const PROHIBITED_TOPIC = /how much|price|pricing|cost|quote|estimate\??$|will insurance|covered by insurance|approve|guarantee|total(ed| loss)|is it safe/i;
/** A visitor message that reads as a question rather than an intake answer. */
const QUESTION_LIKE = /\?\s*$/;

interface OfferedSlot {
  label: string;
  start: string; // ISO
  end: string; // ISO
}
export const conciergeInspectionOfferSchema = z.strictObject({
  formatVersion: z.literal(1), organizationId: uuidSchema, conversationId: uuidSchema,
  appointmentId: uuidSchema, label: z.string().min(1).max(500), start: isoSchema, end: isoSchema,
  source: manualSourceRefSchema, sourceFingerprint: digestSchema, review: schedulingMutationReviewSchema,
});
export type ConciergeInspectionOffer = z.infer<typeof conciergeInspectionOfferSchema>;
const conciergeBookingProofSchema = z.strictObject({
  formatVersion: z.literal(1), appointmentId: uuidSchema, auditId: uuidSchema, offerFingerprint: digestSchema,
  start: isoSchema, end: isoSchema, label: z.string().min(1).max(500),
});
function offerCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(offerCanonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([key,v]) => `${JSON.stringify(key)}:${offerCanonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const offerFingerprint = (value: unknown) => createHash("sha256").update(offerCanonical(value)).digest("hex");
function detectIntent(text: string, cfg: ConciergeConfig): string | undefined {
  const trimmed = text.trim().toLowerCase();
  const byLabel = cfg.intents.find((i) => i.label.toLowerCase() === trimmed);
  if (byLabel) return byLabel.key;
  const haystack = text.toLowerCase();
  for (const intent of cfg.intents) {
    if (intent.keywords.some((k) => haystack.includes(k))) return intent.key;
  }
  return undefined;
}

function isYes(text: string): boolean {
  return /^\s*(y|yes|yeah|yep|yup|correct|it is|sure)\b/i.test(text);
}
function isNo(text: string): boolean {
  return /^\s*(n|no|nope|nah|not)\b/i.test(text);
}

function promptFor(step: Step, state: ConciergeState, cfg: ConciergeConfig): { text: string; quickReplies: string[] } {
  switch (step) {
    case "intent":
      return {
        text: "What brought you in today? Pick the closest option or describe it in your own words.",
        quickReplies: cfg.intents.map((i) => i.label),
      };
    case "emergency_check":
      return {
        text: "Quick safety check: is water actively coming in right now, is any ceiling or roof section sagging, or is water near outlets or light fixtures?",
        quickReplies: ["Yes", "No"],
      };
    case "details":
      return {
        text: "Got it. In a sentence or two — when did this start, and what are you seeing?",
        quickReplies: [],
      };
    case "name":
      return { text: "What's your name?", quickReplies: [] };
    case "phone":
      return {
        text: `Thanks${state.firstName ? `, ${state.firstName}` : ""}. What's the best phone number to reach you?`,
        quickReplies: [],
      };
    case "email":
      return {
        text: "And your email? (Type “skip” if you'd rather not share it.)",
        quickReplies: ["Skip"],
      };
    case "address_street":
      return { text: "What's the street address of the property?", quickReplies: [] };
    case "address_city":
      return {
        text: "And the city, state and ZIP? (e.g. “Springfield, TX 75001”)",
        quickReplies: [],
      };
    case "property_type":
      return {
        text: "Is this a residential or commercial property?",
        quickReplies: ["Residential", "Commercial"],
      };
    case "contact_method":
      return {
        text: "How do you prefer we reach you — call, text, or email?",
        quickReplies: ["Call", "Text", "Email"],
      };
    case "consent":
      return {
        text: "Last step: do we have your permission to contact you by phone, text, and email about this request? Message and data rates may apply; you can opt out anytime. (Consent disclosure " + CONCIERGE_DISCLOSURE_VERSION + ")",
        quickReplies: ["Yes, you have my consent", "No"],
      };
    default:
      return { text: "", quickReplies: [] };
  }
}

export function scoreConcierge(
  state: ConciergeState,
  weights: LeadScoringSettings = DEFAULT_LEAD_SCORING,
  cfg: ConciergeConfig = DEFAULT_CFG,
): { score: number; scoreReasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const intent = state.intent ? intentMap(cfg)[state.intent] : undefined;
  if (intent && state.intent) {
    score += weights.intentPoints[state.intent] ?? intent.points;
    reasons.push(intent.reason);
  }
  if (state.urgency === "emergency") {
    score += weights.emergencyUrgencyBonus;
    reasons.push("Emergency conditions reported in concierge chat");
  } else if (state.urgency === "high") {
    score += weights.highUrgencyBonus;
    reasons.push("High urgency");
  }
  if (state.email) {
    score += weights.emailProvidedBonus;
    reasons.push("Email provided");
  }
  if (state.addressLine1 && state.postalCode) {
    score += weights.completeAddressBonus;
    reasons.push("Complete property address provided");
  }
  if (state.details && state.details.length > 40) {
    score += weights.detailedDescriptionBonus;
    reasons.push("Detailed problem description");
  }
  if (state.contactMethod) {
    score += weights.contactMethodBonus;
    reasons.push("Preferred contact method confirmed");
  }
  if (state.consentGranted) {
    score += weights.smsConsentBonus;
    reasons.push("Contact consent granted (fast follow-up possible)");
  }
  if (state.appointmentId) {
    score += 10;
    reasons.push("Inspection appointment booked in chat");
  }
  return { score: Math.max(0, Math.min(Math.round(score), 100)), scoreReasons: reasons };
}

function knownFacts(state: ConciergeState, cfg: ConciergeConfig = DEFAULT_CFG): string[] {
  const facts: string[] = [];
  const intent = state.intent ? intentMap(cfg)[state.intent] : undefined;
  if (intent) facts.push(`Request: ${intent.label} (recommended service: ${intent.service})`);
  facts.push(`Urgency: ${state.urgency}${state.emergencyFlag ? " — hazard conditions reported (safety guidance sent)" : ""}`);
  if (state.details) facts.push(`Homeowner description: ${state.details.slice(0, 300)}`);
  if (state.firstName) facts.push(`Name: ${[state.firstName, state.lastName].filter(Boolean).join(" ")}`);
  if (state.phone) facts.push(`Phone: ${state.phone}`);
  if (state.email) facts.push(`Email: ${state.email}`);
  if (state.addressLine1) {
    facts.push(
      `Property: ${state.addressLine1}${state.city ? `, ${state.city}` : ""}${state.state ? `, ${state.state}` : ""} ${state.postalCode ?? ""}`.trim(),
    );
  } else if (state.addressRaw) {
    facts.push(`Address (unparsed, verify with caller): ${state.addressRaw}`);
  }
  if (state.propertyType) facts.push(`Property type: ${state.propertyType}`);
  if (state.contactMethod) facts.push(`Preferred contact: ${state.contactMethod}`);
  if (state.appointmentId && state.appointmentStart) {
    facts.push(`Inspection appointment: booked in chat for ${new Date(state.appointmentStart).toISOString()}`);
  } else if (state.slotDeclined) {
    facts.push("Inspection appointment: homeowner skipped slot selection — team should call to schedule");
  }
  facts.push(
    state.consentGranted === undefined
      ? "Consent: not yet captured"
      : `Consent: ${state.consentGranted ? "granted" : "declined"} (${CONCIERGE_DISCLOSURE_VERSION})`,
  );
  return facts;
}

/** Deterministic internal summary used for partial/progressive updates. */
function buildPartialSummary(state: ConciergeState, cfg: ConciergeConfig = DEFAULT_CFG): string {
  return ["Concierge intake (in progress)", ...knownFacts(state, cfg)].join("\n");
}

/**
 * Progressive lead upsert — creates contact/lead as soon as name+phone exist
 * and keeps updating as more slots fill so abandoned chats aren't lost.
 */
async function syncLead(
  organizationId: string,
  conversation: Conversation,
  state: ConciergeState,
  opts: { sourceIp?: string; userAgent?: string; final?: boolean },
): Promise<void> {
  if (!state.firstName || !state.phone) return;
  const cfg = await getConciergeSettings(organizationId);
  const weights = await getLeadScoring(organizationId);
  const base = scoreConcierge(state, weights, cfg);
  // Website behavior signals (empty when the chat carried no visitor id).
  const behavior = await behaviorSignals(
    organizationId,
    typeof state.anonymousId === "string" ? state.anonymousId : null,
    weights,
  );
  const behaviorScored = {
    score: clampScore(base.score + behavior.points),
    scoreReasons: [...base.scoreReasons, ...behavior.reasons],
  };
  const intent = state.intent ? intentMap(cfg)[state.intent] : undefined;

  await db.transaction(async (tx) => {
    if (!state.contactId) {
      const [contact] = await tx
        .insert(contactsTable)
        .values({
          organizationId,
          firstName: state.firstName!,
          lastName: state.lastName ?? null,
          email: state.email ?? null,
          phone: state.phone!,
          preferredContactMethod: state.contactMethod ?? null,
        })
        .returning();
      state.contactId = contact.id;
    } else {
      await tx
        .update(contactsTable)
        .set({
          lastName: state.lastName ?? null,
          email: state.email ?? null,
          phone: state.phone!,
          // Persist the booking-time channel choice so later reminder
          // scheduling (e.g. after a CRM reschedule) honors it.
          preferredContactMethod: state.contactMethod ?? undefined,
        })
        .where(and(eq(contactsTable.id, state.contactId), eq(contactsTable.organizationId, organizationId)));
    }

    if (!state.propertyId && state.addressLine1 && state.city && state.state && state.postalCode) {
      const [property] = await tx
        .insert(propertiesTable)
        .values({
          organizationId,
          contactId: state.contactId!,
          addressLine1: state.addressLine1,
          city: state.city,
          state: state.state,
          postalCode: state.postalCode,
          propertyType: state.propertyType ?? null,
        })
        .returning();
      state.propertyId = property.id;
    }

    const source = conversation.source ?? "concierge";
    const touch = buildTouch({
      channel: "web_chat",
      source,
      attribution: (state.attribution as AttributionInput | undefined) ?? null,
    });
    if (!state.leadId) {
      const [lead] = await tx
        .insert(leadsTable)
        .values({
          organizationId,
          contactId: state.contactId!,
          propertyId: state.propertyId ?? null,
          status: opts.final ? "ai_qualified" : "new",
          urgency: state.urgency,
          serviceType: intent?.service ?? state.intent ?? null,
          sourceDetail: "ai-roof-concierge",
          score: behaviorScored.score,
          scoreReasons: behaviorScored.scoreReasons,
          summary: buildPartialSummary(state, cfg).split("\n").slice(0, 2).join(" — "),
          ...leadAttributionColumns({
            source,
            creationMethod: "concierge",
            touch,
            anonymousId: typeof state.anonymousId === "string" ? state.anonymousId : null,
          }),
        })
        .returning();
      state.leadId = lead.id;
      await tx
        .update(conversationsTable)
        .set({ leadId: lead.id, contactId: state.contactId })
        .where(eq(conversationsTable.id, conversation.id));
      await tx.insert(activitiesTable).values({
        organizationId,
        leadId: lead.id,
        contactId: state.contactId,
        type: "lead_captured",
        title: `Lead created by ${cfg.assistantName}`,
        body: buildPartialSummary(state, cfg),
        metadata: {
          conversationId: conversation.id,
          score: behaviorScored.score,
          scoreReasons: behaviorScored.scoreReasons,
        },
      });
      await tx.insert(auditEventsTable).values({
        organizationId,
        actorUserId: null,
        action: "lead.captured_concierge",
        entityType: "lead",
        entityId: lead.id,
        metadata: { conversationId: conversation.id },
      });
    } else {
      await tx
        .update(leadsTable)
        .set({
          propertyId: state.propertyId ?? null,
          urgency: state.urgency,
          serviceType: intent?.service ?? state.intent ?? null,
          score: behaviorScored.score,
          scoreReasons: behaviorScored.scoreReasons,
          status: opts.final ? "ai_qualified" : undefined,
          lastTouch: touch as unknown as Record<string, unknown>,
          latestSource: source,
        })
        .where(and(eq(leadsTable.id, state.leadId), eq(leadsTable.organizationId, organizationId)));
    }
  });
}

async function recordConsent(
  organizationId: string,
  state: ConciergeState,
  granted: boolean,
  opts: { sourceIp?: string; userAgent?: string },
): Promise<void> {
  if (!state.contactId) return;
  await db.insert(consentRecordsTable).values(
    (["sms", "email", "phone"] as const).map((channel) => ({
      organizationId,
      contactId: state.contactId!,
      channel,
      granted,
      disclosureVersion: CONCIERGE_DISCLOSURE_VERSION,
      sourceIp: opts.sourceIp ?? null,
      userAgent: opts.userAgent ?? null,
    })),
  );
}

export async function startConversation(params: {
  organizationId: string;
  source?: string;
  intentHint?: string;
  attribution?: AttributionInput | null;
  anonymousId?: string | null;
}): Promise<{
  conversationId: string;
  messages: string[];
  quickReplies: string[];
  emergency: boolean;
  done: boolean;
  leadId: string | null;
  urgency: Urgency;
}> {
  const cfg = await getConciergeSettings(params.organizationId);
  const intents = intentMap(cfg);
  const hinted = params.intentHint ? detectIntent(params.intentHint, cfg) : undefined;
  const state: ConciergeState = { step: "intent", urgency: "normal" };
  // Attribution + visitor id captured at chat start ride in the conversation
  // state; they reach the lead only if the visitor later identifies
  // themselves (name + phone) — anonymous chats never link.
  if (params.attribution) state.attribution = params.attribution;
  if (params.anonymousId && typeof params.anonymousId === "string") {
    state.anonymousId = params.anonymousId.slice(0, 100);
  }
  const messages: string[] = [
    cfg.greeting,
  ];
  let quickReplies: string[];
  if (hinted) {
    state.intent = hinted;
    state.urgency = intents[hinted].urgency;
    state.step = intents[hinted].triage ? "emergency_check" : "details";
    const p = promptFor(state.step, state, cfg);
    messages.push(p.text);
    quickReplies = p.quickReplies;
  } else {
    const p = promptFor("intent", state, cfg);
    messages.push(p.text);
    quickReplies = p.quickReplies;
  }

  const [conversation] = await db
    .insert(conversationsTable)
    .values({
      organizationId: params.organizationId,
      source: params.source ?? "public-site",
      intent: state.intent ?? null,
      urgency: state.urgency,
      state: state as Record<string, unknown>,
    })
    .returning();
  await db.insert(conversationMessagesTable).values(
    messages.map((content) => ({
      organizationId: params.organizationId,
      conversationId: conversation.id,
      role: "assistant" as const,
      content,
    })),
  );
  return {
    conversationId: conversation.id,
    messages,
    quickReplies,
    emergency: false,
    done: false,
    leadId: null,
    urgency: state.urgency,
  };
}

export async function handleMessage(params: {
  organizationId: string;
  conversationId: string;
  content: string;
  sourceIp?: string;
  userAgent?: string;
}): Promise<
  | {
      conversationId: string;
      messages: string[];
      quickReplies: string[];
      emergency: boolean;
      done: boolean;
      leadId: string | null;
      urgency: Urgency;
    }
  | null
> {
  const [conversation] = await db
    .select()
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.id, params.conversationId),
        eq(conversationsTable.organizationId, params.organizationId),
      ),
    );
  if (!conversation) return null;

  const state = { urgency: "normal", step: "intent", ...(conversation.state as Partial<ConciergeState>) } as ConciergeState;
  const text = params.content.trim();
  const out: string[] = [];
  let quickReplies: string[] = [];

  // Homeowner picked an abandoned chat back up: reactivate it, drop the
  // partial-summary snapshot, and cancel any pending abandoned-chat
  // follow-up automations so they aren't contacted about a chat they resumed.
  const resumed = conversation.status === "abandoned";
  if (resumed) {
    if (conversation.leadId) {
      const cancelled = await cancelScheduledFollowups(
        params.organizationId,
        conversation.leadId,
        "assessment.abandoned",
      );
      // Close out any auto-created "chase abandoned chat" tasks so a rep
      // doesn't call about a chat that's now active again.
      const closedTasks = await db
        .update(crmTasksTable)
        .set({ status: "done", completedAt: new Date() })
        .where(
          and(
            eq(crmTasksTable.organizationId, params.organizationId),
            eq(crmTasksTable.leadId, conversation.leadId),
            inArray(crmTasksTable.status, ["open", "in_progress"]),
            eq(crmTasksTable.sourceEvent, "assessment.abandoned"),
          ),
        )
        .returning({ id: crmTasksTable.id, title: crmTasksTable.title });
      // Visible timeline entry so the team can skip redundant outreach.
      await db.insert(activitiesTable).values({
        organizationId: params.organizationId,
        leadId: conversation.leadId,
        contactId: conversation.contactId ?? null,
        type: "conversation_resumed",
        title: "Homeowner resumed the concierge chat",
        body: [
          "The homeowner came back to a chat that had been marked abandoned — no need to chase this one.",
          cancelled > 0 ? `Cancelled ${cancelled} pending follow-up${cancelled === 1 ? "" : "s"}.` : null,
          closedTasks.length > 0
            ? `Closed ${closedTasks.length} auto-created follow-up task${closedTasks.length === 1 ? "" : "s"}: ${closedTasks.map((t) => t.title).join(", ")}.`
            : null,
        ]
          .filter(Boolean)
          .join(" "),
        metadata: {
          conversationId: conversation.id,
          cancelledFollowups: cancelled,
          closedTaskIds: closedTasks.map((t) => t.id),
        },
      });
      // The homeowner is actively chatting again — pause automated
      // playbook outreach so the concierge conversation isn't stepped on.
      await stopEnrollmentsForLead(
        params.organizationId,
        conversation.leadId,
        "homeowner resumed concierge chat",
        "paused",
      );
      // Learning loop: a resumed chat is a reply — attribute it to the
      // outreach touches that preceded it.
      await recordLeadOutcome(params.organizationId, conversation.leadId, "replied");
      // Outbound webhook mirror: outside systems can react to the reply.
      void dispatchWebhookEvent(params.organizationId, "lead.replied", {
        leadId: conversation.leadId,
        channel: "concierge",
      }).catch(() => {});
      await db.insert(auditEventsTable).values({
        organizationId: params.organizationId,
        actorUserId: null,
        action: "conversation.resumed",
        entityType: "conversation",
        entityId: conversation.id,
        metadata: { leadId: conversation.leadId, cancelledFollowups: cancelled },
      });
    } else {
      await db.insert(auditEventsTable).values({
        organizationId: params.organizationId,
        actorUserId: null,
        action: "conversation.resumed",
        entityType: "conversation",
        entityId: conversation.id,
        metadata: { leadId: null, cancelledFollowups: 0 },
      });
    }
  }

  await db.insert(conversationMessagesTable).values({
    organizationId: params.organizationId,
    conversationId: conversation.id,
    role: "user",
    content: text,
  });

  const cfg = await getConciergeSettings(params.organizationId);
  const intents = intentMap(cfg);

  // Global guardrail: pricing / insurance-approval / safety-conclusion asks.
  const prohibited = PROHIBITED_TOPIC.test(text) && state.step !== "consent";
  if (prohibited) {
    out.push(cfg.intakeDisclaimer);
  }
  // Global emergency keyword watch at any step.
  if (EMERGENCY_KEYWORDS.test(text) && !state.emergencyFlag) {
    state.emergencyFlag = true;
    state.urgency = "emergency";
    out.push(cfg.emergencySafety, cfg.emergencyEscalation);
  }

  // Knowledge-grounded Q&A: when the visitor asks a question mid-intake, the
  // concierge answers ONLY from the org knowledge base. On a match it quotes
  // the stored entry and re-asks the current step; with no match it says it
  // doesn't know (never guesses) and flags it for human follow-up. Yes/no
  // steps are exempt ("is that ok?" style answers must stay in the flow).
  let answeredQuestion = false;
  if (
    QUESTION_LIKE.test(text) &&
    !["emergency_check", "consent", "scheduling"].includes(state.step)
  ) {
    const entry = await findKnowledgeAnswer(params.organizationId, text);
    if (entry) {
      out.push(entry.content);
      answeredQuestion = true;
    } else if (!prohibited) {
      out.push(cfg.unknownAnswerFallback);
      state.openQuestions = [
        ...((state.openQuestions as string[] | undefined) ?? []),
        text.slice(0, 300),
      ].slice(-5);
      // Not a hard stop: intake continues so contact info still gets captured
      // for the human follow-up.
      answeredQuestion = state.step !== "intent";
    } else {
      answeredQuestion = state.step !== "intent";
    }
  }

  if (answeredQuestion) {
    const p = promptFor(state.step, state, cfg);
    if (p.text) out.push(p.text);
    quickReplies = p.quickReplies;
  } else
  switch (state.step) {
    case "intent": {
      const intent = detectIntent(text, cfg);
      if (!intent) {
        out.push("I want to route you to the right team. Which of these is closest to your situation?");
        quickReplies = cfg.intents.map((i) => i.label);
        break;
      }
      state.intent = intent;
      if (intents[intent].urgency !== "normal" || state.urgency === "normal") {
        state.urgency = state.emergencyFlag ? "emergency" : intents[intent].urgency;
      }
      state.step = intents[intent].triage && !state.emergencyFlag ? "emergency_check" : "details";
      break;
    }
    case "emergency_check": {
      if (isYes(text) || (state.emergencyFlag && !isNo(text))) {
        if (!state.emergencyFlag) {
          state.emergencyFlag = true;
          state.urgency = "emergency";
          out.push(cfg.emergencySafety, cfg.emergencyEscalation);
        }
      } else if (isNo(text)) {
        out.push("Good — no immediate hazard signs. Let's keep this moving.");
      } else {
        out.push("Just to be safe, is that a yes or a no?");
        quickReplies = ["Yes", "No"];
        break;
      }
      state.step = "details";
      break;
    }
    case "details": {
      state.details = text;
      if (!out.some((m) => m === cfg.intakeDisclaimer)) out.push(cfg.intakeDisclaimer);
      state.step = "name";
      break;
    }
    case "name": {
      const parts = text.replace(/^(i'?m|my name is|this is)\s+/i, "").split(/\s+/);
      state.firstName = parts[0];
      state.lastName = parts.slice(1).join(" ") || undefined;
      state.step = "phone";
      break;
    }
    case "phone": {
      const digits = text.replace(/\D/g, "");
      if (digits.length < 7) {
        out.push("That number looks short — could you share a full phone number with area code?");
        break;
      }
      state.phone = text;
      state.step = "email";
      break;
    }
    case "email": {
      if (/^skip$/i.test(text) || isNo(text)) {
        state.email = null;
      } else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        state.email = text;
      } else {
        out.push("That doesn't look like a valid email — try again, or type “skip”.");
        quickReplies = ["Skip"];
        break;
      }
      state.step = "address_street";
      break;
    }
    case "address_street": {
      state.addressLine1 = text;
      state.step = "address_city";
      break;
    }
    case "address_city": {
      const m = text.match(/^(.+?)[,\s]+([A-Za-z]{2})[,\s]+(\d{4,10}(?:-\d{4})?)$/);
      if (m) {
        state.city = m[1].trim();
        state.state = m[2].toUpperCase();
        state.postalCode = m[3];
        state.step = "property_type";
      } else {
        state.addressRetries = (state.addressRetries ?? 0) + 1;
        if (state.addressRetries >= 2) {
          state.addressRaw = `${state.addressLine1 ?? ""} ${text}`.trim();
          out.push("No problem — I've noted the address as you wrote it and our team will confirm it with you.");
          state.step = "property_type";
        } else {
          out.push("Almost — could you give it as “City, ST 12345”?");
          break;
        }
      }
      break;
    }
    case "property_type": {
      state.propertyType = /comm/i.test(text) ? "commercial" : "residential";
      state.step = "contact_method";
      break;
    }
    case "contact_method": {
      state.contactMethod = /text|sms/i.test(text) ? "text" : /email/i.test(text) ? "email" : "call";
      state.step = "consent";
      break;
    }
    case "consent": {
      if (isYes(text)) {
        state.consentGranted = true;
      } else if (isNo(text)) {
        state.consentGranted = false;
        out.push("Understood — we won't contact you without permission. Your request is saved, and you're always welcome to call us directly.");
        state.step = "done";
        break;
      } else {
        out.push("Sorry — is that a yes or a no on being contacted?");
        quickReplies = ["Yes, you have my consent", "No"];
        break;
      }
      // Consent granted — offer real inspection windows before wrapping up.
      const slots = await generateInspectionSlots(params.organizationId, { conversationId: conversation.id });
      if (slots.length === 0) {
        state.step = "done";
        break;
      }
      state.offeredSlots = slots;
      state.step = "scheduling";
      out.push(
        [
          "Here are the next company inspection windows. Technician assignment is pending:",
          ...slots.map((s, i) => `${i + 1}. ${s.label}`),
          "Pick one, or skip and our team will call to arrange a time.",
        ].join("\n"),
      );
      quickReplies = [...slots.map((s) => s.label), SLOT_SKIP_LABEL];
      break;
    }
    case "scheduling": {
      const slots = state.offeredSlots ?? [];
      if (/^skip\b/i.test(text) || isNo(text) || text === SLOT_SKIP_LABEL) {
        state.slotDeclined = true;
        out.push("No problem — our team will reach out to find a time that works for you.");
        state.step = "done";
        break;
      }
      const slot = matchSlot(text, slots);
      if (!slot) {
        out.push("Sorry, I didn't catch that — pick one of the windows below, or skip.");
        quickReplies = [...slots.map((s) => s.label), SLOT_SKIP_LABEL];
        break;
      }
      const appointment = await bookInspectionSlot({
        organizationId: params.organizationId,
        conversationId: conversation.id,
        slot,
        leadId: state.leadId ?? null,
        contactId: state.contactId ?? null,
        propertyId: state.propertyId ?? null,
        notes: `Booked by ${cfg.assistantName} during chat${state.intent ? ` (${intents[state.intent]?.label ?? state.intent})` : ""}.`,
      });
      if (!appointment) {
        // The original offer no longer matches current source or scheduling evidence.
        const fresh = await generateInspectionSlots(params.organizationId, { conversationId: conversation.id });
        if (fresh.length === 0) {
          state.offeredSlots = [];
          state.slotDeclined = true;
          out.push(
            "That window or its scheduling details changed, and no current window is available. Our team will call you to arrange a time.",
          );
          state.step = "done";
          break;
        }
        state.offeredSlots = fresh;
        out.push(
          [
            "That window or its scheduling details changed. Here are the current company inspection windows; technician assignment is pending:",
            ...fresh.map((s, i) => `${i + 1}. ${s.label}`),
            "Pick one, or skip and our team will call to arrange a time.",
          ].join("\n"),
        );
        quickReplies = [...fresh.map((s) => s.label), SLOT_SKIP_LABEL];
        break;
      }
      state.appointmentId = appointment.id;
      state.appointmentStart = slot.start;
      state.appointmentLabel = slot.label;
      if (appointment.replayed) return { conversationId: conversation.id, messages: [`Your original inspection window is booked: ${slot.label}. Technician assignment is pending.`], quickReplies: [], emergency: state.urgency === "emergency", done: true, leadId: state.leadId ?? null, urgency: state.urgency };
      // Run the org's appointment.booked automations for chat bookings too
      // (same event the CRM API emits). The direct chat confirmation below is
      // separate and sent exactly once (guarded by confirmationSentVia); any
      // additional messaging here comes only from org-configured rules.
      emitAutomationEvent(params.organizationId, "appointment.booked", {
        appointmentId: appointment.id,
        leadId: state.leadId ?? undefined,
        contactId: state.contactId ?? undefined,
        actorUserId: null,
        fields: {
          "appointment.type": "inspection",
          "appointment.source": "concierge",
          ...(state.urgency ? { "lead.urgency": state.urgency } : {}),
        },
      });
      out.push(
        `📅 Your inspection window is booked: ${slot.label}. Technician assignment is pending. Call us if you need to change the time.`,
      );
      state.step = "done";
      break;
    }
    case "done":
      out.push("You're all set — your request is with our team. If anything changes (especially new leaks or sagging), call us right away.");
      break;
  }

  // Ask the next question if the conversation isn't finished.
  const finishing = state.step === "done" && (conversation.status === "active" || resumed);
  if (state.step !== "done" && quickReplies.length === 0) {
    const p = promptFor(state.step, state, cfg);
    if (p.text) out.push(p.text);
    quickReplies = p.quickReplies;
  }

  // Progressive lead sync + consent + finalization.
  await syncLead(params.organizationId, conversation, state, {
    sourceIp: params.sourceIp,
    userAgent: params.userAgent,
    final: finishing,
  });
  if (finishing && state.consentGranted !== undefined) {
    await recordConsent(params.organizationId, state, state.consentGranted, params);
  }

  // Appointment confirmation — sent once, after consent has been recorded,
  // to the homeowner's preferred contact channel. Never breaks the chat.
  if (finishing && state.appointmentId && !state.confirmationSentVia) {
    try {
      const sentVia = await sendBookingConfirmation(params.organizationId, conversation.id, state);
      if (sentVia) {
        state.confirmationSentVia = sentVia.channel;
        out.push(
          sentVia.channel === "email"
            ? `📧 I've emailed a confirmation with your inspection time to ${sentVia.to}.`
            : `📲 I've texted a confirmation with your inspection time to ${sentVia.to}.`,
        );
      }
    } catch (err) {
      console.error("[concierge] booking confirmation failed:", err);
    }
  }

  let salesSummary: string | undefined;
  if (finishing) {
    const transcript = await db
      .select()
      .from(conversationMessagesTable)
      .where(eq(conversationMessagesTable.conversationId, conversation.id))
      .orderBy(asc(conversationMessagesTable.createdAt));
    const finalWeights = await getLeadScoring(params.organizationId);
    const finalBase = scoreConcierge(state, finalWeights, cfg);
    const finalBehavior = await behaviorSignals(
      params.organizationId,
      typeof state.anonymousId === "string" ? state.anonymousId : null,
      finalWeights,
    );
    const score = clampScore(finalBase.score + finalBehavior.points);
    const scoreReasons = [...finalBase.scoreReasons, ...finalBehavior.reasons];
    try {
      const orgInstructions = await getAiInstructions(params.organizationId);
      const knowledgeFacts = await buildKnowledgeFacts(params.organizationId);
      const ai = await conciergeAi().generateSalesSummary({
        intent: state.intent,
        urgency: state.urgency,
        facts: orgInstructions
          ? [...knownFacts(state, cfg), ...knowledgeFacts, `Org instructions: ${orgInstructions}`]
          : [...knownFacts(state, cfg), ...knowledgeFacts],
        transcript: transcript.map((m) => ({ role: m.role, content: m.content })),
      });
      salesSummary = ai.summary;
    } catch (err) {
      console.warn("[concierge] AI provider failed for sales summary, using mock provider:", err);
      salesSummary = (
        await mockAiProvider.generateSalesSummary({
          intent: state.intent,
          urgency: state.urgency,
          facts: knownFacts(state, cfg),
          transcript: [],
        })
      ).summary;
    }
    if (state.leadId) {
      await db
        .update(leadsTable)
        .set({ summary: salesSummary.split("\n")[0], score, scoreReasons })
        .where(and(eq(leadsTable.id, state.leadId), eq(leadsTable.organizationId, params.organizationId)));
      await db.insert(activitiesTable).values({
        organizationId: params.organizationId,
        leadId: state.leadId,
        contactId: state.contactId ?? null,
        type: "ai_summary",
        title: "AI Concierge sales summary",
        body: salesSummary,
        metadata: { conversationId: conversation.id, score, scoreReasons },
      });
    }
    const intentInfo = state.intent ? intents[state.intent] : undefined;
    out.push(
      [
        state.urgency === "emergency"
          ? "✅ Done — you're flagged as a same-day emergency and a priority callback is queued."
          : state.appointmentId
            ? "✅ Done — your request is in and your inspection is on our calendar."
            : "✅ Done — your request is in and our team will reach out soon.",
        intentInfo ? `Recommended service: ${intentInfo.label} → ${intentInfo.service.replace(/-/g, " ")}.` : "",
        cfg.wrapUpNote,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  // A handler may have started before another message committed a booking.
  // Merge under the conversation lock so an old outer save cannot erase custody.
  await db.transaction(async tx => {
    const where = and(eq(conversationsTable.organizationId, params.organizationId), eq(conversationsTable.id, conversation.id));
    const [current] = await tx.select().from(conversationsTable).where(where).for("update");
    if (!current) return;
    const saved = current.state as Partial<ConciergeState>;
    if (saved.inspectionBooking !== undefined) {
      conciergeBookingProofSchema.parse(saved.inspectionBooking);
      for (const key of ["inspectionBooking", "appointmentId", "appointmentStart", "appointmentLabel", "offeredSlots", "leadId", "contactId", "propertyId", "consentGranted"] as const) (state as Record<string, unknown>)[key] = saved[key];
      state.step = "done";
      if (saved.confirmationSentVia) state.confirmationSentVia = saved.confirmationSentVia;
    }
    await tx.update(conversationsTable).set({
      state: state as Record<string, unknown>, intent: state.intent ?? null, urgency: state.urgency,
      status: saved.inspectionBooking !== undefined || finishing ? "completed" : resumed ? "active" : current.status,
      salesSummary: salesSummary ?? (resumed ? null : current.salesSummary),
      leadId: state.leadId ?? current.leadId, contactId: state.contactId ?? current.contactId,
    }).where(where);
  });

  await db.insert(conversationMessagesTable).values(
    out.map((content) => ({
      organizationId: params.organizationId,
      conversationId: conversation.id,
      role: "assistant" as const,
      content,
    })),
  );

  return {
    conversationId: conversation.id,
    messages: out,
    quickReplies,
    emergency: state.urgency === "emergency",
    done: state.step === "done",
    leadId: state.leadId ?? null,
    urgency: state.urgency,
  };
}

/**
 * Send the homeowner a booking confirmation (date/window, property address,
 * reschedule instructions) via their preferred contact channel. Respects the
 * consent captured in chat: never sends unless consent was granted (which is
 * also required to reach the scheduling step). Logs an activity on the lead
 * and an audit event. Returns the channel used, or null when skipped.
 */
async function sendBookingConfirmation(
  organizationId: string,
  conversationId: string,
  state: ConciergeState,
): Promise<{ channel: "email" | "sms"; to: string } | null> {
  if (!state.appointmentId || !state.appointmentStart || state.consentGranted !== true) return null;

  const settings = await getOrgSettings(organizationId);
  const [orgRow] = await db
    .select({ name: organizationsTable.name })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId));
  const businessName = settings.businessProfile.businessName ?? orgRow?.name ?? "Our team";
  const businessPhone = settings.businessProfile.phone ?? "";

  const windowLabel =
    state.appointmentLabel ??
    new Intl.DateTimeFormat("en-US", {
      timeZone: process.env.CONCIERGE_TIMEZONE ?? "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      hour12: true,
    }).format(new Date(state.appointmentStart));
  const address =
    [state.addressLine1, state.city, state.state, state.postalCode].filter(Boolean).join(", ") ||
    state.addressRaw ||
    "your property";
  const reschedule = businessPhone
    ? `Need to reschedule? Call or text us at ${businessPhone} and we'll find a time that works.`
    : `Need to reschedule? Reply to this message or contact our office and we'll find a time that works.`;

  // Preferred channel first (email if they chose email and shared one; text
  // otherwise), falling back to whichever contact detail we actually have.
  const emailOk = Boolean(state.email && isSafeMailbox(state.email));
  const useEmail = state.contactMethod === "email" ? emailOk : emailOk && !state.phone;

  const bodyLines = [
    `Hi ${state.firstName ?? "there"},`,
    "",
    `Your inspection with ${businessName} is confirmed.`,
    `🗓 When: ${windowLabel}`,
    `🏠 Where: ${address}`,
    "",
    reschedule,
    "",
    `— ${businessName}`,
  ];

  let channel: "email" | "sms";
  let to: string;
  let providerResult: { id: string | null; provider: string; providerRequestId?: string | null; clientRequestId?: string };
  if (useEmail) {
    channel = "email";
    to = state.email!;
    providerResult = await providers.email.send(
      to,
      `Your inspection is confirmed — ${windowLabel}`,
      bodyLines.join("\n"),
      { organizationId, leadId: state.leadId },
    );
  } else if (state.phone) {
    channel = "sms";
    to = state.phone;
    providerResult = await providers.sms.send(
      to,
      `${businessName}: your inspection is confirmed for ${windowLabel} at ${address}. ${reschedule}`,
      { organizationId, contactId: state.contactId!, purpose: 'appointments', idempotencyKey: `appointment:${state.appointmentId}:confirmation` },
    );
  } else if (emailOk) {
    channel = "email";
    to = state.email!;
    providerResult = await providers.email.send(
      to,
      `Your inspection is confirmed — ${windowLabel}`,
      bodyLines.join("\n"),
      { organizationId, leadId: state.leadId },
    );
  } else {
    return null;
  }

  if (state.leadId) {
    await db.insert(activitiesTable).values({
      organizationId,
      leadId: state.leadId,
      contactId: state.contactId ?? null,
      type: "confirmation_sent",
      title: `Inspection confirmation sent via ${channel} — ${windowLabel}`,
      body: `Booking confirmation sent to ${to} (preferred contact: ${state.contactMethod ?? "unknown"}). Provider: ${providerResult.provider}.`,
      metadata: {
        conversationId,
        appointmentId: state.appointmentId,
        channel,
        to,
        ...(channel === "email" ? emailAcceptanceEvidence(providerResult, { organizationId, leadId: state.leadId, recipientEmail: to }) : { provider: providerResult.provider, providerMessageId: providerResult.id }),
        mock: providerResult.provider.startsWith("mock"),
      },
    });
  }
  await db.insert(auditEventsTable).values({
    organizationId,
    actorUserId: null,
    action: "appointment.confirmation_sent",
    entityType: "appointment",
    entityId: state.appointmentId,
    metadata: {
      conversationId,
      leadId: state.leadId ?? null,
      channel,
      provider: providerResult.provider,
      mock: providerResult.provider.startsWith("mock"),
    },
  });
  return { channel, to };
}

/** Idle threshold after which an active conversation counts as abandoned. */
export const ABANDONED_AFTER_MS = 30 * 60_000;

/**
 * Periodic job: mark conversations idle for >30 minutes as abandoned, persist
 * their partial sales summary, and emit `assessment.abandoned` for the linked
 * lead so automations can trigger a follow-up. Runs across all organizations.
 */
export async function markAbandonedConversations(
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - ABANDONED_AFTER_MS);
  const stale = await db
    .select()
    .from(conversationsTable)
    .where(and(eq(conversationsTable.status, "active"), lt(conversationsTable.updatedAt, cutoff)))
    .limit(50);

  let marked = 0;
  for (const conversation of stale) {
    const state = { urgency: "normal", step: "intent", ...(conversation.state as Partial<ConciergeState>) } as ConciergeState;
    const partialSummary = conversation.salesSummary ?? buildPartialSummary(state);
    const [updated] = await db
      .update(conversationsTable)
      .set({ status: "abandoned", salesSummary: partialSummary })
      .where(and(eq(conversationsTable.id, conversation.id), eq(conversationsTable.status, "active")))
      .returning();
    if (!updated) continue; // raced with a finishing message
    marked += 1;

    await db.insert(auditEventsTable).values({
      organizationId: conversation.organizationId,
      actorUserId: null,
      action: "conversation.abandoned",
      entityType: "conversation",
      entityId: conversation.id,
      metadata: { leadId: conversation.leadId, idleSince: conversation.updatedAt.toISOString() },
    });

    if (conversation.leadId) {
      await db.insert(activitiesTable).values({
        organizationId: conversation.organizationId,
        leadId: conversation.leadId,
        contactId: conversation.contactId ?? null,
        type: "ai_summary",
        title: "Concierge chat abandoned — partial intake summary",
        body: partialSummary,
        metadata: { conversationId: conversation.id, abandoned: true },
      });
      const [lead] = await db
        .select()
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.id, conversation.leadId),
            eq(leadsTable.organizationId, conversation.organizationId),
          ),
        );
      emitAutomationEvent(conversation.organizationId, "assessment.abandoned", {
        leadId: conversation.leadId,
        contactId: conversation.contactId ?? undefined,
        fields: {
          "conversation.status": "abandoned",
          "conversation.intent": conversation.intent ?? undefined,
          "lead.status": lead?.status,
          "lead.urgency": lead?.urgency,
          "lead.source": lead?.source,
        },
      });
    }
  }
  return marked;
}

export async function listLeadConversations(organizationId: string, leadId: string) {
  const conversations = await db
    .select()
    .from(conversationsTable)
    .where(and(eq(conversationsTable.organizationId, organizationId), eq(conversationsTable.leadId, leadId)))
    .orderBy(asc(conversationsTable.createdAt));
  const result = [];
  for (const c of conversations) {
    const messages = await db
      .select()
      .from(conversationMessagesTable)
      .where(eq(conversationMessagesTable.conversationId, c.id))
      .orderBy(asc(conversationMessagesTable.createdAt));
    result.push({
      id: c.id,
      leadId: c.leadId,
      status: c.status,
      intent: c.intent,
      urgency: c.urgency,
      salesSummary: c.salesSummary,
      source: c.source,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    });
  }
  return result;
}

function slotLabel(start: Date, end: Date, tz: string): string {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(start);
  const time = (d: Date) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(d);
  return `${day}, ${time(start)}–${time(end)}`;
}

/** Local calendar parts of a Date in the scheduling timezone. */
function tzParts(d: Date, tz: string): { y: number; m: number; day: number; hour: number; minute: number; weekday: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
    minute: Number(parts.minute),
    weekday: parts.weekday,
  };
}

const SLOT_SKIP_LABEL = "Skip — have the team call me";
/**
 * Offer the next 3 open inspection windows over the coming business days,
 * driven by the org's configured availability (days, windows, timezone,
 * blackout dates, and per-window booking capacity). Windows at capacity are
 * skipped.
 */
async function conversationSource(tx: ScheduleTransaction, org: string, conversation: Conversation) {
  const state = conversation.state as Partial<ConciergeState>;
  if (!state.leadId || !state.contactId || state.leadId !== conversation.leadId || state.contactId !== conversation.contactId) throw new SchedulingPolicyError("stale_scheduling_review", "The conversation customer changed.");
  await appointmentCustomer(tx, org, { leadId: state.leadId, contactId: state.contactId, propertyId: state.propertyId ?? null }, { requireCoherentLeadProperty: true });
  const [lead] = await tx.select().from(leadsTable).where(and(eq(leadsTable.organizationId, org), eq(leadsTable.id, state.leadId))).for("share");
  const [contact] = await tx.select().from(contactsTable).where(and(eq(contactsTable.organizationId, org), eq(contactsTable.id, state.contactId))).for("share");
  const property = state.propertyId ? (await tx.select().from(propertiesTable).where(and(eq(propertiesTable.organizationId, org), eq(propertiesTable.id, state.propertyId))).for("share"))[0] : null;
  if (!lead || !contact || (state.propertyId && !property) || lead.propertyId !== (state.propertyId ?? null)) throw new SchedulingPolicyError("stale_scheduling_review", "The conversation property changed.");
  const source: ManualSourceRef = { sourceKind: "lead", leadId: lead.id, contactId: contact.id, propertyId: property?.id ?? null, estimateId: null };
  // Material facts, not updatedAt touched by progressive sync.
  const fingerprint = offerFingerprint({ conversationId: conversation.id, source,
    contact: { firstName: contact.firstName, lastName: contact.lastName, phone: contact.phone, email: contact.email },
    property: property ? { contactId: property.contactId, addressLine1: property.addressLine1, city: property.city, state: property.state, postalCode: property.postalCode, propertyType: property.propertyType } : null });
  return { source, fingerprint };
}
function conciergeAuthority(org: string, conversationId: string): ServerSchedulingAuthority {
  return { organizationId: org, actorUserId: null, origin: "concierge", sourceId: conversationId, reviewMode: "existing_workflow_transaction" };
}
function inspectionCandidate(id: string, start: string, end: string, source: ManualSourceRef): SchedulingCandidate {
  return { kind: "appointment", id, startAt: start, endAt: end, type: "inspection", status: "scheduled", resourceUserIds: [], source, reservation: null };
}
function addCalendarDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0,10);
}
function ruleDate(now: Date, zone: string) {
  const p = tzParts(now, zone);
  return `${p.y}-${String(p.m).padStart(2,"0")}-${String(p.day).padStart(2,"0")}`;
}
function ruleWindow(date: string, startHour: number, endHour: number, zone: string) {
  const start = resolveWallTime(`${date}T${String(startHour).padStart(2,"0")}:00:00.000`, zone);
  const end = resolveWallTime(`${endHour === 24 ? addCalendarDays(date,1) : date}T${String(endHour % 24).padStart(2,"0")}:00:00.000`, zone);
  // Chat has no occurrence selector: hold rather than choose silently.
  return start.kind === "unique" && end.kind === "unique" && Date.parse(end.choices[0].instant) > Date.parse(start.choices[0].instant)
    ? { start: start.choices[0].instant, end: end.choices[0].instant } : null;
}
function matchesRuleWindow(slot: {start:string;end:string}, avail: Awaited<ReturnType<typeof readSchedulingContext>>["effectiveInspection"]) {
  if (!isoSchema.safeParse(slot.start).success || !isoSchema.safeParse(slot.end).success || Date.parse(slot.start) <= Date.now()) return false;
  const start = new Date(slot.start), date = ruleDate(start, avail.timezone);
  if (!avail.days.includes(tzParts(start, avail.timezone).weekday) || avail.blackoutDates.includes(date)) return false;
  return avail.windows.some(w => { const exact = ruleWindow(date,w.startHour,w.endHour,avail.timezone); return exact?.start === start.toISOString() && exact.end === new Date(slot.end).toISOString(); });
}
function staleConversationSource(error: unknown) {
  return error instanceof ScheduleError && error.code === "customer_reference_mismatch" || error instanceof SchedulingPolicyError && error.code === "stale_scheduling_review";
}
function ordinaryOfferHold(error: unknown) {
  return error instanceof SchedulingPolicyError && ["inspection_capacity_conflict", "company_capacity_conflict", "resource_conflict", "travel_conflict", "stale_scheduling_review"].includes(error.code);
}

/** Org-only previews cannot mint configured source authority. */
export async function generateInspectionSlots(organizationId: string, options: { conversationId?: string } = {}): Promise<OfferedSlot[]> {
  return db.transaction(async tx => {
    await lockSchedulingConfiguration(tx, organizationId);
    const current = await readSchedulingContext(tx, organizationId, undefined, { reservationKind: "appointment", appointmentType: "inspection" });
    const conversation = options.conversationId ? (await tx.select().from(conversationsTable).where(and(eq(conversationsTable.organizationId, organizationId),eq(conversationsTable.id,options.conversationId))).for("update"))[0] : undefined;
    if (options.conversationId && !conversation) throw new SchedulingPolicyError("scheduling_source_missing", "Conversation unavailable.",404);
    if (conversation && (conversation.state as ConciergeState).inspectionBooking) return [];
    let binding: Awaited<ReturnType<typeof conversationSource>> | null = null;
    try { binding = conversation ? await conversationSource(tx,organizationId,conversation) : null; }
    catch(error) { if(staleConversationSource(error)) return []; throw error; }
    if (!conversation && current.policy) return [];
    const source = binding?.source ?? unlinkedSchedulingSource;
    const review = schedulingMutationReviewSchema.parse({ context: {...current.context,source}, duration: {kind:"inspection_interval",preset:null}, startWallTime:null,endWallTime:null });
    const avail = current.effectiveInspection, now = new Date(), today = ruleDate(now,avail.timezone);
    const slots: OfferedSlot[] = [];
    for (let offset=1; offset<=14 && slots.length<3; offset++) {
      const date=addCalendarDays(today,offset);
      const noon=resolveWallTime(`${date}T12:00:00.000`,avail.timezone);
      if(noon.kind!=="unique" || !avail.days.includes(tzParts(new Date(noon.choices[0].instant),avail.timezone).weekday) || avail.blackoutDates.includes(date)) continue;
      for(const w of avail.windows) {
        if(slots.length===3) break;
        const window=ruleWindow(date,w.startHour,w.endHour,avail.timezone);
        if(!window || Date.parse(window.start)<=now.getTime()) continue;
        const id=randomUUID(), candidate=inspectionCandidate(id,window.start,window.end,source);
        try { await prepareInspectionInTransaction(tx,{organizationId,candidate,authority:conversation?conciergeAuthority(organizationId,conversation.id):undefined,review:conversation?review:null}); }
        catch(error) { if(ordinaryOfferHold(error)) continue; throw error; }
        const label=`${slotLabel(new Date(window.start),new Date(window.end),current.context.companyTimeZone)} (${current.context.companyTimeZone}${avail.timezone!==current.context.companyTimeZone?`; inspection rules: ${avail.timezone}`:""})`;
        slots.push(conversation ? conciergeInspectionOfferSchema.parse({formatVersion:1,organizationId,conversationId:conversation.id,appointmentId:id,label,...window,source,sourceFingerprint:binding!.fingerprint,review}) : {label,...window});
      }
    }
    if(conversation) await tx.update(conversationsTable).set({state:{...conversation.state,offeredSlots:slots}}).where(and(eq(conversationsTable.organizationId,organizationId),eq(conversationsTable.id,conversation.id)));
    return slots;
  });
}

/** Final source admission, replay proof and local effects share the conversation transaction. */
export async function bookInspectionSlot(params: {
  organizationId: string; conversationId?: string; slot: {start:string;end:string};
  leadId?: string|null; contactId?:string|null; propertyId?:string|null; notes?:string;
}): Promise<{id:string;replayed?:boolean}|null> {
  return db.transaction(async tx => {
    const org=params.organizationId;
    await lockSchedulingConfiguration(tx,org,false);
    const where=params.conversationId?and(eq(conversationsTable.organizationId,org),eq(conversationsTable.id,params.conversationId)):undefined;
    const conversation=where?(await tx.select().from(conversationsTable).where(where).for("update"))[0]:undefined;
    if(params.conversationId&&!conversation) return null;
    const state=conversation?.state as ConciergeState|undefined;
    const submitted=conciergeInspectionOfferSchema.safeParse(params.slot);
    if(state?.inspectionBooking!==undefined) {
      const proof=conciergeBookingProofSchema.parse(state.inspectionBooking);
      if(!submitted.success || offerFingerprint(submitted.data)!==proof.offerFingerprint) return null;
      const [audit]=await tx.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId,org),eq(auditEventsTable.id,proof.auditId),eq(auditEventsTable.action,"appointment.booked_concierge"),eq(auditEventsTable.entityId,proof.appointmentId)));
      if(!audit || audit.actorUserId!==null || audit.metadata.conversationId!==conversation!.id || offerFingerprint(audit.metadata.offer)!==proof.offerFingerprint || state.appointmentId!==proof.appointmentId) throw new SchedulingPolicyError("invalid_booking_receipt","The original conversation booking proof requires review.");
      return {id:proof.appointmentId,replayed:true};
    }
    if(!(await getCustomerLifecycleStatus(org,tx)).automationAllowed) throw new CustomerLifecycleHoldError();
    const current=await readSchedulingContext(tx,org,undefined,{reservationKind:"appointment",appointmentType:"inspection"});
    if(!matchesRuleWindow(params.slot,current.effectiveInspection)) return null;
    if(!conversation) {
      if(current.policy || submitted.success) return null;
      return insertInspectionInTransaction(tx,{organizationId:org,leadId:params.leadId??null,contactId:params.contactId??null,propertyId:params.propertyId??null,type:"inspection",status:"scheduled",scheduledStart:new Date(params.slot.start),scheduledEnd:new Date(params.slot.end),notes:params.notes??null});
    }
    if(!submitted.success || state!.appointmentId || state!.step!=="scheduling" || state!.consentGranted!==true) return null;
    const offer=submitted.data;
    if(offer.organizationId!==org||offer.conversationId!==conversation.id) return null;
    const stored=(state!.offeredSlots??[]).find(slot=>{const parsed=conciergeInspectionOfferSchema.safeParse(slot);return parsed.success&&offerFingerprint(parsed.data)===offerFingerprint(offer);});
    if(!stored) return null;
    let binding: Awaited<ReturnType<typeof conversationSource>>;
    try { binding=await conversationSource(tx,org,conversation); }
    catch(error) { if(staleConversationSource(error)) return null; throw error; }
    if(binding.fingerprint!==offer.sourceFingerprint || offerCanonical(binding.source)!==offerCanonical(offer.source)) return null;
    if(params.leadId!==undefined&&params.leadId!==binding.source.leadId||params.contactId!==undefined&&params.contactId!==binding.source.contactId||params.propertyId!==undefined&&params.propertyId!==binding.source.propertyId) return null;
    const authority=conciergeAuthority(org,conversation.id), candidate=inspectionCandidate(offer.appointmentId,offer.start,offer.end,binding.source);
    let admission;
    try { admission=await prepareInspectionInTransaction(tx,{organizationId:org,candidate,authority,review:offer.review}); }
    catch(error) { if(ordinaryOfferHold(error)) return null; throw error; }
    const [appointment]=await tx.insert(appointmentsTable).values({id:offer.appointmentId,organizationId:org,leadId:binding.source.leadId,contactId:binding.source.contactId,propertyId:binding.source.propertyId,type:"inspection",status:"scheduled",scheduledStart:new Date(offer.start),scheduledEnd:new Date(offer.end),schedulingReservation:admission.snapshot,notes:params.notes??null}).returning();
    await appendSchedulingTransition(tx,authority,null,admission.snapshot,{kind:"appointment",id:appointment.id},{transition:admission.transition,source:binding.source,invalidHistoricalEvidenceRetained:false});
    await scheduleAppointmentReminder(org,appointment,state!.contactMethod,tx);
    if(binding.source.leadId) await tx.insert(activitiesTable).values({organizationId:org,leadId:binding.source.leadId,contactId:binding.source.contactId,type:"appointment_scheduled",title:`Inspection booked via AI Concierge — ${offer.label}`,body:`Homeowner selected this company window in chat. Appointment ${appointment.id}; technician assignment pending.`,metadata:{conversationId:conversation.id,appointmentId:appointment.id,scheduledStart:offer.start}});
    const [audit]=await tx.insert(auditEventsTable).values({organizationId:org,actorUserId:null,action:"appointment.booked_concierge",entityType:"appointment",entityId:appointment.id,metadata:{conversationId:conversation.id,leadId:binding.source.leadId,offer}}).returning();
    const proof=conciergeBookingProofSchema.parse({formatVersion:1,appointmentId:appointment.id,auditId:audit.id,offerFingerprint:offerFingerprint(offer),start:offer.start,end:offer.end,label:offer.label});
    await tx.update(conversationsTable).set({status:"completed",state:{...state!,step:"done",appointmentId:appointment.id,appointmentStart:offer.start,appointmentLabel:offer.label,inspectionBooking:proof}}).where(where!);
    return {id:appointment.id,replayed:false};
  });
}

function matchSlot(text: string, slots: OfferedSlot[]): OfferedSlot | undefined {
  const t = text.trim().toLowerCase();
  const byLabel = slots.find((s) => s.label.toLowerCase() === t);
  if (byLabel) return byLabel;
  const idx = t.match(/^(?:option\s*|#\s*)?([1-3])\b/);
  if (idx) return slots[Number(idx[1]) - 1];
  return slots.find((s) => t.includes(s.label.toLowerCase().split(",")[0]));
}
