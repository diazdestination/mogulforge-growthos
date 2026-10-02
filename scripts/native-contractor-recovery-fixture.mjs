import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { fixtureIds } from "./restore-drill-fixture.mjs";
const stamp = "2026-10-01T10:00:00.000Z";
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function nativeFixtureIds(slug) {
  return Object.fromEntries(
    [
      "invoice",
      "payment",
      "allocation",
      "reversal",
      "operation",
      "request",
      "priorTask",
      "nextTask",
      "priorService",
      "nextService",
    ].map((name) => {
      const hash = createHash("sha256")
        .update(`native-contractor-v1:${slug}:${name}`)
        .digest("hex");
      return [
        name,
        `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
      ];
    }),
  );
}
export function nativeFixtureRows(slug) {
  const id = fixtureIds(slug),
    native = nativeFixtureIds(slug),
    shared = { organization_id: id.organization };
  const document = {
    title: "Synthetic recovery invoice",
    currency: "USD",
    issuerName: "Synthetic contractor",
    issuerAddress: null,
    customerName: "Synthetic homeowner",
    customerAddress: null,
    dueDate: "2026-10-15",
    notes: "Recovery fixture only; not payable.",
    lineItems: [
      {
        description: "Synthetic work",
        quantity: "1",
        unitPriceCents: 10000,
        totalCents: 10000,
      },
    ],
    subtotalCents: 10000,
    taxCents: 0,
    totalCents: 10000,
  };
  const recurrence = {
    mode: "calendar_months",
    intervalMonths: 6,
    anchorDate: "2026-01-31",
    endDate: null,
    agreementNote: "Synthetic agreement; no customer obligation.",
    approvedByUserId: id.user,
    approvedAt: stamp,
  };
  return [
    [
      "invoices",
      {
        ...shared,
        id: native.invoice,
        lead_id: id.lead,
        project_id: id.project,
        estimate_id: id.estimate,
        status: "issued",
        version: 4,
        invoice_number: "INV-000001",
        draft_document: document,
        issued_document: document,
        issued_document_sha256: digest(document),
        issued_at: stamp,
        created_by_user_id: id.user,
      },
    ],
    ["invoice_sequences", { ...shared, next_number: 2 }],
    [
      "value_entries",
      {
        ...shared,
        id: native.payment,
        lead_id: id.lead,
        kind: "payment",
        amount_cents: 4000,
        source_reference: `synthetic-recovery:${slug}:receipt`,
        occurred_at: stamp,
        recorded_by_user_id: id.user,
      },
    ],
    [
      "invoice_receipt_allocations",
      {
        ...shared,
        id: native.allocation,
        invoice_id: native.invoice,
        value_entry_id: native.payment,
        kind: "payment",
        amount_cents: 4000,
        actor_user_id: id.user,
      },
    ],
    [
      "invoice_receipt_allocations",
      {
        ...shared,
        id: native.reversal,
        invoice_id: native.invoice,
        value_entry_id: native.payment,
        kind: "reversal",
        amount_cents: 4000,
        reverses_allocation_id: native.allocation,
        reason: "Synthetic allocation correction; no cash refund.",
        actor_user_id: id.user,
      },
    ],
    [
      "invoice_operations",
      {
        ...shared,
        id: native.operation,
        invoice_id: native.invoice,
        request_id: native.request,
        fingerprint: digest("synthetic-only"),
        action: "reverse_allocation",
        version: 4,
        actor_user_id: id.user,
        result_id: native.reversal,
        reason: "Synthetic recovery history",
      },
    ],
    [
      "crm_tasks",
      {
        ...shared,
        id: native.priorTask,
        contact_id: id.contact,
        title: "Synthetic prior service",
        status: "done",
        completed_at: stamp,
      },
    ],
    [
      "crm_tasks",
      {
        ...shared,
        id: native.nextTask,
        contact_id: id.contact,
        title: "Synthetic next service",
        status: "open",
        due_at: "2026-07-01T12:00:00.000Z",
        assigned_user_id: id.user,
      },
    ],
    [
      "service_obligations",
      {
        ...shared,
        id: native.priorService,
        contact_id: id.contact,
        task_id: native.priorTask,
        kind: "service_plan",
        equipment_label: "Synthetic equipment",
        due_at: "2026-01-31T12:00:00.000Z",
        status: "completed",
        completed_at: stamp,
        completion_note: "Synthetic completed service",
        recurrence,
        coverage_starts_on: "2026-01-01",
        coverage_ends_on: "2027-01-01",
        coverage_evidence: "Synthetic document reference",
      },
    ],
    [
      "service_obligations",
      {
        ...shared,
        id: native.nextService,
        contact_id: id.contact,
        task_id: native.nextTask,
        kind: "service_plan",
        equipment_label: "Synthetic equipment",
        due_at: "2026-07-31T12:00:00.000Z",
        status: "active",
        recurrence,
        predecessor_obligation_id: native.priorService,
        occurrence_index: 1,
      },
    ],
  ];
}
// Match the application: hash the database's normalized JSON representation.
export async function sealNativeFixture(database, slug) {
  const id = nativeFixtureIds(slug);
  const row = (
    await database.query("SELECT issued_document FROM invoices WHERE id=$1", [
      id.invoice,
    ])
  ).rows[0];
  await database.query(
    "UPDATE invoices SET issued_document_sha256=$2 WHERE id=$1",
    [id.invoice, digest(row.issued_document)],
  );
}
export async function assertNativeFixture(database, slug) {
  const id = fixtureIds(slug),
    native = nativeFixtureIds(slug);
  const invoice = (
    await database.query(
      "SELECT * FROM invoices WHERE id=$1 AND organization_id=$2",
      [native.invoice, id.organization],
    )
  ).rows[0];
  assert.equal(invoice.status, "issued");
  assert.equal(invoice.invoice_number, "INV-000001");
  assert.equal(invoice.version, 4);
  assert.equal(invoice.issued_document.totalCents, 10000);
  assert.equal(invoice.issued_document_sha256, digest(invoice.issued_document));
  assert.equal(
    (
      await database.query(
        "SELECT next_number FROM invoice_sequences WHERE organization_id=$1",
        [id.organization],
      )
    ).rows[0].next_number,
    2,
  );
  const cash = (
    await database.query(
      "SELECT kind,amount_cents FROM value_entries WHERE id=$1",
      [native.payment],
    )
  ).rows[0];
  assert.deepEqual(cash, { kind: "payment", amount_cents: 4000 });
  const allocations = (
    await database.query(
      "SELECT kind,reverses_allocation_id FROM invoice_receipt_allocations WHERE invoice_id=$1",
      [native.invoice],
    )
  ).rows;
  assert.equal(allocations.length, 2);
  assert.equal(
    allocations.find((row) => row.kind === "reversal").reverses_allocation_id,
    native.allocation,
  );
  const next = (
    await database.query(
      "SELECT s.predecessor_obligation_id,s.occurrence_index,s.recurrence,s.status AS obligation_status,s.due_at,t.status FROM service_obligations s JOIN crm_tasks t ON t.id=s.task_id WHERE s.id=$1 AND s.organization_id=$2",
      [native.nextService, id.organization],
    )
  ).rows[0];
  assert.equal(next.predecessor_obligation_id, native.priorService);
  assert.equal(next.occurrence_index, 1);
  assert.equal(next.recurrence.intervalMonths, 6);
  assert.equal(next.status, "open");
  assert.equal(next.obligation_status, "active");
  assert.equal(new Date(next.due_at).toISOString(), "2026-07-31T12:00:00.000Z");
  assert.equal(next.recurrence.anchorDate, "2026-01-31");
  assert.equal(next.recurrence.approvedAt, stamp);
}
