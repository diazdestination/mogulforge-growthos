/** Fictional lineage/command/cash/unknown history; supplied disposable client only. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fixtureIds } from "./restore-drill-fixture.mjs";

const stamp = "2026-10-05T12:00:00.000Z";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
          .join(",")}}`
      : (JSON.stringify(value) ?? "null");
const digest = (value) => sha(canonical(value));
const jsonColumns = new Set([
  "line_items",
  "draft_document",
  "issued_document",
  "metadata",
  "crew_user_ids",
]);
export function returningCustomerIds(slug) {
  assert.ok(
    [
      "restore-drill-contractor-a",
      "restore-drill-contractor-b",
      "preview-returning-work",
    ].includes(slug),
  );
  const names = [
    "contact",
    "property",
    "otherProperty",
    "quoteRoot",
    "jobRoot",
    "invoiceRoot",
    "estimate",
    "project",
    "directProject",
    "invoice",
    "standaloneInvoice",
    "payment",
    "refund",
    "standalonePayment",
    "paymentAllocation",
    "refundAllocation",
    "standaloneAllocation",
    "estimateCreateRequest",
    "estimateAcceptRequest",
    "projectRequest",
    "directJobRequest",
    "task",
    "preview",
    "attempt",
    "execution",
  ];
  return Object.fromEntries(
    names.map((name) => {
      const value = sha(`returning-work-fixture-v1:${slug}:${name}`);
      return [
        name,
        `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`,
      ];
    }),
  );
}
async function insert(database, table, row) {
  assert.match(table, /^[a-z_][a-z0-9_]*$/);
  const keys = Object.keys(row);
  keys.forEach((key) => assert.match(key, /^[a-z_][a-z0-9_]*$/));
  await database.query(
    `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
    keys.map((key) =>
      jsonColumns.has(key) && row[key] !== null
        ? JSON.stringify(row[key])
        : row[key],
    ),
  );
}
export async function seedSyntheticReturningCustomer(
  database,
  { namespace, organizationId: org, actorUserId: actor, preview = false },
) {
  const id = returningCustomerIds(namespace);
  const [company] = (
    await database.query(
      "SELECT o.slug,u.role,u.is_active,u.email_verified_at FROM organizations o JOIN users u ON u.organization_id=o.id WHERE o.id=$1 AND u.id=$2",
      [org, actor],
    )
  ).rows;
  assert.ok(
    company?.is_active && company.email_verified_at && company.role === "owner",
  );
  assert.ok(
    [
      "restore-drill-contractor-a",
      "restore-drill-contractor-b",
      "local-runtime-qa",
    ].includes(company.slug),
  );
  const beforeLeads = Number(
    (
      await database.query(
        "SELECT count(*)::int AS n FROM leads WHERE organization_id=$1",
        [org],
      )
    ).rows[0].n,
  );
  await insert(database, "contacts", {
    id: id.contact,
    organization_id: org,
    first_name: "FICTIONAL",
    last_name: "Returning customer without a lead",
    email: `${namespace}.returning@example.invalid`,
    do_not_contact: true,
    do_not_contact_email: true,
    do_not_contact_sms: true,
    created_at: stamp,
    updated_at: stamp,
  });
  for (const [property, address] of [
    [id.property, "0 FICTIONAL Service Lane"],
    [id.otherProperty, "0 FICTIONAL Second Worksite"],
  ])
    await insert(database, "properties", {
      id: property,
      organization_id: org,
      contact_id: id.contact,
      address_line_1: address,
      city: "Synthetic City",
      state: "GA",
      postal_code: "00000",
      created_at: stamp,
      updated_at: stamp,
    });
  let laterPropertyId = null;
  if (preview) {
    assert.equal(namespace, "preview-returning-work");
    for (let i = 0; i < 28; i++) {
      const value = sha(
          `returning-work-fixture-v1:${namespace}:preview-property-${i}`,
        ),
        property = `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
      await insert(database, "properties", {
        id: property,
        organization_id: org,
        contact_id: id.contact,
        address_line_1: `${i} FICTIONAL Later-page Contractor Worksite with a deliberately long address`,
        city: "Synthetic City",
        state: "GA",
        postal_code: "00000",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: stamp,
      });
      laterPropertyId = property;
    }
  }
  for (const [root, property] of [
    [id.quoteRoot, id.property],
    [id.jobRoot, id.otherProperty],
    [id.invoiceRoot, null],
  ])
    await insert(database, "customer_work_roots", {
      id: root,
      organization_id: org,
      contact_id: id.contact,
      property_id: property,
      created_by_user_id: actor,
      created_at: stamp,
    });
  const estimateInput = {
    requestId: id.estimateCreateRequest,
    confirmed: true,
    source: {
      kind: "existing_customer",
      contactId: id.contact,
      propertyId: id.property,
    },
    title: "FICTIONAL returning work estimate",
    lineItems: [
      {
        description: "Fictional work, not performed or payable",
        quantity: 1,
        unitPriceCents: 20000,
      },
    ],
    taxCents: 0,
    notes: "Synthetic immutable lineage only.",
  };
  await insert(database, "estimates", {
    id: id.estimate,
    organization_id: org,
    lead_id: null,
    customer_work_id: id.quoteRoot,
    work_version: 2,
    title: estimateInput.title,
    status: "accepted",
    line_items: estimateInput.lineItems.map((line) => ({
      ...line,
      totalCents: 20000,
    })),
    subtotal_cents: 20000,
    tax_cents: 0,
    total_cents: 20000,
    notes: estimateInput.notes,
    accepted_at: stamp,
    created_at: stamp,
    updated_at: stamp,
  });
  const projectFields = {
    name: "FICTIONAL returning job",
    status: "completed",
    scheduledStart: null,
    scheduledEnd: null,
    crewUserIds: [],
    crewNotes: "Synthetic original office notes retained.",
  };
  const jobInput = {
    requestId: id.projectRequest,
    confirmed: true,
    source: {
      kind: "estimate",
      estimateId: id.estimate,
      expectedWorkVersion: 2,
    },
    ...projectFields,
  };
  const directInput = {
    requestId: id.directJobRequest,
    confirmed: true,
    source: {
      kind: "existing_customer",
      contactId: id.contact,
      propertyId: id.otherProperty,
    },
    ...projectFields,
    name: "FICTIONAL second separate job",
    status: "scheduled",
  };
  for (const [project, root, estimate, input, version] of [
    [id.project, id.quoteRoot, id.estimate, jobInput, 1],
    [id.directProject, id.jobRoot, null, directInput, 1],
  ])
    await insert(database, "projects", {
      id: project,
      organization_id: org,
      lead_id: null,
      customer_work_id: root,
      work_version: version,
      estimate_id: estimate,
      name: input.name,
      status: input.status,
      crew_user_ids: [],
      crew_notes: input.crewNotes,
      completed_at: input.status === "completed" ? stamp : null,
      created_at: stamp,
      updated_at: stamp,
    });
  const acceptedInput = {
    requestId: id.estimateAcceptRequest,
    confirmed: true,
    expectedWorkVersion: 1,
    title: estimateInput.title,
    lineItems: estimateInput.lineItems,
    taxCents: 0,
    notes: estimateInput.notes,
    status: "accepted",
  };
  for (const [action, input, target, root, version] of [
    ["estimate_created", estimateInput, id.estimate, id.quoteRoot, 1],
    ["estimate_updated", acceptedInput, id.estimate, id.quoteRoot, 2],
    ["project_created", jobInput, id.project, id.quoteRoot, 1],
    ["project_created", directInput, id.directProject, id.jobRoot, 1],
  ])
    await insert(database, "customer_work_commands", {
      organization_id: org,
      request_id: input.requestId,
      actor_user_id: actor,
      action,
      payload_sha256: digest({
        action,
        targetId: action === "estimate_updated" ? target : null,
        input,
        actorUserId: actor,
      }),
      customer_work_id: root,
      estimate_id: action.startsWith("estimate_") ? target : null,
      project_id: action.startsWith("project_") ? target : null,
      result_version: version,
      created_at: stamp,
    });
  for (const [invoice, root, project, estimate, number, total] of [
    [
      id.invoice,
      id.quoteRoot,
      id.project,
      id.estimate,
      "INV-SYNTHETIC-RETURNING-1",
      20000,
    ],
    [
      id.standaloneInvoice,
      id.invoiceRoot,
      null,
      null,
      "INV-SYNTHETIC-RETURNING-2",
      10000,
    ],
  ]) {
    const document = {
      title: "FICTIONAL returning issued document",
      currency: "USD",
      issuerName: "Synthetic contractor",
      issuerAddress: null,
      customerName: "FICTIONAL returning customer",
      customerAddress:
        root === id.quoteRoot ? "0 FICTIONAL Service Lane" : null,
      dueDate: "2026-10-15",
      notes: "Synthetic record, not payable; no external effect.",
      lineItems: [
        {
          description: "FICTIONAL work",
          quantity: "1",
          unitPriceCents: total,
          totalCents: total,
        },
      ],
      subtotalCents: total,
      taxCents: 0,
      totalCents: total,
    };
    await insert(database, "invoices", {
      id: invoice,
      organization_id: org,
      lead_id: null,
      customer_work_id: root,
      project_id: project,
      estimate_id: estimate,
      status: "issued",
      version: 2,
      invoice_number: number,
      draft_document: document,
      issued_document: document,
      issued_document_sha256: sha(JSON.stringify(document)),
      issued_at: stamp,
      created_by_user_id: actor,
      created_at: stamp,
      updated_at: stamp,
    });
    // Seal this NEW fictional capture in the engine's actual JSONB encoding,
    // before the recovery baseline; never rewrite an existing issued record.
    const [captured] = (
      await database.query(
        "SELECT issued_document FROM invoices WHERE id=$1 AND organization_id=$2",
        [invoice, org],
      )
    ).rows;
    await database.query(
      "UPDATE invoices SET issued_document_sha256=$3 WHERE id=$1 AND organization_id=$2",
      [invoice, org, sha(JSON.stringify(captured.issued_document))],
    );
  }
  for (const [value, root, kind, amount, original] of [
    [id.payment, id.quoteRoot, "payment", 10000, null],
    [id.refund, id.quoteRoot, "refund", 1000, id.payment],
    [id.standalonePayment, id.invoiceRoot, "payment", 7000, null],
  ])
    await insert(database, "value_entries", {
      id: value,
      organization_id: org,
      lead_id: null,
      customer_work_id: root,
      refund_of_value_entry_id: original,
      source_reference: `synthetic-returning:${namespace}:${kind}:${value}`,
      kind,
      amount_cents: amount,
      occurred_at: stamp,
      recorded_by_user_id: actor,
      created_at: stamp,
    });
  for (const [allocation, invoice, value, kind, amount] of [
    [id.paymentAllocation, id.invoice, id.payment, "payment", 10000],
    [id.refundAllocation, id.invoice, id.refund, "refund", 1000],
    [
      id.standaloneAllocation,
      id.standaloneInvoice,
      id.standalonePayment,
      "payment",
      7000,
    ],
  ])
    await insert(database, "invoice_receipt_allocations", {
      id: allocation,
      organization_id: org,
      invoice_id: invoice,
      value_entry_id: value,
      kind,
      amount_cents: amount,
      actor_user_id: actor,
      reason:
        kind === "refund"
          ? "FICTIONAL externally recorded refund correction"
          : null,
      created_at: stamp,
    });
  await insert(database, "crm_tasks", {
    id: id.task,
    organization_id: org,
    contact_id: id.contact,
    lead_id: null,
    title: "FICTIONAL native invoice preparation",
    description:
      "Original staff note is retained; a task is not an issued invoice.",
    assigned_user_id: actor,
    status: "done",
    priority: "normal",
    source_event: `project.invoice_preparation:${id.project}`,
    due_at: stamp,
    completed_at: stamp,
    created_at: stamp,
    updated_at: stamp,
  });
  const metadata = {
    reviewVersion: 3,
    payloadSha256: digest({ syntheticOnly: true, invoiceId: id.invoice }),
    expiresAt: "2026-10-05T12:10:00.000Z",
    invoiceVersion: 2,
    documentSha256: null,
    intent: "initial",
    expectedLatestExecutionId: null,
    reason: null,
    duplicateCopyAcknowledged: false,
    context: {
      leadId: null,
      customerWorkId: id.quoteRoot,
      contactId: id.contact,
      propertyId: id.property,
      sourceSha256: digest({ syntheticOnly: true, root: id.quoteRoot }),
      senderIdentitySha256: digest({ syntheticOnly: true, actor }),
      invoiceNumber: "INV-SYNTHETIC-RETURNING-1",
      recipient: `${namespace}.returning@example.invalid`,
      sender: {
        userId: actor,
        source: "company_default",
        provider: "microsoft",
        senderEmail: "synthetic-office@example.invalid",
      },
    },
  };
  const [saved] = (
    await database.query(
      "SELECT issued_document FROM invoices WHERE id=$1 AND organization_id=$2",
      [id.invoice, org],
    )
  ).rows;
  metadata.documentSha256 = digest(saved.issued_document);
  const actionKey = `invoice-delivery:${id.invoice}`,
    fingerprint = digest({
      invoiceId: id.invoice,
      previewId: id.preview,
      payloadSha256: metadata.payloadSha256,
    });
  await insert(database, "audit_events", {
    id: id.preview,
    organization_id: org,
    actor_user_id: actor,
    action: "invoice_delivery.previewed",
    entity_type: "invoice",
    entity_id: id.invoice,
    metadata,
    created_at: stamp,
  });
  await insert(database, "revenue_executions", {
    id: id.execution,
    organization_id: org,
    action_key: actionKey,
    fingerprint,
    kind: "invoice_email",
    state: "indeterminate",
    detail: "SYNTHETIC ONLY: original acknowledgment unknown; never replay.",
    actor_user_id: actor,
    expires_at: stamp,
    completed_at: stamp,
    created_at: stamp,
  });
  await insert(database, "invoice_delivery_attempts", {
    id: id.attempt,
    organization_id: org,
    invoice_id: id.invoice,
    ordinal: 1,
    intent: "initial",
    duplicate_copy_acknowledged: false,
    execution_id: id.execution,
    action_key: actionKey,
    execution_fingerprint: fingerprint,
    actor_user_id: actor,
    preview_id: id.preview,
    payload_sha256: metadata.payloadSha256,
    document_sha256: metadata.documentSha256,
    invoice_version: 2,
    review_sha256: digest(metadata),
    created_at: stamp,
  });
  for (const state of ["processing", "indeterminate"])
    await insert(database, "revenue_execution_events", {
      organization_id: org,
      execution_id: id.execution,
      state,
      detail: "Synthetic retained v3 ownership; no provider configured.",
      actor_user_id: actor,
      created_at: stamp,
    });
  assert.equal(
    Number(
      (
        await database.query(
          "SELECT count(*)::int AS n FROM leads WHERE organization_id=$1",
          [org],
        )
      ).rows[0].n,
    ),
    beforeLeads,
  );
  return { ...id, laterPropertyId };
}
export async function seedReturningCustomerRecovery(database, slug) {
  const legacy = fixtureIds(slug);
  return seedSyntheticReturningCustomer(database, {
    namespace: slug,
    organizationId: legacy.organization,
    actorUserId: legacy.user,
  });
}
export async function assertReturningCustomerRecovery(database, slug) {
  const id = returningCustomerIds(slug),
    legacy = fixtureIds(slug);
  assert.equal(
    (
      await database.query(
        "SELECT count(*)::int AS n FROM leads WHERE contact_id=$1",
        [id.contact],
      )
    ).rows[0].n,
    0,
  );
  const roots = (
    await database.query(
      "SELECT * FROM customer_work_roots WHERE organization_id=$1 AND contact_id=$2 ORDER BY id",
      [legacy.organization, id.contact],
    )
  ).rows;
  assert.equal(roots.length, 3);
  assert.equal(
    roots.find((row) => row.id === id.invoiceRoot).property_id,
    null,
  );
  assert.equal(
    (
      await database.query(
        "SELECT count(*)::int AS n FROM customer_work_commands WHERE organization_id=$1 AND customer_work_id=ANY($2::uuid[])",
        [legacy.organization, roots.map((row) => row.id)],
      )
    ).rows[0].n,
    4,
  );
  const [invoice] = (
    await database.query("SELECT * FROM invoices WHERE id=$1", [id.invoice])
  ).rows;
  assert.equal(invoice.lead_id, null);
  assert.equal(invoice.customer_work_id, id.quoteRoot);
  assert.equal(invoice.project_id, id.project);
  assert.equal(
    invoice.issued_document_sha256,
    sha(JSON.stringify(invoice.issued_document)),
  );
  const values = (
    await database.query(
      "SELECT * FROM value_entries WHERE organization_id=$1 AND customer_work_id=$2 ORDER BY kind",
      [legacy.organization, id.quoteRoot],
    )
  ).rows;
  assert.deepEqual(
    values.map((row) => row.kind),
    ["payment", "refund"],
  );
  assert.equal(values[1].refund_of_value_entry_id, id.payment);
  assert.equal(values[0].amount_cents - values[1].amount_cents, 9000);
  const [attempt] = (
    await database.query(
      "SELECT a.*,r.state,p.metadata FROM invoice_delivery_attempts a JOIN revenue_executions r ON r.id=a.execution_id JOIN audit_events p ON p.id=a.preview_id WHERE a.id=$1",
      [id.attempt],
    )
  ).rows;
  assert.equal(attempt.state, "indeterminate");
  assert.equal(attempt.action_key, `invoice-delivery:${id.invoice}`);
  assert.equal(attempt.review_sha256, digest(attempt.metadata));
  assert.equal(attempt.metadata.reviewVersion, 3);
  assert.equal(attempt.metadata.context.customerWorkId, id.quoteRoot);
  assert.equal(attempt.metadata.context.leadId, null);
  assert.equal(
    (
      await database.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE organization_id=$1 AND entity_id=$2 AND action='invoice_delivery.provider_accepted'",
        [legacy.organization, id.invoice],
      )
    ).rows[0].n,
    0,
  );
}
export async function assertReturningCustomerKeys(database, slug, foreignSlug) {
  const id = returningCustomerIds(slug),
    foreign = returningCustomerIds(foreignSlug),
    legacy = fixtureIds(slug),
    other = fixtureIds(foreignSlug);
  const checks = [
    [
      "UPDATE customer_work_roots SET contact_id=$2 WHERE id=$1",
      [id.quoteRoot, foreign.contact],
      "23503",
    ],
    [
      "UPDATE customer_work_roots SET property_id=$2 WHERE id=$1",
      [id.quoteRoot, foreign.property],
      "23503",
    ],
    [
      "UPDATE customer_work_roots SET created_by_user_id=$2 WHERE id=$1",
      [id.quoteRoot, other.user],
      "23503",
    ],
    [
      "UPDATE estimates SET customer_work_id=NULL WHERE id=$1",
      [id.estimate],
      "23514",
    ],
    [
      "UPDATE estimates SET lead_id=$2 WHERE id=$1",
      [id.estimate, legacy.lead],
      "23514",
    ],
    [
      "UPDATE estimates SET work_version=NULL WHERE id=$1",
      [id.estimate],
      "23514",
    ],
    [
      "UPDATE projects SET customer_work_id=$2 WHERE id=$1",
      [id.directProject, id.quoteRoot],
      "23505",
    ],
    [
      "UPDATE invoices SET customer_work_id=$2 WHERE id=$1",
      [id.invoice, id.invoiceRoot],
      "23503",
    ],
    [
      "UPDATE invoices SET lead_id=$2 WHERE id=$1",
      [id.invoice, legacy.lead],
      "23514",
    ],
    [
      "UPDATE value_entries SET customer_work_id=$2 WHERE id=$1",
      [id.payment, foreign.quoteRoot],
      "23503",
    ],
    [
      "UPDATE value_entries SET refund_of_value_entry_id=NULL WHERE id=$1",
      [id.refund],
      "23514",
    ],
    [
      "UPDATE value_entries SET refund_of_value_entry_id=$2 WHERE id=$1",
      [id.refund, id.standalonePayment],
      "23503",
    ],
    [
      "UPDATE value_entries SET refund_of_value_entry_id=id WHERE id=$1",
      [id.refund],
      "23514",
    ],
    [
      "UPDATE customer_work_commands SET actor_user_id=$2 WHERE request_id=$1",
      [id.projectRequest, other.user],
      "23503",
    ],
    [
      "UPDATE customer_work_commands SET project_id=$2 WHERE request_id=$1",
      [id.projectRequest, id.directProject],
      "23503",
    ],
    [
      "UPDATE customer_work_commands SET result_version=0 WHERE request_id=$1",
      [id.projectRequest],
      "23514",
    ],
  ];
  for (const [text, values, code] of checks) {
    await database.exec("BEGIN");
    try {
      await assert.rejects(
        database.query(text, values),
        (error) => error.code === code,
      );
    } finally {
      await database.exec("ROLLBACK");
    }
  }
  return checks.length;
}
