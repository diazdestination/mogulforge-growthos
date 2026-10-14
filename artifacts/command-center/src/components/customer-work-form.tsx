import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  getListEstimatesQueryKey,
  getListProjectsQueryKey,
  getListUsersQueryKey,
  useListUsers,
  getSchedulingReviewContext,
  getSchedulingPolicy,
} from "@workspace/api-client-react";
import {
  customerWorkEstimateSchema,
  customerWorkProjectSchema,
  customerWorkEstimateMutationSchema,
  customerWorkProjectMutationSchema,
  createCustomerWorkEstimateSchema,
  updateCustomerWorkEstimateSchema,
  createCustomerWorkProjectSchema,
  updateCustomerWorkProjectSchema,
  type CustomerWorkEstimate,
  type CustomerWorkProject,
} from "../../../api-server/src/services/returning-customer-contract";
import {
  sameCustomerWorkId,
  useCustomerWorkCommand,
} from "@/hooks/use-customer-work-command";
import {
  useSchedulingAuthority,
  useSchedulingContext,
  useSchedulingReview,
} from "@/hooks/use-scheduling-review";
import {
  classifyReservationTransition,
  effectiveReservation,
  schedulingReviewContextSchema,
  type SchedulingCandidate,
  type ManualSourceRef,
} from "@workspace/scheduling-core";
import { SchedulingIntervalFields } from "./scheduling-interval-fields";
import { SchedulingIntervalReview } from "./scheduling-interval-review";
import { SchedulingReservationSummary } from "./scheduling-reservation-summary";
import { buildSchedulingProposalView } from "@/lib/scheduling-command";
import type { IntervalInput } from "@/lib/scheduling-ui-contract";
import {
  CustomerWorkSource,
  CustomerWorkCommandNotice,
  type CustomerWorkChoice,
} from "./customer-work-source";
import { workdayButton as button, workdayField as field } from "./workday-ui";
import { dollarsToCents } from "@/lib/invoice-ui";
import { canAssignWork } from "@/lib/contractor-schedule";
import { customerWorkPath } from "@/lib/customer-work-links";
import { customerWorkspacePath } from "@/lib/customer-workspace-links";
import { contractorRequest } from "@/lib/contractor-api";

export const returningEstimate = (value: unknown) => {
  const parsed = customerWorkEstimateSchema.safeParse(value);
  return parsed.success && parsed.data.sourceKind === "customer_work"
    ? parsed.data
    : null;
};
export const returningProject = (value: unknown) => {
  const parsed = customerWorkProjectSchema.safeParse(value);
  return parsed.success && parsed.data.sourceKind === "customer_work"
    ? parsed.data
    : null;
};
export type CustomerWorkActor = {
  id: string;
  organizationId: string;
  scopeKey: string;
};
type WorkRecord = CustomerWorkEstimate | CustomerWorkProject;
type FormProps = {
  kind: "estimates" | "projects";
  actor: CustomerWorkActor;
  record?: WorkRecord;
  fromEstimate?: CustomerWorkEstimate;
  contactId?: string;
  onClose: () => void;
  onSaved?: (record: WorkRecord) => void;
  onOpportunity?: () => void;
};
export function CustomerWorkForm(props: FormProps) {
  return (
    <CustomerWorkFormState
      key={`${props.actor.scopeKey}:${props.kind}:${props.record?.id ?? props.fromEstimate?.id ?? "new"}`}
      {...props}
    />
  );
}
function CustomerWorkFormState(props: FormProps) {
  // The exact work version and human draft are one unit. Loading a newer version
  // is an explicit discard, never a side effect of polling.
  const [base, setBase] = useState(props.record),
    [sourceEstimate, setSourceEstimate] = useState(props.fromEstimate),
    [generation, setGeneration] = useState(0);
  return (
    <CustomerWorkFormDraft
      key={`${props.actor.scopeKey}:${props.kind}:${props.record?.id ?? "new"}:${generation}`}
      {...props}
      record={base}
      fromEstimate={sourceEstimate}
      onReload={(native) => {
        if (props.record) setBase(native);
        else if (props.fromEstimate && "lineItems" in native)
          setSourceEstimate(native);
        else return;
        setGeneration((value) => value + 1);
      }}
    />
  );
}
function CustomerWorkFormDraft({
  kind,
  actor,
  record,
  fromEstimate,
  contactId = "",
  onClose,
  onSaved,
  onReload,
  onOpportunity,
}: FormProps & { onReload: (native: WorkRecord) => void }) {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const client = useQueryClient(),
    [saved, setSaved] = useState<WorkRecord | null>(null);
  const authority = useSchedulingAuthority({
    organizationId: actor.organizationId,
    actorUserId: actor.id,
    scopeKey: actor.scopeKey,
  });
  const [receipt, setReceipt] = useState<{
    version: number;
    duplicate: boolean;
  } | null>(null);
  const command = useCustomerWorkCommand<{
    native: WorkRecord;
    receipt: { version: number; duplicate: boolean };
  }>({
    ...actor,
    userId: actor.id,
    target: `${kind}:${record?.id ?? "new"}`,
    parse: (value, submitted) => {
      const result =
        kind === "estimates"
          ? customerWorkEstimateMutationSchema.parse(value)
          : customerWorkProjectMutationSchema.parse(value);
      const native = "estimate" in result ? result.estimate : result.project;
      if (
        result.organizationId !== actor.organizationId ||
        native.organizationId !== actor.organizationId ||
        native.sourceKind !== "customer_work" ||
        !sameCustomerWorkId(
          result.command.requestId,
          submitted.body.requestId,
        ) ||
        result.command.targetId !== native.id ||
        result.command.customerWorkId !== native.customerWorkId ||
        (record &&
          (record.id !== native.id ||
            record.customerWorkId !== native.customerWorkId)) ||
        result.command.action !==
          `${kind === "estimates" ? "estimate" : "project"}_${record ? "updated" : "created"}` ||
        native.workVersion! < result.command.version
      )
        throw new Error(
          "The original work acknowledgement could not be verified.",
        );
      const source = submitted.body.source as
        | {
            kind?: string;
            contactId?: string;
            propertyId?: string | null;
            estimateId?: string;
          }
        | undefined;
      if (
        source?.kind === "existing_customer" &&
        (native.contactId !== source.contactId ||
          native.propertyId !== source.propertyId)
      )
        throw new Error("The acknowledged customer context changed.");
      if (
        source?.kind === "estimate" &&
        ("estimateId" in native
          ? native.estimateId !== source.estimateId
          : true)
      )
        throw new Error("The acknowledged estimate context changed.");
      if (
        source?.kind === "estimate" &&
        fromEstimate &&
        source.estimateId === fromEstimate.id &&
        (native.customerWorkId !== fromEstimate.customerWorkId ||
          native.contactId !== fromEstimate.contactId ||
          native.propertyId !== fromEstimate.propertyId)
      )
        throw new Error("The accepted estimate work context changed.");
      if (
        result.command.version !==
        (record ? Number(submitted.body.expectedWorkVersion) + 1 : 1)
      )
        throw new Error(
          "The original committed work version was not acknowledged.",
        );
      return {
        native,
        receipt: {
          version: result.command.version,
          duplicate: result.command.duplicate,
        },
      };
    },
    onSuccess: ({ native, receipt }) => {
      setSaved(native);
      setReceipt(receipt);
      void client.invalidateQueries({
        queryKey:
          kind === "estimates"
            ? getListEstimatesQueryKey()
            : getListProjectsQueryKey(),
      });
      void client.invalidateQueries({ queryKey: ["customer-workspace"] });
      void client.invalidateQueries({ queryKey: ["contractor-day"] });
      onSaved?.(native);
    },
  });
  const pending = command.pending?.body;
  const pendingSource = pending?.source as
    | { kind?: string; contactId?: string; propertyId?: string | null }
    | undefined;
  const [choice, setChoice] = useState<CustomerWorkChoice>({
    contactId: pendingSource?.contactId ?? contactId,
    propertyId: pendingSource?.propertyId ?? null,
    confirmed: false,
  });
  const [title, setTitle] = useState(
    String(
      pending?.[kind === "estimates" ? "title" : "name"] ??
        (record && ("title" in record ? record.title : record.name)) ??
        fromEstimate?.title ??
        "",
    ),
  );
  const estimateRecord = record && "lineItems" in record ? record : undefined;
  const projectRecord = record && "crewUserIds" in record ? record : undefined;
  const [notes, setNotes] = useState(
    String(
      pending?.[kind === "estimates" ? "notes" : "crewNotes"] ??
        estimateRecord?.notes ??
        projectRecord?.crewNotes ??
        "",
    ),
  );
  const [status, setStatus] = useState(
    String(
      pending?.status ??
        record?.status ??
        (kind === "estimates" ? "draft" : "scheduled"),
    ),
  );
  const [tax, setTax] = useState(
    (Number(pending?.taxCents ?? estimateRecord?.taxCents ?? 0) / 100).toFixed(
      2,
    ),
  );
  const [items, setItems] = useState(() =>
    (
      (pending?.lineItems as CustomerWorkEstimate["lineItems"] | undefined) ??
      estimateRecord?.lineItems ?? [
        { description: "", quantity: 1, unitPriceCents: 0 },
      ]
    ).map((row) => ({
      description: row.description,
      quantity: String(row.quantity),
      price: (row.unitPriceCents / 100).toFixed(2),
    })),
  );
  const selectedContact =
    projectRecord?.contactId ?? fromEstimate?.contactId ?? choice.contactId;
  const selectedProperty =
    projectRecord?.propertyId ?? fromEstimate?.propertyId ?? choice.propertyId;
  const selectedEstimate =
    projectRecord?.estimateId ?? fromEstimate?.id ?? null;
  const selection = JSON.stringify([
    record?.id ?? "new",
    selectedContact,
    selectedProperty,
    selectedEstimate,
    record?.workVersion,
    projectRecord?.schedulingTargetFingerprint,
  ]);
  const read = useSchedulingContext({
    authority,
    identity: selection,
    enabled: kind === "projects" && !!selectedContact && authority.allowed,
    load: async () => {
      const [raw, policy] = await Promise.all([
        getSchedulingReviewContext({
          sourceKind: "direct_customer",
          sourceId: selectedContact!,
          ...(selectedProperty ? { propertyId: selectedProperty } : {}),
          ...(selectedEstimate ? { estimateId: selectedEstimate } : {}),
          reservationKind: "project",
          ...(projectRecord
            ? { targetKind: "project", targetId: projectRecord.id }
            : {}),
        }),
        getSchedulingPolicy(),
      ]);
      const context = schedulingReviewContextSchema.parse(raw),
        source = context.source;
      if (
        !source ||
        source.sourceKind !== "direct_customer" ||
        !sameCustomerWorkId(source.contactId, selectedContact) ||
        !sameCustomerWorkId(source.propertyId, selectedProperty) ||
        !sameCustomerWorkId(source.estimateId, selectedEstimate) ||
        (projectRecord
          ? context.targetVersion !== projectRecord.updatedAt ||
            context.targetFingerprint !==
              projectRecord.schedulingTargetFingerprint
          : context.targetVersion !== null ||
            context.targetFingerprint !== null)
      )
        throw new Error("Customer work source changed");
      return { context, policy: policy.policy };
    },
  });
  const context = read.value?.context ?? null;
  const source: ManualSourceRef = {
    sourceKind: "direct_customer",
    leadId: null,
    contactId: selectedContact || null,
    propertyId: selectedProperty,
    estimateId: selectedEstimate,
  };
  const before: SchedulingCandidate | null = projectRecord
    ? {
        kind: "project",
        id: projectRecord.id,
        startAt: projectRecord.scheduledStart,
        endAt: projectRecord.scheduledEnd,
        resourceUserIds: projectRecord.crewUserIds,
        type: "project",
        status: projectRecord.status,
        source,
        reservation: projectRecord.schedulingReservation,
      }
    : null;
  let legacyEffectiveEnd: string | null = null;
  if (before && before.endAt === null)
    try {
      legacyEffectiveEnd = effectiveReservation(before)?.endAt ?? null;
    } catch {
      /* Invalid saved evidence stays held. */
    }
  const interval: IntervalInput = {
    startAt: before?.startAt ?? null,
    endAt: before?.endAt ?? null,
    legacyEffectiveEnd,
    reservation: projectRecord?.schedulingReservation ?? null,
    evidence: projectRecord?.schedulingEvidence ?? "legacy",
  };
  const review = useSchedulingReview({
    authority,
    identity: selection,
    context,
    interval,
    initialDraft: {
      startAt: interval.startAt,
      endAt: interval.endAt,
      resourceUserIds: projectRecord?.crewUserIds ?? [],
    },
    transition: "admission",
  });
  let transition: "admission" | "release" | "preserve" = "admission";
  if (before)
    try {
      transition = classifyReservationTransition(before, {
        ...before,
        ...review.draft,
        status,
      });
    } catch {
      /* No inferred historical permission. */
    }
  const historical =
    !!projectRecord?.workVersion &&
    !!projectRecord.schedulingTargetFingerprint &&
    transition !== "admission" &&
    (interval.evidence !== "invalid" ||
      JSON.stringify(review.draft.resourceUserIds) ===
        JSON.stringify(projectRecord.crewUserIds) ||
      !["scheduled", "in_progress"].includes(status));
  const proposal = context
    ? buildSchedulingProposalView({
        context,
        interval,
        draft: review.draft,
        transition,
      })
    : null;
  const hydrated = useRef<string | null>(null);
  useEffect(() => {
    if (!pending || hydrated.current === pending.requestId) return;
    hydrated.current = pending.requestId;
    setTitle(String(pending[kind === "projects" ? "name" : "title"]));
    setNotes(
      String(pending[kind === "projects" ? "crewNotes" : "notes"] ?? ""),
    );
    if (pending.status) setStatus(String(pending.status));
    if (kind === "estimates") {
      setTax((Number(pending.taxCents ?? 0) / 100).toFixed(2));
      setItems(
        (pending.lineItems as CustomerWorkEstimate["lineItems"]).map((row) => ({
      description: row.description,
      quantity: String(row.quantity),
      price: (row.unitPriceCents / 100).toFixed(2),
    })),
      );
    }
    if (kind === "projects")
      review.fields.onDraftChange({
        startAt: pending.scheduledStart as string | null,
        endAt: pending.scheduledEnd as string | null,
        resourceUserIds: pending.crewUserIds as string[],
      });
    setConfirmed(false);
  }, [pending?.requestId]);
  const [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState("");
  const [reloading, setReloading] = useState(false);
  const users = useListUsers({
    query: {
      queryKey: [...getListUsersQueryKey(), actor.scopeKey],
      enabled: kind === "projects" && authority.allowed,
    },
  });
  const versionChanged =
    !!record &&
    pending?.expectedWorkVersion !== undefined &&
    pending.expectedWorkVersion !== record.workVersion;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (
      !confirmed ||
      !authority.isCurrent() ||
      (kind === "projects" &&
        !historical &&
        (!review.review || !review.current())) ||
      command.locked ||
      saved ||
      (!record && !fromEstimate && !choice.confirmed)
    )
      return;
    setError("");
    try {
      const common = {
        confirmed: true,
        ...(record
          ? { expectedWorkVersion: record.workVersion }
          : {
              source: fromEstimate
                ? {
                    kind: "estimate",
                    estimateId: fromEstimate.id,
                    expectedWorkVersion: fromEstimate.workVersion,
                  }
                : {
                    kind: "existing_customer",
                    contactId: choice.contactId,
                    propertyId: choice.propertyId,
                  },
            }),
      };
      const values =
        kind === "estimates"
          ? {
              title,
              notes: notes || null,
              taxCents: dollarsToCents(tax),
              lineItems: items.map((item) => ({
                description: item.description,
                quantity: Number(item.quantity),
                unitPriceCents: dollarsToCents(item.price),
              })),
              ...(record ? { status } : {}),
            }
          : {
              name: title,
              status,
              scheduledStart: review.draft.startAt,
              scheduledEnd: review.draft.endAt,
              crewUserIds: review.draft.resourceUserIds,
              crewNotes: notes || null,
              ...(projectRecord
                ? {
                    expectedTargetFingerprint:
                      projectRecord.schedulingTargetFingerprint,
                  }
                : {}),
              ...(!historical && review.review
                ? { schedulingReview: review.review }
                : {}),
            };
      const schema =
        kind === "estimates"
          ? record
            ? updateCustomerWorkEstimateSchema
            : createCustomerWorkEstimateSchema
          : record
            ? updateCustomerWorkProjectSchema
            : createCustomerWorkProjectSchema;
      const { requestId: _unused, ...body } = schema.parse({
        ...common,
        ...values,
        requestId: crypto.randomUUID(),
      });
      await command.submit(
        `/customer-work/${kind}${record ? `/${record.id}` : ""}`,
        record ? "PATCH" : "POST",
        body,
        `Save ${kind === "estimates" ? "estimate" : "job"}`,
      );
    } catch {
      setError(
        "Check the selected customer, title, positive quantities, exact dollar amounts and schedule. Nothing new was submitted.",
      );
    }
  }
  const original =
    record ??
    (command.pending &&
    (pendingSource?.kind !== "estimate" ||
      (pendingSource as { estimateId?: string }).estimateId !==
        fromEstimate?.id)
      ? undefined
      : fromEstimate);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={
        kind === "estimates"
          ? "Existing customer estimate"
          : "Existing customer job"
      }
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-3"
    >
      <div className="max-h-[92vh] w-full min-w-0 max-w-2xl space-y-4 overflow-y-auto rounded-xl border bg-card p-4 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-semibold">
            {record ? "Edit" : "New"}{" "}
            {kind === "estimates" ? "estimate" : "job"} · Existing customer
          </h2>
          <button
            type="button"
            className={button}
            disabled={command.busy}
            onClick={onClose}
          >
            Close work form
          </button>
        </div>
        <CustomerWorkCommandNotice command={command} />
        {command.committed && !saved && (
          <section role="status">
            <p>
              The original job committed.{" "}
              {command.committed.target.available
                ? "Its original proof is retained."
                : "Its display is unavailable; do not recreate it."}
            </p>
            {!record && !command.separate && (
              <button
                type="button"
                className={button}
                onClick={() => {
                  command.prepareSeparate();
                  review.invalidate();
                  setConfirmed(false);
                }}
              >
                Prepare separate new job
              </button>
            )}
          </section>
        )}
        {!saved &&
          !record &&
          !fromEstimate &&
          onOpportunity &&
          !command.locked && (
            <button type="button" className={button} onClick={onOpportunity}>
              Use an existing opportunity instead
            </button>
          )}
        {saved ? (
          <section role="status" className="space-y-3">
            <h3 className="font-semibold">
              Native {kind === "estimates" ? "estimate" : "job"} saved
            </h3>
            <p>
              {receipt?.duplicate
                ? "Original request reconciled"
                : "Original request confirmed"}{" "}
              at work version {receipt?.version}. Current saved work version:{" "}
              {saved.workVersion}.
            </p>
            <p>No acquisition lead, customer message or payment was created.</p>
            <Link
              className={button}
              href={customerWorkPath(kind, saved.id, actor.organizationId)!}
            >
              Open saved {kind === "estimates" ? "estimate" : "job"}
            </Link>
            <Link
              className={button}
              href={customerWorkspacePath(
                saved.contactId,
                actor.organizationId,
                kind,
              )!}
            >
              Return to customer history
            </Link>
          </section>
        ) : (
          <form className="min-w-0 space-y-4" onSubmit={submit}>
            {original && (
              <div className="space-y-1 rounded border p-3 text-sm">
                <p>
                  {original.customerLabel} ·{" "}
                  {original.propertyLabel || "No property linked"}
                </p>
                <p>Fixed work source: {original.customerWorkId}</p>
                {fromEstimate && (
                  <p>
                    Accepted estimate: {fromEstimate.title} · saved version{" "}
                    {fromEstimate.workVersion}
                  </p>
                )}
                <p>
                  Customer, property and original estimate linkage cannot be
                  changed here.
                </p>
              </div>
            )}
            {command.needsRefresh && (
              <div className="space-y-2">
                <p role="alert">
                  Reload the exact saved record before revising this stale
                  request. The current draft is retained below.
                </p>
                <button
                  type="button"
                  className={button}
                  disabled={command.busy || !!command.pending || reloading}
                  onClick={async () => {
                    const current = () =>
                      active.current && authority.isCurrent();
                    if (!current()) return;
                    const original = record ?? fromEstimate;
                    if (!original) {
                      setChoice((value) => ({ ...value, confirmed: false }));
                      setConfirmed(false);
                      command.refreshed();
                      void client.invalidateQueries({
                        queryKey: ["customer-work-customer"],
                      });
                      return;
                    }
                    setReloading(true);
                    setError("");
                    try {
                      const reloadKind = record ? kind : "estimates";
                      const native = (
                        reloadKind === "estimates"
                          ? customerWorkEstimateSchema
                          : customerWorkProjectSchema
                      ).parse(
                        await contractorRequest(
                          `/${reloadKind}/${original.id}`,
                        ),
                      );
                      if (
                        native.id !== original.id ||
                        native.organizationId !== actor.organizationId ||
                        native.customerWorkId !== original.customerWorkId ||
                        native.contactId !== original.contactId ||
                        native.propertyId !== original.propertyId ||
                        (!record &&
                          (native.sourceKind !== "customer_work" ||
                            native.status !== "accepted" ||
                            !native.workVersion))
                      )
                        throw new Error();
                      if (current()) onReload(native);
                    } catch {
                      if (current())
                        setError(
                          "The exact current work record could not be verified. Your draft remains unchanged.",
                        );
                    } finally {
                      if (current()) setReloading(false);
                    }
                  }}
                >
                  {record
                    ? "Discard my edits and load latest work version"
                    : fromEstimate
                      ? "Discard my edits and load latest accepted estimate"
                      : "Review selected customer again"}
                </button>
              </div>
            )}
            {versionChanged && (
              <p role="alert">
                The pending request belongs to an older saved work version.
                Reconcile only that original request.
              </p>
            )}
            <fieldset
              disabled={command.locked || !authority.allowed}
              className="min-w-0 space-y-4 disabled:opacity-70"
            >
              {!original &&
                (command.pending ? (
                  <section
                    aria-label="Original submitted source"
                    className="break-all rounded border p-3 text-sm"
                  >
                    <p>Original source: {String(pendingSource?.kind)}</p>
                    <p>
                      {pendingSource?.kind === "estimate"
                        ? `Accepted estimate ${String((pendingSource as { estimateId?: string }).estimateId)}`
                        : `Customer ${pendingSource?.contactId} · Property ${pendingSource?.propertyId || "deliberately unlinked"}`}
                    </p>
                    <p>Only the original request can be reconciled.</p>
                  </section>
                ) : (
                  <CustomerWorkSource
                    organizationId={actor.organizationId}
                    scopeKey={actor.scopeKey}
                    value={choice}
                    onChange={(value) => {
                      setChoice(value);
                      setConfirmed(false);
                    }}
                    purpose={kind === "estimates" ? "estimate" : "job"}
                    disabled={command.locked}
                  />
                ))}
              <label className="block text-sm">
                {kind === "estimates" ? "Estimate title" : "Job name"}
                <input
                  className={field}
                  required
                  maxLength={kind === "estimates" ? 150 : 200}
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
              {(record || kind === "projects") && (
                <label className="block text-sm">
                  Recorded {kind === "estimates" ? "estimate" : "job"} status
                  <select
                    className={field}
                    value={status}
                    onChange={(event) => {
                      setStatus(event.target.value);
                      review.invalidate();
                      setConfirmed(false);
                    }}
                  >
                    {(kind === "estimates"
                      ? ["draft", "sent", "accepted", "declined"]
                      : [
                          "scheduled",
                          "in_progress",
                          "on_hold",
                          "completed",
                          "cancelled",
                        ]
                    ).map((value) => (
                      <option key={value} value={value}>
                        {value.replaceAll("_", " ")}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {kind === "estimates" ? (
                <>
                  <p className="text-sm">
                    Sent and accepted are staff-recorded facts, not email
                    delivery, customer signature or payment.
                  </p>
                  {items.map((item, index) => (
                    <div
                      key={index}
                      className="min-w-0 space-y-2 rounded border p-3"
                    >
                      <label className="block text-sm">
                        Line {index + 1} description
                        <input
                          className={field}
                          maxLength={1000}
                          required
                          value={item.description}
                          onChange={(event) => {
                            setItems((rows) =>
                              rows.map((row, n) =>
                                n === index
                                  ? { ...row, description: event.target.value }
                                  : row,
                              ),
                            );
                            setConfirmed(false);
                          }}
                        />
                      </label>
                      <div className="grid min-w-0 grid-cols-2 gap-2">
                        <label className="block text-sm">
                          Line {index + 1} quantity
                          <input
                            className={field}
                            required
                            inputMode="decimal"
                            value={item.quantity}
                            onChange={(event) => {
                              setItems((rows) =>
                                rows.map((row, n) =>
                                  n === index
                                    ? { ...row, quantity: event.target.value }
                                    : row,
                                ),
                              );
                              setConfirmed(false);
                            }}
                          />
                        </label>
                        <label className="block text-sm">
                          Line {index + 1} unit price (USD)
                          <input
                            className={field}
                            required
                            inputMode="decimal"
                            value={item.price}
                            onChange={(event) => {
                              setItems((rows) =>
                                rows.map((row, n) =>
                                  n === index
                                    ? { ...row, price: event.target.value }
                                    : row,
                                ),
                              );
                              setConfirmed(false);
                            }}
                          />
                        </label>
                      </div>
                      <button
                        type="button"
                        className={button}
                        disabled={items.length === 1}
                        onClick={() => {
                          setItems((rows) =>
                            rows.filter((_, n) => n !== index),
                          );
                          setConfirmed(false);
                        }}
                      >
                        Remove line {index + 1}
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className={button}
                    disabled={items.length >= 100}
                    onClick={() => {
                      setItems((rows) => [
                        ...rows,
                        { description: "", quantity: "1", price: "0.00" },
                      ]);
                      setConfirmed(false);
                    }}
                  >
                    Add estimate line
                  </button>
                  <label className="block text-sm">
                    Tax amount (USD)
                    <input
                      className={field}
                      inputMode="decimal"
                      required
                      value={tax}
                      onChange={(event) => {
                        setTax(event.target.value);
                        setConfirmed(false);
                      }}
                    />
                  </label>
                </>
              ) : (
                <>
                  {read.error && (
                    <p role="status">
                      {read.error} Historical notes, closure and eligible saved
                      crew removal remain available.
                    </p>
                  )}
                  <button
                    type="button"
                    className={button}
                    onClick={() => void read.refresh()}
                  >
                    Refresh scheduling review
                  </button>
                  <SchedulingIntervalFields
                    {...review.fields}
                    resources={(users.data ?? [])
                      .filter(canAssignWork)
                      .map((user) => ({
                        id: user.id,
                        label:[user.firstName, user.lastName]
                          .filter(Boolean)
                          .join(" ") || user.email ||
                          user.id,
                      }))}
                    presets={read.value?.policy?.durationPresets ?? []}
                    disabled={command.locked}
                    startOnlyBehavior="preserve_absolute_end"
                  />
                  {!review.draft.startAt && !review.draft.endAt && context && (
                    <button
                      type="button"
                      className={button}
                      onClick={() =>
                        review.fields.onReviewChange({
                          context,
                          duration: { kind: "explicit", preset: null },
                          startWallTime: null,
                          endWallTime: null,
                        })
                      }
                    >
                      Review unscheduled job
                    </button>
                  )}
                  {projectRecord &&
                    !context &&
                    interval.evidence !== "invalid" &&
                    review.draft.resourceUserIds.map((id) => (
                      <button
                        type="button"
                        className={button}
                        key={id}
                        onClick={() =>
                          review.fields.onDraftChange({
                            ...review.draft,
                            resourceUserIds:
                              review.draft.resourceUserIds.filter(
                                (value) => value !== id,
                              ),
                          })
                        }
                      >
                        Remove {id} from saved crew
                      </button>
                    ))}
                  <SchedulingIntervalReview
                    companyTimeZone={
                      context?.companyTimeZone ??
                      authority.profile?.organization?.timezone ??
                      null
                    }
                    interval={interval}
                    proposal={proposal}
                    resources={[]}
                    conflict={null}
                  />
                  {projectRecord && (
                    <SchedulingReservationSummary
                      companyTimeZone={
                        context?.companyTimeZone ??
                        authority.profile?.organization?.timezone ??
                        null
                      }
                      interval={interval}
                      proposal={proposal}
                      resources={[]}
                      conflict={null}
                    />
                  )}
                </>
              )}
              <label className="block text-sm">
                {kind === "estimates" ? "Estimate notes" : "Crew notes"}
                <textarea
                  className={field}
                  maxLength={kind === "estimates" ? 2000 : 4000}
                  value={notes}
                  onChange={(event) => {
                    setNotes(event.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                I reviewed this native work and its recorded status. This does
                not send, sign or collect payment.
              </label>
              {error && (
                <p role="alert" className="text-sm">
                  {error}
                </p>
              )}
              <button
                className={button}
                disabled={
                  !confirmed ||
                  (!original && !choice.confirmed) ||
                  (kind === "projects" && !historical && !review.review)
                }
                type="submit"
              >
                Save customer {kind === "estimates" ? "estimate" : "job"}
              </button>
            </fieldset>
          </form>
        )}
      </div>
    </div>
  );
}
