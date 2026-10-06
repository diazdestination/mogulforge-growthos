import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ContractorApiError, contractorRequest } from "@/lib/contractor-api";
import type { InvoiceMutation } from "@/lib/invoice-ui";
import { currentMemberAuthorityMatches } from '@/lib/member-authority-scope';

interface SavedCommand {
  path: string;
  method: "POST" | "PATCH";
  label: string;
  body: Record<string, unknown> & { requestId: string };
}
const messages: Record<string, string> = {
  invoice_invalid_request:
    "Check the required fields, amounts and dates. Your entries have been kept.",
  invoice_access_denied:
    "Your current role cannot change invoices. Ask an owner or office administrator.",
  invoice_not_found: "This invoice is not available in your current company.",
  invoice_version_changed:
    "Someone changed this invoice. Refresh it, review the latest version, then confirm your change again. Your entries have been kept.",
  invoice_transition_unavailable:
    "This action is no longer available. Refresh the invoice and review its current state.",
  invoice_payment_conflict:
    "This payment or allocation conflicts with the current balance. Refresh and reconcile the entries before continuing.",
  invoice_receipt_unavailable:
    "That receipt is no longer available to allocate. Refresh the invoice before continuing.",
};
export function invoiceRequestStorageKey(
  userId: string,
  organizationId: string,
  target: string,
) {
  return `growthos:invoice-request:${userId}:${organizationId}:${target}`;
}
function readCommand(key: string, target: string): SavedCommand | null {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(key) ?? "null",
    ) as SavedCommand | null;
    if (
      !value ||
      !/^\/invoices(?:\/[a-zA-Z0-9/-]+)?$/.test(value.path) ||
      !["POST", "PATCH"].includes(value.method) ||
      typeof value.body?.requestId !== "string" ||
      typeof value.label !== "string" ||
      (target === "new"
        ? value.path !== "/invoices"
        : !(
            value.path === `/invoices/${target}` ||
            value.path.startsWith(`/invoices/${target}/`)
          ))
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

/** Persist only an explicitly submitted request in this tab, scoped to its user/company. */
export function useInvoiceCommand(
  userId: string,
  organizationId: string,
  target: string,
  onSuccess: (result: InvoiceMutation) => void,
  scopeKey = `${userId}:${organizationId}`,
) {
  const key = invoiceRequestStorageKey(userId, organizationId, target);
  const [pending, setPending] = useState<SavedCommand | null>(() =>
    readCommand(key, target),
  );
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const authority = useRef({ identity: `${scopeKey}:${target}`, active: true });
  if (authority.current.identity !== `${scopeKey}:${target}`) authority.current = { identity: `${scopeKey}:${target}`, active: true };
  useEffect(() => { const token = authority.current; token.active = true; return () => { token.active = false; }; }, [scopeKey, target]);
  const [error, setError] = useState(
    pending
      ? "A previous request has no confirmed result. Retry the saved request to reconcile it before making another change."
      : "",
  );
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [completed, setCompleted] = useState(0);
  const queryClient = useQueryClient();

  async function execute(command: SavedCommand, reconciling = false) {
    const token = authority.current;
    const current = () => token.active && authority.current === token && currentMemberAuthorityMatches(queryClient, scopeKey);
    if (running.current || !current()) return;
    try {
      sessionStorage.setItem(key, JSON.stringify(command));
    } catch {
      setError(
        "This browser could not preserve the request for safe recovery. No change was submitted. Enable storage for this app and try again.",
      );
      return;
    }
    running.current = true;
    setPending(command);
    setBusy(true);
    setError("");
    try {
      const result = await contractorRequest<InvoiceMutation>(command.path, {
        method: command.method,
        body: command.body,
      });
      const requestedInvoice = command.path.split("/")[2];
      const source = command.body.source as { kind?: string; customerWorkId?: string; contactId?: string; propertyId?: string | null } | undefined;
      if (
        !result.invoice?.id ||
        !Number.isInteger(result.invoice.version) ||
        (requestedInvoice && result.invoice.id !== requestedInvoice) ||
        (result.invoice.organizationId !== undefined && result.invoice.organizationId !== organizationId) ||
        (source && (result.invoice.organizationId !== organizationId || result.invoice.sourceKind !== 'customer_work' || result.invoice.leadId !== null || !result.invoice.customerWorkId || !result.invoice.contactId)) ||
        (source?.kind === 'customer_work' && source.customerWorkId !== result.invoice.customerWorkId) ||
        (source?.kind === 'existing_customer' && (source.contactId !== result.invoice.contactId || source.propertyId !== result.invoice.propertyId)) ||
        (command.body.projectId && command.body.projectId !== result.invoice.projectId) ||
        (command.body.estimateId && command.body.estimateId !== result.invoice.estimateId) ||
        (command.body.leadId && command.body.leadId !== result.invoice.leadId)
      )
        throw new Error("Missing invoice acknowledgement");
      if (!current()) return;
      sessionStorage.removeItem(key);
      setPending(null);
      setNeedsRefresh(false);
      setCompleted((current) => current + 1);
      await queryClient.invalidateQueries({
        queryKey: ["invoices", organizationId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["contractor-day"],
      });
      await queryClient.invalidateQueries({ queryKey: ['customer-workspace'] });
      if (current()) onSuccess(result);
    } catch (failure) {
      if (!current()) return;
      if (
        failure instanceof ContractorApiError &&
        failure.status >= 400 &&
        failure.status < 500 &&
        (failure.code.startsWith('invoice_') || failure.code.startsWith('customer_work_')) &&
        failure.code !== "invoice_request_conflict" &&
        failure.code !== "customer_work_request_conflict" &&
        // A later access denial cannot establish whether the earlier request
        // committed. Retain its identity until an authorized reconciliation.
        !(reconciling && [401, 403, 404, 408, 429].includes(failure.status))
      ) {
        sessionStorage.removeItem(key);
        setPending(null);
        setNeedsRefresh(failure.status === 409);
        setError(
          messages[failure.code] ??
            "The request was rejected. Your entries have been kept; refresh before trying again.",
        );
      } else {
        setError(
          failure instanceof ContractorApiError &&
            [401, 403, 404].includes(failure.status)
            ? "Access no longer permits checking this request. Its earlier result is still unconfirmed and the exact request is retained in this tab. Restore authorized access or ask the office to review its history before creating another entry."
            : "The result could not be confirmed. The exact request has been saved in this tab. Retry it to reconcile the result; no new payment or invoice will be assumed.",
        );
      }
    } finally {
      running.current = false;
      if (current()) setBusy(false);
    }
  }
  return {
    busy,
    pending,
    error,
    needsRefresh,
    completed,
    locked: busy || !!pending || needsRefresh,
    refreshed: () => setNeedsRefresh(false),
    submit: (
      path: string,
      method: "POST" | "PATCH",
      body: Record<string, unknown>,
      label: string,
    ) => {
      if (pending || needsRefresh || busy) return;
      return execute({
        path,
        method,
        body: { ...body, requestId: crypto.randomUUID() },
        label,
      });
    },
    retry: () => (pending ? execute(pending, true) : undefined),
  };
}
