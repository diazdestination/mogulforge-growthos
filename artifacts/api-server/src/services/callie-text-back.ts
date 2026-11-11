/**
 * CALLIE missed-call text-back: the eligibility side.
 *
 * A missed inbound call from a number to the business line is the basis for
 * ONE informational reply from that business (conversational consent). This
 * module records that basis and decides, right before every send, whether the
 * reply may go. It is deliberately separate from `consent_records`:
 * `hasChannelConsent` (used by SCOUT review requests, reactivation, MAINTAIN,
 * APPT and every other text) never reads a missed-call basis, so the basis can
 * never be used as marketing, review-request or general SMS consent.
 *
 * Order of checks (first failing reason wins):
 *   invalid_number -> not_registered -> customer_lifecycle_paused ->
 *   suppressed / opted_out -> call_too_old -> over_cap -> quiet_hours
 * Landline / not-textable and missing call details are decided when the call
 * is read (see callieSyncCalls), before any basis is recorded.
 *
 * Quiet hours are a SKIP, not a hold: GrowthOS does not queue a text-back for
 * later. The callback task stays open for staff. The caller's own time zone is
 * not known for a missed call, so the company time zone is used (documented
 * assumption); 8:00 to 21:00 local is the allowed window.
 */
import {
  auditEventsTable,
  consentRecordsTable,
  contactsTable,
  db,
  organizationsTable,
  orgSettingsTable,
  suppressionsTable,
  usersTable,
  twilioDispatchesTable,
  zapierActionExecutionsTable,
  zapierSpecialistPoliciesTable,
  type CallieTextBackSettings,
} from "@workspace/db";
import { and, desc, eq, gte, inArray, like, ne, sql } from "drizzle-orm";

import { getCustomerLifecycleStatus } from "./customer-lifecycle";
import { normalizePhone } from "./send-gate";
import { phoneE164 } from "./twilio-controls";

type Reader = Pick<typeof db, "select">;

export const CALLIE_TEXTBACK_CAPABILITY = "callie.sms.send";
export const MISSED_CALL_BASIS_ACTION = "consent.missed_call_basis";
export const TEXTBACK_WINDOW_DEFAULT_HOURS = 24;
export const TEXTBACK_WINDOW_CHOICES = [12, 24, 48, 72] as const;
/** Allowed local sending window: 8:00 inclusive to 21:00 exclusive. */
export const TEXTING_START_HOUR = 8;
export const TEXTING_END_HOUR = 21;
/** A text-back is a reply to a recent call; older calls are skipped, not texted. */
export const TEXTBACK_MAX_CALL_AGE_HOURS = 24;

export const TEXTBACK_SKIP_REASONS = [
  "opted_out",
  "suppressed",
  "over_cap",
  "quiet_hours",
  "not_registered",
  "invalid_number",
  "landline",
  "missing_call_details",
  "call_too_old",
  "customer_lifecycle_paused",
  "no_basis",
] as const;
export type TextBackSkipReason = (typeof TEXTBACK_SKIP_REASONS)[number];

/** Plain sentences office staff see on CALLIE's activity. */
export const TEXTBACK_SKIP_DETAIL: Record<TextBackSkipReason, string> = {
  opted_out: "Not sent: this number opted out of texts (STOP).",
  suppressed: "Not sent: this number is on your company's do-not-text or suppression list.",
  over_cap: "Not sent: this caller already got a missed-call text inside your text-back window.",
  quiet_hours: "Not sent: outside 8am to 9pm in your company time zone. Call the customer back instead.",
  not_registered: "Not sent: your texting registration is not confirmed in Settings.",
  invalid_number: "Not sent: the caller's number is not a valid US mobile-capable number.",
  landline: "Not sent: the phone system reports this number cannot receive texts (landline or similar).",
  missing_call_details: "Not sent: the call record has no call time or business number to show the caller called you.",
  call_too_old: `Not sent: the call is more than ${TEXTBACK_MAX_CALL_AGE_HOURS} hours old.`,
  customer_lifecycle_paused: "Not sent: customer messaging is paused for this company.",
  no_basis: "Not sent: no missed call from this number is on record for this callback.",
};

export function isTextBackSkipReason(value: unknown): value is TextBackSkipReason {
  return typeof value === "string" && (TEXTBACK_SKIP_REASONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Numbers and call data
// ---------------------------------------------------------------------------

const TOLL_FREE_OR_PREMIUM = new Set(["800", "822", "833", "844", "855", "866", "877", "888", "900"]);

/**
 * A NANP (+1) number in E.164 that can plausibly receive a text: valid area
 * code and exchange, not an N11 service code, not toll-free or premium.
 * Anything else (international, short codes, malformed) returns null.
 */
export function usMobileCapableE164(raw: string | null | undefined): string | null {
  const e164 = phoneE164(raw ?? "");
  if (!e164) return null;
  const npa = e164.slice(2, 5);
  const nxx = e164.slice(5, 8);
  if (/^[2-9]11$/.test(npa) || /^[2-9]11$/.test(nxx)) return null;
  if (TOLL_FREE_OR_PREMIUM.has(npa)) return null;
  return e164;
}

/** Any valid E.164 number for the business line (the number the caller dialed). */
export function businessLineE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const us = phoneE164(raw);
  if (us) return us;
  const digits = raw.replace(/\D/g, "");
  return raw.trim().startsWith("+") && /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

const LINE_TYPE_KEYS = ["line_type", "lineType", "phone_type", "phoneType", "number_type", "numberType", "carrier_type", "carrierType", "caller_line_type"];
const TEXTABLE_KEYS = ["sms_capable", "smsCapable", "can_receive_sms", "canReceiveSms", "textable", "sms_enabled"];

/** True when the inbound call data says the caller's number cannot receive texts. */
export function callerCannotText(record: Record<string, unknown>): boolean {
  for (const key of TEXTABLE_KEYS) {
    const value = record[key];
    if (value === false || (typeof value === "string" && /^(false|no|0)$/i.test(value.trim()))) return true;
  }
  for (const key of LINE_TYPE_KEYS) {
    const value = record[key];
    if (typeof value === "string" && /landline|fixed|toll.?free|pager|premium|unknown_fixed/i.test(value)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Company settings (org_settings.callie_text_back)
// ---------------------------------------------------------------------------

export function effectiveTextBackSettings(raw: Partial<CallieTextBackSettings> | null | undefined): CallieTextBackSettings {
  const windowHours = Number.isInteger(raw?.windowHours) && raw!.windowHours! >= 1 && raw!.windowHours! <= 168 ? raw!.windowHours! : TEXTBACK_WINDOW_DEFAULT_HOURS;
  const registered = raw?.messagingRegistered === true && typeof raw.registeredAt === "string" && typeof raw.registeredByUserId === "string";
  return {
    messagingRegistered: registered,
    registeredByUserId: registered ? raw!.registeredByUserId! : null,
    registeredAt: registered ? raw!.registeredAt! : null,
    windowHours,
  };
}

export async function getCallieTextBackSettings(organizationId: string, reader: Reader = db): Promise<CallieTextBackSettings> {
  const [row] = await reader
    .select({ value: orgSettingsTable.callieTextBack })
    .from(orgSettingsTable)
    .where(eq(orgSettingsTable.organizationId, organizationId))
    .limit(1);
  return effectiveTextBackSettings(row?.value);
}

export interface CallieTextBackView extends CallieTextBackSettings {
  registeredByName: string | null;
  windowChoices: number[];
}

/** Settings as shown in Settings: the confirmer by name (same company only), never a raw id. */
export async function describeCallieTextBackSettings(organizationId: string, settings?: CallieTextBackSettings): Promise<CallieTextBackView> {
  const current = settings ?? await getCallieTextBackSettings(organizationId);
  let registeredByName: string | null = null;
  if (current.registeredByUserId) {
    const [user] = await db
      .select({ name: sql<string>`coalesce(nullif(concat_ws(' ', ${usersTable.firstName}, ${usersTable.lastName}), ''), ${usersTable.email}, 'A team member')` })
      .from(usersTable)
      .where(and(eq(usersTable.id, current.registeredByUserId), eq(usersTable.organizationId, organizationId)))
      .limit(1);
    registeredByName = user?.name ?? "A former team member";
  }
  return { ...current, registeredByName, windowChoices: [...TEXTBACK_WINDOW_CHOICES] };
}

export class CallieTextBackSettingsError extends Error {}

/**
 * Save the registration confirmation and window. Un-confirming registration
 * switches the text-back policy Off in the same transaction, so text-back is
 * never left on without a confirmed registration.
 */
export async function saveCallieTextBackSettings(input: {
  organizationId: string;
  userId: string;
  messagingRegistered: boolean;
  windowHours?: number;
}): Promise<CallieTextBackSettings> {
  const { getOrgSettings } = await import("./settings");
  await getOrgSettings(input.organizationId); // ensure the row exists
  return db.transaction(async (tx) => {
    const current = await getCallieTextBackSettings(input.organizationId, tx);
    const windowHours = input.windowHours ?? current.windowHours;
    if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 168) {
      throw new CallieTextBackSettingsError("Choose a text-back window between 1 and 168 hours.");
    }
    const next: CallieTextBackSettings = input.messagingRegistered
      ? {
          messagingRegistered: true,
          registeredByUserId: current.messagingRegistered ? current.registeredByUserId : input.userId,
          registeredAt: current.messagingRegistered ? current.registeredAt : new Date().toISOString(),
          windowHours,
        }
      : { messagingRegistered: false, registeredByUserId: null, registeredAt: null, windowHours };
    await tx.update(orgSettingsTable).set({ callieTextBack: next }).where(eq(orgSettingsTable.organizationId, input.organizationId));
    let policySwitchedOff = false;
    if (!next.messagingRegistered) {
      const switched = await tx
        .update(zapierSpecialistPoliciesTable)
        .set({ mode: "off", updatedByUserId: input.userId })
        .where(and(
          eq(zapierSpecialistPoliciesTable.organizationId, input.organizationId),
          eq(zapierSpecialistPoliciesTable.capability, CALLIE_TEXTBACK_CAPABILITY),
          ne(zapierSpecialistPoliciesTable.mode, "off"),
        ))
        .returning({ id: zapierSpecialistPoliciesTable.id });
      policySwitchedOff = switched.length > 0;
    }
    await tx.insert(auditEventsTable).values({
      organizationId: input.organizationId,
      actorUserId: input.userId,
      action: "callie.textback_settings_changed",
      entityType: "organization",
      entityId: input.organizationId,
      metadata: {
        messagingRegistered: next.messagingRegistered,
        registrationChanged: next.messagingRegistered !== current.messagingRegistered,
        windowHours: next.windowHours,
        policySwitchedOff,
      },
    });
    return next;
  });
}

// ---------------------------------------------------------------------------
// The missed-call basis (conversational consent for one reply)
// ---------------------------------------------------------------------------

export type MissedCallBasis = {
  source: "missed_call";
  /** The only flow this basis permits. */
  scope: typeof CALLIE_TEXTBACK_CAPABILITY;
  /** Caller, E.164. */
  phone: string;
  /** When the call came in (ISO). */
  calledAt: string;
  /** The business number the caller dialed (E.164). */
  businessNumber: string;
  /** Phone-system record reference, for audit only. */
  callRef: string;
};

/** Append-only; one basis per callback task. Returns the stored basis. */
export async function recordMissedCallBasis(organizationId: string, taskId: string, basis: Omit<MissedCallBasis, "source" | "scope">): Promise<MissedCallBasis> {
  const existing = await readMissedCallBasis(db, organizationId, taskId);
  if (existing) return existing;
  const value: MissedCallBasis = { source: "missed_call", scope: CALLIE_TEXTBACK_CAPABILITY, ...basis };
  await db.insert(auditEventsTable).values({
    organizationId,
    action: MISSED_CALL_BASIS_ACTION,
    entityType: "crm_task",
    entityId: taskId,
    metadata: value,
  });
  return value;
}

export async function readMissedCallBasis(reader: Reader, organizationId: string, taskId: string): Promise<MissedCallBasis | null> {
  const [row] = await reader
    .select({ metadata: auditEventsTable.metadata })
    .from(auditEventsTable)
    .where(and(
      eq(auditEventsTable.organizationId, organizationId),
      eq(auditEventsTable.action, MISSED_CALL_BASIS_ACTION),
      eq(auditEventsTable.entityType, "crm_task"),
      eq(auditEventsTable.entityId, taskId),
      // Only server code writes audit events; actor-less is the intake's shape.
      sql`${auditEventsTable.actorUserId} is null`,
    ))
    .orderBy(auditEventsTable.createdAt)
    .limit(1);
  const m = row?.metadata as Partial<MissedCallBasis> | undefined;
  if (!m || m.source !== "missed_call" || m.scope !== CALLIE_TEXTBACK_CAPABILITY) return null;
  if (typeof m.phone !== "string" || typeof m.calledAt !== "string" || typeof m.businessNumber !== "string") return null;
  if (Number.isNaN(new Date(m.calledAt).getTime())) return null;
  return { source: "missed_call", scope: CALLIE_TEXTBACK_CAPABILITY, phone: m.phone, calledAt: m.calledAt, businessNumber: m.businessNumber, callRef: typeof m.callRef === "string" ? m.callRef : "" };
}

// ---------------------------------------------------------------------------
// Time window
// ---------------------------------------------------------------------------

function localHour(at: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).formatToParts(at).find((part) => part.type === "hour")?.value;
  return Number(hour ?? "0") % 24;
}

export function safeTimeZone(timeZone: string | null | undefined): string {
  try {
    if (timeZone) {
      new Intl.DateTimeFormat("en-US", { timeZone });
      return timeZone;
    }
  } catch {
    // fall through
  }
  return "America/New_York";
}

export function withinTextingHours(at: Date, timeZone: string): boolean {
  const hour = localHour(at, safeTimeZone(timeZone));
  return hour >= TEXTING_START_HOUR && hour < TEXTING_END_HOUR;
}

/** Null when `at` is inside 8:00-21:00 local; otherwise the next top of an hour inside it. */
export function nextTextingHour(at: Date, timeZone: string): Date | null {
  if (withinTextingHours(at, timeZone)) return null;
  const cursor = new Date(at);
  cursor.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 48; i++) {
    cursor.setTime(cursor.getTime() + 3_600_000);
    if (withinTextingHours(cursor, timeZone)) return new Date(cursor);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Frequency cap (durable ledger, both paths)
// ---------------------------------------------------------------------------

const CAP_LEDGER_STATES = ["pending_approval", "executing", "succeeded", "indeterminate", "failed"] as const;

/**
 * Latest missed-call text-back to this caller since `since`, across the Zapier
 * ledger (any non-skipped CALLIE text-back row, including ones waiting for
 * approval or with an unknown outcome) and the built-in Twilio missed-call path.
 */
export async function latestTextBackTo(reader: Reader, organizationId: string, phone: string, since: Date, exceptKey = ""): Promise<Date | null> {
  const [zapier] = await reader
    .select({ at: zapierActionExecutionsTable.createdAt })
    .from(zapierActionExecutionsTable)
    .where(and(
      eq(zapierActionExecutionsTable.organizationId, organizationId),
      eq(zapierActionExecutionsTable.capability, CALLIE_TEXTBACK_CAPABILITY),
      inArray(zapierActionExecutionsTable.state, [...CAP_LEDGER_STATES]),
      sql`${zapierActionExecutionsTable.requestSummary}->>'toPhone' = ${phone}`,
      gte(zapierActionExecutionsTable.createdAt, since),
      ne(zapierActionExecutionsTable.idempotencyKey, exceptKey),
    ))
    .orderBy(desc(zapierActionExecutionsTable.createdAt))
    .limit(1);
  const [native] = await reader
    .select({ at: twilioDispatchesTable.createdAt })
    .from(twilioDispatchesTable)
    .where(and(
      eq(twilioDispatchesTable.organizationId, organizationId),
      eq(twilioDispatchesTable.phone, phone),
      like(twilioDispatchesTable.idempotencyKey, "missed-call-care:%"),
      gte(twilioDispatchesTable.createdAt, since),
      ne(twilioDispatchesTable.idempotencyKey, exceptKey),
    ))
    .orderBy(desc(twilioDispatchesTable.createdAt))
    .limit(1);
  return [zapier?.at, native?.at].filter((at): at is Date => at instanceof Date).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
}

// ---------------------------------------------------------------------------
// Opt-out and suppression (phone-keyed, contact-free)
// ---------------------------------------------------------------------------

export async function textBackOptOutState(reader: Reader, organizationId: string, phone: string): Promise<"opted_out" | "suppressed" | null> {
  const [suppression] = await reader
    .select({ reason: suppressionsTable.reason })
    .from(suppressionsTable)
    .where(and(eq(suppressionsTable.organizationId, organizationId), eq(suppressionsTable.channel, "sms"), eq(suppressionsTable.value, normalizePhone(phone))))
    .limit(1);
  if (suppression) return suppression.reason === "stop_keyword" ? "opted_out" : "suppressed";
  const last10 = normalizePhone(phone).slice(-10);
  const contacts = await reader
    .select({ id: contactsTable.id, doNotContact: contactsTable.doNotContact, doNotContactSms: contactsTable.doNotContactSms })
    .from(contactsTable)
    .where(and(
      eq(contactsTable.organizationId, organizationId),
      sql`right(regexp_replace(coalesce(${contactsTable.phone}, ''), '\\D', '', 'g'), 10) = ${last10}`,
    ))
    .limit(50);
  if (contacts.some((contact) => contact.doNotContactSms)) return "opted_out";
  if (contacts.some((contact) => contact.doNotContact)) return "suppressed";
  if (contacts.length) {
    const records = await reader
      .select({ contactId: consentRecordsTable.contactId, granted: consentRecordsTable.granted })
      .from(consentRecordsTable)
      .where(and(
        eq(consentRecordsTable.organizationId, organizationId),
        eq(consentRecordsTable.channel, "sms"),
        inArray(consentRecordsTable.contactId, contacts.map((contact) => contact.id)),
      ))
      .orderBy(desc(consentRecordsTable.recordedAt), consentRecordsTable.granted);
    const latest = new Map<string, boolean>();
    for (const record of records) if (!latest.has(record.contactId)) latest.set(record.contactId, record.granted);
    // A recorded revocation (e.g. STOP) is an opt-out; never having consented is not.
    if ([...latest.values()].some((granted) => granted === false)) return "opted_out";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export type TextBackVerdict = { ok: true; settings: CallieTextBackSettings; timeZone: string } | { ok: false; reason: TextBackSkipReason; detail: string };

const skip = (reason: TextBackSkipReason): TextBackVerdict => ({ ok: false, reason, detail: TEXTBACK_SKIP_DETAIL[reason] });

/**
 * Decide whether one missed-call text-back may be sent now. Called when the
 * text-back is requested, again when it is approved, and again (under the
 * customer-text locks) right before dispatch.
 */
export async function checkTextBackEligibility(
  reader: Reader,
  input: { organizationId: string; phone: string; calledAt: Date; exceptKey: string; now?: Date },
): Promise<TextBackVerdict> {
  const now = input.now ?? new Date();
  const phone = usMobileCapableE164(input.phone);
  if (!phone || phone !== input.phone) return skip("invalid_number");
  const settings = await getCallieTextBackSettings(input.organizationId, reader);
  if (!settings.messagingRegistered) return skip("not_registered");
  if (!(await getCustomerLifecycleStatus(input.organizationId, reader)).automationAllowed) return skip("customer_lifecycle_paused");
  const optOut = await textBackOptOutState(reader, input.organizationId, phone);
  if (optOut) return skip(optOut);
  if (Number.isNaN(input.calledAt.getTime())) return skip("missing_call_details");
  if (now.getTime() - input.calledAt.getTime() > TEXTBACK_MAX_CALL_AGE_HOURS * 3_600_000) return skip("call_too_old");
  const since = new Date(now.getTime() - settings.windowHours * 3_600_000);
  if (await latestTextBackTo(reader, input.organizationId, phone, since, input.exceptKey)) return skip("over_cap");
  const [organization] = await reader.select({ timezone: organizationsTable.timezone }).from(organizationsTable).where(eq(organizationsTable.id, input.organizationId));
  const timeZone = safeTimeZone(organization?.timezone);
  if (!withinTextingHours(now, timeZone)) return skip("quiet_hours");
  return { ok: true, settings, timeZone };
}
