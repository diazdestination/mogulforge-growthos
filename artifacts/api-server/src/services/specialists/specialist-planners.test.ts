/**
 * Pure planner tests for SCOUT and INVO. The invoice fixtures are SYNTHETIC
 * records shaped like two real, redacted owner-supplied invoices (an HVAC
 * two-repair "upon receipt" invoice and a roofing lump-sum "due on receipt"
 * invoice). No customer data is stored here.
 */
import { describe, expect, it } from "vitest";

import { INVO_POLICY, planInvoice, type InvoFact } from "./invo";
import { SCOUT_CADENCE, planEstimateStep, planStaleLead, type ScoutEstimateFact, type ScoutHistory } from "./scout";

const NOW = new Date("2026-10-11T15:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const LEAD = "00000000-0000-4000-8000-0000000000a1";

/** Synthetic HVAC invoice: two flat-rate repair lines, components listed without part prices. */
function hvacInvoice(extra: Partial<InvoFact> = {}): InvoFact {
  return {
    invoiceId: "00000000-0000-4000-8000-00000000f001", invoiceNumber: null, leadId: LEAD, status: "draft", version: 1,
    document: {
      title: "Synthetic HVAC service", notes: "Terms: upon receipt.", dueDate: null, totalCents: 236_500,
      lineItems: [
        { description: "Standard Repair — synthetic: limit switch, filter drier, refrigerant recharge with leak test and evacuation", quantity: "1", unitPriceCents: 115_000, totalCents: 115_000 },
        { description: "Standard Repair — synthetic: blower belts (2), drain lines (2), coil cleaning (2), bacterial treatment", quantity: "1", unitPriceCents: 121_500, totalCents: 121_500 },
      ],
    },
    issuedAt: null, balanceDueCents: null, paymentState: "unpaid", deliveryAttemptCount: 0,
    warrantyReference: { warrantyObligations: [], activeAssetCount: 0 },
    ...extra,
  };
}

/** Synthetic roofing invoice: one lump-sum line carrying estimate and warranty wording, nothing paid. */
function roofingInvoice(extra: Partial<InvoFact> = {}): InvoFact {
  return {
    invoiceId: "00000000-0000-4000-8000-00000000f002", invoiceNumber: "INV-000042", leadId: LEAD, status: "issued", version: 2,
    document: {
      title: "Synthetic shingle roof replacement",
      notes: "Due on receipt. This shingle estimate includes a manufacturer limited lifetime warranty and 5 year workmanship warranty. Card payments carry a surcharge.",
      dueDate: null, totalCents: 1_105_000,
      lineItems: [{ description: "Architectural shingle system — synthetic full-scope description", quantity: "1", unitPriceCents: 1_105_000, totalCents: 1_105_000 }],
    },
    issuedAt: daysAgo(12), balanceDueCents: 1_105_000, paymentState: "unpaid", deliveryAttemptCount: 1,
    warrantyReference: { warrantyObligations: [], activeAssetCount: 0 },
    ...extra,
  };
}

const rules = (decisions: ReturnType<typeof planInvoice>) =>
  decisions.flatMap((d) => (d.kind === "draft" ? [String(d.draft.evidence.rule)] : []));

describe("INVO planner (synthetic invoices modeled on owner examples)", () => {
  it("HVAC two-repair unsent invoice → office review, and warranty dates when the company requires them", () => {
    const decisions = planInvoice(hvacInvoice(), new Map(), NOW, { warrantyDatesRequired: true });
    expect(rules(decisions).sort()).toEqual(["multi_line_office_review", "warranty_dates_missing"]);
    for (const d of decisions) if (d.kind === "draft") {
      expect(d.draft.actionType).toBe("create_task");
      expect(d.draft).not.toHaveProperty("status");
    }
    // Without the owner requirement and without warranty wording, no warranty task is invented.
    expect(rules(planInvoice(hvacInvoice(), new Map(), NOW, { warrantyDatesRequired: false }))).toEqual(["multi_line_office_review"]);
  });

  it("does not flag warranty dates when the invoice already states a date", () => {
    const fact = hvacInvoice();
    fact.document = { ...fact.document, notes: "Parts warranty valid 2026-10-01 through 2027-10-01." };
    expect(rules(planInvoice(fact, new Map(), NOW, { warrantyDatesRequired: true }))).not.toContain("warranty_dates_missing");
  });

  it("roofing due-on-receipt with full unpaid balance → overdue call and estimate-wording review", () => {
    const decisions = planInvoice(roofingInvoice(), new Map(), NOW, { warrantyDatesRequired: false });
    expect(rules(decisions).sort()).toEqual(["estimate_wording_on_invoice", "overdue_unpaid_balance"]);
    const overdue = decisions.find((d) => d.kind === "draft" && d.draft.evidence.rule === "overdue_unpaid_balance");
    expect(overdue?.kind === "draft" && overdue.draft.evidence).toMatchObject({ dueBasis: "due_on_receipt", daysPastDue: 12, balanceDueCents: 1_105_000 });
    expect(overdue?.kind === "draft" && overdue.draft.estimatedValueCents).toBe(1_105_000);
  });

  it("the same roofing invoice unsent also gets a warranty-date review (warranty wording, no dates)", () => {
    expect(rules(planInvoice(roofingInvoice({ deliveryAttemptCount: 0 }), new Map(), NOW, { warrantyDatesRequired: false })))
      .toContain("warranty_dates_missing");
  });

  it("is not overdue before the policy window, paid in full, or when the balance is unavailable", () => {
    expect(rules(planInvoice(roofingInvoice({ issuedAt: daysAgo(INVO_POLICY.overdueAfterDays - 1) }), new Map(), NOW, { warrantyDatesRequired: false }))).not.toContain("overdue_unpaid_balance");
    expect(rules(planInvoice(roofingInvoice({ balanceDueCents: 0, paymentState: "paid" }), new Map(), NOW, { warrantyDatesRequired: false }))).not.toContain("overdue_unpaid_balance");
    const unavailable = planInvoice(roofingInvoice({ balanceDueCents: null, paymentState: "reconciliation_required" }), new Map(), NOW, { warrantyDatesRequired: false });
    expect(unavailable).toContainEqual(expect.objectContaining({ kind: "skip", reason: "balance_unavailable_or_reconciliation_required" }));
  });

  it("is idempotent against open and settled history, and skips void and customer-work invoices", () => {
    const first = planInvoice(roofingInvoice(), new Map(), NOW, { warrantyDatesRequired: false });
    const history = new Map(first.flatMap((d) => (d.kind === "draft" ? [[d.draft.subjectKey, [{ status: "proposed" as const }]]] : [])));
    expect(rules(planInvoice(roofingInvoice(), history, NOW, { warrantyDatesRequired: false }))).toEqual([]);
    const settled = new Map([...history].map(([k]) => [k, [{ status: "executed" as const }]]));
    // A settled overdue follow-up allows the next weekly bucket only after another full week.
    expect(rules(planInvoice(roofingInvoice(), settled, NOW, { warrantyDatesRequired: false }))).toEqual([]);
    expect(rules(planInvoice(roofingInvoice({ issuedAt: daysAgo(15) }), settled, NOW, { warrantyDatesRequired: false }))).toEqual(["overdue_unpaid_balance"]);
    expect(planInvoice(roofingInvoice({ status: "void" }), new Map(), NOW, { warrantyDatesRequired: true })).toEqual([expect.objectContaining({ kind: "skip", reason: "void" })]);
    expect(planInvoice(roofingInvoice({ leadId: null }), new Map(), NOW, { warrantyDatesRequired: true })[0]).toMatchObject({ kind: "skip", reason: "customer_work_invoice_has_no_lead_queue_scope" });
  });
});

function estimate(extra: Partial<ScoutEstimateFact> = {}): ScoutEstimateFact {
  return {
    estimateId: "00000000-0000-4000-8000-00000000e001", leadId: LEAD, leadStatus: "estimate_sent", estimateTitle: "Synthetic AC replacement",
    totalCents: 900_000, sentAt: hoursAgo(30), contactFirstName: "Pat", contactEmail: "pat@example.test", contactHasPhone: true,
    lastInboundAt: null, replyHold: false, appointmentBooked: false, ...extra,
  };
}
const settledStep = (step: number, at: Date, status: "executed" | "rejected" = "executed"): ScoutHistory =>
  new Map([[`scout:estimate:00000000-0000-4000-8000-00000000e001:step:${step}`, [{ status, evidence: { step }, executedAt: status === "executed" ? at : null, reviewedAt: at, updatedAt: at }]]]);

describe("SCOUT estimate cadence (3 reminders 24h apart, then a call)", () => {
  it("waits 24 hours after sending, then proposes reminder 1 as an email draft", () => {
    expect(planEstimateStep(estimate({ sentAt: hoursAgo(10) }), new Map(), NOW, "Synthetic HVAC")).toMatchObject({ kind: "skip" });
    const step = planEstimateStep(estimate(), new Map(), NOW, "Synthetic HVAC");
    expect(step.kind).toBe("draft");
    if (step.kind !== "draft") return;
    expect(step.draft).toMatchObject({ actionType: "send_email", title: `Estimate reminder 1 of ${SCOUT_CADENCE.reminderCount}` });
    expect(step.draft.evidence).toMatchObject({ rule: "unanswered_estimate_reminder", step: 1, hoursSinceSent: 30 });
  });

  it("uses a staff task when no email is on file", () => {
    const step = planEstimateStep(estimate({ contactEmail: null }), new Map(), NOW, "Synthetic HVAC");
    expect(step.kind === "draft" && step.draft.actionType).toBe("create_task");
  });

  it("advances only after the previous step settles and another 24 hours pass; a rejection counts as staff choice", () => {
    expect(planEstimateStep(estimate({ sentAt: hoursAgo(80) }), settledStep(1, hoursAgo(5)), NOW, "X")).toMatchObject({ kind: "skip" });
    const two = planEstimateStep(estimate({ sentAt: hoursAgo(80) }), settledStep(1, hoursAgo(25)), NOW, "X");
    expect(two.kind === "draft" && two.draft.evidence.step).toBe(2);
    const four = planEstimateStep(estimate({ sentAt: hoursAgo(120) }), settledStep(3, hoursAgo(30), "rejected"), NOW, "X");
    expect(four.kind === "draft" && four.draft).toMatchObject({ actionType: "create_task", title: "Call about unanswered estimate" });
    expect(planEstimateStep(estimate({ sentAt: hoursAgo(200) }), settledStep(4, hoursAgo(30)), NOW, "X")).toMatchObject({ kind: "skip", reason: "cadence_complete" });
  });

  it("never re-proposes past an open or indeterminate step, and stops on any customer response", () => {
    const indeterminate: ScoutHistory = new Map([["scout:estimate:00000000-0000-4000-8000-00000000e001:step:1", [{ status: "indeterminate", evidence: { step: 1 }, executedAt: null, reviewedAt: hoursAgo(40), updatedAt: hoursAgo(40) }]]]);
    expect(planEstimateStep(estimate({ sentAt: hoursAgo(90) }), indeterminate, NOW, "X")).toMatchObject({ kind: "skip", reason: "step_awaiting_review_or_reconciliation" });
    expect(planEstimateStep(estimate({ lastInboundAt: hoursAgo(2) }), new Map(), NOW, "X")).toMatchObject({ kind: "skip", reason: "customer_responded" });
    expect(planEstimateStep(estimate({ replyHold: true }), new Map(), NOW, "X")).toMatchObject({ kind: "skip", reason: "customer_reply_hold" });
    expect(planEstimateStep(estimate({ appointmentBooked: true }), new Map(), NOW, "X")).toMatchObject({ kind: "skip", reason: "appointment_booked" });
    expect(planEstimateStep(estimate({ leadStatus: "won" }), new Map(), NOW, "X")).toMatchObject({ kind: "skip", reason: "lead_moved_on" });
  });
});

describe("SCOUT stale lead rule", () => {
  const base = { leadId: LEAD, leadStatus: "new", hasOpenEstimateCadence: false, importedNeedsReview: false, estimatedValueCents: null };
  it("proposes a follow-up task and a stage change after the quiet window, once per quiet period", () => {
    const decisions = planStaleLead({ ...base, lastCustomerStepAt: daysAgo(9) }, new Map(), NOW);
    expect(decisions.map((d) => d.kind === "draft" && d.draft.actionType)).toEqual(["create_task", "change_stage"]);
    const history: ScoutHistory = new Map(decisions.flatMap((d) => d.kind === "draft" ? [[d.draft.subjectKey, [{ status: "executed" as const, evidence: {}, executedAt: NOW, reviewedAt: NOW, updatedAt: NOW }]]] : []));
    expect(planStaleLead({ ...base, lastCustomerStepAt: daysAgo(9) }, history, NOW).every((d) => d.kind === "skip")).toBe(true);
  });
  it("does not guess an imported date or change an unverified imported stage", () => {
    expect(planStaleLead({ ...base, lastCustomerStepAt: null }, new Map(), NOW)).toEqual([expect.objectContaining({ reason: "no_customer_contact_date" })]);
    expect(planStaleLead({ ...base, importedNeedsReview: true, lastCustomerStepAt: daysAgo(30) }, new Map(), NOW).map((d) => d.kind === "draft" && d.draft.actionType)).toEqual(["create_task"]);
    expect(planStaleLead({ ...base, lastCustomerStepAt: daysAgo(2) }, new Map(), NOW)).toEqual([expect.objectContaining({ reason: "recent_customer_contact" })]);
  });
});
