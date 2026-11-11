import { randomUUID } from "node:crypto";
import {
  activitiesTable,
  auditEventsTable,
  contactsTable,
  crmTasksTable,
  customerLifecycleTable,
  customerWorkCommandsTable,
  db,
  estimateApprovalsTable,
  estimatesTable,
  leadsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { returningCustomerFixture, returningEstimateDraft } from "../test-helpers/returning-customer-fixture";
import { createCustomerWorkEstimate, updateCustomerWorkEstimate } from "./returning-customer";
import { createEstimate, deleteEstimate, updateEstimate } from "./crm";
import {
  approveEstimate,
  createEstimateApprovalLink,
  declineEstimate,
  ESTIMATE_APPROVAL_CONSENT_TEXT,
  estimateApprovalToken,
  getEstimateApprovalStatus,
  getPublicEstimateApproval,
  renderEstimateApprovalRecord,
  revokeEstimateApprovalLink,
  validateSignatureDataUrl,
} from "./estimate-approvals";

export const SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const META = { ip: "203.0.113.7", userAgent: "Synthetic Browser/1.0" };

const orgs: string[] = [];
afterAll(async () => {
  await deleteTestOrgs(...orgs);
});

async function fixture() {
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: "Synthetic Approval Roofing", slug: `test-est-approval-${randomUUID()}` })
    .returning();
  orgs.push(org!.id);
  const [owner] = await db.insert(usersTable).values({ organizationId: org!.id, role: "owner", emailVerifiedAt: new Date() }).returning();
  const [contact] = await db.insert(contactsTable).values({ organizationId: org!.id, firstName: "Dana", lastName: "Reyes", phone: "+14045550142" }).returning();
  const [lead] = await db.insert(leadsTable).values({ organizationId: org!.id, contactId: contact!.id, assignedUserId: owner!.id }).returning();
  const estimate = await createEstimate(
    org!.id,
    { leadId: lead!.id, title: "Roof replacement", status: "sent", lineItems: [{ description: "Architectural shingles", quantity: 20, unitPriceCents: 45000, totalCents: 0 }], taxCents: 1000, notes: "Includes tear-off." },
    { userId: owner!.id },
  );
  return { orgId: org!.id, owner: owner!, contact: contact!, lead: lead!, estimate: estimate! };
}

const tokenOf = (url: string) => url.split("/approve/")[1]!;

describe("estimate approval links", () => {
  it("creates one reusable link with a frozen snapshot and stores only the token hash", async () => {
    const f = await fixture();
    const first = await createEstimateApprovalLink(f.orgId, f.estimate.id, f.owner.id);
    expect(first.reused).toBe(false);
    expect(first.url).toMatch(/\/approve\/[A-Za-z0-9_-]{43}$/);
    const again = await createEstimateApprovalLink(f.orgId, f.estimate.id, f.owner.id);
    expect(again.reused).toBe(true);
    expect(again.url).toBe(first.url);
    const [row] = await db.select().from(estimateApprovalsTable).where(eq(estimateApprovalsTable.estimateId, f.estimate.id));
    expect(row!.tokenHash).not.toContain(tokenOf(first.url));
    expect(JSON.stringify(row)).not.toContain(tokenOf(first.url));
    expect(row!.snapshot).toMatchObject({ companyName: "Synthetic Approval Roofing", customerName: "Dana Reyes", title: "Roof replacement", totalCents: 901000 });
    expect(row!.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);

    const view = await getPublicEstimateApproval(tokenOf(first.url));
    expect(view).toMatchObject({ state: "waiting", companyName: "Synthetic Approval Roofing", consentText: ESTIMATE_APPROVAL_CONSENT_TEXT });
    expect(view!.estimate!.lineItems[0]).toMatchObject({ description: "Architectural shingles", totalCents: 900000 });
    expect(await getPublicEstimateApproval("x".repeat(43))).toBeNull();
    expect(await getPublicEstimateApproval("short")).toBeNull();
  });

  it("approves once in one transaction: signature, accepted status, audit, activity and task", async () => {
    const f = await fixture();
    const { url } = await createEstimateApprovalLink(f.orgId, f.estimate.id, f.owner.id);
    const result = await approveEstimate(tokenOf(url), { signerName: "  Dana   Reyes ", signatureDataUrl: SIGNATURE, consent: true }, META);
    expect(result).toMatchObject({ state: "approved", signerName: "Dana Reyes" });

    const [estimate] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, f.estimate.id));
    expect(estimate!.status).toBe("accepted");
    expect(estimate!.acceptedAt).not.toBeNull();
    const [row] = await db.select().from(estimateApprovalsTable).where(eq(estimateApprovalsTable.estimateId, f.estimate.id));
    expect(row).toMatchObject({ decision: "approved", signerName: "Dana Reyes", signatureDataUrl: SIGNATURE, signerIp: "203.0.113.7", signerUserAgent: "Synthetic Browser/1.0", consentText: ESTIMATE_APPROVAL_CONSENT_TEXT });
    const audits = await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.organizationId, f.orgId), eq(auditEventsTable.entityId, f.estimate.id)));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["estimate.approval_link_created", "estimate.status_changed", "estimate.customer_approved"]));
    const [activity] = await db.select().from(activitiesTable).where(and(eq(activitiesTable.organizationId, f.orgId), eq(activitiesTable.type, "estimate_approved")));
    expect(activity).toMatchObject({ leadId: f.lead.id, contactId: f.contact.id });
    const [task] = await db.select().from(crmTasksTable).where(and(eq(crmTasksTable.organizationId, f.orgId), eq(crmTasksTable.sourceEvent, `estimate.approved:${f.estimate.id}`)));
    expect(task).toMatchObject({ title: "Estimate approved — schedule the work", assignedUserId: f.owner.id, leadId: f.lead.id });

    // A second approval (or a decline) is refused and changes nothing.
    await expect(approveEstimate(tokenOf(url), { signerName: "Someone Else", signatureDataUrl: SIGNATURE, consent: true }, META)).rejects.toMatchObject({ code: "estimate_approval_already_decided" });
    await expect(declineEstimate(tokenOf(url), { reason: "changed mind" }, META)).rejects.toMatchObject({ code: "estimate_approval_already_decided" });
    expect((await db.select().from(crmTasksTable).where(eq(crmTasksTable.sourceEvent, `estimate.approved:${f.estimate.id}`))).length).toBe(1);
    expect(await getPublicEstimateApproval(tokenOf(url))).toMatchObject({ state: "approved", signerName: "Dana Reyes" });

    const status = await getEstimateApprovalStatus(f.orgId, f.estimate.id);
    expect(status).toMatchObject({ eligible: false, approval: { state: "approved", signerName: "Dana Reyes", signatureDataUrl: SIGNATURE } });
    const html = await renderEstimateApprovalRecord(f.orgId, f.estimate.id);
    expect(html).toContain("Dana Reyes");
    expect(html).toContain("203.0.113.7");
    expect(html).toContain(SIGNATURE);
    expect(html).toContain("$9,010.00");
    // Signed evidence keeps the estimate from being deleted.
    await expect(deleteEstimate(f.orgId, f.estimate.id)).rejects.toMatchObject({ code: "estimate_approval_retained" });
    await expect(createEstimateApprovalLink(f.orgId, f.estimate.id, f.owner.id)).rejects.toMatchObject({ code: "estimate_already_decided" });
  });

  it("serializes concurrent approvals so exactly one signature is recorded", async () => {
    const f = await fixture();
    const { url } = await createEstimateApprovalLink(f.orgId, f.estimate.id, f.owner.id);
    const results = await Promise.allSettled([
      approveEstimate(tokenOf(url), { signerName: "Dana Reyes", signatureDataUrl: SIGNATURE, consent: true }, META),
      approveEstimate(tokenOf(url), { signerName: "Dana Reyes", signatureDataUrl: SIGNATURE, consent: true }, META),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "estimate_approval_already_decided" } });
    expect((await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.entityId, f.estimate.id), eq(auditEventsTable.action, "estimate.customer_approved")))).length).toBe(1);
  });

  it("refuses an outdated link after the estimate changes, and a new link replaces it", async () => {
    const f = await fixture();
    const old = await createEstimateApprovalLink(f.orgId, f.estimate.id, f.owner.id);
    await updateEstimate(f.orgId, f.estimate.id, { lineItems: [{ description: "Architectural shingles", quantity: 22, unitPriceCents: 45000 }] as never }, { userId: f.owner.id });
    expect(await getPublicEstimateApproval(tokenOf(old.url))).toMatchObject({ state: "outdated", estimate: null });
    await expect(approveEstimate(tokenOf(old.url), { signerName: "Dana Reyes", signatureDataUrl: SIGNATURE, consent: true }, META)).rejects.toMatchObject({ code: "estimate_approval_outdated" });
    expect((await getEstimateApprovalStatus(f.orgId, f.estimate.id)).approval?.state).toBe("outdated");

    const fresh = await createEstimateApprovalLink(f.orgId, f.estimate.id, f.owner.id);
    expect(fresh.reused).toBe(false);
    expect(fresh.url).not.toBe(old.url);
    expect(await getPublicEstimateApproval(tokenOf(old.url))).toMatchObject({ state: "revoked" });
    const view = await getPublicEstimateApproval(tokenOf(fresh.url));
    expect(view).toMatchObject({ state: "waiting", estimate: { totalCents: 991000 } });
    await approveEstimate(tokenOf(fresh.url), { signerName: "Dana Reyes", signatureDataUrl: SIGNATURE, consent: true }, META);
    expect((await db.select().from(estimatesTable).where(eq(estimatesTable.id, f.estimate.id)))[0]!.status).toBe("accepted");
  });

  it("refuses expired and revoked links", async () => {
    const f = await fixture();
    const expired = await createEstimateApprovalLink(f.orgId, f.estimate.id, f.owner.id);
    await db.update(estimateApprovalsTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(estimateApprovalsTable.estimateId, f.estimate.id));
    expect(await getPublicEstimateApproval(tokenOf(expired.url))).toMatchObject({ state: "expired", estimate: null });
    await expect(approveEstimate(tokenOf(expired.url), { signerName: "Dana Reyes", signatureDataUrl: SIGNATURE, consent: true }, META)).rejects.toMatchObject({ code: "estimate_approval_expired" });

    const renewed = await createEstimateApprovalLink(f.orgId, f.estimate.id, f.owner.id);
    expect(renewed.reused).toBe(false);
    await revokeEstimateApprovalLink(f.orgId, f.estimate.id, f.owner.id);
    expect(await getPublicEstimateApproval(tokenOf(renewed.url))).toMatchObject({ state: "revoked", estimate: null });
    await expect(declineEstimate(tokenOf(renewed.url), {}, META)).rejects.toMatchObject({ code: "estimate_approval_revoked" });
    await expect(revokeEstimateApprovalLink(f.orgId, f.estimate.id, f.owner.id)).rejects.toMatchObject({ code: "estimate_approval_not_open" });
    expect((await db.select().from(estimatesTable).where(eq(estimatesTable.id, f.estimate.id)))[0]!.status).toBe("sent");
    // Undecided links do not block deleting the estimate.
    expect(await deleteEstimate(f.orgId, f.estimate.id)).toBe(true);
  });

  it("records a decline with its reason, audit and follow-up task", async () => {
    const f = await fixture();
    const { url } = await createEstimateApprovalLink(f.orgId, f.estimate.id, f.owner.id);
    expect(await declineEstimate(tokenOf(url), { reason: "Going with a cheaper bid" }, META)).toMatchObject({ state: "declined" });
    const [estimate] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, f.estimate.id));
    expect(estimate!.status).toBe("declined");
    const [row] = await db.select().from(estimateApprovalsTable).where(eq(estimateApprovalsTable.estimateId, f.estimate.id));
    expect(row).toMatchObject({ decision: "declined", declineReason: "Going with a cheaper bid", signatureDataUrl: null });
    const audits = await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.entityId, f.estimate.id), eq(auditEventsTable.action, "estimate.customer_declined")));
    expect(audits).toHaveLength(1);
    const [task] = await db.select().from(crmTasksTable).where(eq(crmTasksTable.sourceEvent, `estimate.declined:${f.estimate.id}`));
    expect(task!.description).toContain("Going with a cheaper bid");
    expect(await renderEstimateApprovalRecord(f.orgId, f.estimate.id)).toContain("Customer declined");
  });

  it("validates name, consent and the drawn signature", async () => {
    const f = await fixture();
    const { url } = await createEstimateApprovalLink(f.orgId, f.estimate.id, f.owner.id);
    const token = tokenOf(url);
    await expect(approveEstimate(token, { signerName: "D", signatureDataUrl: SIGNATURE, consent: true }, META)).rejects.toMatchObject({ code: "estimate_approval_invalid_name" });
    await expect(approveEstimate(token, { signerName: "Dana Reyes", signatureDataUrl: SIGNATURE, consent: false }, META)).rejects.toMatchObject({ code: "estimate_approval_consent_required" });
    await expect(approveEstimate(token, { signerName: "Dana Reyes", signatureDataUrl: "data:image/svg+xml;base64,PHN2Zz4=", consent: true }, META)).rejects.toMatchObject({ code: "estimate_approval_invalid_signature" });
    expect(() => validateSignatureDataUrl(`data:image/png;base64,${"A".repeat(200_001)}`)).toThrow();
    expect(() => validateSignatureDataUrl("data:image/png;base64,aGVsbG8gd29ybGQgdGhpcyBpcyBub3QgYSBwbmcgYXQgYWxsIGJ1dCBpdCBpcyBsb25nIGVub3VnaCB0byBwYXNzIHRoZSBsZW5ndGg=")).toThrow();
    expect((await db.select().from(estimatesTable).where(eq(estimatesTable.id, f.estimate.id)))[0]!.status).toBe("sent");
  });

  it("refuses approval while the company is paused", async () => {
    const f = await fixture();
    const { url } = await createEstimateApprovalLink(f.orgId, f.estimate.id, f.owner.id);
    await db.insert(customerLifecycleTable).values({ organizationId: f.orgId, state: "paused", version: 2, reason: "Synthetic hold", updatedByUserId: f.owner.id });
    await expect(approveEstimate(tokenOf(url), { signerName: "Dana Reyes", signatureDataUrl: SIGNATURE, consent: true }, META)).rejects.toMatchObject({ code: "customer_lifecycle_paused" });
  });

  it("keeps companies isolated", async () => {
    const a = await fixture();
    const b = await fixture();
    const { url } = await createEstimateApprovalLink(a.orgId, a.estimate.id, a.owner.id);
    await expect(createEstimateApprovalLink(b.orgId, a.estimate.id, b.owner.id)).rejects.toMatchObject({ code: "estimate_not_found" });
    await expect(getEstimateApprovalStatus(b.orgId, a.estimate.id)).rejects.toMatchObject({ code: "estimate_not_found" });
    await expect(revokeEstimateApprovalLink(b.orgId, a.estimate.id, b.owner.id)).rejects.toMatchObject({ code: "estimate_not_found" });
    await expect(renderEstimateApprovalRecord(b.orgId, a.estimate.id)).rejects.toMatchObject({ code: "estimate_approval_record_not_found" });
    const view = await getPublicEstimateApproval(tokenOf(url));
    expect(JSON.stringify(view)).not.toContain(b.orgId);
    expect(JSON.stringify(view)).not.toContain(a.orgId);
    // A token derived for one row never opens another.
    const [rowB] = await db.insert(estimateApprovalsTable).values({ id: randomUUID(), organizationId: b.orgId, estimateId: b.estimate.id, createdByUserId: b.owner.id, snapshot: { formatVersion: 1, companyName: "B", customerName: null, title: "t", lineItems: [], subtotalCents: 0, taxCents: 0, totalCents: 0, notes: null }, snapshotSha256: "0".repeat(64), tokenHash: "f".repeat(64), expiresAt: new Date(Date.now() + 86_400_000) }).returning();
    expect(await getPublicEstimateApproval(estimateApprovalToken(rowB!.id))).toBeNull();
  });

  it("refuses estimates with no priced lines", async () => {
    const f = await fixture();
    const empty = await createEstimate(f.orgId, { leadId: f.lead.id, title: "Empty", lineItems: [] }, { userId: f.owner.id });
    await expect(createEstimateApprovalLink(f.orgId, empty!.id, f.owner.id)).rejects.toMatchObject({ code: "estimate_approval_empty" });
    expect((await getEstimateApprovalStatus(f.orgId, empty!.id)).eligible).toBe(false);
  });
});

describe("returning-customer estimate approval", () => {
  async function returning(withQuantity = 2.125) {
    const f = await returningCustomerFixture();
    orgs.push(f.org);
    const draft = returningEstimateDraft(f);
    draft.lineItems = [{ description: "Agreed repair scope", quantity: withQuantity, unitPriceCents: 1234 }];
    const { estimate } = await createCustomerWorkEstimate(f.org, f.actor, draft);
    const link = await createEstimateApprovalLink(f.org, estimate.id, f.office.id);
    return { f, estimate, link };
  }

  it("records the approval through the versioned command with the link creator and customer provenance", async () => {
    const { f, estimate, link } = await returning();
    expect(link.approval.state).toBe("waiting");
    const [frozen] = await db.select().from(estimateApprovalsTable).where(eq(estimateApprovalsTable.estimateId, estimate.id));
    expect(frozen!.snapshot.customerName).toBe("Synthetic Returning Customer");
    expect(await approveEstimate(tokenOf(link.url), { signerName: "Sam Returning", signatureDataUrl: SIGNATURE, consent: true }, META)).toMatchObject({ state: "approved" });

    const [row] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, estimate.id));
    expect(row).toMatchObject({ status: "accepted", workVersion: estimate.workVersion! + 1, totalCents: estimate.totalCents });
    expect(row!.acceptedAt).not.toBeNull();
    const [command] = await db.select().from(customerWorkCommandsTable).where(eq(customerWorkCommandsTable.requestId, link.approval.id));
    expect(command).toMatchObject({ action: "estimate_updated", actorUserId: f.office.id, estimateId: estimate.id, resultVersion: row!.workVersion });
    const audits = await db.select().from(auditEventsTable).where(eq(auditEventsTable.entityId, estimate.id));
    expect(audits.find((a) => a.action === "customer_work.estimate_updated" && (a.metadata as { requestId?: string }).requestId === link.approval.id)!.metadata).toMatchObject({
      staffRecorded: false,
      customerApproval: { approvalId: link.approval.id, decision: "approved" },
    });
    expect(audits.some((a) => a.action === "estimate.customer_approved")).toBe(true);
    const [task] = await db.select().from(crmTasksTable).where(eq(crmTasksTable.sourceEvent, `estimate.approved:${estimate.id}`));
    expect(task).toMatchObject({ leadId: null, contactId: f.contact.id, assignedUserId: f.office.id });
  });

  it("declines a returning estimate, and refuses a link outdated by a new version", async () => {
    const declined = await returning();
    await declineEstimate(tokenOf(declined.link.url), { reason: "Waiting until spring" }, META);
    const [row] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, declined.estimate.id));
    expect(row).toMatchObject({ status: "declined", workVersion: declined.estimate.workVersion! + 1 });

    const { f, estimate, link } = await returning();
    const { source: _source, ...edit } = returningEstimateDraft(f);
    await updateCustomerWorkEstimate(f.org, f.actor, estimate.id, { ...edit, requestId: randomUUID(), expectedWorkVersion: estimate.workVersion, status: "draft" });
    await expect(approveEstimate(tokenOf(link.url), { signerName: "Sam Returning", signatureDataUrl: SIGNATURE, consent: true }, META)).rejects.toMatchObject({ code: "estimate_approval_outdated" });
  });

  it("records nothing when the link creator can no longer act for the company", async () => {
    const { f, estimate, link } = await returning();
    await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, f.office.id));
    await expect(approveEstimate(tokenOf(link.url), { signerName: "Sam Returning", signatureDataUrl: SIGNATURE, consent: true }, META)).rejects.toMatchObject({ code: "estimate_approval_unrecordable", status: 409 });
    const [row] = await db.select().from(estimatesTable).where(eq(estimatesTable.id, estimate.id));
    expect(row).toMatchObject({ status: "draft", workVersion: estimate.workVersion });
    const [approval] = await db.select().from(estimateApprovalsTable).where(eq(estimateApprovalsTable.id, link.approval.id));
    expect(approval!.decision).toBeNull();
  });
});
