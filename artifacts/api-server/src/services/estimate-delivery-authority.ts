import {
  db,
  estimatesTable,
  organizationsTable,
  contactsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  assertCustomerWorkReader,
  customerWorkActor,
  lockCustomerWork,
  readNativeWorkLineage,
  nativeWorkLabels,
  type CustomerWorkReader,
  type CustomerWorkTx,
} from "./customer-work-lineage";
import { assertEstimateCleanHistory } from "./estimate-delivery-history";
import { readUserEmailIdentity } from "./user-email";
import { readCompanyEmailSender } from "./customer-email";
import {
  lockReplyContact,
  hasContactReplyHold,
  hasCustomerReplyHold,
} from "./response-correlation";
import { checkSendEligibility } from "./send-gate";
import { assertOutboundDeliveryAllowed } from "./outbound-hold";
import {
  assertEstimateInitialDraft,
  renderEstimateEmail,
  assertEstimateEmailMessageFits,
  estimateDeliveryFingerprint,
  estimateEmailSnapshotSchema,
  EstimateDeliveryError,
  type EstimateDeliveryActor,
  type EstimateEmailSnapshot,
} from "./estimate-delivery-contract";

function held(code: string, message: string, status = 409): never {
  throw new EstimateDeliveryError(status, code, message);
}
async function estimateRow(
  reader: CustomerWorkReader,
  org: string,
  id: string,
  locked: boolean,
) {
  const q = reader
    .select()
    .from(estimatesTable)
    .where(
      and(eq(estimatesTable.organizationId, org), eq(estimatesTable.id, id)),
    );
  const [row] = await (locked ? q.for("share") : q);
  if (!row)
    held(
      "estimate_not_found",
      "The exact saved estimate is unavailable in this company.",
      404,
    );
  return row;
}
/** SELECT-only authority; the locked path always retains the caller's transaction. */
export async function readEstimateEmailAuthority(
  reader: CustomerWorkReader,
  org: string,
  actor: EstimateDeliveryActor,
  estimateId: string,
  locked: boolean,
): Promise<EstimateEmailSnapshot> {
  assertCustomerWorkReader(reader, locked);
  if (locked) {
    if (reader === db)
      held(
        "estimate_transaction_required",
        "Locked authority requires the original transaction.",
        503,
      );
    const tx = reader as CustomerWorkTx;
    await lockCustomerWork(tx, org);
    // Identify namespaces without holding source rows. All reply locks precede
    // row locks, matching ordinary customer/estimate writers' lock order.
    const candidate = await estimateRow(reader, org, estimateId, false);
    const parents = await readNativeWorkLineage(reader, org, candidate, false);
    await lockReplyContact(
      tx,
      org,
      parents.contact.id,
      parents.lead ? [parents.lead.id] : [],
    );
    const estimate = await estimateRow(reader, org, candidate.id, true);
    const exact = await readNativeWorkLineage(reader, org, estimate, true);
    if (
      estimate.leadId !== candidate.leadId ||
      estimate.customerWorkId !== candidate.customerWorkId ||
      exact.contact.id !== parents.contact.id ||
      exact.lead?.id !== parents.lead?.id
    )
      held(
        "estimate_source_changed",
        "The original estimate participants changed. Refresh this saved quote.",
      );
    return assemble(reader, org, actor, estimate, exact, true);
  }
  const estimate = await estimateRow(reader, org, estimateId, false);
  return assemble(
    reader,
    org,
    actor,
    estimate,
    await readNativeWorkLineage(reader, org, estimate, false),
    false,
  );
}
async function assemble(
  reader: CustomerWorkReader,
  org: string,
  actor: EstimateDeliveryActor,
  estimate: Awaited<ReturnType<typeof estimateRow>>,
  lineage: Awaited<ReturnType<typeof readNativeWorkLineage>>,
  locked: boolean,
): Promise<EstimateEmailSnapshot> {
  const staff = await customerWorkActor(
    reader,
    org,
    actor,
    "crm.write",
    locked,
  );
  const effectiveRole = actor.effectiveRole ?? staff.role;
  if (
    !["office", "admin", "owner"].includes(staff.role) ||
    !["office", "admin", "owner"].includes(effectiveRole)
  )
    held(
      "estimate_access_denied",
      "An office, admin or owner must review this estimate with both current and effective permission.",
      403,
    );
  assertEstimateInitialDraft(estimate);
  await assertEstimateCleanHistory(reader, org, estimate);
  const q = reader
    .select({ id: organizationsTable.id, name: organizationsTable.name })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, estimate.organizationId));
  const [company] = await (locked ? q.for("share") : q);
  if (!company)
    held(
      "estimate_company_unavailable",
      "The original business identity is unavailable.",
    );
  let selected:
    | Awaited<ReturnType<typeof readCompanyEmailSender>>
    | { sender: EstimateEmailSnapshot["sender"]; identitySha256: string };
  try {
    if (lineage.lead?.assignedUserId) {
      const identity = await readUserEmailIdentity(
        reader,
        company.id,
        lineage.lead.assignedUserId,
        locked,
      );
      selected = {
        sender: {
          userId: identity.userId,
          source: "lead_assignee",
          provider: identity.provider,
          senderEmail: identity.senderEmail,
        },
        identitySha256: identity.identitySha256,
      };
    } else selected = await readCompanyEmailSender(reader, company.id, locked);
  } catch {
    held(
      "estimate_sender_unavailable",
      "The assigned or explicitly selected company sender must have an accepted active staff identity and an explicitly selected connected Gmail/Microsoft mailbox.",
    );
  }
  const labels = nativeWorkLabels(lineage);
  const document = {
    estimateId: estimate.id,
    businessName: company.name,
    customerLabel: labels.customerLabel,
    propertyLabel: labels.propertyLabel,
    title: estimate.title,
    lineItems: estimate.lineItems,
    subtotalCents: estimate.subtotalCents,
    taxCents: estimate.taxCents,
    totalCents: estimate.totalCents,
    notes: estimate.notes,
  };
  const message = renderEstimateEmail(
    document,
    lineage.contact.email?.trim().toLowerCase() ?? "",
  );
  assertEstimateEmailMessageFits(selected.sender.provider, message);
  const senderIdentitySha256 = estimateDeliveryFingerprint({
    sender: selected.sender,
    identitySha256: selected.identitySha256,
  });
  return estimateEmailSnapshotSchema.parse({
    organizationId: company.id,
    estimateId: estimate.id,
    actorUserId: staff.id,
    leadId: lineage.lead?.id ?? null,
    customerWorkId: lineage.root?.id ?? null,
    contactId: lineage.contact.id,
    propertyId: lineage.property?.id ?? null,
    estimateUpdatedAt: estimate.updatedAt.toISOString(),
    workVersion: estimate.workVersion,
    sourceSha256: estimateDeliveryFingerprint({
      estimate,
      company,
      contact: lineage.contact,
      property: lineage.property,
      lead: lineage.lead,
      root: lineage.root,
      approver: {
        id: staff.id,
        role: staff.role,
        effectiveRole,
        active: staff.isActive,
        verified: staff.emailVerifiedAt,
      },
      document,
      senderIdentitySha256,
    }),
    senderIdentitySha256,
    document,
    message,
    sender: selected.sender,
  });
}
/** Transactional eligibility retains DNC, suppression, lifecycle and reply holds. */
export async function assertEstimateEmailEligibility(
  reader: CustomerWorkReader,
  snapshot: EstimateEmailSnapshot,
): Promise<void> {
  const [contact] = await reader
    .select()
    .from(contactsTable)
    .where(
      and(
        eq(contactsTable.organizationId, snapshot.organizationId),
        eq(contactsTable.id, snapshot.contactId),
      ),
    );
  if (
    !contact ||
    contact.email?.trim().toLowerCase() !== snapshot.message.recipient
  )
    held(
      "estimate_email_held",
      "The original recipient is unavailable or changed.",
    );
  try {
    assertOutboundDeliveryAllowed({
      channel: "email",
      recipient: snapshot.message.recipient,
    });
  } catch {
    held(
      "estimate_email_held",
      "Customer email is held by the outbound policy.",
    );
  }
  const gate = await checkSendEligibility(
    {
      organizationId: snapshot.organizationId,
      leadId: snapshot.leadId,
      contact,
      channel: "email",
      kind: "transactional",
    },
    reader,
  );
  if (
    !gate.ok ||
    (await hasContactReplyHold(snapshot.organizationId, contact.id, reader)) ||
    (snapshot.leadId !== null &&
      (await hasCustomerReplyHold(
        snapshot.organizationId,
        snapshot.leadId,
        reader,
      )))
  )
    held(
      "estimate_email_held",
      "Customer email requires office review or is held by current eligibility controls.",
    );
}
