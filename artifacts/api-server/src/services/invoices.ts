import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  auditEventsTable,
  activitiesTable,
  contactsTable,
  customerWorkRootsTable,
  crmTasksTable,
  db,
  estimatesTable,
  invoiceOperationsTable as operations,
  invoicePaymentLinksTable,
  invoiceReceiptAllocationsTable as allocations,
  invoiceSequencesTable as sequences,
  invoicesTable as invoices,
  leadsTable,
  projectsTable,
  usersTable,
  valueEntriesTable as entries,
  type UserRole,
} from "@workspace/db";
import { hasPermission } from "../lib/permissions";
import { lockContractorSchedule } from "./contractor-scheduling";
import { invoiceEquipment } from "./invoice-equipment";
import { assertCustomerWorkActive, assertCustomerWorkReader, createCustomerWorkRoot, customerWorkActor, customerWorkHash, lockCustomerWork, readNativeWorkLineage } from "./customer-work-lineage";
import { CustomerWorkError } from "./returning-customer-contract";
import {
  createInvoiceSchema,
  invoiceAllocationSchema,
  invoiceDocument,
  InvoiceError,
  invoiceListSchema,
  invoicePaymentSchema,
  invoiceRefundSchema,
  issueInvoiceSchema,
  reverseInvoiceAllocationSchema,
  updateInvoiceSchema,
  voidInvoiceSchema,
  type InvoiceDetail,
  type InvoiceList,
  type InvoiceMutation,
  type InvoiceSummary,
} from "./invoice-contract";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Tx | typeof db;
export type InvoiceReader = Reader;
type Invoice = typeof invoices.$inferSelect;
type Allocation = typeof allocations.$inferSelect;
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unavailable = () =>
  new InvoiceError(
    503,
    "invoice_unavailable",
    "Invoice records need operator review. No new action was confirmed.",
  );
const conflict = (code: string, message: string): never => {
  throw new InvoiceError(409, code, message);
};
const absent = (): never => {
  throw new InvoiceError(
    404,
    "invoice_not_found",
    "The invoice or related record is not available in this company.",
  );
};

async function actor(
  reader: Reader,
  org: string,
  userId: string,
  manage: boolean,
  effectiveRole?: UserRole,
) {
  const query = reader
    .select({ id: usersTable.id, role: usersTable.role })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.id, userId),
        eq(usersTable.organizationId, org),
        eq(usersTable.isActive, true),
      ),
    );
  const [user] = await (manage ? query.for("share") : query);
  if (
    !user ||
    !hasPermission(user.role, manage ? "invoices.manage" : "invoices.read") ||
    !hasPermission(effectiveRole ?? user!.role, manage ? "invoices.manage" : "invoices.read")
  ) {
    throw new InvoiceError(
      403,
      "invoice_access_denied",
      "An active staff member with invoice permission is required.",
    );
  }
}
async function lock(reader: Tx, org: string) {
  await reader.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`invoices:${org}`}, 0))`,
  );
}
async function budget(reader: Tx) {
  await reader.execute(
    sql`select set_config('lock_timeout','3000ms',true), set_config('statement_timeout','10000ms',true), set_config('idle_in_transaction_session_timeout','15000ms',true)`,
  );
}
async function related(
  reader: Reader,
  org: string,
  refs: {
    leadId: string | null;
    customerWorkId?: string | null;
    projectId?: string | null;
    estimateId?: string | null;
  },
  creating = false,
  locked = false,
) {
  const lineage = await readNativeWorkLineage(reader,org,{leadId:refs.leadId,customerWorkId:refs.customerWorkId ?? null},locked).catch(error=>{
    // Keep the established invoice boundary opaque for unavailable/mismatched
    // parents; a native helper's internal code is not a new legacy API result.
    if (error instanceof CustomerWorkError && ["customer_work_not_found","customer_work_parent_unavailable","customer_work_parent_mismatch","customer_work_scope_invalid"].includes(error.code)) return absent();
    throw error;
  });
  const lead = lineage.lead;
  let project: typeof projectsTable.$inferSelect | null = null;
  let estimate: typeof estimatesTable.$inferSelect | null = null;
  let estimateId = refs.estimateId ?? null;
  if (refs.projectId) {
    const pq = reader
      .select()
      .from(projectsTable)
      .where(
        and(
          eq(projectsTable.id, refs.projectId),
          eq(projectsTable.organizationId, org),
        ),
      );
    const [selected] = await (locked ? pq.for("share") : pq);
    if (!selected || selected.leadId !== refs.leadId || selected.customerWorkId !== (refs.customerWorkId ?? null)) return absent();
    project = selected;
    if (
      (creating || refs.customerWorkId) &&
      estimateId &&
      project.estimateId &&
      estimateId !== project.estimateId
    )
      return absent();
    // Returning lineage includes the project's populated estimate even when an
    // older/manual native row omitted invoice.estimateId. Read its exact parent
    // as evidence; never rewrite the invoice's stored linkage or legacy hash.
    if (creating || refs.customerWorkId) estimateId ??= project.estimateId;
  }
  if (estimateId) {
    const eqry = reader
      .select()
      .from(estimatesTable)
      .where(
        and(
          eq(estimatesTable.id, estimateId),
          eq(estimatesTable.organizationId, org),
        ),
      );
    const [selected] = await (locked ? eqry.for("share") : eqry);
    if (!selected || selected.leadId !== refs.leadId || selected.customerWorkId !== (refs.customerWorkId ?? null)) return absent();
    estimate = selected;
  }
  return { lead, estimateId, lineage, project, estimate };
}
async function load(
  reader: Reader,
  org: string,
  id: string,
  locked = false,
): Promise<Invoice> {
  const query = reader
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.organizationId, org)));
  const [row] = await (locked ? query.for("update") : query);
  if (!row) return absent();
  await related(reader, org, row, false, locked);
  checkedDocument(row);
  return row;
}
function checkedDocument(row: Invoice) {
  const document = row.issuedDocument ?? row.draftDocument;
  if (
    !document ||
    !Number.isSafeInteger(document.totalCents) ||
    document.totalCents < 0 ||
    document.currency !== "USD"
  )
    throw unavailable();
  if (
    row.issuedAt &&
    (!row.issuedDocument ||
      row.issuedDocumentSha256 !== fingerprint(row.issuedDocument))
  )
    throw unavailable();
  if (
    row.balanceBasis === "opening_receivable" &&
    (!row.historicalSource ||
      !row.openingAsOf ||
      !Number.isSafeInteger(row.openingReceivableCents) ||
      row.openingReceivableCents! < 0 ||
      row.openingReceivableCents! > document.totalCents)
  )
    throw unavailable();
  return document;
}

/** Read every related cash record needed for arithmetic; caps fail, never truncate totals. */
type MoneyScope = {leadId:string|null;customerWorkId:string|null};
function moneyScope(value: string | MoneyScope): MoneyScope {
  const scope = typeof value === "string" ? {leadId:value,customerWorkId:null} : value;
  if ((scope.leadId === null) === (scope.customerWorkId === null)) throw unavailable();
  return scope;
}
function sameScope(a: MoneyScope,b: MoneyScope) {return a.leadId===b.leadId && a.customerWorkId===b.customerWorkId;}
async function financial(reader: Reader, org: string, input: string | MoneyScope) {
  const scope=moneyScope(input);
  const values = await reader
    .select()
    .from(entries)
    .where(
      and(
        eq(entries.organizationId, org),
        scope.customerWorkId ? and(eq(entries.customerWorkId,scope.customerWorkId),isNull(entries.leadId)) : and(eq(entries.leadId,scope.leadId!),isNull(entries.customerWorkId)),
        inArray(entries.kind, ["payment", "refund"]),
      ),
    )
    .orderBy(desc(entries.occurredAt), entries.id)
    .limit(2001);
  const applied = await reader
    .select({
      allocation: allocations,
      invoice: {
        id: invoices.id,
        organizationId: invoices.organizationId,
        leadId: invoices.leadId,
        customerWorkId: invoices.customerWorkId,
      },
    })
    .from(allocations)
    .innerJoin(invoices, eq(invoices.id, allocations.invoiceId))
    .where(
      or(
        and(
          scope.customerWorkId ? and(eq(invoices.customerWorkId,scope.customerWorkId),isNull(invoices.leadId)) : and(eq(invoices.leadId,scope.leadId!),isNull(invoices.customerWorkId)),
          or(
            eq(allocations.organizationId, org),
            eq(invoices.organizationId, org),
          ),
        ),
        values.length
          ? inArray(
              allocations.valueEntryId,
              values.map((value) => value.id),
            )
          : undefined,
      ),
    )
    .orderBy(allocations.createdAt, allocations.id)
    .limit(4001);
  if (values.length > 2000 || applied.length > 4000) throw unavailable();
  if (
    values.some(
      (value) =>
        !Number.isSafeInteger(value.amountCents) || value.amountCents <= 0,
    )
  )
    throw unavailable();
  const valueMap = new Map(values.map((row) => [row.id, row]));
  const allocationMap = new Map(
    applied.map(({ allocation }) => [allocation.id, allocation]),
  );
  const reversed = new Map<string, Allocation>();
  for (const { allocation: a, invoice: owner } of applied) {
    const value = valueMap.get(a.valueEntryId);
    if (
      owner.organizationId !== org ||
      !sameScope(owner,scope) ||
      a.organizationId !== org ||
      !value ||
      !Number.isSafeInteger(value.amountCents) ||
      value.amountCents <= 0 ||
      a.amountCents <= 0
    )
      throw unavailable();
    if (a.kind === "reversal") {
      const original = allocationMap.get(a.reversesAllocationId ?? "");
      if (
        !original ||
        original.kind === "reversal" ||
        original.invoiceId !== a.invoiceId ||
        original.valueEntryId !== a.valueEntryId ||
        original.amountCents !== a.amountCents ||
        reversed.has(original.id)
      )
        throw unavailable();
      reversed.set(original.id, a);
    } else if (a.kind !== value.kind || a.reversesAllocationId !== null)
      throw unavailable();
  }
  const active = applied
    .map((row) => row.allocation)
    .filter((row) => row.kind !== "reversal" && !reversed.has(row.id));
  const used = new Map<string, number>();
  for (const a of active)
    used.set(a.valueEntryId, (used.get(a.valueEntryId) ?? 0) + a.amountCents);
  for (const [id, amount] of used)
    if (amount > valueMap.get(id)!.amountCents || !Number.isSafeInteger(amount))
      throw unavailable();
  if (scope.customerWorkId) {
    const refunded = new Map<string, number>();
    for (const value of values) {
      if (!sameScope(value,scope)) throw unavailable();
      if (value.kind === "payment") {
        if (value.refundOfValueEntryId !== null) throw unavailable();
        continue;
      }
      const original = valueMap.get(value.refundOfValueEntryId ?? "");
      if (!original || original.kind !== "payment" || original.id === value.id || value.occurredAt < original.occurredAt) throw unavailable();
      refunded.set(original.id,(refunded.get(original.id) ?? 0)+value.amountCents);
    }
    for (const [id,amount] of refunded) if (!Number.isSafeInteger(amount) || amount > valueMap.get(id)!.amountCents) throw unavailable();
    for (const a of active.filter(a=>a.kind === "refund")) {
      const originalPaymentId=valueMap.get(a.valueEntryId)!.refundOfValueEntryId!;
      const paid=active.filter(p=>p.invoiceId===a.invoiceId && p.kind==="payment" && p.valueEntryId===originalPaymentId).reduce((s,p)=>s+p.amountCents,0);
      const returned=active.filter(r=>r.invoiceId===a.invoiceId && r.kind==="refund" && valueMap.get(r.valueEntryId)!.refundOfValueEntryId===originalPaymentId).reduce((s,r)=>s+r.amountCents,0);
      if (returned>paid) throw unavailable();
    }
  }
  const unallocatedRefundCents = values
    .filter((v) => v.kind === "refund")
    .reduce((sum, v) => sum + v.amountCents - (used.get(v.id) ?? 0), 0);
  if (!Number.isSafeInteger(unallocatedRefundCents)) throw unavailable();
  return {
    values,
    valueMap,
    applied: applied.map((row) => row.allocation),
    active,
    reversed,
    used,
    unallocatedRefundCents,
  };
}
type Financial = Awaited<ReturnType<typeof financial>>;
function money(row: Invoice, data: Financial) {
  const documentTotal = checkedDocument(row).totalCents;
  const total =
    row.balanceBasis === "opening_receivable"
      ? row.openingReceivableCents!
      : documentTotal;
  const recordedPaidCents = data.active
    .filter((a) => a.invoiceId === row.id)
    .reduce(
      (sum, a) => sum + (a.kind === "payment" ? a.amountCents : -a.amountCents),
      0,
    );
  if (
    !Number.isSafeInteger(recordedPaidCents) ||
    recordedPaidCents < 0 ||
    recordedPaidCents > total
  )
    throw unavailable();
  const recordedBalanceCents = total - recordedPaidCents;
  const reconciliationRequired = data.unallocatedRefundCents > 0;
  const paymentState: InvoiceSummary["paymentState"] = reconciliationRequired
    ? "reconciliation_required"
    : recordedPaidCents === 0
      ? "unpaid"
      : recordedBalanceCents === 0
        ? "paid"
        : "partial";
  return {
    recordedPaidCents,
    recordedBalanceCents,
    balanceDueCents:
      row.status === "void"
        ? 0
        : row.status !== "issued" || reconciliationRequired
          ? null
          : recordedBalanceCents,
    paymentState,
    reconciliationRequired,
    unallocatedRefundCents: data.unallocatedRefundCents,
  };
}
function summary(row: Invoice, data: Financial, lineage: Awaited<ReturnType<typeof readNativeWorkLineage>>): InvoiceSummary {
  const doc = checkedDocument(row);
  return {
    id: row.id,
    organizationId: row.organizationId,
    leadId: row.leadId,
    customerWorkId: row.customerWorkId,
    contactId: lineage.contact.id,
    propertyId: lineage.property?.id ?? null,
    sourceKind: lineage.kind,
    projectId: row.projectId,
    estimateId: row.estimateId,
    invoiceNumber: row.invoiceNumber,
    status: row.status,
    version: row.version,
    title: doc.title,
    customerName: doc.customerName,
    currency: doc.currency,
    subtotalCents: doc.subtotalCents,
    taxCents: doc.taxCents,
    totalCents: doc.totalCents,
    dueDate: doc.dueDate,
    issuedAt: row.issuedAt?.toISOString() ?? null,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    balanceBasis: row.balanceBasis,
    openingReceivableCents: row.openingReceivableCents,
    openingAsOf: row.openingAsOf?.toISOString() ?? null,
    historicalSource: row.historicalSource,
    ...money(row, data),
  };
}
async function detail(
  reader: Reader,
  org: string,
  row: Invoice,
): Promise<InvoiceDetail> {
  const data = await financial(reader, org, row);
  const {lineage} = await related(reader,org,row);
  const history = await reader
    .select()
    .from(operations)
    .where(
      and(eq(operations.organizationId, org), eq(operations.invoiceId, row.id)),
    )
    .orderBy(operations.createdAt, operations.id)
    .limit(4001);
  if (history.length > 4000) throw unavailable();
  const available = data.values.filter(
    (v) => v.amountCents > (data.used.get(v.id) ?? 0),
  );
  return {
    ...summary(row, data, lineage),
    document: row.issuedDocument ?? row.draftDocument,
    allocations: data.applied
      .filter((a) => a.invoiceId === row.id && a.kind !== "reversal")
      .map((a) => {
        const value = data.valueMap.get(a.valueEntryId)!;
        const reversal = data.reversed.get(a.id);
        return {
          id: a.id,
          valueEntryId: value.id,
          refundOfValueEntryId: value.refundOfValueEntryId,
          kind: a.kind as "payment" | "refund",
          sourceReference: value.sourceReference,
          amountCents: a.amountCents,
          occurredAt: value.occurredAt.toISOString(),
          allocatedAt: a.createdAt.toISOString(),
          reversedAt: reversal?.createdAt.toISOString() ?? null,
          reversalReason: reversal?.reason ?? null,
        };
      }),
    availableValueEntries: available.slice(0, 50).map((v) => ({
      id: v.id,
      refundOfValueEntryId: v.refundOfValueEntryId,
      kind: v.kind as "payment" | "refund",
      sourceReference: v.sourceReference,
      amountCents: v.amountCents,
      availableCents: v.amountCents - (data.used.get(v.id) ?? 0),
      occurredAt: v.occurredAt.toISOString(),
    })),
    availableValueEntriesTruncated: available.length > 50,
    events: history.map((event) => ({
      id: event.id,
      action: event.action,
      version: event.version,
      reason: event.reason,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}
export async function listInvoices(
  org: string,
  userId: string,
  raw: unknown,
  effectiveRole?: UserRole,
): Promise<InvoiceList> {
  const filter = invoiceListSchema.parse(raw);
  return db.transaction(
    async (tx) => {
      await budget(tx);
      await actor(tx, org, userId, false,effectiveRole);
      const where = and(
        eq(invoices.organizationId, org),
        filter.status ? eq(invoices.status, filter.status) : undefined,
        filter.leadId ? eq(invoices.leadId, filter.leadId) : undefined,
        filter.projectId ? eq(invoices.projectId, filter.projectId) : undefined,
        filter.customerWorkId ? eq(invoices.customerWorkId,filter.customerWorkId) : undefined,
        filter.contactId ? sql`((exists(select 1 from ${customerWorkRootsTable} r where r.organization_id=${org} and r.id=${invoices.customerWorkId} and r.contact_id=${filter.contactId})) or (exists(select 1 from ${leadsTable} l where l.organization_id=${org} and l.id=${invoices.leadId} and l.contact_id=${filter.contactId})))` : undefined,
      );
      const [count] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(invoices)
        .where(where);
      const rows = await tx
        .select()
        .from(invoices)
        .where(where)
        .orderBy(desc(invoices.createdAt), invoices.id)
        .limit(25)
        .offset(filter.page * 25);
      const cache = new Map<string, Financial>();
      const items: InvoiceSummary[] = [];
      for (const row of rows) {
        const {lineage}=await related(tx, org, row);
        if (row.customerWorkId) await customerWorkActor(tx,org,{userId,effectiveRole},"invoices.read");
        const key=row.customerWorkId ? `work:${row.customerWorkId}` : `lead:${row.leadId}`;
        if (!cache.has(key)) cache.set(key,await financial(tx,org,row));
        items.push(summary(row,cache.get(key)!,lineage));
      }
      return { items, total: count!.total, page: filter.page, pageSize: 25 };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function getInvoice(
  org: string,
  userId: string,
  id: string,
  effectiveRole?: UserRole,
): Promise<InvoiceDetail> {
  return db.transaction(
    async (tx) => {
      await budget(tx);
      return readInvoiceDetail(tx,org,userId,id,{effectiveRole});
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** No nested transaction/pool read: the caller retains its own exact admission locks. */
export async function readInvoiceDetail(reader:Reader,org:string,userId:string,id:string,options:{effectiveRole?:UserRole;lockRows?:boolean}={}) {
  const locked=options.lockRows === true;
  assertCustomerWorkReader(reader,locked);
  await actor(reader,org,userId,false,options.effectiveRole);
  const row=await load(reader,org,id,locked);
  if (row.customerWorkId) await customerWorkActor(reader,org,{userId,effectiveRole:options.effectiveRole},"invoices.read",locked);
  return detail(reader,org,row);
}

/** Returning-only delivery authority. V2 callers continue constructing their literal legacy snapshot. */
export async function readReturningInvoiceLineage(reader:Reader,org:string,invoiceId:string,options:{actorUserId:string;effectiveRole?:UserRole;lockRows?:boolean;requireIssued?:boolean}) {
  const locked=options.lockRows===true;
  assertCustomerWorkReader(reader,locked);
  await customerWorkActor(reader,org,{userId:options.actorUserId,effectiveRole:options.effectiveRole},"invoices.manage",locked);
  const row=await load(reader,org,invoiceId,locked);
  const parents=await related(reader,org,row,false,locked);
  if (parents.lineage.kind!=="customer_work") return absent();
  if (options.requireIssued!==false && row.status!=="issued") return conflict("invoice_transition_unavailable","Only a current issued invoice can be reviewed for email.");
  const {root,contact,property}=parents.lineage;
  // Include semantic values, not only timestamps. Ordinary same-millisecond edits
  // invalidate a reviewed recipient/address/native parent without rewriting issue history.
  const parentEvidence={root,contact,property,project:parents.project,estimate:parents.estimate};
  return {invoice:await detail(reader,org,row),root,contact,property,parentEvidence,sourceSha256:customerWorkHash(parentEvidence)};
}

async function replay(
  tx: Tx,
  org: string,
  requestId: string,
  hash: string,
  userId?: string,
  effectiveRole?: UserRole,
): Promise<InvoiceMutation | null> {
  const [prior] = await tx
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.organizationId, org),
        eq(operations.requestId, requestId),
      ),
    );
  if (!prior) return null;
  if (prior.fingerprint !== hash)
    return conflict(
      "invoice_request_conflict",
      "This request identity already records a different invoice action. Review the saved result before changing it.",
    );
  const row=await load(tx,org,prior.invoiceId);
  if (row.customerWorkId) {
    if (!userId || prior.actorUserId!==userId) return conflict("invoice_request_conflict","The original request belongs to a different staff action.");
    await customerWorkActor(tx,org,{userId,effectiveRole},"invoices.manage",true);
  }
  return {
    invoice: await detail(tx, org, row),
    duplicate: true,
  };
}
async function event(
  tx: Tx,
  org: string,
  userId: string,
  row: Invoice,
  requestId: string,
  hash: string,
  action: string,
  reason: string | null = null,
  resultId: string | null = null,
) {
  await tx.insert(operations).values({
    organizationId: org,
    invoiceId: row.id,
    requestId,
    fingerprint: hash,
    action,
    version: row.version,
    actorUserId: userId,
    reason,
    resultId,
  });
  await tx.insert(auditEventsTable).values({
    organizationId: org,
    actorUserId: userId,
    action: `invoice.${action}`,
    entityType: "invoice",
    entityId: row.id,
    metadata: {
      version: row.version,
      requestId,
      invoiceNumber: row.invoiceNumber,
      resultId,
      evidence: "staff_recorded",
      providerEffect: false,
      ...(reason ? { reason } : {}),
    },
  });
  await tx.insert(activitiesTable).values({
    organizationId: org,
    leadId: row.leadId,
    contactId: row.customerWorkId ? (await related(tx,org,row)).lineage.contact.id : null,
    actorUserId: userId,
    type: "invoice_event",
    title: `Invoice ${action.replaceAll("_", " ")}`,
    metadata: {
      invoiceId: row.id,
      version: row.version,
      invoiceNumber: row.invoiceNumber,
      providerEffect: false,
      ...(row.customerWorkId ? {customerWorkId:row.customerWorkId} : {}),
    },
  });
}
async function advance(
  tx: Tx,
  org: string,
  row: Invoice,
  patch: Partial<typeof invoices.$inferInsert> = {},
) {
  const [updated] = await tx
    .update(invoices)
    .set({ ...patch, version: row.version + 1, updatedAt: new Date() })
    .where(
      and(
        eq(invoices.id, row.id),
        eq(invoices.organizationId, org),
        eq(invoices.version, row.version),
      ),
    )
    .returning();
  if (!updated)
    return conflict(
      "invoice_version_changed",
      "The invoice changed. Refresh and review it before another action.",
    );
  return updated;
}
async function mutate(
  org: string,
  userId: string,
  id: string,
  input: { requestId: string; expectedVersion: number },
  action: string,
  work: (
    tx: Tx,
    row: Invoice,
  ) => Promise<{
    row: Invoice;
    reason?: string | null;
    resultId?: string | null;
  }>,
  effectiveRole?: UserRole,
  providerReceipt = false,
): Promise<InvoiceMutation> {
  const hash = fingerprint({ action, id, input });
  return db.transaction(async (tx) => {
    await budget(tx);
    await lockCustomerWork(tx,org,true);
    await actor(tx, org, userId, true,effectiveRole);
    const prior = await replay(tx, org, input.requestId, hash,userId,effectiveRole);
    if (prior) return prior;
    const row = await load(tx, org, id, true);
    if (!providerReceipt) {
      const [collecting] = await tx.select({ id: invoicePaymentLinksTable.id }).from(invoicePaymentLinksTable).where(and(
        eq(invoicePaymentLinksTable.organizationId, org), eq(invoicePaymentLinksTable.invoiceId, id),
        or(inArray(invoicePaymentLinksTable.state, ["open", "processing"]), and(eq(invoicePaymentLinksTable.state, "needs_reconciliation"), isNull(invoicePaymentLinksTable.paidAt))),
      )).limit(1);
      if (collecting) return conflict("invoice_collection_pending", "Resolve the outstanding Stripe collection before changing this invoice or its recorded balance.");
    }
    if (row.customerWorkId) {
      await customerWorkActor(tx,org,{userId,effectiveRole},"invoices.manage",true);
      await assertCustomerWorkActive(tx,org);
    }
    if (row.version !== input.expectedVersion)
      return conflict(
        "invoice_version_changed",
        "The invoice changed. Refresh and review it before another action.",
      );
    const result = await work(tx, row);
    await event(
      tx,
      org,
      userId,
      result.row,
      input.requestId,
      hash,
      action,
      result.reason,
      result.resultId,
    );
    return { invoice: await detail(tx, org, result.row), duplicate: false };
  });
}
export async function createInvoice(
  org: string,
  userId: string,
  raw: unknown,
  effectiveRole?: UserRole,
): Promise<InvoiceMutation> {
  const parsed = createInvoiceSchema.parse(raw);
  const input = {
    ...parsed,
    projectId: parsed.projectId ?? null,
    estimateId: parsed.estimateId ?? null,
    document: invoiceDocument(parsed.document),
  };
  const hash = fingerprint({ action: "draft_created", input });
  return db.transaction(async (tx) => {
    await budget(tx);
    // Prefix also serializes native conversion/preparation; there is no
    // invoice-then-schedule inversion and no second owner after a lost response.
    await lockCustomerWork(tx,org,true);
    await actor(tx, org, userId, true,effectiveRole);
    if ("source" in input) await customerWorkActor(tx,org,{userId,effectiveRole},"invoices.manage",true);
    const prior = await replay(tx, org, input.requestId, hash,userId,effectiveRole);
    if (prior) return prior;
    let leadId:string|null=null;
    let customerWorkId:string|null=null;
    if ("source" in input) {
      await assertCustomerWorkActive(tx,org);
      customerWorkId=input.source.kind === "customer_work" ? input.source.customerWorkId : (await createCustomerWorkRoot(tx,org,userId,input.source)).id;
    } else leadId=input.leadId;
    const refs = await related(tx, org, {...input,leadId,customerWorkId}, true, true);
    const equipment = await invoiceEquipment(tx, org, refs.lineage, input.equipment);
    const [row] = await tx
      .insert(invoices)
      .values({
        organizationId: org,
        leadId,
        customerWorkId,
        projectId: input.projectId,
        estimateId: refs.estimateId,
        draftDocument: equipment ? { ...input.document, equipment } : input.document,
        createdByUserId: userId,
      })
      .returning();
    await event(tx, org, userId, row!, input.requestId, hash, "draft_created");
    if (input.projectId)
      await tx
        .update(crmTasksTable)
        .set({ status: "done", completedAt: new Date() })
        .where(
          and(
            eq(crmTasksTable.organizationId, org),
            customerWorkId ? and(isNull(crmTasksTable.leadId),eq(crmTasksTable.contactId,refs.lineage.contact.id)) : eq(crmTasksTable.leadId,leadId!),
            eq(
              crmTasksTable.sourceEvent,
              `project.invoice_preparation:${input.projectId}`,
            ),
            inArray(crmTasksTable.status, ["open", "in_progress"]),
          ),
        );
    return { invoice: await detail(tx, org, row!), duplicate: false };
  });
}
export async function updateInvoice(
  org: string,
  userId: string,
  id: string,
  raw: unknown,
  effectiveRole?: UserRole,
) {
  const parsed = updateInvoiceSchema.parse(raw);
  const input = { ...parsed, document: invoiceDocument(parsed.document) };
  return mutate(org, userId, id, input, "draft_updated", async (tx, row) => {
    if (row.status !== "draft")
      return conflict(
        "invoice_transition_unavailable",
        "Only a draft invoice can be edited. Issued documents are retained unchanged.",
      );
    const equipment = await invoiceEquipment(tx, org, (await related(tx, org, row, false, true)).lineage, input.equipment);
    return {
      row: await advance(tx, org, row, { draftDocument: equipment ? { ...input.document, equipment } : input.document }),
    };
  },effectiveRole);
}
export async function issueInvoice(
  org: string,
  userId: string,
  id: string,
  raw: unknown,
  effectiveRole?: UserRole,
) {
  const input = issueInvoiceSchema.parse(raw);
  return mutate(org, userId, id, input, "issued", async (tx, row) => {
    if (row.status !== "draft")
      return conflict(
        "invoice_transition_unavailable",
        "Only a reviewed draft can be issued.",
      );
    if (
      row.draftDocument.lineItems.length === 0 ||
      row.draftDocument.totalCents < 1
    )
      throw new InvoiceError(
        400,
        "invoice_invalid_request",
        "Add at least one invoice line and a positive total before issuing.",
      );
    await tx
      .insert(sequences)
      .values({ organizationId: org })
      .onConflictDoNothing();
    const [counter] = await tx
      .select()
      .from(sequences)
      .where(eq(sequences.organizationId, org))
      .for("update");
    if (!counter || counter.nextNumber >= 2_147_483_647) throw unavailable();
    await tx
      .update(sequences)
      .set({ nextNumber: counter.nextNumber + 1 })
      .where(eq(sequences.organizationId, org));
    const invoiceNumber = `INV-${String(counter.nextNumber).padStart(6, "0")}`;
    const [collision] = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.organizationId, org),
          eq(invoices.invoiceNumber, invoiceNumber),
        ),
      );
    if (collision) throw unavailable();
    return {
      row: await advance(tx, org, row, {
        status: "issued",
        invoiceNumber,
        issuedDocument: structuredClone(row.draftDocument),
        issuedDocumentSha256: fingerprint(row.draftDocument),
        issuedAt: new Date(),
      }),
    };
  },effectiveRole);
}
export async function voidInvoice(
  org: string,
  userId: string,
  id: string,
  raw: unknown,
  effectiveRole?: UserRole,
) {
  const input = voidInvoiceSchema.parse(raw);
  return mutate(org, userId, id, input, "voided", async (tx, row) => {
    if (row.status === "void")
      return conflict(
        "invoice_transition_unavailable",
        "This invoice is already void.",
      );
    if (
      money(row, await financial(tx, org, row)).recordedPaidCents !== 0
    )
      return conflict(
        "invoice_payment_conflict",
        "Resolve the recorded receipt allocations before voiding. Voiding does not refund money.",
      );
    return {
      row: await advance(tx, org, row, {
        status: "void",
        voidedAt: new Date(),
        voidReason: input.reason,
      }),
      reason: input.reason,
    };
  },effectiveRole);
}
async function applyValue(
  tx: Tx,
  org: string,
  userId: string,
  row: Invoice,
  valueEntryId: string,
  amountCents: number,
) {
  if (row.status !== "issued")
    return conflict(
      "invoice_transition_unavailable",
      "Receipts and refunds can be allocated only to an issued invoice.",
    );
  const data = await financial(tx, org, row);
  const value = data.valueMap.get(valueEntryId);
  if (
    !value ||
    value.amountCents - (data.used.get(value.id) ?? 0) < amountCents
  )
    return conflict(
      "invoice_receipt_unavailable",
      "The source entry is unavailable or does not have enough unallocated value.",
    );
  if (
    row.balanceBasis === "opening_receivable" &&
    value.occurredAt <= row.openingAsOf!
  )
    return conflict(
      "invoice_opening_cutoff",
      "Only evidenced receipts/refunds after the opening cutoff can be applied. Prior cash is unknown, not inferred from the opening balance.",
    );
  const totals = money(row, data);
  if (value.kind === "payment" && amountCents > totals.recordedBalanceCents)
    return conflict(
      "invoice_payment_conflict",
      "The allocation exceeds the invoice's recorded balance.",
    );
  if (value.kind === "refund" && amountCents > totals.recordedPaidCents)
    return conflict(
      "invoice_payment_conflict",
      "A recorded refund allocation cannot exceed this invoice's recorded net receipts.",
    );
  if (row.customerWorkId && value.kind==="refund") {
    const paid=data.active.filter(a=>a.invoiceId===row.id && a.kind==="payment" && a.valueEntryId===value.refundOfValueEntryId).reduce((s,a)=>s+a.amountCents,0);
    const returned=data.active.filter(a=>a.invoiceId===row.id && a.kind==="refund" && data.valueMap.get(a.valueEntryId)!.refundOfValueEntryId===value.refundOfValueEntryId).reduce((s,a)=>s+a.amountCents,0);
    if (amountCents>paid-returned) return conflict("invoice_refund_allocation_conflict","This refund exceeds this invoice's remaining allocation from its exact original payment.");
  }
  const [allocation] = await tx
    .insert(allocations)
    .values({
      organizationId: org,
      invoiceId: row.id,
      valueEntryId: value.id,
      kind: value.kind as "payment" | "refund",
      amountCents,
      actorUserId: userId,
    })
    .returning();
  return allocation!;
}
export async function allocateInvoiceValue(
  org: string,
  userId: string,
  id: string,
  raw: unknown,
  effectiveRole?: UserRole,
) {
  const input = invoiceAllocationSchema.parse(raw);
  return mutate(org, userId, id, input, "value_allocated", async (tx, row) => {
    const allocation = await applyValue(
      tx,
      org,
      userId,
      row,
      input.valueEntryId,
      input.amountCents,
    );
    return { row: await advance(tx, org, row), resultId: allocation.id };
  },effectiveRole);
}
export async function recordInvoicePayment(
  org: string,
  userId: string,
  id: string,
  raw: unknown,
  effectiveRole?: UserRole,
  options: { evidence?: "staff_recorded" | "stripe_checkout" } = {},
) {
  const parsed = invoicePaymentSchema.parse(raw);
  const input = {
    ...parsed,
    occurredAt: new Date(parsed.occurredAt).toISOString(),
  };
  return mutate(org, userId, id, input, "payment_recorded", async (tx, row) => {
    if (row.status !== "issued")
      return conflict(
        "invoice_transition_unavailable",
        "Record a receipt only after issuing the invoice.",
      );
    if (
      row.balanceBasis === "opening_receivable" &&
      new Date(input.occurredAt) <= row.openingAsOf!
    )
      return conflict(
        "invoice_opening_cutoff",
        "This receipt predates the opening cutoff. Reconcile it separately; the opening receivable is not cash.",
      );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`value-entry:${org}:${input.sourceReference}`}))`,
    );
    const [existing] = await tx
      .select()
      .from(entries)
      .where(
        and(
          eq(entries.organizationId, org),
          eq(entries.sourceReference, input.sourceReference),
        ),
      );
    if (existing)
      return conflict(
        "invoice_receipt_unavailable",
        "That cash record already exists. Apply its available value instead of recording another receipt.",
      );
    const [entry] = await tx
      .insert(entries)
      .values({
        organizationId: org,
        leadId: row.leadId,
        customerWorkId: row.customerWorkId,
        kind: "payment",
        amountCents: input.amountCents,
        occurredAt: new Date(input.occurredAt),
        sourceReference: input.sourceReference,
        recordedByUserId: userId,
      })
      .returning();
    const allocation = await applyValue(
      tx,
      org,
      userId,
      row,
      entry!.id,
      input.amountCents,
    );
    await tx.insert(auditEventsTable).values({
      organizationId: org,
      actorUserId: userId,
      action: "revenue.value_recorded",
      entityType: "value_entry",
      entityId: entry!.id,
      metadata: {
        leadId: row.leadId,
        ...(row.customerWorkId ? {customerWorkId:row.customerWorkId} : {}),
        invoiceId: row.id,
        kind: "payment",
        evidence: options.evidence ?? "staff_recorded",
        providerEffect: false,
      },
    });
    return { row: await advance(tx, org, row), resultId: allocation.id };
  },effectiveRole, options.evidence === "stripe_checkout");
}
/** Staff records a refund that happened outside GrowthOS; no processor is called. */
export async function recordInvoiceRefund(org:string,userId:string,id:string,raw:unknown,effectiveRole?:UserRole) {
  const parsed=invoiceRefundSchema.parse(raw);
  const input={...parsed,occurredAt:new Date(parsed.occurredAt).toISOString()};
  return mutate(org,userId,id,input,"refund_recorded",async(tx,row)=>{
    if (!row.customerWorkId || row.status!=="issued") return conflict("invoice_transition_unavailable","Record this external refund only against an issued returning-work invoice.");
    const data=await financial(tx,org,row);
    const original=data.valueMap.get(input.originalPaymentValueEntryId);
    if (!original || original.kind!=="payment" || new Date(input.occurredAt)<original.occurredAt) return conflict("invoice_refund_source_unavailable","Choose this work's exact original payment and a refund date no earlier than that receipt.");
    const refunded=data.values.filter(v=>v.kind==="refund" && v.refundOfValueEntryId===original.id).reduce((s,v)=>s+v.amountCents,0);
    if (input.amountCents>original.amountCents-refunded) return conflict("invoice_refund_cash_conflict","Cumulative recorded refunds cannot exceed the exact original cash receipt.");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`value-entry:${org}:${input.sourceReference}`}))`);
    const [existing]=await tx.select({id:entries.id}).from(entries).where(and(eq(entries.organizationId,org),eq(entries.sourceReference,input.sourceReference)));
    if (existing) return conflict("invoice_receipt_unavailable","That cash reference is already recorded. Review its original allocation rather than recording it again.");
    const [entry]=await tx.insert(entries).values({organizationId:org,leadId:null,customerWorkId:row.customerWorkId,kind:"refund",refundOfValueEntryId:original.id,amountCents:input.amountCents,sourceReference:input.sourceReference,occurredAt:new Date(input.occurredAt),recordedByUserId:userId}).returning();
    const allocation=await applyValue(tx,org,userId,row,entry!.id,input.amountCents);
    await tx.insert(auditEventsTable).values({organizationId:org,actorUserId:userId,action:"revenue.value_recorded",entityType:"value_entry",entityId:entry!.id,metadata:{customerWorkId:row.customerWorkId,invoiceId:row.id,originalPaymentValueEntryId:original.id,kind:"refund",evidence:"staff_recorded",providerEffect:false,reason:input.reason}});
    return {row:await advance(tx,org,row),reason:input.reason,resultId:allocation.id};
  },effectiveRole);
}
export async function reverseInvoiceAllocation(
  org: string,
  userId: string,
  id: string,
  allocationId: string,
  raw: unknown,
  effectiveRole?: UserRole,
) {
  const input = { ...reverseInvoiceAllocationSchema.parse(raw), allocationId };
  return mutate(
    org,
    userId,
    id,
    input,
    "allocation_reversed",
    async (tx, row) => {
      if (row.status !== "issued")
        return conflict(
          "invoice_transition_unavailable",
          "Only an issued invoice's allocation can be reversed.",
        );
      const data = await financial(tx, org, row);
      const original = data.active.find(
        (a) => a.id === allocationId && a.invoiceId === row.id,
      );
      if (!original)
        return conflict(
          "invoice_receipt_unavailable",
          "The allocation is unavailable or has already been reversed.",
        );
      if (row.customerWorkId && original.kind==="payment") {
        const remaining=data.active.filter(a=>a.id!==original.id && a.invoiceId===row.id && a.kind==="payment" && a.valueEntryId===original.valueEntryId).reduce((s,a)=>s+a.amountCents,0);
        const returned=data.active.filter(a=>a.invoiceId===row.id && a.kind==="refund" && data.valueMap.get(a.valueEntryId)!.refundOfValueEntryId===original.valueEntryId).reduce((s,a)=>s+a.amountCents,0);
        if (returned>remaining) return conflict("invoice_refund_allocation_conflict","Reconcile the linked refund allocation before reversing its original payment allocation.");
      }
      const totals = money(row, data);
      const nextPaid =
        totals.recordedPaidCents +
        (original.kind === "payment"
          ? -original.amountCents
          : original.amountCents);
      if (
        nextPaid < 0 ||
        nextPaid >
          (row.balanceBasis === "opening_receivable"
            ? row.openingReceivableCents!
            : (row.issuedDocument ?? row.draftDocument).totalCents)
      )
        return conflict(
          "invoice_payment_conflict",
          "Review the other receipt/refund allocations before reversing this one.",
        );
      const [reversal] = await tx
        .insert(allocations)
        .values({
          organizationId: org,
          invoiceId: row.id,
          valueEntryId: original.valueEntryId,
          kind: "reversal",
          amountCents: original.amountCents,
          reversesAllocationId: original.id,
          actorUserId: userId,
          reason: input.reason,
        })
        .returning();
      return {
        row: await advance(tx, org, row),
        reason: input.reason,
        resultId: reversal!.id,
      };
    },
    effectiveRole,
  );
}

/** Internal transaction primitives for the reviewed importer, never an HTTP bypass. */
export const financialMigrationInvoiceTools = {
  budget,
  lock,
  detail,
  applyValue,
  event,
};
