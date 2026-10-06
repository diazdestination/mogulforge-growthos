import { useEffect, useRef, useState } from "react";
import { ContractorApiError, contractorRequest } from "@/lib/contractor-api";
import { useQueryClient } from "@tanstack/react-query";
import { currentMemberAuthorityMatches } from "@/lib/member-authority-scope";
import {
  createCustomerWorkEstimateSchema,
  updateCustomerWorkEstimateSchema,
  createCustomerWorkProjectSchema,
  updateCustomerWorkProjectSchema,
} from "../../../api-server/src/services/returning-customer-contract";

export type SubmittedWorkCommand = {
  path: string;
  method: "POST" | "PATCH";
  body: Record<string, unknown> & { requestId: string };
  label: string;
};
export const customerWorkCommandKey = (
  userId: string,
  organizationId: string,
  target: string,
) => `growthos:customer-work-command:${userId}:${organizationId}:${target}`;
export function readCustomerWorkCommand(
  key: string,
  target: string,
): SubmittedWorkCommand | null {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(key) || "null",
    ) as SubmittedWorkCommand | null;
    const [kind, id] = target.split(":");
    const path = `/customer-work/${kind}${id === "new" ? "" : `/${id}`}`;
    const schema =
      kind === "estimates"
        ? id === "new"
          ? createCustomerWorkEstimateSchema
          : updateCustomerWorkEstimateSchema
        : createCustomerWorkProjectSchema;
    const selected =
      kind === "projects" && id !== "new"
        ? updateCustomerWorkProjectSchema
        : schema;
    return saved &&
      ["estimates", "projects"].includes(kind) &&
      saved.path === path &&
      saved.method === (id === "new" ? "POST" : "PATCH") &&
      typeof saved.label === "string" &&
      selected.safeParse(saved.body).success
      ? saved
      : null;
  } catch {
    return null;
  }
}
/** Only explicitly submitted requests survive a reload. Unknown results retain
 * the original command; never auto-replay or replace its key. */
export function useCustomerWorkCommand<T>({
  userId,
  organizationId,
  scopeKey,
  target,
  parse,
  onSuccess,
}: {
  userId: string;
  organizationId: string;
  scopeKey: string;
  target: string;
  parse: (value: unknown, command: SubmittedWorkCommand) => T;
  onSuccess: (value: T) => void;
}) {
  const key = customerWorkCommandKey(userId, organizationId, target);
  const client = useQueryClient();
  const [pending, setPending] = useState(() =>
    readCustomerWorkCommand(key, target),
  );
  const [busy, setBusy] = useState(false),
    [needsRefresh, setNeedsRefresh] = useState(false),
    [error, setError] = useState(
      pending
        ? "An earlier submitted request has no confirmed result. Reconcile that exact request before making another change."
        : "",
    );
  const state = useRef({
    identity: `${scopeKey}:${target}`,
    active: true,
    running: false,
  });
  if (state.current.identity !== `${scopeKey}:${target}`)
    state.current = {
      identity: `${scopeKey}:${target}`,
      active: true,
      running: false,
    };
  useEffect(() => {
    const original = state.current;
    original.active = true;
    return () => {
      original.active = false;
    };
  }, [scopeKey, target]);
  async function execute(command: SubmittedWorkCommand, reconciling: boolean) {
    const token = state.current;
    if (
      !token.active ||
      token.running ||
      !currentMemberAuthorityMatches(client, scopeKey)
    )
      return;
    try {
      sessionStorage.setItem(key, JSON.stringify(command));
    } catch {
      setError(
        "The browser could not retain this request for recovery. Nothing was submitted.",
      );
      return;
    }
    token.running = true;
    setBusy(true);
    setPending(command);
    setError("");
    const current = () =>
      token === state.current &&
      token.active &&
      currentMemberAuthorityMatches(client, scopeKey);
    try {
      const value = parse(
        await contractorRequest(command.path, {
          method: command.method,
          body: command.body,
        }),
        command,
      );
      if (!current()) return;
      sessionStorage.removeItem(key);
      setPending(null);
      setNeedsRefresh(false);
      onSuccess(value);
    } catch (failure) {
      if (!current()) return;
      // Only a typed current-request refusal is known not to have committed.
      const knownRefusal =
        failure instanceof ContractorApiError &&
        failure.status >= 400 &&
        failure.status < 500 &&
        failure.code.startsWith("customer_work_") &&
        failure.code !== "customer_work_request_conflict" &&
        !(reconciling && [401, 403, 404, 408, 429].includes(failure.status));
      if (knownRefusal) {
        sessionStorage.removeItem(key);
        setPending(null);
        setNeedsRefresh(failure.status === 409);
        setError(
          failure.status === 409
            ? "The saved work or its parents changed. Your entries are retained. Reload the exact record and review before another change."
            : "The request was refused. Your entries are retained; check current access and required fields.",
        );
      } else
        setError(
          "The result is unconfirmed. The exact submitted request is retained in this tab. Reconcile it explicitly; no new work or request key will be created automatically.",
        );
    } finally {
      token.running = false;
      if (current()) setBusy(false);
    }
  }
  return {
    busy,
    pending,
    error,
    needsRefresh,
    locked: busy || !!pending || needsRefresh,
    refreshed: () => setNeedsRefresh(false),
    submit: (
      path: string,
      method: "POST" | "PATCH",
      body: Record<string, unknown>,
      label: string,
    ) => {
      if (pending || needsRefresh || state.current.running) return;
      return execute(
        {
          path,
          method,
          body: { ...body, requestId: crypto.randomUUID() },
          label,
        },
        false,
      );
    },
    retry: () => (pending ? execute(pending, true) : undefined),
  };
}
