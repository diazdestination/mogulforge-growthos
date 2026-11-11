import {
  db,
  zapierCapabilityBindingsTable,
  zapierMcpConnectionsTable,
  zapierSpecialistPoliciesTable,
} from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";

import { zapierMcpConfigured } from "./zapier-mcp-client";
import { callieSyncCalls, scoutSyncMarketplaceLeads, scoutSyncReviews } from "./zapier-specialist-flows";
import { callieSyncSmsReplies, scoutSyncInboxReplies } from "./zapier-owned-app-flows";

/**
 * Scheduler stage: run the read-only specialist syncs (SCOUT leads and
 * reviews and inbox replies, CALLIE calls) for every organization that
 * connected Zapier, bound the capability, and left it on `auto`. Each sync is
 * idempotent within the company's poll window (Settings, default 4 hours)
 * through the execution ledger, so the 60-second scheduler cadence never
 * spends more than one Zapier read per capability per window.
 *
 * Writes are never started from here: APPT, INVO, ESTI, SCOUT review texts
 * and SCHED day sheets originate from a human action or an approved request.
 * The one exception is CALLIE's call sync, which may REQUEST one missed-call
 * text-back per new missed inbound call. That request goes through the
 * `callie.sms.send` policy (Off by default, cannot leave Off until texting
 * registration is confirmed) and every text-back eligibility check, at
 * request, at approval and again right before dispatch.
 */

const READ_SYNCS = {
  "scout.leads.list": scoutSyncMarketplaceLeads,
  "scout.reviews.list": scoutSyncReviews,
  "callie.calls.list": callieSyncCalls,
  "scout.inbox.list": scoutSyncInboxReplies,
  "callie.sms.inbox.list": callieSyncSmsReplies,
} as const;

export async function processZapierConnectedApps(organizationId?: string): Promise<void> {
  if (!zapierMcpConfigured()) return;
  const connections = await db
    .select({ organizationId: zapierMcpConnectionsTable.organizationId })
    .from(zapierMcpConnectionsTable)
    .where(
      organizationId
        ? and(eq(zapierMcpConnectionsTable.organizationId, organizationId), isNull(zapierMcpConnectionsTable.revokedAt))
        : isNull(zapierMcpConnectionsTable.revokedAt),
    );
  for (const connection of connections) {
    const bindings = await db
      .select({ capability: zapierCapabilityBindingsTable.capability })
      .from(zapierCapabilityBindingsTable)
      .where(eq(zapierCapabilityBindingsTable.organizationId, connection.organizationId));
    const policies = await db
      .select({ capability: zapierSpecialistPoliciesTable.capability, mode: zapierSpecialistPoliciesTable.mode })
      .from(zapierSpecialistPoliciesTable)
      .where(eq(zapierSpecialistPoliciesTable.organizationId, connection.organizationId));
    const modeByCapability = new Map(policies.map((policy) => [policy.capability, policy.mode]));
    for (const binding of bindings) {
      const sync = READ_SYNCS[binding.capability as keyof typeof READ_SYNCS];
      if (!sync) continue;
      // Read capabilities default to auto only once a policy row exists; an
      // explicit `off` or `approve` keeps the scheduler out.
      if ((modeByCapability.get(binding.capability) ?? "auto") !== "auto") continue;
      try {
        await sync({ organizationId: connection.organizationId, actorUserId: null });
      } catch {
        // The ledger already holds the receipt; never let one tenant's
        // provider failure stop the others. No error objects are logged.
        console.error("[zapier] connected-app sync failed; review the Zapier execution ledger");
      }
    }
  }
}
