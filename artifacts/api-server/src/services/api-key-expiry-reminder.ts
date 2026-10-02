/**
 * Pre-expiry reminder for org API keys.
 *
 * Once a key's expiresAt falls within the reminder window, org admins get a
 * single heads-up email so they can rotate the key before the integration
 * silently stops working. A key is atomically "claimed"
 * by setting expiry_reminder_sent_at (update ... where null ... returning)
 * before any email goes out, so concurrent scheduler ticks or repeated runs
 * do not replay an attempted reminder for the same expiry. The legacy sent-at
 * field is a claim, not delivery proof. Unknown/partial outcomes retain that
 * claim for operator review. Only a key with no send attempt may be released.
 */
import { apiKeysTable, db, usersTable, type ApiKey } from "@workspace/db";
import { and, eq, gt, inArray, isNull, lte } from "drizzle-orm";

import { logger } from "../lib/logger";

import {
  isSafeMailbox,
  isTransactionalEmailConfigured,
  transactionalEmailProvider,
} from "./providers";
import { assertOutboundDeliveryAllowed } from "./outbound-hold";
import { ResendSendError } from "./resend-delivery";
import { recordAudit } from "./audit";

/** How many days before expiry the reminder goes out. */
export const API_KEY_EXPIRY_REMINDER_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

function formatWhenExpires(expiresAt: Date, now: Date): string {
  const days = Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS);
  const dateText = expiresAt.toISOString().slice(0, 10);
  if (days <= 0) return `today (${dateText})`;
  if (days === 1) return `tomorrow (${dateText})`;
  return `in ${days} days (${dateText})`;
}

/** Usable email addresses of an org's active owners/admins. */
export async function orgAdminEmails(
  organizationId: string,
): Promise<string[]> {
  const admins = await db
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.organizationId, organizationId),
        eq(usersTable.isActive, true),
        inArray(usersTable.role, ["owner", "admin"]),
      ),
    );
  return admins
    .map((a) => a.email?.trim() ?? "")
    .filter((email) => email.length > 0 && isSafeMailbox(email));
}

interface ReminderResult {
  recipientCount: number;
  acceptedCount: number;
  rejectedCount: number;
  unknownCount: number;
  notAttemptedCount: number;
}

/** Provider acceptance is distinct from inbox delivery and from uncertainty. */
async function sendReminderForKey(
  key: ApiKey,
  now: Date,
): Promise<ReminderResult> {
  const result: ReminderResult = {
    recipientCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    unknownCount: 0,
    notAttemptedCount: 0,
  };
  if (!key.expiresAt) return result;
  let recipients: string[];
  try {
    recipients = await orgAdminEmails(key.organizationId);
  } catch {
    // This lookup happens before every provider call. Only this known
    // no-attempt failure is eligible for the ordinary guarded claim release.
    logger.error(
      {
        apiKeyId: key.id,
        organizationId: key.organizationId,
        errorCode: "api_key_expiry_reminder_recipient_lookup_failed",
        outcome: "not_attempted",
      },
      "api-key expiry reminder: recipient lookup failed before any send",
    );
    return result;
  }
  result.recipientCount = recipients.length;
  if (recipients.length === 0) return result;
  const whenText = formatWhenExpires(key.expiresAt, now);
  const subject = `API key "${key.name}" expires ${whenText}`;
  const body = [
    `The API key "${key.name}" (${key.prefix}…) expires ${whenText}.`,
    "",
    "After that moment, any integration using this key will stop working.",
    "To avoid an interruption, create a replacement key and update the",
    "integration before the expiry date, then revoke the old key.",
    "",
    "You can manage API keys in the Command Center under Settings → API keys.",
  ].join("\n");
  for (const to of recipients) {
    // A known pre-dispatch hold/configuration failure is safe to release. The
    // provider repeats these authoritative checks at the actual send boundary.
    try {
      assertOutboundDeliveryAllowed({ channel: "email", recipient: to });
      if (
        process.env.NODE_ENV === "production" &&
        !isTransactionalEmailConfigured()
      )
        throw new Error("transactional_email_unconfigured");
    } catch {
      result.notAttemptedCount += 1;
      continue;
    }
    try {
      await transactionalEmailProvider.send(to, subject, body);
      result.acceptedCount += 1;
    } catch (err) {
      // A plain error does not prove the request was rejected before an effect.
      // Continue to other admins, never replay this recipient automatically.
      if (err instanceof ResendSendError && err.outcome === "rejected")
        result.rejectedCount += 1;
      else result.unknownCount += 1;
    }
  }
  return result;
}

/**
 * Find active keys expiring within the reminder window that have not been
 * reminded about yet, claim them, and email org admins. Returns the claimed
 * keys, not a list of successfully delivered emails. Safe outcome counts are
 * recorded in the audit log for attempted sends, including partial acceptance.
 */
export async function processApiKeyExpiryReminders(
  withinDays = API_KEY_EXPIRY_REMINDER_DAYS,
  now = new Date(),
): Promise<ApiKey[]> {
  const windowEnd = new Date(now.getTime() + withinDays * DAY_MS);
  // Atomically claim eligible keys so a reminder is sent at most once even
  // if two scheduler instances tick at the same time.
  const claimed = await db
    .update(apiKeysTable)
    .set({ expiryReminderSentAt: now })
    .where(
      and(
        eq(apiKeysTable.isActive, true),
        isNull(apiKeysTable.revokedAt),
        isNull(apiKeysTable.expiryReminderSentAt),
        gt(apiKeysTable.expiresAt, now),
        lte(apiKeysTable.expiresAt, windowEnd),
      ),
    )
    .returning();
  for (const key of claimed) {
    const result = await sendReminderForKey(key, now);
    const attemptedCount =
      result.acceptedCount + result.rejectedCount + result.unknownCount;
    if (attemptedCount === 0) {
      // No provider call was attempted. Releasing is safe if recipients or
      // configuration become available. Never clear an uncertain/partial send.
      await db
        .update(apiKeysTable)
        .set({ expiryReminderSentAt: null })
        .where(
          and(
            eq(apiKeysTable.id, key.id),
            eq(apiKeysTable.expiryReminderSentAt, now),
          ),
        );
      logger.warn(
        {
          apiKeyId: key.id,
          organizationId: key.organizationId,
          ...result,
          outcome: "not_attempted",
        },
        "api-key expiry reminder: no send attempted, claim released",
      );
      continue;
    }
    const outcome =
      result.unknownCount > 0
        ? "indeterminate"
        : result.acceptedCount === result.recipientCount
          ? "accepted"
          : result.acceptedCount > 0
            ? "partially_accepted"
            : "rejected";
    const metadata = {
      ...result,
      outcome,
      claimAt: now.toISOString(),
      expiresAt: key.expiresAt?.toISOString(),
      claimRetained: true,
      automaticRetry: false,
      reconciliationRequired: result.unknownCount > 0,
      operatorReviewRequired: outcome !== "accepted",
      deliveryVerified: false,
    };
    const evidence = {
      apiKeyId: key.id,
      organizationId: key.organizationId,
      ...metadata,
    };
    try {
      await recordAudit({
        organizationId: key.organizationId,
        action: "api_key.expiry_reminder.processed",
        entityType: "api_key",
        entityId: key.id,
        metadata,
      });
    } catch {
      // The effect may already exist. Keep this claim and outcome evidence,
      // but do not strand later keys that this cycle has already claimed.
      logger.error(
        {
          ...evidence,
          errorCode: "api_key_expiry_reminder_audit_failed",
          auditRecorded: false,
          operatorReviewRequired: true,
        },
        "api-key expiry reminder: audit write failed; claim retained and remaining keys will continue",
      );
      continue;
    }
    if (outcome === "accepted")
      logger.info(
        evidence,
        "api-key expiry reminder: provider accepted reminders",
      );
    else
      logger.warn(
        evidence,
        "api-key expiry reminder: claim retained; review email outcomes before any new send",
      );
  }
  return claimed;
}
