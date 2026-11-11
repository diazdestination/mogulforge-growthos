import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  activitiesTable,
  auditEventsTable,
  contactsTable,
  crmTasksTable,
  customerWorkRootsTable,
  db,
  estimateApprovalsTable,
  estimatesTable,
  leadsTable,
  type Estimate,
  type EstimateApproval,
  type EstimateApprovalSnapshot,
} from "@workspace/db";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";

import { updateEstimateInTransaction } from "./crm";
import { customerWorkHash, lockCustomerWork } from "./customer-work-lineage";
import { CustomerWorkError } from "./returning-customer-contract";
import { estimateOffersApprovalLink } from "./estimate-delivery-contract";
import { updateCustomerWorkEstimate } from "./returning-customer";
import { assertCustomerLifecycleActive } from "./customer-lifecycle";
import { publicBaseUrl } from "./send-gate";
import { getBusinessName } from "./settings";

/**
 * ESTI customer estimate approval with e-signature.
 *
 * Staff create (or reuse) one approval link per saved estimate version. The
 * link is a capability URL: its token is an HMAC of the row id under the
 * server secret, so the database holds only the token's SHA-256 and staff can
 * re-copy the same link. The row freezes what the customer sees; an estimate
 * edit after link creation makes the link outdated and approval is refused.
 * Approval records the typed name, drawn signature and consent, and moves the
 * estimate to accepted through the existing estimate transition, all in one
 * transaction with the audit event, lead activity and staff follow-up task.
 */

export const ESTIMATE_APPROVAL_CONSENT_TEXT = "I approve this estimate and authorize the work.";
export const ESTIMATE_APPROVAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SIGNATURE_MAX_CHARS = 200_000;

export type EstimateApprovalState = "waiting" | "approved" | "declined" | "expired" | "revoked" | "outdated";

export class EstimateApprovalError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EstimateApprovalError";
  }
}
const fail = (status: number, code: string, message: string): never => {
  throw new EstimateApprovalError(status, code, message);
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function signingKey(): string {
  const key = process.env.SESSION_SECRET;
  if (!key || key.length < 16) fail(503, "estimate_approval_unavailable", "Approval links are not configured on this server.");
  return key!;
}

/** Deterministic capability token for one approval row. Never stored. */
export function estimateApprovalToken(approvalId: string): string {
  return createHmac("sha256", signingKey()).update(`estimate-approval.v1:${approvalId}`).digest("base64url");
}

export function estimateApprovalUrl(approvalId: string): string {
  return `${publicBaseUrl()}/approve/${estimateApprovalToken(approvalId)}`;
}

/** Digest of the customer-visible estimate content. Status and timestamps are excluded. */
export function estimateContentSha256(estimate: Pick<Estimate, "title" | "lineItems" | "subtotalCents" | "taxCents" | "totalCents" | "notes">): string {
  return customerWorkHash(
    {
      title: estimate.title,
      lineItems: estimate.lineItems.map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        totalCents: line.totalCents,
      })),
      subtotalCents: estimate.subtotalCents,
      taxCents: estimate.taxCents,
      totalCents: estimate.totalCents,
      notes: estimate.notes ?? null,
    },
  );
}

export function estimateApprovalState(approval: EstimateApproval, estimate: Estimate | null, now = new Date()): EstimateApprovalState {
  if (approval.decision === "approved") return "approved";
  if (approval.decision === "declined") return "declined";
  if (approval.revokedAt) return "revoked";
  if (!estimate || estimateContentSha256(estimate) !== approval.snapshotSha256 || !["draft", "sent"].includes(estimate.status)) return "outdated";
  if (approval.expiresAt.getTime() <= now.getTime()) return "expired";
  return "waiting";
}

type Reader = Pick<typeof db, "select">;

async function readEstimate(reader: Reader, organizationId: string, estimateId: string) {
  const [estimate] = await reader
    .select()
    .from(estimatesTable)
    .where(and(eq(estimatesTable.organizationId, organizationId), eq(estimatesTable.id, estimateId)));
  return estimate ?? null;
}

/** The estimate's customer: its opportunity's contact, or the returning-work root's contact. */
async function estimateParty(reader: Reader, organizationId: string, estimate: Pick<Estimate, "leadId" | "customerWorkId">) {
  if (estimate.leadId) {
    const [row] = await reader
      .select({ lead: leadsTable, contact: contactsTable })
      .from(leadsTable)
      .leftJoin(contactsTable, and(eq(contactsTable.organizationId, organizationId), eq(contactsTable.id, leadsTable.contactId)))
      .where(and(eq(leadsTable.organizationId, organizationId), eq(leadsTable.id, estimate.leadId)));
    return { lead: row?.lead ?? null, contact: row?.contact ?? null };
  }
  if (!estimate.customerWorkId) return { lead: null, contact: null };
  const [row] = await reader
    .select({ contact: contactsTable })
    .from(customerWorkRootsTable)
    .innerJoin(contactsTable, and(eq(contactsTable.organizationId, organizationId), eq(contactsTable.id, customerWorkRootsTable.contactId)))
    .where(and(eq(customerWorkRootsTable.organizationId, organizationId), eq(customerWorkRootsTable.id, estimate.customerWorkId)));
  return { lead: null, contact: row?.contact ?? null };
}

/** Opportunity estimates, or versioned returning-customer estimates. */
const approvalSource = (estimate: Estimate) =>
  (estimate.leadId !== null && estimate.customerWorkId === null) ||
  (estimate.leadId === null && estimate.customerWorkId !== null && Number.isInteger(estimate.workVersion) && (estimate.workVersion ?? 0) > 0);

function assertLinkable(estimate: Estimate | null): asserts estimate is Estimate {
  if (!estimate) fail(404, "estimate_not_found", "Estimate not found.");
  if (!approvalSource(estimate!)) fail(409, "estimate_approval_unsupported", "This estimate's customer source is unavailable.");
  if (!["draft", "sent"].includes(estimate!.status)) {
    fail(409, "estimate_already_decided", "This estimate is already accepted or declined.");
  }
  if (!estimate!.lineItems.length || estimate!.totalCents < 1) {
    fail(400, "estimate_approval_empty", "Add at least one priced line before asking the customer to approve.");
  }
}

export type StaffApprovalView = {
  id: string;
  state: EstimateApprovalState;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  decidedAt: string | null;
  signerName: string | null;
  signatureDataUrl: string | null;
  declineReason: string | null;
  totalCents: number;
};

function staffView(approval: EstimateApproval, estimate: Estimate | null): StaffApprovalView {
  return {
    id: approval.id,
    state: estimateApprovalState(approval, estimate),
    createdAt: approval.createdAt.toISOString(),
    expiresAt: approval.expiresAt.toISOString(),
    revokedAt: approval.revokedAt?.toISOString() ?? null,
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    signerName: approval.signerName,
    signatureDataUrl: approval.decision === "approved" ? approval.signatureDataUrl : null,
    declineReason: approval.declineReason,
    totalCents: approval.snapshot.totalCents,
  };
}

/** Latest approval for an estimate; a revoked row only shows when nothing newer stands. */
async function latestApproval(reader: Reader, organizationId: string, estimateId: string) {
  const rows = await reader
    .select()
    .from(estimateApprovalsTable)
    .where(and(eq(estimateApprovalsTable.organizationId, organizationId), eq(estimateApprovalsTable.estimateId, estimateId)))
    .orderBy(desc(estimateApprovalsTable.createdAt))
    .limit(20);
  return rows.find((row) => !row.revokedAt) ?? rows[0] ?? null;
}

export async function getEstimateApprovalStatus(organizationId: string, estimateId: string) {
  const estimate = await readEstimate(db, organizationId, estimateId);
  if (!estimate) fail(404, "estimate_not_found", "Estimate not found.");
  const approval = await latestApproval(db, organizationId, estimateId);
  const eligible = estimateOffersApprovalLink(estimate!);
  return { estimateId, eligible, approval: approval ? staffView(approval, estimate) : null };
}

/**
 * Create the approval link for the estimate's current content, or return the
 * existing open link when it still matches. A stale or expired open link is
 * revoked first so only one link is ever open per estimate.
 */
export async function createEstimateApprovalLink(
  organizationId: string,
  estimateId: string,
  actorUserId: string,
  source: "staff" | "estimate_email" = "staff",
) {
  signingKey();
  // Settings reads take the company lifecycle lock in their own transaction; read first.
  const companyName = await getBusinessName(organizationId);
  return db.transaction(async (tx) => {
    await lockCustomerWork(tx, organizationId);
    const [estimate] = await tx
      .select()
      .from(estimatesTable)
      .where(and(eq(estimatesTable.organizationId, organizationId), eq(estimatesTable.id, estimateId)))
      .for("update");
    assertLinkable(estimate ?? null);
    const contentSha = estimateContentSha256(estimate!);
    const [open] = await tx
      .select()
      .from(estimateApprovalsTable)
      .where(
        and(
          eq(estimateApprovalsTable.organizationId, organizationId),
          eq(estimateApprovalsTable.estimateId, estimateId),
          isNull(estimateApprovalsTable.revokedAt),
          isNull(estimateApprovalsTable.decision),
        ),
      )
      .for("update");
    if (open && open.snapshotSha256 === contentSha && open.expiresAt.getTime() > Date.now()) {
      return { approval: staffView(open, estimate!), url: estimateApprovalUrl(open.id), reused: true };
    }
    if (open) {
      await tx.update(estimateApprovalsTable).set({ revokedAt: new Date(), revokedByUserId: actorUserId }).where(eq(estimateApprovalsTable.id, open.id));
      await tx.insert(auditEventsTable).values({
        organizationId,
        actorUserId,
        action: "estimate.approval_link_revoked",
        entityType: "estimate",
        entityId: estimateId,
        metadata: { approvalId: open.id, reason: open.snapshotSha256 === contentSha ? "expired" : "estimate_changed" },
      });
    }
    const customer = await estimateParty(tx, organizationId, estimate!);
    const customerName = customer?.contact ? [customer.contact.firstName, customer.contact.lastName].filter(Boolean).join(" ").trim() || null : null;
    const snapshot: EstimateApprovalSnapshot = {
      formatVersion: 1,
      companyName,
      customerName,
      title: estimate!.title,
      lineItems: estimate!.lineItems.map((line) => ({ ...line })),
      subtotalCents: estimate!.subtotalCents,
      taxCents: estimate!.taxCents,
      totalCents: estimate!.totalCents,
      notes: estimate!.notes ?? null,
    };
    const id = randomUUID();
    const [row] = await tx
      .insert(estimateApprovalsTable)
      .values({
        id,
        organizationId,
        estimateId,
        createdByUserId: actorUserId,
        snapshot,
        snapshotSha256: contentSha,
        tokenHash: sha256(estimateApprovalToken(id)),
        expiresAt: new Date(Date.now() + ESTIMATE_APPROVAL_TTL_MS),
      })
      .returning();
    await tx.insert(auditEventsTable).values({
      organizationId,
      actorUserId,
      action: "estimate.approval_link_created",
      entityType: "estimate",
      entityId: estimateId,
      metadata: { approvalId: id, snapshotSha256: contentSha, expiresAt: row!.expiresAt.toISOString(), customerContacted: false, source },
    });
    return { approval: staffView(row!, estimate!), url: estimateApprovalUrl(id), reused: false };
  });
}

/**
 * Send-time only: the approval link for a reviewed estimate email. Reuses the
 * open link, or creates one when none is open, then re-checks at this moment
 * that the link is waiting and freezes exactly the content being emailed.
 * Returns null (send the estimate without the link) instead of throwing, so a
 * link problem never strands an email whose delivery is already claimed.
 */
export async function approvalLinkForEstimateEmail(
  organizationId: string,
  estimateId: string,
  actorUserId: string,
  emailed: Pick<Estimate, "title" | "lineItems" | "subtotalCents" | "taxCents" | "totalCents" | "notes">,
): Promise<string | null> {
  try {
    const { approval, url } = await createEstimateApprovalLink(organizationId, estimateId, actorUserId, "estimate_email");
    const [row] = await db
      .select()
      .from(estimateApprovalsTable)
      .where(and(eq(estimateApprovalsTable.organizationId, organizationId), eq(estimateApprovalsTable.id, approval.id)));
    const estimate = await readEstimate(db, organizationId, estimateId);
    if (!row || estimateApprovalState(row, estimate) !== "waiting" || row.snapshotSha256 !== estimateContentSha256(emailed)) return null;
    return url;
  } catch {
    return null;
  }
}

export async function revokeEstimateApprovalLink(organizationId: string, estimateId: string, actorUserId: string) {
  return db.transaction(async (tx) => {
    await lockCustomerWork(tx, organizationId);
    const estimate = await readEstimate(tx, organizationId, estimateId);
    if (!estimate) fail(404, "estimate_not_found", "Estimate not found.");
    const [revoked] = await tx
      .update(estimateApprovalsTable)
      .set({ revokedAt: new Date(), revokedByUserId: actorUserId })
      .where(
        and(
          eq(estimateApprovalsTable.organizationId, organizationId),
          eq(estimateApprovalsTable.estimateId, estimateId),
          isNull(estimateApprovalsTable.revokedAt),
          isNull(estimateApprovalsTable.decision),
        ),
      )
      .returning();
    if (!revoked) fail(409, "estimate_approval_not_open", "There is no open approval link to revoke.");
    await tx.insert(auditEventsTable).values({
      organizationId,
      actorUserId,
      action: "estimate.approval_link_revoked",
      entityType: "estimate",
      entityId: estimateId,
      metadata: { approvalId: revoked!.id, reason: "staff_revoked" },
    });
    return { approval: staffView(revoked!, estimate) };
  });
}

/**
 * Validate an open approval for a staff-requested text: returns the URL and
 * customer contact only while the link is waiting. Used by the Zapier flow
 * on request, on approval re-derivation and at dispatch.
 */
export async function readWaitingApprovalForText(reader: Reader, organizationId: string, estimateId: string) {
  const estimate = await readEstimate(reader, organizationId, estimateId);
  if (!estimate) fail(404, "estimate_not_found", "Estimate not found.");
  const [open] = await reader
    .select()
    .from(estimateApprovalsTable)
    .where(
      and(
        eq(estimateApprovalsTable.organizationId, organizationId),
        eq(estimateApprovalsTable.estimateId, estimateId),
        isNull(estimateApprovalsTable.revokedAt),
        isNull(estimateApprovalsTable.decision),
      ),
    );
  if (!open) fail(409, "estimate_approval_not_open", "Create an approval link before texting it.");
  const state = estimateApprovalState(open!, estimate);
  if (state !== "waiting") {
    fail(409, `estimate_approval_${state}`, state === "outdated" ? "The estimate changed after its approval link was created. Create a new link." : "The approval link expired. Create a new link.");
  }
  const customer = await estimateParty(reader, organizationId, estimate!);
  return { estimate: estimate!, approval: open!, lead: customer.lead, contact: customer.contact, url: estimateApprovalUrl(open!.id) };
}

// ---------- public, token-authenticated ----------

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

async function findByToken(token: string, reader: Reader = db): Promise<EstimateApproval | null> {
  if (!TOKEN_RE.test(token)) return null;
  const [row] = await reader.select().from(estimateApprovalsTable).where(eq(estimateApprovalsTable.tokenHash, sha256(token)));
  if (!row) return null;
  // Defense in depth: the token must still derive from this row under the current key.
  const expected = Buffer.from(estimateApprovalToken(row.id));
  const given = Buffer.from(token);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return row;
}

export type PublicApprovalView = {
  state: EstimateApprovalState;
  companyName: string;
  consentText: string;
  expiresAt: string;
  estimate: Omit<EstimateApprovalSnapshot, "formatVersion" | "companyName"> | null;
  decidedAt: string | null;
  signerName: string | null;
};

function publicView(approval: EstimateApproval, estimate: Estimate | null): PublicApprovalView {
  const state = estimateApprovalState(approval, estimate);
  const { formatVersion: _v, companyName, ...shown } = approval.snapshot;
  return {
    state,
    companyName,
    consentText: approval.consentText ?? ESTIMATE_APPROVAL_CONSENT_TEXT,
    expiresAt: approval.expiresAt.toISOString(),
    // An outdated, expired or revoked link no longer shows prices.
    estimate: ["waiting", "approved", "declined"].includes(state) ? shown : null,
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    signerName: approval.decision === "approved" ? approval.signerName : null,
  };
}

export async function getPublicEstimateApproval(token: string): Promise<PublicApprovalView | null> {
  const approval = await findByToken(token);
  if (!approval) return null;
  return publicView(approval, await readEstimate(db, approval.organizationId, approval.estimateId));
}

export type ApprovalRequestMeta = { ip: string | null; userAgent: string | null };

const PNG_PREFIX = "data:image/png;base64,";

/** A drawn signature: a bounded PNG data URL whose bytes really are a PNG. */
export function validateSignatureDataUrl(value: string): string {
  if (typeof value !== "string" || !value.startsWith(PNG_PREFIX) || value.length > SIGNATURE_MAX_CHARS) {
    fail(400, "estimate_approval_invalid_signature", "Draw your signature in the box.");
  }
  const body = value.slice(PNG_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) fail(400, "estimate_approval_invalid_signature", "Draw your signature in the box.");
  const bytes = Buffer.from(body, "base64");
  if (bytes.length < 67 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    fail(400, "estimate_approval_invalid_signature", "Draw your signature in the box.");
  }
  return value;
}

/** Lock the approval and its estimate, and refuse anything but a waiting link. */
async function lockWaiting(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], token: string) {
  const found = await findByToken(token, tx);
  if (!found) fail(404, "estimate_approval_not_found", "This approval link is not valid.");
  // The versioned returning-estimate command also takes the invoices lock; take
  // it here, before any row lock, so both estimate kinds share one lock order.
  await lockCustomerWork(tx, found!.organizationId, true);
  const [approval] = await tx.select().from(estimateApprovalsTable).where(eq(estimateApprovalsTable.id, found!.id)).for("update");
  const [estimate] = await tx
    .select()
    .from(estimatesTable)
    .where(and(eq(estimatesTable.organizationId, approval!.organizationId), eq(estimatesTable.id, approval!.estimateId)))
    .for("update");
  const state = estimateApprovalState(approval!, estimate ?? null);
  if (state === "approved" || state === "declined") {
    fail(409, "estimate_approval_already_decided", state === "approved" ? "This estimate was already approved." : "This estimate was already declined.");
  }
  if (state === "outdated") fail(409, "estimate_approval_outdated", "This estimate was updated. Ask the company for a new approval link.");
  if (state === "expired") fail(410, "estimate_approval_expired", "This approval link expired. Ask the company for a new link.");
  if (state === "revoked") fail(410, "estimate_approval_revoked", "This approval link is no longer active. Ask the company for a new link.");
  return { approval: approval!, estimate: estimate! };
}

async function followUp(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  approval: EstimateApproval,
  estimate: Estimate,
  decision: "approved" | "declined",
  detail: string,
) {
  const org = approval.organizationId;
  const customer = await estimateParty(tx, org, estimate);
  const who = approval.signerName ?? approval.snapshot.customerName ?? "The customer";
  await tx.insert(activitiesTable).values({
    organizationId: org,
    leadId: estimate.leadId,
    contactId: customer.contact?.id ?? null,
    type: decision === "approved" ? "estimate_approved" : "estimate_declined",
    title: decision === "approved" ? `${who} approved and signed "${estimate.title}"` : `Customer declined "${estimate.title}"`,
    body: detail || null,
    metadata: { estimateId: estimate.id, approvalId: approval.id, totalCents: approval.snapshot.totalCents },
  });
  await tx.insert(crmTasksTable).values({
    organizationId: org,
    leadId: estimate.leadId,
    contactId: customer.contact?.id ?? null,
    assignedUserId: customer.lead?.assignedUserId ?? approval.createdByUserId,
    title: decision === "approved" ? "Estimate approved — schedule the work" : "Estimate declined — follow up",
    description: decision === "approved" ? `${who} signed "${estimate.title}". Review the signed record and schedule the work.` : `The customer declined "${estimate.title}".${detail ? ` Reason: ${detail}` : ""}`,
    sourceEvent: `estimate.${decision}:${estimate.id}`,
    priority: decision === "approved" ? "high" : "normal",
    dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
}

/**
 * Move the estimate to the customer's decision through its own writer: the
 * opportunity transition, or the versioned returning-customer command. A
 * returning command needs a staff actor; it records the staff member who
 * created the link, with explicit customer-approval provenance in its audit.
 */
async function recordDecisionStatus(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  approval: EstimateApproval,
  estimate: Estimate,
  status: "accepted" | "declined",
): Promise<Estimate> {
  const org = approval.organizationId;
  const outdated = () => fail(409, "estimate_approval_outdated", "This estimate was updated. Ask the company for a new approval link.");
  if (!estimate.customerWorkId) {
    const row = await updateEstimateInTransaction(tx, org, estimate.id, { status }, { userId: null });
    if (!row || row.status !== status) outdated();
    return row!;
  }
  try {
    await updateCustomerWorkEstimate(
      org,
      { userId: approval.createdByUserId },
      estimate.id,
      {
        requestId: approval.id,
        confirmed: true,
        expectedWorkVersion: estimate.workVersion,
        title: estimate.title,
        notes: estimate.notes ?? null,
        lineItems: estimate.lineItems.map((line) => ({ description: line.description, quantity: line.quantity, unitPriceCents: line.unitPriceCents })),
        taxCents: estimate.taxCents,
        status,
      },
      { tx, customerApproval: { approvalId: approval.id, decision: status === "accepted" ? "approved" : "declined" } },
    );
  } catch (error) {
    if (error instanceof CustomerWorkError && error.code === "customer_work_access_denied") {
      fail(409, "estimate_approval_unrecordable", "This company can't record a response on this link right now. Contact them directly.");
    }
    if (error instanceof CustomerWorkError) outdated();
    throw error;
  }
  const [row] = await tx
    .select()
    .from(estimatesTable)
    .where(and(eq(estimatesTable.organizationId, org), eq(estimatesTable.id, estimate.id)));
  // The command recomputes totals; the decided content must be exactly what the customer saw.
  if (!row || row.status !== status || estimateContentSha256(row) !== approval.snapshotSha256) outdated();
  return row!;
}

export async function approveEstimate(
  token: string,
  input: { signerName: string; signatureDataUrl: string; consent: boolean },
  meta: ApprovalRequestMeta,
) {
  const signerName = typeof input.signerName === "string" ? input.signerName.trim().replace(/\s+/g, " ") : "";
  if (signerName.length < 2 || signerName.length > 120) fail(400, "estimate_approval_invalid_name", "Type your full name.");
  if (input.consent !== true) fail(400, "estimate_approval_consent_required", "Tick the box to confirm your approval.");
  const signature = validateSignatureDataUrl(input.signatureDataUrl);
  const found = await findByToken(token);
  if (!found) fail(404, "estimate_approval_not_found", "This approval link is not valid.");
  await assertCustomerLifecycleActive(found!.organizationId);
  return db.transaction(async (tx) => {
    const { approval, estimate } = await lockWaiting(tx, token);
    const org = approval.organizationId;
    // Reuse the estimate's own transition (status, acceptedAt, saved-state chain, audit).
    const accepted = await recordDecisionStatus(tx, approval, estimate, "accepted");
    const signatureSha256 = sha256(signature);
    const [decided] = await tx
      .update(estimateApprovalsTable)
      .set({
        decision: "approved",
        decidedAt: new Date(),
        signerName,
        signatureDataUrl: signature,
        signatureSha256,
        consentText: ESTIMATE_APPROVAL_CONSENT_TEXT,
        signerIp: meta.ip?.slice(0, 64) ?? null,
        signerUserAgent: meta.userAgent?.slice(0, 500) ?? null,
      })
      .where(and(eq(estimateApprovalsTable.id, approval.id), isNull(estimateApprovalsTable.decision), isNull(estimateApprovalsTable.revokedAt)))
      .returning();
    if (!decided) fail(409, "estimate_approval_already_decided", "This estimate was already approved.");
    await tx.insert(auditEventsTable).values({
      organizationId: org,
      actorUserId: null,
      action: "estimate.customer_approved",
      entityType: "estimate",
      entityId: estimate.id,
      metadata: {
        approvalId: approval.id,
        signerName,
        snapshotSha256: approval.snapshotSha256,
        signatureSha256,
        totalCents: approval.snapshot.totalCents,
        consentText: ESTIMATE_APPROVAL_CONSENT_TEXT,
        signerIp: decided!.signerIp,
      },
    });
    await followUp(tx, decided!, estimate, "approved", "");
    return publicView(decided!, accepted);
  });
}

export async function declineEstimate(token: string, input: { reason?: string | null }, meta: ApprovalRequestMeta) {
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 1000) : "";
  const found = await findByToken(token);
  if (!found) fail(404, "estimate_approval_not_found", "This approval link is not valid.");
  await assertCustomerLifecycleActive(found!.organizationId);
  return db.transaction(async (tx) => {
    const { approval, estimate } = await lockWaiting(tx, token);
    const org = approval.organizationId;
    const declined = await recordDecisionStatus(tx, approval, estimate, "declined");
    const [decided] = await tx
      .update(estimateApprovalsTable)
      .set({
        decision: "declined",
        decidedAt: new Date(),
        declineReason: reason || null,
        signerIp: meta.ip?.slice(0, 64) ?? null,
        signerUserAgent: meta.userAgent?.slice(0, 500) ?? null,
      })
      .where(and(eq(estimateApprovalsTable.id, approval.id), isNull(estimateApprovalsTable.decision), isNull(estimateApprovalsTable.revokedAt)))
      .returning();
    if (!decided) fail(409, "estimate_approval_already_decided", "This estimate was already decided.");
    await tx.insert(auditEventsTable).values({
      organizationId: org,
      actorUserId: null,
      action: "estimate.customer_declined",
      entityType: "estimate",
      entityId: estimate.id,
      metadata: { approvalId: approval.id, snapshotSha256: approval.snapshotSha256, hasReason: !!reason, signerIp: decided!.signerIp },
    });
    await followUp(tx, decided!, estimate, "declined", reason);
    return publicView(decided!, declined);
  });
}

// ---------- staff signed record ----------

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Printable HTML of the signed (or declined) record for one estimate. */
export async function renderEstimateApprovalRecord(organizationId: string, estimateId: string): Promise<string> {
  const [approval] = await db
    .select()
    .from(estimateApprovalsTable)
    .where(and(eq(estimateApprovalsTable.organizationId, organizationId), eq(estimateApprovalsTable.estimateId, estimateId), isNotNull(estimateApprovalsTable.decision)))
    .orderBy(desc(estimateApprovalsTable.decidedAt))
    .limit(1);
  if (!approval?.decision) fail(404, "estimate_approval_record_not_found", "This estimate has no customer decision on record.");
  const a = approval!;
  const s = a.snapshot;
  const rows = s.lineItems
    .map((line) => `<tr><td>${escapeHtml(line.description)}</td><td class="n">${escapeHtml(String(line.quantity))}</td><td class="n">${money(line.unitPriceCents)}</td><td class="n">${money(line.totalCents)}</td></tr>`)
    .join("");
  const decided = a.decidedAt!.toISOString();
  const signed =
    a.decision === "approved"
      ? `<section class="sig"><h2>Customer approval</h2>
<p class="consent">&#9745; ${escapeHtml(a.consentText ?? ESTIMATE_APPROVAL_CONSENT_TEXT)}</p>
<img alt="Customer signature" src="${escapeHtml(a.signatureDataUrl ?? "")}">
<dl><dt>Signed by</dt><dd>${escapeHtml(a.signerName ?? "")}</dd><dt>Signed at (UTC)</dt><dd>${escapeHtml(decided)}</dd><dt>IP address</dt><dd>${escapeHtml(a.signerIp ?? "Not recorded")}</dd><dt>Browser</dt><dd>${escapeHtml(a.signerUserAgent ?? "Not recorded")}</dd><dt>Signature SHA-256</dt><dd class="mono">${escapeHtml(a.signatureSha256 ?? "")}</dd></dl></section>`
      : `<section class="sig"><h2>Customer declined</h2><dl><dt>Declined at (UTC)</dt><dd>${escapeHtml(decided)}</dd><dt>Reason</dt><dd>${escapeHtml(a.declineReason ?? "No reason given")}</dd><dt>IP address</dt><dd>${escapeHtml(a.signerIp ?? "Not recorded")}</dd></dl></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(s.title)} — ${a.decision === "approved" ? "signed approval" : "declined"}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111;max-width:760px;margin:24px auto;padding:0 16px;line-height:1.45}h1{font-size:22px;margin:0}h2{font-size:16px;margin:24px 0 8px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{border-bottom:1px solid #ddd;padding:6px 4px;text-align:left;vertical-align:top}.n{text-align:right;white-space:nowrap}.tot td{border:none}.sig img{max-width:360px;width:100%;border:1px solid #ccc;background:#fff}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;font-size:14px}dt{color:#555}.mono{font-family:ui-monospace,monospace;word-break:break-all;font-size:12px}.muted{color:#555;font-size:12px}@media print{.noprint{display:none}}</style></head>
<body><p class="muted noprint">Use your browser's Print command to print or save this record as a PDF.</p>
<p class="muted">${escapeHtml(s.companyName)}</p><h1>${escapeHtml(s.title)}</h1>
<p>Customer: ${escapeHtml(s.customerName ?? "Not recorded")}</p>
<table><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Unit</th><th class="n">Amount</th></tr></thead><tbody>${rows}</tbody>
<tbody class="tot"><tr><td colspan="3" class="n">Subtotal</td><td class="n">${money(s.subtotalCents)}</td></tr><tr><td colspan="3" class="n">Tax</td><td class="n">${money(s.taxCents)}</td></tr><tr><td colspan="3" class="n"><strong>Total</strong></td><td class="n"><strong>${money(s.totalCents)}</strong></td></tr></tbody></table>
${s.notes ? `<h2>Notes</h2><p>${escapeHtml(s.notes)}</p>` : ""}
${signed}
<p class="muted">Approval link created ${escapeHtml(a.createdAt.toISOString())}. Estimate content SHA-256 at link creation: <span class="mono">${escapeHtml(a.snapshotSha256)}</span>. This record shows the estimate exactly as the customer saw it.</p>
</body></html>`;
}
