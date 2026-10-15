import { webcrypto, createHash } from "node:crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import { memberAuthorityScope } from "@/lib/member-authority-scope";
import {
  workMember,
  workOrg,
  workContact,
  workRoot,
  workId,
} from "@/test/customer-work-fixtures";
import { canonicalCustomerWorkValue } from "../../../api-server/src/services/returning-customer-contract";
import {
  customerWorkCommandKey,
  useCustomerWorkCommand,
} from "./use-customer-work-command";
import { makeSchedulingContext } from "@/test/scheduling-ui-fixtures";

const body = {
  confirmed: true,
  source: {
    kind: "existing_customer",
    contactId: workContact,
    propertyId: null,
  },
  name: "Reviewed repair",
  status: "scheduled",
  scheduledStart: null,
  scheduledEnd: null,
  crewUserIds: [],
  crewNotes: null,
  schedulingReview: {
    context: makeSchedulingContext({
      organizationId: workOrg,
      source: {
        sourceKind: "direct_customer",
        leadId: null,
        contactId: workContact,
        propertyId: null,
        estimateId: null,
      },
    }),
    duration: { kind: "explicit", preset: null },
    startWallTime: null,
    endWallTime: null,
  },
};
const key = customerWorkCommandKey(workMember.id, workOrg, "projects:new");
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function outcome(input: Record<string, unknown>) {
  return {
    formatVersion: 1,
    organizationId: workOrg,
    actorUserId: workMember.id,
    requestId: input.requestId,
    action: "project_created",
    payloadSha256: createHash("sha256")
      .update(
        canonicalCustomerWorkValue({
          action: "project_created",
          targetId: null,
          input,
          actorUserId: workMember.id,
        }),
      )
      .digest("hex"),
    customerWorkId: workRoot,
    target: { kind: "project", id: workId(706), available: false },
    resultWorkVersion: 1,
    outcome: "committed",
  };
}
function setup(member: typeof workMember | null = workMember) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (member) client.setQueryData(getGetMeQueryKey(), member);
  const onSuccess = vi.fn();
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () =>
      useCustomerWorkCommand({
        userId: workMember.id,
        organizationId: workOrg,
        scopeKey: memberAuthorityScope(workMember),
        target: "projects:new",
        parse: (value) => value,
        onSuccess,
      }),
    { wrapper },
  );
  return { ...hook, client, onSuccess };
}
beforeEach(() => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("returning project original-command custody", () => {
  it("migrates only the exact legacy request on explicit retry, preserving raw trim and timestamp spelling", async () => {
    const original = {
      path: "/customer-work/projects",
      method: "POST",
      body: {
        ...body,
        requestId: "AB000000-0000-4000-8000-000000000001",
        name: "  Original raw name  ",
        scheduledStart: "2035-01-01T17:00:00.123456Z",
        scheduledEnd: "2035-01-01T18:00:00.123456Z",
      },
      label: "Original job",
    };
    delete (original.body as any).schedulingReview;
    sessionStorage.setItem(key, JSON.stringify(original));
    const bytes = sessionStorage.getItem(key);
    const fetcher = vi.fn(async () => json({ error: "lost" }, 503));
    vi.stubGlobal("fetch", fetcher);
    const hook = setup();
    await waitFor(() => expect(hook.result.current.pending).toEqual(original));
    expect(fetcher).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBe(bytes);
    await act(async () => {
      await hook.result.current.retry();
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(
      original.body,
    );
    expect(JSON.parse(sessionStorage.getItem(key)!).command).toEqual(original);
  });
  it("keeps committed UUIDs retired after explicit distinct future work and remount", async () => {
    const firstId = "AB000000-0000-4000-8000-000000000001",
      secondId = "AB000000-0000-4000-8000-000000000002";
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(firstId)
      .mockReturnValueOnce(secondId)
      .mockReturnValueOnce(
        firstId.toLowerCase() as `${string}-${string}-${string}-${string}-${string}`,
      );
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
      json(
        {
          error: "Original unavailable",
          code: "customer_work_result_unavailable",
          commandOutcome: outcome(JSON.parse(String(init?.body))),
        },
        409,
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const hook = setup();
    await act(async () => {
      await hook.result.current.submit(
        "/customer-work/projects",
        "POST",
        body,
        "Save job",
      );
    });
    act(() => hook.result.current.prepareSeparate());
    await act(async () => {
      await hook.result.current.submit(
        "/customer-work/projects",
        "POST",
        body,
        "Distinct reviewed job",
      );
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    hook.unmount();
    const restored = setup();
    await waitFor(() =>
      expect(restored.result.current.committed).not.toBeNull(),
    );
    act(() => restored.result.current.prepareSeparate());
    await act(async () => {
      await restored.result.current.submit(
        "/customer-work/projects",
        "POST",
        body,
        "Reused ID",
      );
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(restored.result.current.locked).toBe(true);
  });
  it("keeps the original committed proof when future custody cannot be written", async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => json({
      error: "Original unavailable", code: "customer_work_result_unavailable",
      commandOutcome: outcome(JSON.parse(String(init?.body))),
    }, 409));
    vi.stubGlobal("fetch", fetcher);
    const hook = setup();
    await act(async () => { await hook.result.current.submit("/customer-work/projects", "POST", body, "Original job"); });
    const original = sessionStorage.getItem(key);
    act(() => hook.result.current.prepareSeparate());
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
    await act(async () => { await hook.result.current.submit("/customer-work/projects", "POST", body, "Separate job"); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(key)).toBe(original);
    expect(hook.result.current.committed).toEqual(JSON.parse(original!).outcome);
    hook.unmount();
    const restored = setup();
    await waitFor(() => expect(restored.result.current.committed).toEqual(JSON.parse(original!).outcome));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    "missing authority",
    "corrupt storage",
    "readback mismatch",
  ] as const)("blocks %s before project POST", async (failure) => {
    if (failure === "corrupt storage") sessionStorage.setItem(key, "{broken");
    if (failure === "readback mismatch")
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {});
    const fetcher = vi.fn(async () => {
      throw new Error("lost");
    });
    vi.stubGlobal("fetch", fetcher);
    const hook = setup(failure === "missing authority" ? null : workMember);
    await act(async () => {
      await hook.result.current.submit(
        "/customer-work/projects",
        "POST",
        body,
        "Save job",
      );
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(hook.result.current.locked).toBe(true);
  });
  it("retains a typed unavailable commit and never exposes an original retry after remount", async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body));
      return json(
        {
          error: "Original unavailable",
          code: "customer_work_result_unavailable",
          commandOutcome: outcome(input),
        },
        409,
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const first = setup();
    await act(async () => {
      await first.result.current.submit(
        "/customer-work/projects",
        "POST",
        body,
        "Save job",
      );
    });
    expect(first.result.current.error).toMatch(/committed.*unavailable/i);
    expect(first.result.current.pending).toBeNull();
    expect(first.result.current.locked).toBe(true);
    const bytes = sessionStorage.getItem(key);
    expect(bytes).toContain("payloadSha256");
    first.unmount();
    const restored = setup();
    await waitFor(() =>
      expect(restored.result.current.error).toMatch(/committed.*unavailable/i),
    );
    await act(async () => {
      await restored.result.current.retry();
      await restored.result.current.submit(
        "/customer-work/projects",
        "POST",
        body,
        "Save job",
      );
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(key)).toBe(bytes);
  });
  it("holds generic 409 and preserves the exact frozen original across explicit recovery", async () => {
    const fetcher = vi.fn(async () =>
      json({ error: "Changed", code: "customer_work_version_conflict" }, 409),
    );
    vi.stubGlobal("fetch", fetcher);
    const draft = structuredClone(body);
    const hook = setup();
    await act(async () => {
      await hook.result.current.submit(
        "/customer-work/projects",
        "POST",
        draft,
        "Save job",
      );
    });
    draft.name = "Later draft";
    expect(hook.result.current.pending?.body.name).toBe("Reviewed repair");
    const first = String(fetcher.mock.calls[0]?.[1]?.body);
    hook.unmount();
    const remount = setup();
    await waitFor(() => expect(remount.result.current.pending).not.toBeNull());
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => {
      await remount.result.current.retry();
    });
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).toBe(first);
  });
  it("does not publish a deferred acknowledgement after revoke and restore before React renders", async () => {
    let resolve!: (value: Response) => void;
    let original!: Record<string, unknown>;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init?: RequestInit) => {
        original = JSON.parse(String(init?.body));
        return new Promise<Response>((r) => {
          resolve = r;
        });
      }),
    );
    const hook = setup();
    let pending!: Promise<unknown> | undefined;
    act(() => {
      pending = hook.result.current.submit(
        "/customer-work/projects",
        "POST",
        body,
        "Save job",
      );
    });
    await waitFor(() => expect(resolve).toBeDefined());
    act(() => {
      hook.client.setQueryData(getGetMeQueryKey(), {
        ...workMember,
        isActive: false,
      });
      hook.client.setQueryData(getGetMeQueryKey(), workMember);
    });
    await act(async () => {
      resolve(
        json(
          {
            error: "Original unavailable",
            code: "customer_work_result_unavailable",
            commandOutcome: outcome(original),
          },
          409,
        ),
      );
      await pending;
    });
    expect(hook.onSuccess).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).not.toBeNull();
    expect(JSON.parse(sessionStorage.getItem(key)!).outcome).toBeNull();
  });
});
