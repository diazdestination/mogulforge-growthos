import { createHash } from "node:crypto";
import { z } from "zod/v4";

export const MAILBOX_READ_SCOPES = [
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/User.Read",
  "offline_access",
];
export const MAILBOX_HEADER = "x-growthos-parent-id";
export const MAILBOX_POLICY_VERSION = 1;
export const MAILBOX_PAGE_SIZE = 25;
export const MAILBOX_PAGES_PER_FOLDER = 2;
export const MAILBOX_MAX_BODY = 32_000;
export type MailboxIdentity = {
  organizationId: string;
  senderUserId: string;
  provider: "microsoft";
  connectionId: string;
  connectionRevision: string;
  mailboxAccountId: string;
  mailboxEmail: string;
  connectorId: string;
  connectorVersion: number;
  policyVersion: number;
  startedAt: string;
};
export type MailboxMessage = {
  providerMessageId: string;
  internetMessageId: string | null;
  from: string;
  to: string[];
  subject: string;
  text: string;
  sentAt: string;
  receivedAt: string;
  correlationHeader: string | null;
  inReplyTo: string[];
  references: string[];
  automated: boolean;
};
export type LeadMonitoringApproval = { version: number; approvedAt: string };
export const leadMonitoringInput = z
  .object({
    expectedConnectorVersion: z.number().int().positive(),
    expectedLeadMonitoringVersion: z.number().int().nonnegative(),
    enabled: z.boolean(),
    leadContextAcknowledged: z.literal(true),
  })
  .strict();
export const mailboxConnectInput = z
  .object({
    expectedVersion: z.number().int().min(0),
    readAcknowledged: z.literal(true),
    retentionAcknowledged: z.literal(true),
    returnPath: z.enum(["/account", "/settings"]).default("/account"),
  })
  .strict();
export const mailboxDisableInput = z
  .object({
    expectedVersion: z.number().int().min(1),
    confirmed: z.literal(true),
  })
  .strict();
export class MailboxError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(
      "Mailbox reply monitoring needs review. No mailbox was changed and no message was sent.",
    );
  }
}
export function mailboxDigest(value: unknown) {
  const canonical = (v: unknown): string =>
    Array.isArray(v)
      ? `[${v.map(canonical).join(",")}]`
      : v && typeof v === "object"
        ? `{${Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
            .join(",")}}`
        : (JSON.stringify(v) ?? "null");
  return createHash("sha256").update(canonical(value)).digest("hex");
}
