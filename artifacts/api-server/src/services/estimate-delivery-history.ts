import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  auditEventsTable,
  customerWorkCommandsTable,
  db,
  estimatesTable,
  customerWorkRootsTable,
  usersTable,
  type Estimate,
} from "@workspace/db";
import type {
  CustomerWorkReader,
  CustomerWorkTx,
} from "./customer-work-lineage";
import {
  EstimateDeliveryError,
  estimateDeliveryFingerprint,
  estimateEmailReviewMetadataSchema,
  ESTIMATE_EMAIL_REVIEW_ACTION,
  ESTIMATE_EMAIL_PREVIEW_MS,
} from "./estimate-delivery-contract";

const time = z.iso.datetime({ offset: true }).nullable();
export const estimateSavedStateSchema = z
  .object({
    version: z.literal(1),
    previousAuditId: z.uuid().nullable(),
    sequence: z.number().int().positive(),
    estimateSha256: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["draft", "sent", "accepted", "declined"]),
    sentAt: time,
    acceptedAt: time,
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    leadId: z.uuid().nullable(),
    customerWorkId: z.uuid().nullable(),
    workVersion: z.number().int().positive().nullable(),
    commandId: z.uuid().nullable(),
    anchor: z.enum(["creation", "legacy_returning", "unknown"]),
    intact: z.boolean(),
  })
  .strict();
type Saved = z.infer<typeof estimateSavedStateSchema>;
type Provenance = { creation?: boolean; previousEstimate?: Estimate };
function held(): never {
  throw new EstimateDeliveryError(
    409,
    "estimate_history_held",
    "The saved estimate has incomplete or previously marked history. Initial email delivery is held.",
  );
}
/** Deliberately enumerate the complete persisted row: enriched labels and sender state are excluded. */
export function estimateSavedStateDigest(e: Estimate): string {
  return estimateDeliveryFingerprint({
    id: e.id,
    organizationId: e.organizationId,
    leadId: e.leadId,
    customerWorkId: e.customerWorkId,
    workVersion: e.workVersion,
    title: e.title,
    status: e.status,
    lineItems: e.lineItems,
    subtotalCents: e.subtotalCents,
    taxCents: e.taxCents,
    totalCents: e.totalCents,
    notes: e.notes,
    sentAt: e.sentAt,
    acceptedAt: e.acceptedAt,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  });
}
async function events(reader: CustomerWorkReader, org: string, id: string) {
  return reader
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.organizationId, org),
        eq(auditEventsTable.entityId, id),
        eq(auditEventsTable.entityType, "estimate"),
      ),
    );
}
function chain(rows: Awaited<ReturnType<typeof events>>) {
  const states = rows
    .filter((e) => e.action === "estimate.saved_state")
    .map((e) => ({
      id: e.id,
      state: estimateSavedStateSchema.parse(e.metadata),
    }));
  if (!states.length) return [];
  const roots = states.filter((e) => e.state.previousAuditId === null);
  if (roots.length !== 1) held();
  const ordered = [roots[0]!],
    seen = new Set([roots[0]!.id]);
  for (;;) {
    const next = states.filter(
      (e) => e.state.previousAuditId === ordered.at(-1)!.id,
    );
    if (next.length > 1) held();
    if (!next.length) break;
    if (seen.has(next[0]!.id)) held();
    seen.add(next[0]!.id);
    ordered.push(next[0]!);
  }
  if (
    ordered.length !== states.length ||
    ordered.some((e, i) => e.state.sequence !== i + 1)
  )
    held();
  return ordered;
}
async function commandMatches(
  reader: CustomerWorkReader,
  org: string,
  e: Estimate,
  id: string,
  version: number,
  action: "estimate_created" | "estimate_updated",
) {
  const [c] = await reader
    .select()
    .from(customerWorkCommandsTable)
    .where(
      and(
        eq(customerWorkCommandsTable.organizationId, org),
        eq(customerWorkCommandsTable.id, id),
      ),
    );
  return (
    !!c &&
    c.estimateId === e.id &&
    c.customerWorkId === e.customerWorkId &&
    c.projectId === null &&
    c.action === action &&
    c.resultVersion === version
  );
}
async function legacyAnchor(
  reader: CustomerWorkReader,
  org: string,
  e: Estimate,
  rows: Awaited<ReturnType<typeof events>>,
  ignoreCommandId: string | null = null,
) {
  if (
    e.organizationId !== org ||
    !e.customerWorkId ||
    e.leadId !== null ||
    e.workVersion !== 1 ||
    e.status !== "draft" ||
    e.sentAt ||
    e.acceptedAt
  )
    return null;
  const cs = (
    await reader
      .select()
      .from(customerWorkCommandsTable)
      .where(
        and(
          eq(customerWorkCommandsTable.organizationId, org),
          eq(customerWorkCommandsTable.estimateId, e.id),
        ),
      )
  ).filter((c) => c.id !== ignoreCommandId);
  if (
    cs.length !== 1 ||
    !(await commandMatches(reader, org, e, cs[0]!.id, 1, "estimate_created"))
  )
    return null;
  for (const r of rows) {
    if (r.action === ESTIMATE_EMAIL_REVIEW_ACTION) {
      // A strictly actor/target-bound read-only review is not evidence of a send.
      // Expired reviews remain non-effects; claim enforces their lifetime.
      const parsed = estimateEmailReviewMetadataSchema.safeParse(r.metadata);
      if (!parsed.success) return null;
      const m = parsed.data,
        s = m.snapshot;
      if (
        r.organizationId !== org ||
        r.entityType !== "estimate" ||
        r.entityId !== e.id ||
        r.actorUserId !== s.actorUserId ||
        s.organizationId !== org ||
        s.estimateId !== e.id ||
        s.leadId !== null ||
        s.customerWorkId !== e.customerWorkId ||
        s.workVersion !== 1 ||
        s.estimateUpdatedAt !== e.updatedAt.toISOString() ||
        estimateDeliveryFingerprint(s) !== m.payloadSha256 ||
        Date.parse(m.expiresAt) !==
          r.createdAt.getTime() + ESTIMATE_EMAIL_PREVIEW_MS
      )
        return null;
      const [root] = await reader
        .select()
        .from(customerWorkRootsTable)
        .where(
          and(
            eq(customerWorkRootsTable.organizationId, org),
            eq(customerWorkRootsTable.id, e.customerWorkId),
          ),
        );
      const [actor] = await reader
        .select({ organizationId: usersTable.organizationId })
        .from(usersTable)
        .where(eq(usersTable.id, s.actorUserId));
      if (
        !root ||
        root.contactId !== s.contactId ||
        root.propertyId !== s.propertyId ||
        actor?.organizationId !== org
      )
        return null;
      if (
        estimateDeliveryFingerprint({
          title: e.title,
          lineItems: e.lineItems,
          subtotalCents: e.subtotalCents,
          taxCents: e.taxCents,
          totalCents: e.totalCents,
          notes: e.notes,
        }) !==
        estimateDeliveryFingerprint({
          title: s.document.title,
          lineItems: s.document.lineItems,
          subtotalCents: s.document.subtotalCents,
          taxCents: s.document.taxCents,
          totalCents: s.document.totalCents,
          notes: s.document.notes,
        })
      )
        return null;
    } else if (
      r.action !== "customer_work.estimate_created" ||
      r.metadata.savedStateVersion !== undefined ||
      r.metadata.customerWorkId !== e.customerWorkId ||
      r.metadata.workVersion !== 1
    )
      return null;
  }
  return cs[0]!.id;
}
function metadata(
  e: Estimate,
  previousAuditId: string | null,
  sequence: number,
  commandId: string | null,
  anchor: Saved["anchor"],
  intact: boolean,
): Saved {
  return estimateSavedStateSchema.parse({
    version: 1,
    previousAuditId,
    sequence,
    estimateSha256: estimateSavedStateDigest(e),
    status: e.status,
    sentAt: e.sentAt?.toISOString() ?? null,
    acceptedAt: e.acceptedAt?.toISOString() ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    leadId: e.leadId,
    customerWorkId: e.customerWorkId,
    workVersion: e.workVersion,
    commandId,
    anchor,
    intact,
  });
}
/** Call only after the shared lifecycle/schedule and estimate row locks, before commit. */
export async function recordEstimateSavedState(
  tx: CustomerWorkTx,
  org: string,
  e: Estimate,
  actorUserId: string | null,
  commandId: string | null,
  provenance: Provenance = {},
): Promise<void> {
  if ((tx as CustomerWorkReader) === db || e.organizationId !== org) held();
  const rows = await events(tx, org, e.id);
  let ordered: ReturnType<typeof chain> = [],
    intact = true;
  try {
    ordered = chain(rows);
  } catch {
    intact = false;
  }
  let anchor: Saved["anchor"] = "unknown";
  if (
    !rows.some((r) => r.action === "estimate.saved_state") &&
    provenance.creation
  ) {
    anchor = "creation";
    if (
      e.customerWorkId &&
      (!commandId ||
        !(await commandMatches(tx, org, e, commandId, 1, "estimate_created")))
    )
      intact = false;
  } else if (ordered.length) {
    anchor = ordered[0]!.state.anchor;
    if (
      !provenance.previousEstimate ||
      ordered.at(-1)!.state.estimateSha256 !==
        estimateSavedStateDigest(provenance.previousEstimate)
    )
      intact = false;
  } else if (provenance.previousEstimate) {
    const previous = provenance.previousEstimate,
      legacy = await legacyAnchor(tx, org, previous, rows, commandId);
    if (legacy) {
      const [a] = await tx
        .insert(auditEventsTable)
        .values({
          organizationId: org,
          actorUserId,
          action: "estimate.saved_state",
          entityType: "estimate",
          entityId: e.id,
          metadata: metadata(
            previous,
            null,
            1,
            legacy,
            "legacy_returning",
            true,
          ),
        })
        .returning();
      ordered = [
        {
          id: a!.id,
          state: metadata(previous, null, 1, legacy, "legacy_returning", true),
        },
      ];
      anchor = "legacy_returning";
    }
  }
  if (ordered.some((r) => !r.state.intact)) intact = false;
  const last = ordered.at(-1);
  await tx.insert(auditEventsTable).values({
    organizationId: org,
    actorUserId,
    action: "estimate.saved_state",
    entityType: "estimate",
    entityId: e.id,
    metadata: metadata(
      e,
      last?.id ?? null,
      (last?.state.sequence ?? 0) + 1,
      commandId,
      anchor,
      intact,
    ),
  });
}
export async function assertEstimateCleanHistory(
  reader: CustomerWorkReader,
  org: string,
  e: Estimate,
): Promise<void> {
  try {
    if (
      e.organizationId !== org ||
      e.status !== "draft" ||
      e.sentAt ||
      e.acceptedAt
    )
      held();
    const rows = await events(reader, org, e.id),
      ordered = chain(rows);
    if (
      rows.some(
        (r) =>
          r.action === "estimate.status_changed" &&
          r.metadata.status !== "draft",
      )
    )
      held();
    if (!ordered.length) {
      if (!(await legacyAnchor(reader, org, e, rows))) held();
      return;
    }
    if (
      ordered[0]!.state.anchor === "unknown" ||
      ordered.at(-1)!.state.estimateSha256 !== estimateSavedStateDigest(e)
    )
      held();
    if (e.customerWorkId) {
      const commands = await reader
        .select()
        .from(customerWorkCommandsTable)
        .where(
          and(
            eq(customerWorkCommandsTable.organizationId, org),
            eq(customerWorkCommandsTable.estimateId, e.id),
          ),
        );
      if (
        commands.some(
          (c) => ordered.filter((v) => v.state.commandId === c.id).length !== 1,
        )
      )
        held();
    }
    for (let i = 0; i < ordered.length; i++) {
      const s = ordered[i]!.state,
        prior = ordered[i - 1]?.state;
      if (
        !s.intact ||
        s.anchor !== ordered[0]!.state.anchor ||
        s.status !== "draft" ||
        s.sentAt ||
        s.acceptedAt ||
        s.leadId !== e.leadId ||
        s.customerWorkId !== e.customerWorkId ||
        s.createdAt !== e.createdAt.toISOString()
      )
        held();
      if (e.customerWorkId) {
        if (
          !s.workVersion ||
          (i === 0 && s.workVersion !== 1) ||
          (prior &&
            s.workVersion !== prior.workVersion! + 1 &&
            s.workVersion !== prior.workVersion)
        )
          held();
        if (s.commandId) {
          if (
            !(await commandMatches(
              reader,
              org,
              e,
              s.commandId,
              s.workVersion,
              i === 0 ? "estimate_created" : "estimate_updated",
            ))
          )
            held();
        } else if (!prior || s.workVersion !== prior.workVersion) held();
      } else if (s.workVersion !== null || s.commandId !== null) held();
    }
  } catch {
    held();
  }
}
