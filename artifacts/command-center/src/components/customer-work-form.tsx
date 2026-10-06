import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  getListEstimatesQueryKey,
  getListProjectsQueryKey,
  getListUsersQueryKey,
  useListUsers,
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
import { useCustomerWorkCommand } from "@/hooks/use-customer-work-command";
import {
  CustomerWorkSource,
  CustomerWorkCommandNotice,
  type CustomerWorkChoice,
} from "./customer-work-source";
import { workdayButton as button, workdayField as field } from "./workday-ui";
import { dollarsToCents } from "@/lib/invoice-ui";
import {
  canAssignWork,
  localDateTime,
  scheduleTimezone,
} from "@/lib/contractor-schedule";
import { customerWorkPath } from "@/lib/customer-work-links";
import { customerWorkspacePath } from "@/lib/customer-workspace-links";
import { contractorRequest } from "@/lib/contractor-api";
import { currentMemberAuthorityMatches } from "@/lib/member-authority-scope";

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
        result.command.requestId !== submitted.body.requestId ||
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
  const [start, setStart] = useState(
      localDateTime(
        (pending?.scheduledStart as string) ?? projectRecord?.scheduledStart,
      ),
    ),
    [end, setEnd] = useState(
      localDateTime(
        (pending?.scheduledEnd as string) ?? projectRecord?.scheduledEnd,
      ),
    );
  const [crew, setCrew] = useState<string[]>(
    (pending?.crewUserIds as string[] | undefined) ??
      projectRecord?.crewUserIds ??
      [],
  );
  const [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState("");
  const [reloading, setReloading] = useState(false);
  const users = useListUsers({
    query: {
      queryKey: [...getListUsersQueryKey(), actor.scopeKey],
      enabled: kind === "projects",
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
              scheduledStart: start ? new Date(start).toISOString() : null,
              scheduledEnd: end ? new Date(end).toISOString() : null,
              crewUserIds: crew,
              crewNotes: notes || null,
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
                      active.current &&
                      currentMemberAuthorityMatches(client, actor.scopeKey);
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
              disabled={command.locked}
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
                  <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                    <label className="block text-sm">
                      Scheduled start
                      <input
                        className={field}
                        type="datetime-local"
                        value={start}
                        onChange={(event) => {
                          setStart(event.target.value);
                          setConfirmed(false);
                        }}
                      />
                    </label>
                    <label className="block text-sm">
                      Scheduled end
                      <input
                        className={field}
                        type="datetime-local"
                        value={end}
                        onChange={(event) => {
                          setEnd(event.target.value);
                          setConfirmed(false);
                        }}
                      />
                    </label>
                  </div>
                  <p className="text-xs">
                    Times use {scheduleTimezone}. Current native crew/capacity
                    checks still apply.
                  </p>
                  <fieldset className="rounded border p-3">
                    <legend className="text-sm">Crew assignment</legend>
                    {users.data?.filter(canAssignWork).map((user) => (
                      <label
                        key={user.id}
                        className="flex min-h-11 items-center gap-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={crew.includes(user.id)}
                          onChange={(event) => {
                            setCrew((values) =>
                              event.target.checked
                                ? [...values, user.id]
                                : values.filter((id) => id !== user.id),
                            );
                            setConfirmed(false);
                          }}
                        />
                        {[user.firstName, user.lastName]
                          .filter(Boolean)
                          .join(" ") || user.email}
                      </label>
                    ))}
                  </fieldset>
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
                disabled={!confirmed || (!original && !choice.confirmed)}
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
