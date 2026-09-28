import {
  consentRecordsTable,
  contactsTable,
  db,
  leadsTable,
  playbookEnrollmentsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { rateLimit } from "../../lib/rateLimit";
import { recordAudit } from "../../services/audit";
import { recordContactOptOut } from "../../services/delivery-events";
import { stopEnrollmentsForLead } from "../../services/playbooks";
import {
  addSuppression,
  parseUnsubscribeToken,
  publicBaseUrl,
} from "../../services/send-gate";

/**
 * Public opt-out endpoints (no auth — recipients are not CRM users):
 *
 * - GET  /public/unsubscribe/:token  → confirmation landing page
 * - POST /public/unsubscribe/:token  → records the email unsubscribe
 * SMS consent and signature-validated opt-out routing live in twilio.ts.
 *
 * The unsubscribe token is an HMAC over (org, contact) — unguessable, no DB
 * state, and safe to expose in every outbound email footer.
 */
const router: IRouter = Router();

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:64px auto;padding:0 20px;line-height:1.6;color:#1a1a1a}button{background:#1a1a1a;color:#fff;border:0;border-radius:8px;padding:12px 24px;font-size:16px;cursor:pointer}p{color:#444}</style></head>
<body>${body}</body>
</html>`;
}

router.get(
  "/public/unsubscribe/:token",
  rateLimit({ windowMs: 60_000, max: 30, key: "unsubscribe" }),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = parseUnsubscribeToken(String(req.params.token ?? ""));
    if (!parsed) {
      res
        .status(404)
        .send(page("Link not valid", "<h1>This link isn't valid</h1><p>The unsubscribe link may be incomplete — try copying the full link from the email.</p>"));
      return;
    }
    // Confirmation step so mail scanners that prefetch links can't
    // unsubscribe people by accident; the POST does the actual work.
    res.status(200).setHeader("Cache-Control", "no-store").send(
      page(
        "Unsubscribe",
        `<h1>Unsubscribe from emails</h1>
<p>You'll stop receiving automated emails at this address. You can still be contacted about appointments you book.</p>
<form method="POST" action=""><button type="submit">Unsubscribe</button></form>`,
      ),
    );
  },
);

router.post(
  "/public/unsubscribe/:token",
  rateLimit({ windowMs: 60_000, max: 10, key: "unsubscribe-post" }),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = parseUnsubscribeToken(String(req.params.token ?? ""));
    if (!parsed) {
      res.status(404).send(page("Link not valid", "<h1>This link isn't valid</h1>"));
      return;
    }
    const { organizationId, contactId } = parsed;
    const [contact] = await db
      .select()
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.id, contactId),
          eq(contactsTable.organizationId, organizationId),
        ),
      );
    if (contact?.email) {
      // Suppresses the address, flips the contact's do-not-email flag,
      // marks outstanding email touches unsubscribed, and records the
      // opt-out on each lead's timeline.
      await recordContactOptOut({
        organizationId,
        contactId: contact.id,
        channel: "email",
        source: "unsubscribe_link",
      });
      await db.insert(consentRecordsTable).values({
        organizationId,
        contactId: contact.id,
        channel: "email",
        granted: false,
        disclosureVersion: "unsubscribe-link-v1",
        sourceIp: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? null,
        userAgent: (req.headers["user-agent"] as string) ?? null,
      });
      await stopContactEnrollments(organizationId, contact.id, "recipient unsubscribed");
      await recordAudit({
        organizationId,
        action: "send.unsubscribed",
        entityType: "contact",
        entityId: contact.id,
        metadata: { channel: "email", source: "unsubscribe_link" },
      });
    }
    // Same response whether or not the contact still exists — don't leak.
    res.status(200).send(
      page(
        "Unsubscribed",
        "<h1>You're unsubscribed</h1><p>You won't receive any more automated emails at this address.</p>",
      ),
    );
  },
);

/** Stop every live enrollment on every lead belonging to the contact. */
async function stopContactEnrollments(
  organizationId: string,
  contactId: string,
  reason: string,
): Promise<void> {
  const leads = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .innerJoin(
      playbookEnrollmentsTable,
      and(
        eq(playbookEnrollmentsTable.leadId, leadsTable.id),
        inArray(playbookEnrollmentsTable.status, ["active", "paused"]),
      ),
    )
    .where(
      and(
        eq(leadsTable.organizationId, organizationId),
        eq(leadsTable.contactId, contactId),
      ),
    );
  for (const lead of leads) {
    await stopEnrollmentsForLead(organizationId, lead.id, reason, "stopped");
  }
}

export default router;
