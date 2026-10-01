import {
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

import { recordAudit } from "./audit";
import { checkSendEligibility } from "./send-gate";

export const MANUAL_SMS_TEMPLATE_IDS = [
  "first-response",
  "arrange-visit",
  "follow-up",
] as const;
export type ManualSmsTemplateId = (typeof MANUAL_SMS_TEMPLATE_IDS)[number];

export interface ManualSmsTemplate {
  id: ManualSmsTemplateId;
  title: string;
  body: string;
}

export interface ManualSmsDrafts {
  allowed: boolean;
  reason: string | null;
  phoneE164: string | null;
  templates: ManualSmsTemplate[];
  orgId: string;
}

/**
 * Validate ONE telephone recipient before building a native URI. The send
 * gate's digit-only normalization is for suppression matching, not URI safety.
 * Do not turn an injected URI, multiple numbers or an extension into a phone.
 * Unprefixed numbers are NANP; international numbers require an explicit +.
 */
export function normalizeManualSmsPhone(value: string | null | undefined): string | null {
  if (!value || value.length > 64 || !/^[+0-9 ().-]+$/.test(value)) return null;
  const compact = value.trim().replace(/[ ().-]/g, "");
  if (compact.startsWith("+")) {
    if (!/^\+[1-9]\d{9,14}$/.test(compact)) return null;
    if (compact.startsWith("+1") && !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(compact)) return null;
    return compact;
  }
  const national = compact.length === 11 && compact.startsWith("1") ? compact.slice(1) : compact;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(national) ? `+1${national}` : null;
}

function label(value: string | null | undefined, fallback: string, maxLength: number): string {
  return value
    ?.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength) || fallback;
}

export function buildManualSmsTemplates(input: {
  companyName: string;
  customerFirstName: string | null;
  staffFirstName: string | null;
}): ManualSmsTemplate[] {
  const company = label(input.companyName, "our service team", 80);
  const customer = label(input.customerFirstName, "there", 40);
  const staff = label(input.staffFirstName, "the team", 40);
  const intro = `Hi ${customer}, this is ${staff} with ${company}.`;
  // These are replies to an existing service request, never a marketing or
  // reactivation campaign. The staff member must review and press Send.
  return [
    {
      id: "first-response",
      title: "First response",
      body: `${intro} Thanks for reaching out. What can we help you with?`,
    },
    {
      id: "arrange-visit",
      title: "Arrange a visit",
      body: `${intro} What day and time would work for a visit about your service request? We will confirm availability before anything is booked.`,
    },
    {
      id: "follow-up",
      title: "Service follow-up",
      body: `${intro} Following up on your service request. Would you still like help, or should we close the request?`,
    },
  ];
}

/** Returns null for a missing OR other-tenant lead/contact. No provider calls. */
export async function getManualSmsDrafts(input: {
  organizationId: string;
  leadId: string;
  staffFirstName: string | null;
}): Promise<ManualSmsDrafts | null> {
  const [row] = await db
    .select({ contact: contactsTable, companyName: organizationsTable.name })
    .from(leadsTable)
    .innerJoin(contactsTable, and(
      eq(contactsTable.id, leadsTable.contactId),
      eq(contactsTable.organizationId, input.organizationId),
    ))
    .innerJoin(organizationsTable, eq(organizationsTable.id, leadsTable.organizationId))
    .where(and(
      eq(leadsTable.id, input.leadId),
      eq(leadsTable.organizationId, input.organizationId),
    ))
    .limit(1);
  if (!row) return null;

  const blocked = (reason: string): ManualSmsDrafts => ({
    allowed: false, reason, phoneE164: null, templates: [], orgId: input.organizationId,
  });
  const phoneE164 = normalizeManualSmsPhone(row.contact.phone);
  if (!phoneE164) return blocked(row.contact.phone ? "invalid_phone" : "no_phone");
  // Explicit SMS consent, hard do-not-contact flags and address-level STOP
  // suppressions still apply. A manual draft never creates or implies consent.
  // This requested-service reply is human-reviewed, not automated outreach.
  const gate = await checkSendEligibility({
    organizationId: input.organizationId,
    contact: row.contact,
    channel: "sms",
    kind: "transactional",
  });
  if (!gate.ok) return blocked(gate.reason);
  return {
    allowed: true,
    reason: null,
    phoneE164,
    templates: buildManualSmsTemplates({
      companyName: row.companyName,
      customerFirstName: row.contact.firstName,
      staffFirstName: input.staffFirstName,
    }),
    orgId: input.organizationId,
  };
}

export async function prepareManualSmsDraft(input: {
  organizationId: string;
  actorUserId: string;
  staffFirstName: string | null;
  leadId: string;
  templateId: ManualSmsTemplateId;
}): Promise<(ManualSmsDrafts & {
  prepared?: true;
  templateId?: ManualSmsTemplateId;
  preparedAt?: string;
}) | null> {
  // Fresh read on the prepare action, not an old GET or a trusted client flag.
  const drafts = await getManualSmsDrafts(input);
  if (!drafts?.allowed) return drafts;
  await recordAudit({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: "lead.manual_sms_prepared",
    entityType: "lead",
    entityId: input.leadId,
    metadata: {
      templateId: input.templateId,
      channel: "sms",
      outcome: "draft_prepared",
      requestedServiceReplyConfirmed: true,
      providerAttempted: false,
      sentVerified: false,
    },
  });
  // There is deliberately no activity, contact attempt, sent timestamp, stage
  // update or delivery record. GrowthOS cannot observe the phone's SMS app.
  return { ...drafts, prepared: true, templateId: input.templateId, preparedAt: new Date().toISOString() };
}
