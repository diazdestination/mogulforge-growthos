import type {
  DurationPreset,
  ISO,
  PolicyReadResult,
  PolicySaveInput,
  ReservationSnapshot,
  SchedulingMutationReview,
  SchedulingReviewContext,
  UserId,
  UUID,
} from "@workspace/scheduling-core";
export type {
  DurationPreset,
  ISO,
  PolicyReadResult,
  PolicySaveInput,
  ReservationSnapshot,
  SchedulingMutationReview,
  SchedulingReviewContext,
  UserId,
  UUID,
} from "@workspace/scheduling-core";

export type SchedulingScope = { organizationId: UUID; actorUserId: UserId };
export type PolicyViewState =
  | { kind: "loading"; scope: SchedulingScope }
  | {
      kind: "unconfigured" | "loaded";
      scope: SchedulingScope;
      value: PolicyReadResult;
    }
  | { kind: "read_error" | "invalid"; scope: SchedulingScope; message: string }
  | {
      kind: "saving" | "stale" | "unknown";
      scope: SchedulingScope;
      value: PolicyReadResult;
      draft: PolicySaveInput;
      message: string;
    };
export type PolicySaveResult =
  | { kind: "saved"; value: PolicyReadResult }
  | { kind: "stale" | "unknown" | "refused"; message: string };
export type IntervalInput = {
  startAt: ISO | null;
  endAt: ISO | null;
  legacyEffectiveEnd: ISO | null;
  reservation: ReservationSnapshot | null;
  evidence: "legacy" | "versioned" | "invalid";
};
export type ResourceChoice = { id: UserId; label: string };
export type GateView = {
  kind: "not_configured" | "available" | "held";
  message: string | null;
};
export type AuthorizedConflict = null | {
  reservationKind: "appointment" | "project";
  reservationId: UUID;
  resourceLabel: string;
  startAt: ISO;
  endAt: ISO;
  reason: string;
};
export type SchedulingDraft = {
  startAt: ISO | null;
  endAt: ISO | null;
  resourceUserIds: UserId[];
};
export type SchedulingProposalView = {
  basis: "new_admission" | "saved_release" | "saved_preservation";
  startAt: ISO;
  endAt: ISO;
  resourceUserIds: UserId[];
  appliedTravelGapMinutes: number;
  companyCeiling: number | null;
  inspectionCeiling: number | null;
  inspectionGate: GateView;
  companyGate: GateView;
};
/** Root owns draft/scope/request custody. Saving is explicit and never retried automatically. */
export type SchedulingPolicyPanelProps = {
  state: PolicyViewState;
  draft: PolicySaveInput | null;
  canManage: boolean;
  onDraftChange: (draft: PolicySaveInput) => void;
  onSave: (draft: PolicySaveInput) => Promise<PolicySaveResult>;
  onRefresh: () => void;
};
/** Before every draft/preset/resource/context/effective-mode edit call onReviewChange(null), then
 * onDraftChange with the exact changed draft. Root discards callbacks from old
 * draft/context/mode closures. Only a complete unambiguous draft may emit a review. */
export type SchedulingIntervalFieldsProps = {
  /** Omitted and preserve_elapsed retain appointment elapsed-duration semantics. */
  startOnlyBehavior?: 'preserve_elapsed' | 'preserve_absolute_end';
  context: SchedulingReviewContext | null;
  companyTimeZone: string | null;
  interval: IntervalInput;
  draft: SchedulingDraft;
  resources: ResourceChoice[];
  presets: DurationPreset[];
  review: SchedulingMutationReview | null;
  disabled: boolean;
  onDraftChange: (draft: SchedulingDraft) => void;
  onReviewChange: (review: SchedulingMutationReview | null) => void;
};
/** companyTimeZone is CURRENT authority. approvedTimeZone is historical only.
 * A partial client list never proves availability; configured proposal gates
 * remain held with "Rechecked when saving" until final transactional admission. */
export type SchedulingTravelReviewProps = {
  companyTimeZone: string | null;
  interval: IntervalInput;
  proposal: SchedulingProposalView | null;
  resources: ResourceChoice[];
  conflict: AuthorizedConflict;
};
