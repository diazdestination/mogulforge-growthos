import { webcrypto } from "node:crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import { workMember, workProject } from "@/test/customer-work-fixtures";
import { CustomerWorkForm } from "./customer-work-form";
import { memberAuthorityScope } from "@/lib/member-authority-scope";
import {
  makeSchedulingContext,
  makeSchedulingInterval,
  makeSchedulingDraft,
  makePolicyReadResult,
} from "@/test/scheduling-ui-fixtures";
import {
  useSchedulingAuthority,
  useSchedulingContext,
  useSchedulingReview,
} from "@/hooks/use-scheduling-review";
import { SchedulingIntervalFields } from "./scheduling-interval-fields";
import { formatSchedulingWallTime } from "@workspace/scheduling-core";
import { SchedulingPolicySettings } from "@/pages/settings";
const scope = {
  organizationId: workMember.organization.id,
  actorUserId: workMember.id,
};
const context = makeSchedulingContext({
  organizationId: scope.organizationId,
  policyRevision: 0,
  policyDigest: null,
  applicableRules: {
    newTravelGapMinutes: 0,
    companyCeiling: null,
    inspectionCeiling: 2,
  },
});
function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(getGetMeQueryKey(), workMember);
  return {
    client,
    Wrapper: ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}
beforeEach(() => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("shared scheduling host authority and review", () => {
  it("holds a returning job material edit when current scheduling read fails but keeps historical notes available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        String(input).includes("/users")
          ? Response.json([])
          : Response.json({ error: "offline" }, { status: 503 }),
      ),
    );
    const { Wrapper } = wrapper();
    render(
      <Wrapper>
        <CustomerWorkForm
          kind="projects"
          actor={{
            id: workMember.id,
            organizationId: workMember.organization.id,
            scopeKey: memberAuthorityScope(workMember),
          }}
          record={workProject()}
          onClose={() => {}}
        />
      </Wrapper>,
    );
    await screen.findByText(/Current scheduling review is unavailable/);
    expect(
      (screen.getByLabelText("Crew notes") as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("checkbox", { name: /I reviewed this native work/ }),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Save customer job",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      (
        screen.getByRole("button", {
          name: "Review interval",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("invalidates captured write authority on revoke and restore without waiting for a React commit", () => {
    const { client, Wrapper } = wrapper();
    const hook = renderHook(() => useSchedulingAuthority(scope), {
      wrapper: Wrapper,
    });
    const original = hook.result.current.isCurrent;
    expect(original()).toBe(true);
    act(() => {
      client.setQueryData(getGetMeQueryKey(), {
        ...workMember,
        isActive: false,
      });
      client.setQueryData(getGetMeQueryKey(), workMember);
    });
    expect(original()).toBe(false);
    expect(hook.result.current.isCurrent()).toBe(true);
  });
  it("holds unknown cached roles and a missing profile", () => {
    const { client, Wrapper } = wrapper();
    client.setQueryData(getGetMeQueryKey(), {
      ...workMember,
      role: "invented",
    });
    const hook = renderHook(() => useSchedulingAuthority(scope), {
      wrapper: Wrapper,
    });
    expect(hook.result.current.allowed).toBe(false);
    act(() => {
      client.removeQueries({ queryKey: getGetMeQueryKey() });
    });
    expect(hook.result.current.allowed).toBe(false);
  });
  it("fences incomplete-profile revoke and restore before a React commit", () => {
    const { client, Wrapper } = wrapper();
    const hook = renderHook(() => useSchedulingAuthority(scope), {
      wrapper: Wrapper,
    });
    const original = hook.result.current.isCurrent;
    act(() => {
      client.setQueryData(getGetMeQueryKey(), {
        ...workMember,
        firstName: undefined,
      });
      client.setQueryData(getGetMeQueryKey(), workMember);
    });
    expect(original()).toBe(false);
  });
  it("discards a context read from a former selection", async () => {
    let resolve!: (value: unknown) => void;
    const old = new Promise((r) => {
      resolve = r;
    });
    const { Wrapper } = wrapper();
    const hook = renderHook(
      ({ selection }) => {
        const authority = useSchedulingAuthority(scope);
        return useSchedulingContext({
          authority,
          identity: selection,
          enabled: true,
          load: async () =>
            selection === "old" ? old : { context, policy: null },
        });
      },
      { wrapper: Wrapper, initialProps: { selection: "old" } },
    );
    hook.rerender({ selection: "new" });
    await waitFor(() =>
      expect(hook.result.current.value?.context).toEqual(context),
    );
    await act(async () => {
      resolve({
        context: {
          ...context,
          organizationId: "00000000-0000-4000-8000-000000000999",
        },
        policy: null,
      });
      await old;
    });
    expect(hook.result.current.value?.context).toEqual(context);
  });
  it("keeps a current edit usable after an unchanged context draft echo", () => {
    const { Wrapper } = wrapper();
    const hook = renderHook(() => useSchedulingReview({
      authority: useSchedulingAuthority(scope), identity: "fresh-care", context,
      interval: makeSchedulingInterval(), initialDraft: makeSchedulingDraft({ startAt: null, endAt: null }), transition: "admission",
    }), { wrapper: Wrapper });
    const change = hook.result.current.fields.onDraftChange;
    act(() => {
      change({ ...hook.result.current.draft });
      change({ ...hook.result.current.draft, startAt: "2035-01-01T18:00:00.000Z" });
    });
    expect(hook.result.current.draft.startAt).toBe("2035-01-01T18:00:00.000Z");
    act(() => change({ ...hook.result.current.draft, startAt: "2035-01-02T18:00:00.000Z" }));
    expect(hook.result.current.draft.startAt).toBe("2035-01-01T18:00:00.000Z");
  });
  it("rejects an old draft callback and reviews the exact absolute-end project draft", async () => {
    const { Wrapper } = wrapper();
    let latest!: ReturnType<typeof useSchedulingReview>;
    const interval = makeSchedulingInterval({
      startAt: "2035-01-01T17:00:00.125Z",
      endAt: "2035-01-03T18:30:00.625Z",
      reservation: null,
      evidence: "legacy",
    });
    function Host() {
      const authority = useSchedulingAuthority(scope);
      latest = useSchedulingReview({
        authority,
        identity: "project",
        context,
        interval,
        initialDraft: makeSchedulingDraft({
          startAt: interval.startAt,
          endAt: interval.endAt,
        }),
        transition: "admission",
      });
      return (
        <SchedulingIntervalFields
          {...latest.fields}
          resources={[]}
          presets={[]}
          disabled={false}
          startOnlyBehavior="preserve_absolute_end"
        />
      );
    }
    render(
      <Wrapper>
        <Host />
      </Wrapper>,
    );
    const old = latest.fields.onReviewChange;
    fireEvent.change(screen.getByLabelText("Service start"), {
      target: { value: "2035-01-02T09:00" },
    });
    const draft = latest.draft;
    expect(draft.endAt).toBe("2035-01-03T18:30:00.625Z");
    expect(latest.review).toBeNull();
    act(() =>
      old({
        context,
        duration: { kind: "explicit", preset: null },
        startWallTime: formatSchedulingWallTime(
          interval.startAt!,
          context.companyTimeZone,
        ),
        endWallTime: formatSchedulingWallTime(
          interval.endAt!,
          context.companyTimeZone,
        ),
      }),
    );
    expect(latest.review).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Review interval/ }));
    await waitFor(() => expect(latest.review?.duration.kind).toBe("explicit"));
    expect(latest.draft).toEqual(draft);
  });
});
describe("dedicated scheduling policy host", () => {
  it("keeps failed policy reads held without inventing editable defaults", async () => {
    const { client, Wrapper } = wrapper();
    client.setQueryData(getGetMeQueryKey(), { ...workMember, role: "admin" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    render(
      <Wrapper>
        <SchedulingPolicySettings />
      </Wrapper>,
    );
    await screen.findByText(/Current scheduling review is unavailable/);
    expect(
      (
        screen.getByRole("button", {
          name: /Save scheduling settings/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("retains an unknown PUT and only reads on explicit refresh", async () => {
    const { client, Wrapper } = wrapper();
    client.setQueryData(getGetMeQueryKey(), { ...workMember, role: "admin" });
    const value = makePolicyReadResult();
    value.context.organizationId = scope.organizationId;
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT") throw new Error("lost");
      return Response.json(value);
    });
    vi.stubGlobal("fetch", fetcher);
    render(
      <Wrapper>
        <SchedulingPolicySettings />
      </Wrapper>,
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: /Save scheduling settings/,
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Save scheduling settings/ }),
    );
    await screen.findAllByText(/result is unconfirmed/i);
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === "PUT"),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Refresh scheduling/ }));
    await waitFor(() =>
      expect(
        fetcher.mock.calls.filter(([, init]) => init?.method === "GET"),
      ).toHaveLength(2),
    );
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === "PUT"),
    ).toHaveLength(1);
  });
});

describe('current explanation lifetime fences', () => {
  it.each(['draft', 'source', 'context', 'actor', 'organization', 'malformed'] as const)('discards a late current conflict after %s changes', async change => {
    const { client, Wrapper } = wrapper();
    let resolveResponse!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { resolveResponse = resolve; })));
    const draft = makeSchedulingDraft();
    const options = { identity: 'current-source', context };
    const hook = renderHook(({ identity, context }) => {
      const authority = useSchedulingAuthority();
      return useSchedulingReview({ authority, identity, context, interval: makeSchedulingInterval(), initialDraft: draft, transition: 'admission', explanationScope: { reservationKind: 'appointment', appointmentType: 'other' } });
    }, { wrapper: Wrapper, initialProps: options });
    act(() => hook.result.current.fields.onReviewChange({ context, duration: { kind: 'explicit', preset: null }, startWallTime: formatSchedulingWallTime(draft.startAt!, context.companyTimeZone), endWallTime: formatSchedulingWallTime(draft.endAt!, context.companyTimeZone) }));
    expect(fetch).toHaveBeenCalledTimes(1);
    if (change === 'draft') act(() => hook.result.current.fields.onDraftChange({ ...draft, endAt: '2035-01-01T20:00:00.000Z' }));
    if (change === 'source') hook.rerender({ ...options, identity: 'another-source' });
    if (change === 'context') hook.rerender({ ...options, context: { ...context, companyTimeZone: 'UTC' } });
    if (change === 'actor' || change === 'organization') act(() => client.setQueryData(getGetMeQueryKey(), { ...workMember, ...(change === 'actor' ? { id: 'different-actor' } : { organization: { ...workMember.organization, id: '33333333-3333-4333-8333-333333333333' } }) }));
    await act(async () => resolveResponse(Response.json({ basis: 'current_schedule', evaluatedAt: '2035-01-01T10:00:00.000Z', context, conflict: { reservationKind: 'appointment', reservationId: '22222222-2222-4222-8222-222222222222', resourceUserId: draft.resourceUserIds[0], startAt: '2035-01-01T17:00:00.000Z', endAt: '2035-01-01T18:00:00.000Z', reason: 'resource_overlap', requiredGapMinutes: 0 }, ...(change === 'malformed' ? { operationId: 'forbidden' } : {}) })));
    expect(hook.result.current.conflict).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sessionStorage.length).toBe(0);
  });
});
