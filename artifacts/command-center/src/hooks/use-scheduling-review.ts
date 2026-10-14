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
import {
  schedulingMutationReviewSchema,
  schedulingPolicySchema,
  schedulingReviewContextSchema,
  validateWallTime,
} from "@workspace/scheduling-core";
import { canManageSettings, canWrite } from "@/lib/permissions";
import { memberAuthorityScope } from "@/lib/member-authority-scope";
import {
  buildSchedulingProposalView,
  freezeSchedulingValue,
} from "@/lib/scheduling-command";
import type {
  IntervalInput,
  PolicyReadResult,
  SchedulingDraft,
  SchedulingIntervalFieldsProps,
  SchedulingMutationReview,
  SchedulingReviewContext,
} from "@/lib/scheduling-ui-contract";

function completeProfile(p: MemberProfile | undefined): p is MemberProfile {
  const nullableText = (value: unknown) =>
    value === null || typeof value === "string";
  return (
    !!p &&
    typeof p.id === "string" &&
    !!p.id &&
    nullableText(p.email) &&
    nullableText(p.firstName) &&
    nullableText(p.lastName) &&
    typeof p.isActive === "boolean" &&
    Object.values(UserRole).includes(p.role) &&
    !!p.organization &&
    typeof p.organization.id === "string" &&
    !!p.organization.id &&
    typeof p.organization.name === "string" &&
    typeof p.organization.slug === "string" &&
    typeof p.organization.timezone === "string"
  );
}

/** Current cached membership is authority; a supplied scope only constrains it. */
export function useSchedulingAuthority(
  scope?: {
    organizationId: string;
    actorUserId: string;
    scopeKey?: string;
  } | null,
  permission: "write" | "manage" = "write",
) {
  const client = useQueryClient(),
    epoch = useRef(0),
    mounted = useRef(true);
  const snapshot = useCallback(() => {
    const q = client.getQueryState<MemberProfile>(getGetMeQueryKey()),
      p = q?.data;
    return JSON.stringify([
      q?.status,
      completeProfile(p),
      p && memberAuthorityScope(p),
      p?.organization?.timezone,
    ]);
  }, [client]);
  const observed = useRef(snapshot());
  const subscribe = useCallback(
    (notify: () => void) =>
      client.getQueryCache().subscribe(() => {
        const next = snapshot();
        if (next !== observed.current) {
          observed.current = next;
          epoch.current++;
        }
        notify();
      }),
    [client, snapshot],
  );
  const reactiveSnapshot = useCallback(
    () => JSON.stringify([snapshot(), epoch.current]),
    [snapshot],
  );
  const value = useSyncExternalStore(
      subscribe,
      reactiveSnapshot,
      reactiveSnapshot,
    ),
    capturedEpoch = epoch.current;
  const scopeIdentity = JSON.stringify([scope ?? null, permission]),
    currentScope = useRef(scopeIdentity);
  currentScope.current = scopeIdentity;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const currentProfile = () => {
    const q = client.getQueryState<MemberProfile>(getGetMeQueryKey()),
      p = q?.data;
    if (
      q?.status !== "success" ||
      !completeProfile(p) ||
      p.isActive !== true ||
      !p.organization ||
      p.id.startsWith("invite:") ||
      !(permission === "manage" ? canManageSettings(p.role) : canWrite(p.role))
    )
      return null;
    if (
      scope &&
      (p.id !== scope.actorUserId ||
        p.organization.id !== scope.organizationId ||
        (scope.scopeKey !== undefined &&
          scope.scopeKey !== memberAuthorityScope(p)))
    )
      return null;
    return p;
  };
  const isCurrent = () =>
    mounted.current &&
    capturedEpoch === epoch.current &&
    value === reactiveSnapshot() &&
    scopeIdentity === currentScope.current &&
    currentProfile() !== null;
  const profile = currentProfile();
  return {
    allowed: isCurrent(),
    profile,
    identity: JSON.stringify([value, capturedEpoch, scopeIdentity]),
    isCurrent,
  };
}
export type SchedulingAuthority = ReturnType<typeof useSchedulingAuthority>;

/** Adapter validates its own source selection; this hook only fences read lifetime. */
export function useSchedulingContext({
  authority,
  identity,
  enabled,
  load,
}: {
  authority: SchedulingAuthority;
  identity: string;
  enabled: boolean;
  load: () => Promise<unknown>;
}) {
  const [, render] = useState(0),
    revision = useRef(0);
  const key = JSON.stringify([identity, authority.identity, enabled]);
  const state = useRef<{
    key: string;
    value: PolicyReadResult | null;
    error: string;
    loading: boolean;
    generation: number;
  }>({ key, value: null, error: "", loading: false, generation: 0 });
  if (state.current.key !== key)
    state.current = {
      key,
      value: null,
      error: "",
      loading: false,
      generation: ++revision.current,
    };
  const token = state.current;
  const refresh = async () => {
    const generation = ++revision.current;
    token.generation = generation;
    token.value = null;
    token.error = "";
    token.loading = true;
    render((n) => n + 1);
    const current = () =>
      state.current === token &&
      token.generation === generation &&
      authority.isCurrent();
    if (!enabled || !current()) {
      token.loading = false;
      return;
    }
    try {
      const raw = await load();
      if (!current()) return;
      if (
        !raw ||
        typeof raw !== "object" ||
        !("context" in raw) ||
        !("policy" in raw)
      )
        throw new Error("Scheduling review unavailable");
      const context = schedulingReviewContextSchema.parse(raw.context),
        policy =
          raw.policy === null ? null : schedulingPolicySchema.parse(raw.policy);
      if (
        context.organizationId !== authority.profile?.organization?.id ||
        context.policyRevision !== (policy?.revision ?? 0) ||
        context.policyDigest !== (policy?.digest ?? null) ||
        (policy && policy.timeZone !== context.companyTimeZone) ||
        context.applicableRules.newTravelGapMinutes !==
          (policy?.enabled ? policy.minimumTravelGapMinutes : 0) ||
        context.applicableRules.companyCeiling !==
          (policy?.enabled ? policy.maxConcurrentReservations : null)
      )
        throw new Error("Scheduling policy context changed");
      token.value = freezeSchedulingValue({ context, policy });
    } catch {
      if (current())
        token.error =
          "Current scheduling review is unavailable. Refresh before changing the schedule.";
    } finally {
      if (current()) {
        token.loading = false;
        render((n) => n + 1);
      }
    }
  };
  useEffect(() => {
    void refresh();
    return () => {
      token.generation = ++revision.current;
    };
  }, [key]);
  return {
    value: authority.allowed ? token.value : null,
    error: token.error,
    loading: token.loading,
    refresh,
  };
}

/** Atomic controlled draft/review. This is presentation, never mutation permission. */
export function useSchedulingReview({
  authority,
  identity,
  context,
  interval,
  initialDraft,
  transition,
}: {
  authority: SchedulingAuthority;
  identity: string;
  context: SchedulingReviewContext | null;
  interval: IntervalInput;
  initialDraft: SchedulingDraft;
  transition: "admission" | "release" | "preserve";
}) {
  const [, render] = useState(0),
    ref = useRef<{
      identity: string;
      key: string;
      draft: SchedulingDraft;
      review: SchedulingMutationReview | null;
      draftVersion: number;
      reviewVersion: number;
    } | null>(null);
  const key = JSON.stringify([identity, authority.identity, context]);
  if (!ref.current || ref.current.key !== key) {
    const draft =
      ref.current?.identity === identity
        ? ref.current.draft
        : structuredClone(initialDraft);
    ref.current = {
      identity,
      key,
      draft,
      review: null,
      draftVersion: 0,
      reviewVersion: 0,
    };
  }
  const token = ref.current,
    draftVersion = token.draftVersion,
    reviewVersion = token.reviewVersion;
  const current = () => ref.current === token && authority.isCurrent();
  const onDraftChange = (next: SchedulingDraft) => {
    if (!current() || draftVersion !== token.draftVersion) return;
    // Fields echo the controlled draft when context changes. That echo must not
    // retire the current edit callback before the first actual user change.
    if (JSON.stringify(next) === JSON.stringify(token.draft)) return;
    token.review = null;
    token.reviewVersion++;
    token.draftVersion++;
    token.draft = freezeSchedulingValue(structuredClone(next));
    render((n) => n + 1);
  };
  const onReviewChange = (review: SchedulingMutationReview | null) => {
    if (
      !current() ||
      draftVersion !== token.draftVersion ||
      reviewVersion !== token.reviewVersion
    )
      return;
    token.review = null;
    if (review === null) {
      token.reviewVersion++;
      render((n) => n + 1);
      return;
    }
    try {
      const parsed = schedulingMutationReviewSchema.parse(review);
      if (
        !context ||
        JSON.stringify(parsed.context) !==
          JSON.stringify(schedulingReviewContextSchema.parse(context))
      )
        return;
      if (token.draft.startAt) {
        if (!parsed.startWallTime) return;
        validateWallTime(token.draft.startAt, parsed.startWallTime);
      } else if (parsed.startWallTime) return;
      if (token.draft.endAt) {
        if (!parsed.endWallTime) return;
        validateWallTime(token.draft.endAt, parsed.endWallTime);
      } else if (parsed.endWallTime) return;
      token.review = freezeSchedulingValue(structuredClone(parsed));
      render((n) => n + 1);
    } catch {
      /* Invalid wall evidence never approves the draft. */
    }
  };
  const draft = token.draft,
    review = authority.allowed ? token.review : null;
  const fields: Pick<
    SchedulingIntervalFieldsProps,
    | "context"
    | "companyTimeZone"
    | "interval"
    | "draft"
    | "review"
    | "onDraftChange"
    | "onReviewChange"
  > = {
    context: authority.allowed ? context : null,
    companyTimeZone: context?.companyTimeZone ?? null,
    interval,
    draft,
    review,
    onDraftChange,
    onReviewChange,
  };
  return {
    draft,
    review,
    fields,
    proposal: context
      ? buildSchedulingProposalView({ context, interval, draft, transition })
      : null,
    current: () =>
      current() &&
      draftVersion === token.draftVersion &&
      reviewVersion === token.reviewVersion,
    invalidate: () => onReviewChange(null),
  };
}
