import { useState } from "react";
import { Link, useLocation, useRoute, useSearch } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getLead, getProject, useGetMe } from "@workspace/api-client-react";
import { ArrowLeft, ArrowRight, Plus, Printer, RefreshCw } from "lucide-react";
import LeadSelect from "@/components/lead-select";
import { InvoiceEditor } from "@/components/invoice-editor";
import { InvoiceActions } from "@/components/invoice-actions";
import { InvoiceDelivery } from "@/components/invoice-delivery";
import { InvoiceDeliveryWorklist } from "@/components/invoice-delivery-worklist";
import { canManageInvoices, canReadInvoices } from "@/lib/permissions";
import { contractorRequest } from "@/lib/contractor-api";
import {
  invoiceRequestStorageKey,
  useInvoiceCommand,
} from "@/hooks/use-invoice-command";
import {
  draftDocument,
  invoiceButton,
  invoiceControl,
  invoicePrimary,
  money,
  paymentLabel,
  printInvoiceDocument,
  type InvoiceDetail,
  type InvoiceDraft,
  type InvoiceList,
  type InvoiceSummary,
} from "@/lib/invoice-ui";

function dateLabel(value: string | null) {
  return value
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(new Date(`${value}T12:00:00Z`))
    : "Not set";
}
type Actor = {
  id: string;
  organizationId: string;
  organizationName: string;
  manage: boolean;
  migrate: boolean;
};
type Command = ReturnType<typeof useInvoiceCommand>;

export function InvoiceCommandNotice({
  command,
  allowRetry = true,
}: {
  command: Command;
  allowRetry?: boolean;
}) {
  if (!command.error && !command.busy) return null;
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-4">
      {command.busy ? (
        <p role="status" className="text-sm">
          Confirming {command.pending?.label.toLowerCase() ?? "the request"}…
        </p>
      ) : (
        <p role="alert" className="text-sm">
          {command.error}
        </p>
      )}
      {command.pending && !command.busy && allowRetry && (
        <button
          className={`${invoiceButton} mt-3`}
          onClick={() => void command.retry()}
        >
          Retry saved request
        </button>
      )}
      {command.pending && !allowRetry && (
        <p className="mt-2 text-sm">
          Your current role is read-only. The saved request is retained for an
          authorized review.
        </p>
      )}
    </div>
  );
}

function Balance({ invoice }: { invoice: InvoiceSummary }) {
  if (invoice.reconciliationRequired)
    return <span className="text-sm font-medium">Needs reconciliation</span>;
  if (invoice.status === "void") return <span>Void</span>;
  return (
    <span className="tabular-nums">
      {invoice.balanceDueCents === null
        ? "Not issued"
        : money(invoice.balanceDueCents)}
    </span>
  );
}

export default function Invoices() {
  const { data: me, isLoading } = useGetMe();
  const [, params] = useRoute("/invoices/:id");
  if (isLoading)
    return (
      <div role="status" className="p-6">
        Checking invoice access…
      </div>
    );
  if (!me?.organization || !canReadInvoices(me.role))
    return (
      <div role="alert" className="p-6">
        <h1 className="text-xl font-semibold">
          Invoices are not available for this role
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          An owner, administrator, office user, or sales manager can view
          customer invoices.
        </p>
        <Link href="/" className={`${invoiceButton} mt-4`}>
          Back to Today
        </Link>
      </div>
    );
  const actor: Actor = {
    id: me.id,
    organizationId: me.organization.id,
    organizationName: me.organization.name,
    manage: canManageInvoices(me.role),
    migrate: me.role === "owner" || me.role === "admin",
  };
  return params?.id ? (
    <InvoiceWorkspace
      key={`${actor.id}:${actor.organizationId}:${params.id}`}
      id={params.id}
      actor={actor}
    />
  ) : (
    <InvoiceIndex key={`${actor.id}:${actor.organizationId}`} actor={actor} />
  );
}

function InvoiceIndex({ actor }: { actor: Actor }) {
  const search = new URLSearchParams(useSearch());
  const projectId = search.get("projectId") || "";
  const leadId = search.get("leadId") || "";
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0);
  const [deliveryView, setDeliveryView] = useState(
    () => search.get("view") === "delivery",
  );
  const [creating, setCreating] = useState(() => {
    try {
      return !!sessionStorage.getItem(
        invoiceRequestStorageKey(actor.id, actor.organizationId, "new"),
      );
    } catch {
      return false;
    }
  });
  const list = useQuery({
    queryKey: [
      "invoices",
      actor.organizationId,
      "list",
      status,
      page,
      projectId,
      leadId,
    ],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ page: String(page) });
      if (status) params.set("status", status);
      if (projectId) params.set("projectId", projectId);
      if (leadId) params.set("leadId", leadId);
      return contractorRequest<InvoiceList>(`/invoices?${params}`, { signal });
    },
    retry: false,
    enabled: !deliveryView,
  });
  return (
    <div className="flex-1 p-4 text-foreground md:p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Invoices</h1>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              Prepare customer invoices and reconcile recorded payments.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {actor.migrate && (
              <Link href="/financial-migrations" className={invoiceButton}>
                Import invoice history
              </Link>
            )}
            {actor.manage && !creating && (
              <button
                className={invoicePrimary}
                onClick={() => setCreating(true)}
              >
                <Plus className="h-4 w-4" aria-hidden />
                New invoice
              </button>
            )}
          </div>
        </header>
        {projectId && (
          <p className="text-sm text-muted-foreground">
            Showing invoices linked to this job. Open an existing draft or
            prepare another invoice for approved work.{" "}
            <Link href="/invoices" className="underline underline-offset-4">
              Show all invoices
            </Link>
          </p>
        )}
        {creating && actor.manage && (
          <CreateInvoice
            actor={actor}
            projectId={projectId}
            initialLeadId={leadId}
            onClose={() => setCreating(false)}
          />
        )}
        <nav
          aria-label="Invoice workspace views"
          className="flex flex-wrap gap-2"
        >
          <button
            className={invoiceButton}
            aria-pressed={!deliveryView}
            onClick={() => setDeliveryView(false)}
          >
            Documents and balances
          </button>
          <button
            className={invoiceButton}
            aria-pressed={deliveryView}
            onClick={() => setDeliveryView(true)}
          >
            Invoice email delivery
          </button>
        </nav>
        {deliveryView ? (
          <InvoiceDeliveryWorklist
            key={`${projectId}:${leadId}`}
            organizationId={actor.organizationId}
            canManage={actor.manage}
            projectId={projectId}
            leadId={leadId}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <label
                  htmlFor="invoice-status"
                  className="mb-1 block text-sm font-medium"
                >
                  Document status
                </label>
                <select
                  id="invoice-status"
                  className={invoiceControl}
                  value={status}
                  onChange={(event) => {
                    setStatus(event.target.value);
                    setPage(0);
                  }}
                >
                  <option value="">All invoices</option>
                  <option value="draft">Drafts</option>
                  <option value="issued">Issued</option>
                  <option value="void">Void</option>
                </select>
              </div>
              <button
                className={invoiceButton}
                disabled={list.isFetching}
                onClick={() => void list.refetch()}
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                Refresh list
              </button>
            </div>
            {list.isPending ? (
              <p role="status">Loading invoices…</p>
            ) : list.isError ? (
              <div
                role="alert"
                className="rounded-xl border border-border bg-card p-5"
              >
                <h2 className="font-semibold">Invoices could not load</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Refresh the list to try again. No empty list or zero balance
                  is being assumed.
                </p>
              </div>
            ) : list.data ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {list.data.total === 0
                    ? "No invoices match this view."
                    : `${list.data.total} invoice${list.data.total === 1 ? "" : "s"} · Page ${list.data.page + 1}`}
                </p>
                {list.data.total === 0 ? (
                  <div className="rounded-xl border border-border bg-card p-6">
                    <h2 className="font-semibold">Start with a draft</h2>
                    <p className="mt-2 max-w-prose text-sm text-muted-foreground">
                      Link approved work to its customer opportunity, review the
                      details, then issue the saved version. No customer message
                      or charge is sent here.
                    </p>
                  </div>
                ) : (
                  <ul
                    aria-label="Customer invoices"
                    className="divide-y divide-border rounded-xl border border-border bg-card"
                  >
                    {list.data.items.map((invoice) => (
                      <li key={invoice.id}>
                        <Link
                          href={`/invoices/${invoice.id}`}
                          className="grid gap-3 p-4 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
                        >
                          <div className="min-w-0">
                            <span className="font-semibold">
                              {invoice.invoiceNumber ??
                                (invoice.status === "void"
                                  ? "Voided draft"
                                  : "Unnumbered draft")}
                            </span>
                            <p className="mt-1 break-words text-sm">
                              {invoice.title}
                            </p>
                            <p className="mt-1 text-xs capitalize text-muted-foreground">
                              {invoice.status}
                              {invoice.status === "issued" ||
                              invoice.reconciliationRequired
                                ? ` · ${paymentLabel(invoice)}`
                                : ""}
                            </p>
                          </div>
                          <div className="min-w-0 text-sm">
                            <p className="break-words font-medium">
                              {invoice.customerName}
                            </p>
                            <p className="mt-1 text-muted-foreground">
                              Due {dateLabel(invoice.dueDate)}
                            </p>
                          </div>
                          <div className="text-sm sm:text-right">
                            <p className="tabular-nums">
                              Total {money(invoice.totalCents)}
                            </p>
                            <p className="mt-1 font-medium">
                              Balance <Balance invoice={invoice} />
                            </p>
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <button
                    className={invoiceButton}
                    disabled={page === 0 || list.isFetching}
                    onClick={() => setPage((current) => current - 1)}
                  >
                    <ArrowLeft className="h-4 w-4" aria-hidden />
                    Previous page
                  </button>
                  <button
                    className={invoiceButton}
                    disabled={
                      (page + 1) * list.data.pageSize >= list.data.total ||
                      list.isFetching
                    }
                    onClick={() => setPage((current) => current + 1)}
                  >
                    Next page
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function CreateInvoice({
  actor,
  projectId,
  initialLeadId,
  onClose,
}: {
  actor: Actor;
  projectId: string;
  initialLeadId: string;
  onClose: () => void;
}) {
  const [, navigate] = useLocation();
  const command = useInvoiceCommand(
    actor.id,
    actor.organizationId,
    "new",
    (result) => navigate(`/invoices/${result.invoice.id}`),
  );
  const saved = command.pending?.body;
  const linkedProject =
    typeof saved?.projectId === "string" ? saved.projectId : projectId;
  const [leadId, setLeadId] = useState(
    typeof saved?.leadId === "string" ? saved.leadId : initialLeadId,
  );
  const project = useQuery({
    queryKey: ["invoice-project", actor.organizationId, linkedProject],
    queryFn: async () => {
      const result = await getProject(encodeURIComponent(linkedProject));
      if (
        result.organizationId !== actor.organizationId ||
        result.id !== linkedProject
      )
        throw new Error("Workspace response mismatch");
      return result;
    },
    enabled: !!linkedProject,
    retry: false,
  });
  const effectiveLead = leadId || project.data?.leadId || "";
  const lead = useQuery({
    queryKey: ["invoice-lead", actor.organizationId, effectiveLead],
    queryFn: async () => {
      const result = await getLead(encodeURIComponent(effectiveLead));
      if (
        result.organizationId !== actor.organizationId ||
        result.id !== effectiveLead
      )
        throw new Error("Workspace response mismatch");
      return result;
    },
    enabled: !!effectiveLead,
    retry: false,
  });
  const savedDocument = saved?.document as InvoiceDraft | undefined;
  const initial: InvoiceDraft = savedDocument ?? {
    title: project.data
      ? `Invoice for ${project.data.name}`
      : "Customer invoice",
    currency: "USD",
    issuerName: actor.organizationName,
    issuerAddress: null,
    customerName: lead.data?.contactName || "",
    customerAddress: null,
    dueDate: null,
    notes: null,
    lineItems: [],
    taxCents: 0,
  };
  const contextLoading =
    (!!linkedProject && project.isPending) ||
    (!!effectiveLead && lead.isPending);
  const contextError =
    (!!linkedProject && project.isError) || (!!effectiveLead && lead.isError);
  return (
    <section
      aria-label="New invoice"
      className="space-y-4 rounded-xl border border-border bg-card p-4 md:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Prepare an invoice</h2>
        <button
          className={invoiceButton}
          disabled={command.busy || !!command.pending}
          onClick={onClose}
        >
          Cancel draft
        </button>
      </div>
      <InvoiceCommandNotice command={command} />
      {contextLoading ? (
        <p role="status">Loading the linked customer and job…</p>
      ) : contextError ? (
        <div role="alert">
          <p>
            The linked record could not load. Refresh it before preparing an
            invoice.
          </p>
          <button
            className={`${invoiceButton} mt-2`}
            onClick={() => {
              void project.refetch();
              void lead.refetch();
            }}
          >
            Refresh linked records
          </button>
        </div>
      ) : (
        <InvoiceEditor
          key={effectiveLead || "unselected"}
          initial={initial}
          disabled={command.locked}
          busy={command.busy}
          onSave={(document) => {
            if (!effectiveLead) return;
            void command.submit(
              "/invoices",
              "POST",
              {
                leadId: effectiveLead,
                ...(linkedProject ? { projectId: linkedProject } : {}),
                document,
              },
              "Save draft",
            );
          }}
        >
          <div>
            <p className="mb-1 text-sm font-medium">Customer opportunity</p>
            {linkedProject ? (
              <p className="rounded-lg bg-muted p-3 text-sm">
                {project.data?.name} ·{" "}
                {lead.data?.contactName ||
                  lead.data?.summary ||
                  "Linked customer opportunity"}
              </p>
            ) : (
              <LeadSelect
                value={effectiveLead}
                onChange={setLeadId}
                required
                withStatus
                testId="invoice-lead-select"
                id="invoice-customer-opportunity"
                label="Customer opportunity"
              />
            )}
          </div>
        </InvoiceEditor>
      )}
    </section>
  );
}

/** Keep the optimistic token paired with the document loaded into this editor. */
function InvoiceDraftEditor({
  invoice,
  command,
}: {
  invoice: InvoiceDetail;
  command: Command;
}) {
  const [base, setBase] = useState(() => ({
    version:
      typeof command.pending?.body.expectedVersion === "number"
        ? command.pending.body.expectedVersion
        : invoice.version,
    document:
      (command.pending?.body.document as InvoiceDraft | undefined) ??
      draftDocument(invoice.document),
  }));
  const changed =
    invoice.version !== base.version || invoice.status !== "draft";
  return (
    <>
      {changed && (
        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
          <p role="alert" className="text-sm">
            {invoice.status === "draft"
              ? `The saved invoice changed from version ${base.version} to ${invoice.version}. Your unsaved edits are retained below, but cannot overwrite the newer document. Discard them and load the latest version before editing again.`
              : `This invoice is now ${invoice.status}. Your unsaved draft is retained below, read-only. Cancel editing to review the saved document.`}
          </p>
          {invoice.status === "draft" && (
            <button
              className={invoiceButton}
              disabled={command.busy || !!command.pending}
              onClick={() => {
                setBase({
                  version: invoice.version,
                  document: draftDocument(invoice.document),
                });
                command.refreshed();
              }}
            >
              Discard my edits and load latest version
            </button>
          )}
        </div>
      )}
      <InvoiceEditor
        key={base.version}
        initial={base.document}
        disabled={command.locked || changed}
        busy={command.busy}
        onSave={(document) => {
          if (changed) return;
          void command.submit(
            `/invoices/${invoice.id}`,
            "PATCH",
            { expectedVersion: base.version, document },
            "Save draft",
          );
        }}
      />
    </>
  );
}

function InvoiceWorkspace({ id, actor }: { id: string; actor: Actor }) {
  const queryClient = useQueryClient();
  const detailKey = ["invoices", actor.organizationId, "detail", id];
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: async ({ signal }) => {
      const result = await contractorRequest<InvoiceDetail>(
        `/invoices/${encodeURIComponent(id)}`,
        { signal },
      );
      if (result.id !== id) throw new Error("Invoice response mismatch");
      return result;
    },
    retry: false,
  });
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState("");
  const command = useInvoiceCommand(
    actor.id,
    actor.organizationId,
    id,
    (result) => {
      queryClient.setQueryData(detailKey, result.invoice);
      setEditing(false);
      setNotice(
        result.duplicate
          ? "The saved request was already completed. Its confirmed result is shown."
          : "Invoice record saved.",
      );
    },
  );
  const invoice = detail.data;
  async function refresh() {
    const result = await detail.refetch();
    if (!result.isError) command.refreshed();
  }
  return (
    <div className="flex-1 p-4 text-foreground md:p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/invoices" className={invoiceButton}>
            <ArrowLeft className="h-4 w-4" aria-hidden />
            All invoices
          </Link>
          <button
            className={invoiceButton}
            disabled={detail.isFetching || command.busy}
            onClick={() => void refresh()}
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            Refresh invoice
          </button>
        </div>
        <InvoiceCommandNotice command={command} allowRetry={actor.manage} />
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        {detail.isPending ? (
          <p role="status">Loading invoice…</p>
        ) : detail.isError ? (
          <div
            role="alert"
            className="rounded-xl border border-border bg-card p-5"
          >
            <h1 className="text-xl font-semibold">
              This invoice could not load
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              It may be unavailable in your company, or the connection failed.
              Refresh to check again.
            </p>
          </div>
        ) : invoice ? (
          <>
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="text-2xl font-bold tracking-tight">
                  {invoice.invoiceNumber ??
                    (invoice.status === "void"
                      ? "Voided draft"
                      : "Draft invoice")}
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {invoice.title} · Version {invoice.version}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="rounded-lg bg-muted px-3 py-2 text-sm font-medium capitalize">
                  {invoice.status}
                </span>
                {invoice.status === "issued" && (
                  <span className="rounded-lg border border-border px-3 py-2 text-sm">
                    {paymentLabel(invoice)}
                  </span>
                )}
              </div>
            </header>
            {actor.manage &&
              invoice.status === "draft" &&
              !editing &&
              !command.pending && (
                <button
                  className={invoiceButton}
                  disabled={command.locked}
                  onClick={() => setEditing(true)}
                >
                  Edit draft
                </button>
              )}
            {actor.manage && (editing || !!command.pending?.body.document) ? (
              <section className="space-y-4 rounded-xl border border-border bg-card p-4 md:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-lg font-semibold">
                    Edit invoice details
                  </h2>
                  <button
                    className={invoiceButton}
                    disabled={command.busy || !!command.pending}
                    onClick={() => setEditing(false)}
                  >
                    Cancel editing
                  </button>
                </div>
                <InvoiceDraftEditor invoice={invoice} command={command} />
              </section>
            ) : (
              <>
                <InvoiceDocumentView invoice={invoice} />
                {invoice.historicalSource && (
                  <aside
                    className="rounded-lg border p-4 text-sm"
                    aria-label="Historical invoice basis"
                  >
                    <p>
                      Historical invoice from{" "}
                      {invoice.historicalSource.sourceSystem}. Original
                      document, number and issue date retained. Import did not
                      send or collect money.
                    </p>
                    {invoice.balanceBasis === "opening_receivable" && (
                      <p className="mt-2">
                        Opening receivable:{" "}
                        {money(invoice.openingReceivableCents ?? 0)} as of{" "}
                        {invoice.openingAsOf}. Historical payments are unknown.
                        Recorded receipts below include only later evidenced
                        payments/refunds; the difference from the original total
                        is not cash.
                      </p>
                    )}
                  </aside>
                )}
              </>
            )}
            {!editing && (
              <section
                aria-label="Invoice balance"
                className="space-y-3 border-y border-border py-5"
              >
                <h2 className="font-semibold">Recorded balance</h2>
                <dl className="grid gap-4 sm:grid-cols-3">
                  <div>
                    <dt className="text-sm text-muted-foreground">
                      Issued total
                    </dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums">
                      {!invoice.issuedAt
                        ? "Not issued"
                        : money(invoice.totalCents)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">
                      {invoice.balanceBasis === "opening_receivable"
                        ? "Recorded receipts after cutoff"
                        : "Recorded net receipts"}
                    </dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums">
                      {money(invoice.recordedPaidCents)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">
                      Balance due
                    </dt>
                    <dd className="mt-1 text-lg font-semibold">
                      <Balance invoice={invoice} />
                    </dd>
                  </div>
                </dl>
                <p className="max-w-prose text-sm text-muted-foreground">
                  Payments shown here are staff-recorded evidence. No bank
                  verification, charge, refund, or customer message is performed
                  by these controls.
                </p>
                {invoice.reconciliationRequired && (
                  <p role="alert" className="text-sm">
                    {money(invoice.unallocatedRefundCents)} in recorded refunds
                    for this customer opportunity need allocation review. The
                    balance is withheld until reconciliation.
                  </p>
                )}
              </section>
            )}
            {actor.manage && !editing && (
              <InvoiceActions invoice={invoice} command={command} />
            )}
            {!editing && (
              <InvoiceDelivery
                key={`${actor.organizationId}:${actor.id}:${invoice.id}`}
                invoice={invoice}
                organizationId={actor.organizationId}
                canManage={actor.manage}
              />
            )}
            <section aria-label="Payment allocations" className="space-y-3">
              <h2 className="text-lg font-semibold">
                Payment and refund allocations
              </h2>
              {invoice.allocations.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No receipts or refunds have been allocated to this invoice.
                </p>
              ) : (
                <ul className="divide-y divide-border rounded-xl border border-border bg-card">
                  {invoice.allocations.map((entry) => (
                    <li key={entry.id} className="space-y-1 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <strong className="break-words text-sm">
                          {entry.sourceReference}
                        </strong>
                        <span className="text-sm tabular-nums">
                          {entry.kind === "refund" ? "Refund" : "Payment"} ·{" "}
                          {money(entry.amountCents)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {new Date(entry.occurredAt).toLocaleString()} ·{" "}
                        {entry.reversedAt
                          ? `Allocation reversed: ${entry.reversalReason}`
                          : "Allocated to this invoice"}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-label="Invoice history" className="space-y-3">
              <h2 className="text-lg font-semibold">Invoice history</h2>
              <ol className="divide-y divide-border">
                {invoice.events.map((event) => (
                  <li key={event.id} className="py-3 text-sm">
                    <p className="font-medium">
                      {event.action.replaceAll("_", " ").replaceAll(".", " · ")}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Version {event.version} ·{" "}
                      {new Date(event.createdAt).toLocaleString()}
                    </p>
                    {event.reason && (
                      <p className="mt-1 break-words text-sm">{event.reason}</p>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

function InvoiceDocumentView({ invoice }: { invoice: InvoiceDetail }) {
  const doc = invoice.document;
  const [printError, setPrintError] = useState("");
  return (
    <section aria-label="Saved invoice document" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          {invoice.issuedAt
            ? "Issued document"
            : invoice.status === "void"
              ? "Voided draft document"
              : "Saved draft"}
        </h2>
        <button
          className={invoiceButton}
          onClick={() => {
            setPrintError("");
            try {
              const element = document.getElementById(
                "customer-invoice-document",
              );
              if (!element) throw new Error("Document unavailable");
              printInvoiceDocument(element);
            } catch {
              setPrintError(
                "Print preview could not open. Try again after allowing printing in this browser.",
              );
            }
          }}
        >
          <Printer className="h-4 w-4" aria-hidden />
          Print / Save PDF
        </button>
      </div>
      <p className="text-sm text-muted-foreground">
        {invoice.issuedAt
          ? "This document is retained as issued. Issuing does not mean it was sent to the customer."
          : invoice.status === "void"
            ? "This unissued draft is retained with its void reason."
            : "Review the saved details before issuing."}
      </p>
      {printError && (
        <p role="alert" className="text-sm text-destructive">
          {printError}
        </p>
      )}
      <article
        id="customer-invoice-document"
        className="space-y-6 rounded-xl border border-border bg-card p-4 md:p-7"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="break-words text-xl font-semibold">
              {doc.issuerName}
            </h3>
            {doc.issuerAddress && (
              <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                {doc.issuerAddress}
              </p>
            )}
          </div>
          <div className="text-sm">
            <p className="font-semibold">
              {invoice.invoiceNumber ?? "DRAFT · Not issued"}
            </p>
            <p className="mt-1">Due: {dateLabel(doc.dueDate)}</p>
            {invoice.status === "void" && (
              <p className="mt-1 font-bold">VOID · {invoice.voidReason}</p>
            )}
          </div>
        </div>
        <div>
          <p className="text-sm font-medium">Bill to</p>
          <p className="mt-1 break-words font-semibold">{doc.customerName}</p>
          {doc.customerAddress && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {doc.customerAddress}
            </p>
          )}
        </div>
        <div>
          <h3 className="mb-3 break-words font-semibold">{doc.title}</h3>
          <div
            className="overflow-x-auto rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            role="region"
            aria-label="Invoice line items; scroll for all columns"
            tabIndex={0}
          >
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Invoice line items in USD</caption>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="py-2 pr-3">
                    Work
                  </th>
                  <th scope="col" className="px-2 py-2 text-right">
                    Qty
                  </th>
                  <th scope="col" className="px-2 py-2 text-right">
                    Price
                  </th>
                  <th scope="col" className="py-2 pl-2 text-right">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {doc.lineItems.map((line, index) => (
                  <tr key={index} className="border-b border-border">
                    <td className="min-w-28 whitespace-pre-wrap break-words py-3 pr-3">
                      {line.description}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {line.quantity}
                    </td>
                    <td className="whitespace-nowrap px-2 py-3 text-right tabular-nums">
                      {money(line.unitPriceCents)}
                    </td>
                    <td className="whitespace-nowrap py-3 pl-2 text-right tabular-nums">
                      {money(line.totalCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {doc.lineItems.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">
              No line items in this draft.
            </p>
          )}
        </div>
        <dl className="ml-auto max-w-xs space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt>Subtotal</dt>
            <dd className="tabular-nums">{money(doc.subtotalCents)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>Tax</dt>
            <dd className="tabular-nums">{money(doc.taxCents)}</dd>
          </div>
          <div className="flex justify-between gap-4 border-t border-border pt-3 text-base font-semibold">
            <dt>Total (USD)</dt>
            <dd className="tabular-nums">{money(doc.totalCents)}</dd>
          </div>
        </dl>
        {doc.notes && (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {doc.notes}
          </p>
        )}
      </article>
    </section>
  );
}
