import { webcrypto } from "node:crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createAppointment,
  getGetMeQueryKey,
  reconcileSchedulingOperation,
  type MemberProfile,
} from "@workspace/api-client-react";
import type { ManualSchedulingCommand } from "@workspace/scheduling-core";
import {
  appointmentCommand,
  acknowledgement,
  enabledContext,
  source,
} from "@/lib/scheduling-ui-contract.fixtures";
import {
  manualSchedulingHash,
  manualSchedulingSourceKey,
} from "@/lib/scheduling-command";
import { useManualSchedulingCommand } from "./use-manual-scheduling-command";

const scope = {
  organizationId: enabledContext.organizationId,
  actorUserId: "staff-synthetic",
  canWrite: true,
};
const sourceKey = manualSchedulingSourceKey(source);
const key = `growthos.scheduling.pending.v1:${scope.organizationId}:${scope.actorUserId}:appointment_create:${sourceKey}`;
const profile: MemberProfile = {
  id: scope.actorUserId,
  email: null,
  firstName: null,
  lastName: null,
  role: "admin",
  isActive: true,
  organization: {
    id: scope.organizationId,
    name: "Synthetic",
    slug: "synthetic",
    timezone: "America/Los_Angeles",
  },
};
const clone = () => structuredClone(appointmentCommand);
const next = () => ({
  ...clone(),
  operationId: "33333333-3333-4333-8333-333333333333",
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function ack(command = appointmentCommand) {
  return {
    ...acknowledgement,
    operationId: command.operationId,
    payloadSha256: await manualSchedulingHash(command, scope),
  };
}
function setup(
  options: {
    member?: MemberProfile | null;
    dispatch?: (c: ManualSchedulingCommand) => Promise<unknown>;
    reconcile?: (c: ManualSchedulingCommand) => Promise<unknown>;
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (options.member !== null)
    client.setQueryData(getGetMeQueryKey(), options.member ?? profile);
  const dispatch = vi.fn(
    options.dispatch ??
      (async () => {
        throw new Error("Lost response");
      }),
  );
  const reconcile = vi.fn(options.reconcile ?? (async (c) => ack(c)));
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    (props) =>
      useManualSchedulingCommand({
        ...props,
        kind: "appointment_create",
        dispatch,
        reconcile,
      }),
    {
      initialProps: { scope: scope as typeof scope | null, sourceKey },
      wrapper,
    },
  );
  return { ...hook, client, dispatch, reconcile };
}
beforeEach(() => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("manual same-tab custody", () => {
  it.each(["read", "quota", "corrupt", "readback"] as const)(
    "holds %s custody failure with zero POST and no evidence overwrite",
    async (mode) => {
      if (mode === "corrupt") sessionStorage.setItem(key, "{broken");
      if (mode === "read")
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
          throw new Error("denied");
        });
      if (mode === "quota")
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
          throw new Error("quota");
        });
      if (mode === "readback")
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(
          () => undefined,
        );
      const h = setup();
      await waitFor(() =>
        expect(["idle", "blocked_custody"]).toContain(
          h.result.current.state.kind,
        ),
      );
      await act(async () => {
        await h.result.current.submit(clone());
      });
      expect(h.result.current.state.kind).toBe("blocked_custody");
      expect(h.dispatch).not.toHaveBeenCalled();
      if (mode === "corrupt")
        expect(sessionStorage.getItem(key)).toBe("{broken");
    },
  );
  it("retains exact wire on loss, blocks replacements, restores without POST, then explicitly reconciles original", async () => {
    const command = clone();
    command.body.scheduledStart = "2035-01-01T09:00:00-08:00";
    if (command.kind === "appointment_create") command.body.propertyId = null;
    const h = setup();
    await waitFor(() => expect(h.result.current.state.kind).toBe("idle"));
    await act(async () => {
      await h.result.current.submit(command);
    });
    expect(h.result.current.state.kind).toBe("unknown");
    expect(h.dispatch).toHaveBeenCalledExactlyOnceWith(command);
    await act(async () => {
      await h.result.current.submit(next());
    });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    h.unmount();
    const restored = setup();
    await waitFor(() =>
      expect(restored.result.current.state.kind).toBe("unknown"),
    );
    expect(restored.dispatch).not.toHaveBeenCalled();
    expect(restored.result.current.state.command).toEqual(command);
    await act(async () => {
      await restored.result.current.reconcileOriginal();
    });
    expect(restored.reconcile).toHaveBeenCalledExactlyOnceWith(command);
    expect(restored.result.current.state.kind).toBe("committed");
    restored.unmount();
    const terminal = setup();
    await waitFor(() =>
      expect(terminal.result.current.state.kind).toBe("committed"),
    );
    expect(terminal.result.current.state.ack?.operationId).toBe(
      command.operationId,
    );
    expect(terminal.dispatch).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ...profile, role: "viewer" },
    { ...profile, role: "invented-role" },
    { ...profile, isActive: false },
    { ...profile, id: "other" },
    {
      ...profile,
      organization: {
        ...profile.organization!,
        id: acknowledgement.operationId,
      },
    },
  ] as (MemberProfile | null)[])(
    "requires real current matching active member cache (%j)",
    async (member) => {
      const h = setup({ member });
      await act(async () => {
        await h.result.current.submit(clone());
      });
      expect(h.dispatch).not.toHaveBeenCalled();
      expect(h.result.current.state.kind).toBe("blocked_scope");
      expect(h.result.current.state.command).toBeUndefined();
    },
  );
  it("hides retained payload immediately on cache error and scope changes, ignores late callbacks", async () => {
    const response = deferred<unknown>();
    const h = setup({ dispatch: () => response.promise });
    await waitFor(() => expect(h.result.current.state.kind).toBe("idle"));
    let running!: Promise<void>;
    act(() => {
      running = h.result.current.submit(clone());
    });
    await waitFor(() => expect(h.dispatch).toHaveBeenCalledTimes(1));
    act(() => {
      h.client
        .getQueryCache()
        .find({ queryKey: getGetMeQueryKey() })!
        .setState({ status: "error", error: new Error("expired") });
    });
    expect(h.result.current.state.kind).toBe("blocked_scope");
    expect(h.result.current.state.command).toBeUndefined();
    await act(async () => {
      response.resolve({ schedulingOperation: await ack() });
      await running;
    });
    expect(h.result.current.state.ack).toBeUndefined();
    expect(JSON.parse(sessionStorage.getItem(key)!).ack).toBeNull();
    h.rerender({ scope: { ...scope, actorUserId: "other" }, sourceKey });
    expect(h.result.current.state.command).toBeUndefined();
  });
  it("freezes caller input before deferred hash and stops POST after authority revocation", async () => {
    const digest = deferred<void>();
    const real = webcrypto.subtle.digest.bind(webcrypto.subtle);
    vi.spyOn(webcrypto.subtle, "digest").mockImplementationOnce(
      async (algorithm, data) => {
        await digest.promise;
        return real(algorithm, data);
      },
    );
    const h = setup();
    await waitFor(() => expect(h.result.current.state.kind).toBe("idle"));
    const command = clone();
    const original = clone();
    let running!: Promise<void>;
    act(() => {
      running = h.result.current.submit(command);
    });
    command.body.scheduledStart = "2040-01-01T00:00:00Z";
    act(() => {
      h.client.setQueryData(getGetMeQueryKey(), {
        ...profile,
        isActive: false,
      });
    });
    await act(async () => {
      digest.resolve();
      await running;
    });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(original.body.scheduledStart).not.toBe(command.body.scheduledStart);
  });
  it.each(['completeness', 'zone'] as const)('fences original dispatch after %s revoke-and-restore during a deferred hash', async (change) => {
    const gate = deferred<void>();
    const real = webcrypto.subtle.digest.bind(webcrypto.subtle);
    vi.spyOn(webcrypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => {
      await gate.promise; return real(algorithm, data);
    });
    const h = setup();
    await waitFor(() => expect(h.result.current.state.kind).toBe('idle'));
    let pending!: Promise<void>;
    act(() => { pending = h.result.current.submit(clone()); });
    act(() => {
      h.client.setQueryData(getGetMeQueryKey(), change === 'completeness' ? { ...profile, firstName: undefined } : { ...profile, organization: { ...profile.organization!, timezone: 'UTC' } });
      h.client.setQueryData(getGetMeQueryKey(), profile);
    });
    await act(async () => { gate.resolve(); await pending; });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBeNull();
  });
  it.each(['completeness', 'zone'] as const)('fences original reconciliation after %s revoke-and-restore during custody verification', async (change) => {
    const h = setup();
    await waitFor(() => expect(h.result.current.state.kind).toBe('idle'));
    await act(async () => { await h.result.current.submit(clone()); });
    const bytes = sessionStorage.getItem(key);
    const gate = deferred<void>();
    const real = webcrypto.subtle.digest.bind(webcrypto.subtle);
    vi.spyOn(webcrypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => {
      await gate.promise; return real(algorithm, data);
    });
    let pending!: Promise<void>;
    act(() => { pending = h.result.current.reconcileOriginal(); });
    act(() => {
      h.client.setQueryData(getGetMeQueryKey(), change === 'completeness' ? { ...profile, firstName: undefined } : { ...profile, organization: { ...profile.organization!, timezone: 'UTC' } });
      h.client.setQueryData(getGetMeQueryKey(), profile);
    });
    await act(async () => { gate.resolve(); await pending; });
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBe(bytes);
  });
  it("uses frozen input across an asynchronous digest, including real native SDK serialization", async () => {
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.scheduledStart).toBe("2035-01-01T17:00:00.000Z");
      return new Response(
        JSON.stringify({ schedulingOperation: await ack() }),
        { headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const h = setup({
      dispatch: async (c) =>
        createAppointment({
          ...c.body,
          operationId: c.operationId,
          schedulingReview: c.review,
        } as Parameters<typeof createAppointment>[0]),
      reconcile: reconcileSchedulingOperation,
    });
    await waitFor(() => expect(h.result.current.state.kind).toBe("idle"));
    const command = clone();
    let running!: Promise<void>;
    act(() => {
      running = h.result.current.submit(command);
    });
    command.body.scheduledStart = "2040-01-01T00:00:00Z";
    await act(async () => {
      await running;
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.result.current.state.kind).toBe("committed");
  });
  it.each(["id", "hash", "source", "generic", "404"] as const)(
    "keeps %s responses unknown and never retries automatically",
    async (mismatch) => {
      const a = await ack();
      const value =
        mismatch === "id"
          ? { ...a, operationId: scope.organizationId }
          : mismatch === "hash"
            ? { ...a, payloadSha256: "f".repeat(64) }
            : mismatch === "source"
              ? {
                  ...a,
                  source: {
                    ...source,
                    sourceKind: "lead",
                    leadId: a.operationId,
                  },
                }
              : {};
      const h = setup({
        dispatch: async () => {
          if (mismatch === "404")
            throw new ApiError(new Response(null, { status: 404 }), null, {
              method: "POST",
              url: "/api/v1/appointments",
            });
          return { schedulingOperation: value };
        },
      });
      await waitFor(() => expect(h.result.current.state.kind).toBe("idle"));
      await act(async () => {
        await h.result.current.submit(clone());
      });
      expect(h.result.current.state.kind).toBe("unknown");
      expect(h.dispatch).toHaveBeenCalledTimes(1);
    },
  );
  it("persists permanent refusal, requires explicit acknowledgement, and never rearms its ID", async () => {
    const refusal = {
      ...(await ack()),
      outcome: "no_commit_refused",
      target: null,
      refusalCode: "original_create_fenced",
    };
    const h = setup({
      dispatch: async () => {
        throw new ApiError(
          new Response(null, { status: 409 }),
          {
            error: "Refused",
            code: "manual_scheduling_refused",
            schedulingOperation: refusal,
          },
          { method: "POST", url: "/api/v1/appointments" },
        );
      },
    });
    await waitFor(() => expect(h.result.current.state.kind).toBe("idle"));
    await act(async () => {
      await h.result.current.submit(clone());
    });
    expect(h.result.current.state.kind).toBe("refused");
    await act(async () => {
      await h.result.current.submit(next());
    });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    act(() => {
      h.result.current.acknowledgeRefusal();
    });
    await act(async () => {
      await h.result.current.submit(clone());
    });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await h.result.current.submit(next());
    });
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });
  it("retains committed-unavailable and allows only a new explicit distinct command", async () => {
    const h = setup({
      dispatch: async (c) => ({
        schedulingOperation: {
          ...(await ack(c)),
          target: { ...acknowledgement.target!, available: false },
        },
      }),
    });
    await waitFor(() => expect(h.result.current.state.kind).toBe("idle"));
    await act(async () => {
      await h.result.current.submit(clone());
    });
    expect(h.result.current.state.kind).toBe("committed");
    expect(h.result.current.state.ack?.target?.available).toBe(false);
    await act(async () => {
      await h.result.current.submit(clone());
    });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await h.result.current.submit(next());
    });
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    await act(async () => {
      await h.result.current.submit(clone());
    });
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });
  it.each(["hash", "scope", "extra", "ack", "missing-original"] as const)(
    "holds %s stored evidence without overwriting it",
    async (damage) => {
      const h = setup();
      await waitFor(() => expect(h.result.current.state.kind).toBe("idle"));
      await act(async () => {
        await h.result.current.submit(clone());
      });
      const stored = JSON.parse(sessionStorage.getItem(key)!);
      if (damage === "hash") stored.payloadSha256 = "f".repeat(64);
      if (damage === "scope") stored.actorUserId = "other";
      if (damage === "extra") stored.extra = true;
      if (damage === "ack")
        stored.ack = { ...(await ack()), actorUserId: "other" };
      if (damage === "missing-original") {
        sessionStorage.removeItem(key);
        await act(async () => {
          await h.result.current.reconcileOriginal();
        });
        expect(h.result.current.state.kind).toBe("blocked_custody");
        expect(h.reconcile).not.toHaveBeenCalled();
        return;
      }
      h.unmount();
      const bytes = JSON.stringify(stored);
      sessionStorage.setItem(key, bytes);
      const restored = setup();
      await waitFor(() =>
        expect(restored.result.current.state.kind).toBe("blocked_custody"),
      );
      await act(async () => {
        await restored.result.current.submit(next());
        await restored.result.current.reconcileOriginal();
      });
      expect(restored.dispatch).not.toHaveBeenCalled();
      expect(restored.reconcile).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(key)).toBe(bytes);
    },
  );
  it("keeps refusal acknowledgement and old ID permanent across remount", async () => {
    const refusal = {
      ...(await ack()),
      outcome: "no_commit_refused",
      target: null,
      refusalCode: "original_create_fenced",
    };
    const h = setup({
      dispatch: async () => ({ schedulingOperation: refusal }),
    });
    await waitFor(() => expect(h.result.current.state.kind).toBe("idle"));
    await act(async () => {
      await h.result.current.submit(clone());
    });
    h.unmount();
    const restored = setup();
    await waitFor(() =>
      expect(restored.result.current.state.kind).toBe("refused"),
    );
    await act(async () => {
      await restored.result.current.submit(next());
    });
    expect(restored.dispatch).not.toHaveBeenCalled();
    act(() => {
      restored.result.current.acknowledgeRefusal();
    });
    restored.unmount();
    const acknowledged = setup({
      dispatch: async (c) => ({ schedulingOperation: await ack(c) }),
    });
    await waitFor(() =>
      expect(acknowledged.result.current.state.kind).toBe("idle"),
    );
    await act(async () => {
      await acknowledged.result.current.submit(clone());
    });
    expect(acknowledged.dispatch).not.toHaveBeenCalled();
    await act(async () => {
      await acknowledged.result.current.submit(next());
    });
    expect(acknowledged.dispatch).toHaveBeenCalledTimes(1);
    expect(acknowledged.result.current.state.kind).toBe("committed");
    await act(async () => {
      await acknowledged.result.current.submit(clone());
    });
    expect(acknowledged.dispatch).toHaveBeenCalledTimes(1);
  });
  it.each(["org", "actor", "source", "permission", "unmount"] as const)(
    "invalidates %s scope during hash before POST",
    async (change) => {
      const real = webcrypto.subtle.digest.bind(webcrypto.subtle),
        pause = deferred<void>();
      vi.spyOn(webcrypto.subtle, "digest").mockImplementationOnce(
        async (algorithm, data) => {
          await pause.promise;
          return real(algorithm, data);
        },
      );
      const h = setup();
      await waitFor(() => expect(h.result.current.state.kind).toBe("idle"));
      let running!: Promise<void>;
      act(() => {
        running = h.result.current.submit(clone());
      });
      if (change === "unmount") h.unmount();
      else
        h.rerender({
          scope:
            change === "org"
              ? { ...scope, organizationId: acknowledgement.operationId }
              : change === "actor"
                ? { ...scope, actorUserId: "other" }
                : change === "permission"
                  ? { ...scope, canWrite: false }
                  : scope,
          sourceKey:
            change === "source"
              ? '["unlinked_manual",null,null,null,"other"]'
              : sourceKey,
        });
      await act(async () => {
        pause.resolve();
        await running;
      });
      expect(h.dispatch).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(key)).toBeNull();
    },
  );
  it("stops POST if writing storage synchronously revokes current authority", async () => {
    const h = setup();
    await waitFor(() => expect(h.result.current.state.kind).toBe("idle"));
    const set = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      k,
      v,
    ) {
      set.call(this, k, v);
      h.client.setQueryData(getGetMeQueryKey(), { ...profile, role: "viewer" });
    });
    await act(async () => {
      await h.result.current.submit(clone());
    });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.result.current.state.command).toBeUndefined();
  });
  it("does not relabel late responses after a source switch, and restores original unknown on return", async () => {
    const response = deferred<unknown>();
    const h = setup({ dispatch: () => response.promise });
    await waitFor(() => expect(h.result.current.state.kind).toBe("idle"));
    let running!: Promise<void>;
    act(() => {
      running = h.result.current.submit(clone());
    });
    await waitFor(() => expect(h.dispatch).toHaveBeenCalledTimes(1));
    h.rerender({ scope, sourceKey: "different" });
    expect(h.result.current.state.command).toBeUndefined();
    await act(async () => {
      response.resolve({ schedulingOperation: await ack() });
      await running;
    });
    h.rerender({ scope, sourceKey });
    await waitFor(() => expect(h.result.current.state.kind).toBe("unknown"));
    expect(h.result.current.state.ack).toBeUndefined();
    expect(h.result.current.state.command).toEqual(appointmentCommand);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });
  it("uses the real generated reconcile parser with original body and no automatic retries", async () => {
    const h = setup({ reconcile: reconcileSchedulingOperation });
    await waitFor(() => expect(h.result.current.state.kind).toBe("idle"));
    await act(async () => {
      await h.result.current.submit(clone());
    });
    const fetch = vi.fn(async (url: unknown, init: RequestInit) => {
      expect(String(url)).toBe("/api/v1/scheduling/operations/reconcile");
      expect(JSON.parse(init.body as string)).toEqual(appointmentCommand);
      return new Response(JSON.stringify(await ack()), {
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    await act(async () => {
      await h.result.current.reconcileOriginal();
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.result.current.state.kind).toBe("committed");
  });
  it("does not replace original terminal evidence if new custody cannot be retained", async () => {
    const h = setup({
      dispatch: async (c) => ({ schedulingOperation: await ack(c) }),
    });
    await waitFor(() => expect(h.result.current.state.kind).toBe("idle"));
    await act(async () => {
      await h.result.current.submit(clone());
    });
    const original = sessionStorage.getItem(key);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    await act(async () => {
      await h.result.current.submit(next());
    });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(key)).toBe(original);
    expect(h.result.current.state.kind).toBe("blocked_custody");
  });
});
