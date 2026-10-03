import { db, twilioDispatchesTable } from "@workspace/db";
import { callieAckDispatchesTable } from "../../../../lib/db/src/schema/callie";
import { and, desc, eq, gte, ne, sql } from "drizzle-orm";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type SmsBudgetReader = Pick<typeof db, "select">;

/** Both transports must hold this lock while checking and claiming allowance. */
export async function lockTwilioSmsBudget(tx: Transaction, organizationId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`twilio:${organizationId}`}))`);
}

export async function callieOwnsSmsOperation(reader: SmsBudgetReader, organizationId: string, operationKey: string) {
  const [owned] = await reader.select({ id: callieAckDispatchesTable.id }).from(callieAckDispatchesTable)
    .where(and(eq(callieAckDispatchesTable.organizationId, organizationId), eq(callieAckDispatchesTable.operationKey, operationKey))).limit(1);
  return Boolean(owned);
}

/** Every owned attempt counts, including failures and ambiguous effects. */
export async function countTwilioSmsOperations(reader: SmsBudgetReader, organizationId: string, since: Date) {
  const [legacy] = await reader.select({ count: sql<number>`count(*)::int` }).from(twilioDispatchesTable)
    .where(and(eq(twilioDispatchesTable.organizationId, organizationId), gte(twilioDispatchesTable.createdAt, since)));
  const [callie] = await reader.select({ count: sql<number>`count(*)::int` }).from(callieAckDispatchesTable)
    .where(and(eq(callieAckDispatchesTable.organizationId, organizationId), gte(callieAckDispatchesTable.createdAt, since)));
  return legacy.count + callie.count;
}

export async function latestTwilioSmsToPhone(reader: SmsBudgetReader, organizationId: string, phone: string, since: Date, exceptKey: string) {
  const [legacy] = await reader.select({ at: twilioDispatchesTable.createdAt }).from(twilioDispatchesTable)
    .where(and(eq(twilioDispatchesTable.organizationId, organizationId), eq(twilioDispatchesTable.phone, phone),
      gte(twilioDispatchesTable.createdAt, since), ne(twilioDispatchesTable.idempotencyKey, exceptKey)))
    .orderBy(desc(twilioDispatchesTable.createdAt)).limit(1);
  const [callie] = await reader.select({ at: callieAckDispatchesTable.createdAt }).from(callieAckDispatchesTable)
    .where(and(eq(callieAckDispatchesTable.organizationId, organizationId), eq(callieAckDispatchesTable.toPhone, phone),
      gte(callieAckDispatchesTable.createdAt, since), ne(callieAckDispatchesTable.operationKey, exceptKey)))
    .orderBy(desc(callieAckDispatchesTable.createdAt)).limit(1);
  return [legacy?.at, callie?.at].filter((at): at is Date => at !== undefined).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
}
