/** Compile-time consumer fixtures; these are synthetic examples, never company facts. */
import type * as Wire from "@workspace/api-client-react";
import type * as Core from "@workspace/scheduling-core";
import type {
  SchedulingDraft,
  SchedulingIntervalFieldsProps,
  SchedulingPolicyPanelProps,
  SchedulingProposalView,
  SchedulingTravelReviewProps,
} from "./scheduling-ui-contract";
const organizationId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
export const source: Core.ManualSourceRef = {
  sourceKind: "unlinked_manual",
  leadId: null,
  contactId: null,
  propertyId: null,
  estimateId: null,
};
export const enabledContext: Core.SchedulingReviewContext = {
  organizationId,
  policyRevision: 1,
  policyDigest: "a".repeat(64),
  companyTimeZone: "America/Los_Angeles",
  inspection: {
    ruleTimeZone: "America/New_York",
    availabilityDigest: "b".repeat(64),
    sourceState: "recorded",
  },
  applicableRules: {
    newTravelGapMinutes: 60,
    companyCeiling: 3,
    inspectionCeiling: 2,
  },
  source,
  targetVersion: null,
  targetFingerprint: null,
};
export const disabledContext: Core.SchedulingReviewContext = {
  ...enabledContext,
  policyRevision: 2,
  policyDigest: "c".repeat(64),
  applicableRules: {
    newTravelGapMinutes: 0,
    companyCeiling: null,
    inspectionCeiling: 2,
  },
};
export const projectContext: Core.SchedulingReviewContext = {
  ...enabledContext,
  inspection: null,
  applicableRules: {
    newTravelGapMinutes: 60,
    companyCeiling: 3,
    inspectionCeiling: null,
  },
  source: {
    sourceKind: "lead",
    leadId: targetId,
    contactId: organizationId,
    propertyId: null,
    estimateId: null,
  },
};
export const legacy101Context: Core.SchedulingReviewContext = {
  ...enabledContext,
  policyRevision: 0,
  policyDigest: null,
  applicableRules: {
    newTravelGapMinutes: 0,
    companyCeiling: null,
    inspectionCeiling: 101,
  },
};
export const newInspectionQuery = {
  sourceKind: "unlinked_manual",
  reservationKind: "appointment",
} satisfies Wire.GetSchedulingReviewContextParams;
export const projectQuery = {
  sourceKind: "lead",
  sourceId: targetId,
  reservationKind: "project",
} satisfies Wire.GetSchedulingReviewContextParams;
export const editNoninspectionQuery = {
  sourceKind: "unlinked_manual",
  reservationKind: "appointment",
  targetKind: "appointment",
  targetId,
  appointmentType: "production",
} satisfies Wire.GetSchedulingReviewContextParams;
export const appointmentCommand: Core.ManualSchedulingCommand = {
  operationId: targetId,
  kind: "appointment_create",
  body: {
    scheduledStart: "2035-01-01T17:00:00.000Z",
    scheduledEnd: "2035-01-01T18:30:00.000Z",
    type: "inspection",
  },
  review: {
    context: enabledContext,
    duration: { kind: "explicit", preset: null },
    startWallTime: {
      localDateTime: "2035-01-01T09:00",
      offset: "-08:00",
      timeZone: "America/Los_Angeles",
    },
    endWallTime: {
      localDateTime: "2035-01-01T10:30",
      offset: "-08:00",
      timeZone: "America/Los_Angeles",
    },
  },
};
export const projectCommand: Core.ManualSchedulingCommand = {
  operationId: targetId,
  kind: "project_create",
  body: {
    leadId: targetId,
    name: "Synthetic job",
    scheduledStart: "2035-01-01T17:00:00.000Z",
    scheduledEnd: "2035-01-01T18:30:00.000Z",
  },
  review: { ...appointmentCommand.review, context: projectContext },
};
export const acknowledgement: Core.ManualSchedulingAck = {
  operationId: targetId,
  organizationId,
  actorUserId: "staff-synthetic",
  kind: "appointment_create",
  source,
  payloadSha256: "d".repeat(64),
  outcome: "committed",
  target: { kind: "appointment", id: targetId, available: true },
  refusalCode: null,
};
export const saveInput: Core.PolicySaveInput = {
  expectedRevision: 0,
  expectedCompanyTimeZone: "America/Los_Angeles",
  enabled: true,
  minimumTravelGapMinutes: 60,
  maxConcurrentReservations: 3,
  durationPresets: [{ id: null, label: "Synthetic visit", elapsedMinutes: 90 }],
};
export const draft: SchedulingDraft = {
  startAt: "2035-01-01T17:00:00.000Z",
  endAt: "2035-01-01T18:30:00.000Z",
  resourceUserIds: [],
};
export const proposal: SchedulingProposalView = {
  basis: "new_admission",
  startAt: draft.startAt!,
  endAt: draft.endAt!,
  resourceUserIds: [],
  appliedTravelGapMinutes: 60,
  companyCeiling: 3,
  inspectionCeiling: 2,
  inspectionGate: { kind: "held", message: "Rechecked when saving" },
  companyGate: { kind: "held", message: "Rechecked when saving" },
};
const interval = {
  startAt: null,
  endAt: null,
  legacyEffectiveEnd: null,
  reservation: null,
  evidence: "legacy" as const,
};
export const intervalProps: SchedulingIntervalFieldsProps = {
  context: enabledContext,
  companyTimeZone: enabledContext.companyTimeZone,
  interval,
  draft,
  resources: [],
  presets: [],
  review: null,
  disabled: false,
  onDraftChange: () => undefined,
  onReviewChange: (review) => {
    const nullable: Core.SchedulingMutationReview | null = review;
    void nullable;
  },
};
export const policyProps: SchedulingPolicyPanelProps = {
  state: {
    kind: "loading",
    scope: { organizationId, actorUserId: "staff-synthetic" },
  },
  draft: saveInput,
  canManage: true,
  onDraftChange: () => undefined,
  onSave: async () => ({
    kind: "unknown",
    message: "Review current saved state.",
  }),
  onRefresh: () => undefined,
};
export const reviewProps: SchedulingTravelReviewProps = {
  companyTimeZone: enabledContext.companyTimeZone,
  interval,
  proposal,
  resources: [],
  conflict: null,
};

// Both directions prevent generated type drift, including project source loss.
export const commandToWire: Wire.ManualSchedulingCommand = appointmentCommand;
export const projectToWire: Wire.ManualSchedulingCommand = projectCommand;
export const wireToCore = (
  value: Wire.ManualSchedulingCommand,
): Core.ManualSchedulingCommand => value;
export const contextToWire: Wire.SchedulingReviewContext = enabledContext;
export const contextFromWire = (
  value: Wire.SchedulingReviewContext,
): Core.SchedulingReviewContext => value;
export const ackToWire: Wire.ManualSchedulingAck = acknowledgement;
export const ackFromWire = (
  value: Wire.ManualSchedulingAck,
): Core.ManualSchedulingAck => value;
export const saveToWire: Wire.PolicySaveInput = saveInput;
export const saveFromWire = (
  value: Wire.PolicySaveInput,
): Core.PolicySaveInput => value;
