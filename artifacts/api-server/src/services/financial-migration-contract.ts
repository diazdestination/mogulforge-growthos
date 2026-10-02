import { createHash } from "node:crypto";
import { z } from "zod/v4";
import {
  invoiceDocument,
  invoiceDocumentInputSchema,
  MAX_INVOICE_CENTS,
} from "./invoice-contract";

export class FinancialMigrationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const cents = z.number().int().min(0).max(MAX_INVOICE_CENTS);
const identity = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const sourceKey = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/);
const timestamp = z.iso
  .datetime({ offset: true })
  .transform((v) => new Date(v).toISOString());
const sourceDocument = invoiceDocumentInputSchema.extend({
  lineItems: z
    .array(
      invoiceDocumentInputSchema.shape.lineItems.element.extend({
        totalCents: cents,
      }),
    )
    .min(1)
    .max(100),
  subtotalCents: cents,
  totalCents: cents.min(1),
});
const invoice = z
  .object({
    externalId: identity,
    invoiceNumber: identity,
    leadId: z.uuid(),
    issuedAt: timestamp,
    basis: z.enum(["full_history", "opening_receivable"]),
    balanceAtCutoffCents: cents,
    document: sourceDocument,
  })
  .strict();
const receipt = z
  .object({
    externalId: identity,
    leadId: z.uuid(),
    kind: z.enum(["payment", "refund"]),
    amountCents: cents.min(1),
    occurredAt: timestamp,
    evidence: z.string().trim().min(10).max(500),
    allocations: z
      .array(
        z
          .object({ externalInvoiceId: identity, amountCents: cents.min(1) })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
const totals = z
  .object({
    invoiceCount: z.number().int().min(1).max(50),
    documentTotalCents: z
      .number()
      .int()
      .nonnegative()
      .max(50 * MAX_INVOICE_CENTS),
    openingReceivableCents: z
      .number()
      .int()
      .nonnegative()
      .max(50 * MAX_INVOICE_CENTS),
    balanceDueCents: z
      .number()
      .int()
      .nonnegative()
      .max(50 * MAX_INVOICE_CENTS),
    paymentCents: z
      .number()
      .int()
      .nonnegative()
      .max(200 * MAX_INVOICE_CENTS),
    refundCents: z
      .number()
      .int()
      .nonnegative()
      .max(200 * MAX_INVOICE_CENTS),
  })
  .strict();
export const financialSourceSchema = z
  .object({
    format: z.literal("growthos-financial-migration"),
    version: z.literal(1),
    sourceSystem: sourceKey,
    sourceAccount: sourceKey,
    cutoffAt: timestamp,
    invoices: z.array(invoice).min(1).max(50),
    receipts: z.array(receipt).max(200),
    controlTotals: totals,
  })
  .strict();
export type FinancialSource = z.output<typeof financialSourceSchema>;
export const financialPreviewSchema = z
  .object({ sourceJson: z.string().min(2).max(512_000) })
  .strict();
export const financialCommitSchema = z
  .object({
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    confirmed: z.literal(true),
    sourceFrozen: z.literal(true),
  })
  .strict();
export function financialHash(value: unknown): string {
  const stable = (v: unknown): string =>
    v instanceof Date
      ? JSON.stringify(v.toISOString())
      : Array.isArray(v)
        ? `[${v.map(stable).join(",")}]`
        : v && typeof v === "object"
          ? `{${Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`)
              .join(",")}}`
          : (JSON.stringify(v) ?? "null");
  return createHash("sha256").update(stable(value)).digest("hex");
}
export type MigrationIssue = { path: string; message: string };
export function normalizeFinancialSource(
  sourceJson: string,
  now = new Date(),
):
  | { ok: false; issues: MigrationIssue[] }
  | { ok: true; source: FinancialSource; rawSha256: string } {
  if (Buffer.byteLength(sourceJson) > 512_000)
    return {
      ok: false,
      issues: [
        {
          path: "file",
          message: "Use a normalized file no larger than 512,000 bytes.",
        },
      ],
    };
  let raw: unknown;
  try {
    raw = JSON.parse(sourceJson);
  } catch {
    return {
      ok: false,
      issues: [
        {
          path: "file",
          message: "Supply valid normalized JSON, not a vendor CSV or PDF.",
        },
      ],
    };
  }
  const parsed = financialSourceSchema.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      issues: parsed.error.issues
        .slice(0, 30)
        .map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  const s = parsed.data,
    issues: MigrationIssue[] = [];
  const issue = (path: string, message: string) => {
    if (issues.length < 30) issues.push({ path, message });
  };
  if (Date.parse(s.cutoffAt) > now.getTime())
    issue("cutoffAt", "The financial cutoff cannot be in the future.");
  const invoices = new Map<string, FinancialSource["invoices"][number]>(),
    numbers = new Set<string>();
  for (const [n, row] of s.invoices.entries()) {
    const path = `invoices.${n}`;
    if (invoices.has(row.externalId))
      issue(
        path,
        "Duplicate source invoice ID. Each source identity must occur once.",
      );
    if (numbers.has(row.invoiceNumber))
      issue(
        path,
        "Duplicate original invoice number. Reconcile source numbering first.",
      );
    invoices.set(row.externalId, row);
    numbers.add(row.invoiceNumber);
    if (Date.parse(row.issuedAt) > Date.parse(s.cutoffAt))
      issue(path, "Issued date is after the approved cutoff.");
    try {
      const { subtotalCents, totalCents, lineItems, ...rest } = row.document;
      const computed = invoiceDocument(
        invoiceDocumentInputSchema.parse({
          ...rest,
          lineItems: lineItems.map(({ totalCents: _total, ...line }) => line),
        }),
      );
      if (
        computed.subtotalCents !== subtotalCents ||
        computed.totalCents !== totalCents ||
        computed.lineItems.some(
          (line, i) => line.totalCents !== lineItems[i]!.totalCents,
        )
      )
        issue(
          path,
          "Source lines, exact tax and totals do not reconcile. Discounts, credits and alternative rounding need separate review; do not invent lines.",
        );
      if (row.balanceAtCutoffCents > totalCents)
        issue(path, "Outstanding balance exceeds the original document total.");
      row.document = computed;
    } catch {
      issue(path, "Document exceeds the supported exact-cent invoice model.");
    }
    const nativeNumber = /^INV-(\d+)$/.exec(row.invoiceNumber);
    if (nativeNumber && BigInt(nativeNumber[1]!) >= 2147483646n)
      issue(
        path,
        "Original number exhausts the native numbering range. An explicit numbering policy is required.",
      );
  }
  const receiptIds = new Set<string>(),
    paid = new Map<string, number>(),
    refunded = new Map<string, number>();
  for (const [n, row] of s.receipts.entries()) {
    const path = `receipts.${n}`;
    if (receiptIds.has(row.externalId))
      issue(
        path,
        "Duplicate source receipt ID. Do not clone a shared payment.",
      );
    receiptIds.add(row.externalId);
    if (Date.parse(row.occurredAt) > Date.parse(s.cutoffAt))
      issue(path, "Receipt occurred after the financial cutoff.");
    const allocated = new Set<string>();
    for (const a of row.allocations) {
      const target = invoices.get(a.externalInvoiceId);
      if (allocated.has(a.externalInvoiceId))
        issue(path, "Repeated invoice allocation in one receipt.");
      allocated.add(a.externalInvoiceId);
      if (!target || target.leadId !== row.leadId)
        issue(
          path,
          "Every receipt allocation must identify an included invoice on the same mapped opportunity. Cross-job receipts need reconciliation.",
        );
      else if (target.basis === "opening_receivable")
        issue(
          path,
          "Opening receivables cannot include historical cash. Use one basis only.",
        );
      const map = row.kind === "payment" ? paid : refunded;
      map.set(
        a.externalInvoiceId,
        (map.get(a.externalInvoiceId) ?? 0) + a.amountCents,
      );
    }
    if (
      row.allocations.reduce((sum, a) => sum + a.amountCents, 0) !==
      row.amountCents
    )
      issue(
        path,
        "This slice requires the entire evidenced receipt to be allocated exactly once. Unapplied cash needs separate reconciliation.",
      );
    row.allocations.sort((a, b) =>
      a.externalInvoiceId.localeCompare(b.externalInvoiceId),
    );
  }
  for (const [n, row] of s.invoices.entries()) {
    if (row.basis !== "full_history") continue;
    const p = paid.get(row.externalId) ?? 0,
      r = refunded.get(row.externalId) ?? 0;
    if (
      p > row.document.totalCents ||
      r > p ||
      row.document.totalCents - p + r !== row.balanceAtCutoffCents
    )
      issue(
        `invoices.${n}`,
        "Evidenced receipts/refunds do not reconcile to the source balance. Credits, gross overpayments and write-offs are unsupported; never infer missing cash.",
      );
  }
  const computed = {
    invoiceCount: s.invoices.length,
    documentTotalCents: s.invoices.reduce(
      (n, i) => n + i.document.totalCents,
      0,
    ),
    openingReceivableCents: s.invoices.reduce(
      (n, i) =>
        n + (i.basis === "opening_receivable" ? i.balanceAtCutoffCents : 0),
      0,
    ),
    balanceDueCents: s.invoices.reduce((n, i) => n + i.balanceAtCutoffCents, 0),
    paymentCents: s.receipts
      .filter((r) => r.kind === "payment")
      .reduce((n, r) => n + r.amountCents, 0),
    refundCents: s.receipts
      .filter((r) => r.kind === "refund")
      .reduce((n, r) => n + r.amountCents, 0),
  };
  for (const key of Object.keys(computed) as (keyof typeof computed)[])
    if (computed[key] !== s.controlTotals[key])
      issue(
        `controlTotals.${key}`,
        `Expected ${s.controlTotals[key]} cents/count, but normalized rows reconcile to ${computed[key]}.`,
      );
  if (issues.length) return { ok: false, issues };
  s.invoices.sort((a, b) => a.externalId.localeCompare(b.externalId));
  s.receipts.sort((a, b) => a.externalId.localeCompare(b.externalId));
  return {
    ok: true,
    source: s,
    rawSha256: createHash("sha256").update(sourceJson).digest("hex"),
  };
}
export function migrationItemDigest(source: FinancialSource, row: unknown) {
  return financialHash({
    sourceSystem: source.sourceSystem,
    sourceAccount: source.sourceAccount,
    cutoffAt: source.cutoffAt,
    row,
  });
}
