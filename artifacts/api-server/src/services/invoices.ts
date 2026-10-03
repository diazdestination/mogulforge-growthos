import { createHash } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  auditEventsTable,
  activitiesTable,
  contactsTable,
  crmTasksTable,
  db,
  estimatesTable,
  invoiceOperationsTable as operations,
  invoiceReceiptAllocationsTable as allocations,
  invoiceSequencesTable as sequences,
  invoicesTable as invoices,
  leadsTable,
  projectsTable,
  usersTable,
  valueEntriesTable as entries,
} from "@workspace/db";
import { hasPermission } from "../lib/permissions";
import { lockContractorSchedule } from "./contractor-scheduling";
import {
  createInvoiceSchema,
  invoiceAllocationSchema,
  invoiceDocument,
  InvoiceError,
  invoiceListSchema,
  invoicePaymentSchema,
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
    !hasPermission(user.role, manage ? "invoices.manage" : "invoices.read")
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
    leadId: string;
    projectId?: string | null;
    estimateId?: string | null;
  },
  creating = false,
) {
  const [lead] = await reader
    .select({ id: leadsTable.id, contactId: leadsTable.contactId })
    .from(leadsTable)
    .where(
      and(eq(leadsTable.id, refs.leadId), eq(leadsTable.organizationId, org)),
    );
  if (!lead) return absent();
  const [contact] = await reader
    .select({ id: contactsTable.id })
    .from(contactsTable)
    .where(
      and(
        eq(contactsTable.id, lead.contactId),
        eq(contactsTable.organizationId, org),
      ),
    );
  if (!contact) return absent();
  let estimateId = refs.estimateId ?? null;
  if (refs.projectId) {
    const [project] = await reader
      .select()
      .from(projectsTable)
      .where(
        and(
          eq(projectsTable.id, refs.projectId),
          eq(projectsTable.organizationId, org),
        ),
      );
    if (!project || project.leadId !== lead.id) return absent();
    if (
      creating &&
      estimateId &&
      project.estimateId &&
      estimateId !== project.estimateId
    )
      return absent();
    if (creating) estimateId ??= project.estimateId;
  }
  if (estimateId) {
    const [estimate] = await reader
      .select({ id: estimatesTable.id, leadId: estimatesTable.leadId })
      .from(estimatesTable)
      .where(
        and(
          eq(estimatesTable.id, estimateId),
          eq(estimatesTable.organizationId, org),
        ),
      );
    if (!estimate || estimate.leadId !== lead.id) return absent();
  }
  return { lead, estimateId };
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
  await related(reader, org, row);
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
async function financial(reader: Reader, org: string, leadId: string) {
  const values = await reader
    .select()
    .from(entries)
    .where(
      and(
        eq(entries.organizationId, org),
        eq(entries.leadId, leadId),
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
      },
    })
    .from(allocations)
    .innerJoin(invoices, eq(invoices.id, allocations.invoiceId))
    .where(
      or(
        and(
          eq(invoices.leadId, leadId),
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
      owner.leadId !== leadId ||
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
function summary(row: Invoice, data: Financial): InvoiceSummary {
  const doc = checkedDocument(row);
  return {
    id: row.id,
    leadId: row.leadId,
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
  const data = await financial(reader, org, row.leadId);
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
    ...summary(row, data),
    document: row.issuedDocument ?? row.draftDocument,
    allocations: data.applied
      .filter((a) => a.invoiceId === row.id && a.kind !== "reversal")
      .map((a) => {
        const value = data.valueMap.get(a.valueEntryId)!;
        const reversal = data.reversed.get(a.id);
        return {
          id: a.id,
          valueEntryId: value.id,
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
): Promise<InvoiceList> {
  const filter = invoiceListSchema.parse(raw);
  return db.transaction(
    async (tx) => {
      await budget(tx);
      await actor(tx, org, userId, false);
      const where = and(
        eq(invoices.organizationId, org),
        filter.status ? eq(invoices.status, filter.status) : undefined,
        filter.leadId ? eq(invoices.leadId, filter.leadId) : undefined,
        filter.projectId ? eq(invoices.projectId, filter.projectId) : undefined,
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
        await related(tx, org, row);
        if (!cache.has(row.leadId))
          cache.set(row.leadId, await financial(tx, org, row.leadId));
        items.push(summary(row, cache.get(row.leadId)!));
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
): Promise<InvoiceDetail> {
  return db.transaction(
    async (tx) => {
      await budget(tx);
      await actor(tx, org, userId, false);
      return detail(tx, org, await load(tx, org, id));
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

async function replay(
  tx: Tx,
  org: string,
  requestId: string,
  hash: string,
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
  return {
    invoice: await detail(tx, org, await load(tx, org, prior.invoiceId)),
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
    actorUserId: userId,
    type: "invoice_event",
    title: `Invoice ${action.replaceAll("_", " ")}`,
    metadata: {
      invoiceId: row.id,
      version: row.version,
      invoiceNumber: row.invoiceNumber,
      providerEffect: false,
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
): Promise<InvoiceMutation> {
  const hash = fingerprint({ action, id, input });
  return db.transaction(async (tx) => {
    await budget(tx);
    await lock(tx, org);
    await actor(tx, org, userId, true);
    const prior = await replay(tx, org, input.requestId, hash);
    if (prior) return prior;
    const row = await load(tx, org, id, true);
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
    // CRM merge/delete retention checks use this lock even without a project.
    // Keep it first so references cannot move after their retention check.
    await lockContractorSchedule(tx, org);
    await lock(tx, org);
    await actor(tx, org, userId, true);
    const prior = await replay(tx, org, input.requestId, hash);
    if (prior) return prior;
    const refs = await related(tx, org, input, true);
    const [row] = await tx
      .insert(invoices)
      .values({
        organizationId: org,
        leadId: input.leadId,
        projectId: input.projectId,
        estimateId: refs.estimateId,
        draftDocument: input.document,
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
            eq(crmTasksTable.leadId, input.leadId),
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
) {
  const parsed = updateInvoiceSchema.parse(raw);
  const input = { ...parsed, document: invoiceDocument(parsed.document) };
  return mutate(org, userId, id, input, "draft_updated", async (tx, row) => {
    if (row.status !== "draft")
      return conflict(
        "invoice_transition_unavailable",
        "Only a draft invoice can be edited. Issued documents are retained unchanged.",
      );
    return {
      row: await advance(tx, org, row, { draftDocument: input.document }),
    };
  });
}
export async function issueInvoice(
  org: string,
  userId: string,
  id: string,
  raw: unknown,
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
  });
}
export async function voidInvoice(
  org: string,
  userId: string,
  id: string,
  raw: unknown,
) {
  const input = voidInvoiceSchema.parse(raw);
  return mutate(org, userId, id, input, "voided", async (tx, row) => {
    if (row.status === "void")
      return conflict(
        "invoice_transition_unavailable",
        "This invoice is already void.",
      );
    if (
      money(row, await financial(tx, org, row.leadId)).recordedPaidCents !== 0
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
  });
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
  const data = await financial(tx, org, row.leadId);
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
  });
}
export async function recordInvoicePayment(
  org: string,
  userId: string,
  id: string,
  raw: unknown,
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
        invoiceId: row.id,
        kind: "payment",
        evidence: "staff_recorded",
        providerEffect: false,
      },
    });
    return { row: await advance(tx, org, row), resultId: allocation.id };
  });
}
export async function reverseInvoiceAllocation(
  org: string,
  userId: string,
  id: string,
  allocationId: string,
  raw: unknown,
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
      const data = await financial(tx, org, row.leadId);
      const original = data.active.find(
        (a) => a.id === allocationId && a.invoiceId === row.id,
      );
      if (!original)
        return conflict(
          "invoice_receipt_unavailable",
          "The allocation is unavailable or has already been reversed.",
        );
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
