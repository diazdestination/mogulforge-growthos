import { db, revenueExecutionsTable } from "@workspace/db";
import { and, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import { sourceOutreachItemsTable as legacy } from "../../../../lib/db/src/schema/source-adoption";
import { sourceNurtureItemsTable as nurture } from "../../../../lib/db/src/schema/source-nurture";
import { lockContractorSchedule } from "./contractor-scheduling";
import { lockReplyLead } from "./response-correlation";
import { sourceOutreachKey, adoptionDeny } from "./source-adoption-contract";
export type NurtureTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Uniform order for reservation, source mutation, reply and final send claims. */
export async function acquireNurtureLocks(tx: Pick<NurtureTx, "execute">, org: string, leadIds: string[] = []) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`customer-lifecycle:${org}`}, 0))`);
  await lockContractorSchedule(tx as NurtureTx, org);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`lead-import:${org}`}))`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`source-outreach:${org}`}, 0))`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`contact-touch:${org}`}, 0))`);
  for (const id of [...new Set(leadIds)].sort()) await lockReplyLead(tx as NurtureTx, org, id);
}
export async function assertSourceSlotAvailable(reader: Pick<typeof db, "select">, org: string, leadId: string, recipient: string, ownNurtureItemId?: string) {
  const [old] = await reader.select({ id: legacy.id }).from(legacy).where(and(eq(legacy.organizationId, org), isNotNull(legacy.claimedAt), or(eq(legacy.leadId, leadId), eq(legacy.recipient, recipient)))).limit(1);
  const [claimed] = await reader.select({ id: nurture.id }).from(nurture).where(and(eq(nurture.organizationId, org), isNotNull(nurture.admittedAt),
    ownNurtureItemId ? ne(nurture.id, ownNurtureItemId) : undefined, or(eq(nurture.leadId, leadId), eq(nurture.recipient, recipient)))).limit(1);
  const [receipt] = await reader.select({ id: revenueExecutionsTable.id }).from(revenueExecutionsTable).where(and(eq(revenueExecutionsTable.organizationId, org), eq(revenueExecutionsTable.actionKey, sourceOutreachKey(leadId)))).limit(1);
  if (old || claimed || receipt) adoptionDeny("source_touch_reserved", "This opportunity or address already owns its reviewed source outreach. Another campaign cannot resend it.");
}
