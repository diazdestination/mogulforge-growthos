import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetMeQueryKey,
  UserRole,
  type MemberProfile,
} from "@workspace/api-client-react";
import type {
  ManualSchedulingAck,
  ManualSchedulingCommand,
} from "@workspace/scheduling-core";
import { canWrite } from "@/lib/permissions";
import { useSchedulingAuthority } from "./use-scheduling-review";
import {
  freezeManualSchedulingCommand,
  freezeSchedulingValue,
  manualSchedulingAckFor,
  manualSchedulingHash,
  parseManualSchedulingCustody,
  type ManualSchedulingCustody,
} from "@/lib/scheduling-command";
import type { SchedulingScope } from "@/lib/scheduling-ui-contract";

export type ManualSchedulingCommandState = {
  kind:
    | "idle"
    | "preparing"
    | "submitting"
    | "unknown"
    | "reconciling"
    | "committed"
    | "refused"
    | "blocked_custody"
    | "blocked_scope";
  command?: ManualSchedulingCommand;
  ack?: ManualSchedulingAck;
};
type Options = {
  scope: (SchedulingScope & { canWrite: boolean }) | null;
  kind: ManualSchedulingCommand["kind"];
  sourceKey: string;
  /** Use the native pure SDK function; do not wrap in a retrying mutation. */
  dispatch: (command: ManualSchedulingCommand) => Promise<unknown>;
  reconcile: (original: ManualSchedulingCommand) => Promise<unknown>;
};
type Token = {
  identity: string;
  authority: string;
  active: boolean;
  running: boolean;
  loaded: boolean;
  bytes: string | null;
  custody: ManualSchedulingCustody | null;
  state: ManualSchedulingCommandState;
};
const outcome = (
  saved: ManualSchedulingCustody,
): ManualSchedulingCommandState => ({
  kind:
    saved.ack?.outcome === "committed"
      ? "committed"
      : saved.ack
        ? saved.refusalAcknowledged
          ? "idle"
          : "refused"
        : "unknown",
  command: saved.command,
  ...(saved.ack ? { ack: saved.ack } : {}),
});

/** One same-tab original, with explicit reconciliation only. No timer, retry,
 * fresh UUID, policy refresh, or mutation is triggered by mount/cache changes. */
export function useManualSchedulingCommand({
  scope,
  kind,
  sourceKey,
  dispatch,
  reconcile,
}: Options) {
  const client = useQueryClient();
  const strictAuthority = useSchedulingAuthority(scope ? {
    organizationId: scope.organizationId, actorUserId: scope.actorUserId,
  } : null);
  const tokenRef = useRef<Token | null>(null);
  const [, rerender] = useState(0);
  const snapshot = useCallback(() => {
    const query = client.getQueryState<MemberProfile>(getGetMeQueryKey());
    const p = query?.data;
    return JSON.stringify([
      query?.status ?? null,
      p?.id ?? null,
      p?.organization?.id ?? null,
      p?.role ?? null,
      p?.isActive ?? null,
    ]);
  }, [client]);
  const subscribe = useCallback(
    (notify: () => void) =>
      client.getQueryCache().subscribe(() => {
        // Invalidate even a revoke-and-restore sequence before React renders.
        if (tokenRef.current && tokenRef.current.authority !== snapshot())
          tokenRef.current.active = false;
        notify();
      }),
    [client, snapshot],
  );
  const authority = useSyncExternalStore(subscribe, snapshot, snapshot);
  const identity = JSON.stringify([
    scope?.organizationId ?? null,
    scope?.actorUserId ?? null,
    scope?.canWrite ?? false,
    kind,
    sourceKey,
    authority,
    strictAuthority.identity,
  ]);
  const allowed = () => {
    const query = client.getQueryState<MemberProfile>(getGetMeQueryKey());
    const p = query?.data;
    return (
      strictAuthority.isCurrent() &&
      scope?.canWrite === true &&
      query?.status === "success" &&
      !!p &&
      p.isActive === true &&
      p.id === scope.actorUserId &&
      p.organization?.id === scope.organizationId &&
      Object.values(UserRole).includes(p.role) &&
      canWrite(p.role) &&
      !p.id.startsWith("invite:")
    );
  };
  if (
    !tokenRef.current ||
    tokenRef.current.identity !== identity ||
    !tokenRef.current.active
  ) {
    if (tokenRef.current) tokenRef.current.active = false;
    tokenRef.current = {
      identity,
      authority,
      active: true,
      running: false,
      loaded: false,
      bytes: null,
      custody: null,
      state: { kind: allowed() ? "preparing" : "blocked_scope" },
    };
  }
  const token = tokenRef.current;
  const key = scope
    ? `growthos.scheduling.pending.v1:${scope.organizationId}:${scope.actorUserId}:${kind}:${sourceKey}`
    : "";
  const current = () =>
    tokenRef.current === token &&
    token.active &&
    token.authority === snapshot() &&
    allowed();
  const publish = (state: ManualSchedulingCommandState) => {
    if (!current()) return;
    token.state = freezeSchedulingValue(state);
    rerender((n) => n + 1);
  };
  const block = () =>
    publish({
      kind: "blocked_custody",
      ...(token.custody
        ? {
            command: token.custody.command,
            ...(token.custody.ack ? { ack: token.custody.ack } : {}),
          }
        : {}),
    });

  useEffect(() => {
    token.active = true;
    if (!current() || !scope)
      return () => {
        token.active = false;
      };
    let cancelled = false;
    void (async () => {
      try {
        const bytes = sessionStorage.getItem(key);
        const saved =
          bytes === null
            ? null
            : await parseManualSchedulingCustody(bytes, scope, kind, sourceKey);
        if (cancelled || !current()) return;
        if (sessionStorage.getItem(key) !== bytes)
          throw new Error("Custody changed during restoration");
        token.bytes = bytes;
        token.custody = saved;
        token.loaded = true;
        publish(saved ? outcome(saved) : { kind: "idle" });
      } catch {
        if (!cancelled) block();
      }
    })();
    return () => {
      cancelled = true;
      token.active = false;
    };
    // Identity includes semantic scope/authority, not changing callback objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, token]);

  async function write(saved: ManualSchedulingCustody) {
    if (!current() || !scope) return false;
    if (sessionStorage.getItem(key) !== token.bytes)
      throw new Error("Custody changed");
    const bytes = JSON.stringify(saved);
    sessionStorage.setItem(key, bytes);
    if (!current()) return false;
    const returned = sessionStorage.getItem(key);
    if (returned !== bytes) throw new Error("Custody write/readback mismatch");
    const validated = await parseManualSchedulingCustody(
      returned,
      scope,
      kind,
      sourceKey,
    );
    if (!current()) return false;
    if (sessionStorage.getItem(key) !== bytes)
      throw new Error("Custody changed before dispatch");
    token.bytes = bytes;
    token.custody = validated;
    return true;
  }
  async function execute(
    saved: ManualSchedulingCustody,
    mode: "dispatch" | "reconcile",
  ) {
    if (!current() || !scope) return;
    publish({
      kind: mode === "dispatch" ? "submitting" : "reconciling",
      command: saved.command,
    });
    // These functions are called once. HTTP status alone never resolves custody.
    let response: unknown;
    try {
      response = await (mode === "dispatch" ? dispatch : reconcile)(
        saved.command,
      );
    } catch (error) {
      response = error;
    }
    if (!current()) return;
    const ack = manualSchedulingAckFor(
      response,
      mode,
      saved.command,
      scope,
      saved.payloadSha256,
    );
    if (!ack) {
      publish({ kind: "unknown", command: saved.command });
      return;
    }
    if (await write({ ...saved, ack })) publish(outcome(token.custody!));
  }
  async function submit(original: ManualSchedulingCommand): Promise<void> {
    if (
      !current() ||
      !scope ||
      token.running ||
      !token.loaded ||
      token.state.kind === "blocked_custody"
    )
      return;
    const prior = token.custody;
    if (
      prior &&
      (!prior.ack ||
        (prior.ack.outcome === "no_commit_refused" &&
          !prior.refusalAcknowledged))
    )
      return;
    // Freeze caller-owned objects synchronously, before any hash/storage await.
    let command: ManualSchedulingCommand;
    try {
      command = freezeManualSchedulingCommand(original, scope, kind, sourceKey);
    } catch {
      block();
      return;
    }
    if (
      prior &&
      (command.operationId === prior.command.operationId ||
        prior.retiredOperationIds.includes(command.operationId))
    )
      return;
    token.running = true;
    publish({
      kind: "preparing",
      ...(prior
        ? { command: prior.command, ...(prior.ack ? { ack: prior.ack } : {}) }
        : {}),
    });
    try {
      const payloadSha256 = await manualSchedulingHash(command, scope);
      if (!current()) return;
      const saved: ManualSchedulingCustody = {
        formatVersion: 1,
        organizationId: scope.organizationId,
        actorUserId: scope.actorUserId,
        kind,
        sourceKey,
        command,
        payloadSha256,
        ack: null,
        refusalAcknowledged: false,
        retiredOperationIds: prior
          ? [...prior.retiredOperationIds, prior.command.operationId]
          : [],
      };
      if (await write(saved)) await execute(token.custody!, "dispatch");
    } catch {
      block();
    } finally {
      token.running = false;
    }
  }
  async function reconcileOriginal(): Promise<void> {
    if (
      !current() ||
      !scope ||
      token.running ||
      !token.custody ||
      token.custody.ack
    )
      return;
    token.running = true;
    try {
      const bytes = sessionStorage.getItem(key);
      if (!bytes || bytes !== token.bytes)
        throw new Error("Original custody is unavailable");
      const saved = await parseManualSchedulingCustody(
        bytes,
        scope,
        kind,
        sourceKey,
      );
      if (!current()) return;
      if (sessionStorage.getItem(key) !== bytes)
        throw new Error("Original custody changed");
      await execute(saved, "reconcile");
    } catch {
      block();
    } finally {
      token.running = false;
    }
  }
  function acknowledgeRefusal(): void {
    const saved = token.custody;
    if (
      !current() ||
      token.running ||
      !saved ||
      saved.ack?.outcome !== "no_commit_refused" ||
      saved.refusalAcknowledged
    )
      return;
    // All data was already validated; this synchronous acknowledgement has no
    // transport and does not change the original command or its terminal proof.
    try {
      if (sessionStorage.getItem(key) !== token.bytes)
        throw new Error("Custody changed");
      const changed = freezeSchedulingValue({
        ...saved,
        refusalAcknowledged: true,
      });
      const bytes = JSON.stringify(changed);
      sessionStorage.setItem(key, bytes);
      if (!current()) return;
      if (sessionStorage.getItem(key) !== bytes)
        throw new Error("Custody readback mismatch");
      token.custody = changed;
      token.bytes = bytes;
      publish(outcome(changed));
    } catch {
      block();
    }
  }
  return {
    state: current() ? token.state : { kind: "blocked_scope" as const },
    submit,
    reconcileOriginal,
    acknowledgeRefusal,
  };
}
