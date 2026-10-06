import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  auditEventsTable,
  contactsTable,
  customerLifecycleTable,
  db,
  invoiceSequencesTable,
  invoicesTable,
  leadsTable,
  usersTable,
  valueEntriesTable,
} from "@workspace/db";
import {
  financialMigrationItemsTable as items,
  financialMigrationReviewsTable as reviews,
} from "../../../../lib/db/src/schema/financial-migration";
import { lockContractorSchedule } from "./contractor-scheduling";
import { readNativeWorkLineage } from "./customer-work-lineage";
import { CustomerWorkError } from "./returning-customer-contract";
import { financialMigrationInvoiceTools as invoiceTools } from "./invoices";
import {
  FinancialMigrationError,
  financialCommitSchema,
  financialHash,
  financialPreviewSchema,
  migrationItemDigest,
  normalizeFinancialSource,
  type FinancialSource,
  type MigrationIssue,
} from "./financial-migration-contract";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Review = typeof reviews.$inferSelect;
type Item = typeof items.$inferSelect;
const fail = (code: string, message: string, status = 409): never => {
  throw new FinancialMigrationError(status, code, message);
};
async function manager(tx: Tx, org: string, actor: string, locked = true) {
  const query = tx
    .select({ id: usersTable.id, emailVerifiedAt: usersTable.emailVerifiedAt })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.id, actor),
        eq(usersTable.organizationId, org),
        eq(usersTable.isActive, true),
        inArray(usersTable.role, ["owner", "admin"]),
      ),
    );
  const [user] = await (locked ? query.for("share") : query);
  if (!user || !user.emailVerifiedAt || user.id.startsWith("invite:"))
    fail(
      "financial_manager_required",
      "An active, accepted company owner or administrator must review financial migration.",
      403,
    );
}
async function lockLifecycle(tx: Tx, org: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`customer-lifecycle:${org}`}, 0))`,
  );
}
async function active(tx: Tx, org: string) {
  await lockLifecycle(tx, org);
  const [state] = await tx
    .select()
    .from(customerLifecycleTable)
    .where(eq(customerLifecycleTable.organizationId, org))
    .for("share");
  if (state && state.state !== "active")
    fail(
      "financial_company_held",
      "Financial migration is held while this company is paused or offboarding.",
    );
}
async function context(tx: Tx, org: string, source: FinancialSource) {
  const ids = [...new Set(source.invoices.map((i) => i.leadId))].sort();
  const leads = await tx
    .select({
      id: leadsTable.id,
      contactId: leadsTable.contactId,
      status: leadsTable.status,
      updatedAt: leadsTable.updatedAt,
      creationMethod: leadsTable.creationMethod,
      history: leadsTable.importedHistory,
    })
    .from(leadsTable)
    .where(and(eq(leadsTable.organizationId, org), inArray(leadsTable.id, ids)))
    .orderBy(leadsTable.id)
    .for("share");
  if (leads.length !== ids.length)
    fail(
      "financial_mapping_unavailable",
      "Every invoice must map to an existing opportunity in this company. No customers or opportunities are created by this import.",
    );
  const contactIds = [...new Set(leads.map((l) => l.contactId))].sort();
  const contacts = await tx
    .select({
      id: contactsTable.id,
      firstName: contactsTable.firstName,
      lastName: contactsTable.lastName,
      updatedAt: contactsTable.updatedAt,
    })
    .from(contactsTable)
    .where(
      and(
        eq(contactsTable.organizationId, org),
        inArray(contactsTable.id, contactIds),
      ),
    )
    .orderBy(contactsTable.id)
    .for("share");
  if (contacts.length !== contactIds.length)
    fail(
      "financial_mapping_unavailable",
      "A mapped customer is unavailable in this company.",
    );
  return {
    digest: financialHash({ leads, contacts }),
    mappings: leads.map((l) => ({
      leadId: l.id,
      contactId: l.contactId,
      customerName: [
        contacts.find((c) => c.id === l.contactId)?.firstName,
        contacts.find((c) => c.id === l.contactId)?.lastName,
      ]
        .filter(Boolean)
        .join(" "),
    })),
  };
}
async function priorItems(tx: Tx, org: string, source: FinancialSource) {
  return tx
    .select()
    .from(items)
    .where(
      and(
        eq(items.organizationId, org),
        eq(items.sourceSystem, source.sourceSystem),
        eq(items.sourceAccount, source.sourceAccount),
        inArray(items.externalId, [
          ...source.invoices.map((i) => i.externalId),
          ...source.receipts.map((r) => r.externalId),
        ]),
      ),
    )
    .orderBy(items.id);
}
const findItem = (prior: Item[], type: Item["entityType"], id: string) =>
  prior.find((p) => p.entityType === type && p.externalId === id);
async function inspect(tx: Tx, org: string, source: FinancialSource) {
  const prior = await priorItems(tx, org, source),
    issues: MigrationIssue[] = [];
  for (const [kind, rows] of [
    ["invoice", source.invoices],
    ["receipt", source.receipts],
  ] as const)
    for (const row of rows) {
      const previous = findItem(prior, kind, row.externalId);
      if (previous && previous.digest !== migrationItemDigest(source, row))
        issues.push({
          path: `${kind}:${row.externalId}`,
          message:
            "This source identity was already imported with different content. Reconcile the immutable prior record; a new file or review cannot replace it.",
        });
    }
  const existing = await tx
    .select({ id: invoicesTable.id, number: invoicesTable.invoiceNumber })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.organizationId, org),
        inArray(
          invoicesTable.invoiceNumber,
          source.invoices.map((i) => i.invoiceNumber),
        ),
      ),
    );
  for (const row of source.invoices) {
    const collision = existing.find((i) => i.number === row.invoiceNumber),
      mapped = findItem(prior, "invoice", row.externalId);
    if (collision && collision.id !== mapped?.invoiceId)
      issues.push({
        path: `invoice:${row.externalId}`,
        message:
          "Original invoice number is already used in this company. Resolve source numbering; the importer will not rename or overwrite it.",
      });
    if (mapped && (!collision || collision.id !== mapped.invoiceId))
      issues.push({
        path: `invoice:${row.externalId}`,
        message:
          "The retained source invoice mapping is inconsistent. Operator reconciliation is required.",
      });
  }
  for (const row of source.receipts)
    if (
      !findItem(prior, "receipt", row.externalId) &&
      row.allocations.some((a) =>
        findItem(prior, "invoice", a.externalInvoiceId),
      )
    )
      issues.push({
        path: `receipt:${row.externalId}`,
        message:
          "New historical cash cannot be added to an already imported invoice. Reconcile a later delta as a separate financial event.",
      });
  return {
    prior,
    issues,
    duplicateInvoices: source.invoices.filter((i) =>
      findItem(prior, "invoice", i.externalId),
    ).length,
    duplicateReceipts: source.receipts.filter((r) =>
      findItem(prior, "receipt", r.externalId),
    ).length,
  };
}
function reviewView(row: Review) {
  return {
    id: row.id,
    digest: row.digest,
    rawSha256: row.rawSha256,
    state: row.state,
    source: row.payload.source as FinancialSource,
    mappings: row.payload.mappings,
    duplicateInvoices: row.payload.duplicateInvoices,
    duplicateReceipts: row.payload.duplicateReceipts,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    committedAt: row.committedAt?.toISOString() ?? null,
    result: row.result,
  };
}
async function audit(
  tx: Tx,
  org: string,
  actor: string,
  id: string,
  action: string,
  metadata: Record<string, unknown>,
) {
  await tx.insert(auditEventsTable).values({
    organizationId: org,
    actorUserId: actor,
    entityType: "financial_migration",
    entityId: id,
    action: `financial_migration.${action}`,
    metadata,
  });
}
export async function previewFinancialMigration(
  org: string,
  actor: string,
  raw: unknown,
) {
  const input = financialPreviewSchema.parse(raw);
  return db.transaction(async (tx) => {
    await invoiceTools.budget(tx);
    await manager(tx, org, actor);
    await active(tx, org);
    const normalized = normalizeFinancialSource(input.sourceJson);
    if (!normalized.ok)
      return { valid: false as const, issues: normalized.issues };
    const { source, rawSha256 } = normalized;
    const mapping = await context(tx, org, source),
      checked = await inspect(tx, org, source);
    if (checked.issues.length)
      return { valid: false as const, issues: checked.issues.slice(0, 30) };
    const digest = financialHash({
      version: 1,
      actor,
      org,
      rawSha256,
      source,
      contextDigest: mapping.digest,
    });
    const [row] = await tx
      .insert(reviews)
      .values({
        organizationId: org,
        actorUserId: actor,
        rawSha256,
        digest,
        contextDigest: mapping.digest,
        payload: {
          source,
          mappings: mapping.mappings,
          duplicateInvoices: checked.duplicateInvoices,
          duplicateReceipts: checked.duplicateReceipts,
        },
        expiresAt: new Date(Date.now() + 30 * 60_000),
      })
      .returning();
    await audit(tx, org, actor, row!.id, "previewed", {
      digest,
      rawSha256,
      controlTotals: source.controlTotals,
      effects: false,
    });
    return { valid: true as const, review: reviewView(row!) };
  });
}
export async function listFinancialMigrations(org: string, actor: string) {
  return db.transaction(async (tx) => {
    await invoiceTools.budget(tx);
    await manager(tx, org, actor, false);
    const rows = await tx
      .select({
        id: reviews.id,
        state: reviews.state,
        digest: reviews.digest,
        createdAt: reviews.createdAt,
        committedAt: reviews.committedAt,
      })
      .from(reviews)
      .where(
        and(eq(reviews.organizationId, org), eq(reviews.actorUserId, actor)),
      )
      .orderBy(desc(reviews.createdAt), reviews.id)
      .limit(30);
    return { items: rows, limit: 30 };
  });
}
export async function getFinancialMigration(
  org: string,
  actor: string,
  id: string,
) {
  return db.transaction(async (tx) => {
    await invoiceTools.budget(tx);
    await manager(tx, org, actor, false);
    const [row] = await tx
      .select()
      .from(reviews)
      .where(
        and(
          eq(reviews.id, id),
          eq(reviews.organizationId, org),
          eq(reviews.actorUserId, actor),
        ),
      );
    if (!row)
      fail(
        "financial_review_unavailable",
        "The financial review is unavailable to this owner/admin.",
        404,
      );
    return reviewView(row!);
  });
}
export async function commitFinancialMigration(
  org: string,
  actor: string,
  id: string,
  raw: unknown,
) {
  const input = financialCommitSchema.parse(raw);
  return db.transaction(async (tx) => {
    await invoiceTools.budget(tx);
    // Global order: lifecycle -> schedule -> invoice -> staff/records. Service-watch
    // also takes lifecycle before schedule; native invoice creation starts at schedule.
    await lockLifecycle(tx, org);
    await lockContractorSchedule(tx, org);
    await invoiceTools.lock(tx, org);
    await manager(tx, org, actor);
    const [review] = await tx
      .select()
      .from(reviews)
      .where(
        and(
          eq(reviews.id, id),
          eq(reviews.organizationId, org),
          eq(reviews.actorUserId, actor),
        ),
      )
      .for("update");
    if (!review)
      fail(
        "financial_review_unavailable",
        "The financial review is unavailable to this owner/admin.",
        404,
      );
    if (review!.digest !== input.expectedDigest)
      fail(
        "financial_review_changed",
        "Approve the exact displayed review digest.",
      );
    if (review!.state === "committed") return reviewView(review!);
    await active(tx, org);
    if (review!.expiresAt.getTime() <= Date.now())
      fail(
        "financial_review_expired",
        "This review expired. Prepare and review the source again.",
      );
    const source = review!.payload.source as FinancialSource;
    const validated = normalizeFinancialSource(JSON.stringify(source));
    if (
      !validated.ok ||
      financialHash(validated.source) !== financialHash(source)
    )
      fail(
        "financial_review_corrupt",
        "The saved normalized review no longer validates. No financial records were imported.",
      );
    const mapping = await context(tx, org, source);
    if (
      mapping.digest !== review!.contextDigest ||
      review!.digest !==
        financialHash({
          version: 1,
          actor,
          org,
          rawSha256: review!.rawSha256,
          source,
          contextDigest: mapping.digest,
        })
    )
      fail(
        "financial_mapping_changed",
        "The mapped customer/opportunity or source changed after review. Prepare a fresh review; no local work was replaced.",
      );
    const checked = await inspect(tx, org, source);
    if (checked.issues.length)
      fail("financial_source_conflict", checked.issues[0]!.message);
    // Retain real legacy parent rows through the import. This is a current
    // coherence/locking check only: v1 review context, payload and hashes stay
    // byte-compatible and no property/source is inferred or rewritten.
    for (const leadId of [...new Set(source.invoices.map((record) => record.leadId))].sort()) {
      try {
        await readNativeWorkLineage(tx, org, { leadId, customerWorkId: null }, true);
      } catch (error) {
        if (error instanceof CustomerWorkError) fail("financial_mapping_unavailable", "A mapped opportunity, customer or property changed. Review the original financial source before importing.");
        throw error;
      }
    }
    const target = new Map<string, typeof invoicesTable.$inferSelect>();
    let importedInvoices = 0,
      importedReceipts = 0;
    for (const record of source.invoices) {
      const prior = findItem(checked.prior, "invoice", record.externalId);
      if (prior) {
        const [row] = await tx
          .select()
          .from(invoicesTable)
          .where(
            and(
              eq(invoicesTable.id, prior.invoiceId!),
              eq(invoicesTable.organizationId, org),
            ),
          )
          .for("update");
        if (!row || row.leadId !== record.leadId)
          fail(
            "financial_source_conflict",
            "A retained invoice no longer matches its source relationship.",
          );
        target.set(record.externalId, row!);
        continue;
      }
      const digest = migrationItemDigest(source, record);
      const [draft] = await tx
        .insert(invoicesTable)
        .values({
          organizationId: org,
          leadId: record.leadId,
          createdByUserId: actor,
          draftDocument: record.document,
          balanceBasis: record.basis,
          openingReceivableCents:
            record.basis === "opening_receivable"
              ? record.balanceAtCutoffCents
              : null,
          openingAsOf:
            record.basis === "opening_receivable"
              ? new Date(source.cutoffAt)
              : null,
          historicalSource: {
            sourceSystem: source.sourceSystem,
            sourceAccount: source.sourceAccount,
            externalId: record.externalId,
            cutoffAt: source.cutoffAt,
            recordSha256: digest,
          },
        })
        .returning();
      // Hash the database round-tripped JSONB order, matching native document verification.
      const [row] = await tx
        .update(invoicesTable)
        .set({
          status: "issued",
          invoiceNumber: record.invoiceNumber,
          issuedDocument: draft!.draftDocument,
          issuedDocumentSha256: createHash("sha256")
            .update(JSON.stringify(draft!.draftDocument))
            .digest("hex"),
          issuedAt: new Date(record.issuedAt),
        })
        .where(eq(invoicesTable.id, draft!.id))
        .returning();
      await tx.insert(items).values({
        organizationId: org,
        reviewId: id,
        sourceSystem: source.sourceSystem,
        sourceAccount: source.sourceAccount,
        entityType: "invoice",
        externalId: record.externalId,
        digest,
        invoiceId: row!.id,
      });
      target.set(record.externalId, row!);
      importedInvoices++;
    }
    // Never assign new numbers to historical invoices; reserve any overlapping native sequence.
    const numbers = source.invoices
      .map((i) => /^INV-(\d+)$/.exec(i.invoiceNumber))
      .filter(Boolean)
      .map((m) => Number(m![1]));
    if (numbers.length) {
      await tx
        .insert(invoiceSequencesTable)
        .values({ organizationId: org })
        .onConflictDoNothing();
      const [counter] = await tx
        .select()
        .from(invoiceSequencesTable)
        .where(eq(invoiceSequencesTable.organizationId, org))
        .for("update");
      await tx
        .update(invoiceSequencesTable)
        .set({
          nextNumber: Math.max(
            counter!.nextNumber,
            ...numbers.map((n) => n + 1),
          ),
        })
        .where(eq(invoiceSequencesTable.organizationId, org));
    }
    // Receipt transactions already imported cannot be reused with another allocation set.
    for (const record of [...source.receipts].sort(
      (a, b) => (a.kind === "payment" ? 0 : 1) - (b.kind === "payment" ? 0 : 1),
    )) {
      const prior = findItem(checked.prior, "receipt", record.externalId);
      if (prior) continue;
      if (
        record.allocations.some((a) =>
          findItem(checked.prior, "invoice", a.externalInvoiceId),
        )
      )
        fail(
          "financial_source_conflict",
          "New historical cash cannot be added to an already imported invoice. Reconcile a later delta as a separate reviewed financial event.",
        );
      const reference = `migration:${financialHash({ org, sourceSystem: source.sourceSystem, sourceAccount: source.sourceAccount, externalId: record.externalId })}`;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`value-entry:${org}:${reference}`}))`,
      );
      const [entry] = await tx
        .insert(valueEntriesTable)
        .values({
          organizationId: org,
          leadId: record.leadId,
          kind: record.kind,
          amountCents: record.amountCents,
          occurredAt: new Date(record.occurredAt),
          sourceReference: reference,
          recordedByUserId: actor,
        })
        .returning();
      for (const allocation of record.allocations)
        await invoiceTools.applyValue(
          tx,
          org,
          actor,
          target.get(allocation.externalInvoiceId)!,
          entry!.id,
          allocation.amountCents,
        );
      await tx.insert(items).values({
        organizationId: org,
        reviewId: id,
        sourceSystem: source.sourceSystem,
        sourceAccount: source.sourceAccount,
        entityType: "receipt",
        externalId: record.externalId,
        digest: migrationItemDigest(source, record),
        valueEntryId: entry!.id,
      });
      await audit(tx, org, actor, id, "historical_receipt_recorded", {
        valueEntryId: entry!.id,
        evidence: "source_attested_historical",
        kind: record.kind,
        sourceReference: reference,
        providerEffect: false,
      });
      importedReceipts++;
    }
    const invoiceIds: string[] = [];
    for (const record of source.invoices) {
      const row = target.get(record.externalId)!;
      invoiceIds.push(row.id);
      const detail = await invoiceTools.detail(tx, org, row);
      if (!findItem(checked.prior, "invoice", record.externalId)) {
        if (
          detail.recordedBalanceCents !== record.balanceAtCutoffCents ||
          detail.reconciliationRequired
        )
          fail(
            "financial_reconciliation_failed",
            "Saved balances or unallocated refunds do not reconcile exactly. The entire commit was rolled back.",
          );
        await invoiceTools.event(
          tx,
          org,
          actor,
          row,
          randomUUID(),
          migrationItemDigest(source, record),
          "historical_imported",
          "Original source document and date retained; no issuance, sending or money movement performed.",
        );
      }
    }
    const result = {
      importedInvoices,
      importedReceipts,
      duplicateInvoices: checked.duplicateInvoices,
      duplicateReceipts: checked.duplicateReceipts,
      invoiceIds,
      controlTotals: source.controlTotals,
      providerEffect: false,
      sourceFrozen: true,
      historicalPaymentsInferred: false,
    };
    await audit(tx, org, actor, id, "committed", {
      digest: review!.digest,
      ...result,
    });
    const [saved] = await tx
      .update(reviews)
      .set({ state: "committed", result, committedAt: new Date() })
      .where(eq(reviews.id, id))
      .returning();
    return reviewView(saved!);
  });
}
