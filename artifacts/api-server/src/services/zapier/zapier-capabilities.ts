import type { ZapierCapabilityDirection, ZapierSpecialistId } from "@workspace/db";
import { z } from "zod";

/**
 * The capability registry is the only vocabulary a specialist may use when it
 * reaches outside GrowthOS through Zapier. Each capability declares:
 *
 * - which specialist owns it and whether it reads or writes,
 * - a typed input contract validated before anything is sent,
 * - the Zapier apps/actions a contractor is allowed to bind it to, and
 * - a deterministic mapper from the typed input to that action's parameters.
 *
 * No model participates in choosing a capability, an action, or its params.
 * Adding an app means adding a candidate here with a reviewed mapper.
 */

export const ZAPIER_CAPABILITY_KEYS = [
  "scout.reviews.list",
  "scout.leads.list",
  "appt.calendar.create_event",
  "appt.sms.send",
  "invo.accounting.create_invoice",
  "callie.calls.list",
  "callie.sms.send",
  "sched.sms.send",
  "maintain.sms.send",
] as const;
export type ZapierCapabilityKey = (typeof ZAPIER_CAPABILITY_KEYS)[number];

export const CALENDAR_EVENT_INPUT = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  location: z.string().max(500).optional(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  timezone: z.string().min(1).max(64),
  attendeeEmails: z.array(z.string().email()).max(10).optional(),
});

export const ACCOUNTING_INVOICE_INPUT = z.object({
  invoiceNumber: z.string().min(1).max(64),
  customerName: z.string().min(1).max(200),
  customerEmail: z.string().email().optional(),
  customerAddress: z.string().max(500).optional(),
  issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  memo: z.string().max(1000).optional(),
  lineItems: z
    .array(
      z.object({
        description: z.string().min(1).max(500),
        quantity: z.number().positive().max(100000),
        unitPriceCents: z.number().int().min(0),
        totalCents: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(200),
  subtotalCents: z.number().int().min(0),
  taxCents: z.number().int().min(0),
  totalCents: z.number().int().min(0),
});

export const SMS_SEND_INPUT = z.object({
  toPhone: z.string().regex(/^\+?[1-9]\d{6,14}$/),
  body: z.string().min(1).max(1200),
});

export const LIST_SINCE_INPUT = z.object({
  /** Optional ISO cursor; readers that cannot filter server-side filter client-side. */
  since: z.string().datetime({ offset: true }).optional(),
});

export type ZapierActionCandidate = {
  /** Zapier app identifier (selected_api). */
  app: string;
  appName: string;
  /** Zapier action key. */
  action: string;
  actionName: string;
  /** Non-secret per-binding configuration the contractor supplies (e.g. calendar id). */
  configFields: { key: string; label: string; required: boolean }[];
  /** Deterministic input → Zapier params mapping. */
  toParams: (input: unknown, config: Record<string, unknown>) => Record<string, unknown>;
};

export type ZapierCapabilityDefinition = {
  key: ZapierCapabilityKey;
  specialistId: ZapierSpecialistId;
  direction: ZapierCapabilityDirection;
  label: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  candidates: ZapierActionCandidate[];
  /** Field names that may appear in the ledger's bounded request summary. */
  summaryFields: string[];
  /** Default authority for a newly bound capability. */
  defaultMode: "approve" | "auto";
  defaultDailyBudget: number;
};

const cents = (value: number): string => (value / 100).toFixed(2);

function calendarCandidate(app: string, appName: string, action: string, actionName: string): ZapierActionCandidate {
  return {
    app,
    appName,
    action,
    actionName,
    configFields: [{ key: "calendarid", label: "Calendar", required: true }],
    toParams: (raw, config) => {
      const input = CALENDAR_EVENT_INPUT.parse(raw);
      return {
        calendarid: config.calendarid,
        summary: input.title,
        description: input.description ?? "",
        location: input.location ?? "",
        start_time: input.startsAt,
        end_time: input.endsAt,
        timezone: input.timezone,
        attendees: input.attendeeEmails?.join(",") ?? "",
      };
    },
  };
}

function smsCandidate(app: string, appName: string, action: string, actionName: string, fromKey: string): ZapierActionCandidate {
  return {
    app,
    appName,
    action,
    actionName,
    configFields: [{ key: fromKey, label: "Sending number", required: true }],
    toParams: (raw, config) => {
      const input = SMS_SEND_INPUT.parse(raw);
      return { [fromKey]: config[fromKey], to_number: input.toPhone, body: input.body };
    },
  };
}

function leadAdsCandidate(app: string, appName: string): ZapierActionCandidate {
  return {
    app,
    appName,
    action: "new_lead",
    actionName: "New Lead",
    configFields: [
      { key: "page", label: "Facebook Page", required: true },
      { key: "form_id", label: "Lead form", required: false },
    ],
    toParams: (_raw, config) => ({ page: config.page, form_id: config.form_id ?? undefined }),
  };
}

export const ZAPIER_CAPABILITIES: readonly ZapierCapabilityDefinition[] = [
  {
    key: "scout.reviews.list",
    specialistId: "scout",
    direction: "read",
    label: "Watch new reviews",
    description: "SCOUT reads new public reviews so reputation changes become follow-ups, never auto-replies.",
    inputSchema: LIST_SINCE_INPUT,
    summaryFields: ["since"],
    defaultMode: "auto",
    defaultDailyBudget: 48,
    candidates: [
      {
        app: "GoogleMyBusinessCLIAPI",
        appName: "Google Business Profile",
        action: "new_review",
        actionName: "New Review",
        configFields: [{ key: "location", label: "Business location", required: true }],
        toParams: (_raw, config) => ({ location: config.location }),
      },
      {
        app: "FacebookV2CLIAPI",
        appName: "Facebook Pages",
        action: "recommendation",
        actionName: "New Recommendation",
        configFields: [{ key: "page", label: "Facebook Page", required: true }],
        toParams: (_raw, config) => ({ page: config.page }),
      },
    ],
  },
  {
    key: "scout.leads.list",
    specialistId: "scout",
    direction: "read",
    label: "Pull new marketplace leads",
    description: "SCOUT reads new leads from lead marketplaces and creates GrowthOS opportunities once each.",
    inputSchema: LIST_SINCE_INPUT,
    summaryFields: ["since"],
    defaultMode: "auto",
    defaultDailyBudget: 96,
    candidates: [
      leadAdsCandidate("FacebookLeadsCLIAPI", "Facebook Lead Ads"),
      leadAdsCandidate("FacebookLeadAdsCLIAPI", "Facebook Lead Ads (for Business admins)"),
      {
        app: "HousecallProCLIAPI",
        appName: "Housecall Pro",
        action: "new_customer",
        actionName: "New Customer",
        configFields: [],
        toParams: () => ({}),
      },
      {
        app: "JobberCLIAPI",
        appName: "Jobber",
        action: "new_request",
        actionName: "New Request",
        configFields: [],
        toParams: () => ({}),
      },
    ],
  },
  {
    key: "appt.calendar.create_event",
    specialistId: "appt",
    direction: "write",
    label: "Put booked appointments on the calendar",
    description: "APPT creates one calendar event per GrowthOS appointment on the contractor's own calendar.",
    inputSchema: CALENDAR_EVENT_INPUT,
    summaryFields: ["title", "startsAt", "endsAt", "timezone"],
    defaultMode: "auto",
    defaultDailyBudget: 50,
    candidates: [
      calendarCandidate("GoogleCalendarCLIAPI", "Google Calendar", "detailed_event", "Create Detailed Event"),
      calendarCandidate("MicrosoftOutlookCLIAPI", "Microsoft Outlook", "create_event", "Create Event"),
    ],
  },
  {
    key: "appt.sms.send",
    specialistId: "appt",
    direction: "write",
    label: "Text appointment reminders",
    description: "APPT texts a consented customer their appointment reminder from the contractor's own number.",
    inputSchema: SMS_SEND_INPUT,
    summaryFields: ["toPhone"],
    defaultMode: "approve",
    defaultDailyBudget: 60,
    candidates: [
      smsCandidate("TwilioCLIAPI", "Twilio", "send_sms", "Send SMS", "from_number"),
      smsCandidate("OpenPhoneCLIAPI", "Quo", "send_message", "Send Message", "from"),
    ],
  },
  {
    key: "invo.accounting.create_invoice",
    specialistId: "invo",
    direction: "write",
    label: "Push issued invoices to accounting",
    description: "INVO sends an issued GrowthOS invoice to the contractor's accounting system exactly once.",
    inputSchema: ACCOUNTING_INVOICE_INPUT,
    summaryFields: ["invoiceNumber", "customerName", "totalCents", "issuedOn", "dueOn"],
    defaultMode: "approve",
    defaultDailyBudget: 25,
    candidates: [
      {
        app: "QuickBooksV3CLIAPI",
        appName: "QuickBooks Online",
        action: "invoice",
        actionName: "Create Invoice",
        configFields: [],
        toParams: (raw) => {
          const input = ACCOUNTING_INVOICE_INPUT.parse(raw);
          return {
            customer_name: input.customerName,
            customer_email: input.customerEmail ?? "",
            bill_address: input.customerAddress ?? "",
            doc_number: input.invoiceNumber,
            txn_date: input.issuedOn,
            due_date: input.dueOn ?? "",
            customer_memo: input.memo ?? "",
            line_items: input.lineItems.map((item) => ({
              description: item.description,
              quantity: String(item.quantity),
              unit_price: cents(item.unitPriceCents),
              amount: cents(item.totalCents),
            })),
            tax_amount: cents(input.taxCents),
            total_amount: cents(input.totalCents),
          };
        },
      },
      {
        app: "XeroCLIAPI",
        appName: "Xero",
        action: "invoice",
        actionName: "Create Sales Invoice",
        configFields: [],
        toParams: (raw) => {
          const input = ACCOUNTING_INVOICE_INPUT.parse(raw);
          return {
            contact_name: input.customerName,
            contact_email: input.customerEmail ?? "",
            invoice_number: input.invoiceNumber,
            date: input.issuedOn,
            due_date: input.dueOn ?? "",
            reference: input.memo ?? "",
            line_items: input.lineItems.map((item) => ({
              description: item.description,
              quantity: String(item.quantity),
              unit_amount: cents(item.unitPriceCents),
              line_amount: cents(item.totalCents),
            })),
          };
        },
      },
    ],
  },
  {
    key: "callie.calls.list",
    specialistId: "callie",
    direction: "read",
    label: "Log calls from the phone system",
    description: "CALLIE reads new calls from the contractor's call tracking so missed calls become callback tasks.",
    inputSchema: LIST_SINCE_INPUT,
    summaryFields: ["since"],
    defaultMode: "auto",
    defaultDailyBudget: 96,
    candidates: [
      {
        app: "CallRailCLIAPI",
        appName: "CallRail",
        action: "new_call",
        actionName: "New Call",
        configFields: [{ key: "company_id", label: "CallRail company", required: false }],
        toParams: (_raw, config) => ({ company_id: config.company_id ?? undefined }),
      },
      {
        app: "OpenPhoneCLIAPI",
        appName: "Quo",
        action: "call_completed",
        actionName: "Call Completed",
        configFields: [{ key: "phone_number_id", label: "OpenPhone number", required: false }],
        toParams: (_raw, config) => ({ phone_number_id: config.phone_number_id ?? undefined }),
      },
    ],
  },
  {
    key: "callie.sms.send",
    specialistId: "callie",
    direction: "write",
    label: "Text back missed callers",
    description: "CALLIE sends one approved text to a missed caller from the contractor's own number.",
    inputSchema: SMS_SEND_INPUT,
    summaryFields: ["toPhone"],
    defaultMode: "approve",
    defaultDailyBudget: 40,
    candidates: [
      smsCandidate("TwilioCLIAPI", "Twilio", "send_sms", "Send SMS", "from_number"),
      smsCandidate("OpenPhoneCLIAPI", "Quo", "send_message", "Send Message", "from"),
    ],
  },
  {
    key: "sched.sms.send",
    specialistId: "sched",
    direction: "write",
    label: "Text crews their day sheet",
    description: "SCHED texts each crew member tomorrow's jobs from the contractor's own number.",
    inputSchema: SMS_SEND_INPUT,
    summaryFields: ["toPhone"],
    defaultMode: "approve",
    defaultDailyBudget: 40,
    candidates: [
      smsCandidate("TwilioCLIAPI", "Twilio", "send_sms", "Send SMS", "from_number"),
      smsCandidate("OpenPhoneCLIAPI", "Quo", "send_message", "Send Message", "from"),
    ],
  },
  {
    key: "maintain.sms.send",
    specialistId: "maintain",
    direction: "write",
    label: "Text service reminders",
    description: "MAINTAIN texts a consented customer one reminder that a recorded service is due, from the contractor's own number.",
    inputSchema: SMS_SEND_INPUT,
    summaryFields: ["toPhone"],
    defaultMode: "approve",
    defaultDailyBudget: 40,
    candidates: [
      smsCandidate("TwilioCLIAPI", "Twilio", "send_sms", "Send SMS", "from_number"),
      smsCandidate("OpenPhoneCLIAPI", "Quo", "send_message", "Send Message", "from"),
    ],
  },
];

const BY_KEY = new Map(ZAPIER_CAPABILITIES.map((definition) => [definition.key, definition]));

export function getZapierCapability(key: string): ZapierCapabilityDefinition | null {
  return BY_KEY.get(key as ZapierCapabilityKey) ?? null;
}

export function isZapierCapabilityKey(value: string): value is ZapierCapabilityKey {
  return BY_KEY.has(value as ZapierCapabilityKey);
}

/**
 * Match a live Zapier action (as reported by the contractor's server) to a
 * reviewed candidate. Zapier app ids and action keys vary by app version, so
 * the display names are accepted as a secondary, case-insensitive match.
 */
export function findZapierCandidate(
  definition: ZapierCapabilityDefinition,
  live: { app: string; appName?: string | null; action: string; actionName?: string | null },
): ZapierActionCandidate | null {
  const norm = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();
  return (
    definition.candidates.find((candidate) => {
      const appMatches = candidate.app === live.app || norm(candidate.appName) === norm(live.appName);
      const actionMatches =
        candidate.action === live.action || norm(candidate.actionName) === norm(live.actionName);
      return appMatches && actionMatches;
    }) ?? null
  );
}

/** Bounded, allow-listed view of an input for the ledger. Never the full payload. */
export function summarizeZapierInput(definition: ZapierCapabilityDefinition, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const record = input as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const field of definition.summaryFields) {
    const value = record[field];
    if (value === undefined) continue;
    summary[field] = typeof value === "string" ? value.slice(0, 200) : value;
  }
  return summary;
}
