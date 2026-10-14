/** Synthetic consumer fixtures derived from the reviewed Task 3 examples. */
import {
  draft as contractDraft,
  enabledContext,
  proposal as contractProposal,
  saveInput,
} from "../lib/scheduling-ui-contract.fixtures";
import type {
  DurationPreset,
  IntervalInput,
  PolicyReadResult,
  PolicySaveInput,
  PolicyViewState,
  ReservationSnapshot,
  ResourceChoice,
  SchedulingDraft,
  SchedulingProposalView,
  SchedulingReviewContext,
  SchedulingScope,
} from "../lib/scheduling-ui-contract";

export const schedulingFixtureIds = {
  organization: "11111111-1111-4111-8111-111111111111",
  target: "22222222-2222-4222-8222-222222222222",
  preset: "33333333-3333-4333-8333-333333333333",
  alternateOrganization: "44444444-4444-4444-8444-444444444444",
  staff: "staff-synthetic",
} as const;

export function makeSchedulingScope(overrides: Partial<SchedulingScope> = {}): SchedulingScope {
  return { organizationId: schedulingFixtureIds.organization, actorUserId: schedulingFixtureIds.staff, ...overrides };
}

export function makeSchedulingContext(overrides: Partial<SchedulingReviewContext> = {}): SchedulingReviewContext {
  return { ...structuredClone(enabledContext), ...structuredClone(overrides) };
}

export function makeDurationPreset(overrides: Partial<DurationPreset> = {}): DurationPreset {
  return { id: schedulingFixtureIds.preset, label: "Synthetic visit", elapsedMinutes: 90, ...overrides };
}

export function makePolicyReadResult(overrides: Partial<PolicyReadResult> = {}): PolicyReadResult {
  const context = makeSchedulingContext({
    inspection: null,
    source: null,
    applicableRules: { newTravelGapMinutes: 60, companyCeiling: 3, inspectionCeiling: null },
  });
  return {
    policy: {
      formatVersion: 1,
      revision: 1,
      enabled: true,
      timeZone: context.companyTimeZone,
      minimumTravelGapMinutes: 60,
      maxConcurrentReservations: 3,
      durationPresets: [makeDurationPreset()],
      digest: context.policyDigest!,
      updatedAt: "2035-01-01T16:00:00.000Z",
      updatedByUserId: schedulingFixtureIds.staff,
    },
    context,
    ...structuredClone(overrides),
  };
}

export function makePolicyDraft(overrides: Partial<PolicySaveInput> = {}): PolicySaveInput {
  return {
    ...structuredClone(saveInput),
    expectedRevision: 1,
    durationPresets: [makeDurationPreset()],
    ...structuredClone(overrides),
  };
}

export function makePolicyViewState(value = makePolicyReadResult()): PolicyViewState {
  return { kind: value.policy ? "loaded" : "unconfigured", scope: makeSchedulingScope(), value };
}

export function makeSchedulingDraft(overrides: Partial<SchedulingDraft> = {}): SchedulingDraft {
  return { ...structuredClone(contractDraft), ...structuredClone(overrides) };
}

export function makeSchedulingResources(): ResourceChoice[] {
  return [
    { id: schedulingFixtureIds.staff, label: "Synthetic staff" },
    { id: "staff-secondary", label: "Second synthetic staff" },
  ];
}

export function makeReservationSnapshot(overrides: Partial<ReservationSnapshot> = {}): ReservationSnapshot {
  return {
    formatVersion: 1,
    reservationRevision: 1,
    sourcePolicyRevision: 1,
    sourcePolicyDigest: "a".repeat(64),
    approvedTimeZone: "America/Los_Angeles",
    inspection: structuredClone(enabledContext.inspection),
    startAt: "2035-01-01T17:00:00.000Z",
    endAt: "2035-01-01T18:30:00.000Z",
    resourceUserIds: [schedulingFixtureIds.staff],
    minimumTravelGapMinutes: 60,
    duration: { kind: "preset", preset: makeDurationPreset() },
    admittedAt: "2035-01-01T16:00:00.000Z",
    admittedByUserId: schedulingFixtureIds.staff,
    target: { kind: "appointment", id: schedulingFixtureIds.target },
    lastTransition: { kind: "admission", actorUserId: schedulingFixtureIds.staff, at: "2035-01-01T16:00:00.000Z" },
    ...structuredClone(overrides),
  };
}

export function makeSchedulingInterval(overrides: Partial<IntervalInput> = {}): IntervalInput {
  const reservation = makeReservationSnapshot();
  return {
    startAt: reservation.startAt,
    endAt: reservation.endAt,
    legacyEffectiveEnd: null,
    reservation,
    evidence: "versioned",
    ...structuredClone(overrides),
  };
}

export function makeSchedulingProposal(overrides: Partial<SchedulingProposalView> = {}): SchedulingProposalView {
  return { ...structuredClone(contractProposal), ...structuredClone(overrides) };
}
