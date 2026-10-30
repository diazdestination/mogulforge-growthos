import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  appointmentsTable, auditEventsTable, db, propertiesTable, pool,
} from "@workspace/db";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { returningCustomerFixture, returningEstimateDraft, returningProjectDraft } from "../test-helpers/returning-customer-fixture";
import { createPriceBookItem, previewEstimateMargin, updatePriceBookItem } from "./price-book";
import { createCustomerWorkEstimate, createCustomerWorkProject, updateCustomerWorkEstimate } from "./returning-customer";
import { getEstimate, getProject } from "./crm";
import { getSchedulingReviewContext } from "./scheduling-policy";
import { createManualScheduledAppointment } from "./manual-scheduling";
import { getRoutePlan, setGeocoderForTests } from "./route-plan";
import { createInvoice, getInvoice, issueInvoice, recordInvoicePayment } from "./invoices";

// Real services and disposable PostgreSQL only. No provider adapters or HTTP dispatch.
const orgs: string[] = [];
const DAY = "2037-06-15";
beforeAll(() => {
  vi.stubEnv("GROWTHOS_OUTBOUND_HOLD", "true");
});
afterAll(async () => {
  setGeocoderForTests(undefined);
  vi.unstubAllEnvs();
  await deleteTestOrgs(...orgs);
});
async function fixture() {
  const f = await returningCustomerFixture();
  orgs.push(f.org);
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const confirmation = (expectedVersion: number) => ({ requestId: randomUUID(), expectedVersion, confirmed: true as const });
async function counts(org: string) {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM customer_work_roots WHERE organization_id=$1) AS roots,
    (SELECT count(*)::int FROM estimates WHERE organization_id=$1) AS estimates,
    (SELECT count(*)::int FROM projects WHERE organization_id=$1) AS projects,
    (SELECT count(*)::int FROM appointments WHERE organization_id=$1) AS appointments,
    (SELECT count(*)::int FROM invoices WHERE organization_id=$1) AS invoices,
    (SELECT count(*)::int FROM leads WHERE organization_id=$1) AS leads,
    (SELECT count(*)::int FROM value_entries WHERE organization_id=$1) AS receipts,
    (SELECT count(*)::int FROM invoice_receipt_allocations WHERE organization_id=$1) AS allocations`, [org])).rows[0];
}
async function visitCommand(f: Fixture, propertyId: string, hour: number) {
  const actor = { organizationId: f.org, userId: f.owner.id };
  return {
    operationId: randomUUID(), kind: "appointment_create" as const,
    body: {
      contactId: f.contact.id, propertyId, assignedUserId: f.office.id,
      type: "production" as const,
      scheduledStart: `${DAY}T${hour}:00:00.000Z`, scheduledEnd: `${DAY}T${hour}:45:00.000Z`,
    },
    review: {
      context: await getSchedulingReviewContext(actor, {
        sourceKind: "direct_customer", sourceId: f.contact.id, propertyId,
        reservationKind: "appointment", appointmentType: "production",
      }),
      duration: { kind: "explicit" as const, preset: null }, startWallTime: null, endWallTime: null,
    },
  };
}

it("retains exact estimate prices through accepted scheduled job, complete mixed route and issued external-receipt invoice without duplicate work", async () => {
  const f = await fixture();
  const item = await createPriceBookItem(f.org, f.owner.id, {
    trade: "HVAC", name: "Synthetic maintenance labor", unit: "hour",
    unitCostCents: 6000, unitPriceCents: 10000, targetMarginBps: 3500,
  });
  const lines = [{ description: item.name, quantity: 1.25, unitPriceCents: item.unitPriceCents }];
  const margin = await previewEstimateMargin(f.org, { lineItems: [{ ...lines[0], priceBookItemId: item.id }] });
  expect(margin).toMatchObject({ pricedRevenueCents: 12500, pricedCostCents: 7500, pricedMarginCents: 5000, pricedMarginBps: 4000, unpricedLineCount: 0 });
  expect(margin.lines[0]).toMatchObject({ priceBookItemId: item.id, targetMarginBps: 3500, status: "on_target" });

  const draftInput = { ...returningEstimateDraft(f), lineItems: lines, taxCents: 875 };
  const created = await createCustomerWorkEstimate(f.org, f.actor, draftInput);
  expect((await createCustomerWorkEstimate(f.org, f.actor, draftInput)).command.duplicate).toBe(true);
  const estimateId = created.estimate.id, workId = created.estimate.customerWorkId!;
  expect(created.estimate).toMatchObject({ leadId: null, customerWorkId: workId, contactId: f.contact.id, propertyId: f.secondProperty.id, subtotalCents: 12500, taxCents: 875, totalCents: 13375 });
  expect(created.estimate.lineItems).toEqual([{ ...lines[0], totalCents: 12500 }]);
  const { source: _source, ...fields } = draftInput;
  const acceptInput = { ...fields, requestId: randomUUID(), expectedWorkVersion: created.estimate.workVersion!, status: "accepted" as const };
  const accepted = await updateCustomerWorkEstimate(f.org, f.actor, estimateId, acceptInput);
  expect((await updateCustomerWorkEstimate(f.org, f.actor, estimateId, acceptInput)).command.duplicate).toBe(true);

  // Margin guidance is a current-book preview, not a persisted cost snapshot.
  // The agreed estimate's quantities/prices remain historical after book edits.
  await updatePriceBookItem(f.org, f.owner.id, item.id, { unitCostCents: 9000, unitPriceCents: 15000 });
  expect((await previewEstimateMargin(f.org, { lineItems: [{ ...lines[0], priceBookItemId: item.id }] })).pricedMarginBps).toBe(1000);
  expect(await getEstimate(f.org, estimateId)).toMatchObject({ subtotalCents: 12500, totalCents: 13375, lineItems: [{ ...lines[0], totalCents: 12500 }] });
  const schedulingActor = { organizationId: f.org, userId: f.owner.id };
  const jobInput = {
    ...returningProjectDraft(f),
    source: { kind: "estimate" as const, estimateId, expectedWorkVersion: accepted.estimate.workVersion! },
    scheduledStart: `${DAY}T13:00:00.000Z`, scheduledEnd: `${DAY}T13:45:00.000Z`, crewUserIds: [f.office.id],
    schedulingReview: {
      context: await getSchedulingReviewContext(schedulingActor, {
        sourceKind: "direct_customer", sourceId: f.contact.id, propertyId: f.secondProperty.id,
        estimateId, reservationKind: "project",
      }),
      duration: { kind: "explicit" as const, preset: null }, startWallTime: null, endWallTime: null,
    },
  };
  const job = await createCustomerWorkProject(f.org, f.actor, jobInput);
  expect((await createCustomerWorkProject(f.org, f.actor, jobInput)).command.duplicate).toBe(true);
  expect(await getProject(f.org, job.project.id)).toMatchObject({ leadId: null, customerWorkId: workId, estimateId, contactId: f.contact.id, propertyId: f.secondProperty.id, crewUserIds: [f.office.id] });
  await expect(createCustomerWorkProject(f.org, f.actor, { ...jobInput, requestId: randomUUID() })).rejects.toMatchObject({ code: "customer_work_project_exists" });
  // The scheduled job itself is the first route stop; no duplicate visit is needed.
  expect((await getRoutePlan(f.org, f.owner.id, { date: DAY, userId: f.office.id })).stops).toMatchObject([{ kind: "project", projectId: job.project.id, appointmentId: null, propertyId: f.secondProperty.id }]);
  const sameWindow = await createManualScheduledAppointment(schedulingActor, await visitCommand(f, f.secondProperty.id, 13));
  expect(sameWindow.record).toBeNull();
  expect(sameWindow.ack).toMatchObject({ outcome: "no_commit_refused", refusalCode: "resource_conflict" });

  const routeProperties = [];
  const bookedLongitudes = [-84.1, -83.8, -84.0, -83.9];
  for (let index = 0; index < bookedLongitudes.length; index++) {
    const values = { latitude: "34.4", longitude: String(bookedLongitudes[index]) };
    if (index === 0) {
      routeProperties.push((await db.update(propertiesTable).set(values).where(eq(propertiesTable.id, f.secondProperty.id)).returning())[0]!);
    } else {
      routeProperties.push((await db.insert(propertiesTable).values({ ...values, organizationId: f.org, contactId: f.contact.id, addressLine1: `${index + 3} Synthetic Route Lane`, city: "Example", state: "GA", postalCode: "00000" }).returning())[0]!);
    }
  }
  const visitIds: string[] = [`project:${job.project.id}`];
  for (let index = 1; index < routeProperties.length; index++) {
    const input = await visitCommand(f, routeProperties[index]!.id, 13 + index);
    const visit = await createManualScheduledAppointment(schedulingActor, input);
    expect(visit.record).toMatchObject({ contactId: f.contact.id, propertyId: routeProperties[index]!.id, leadId: null, assignedUserId: f.office.id });
    expect(visit.newlyCreated).toBe(true);
    const retry = await createManualScheduledAppointment(schedulingActor, input);
    expect(retry.record?.id).toBe(visit.record!.id);
    expect(retry.newlyCreated).toBe(false);
    visitIds.push(visit.record!.id);
  }
  const geocode = vi.fn(async () => null);
  setGeocoderForTests(geocode);
  const plan = await getRoutePlan(f.org, f.owner.id, { date: DAY, userId: f.office.id });
  expect(plan.currentOrder).toEqual(visitIds);
  expect(plan.stops.map(stop => stop.propertyId)).toEqual(routeProperties.map(property => property.id));
  expect(plan.unlocatedCount).toBe(0);
  expect(plan.suggestedOrder).toEqual([visitIds[0], visitIds[2], visitIds[3], visitIds[1]]);
  expect(plan.savedMiles).toBeGreaterThan(0);
  for (const link of [plan.mapsUrl, plan.suggestedMapsUrl]) {
    expect(link).not.toBeNull();
    const params = new URL(link!).searchParams;
    const addresses = [params.get("origin"), ...(params.get("waypoints")?.split("|") ?? []), params.get("destination")];
    expect(addresses.sort()).toEqual(plan.stops.map(stop => stop.address).sort());
  }
  expect(geocode).not.toHaveBeenCalled();
  expect(await getRoutePlan(f.org, f.owner.id, { date: DAY, userId: f.office.id })).toEqual(plan);

  const invoiceInput = {
    requestId: randomUUID(), source: { kind: "customer_work" as const, customerWorkId: workId }, projectId: job.project.id, estimateId,
    document: {
      title: "Synthetic reviewed maintenance invoice", currency: "USD" as const,
      issuerName: "Synthetic contractor", customerName: "Synthetic Returning Customer",
      customerAddress: f.secondProperty.addressLine1,
      lineItems: accepted.estimate.lineItems.map(line => ({ description: line.description, quantity: String(line.quantity), unitPriceCents: line.unitPriceCents })), taxCents: accepted.estimate.taxCents,
    },
  };
  const invoice = await createInvoice(f.org, f.owner.id, invoiceInput);
  expect((await createInvoice(f.org, f.owner.id, invoiceInput)).duplicate).toBe(true);
  const issueInput = confirmation(invoice.invoice.version);
  const issued = await issueInvoice(f.org, f.owner.id, invoice.invoice.id, issueInput);
  expect((await issueInvoice(f.org, f.owner.id, invoice.invoice.id, issueInput)).duplicate).toBe(true);
  expect(issued.invoice).toMatchObject({ status: "issued", leadId: null, contactId: f.contact.id, propertyId: f.secondProperty.id, customerWorkId: workId, projectId: job.project.id, estimateId, totalCents: 13375, balanceDueCents: 13375, paymentState: "unpaid" });
  expect(issued.invoice.invoiceNumber).toBeTruthy();
  expect(issued.invoice.document.lineItems).toEqual([{ ...lines[0], quantity: "1.25", totalCents: 12500 }]);
  const receiptInput = { ...confirmation(issued.invoice.version), amountCents: 5000, sourceReference: `synthetic-external-receipt-${randomUUID()}`, occurredAt: new Date(Date.now() - 60000).toISOString() };
  const partial = await recordInvoicePayment(f.org, f.owner.id, issued.invoice.id, receiptInput);
  expect(partial.invoice).toMatchObject({ recordedPaidCents: 5000, balanceDueCents: 8375, paymentState: "partial" });
  expect((await recordInvoicePayment(f.org, f.owner.id, issued.invoice.id, receiptInput)).duplicate).toBe(true);
  const final = await recordInvoicePayment(f.org, f.owner.id, issued.invoice.id, { ...receiptInput, ...confirmation(partial.invoice.version), amountCents: 8375, sourceReference: `synthetic-external-final-${randomUUID()}` });
  expect(final.invoice).toMatchObject({ recordedPaidCents: 13375, balanceDueCents: 0, paymentState: "paid" });
  expect(final.invoice.allocations).toHaveLength(2);
  const beforeConflict = await counts(f.org);
  await expect(recordInvoicePayment(f.org, f.owner.id, final.invoice.id, { ...receiptInput, ...confirmation(final.invoice.version) })).rejects.toMatchObject({ code: "invoice_receipt_unavailable" });
  expect(await counts(f.org)).toEqual(beforeConflict);
  expect(beforeConflict).toEqual({ roots: 1, estimates: 1, projects: 1, appointments: 3, invoices: 1, leads: 0, receipts: 2, allocations: 2 });
  const receiptAudits = await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, f.org), eq(auditEventsTable.action, "revenue.value_recorded")));
  expect(receiptAudits).toHaveLength(2);
  for (const audit of receiptAudits) expect(audit.metadata).toMatchObject({ invoiceId: final.invoice.id, customerWorkId: workId, evidence: "staff_recorded", providerEffect: false });
});

it("refuses foreign workflow parents, crew, reads and receipt writes without duplicating records", async () => {
  const f = await fixture(), foreign = await fixture();
  const item = await createPriceBookItem(f.org, f.owner.id, { trade: "HVAC", name: "Synthetic tenant-only scope", unitCostCents: 6000, unitPriceCents: 10000 });
  expect((await previewEstimateMargin(foreign.org, { lineItems: [{ description: item.name, quantity: 1, unitPriceCents: 10000, priceBookItemId: item.id }] })).lines[0]?.status).toBe("no_cost");
  await expect(createCustomerWorkEstimate(f.org, f.actor, { ...returningEstimateDraft(f), source: { kind: "existing_customer", contactId: f.contact.id, propertyId: foreign.firstProperty.id } })).rejects.toMatchObject({ code: "customer_work_parent_mismatch" });
  const saved = await createCustomerWorkEstimate(f.org, f.actor, returningEstimateDraft(f));
  expect(await getEstimate(foreign.org, saved.estimate.id)).toBeNull();
  const before = await counts(f.org);
  await expect(createCustomerWorkProject(f.org, f.actor, { ...returningProjectDraft(f), crewUserIds: [foreign.office.id] })).rejects.toBeDefined();
  await expect(getRoutePlan(foreign.org, foreign.owner.id, { date: DAY, userId: f.office.id })).rejects.toMatchObject({ code: "not_found" });
  const actor = { organizationId: f.org, userId: f.owner.id };
  const command = await visitCommand(f, f.secondProperty.id, 13);
  await expect(createManualScheduledAppointment(actor, { ...command, body: { ...command.body, propertyId: foreign.secondProperty.id } })).rejects.toMatchObject({ code: "invalid_scheduling_context" });
  expect(await counts(f.org)).toEqual(before);
  const invoice = await createInvoice(f.org, f.owner.id, {
    requestId: randomUUID(), source: { kind: "customer_work", customerWorkId: saved.estimate.customerWorkId }, estimateId: saved.estimate.id,
    document: { title: "Synthetic tenant invoice", currency: "USD", issuerName: "Synthetic contractor", customerName: "Synthetic Returning Customer", lineItems: [{ description: "Synthetic scope", quantity: "1", unitPriceCents: 10000 }], taxCents: 0 },
  });
  await expect(getInvoice(foreign.org, foreign.owner.id, invoice.invoice.id)).rejects.toMatchObject({ code: "invoice_not_found" });
  await expect(recordInvoicePayment(foreign.org, foreign.owner.id, invoice.invoice.id, { ...confirmation(1), amountCents: 1000, sourceReference: `synthetic-foreign-${randomUUID()}`, occurredAt: new Date(Date.now() - 1000).toISOString() })).rejects.toMatchObject({ code: "invoice_not_found" });
  expect((await counts(f.org)).receipts).toBe(0);
  expect(await db.select().from(appointmentsTable).where(eq(appointmentsTable.organizationId, foreign.org))).toEqual([]);
});
