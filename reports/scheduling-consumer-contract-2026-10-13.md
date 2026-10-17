# Saved scheduling consumer contract

Task3 source contract, based on accepted Task2 `2f1c8bb40a8bba8aa68f7fbc68f11dce35bad6c4`. Controller review and publication are required before peer UI implementation. This document describes implemented policy/context readers and writers plus the declared native-command boundary. Task4 implements receipt reconciliation; Task5 wires native admission. No receipt/admission enforcement is claimed by this contract commit alone.

## Authoritative exports

- `lib/scheduling-core/src/index.ts`: closed models, wall-time resolution, reservation mathematics and exact command canonicalization. Preserve the existing canonical hash semantics: submitted wire body/review, omitted versus null and array order. Never hash refreshed context into a retained command.
- `artifacts/api-server/src/services/scheduling-policy.ts`: transaction reader, policy writer, timezone writer, actor/lock helpers, source-scoped review and closed projection.
- `artifacts/command-center/src/lib/scheduling-ui-contract.ts`: controlled UI types and props. It contains no component, proposal builder, custody store or API mutation implementation.
- `artifacts/command-center/src/lib/scheduling-ui-contract.fixtures.ts`: compiled core/generated compatibility in both directions and typed UI props with nullable review callbacks.
- `reports/scheduling-consumer-fixtures-2026-10-13.json`: exact JSON copies of the typed examples, checked by `scripts/scheduling-codegen-strict.test.mjs`. IDs, staff, dates and hashes are synthetic examples, not company configuration or usable authority.

Generated client types are exported from `@workspace/api-client-react`; validators are generated in `lib/api-zod/src/generated/api.ts`. The codegen script preserves PR57's estimate correction and then closes 20 explicitly pinned scheduling DTO boundaries, including every nested object. It refuses missing/changed AST shapes before writing. The command graph is inlined in OpenAPI because Orval8 incorrectly drops the second discriminated branch's repeated nullable source reference; both appointment and project commands are runtime and type checked.

## Implemented HTTP surface

All paths below are relative to `/api/v1`. Policy/context handlers return `Cache-Control: no-store` and recheck accepted, verified, active staff authority inside their transaction. Request actor identity always comes from trusted server membership.

| Method/path | Authority | Body/query and response |
| --- | --- | --- |
| `GET /settings/scheduling-policy` | `crm.read` | `PolicyReadResult` with policy or null, policy-only context has source/inspection null. Does not initialize settings. |
| `PUT /settings/scheduling-policy` | `settings.manage` | Closed `PolicySaveInput` → `PolicyReadResult`. Expected revision and company zone required. |
| `GET /scheduling/review-context` | `crm.read` | Closed query below → `SchedulingReviewContext` with locked real source and original target version/fingerprint. |
| Existing `PUT /settings` | `settings.manage` | Inspection writes now serialize policy revision/digest and audit atomically. Generic settings body/response does not admit/expose schedulingPolicy. |
| Existing `PATCH /platform/orgs/:id` | verified active platform administrator | `timezone` requires exact `expectedTimeZone`; timezone/configured-policy revision/audit and any supplied valid name commit together. Name-only semantics remain. |

`PolicySaveInput` is `{expectedRevision,expectedCompanyTimeZone,enabled,minimumTravelGapMinutes,maxConcurrentReservations,durationPresets}`. A preset `{id:null,label,elapsedMinutes}` requests a server UUID. A non-null ID must belong to the current policy. Revision, digest, approved timezone and actor metadata cannot be supplied as writable fields. Missing policy is revision0; first explicit save is1. Disable retains policy, IDs and provenance and advances revision. Re-enable advances again. No reset to null is supported.

Review query:

```ts
{
  sourceKind: 'lead' | 'direct_customer' | 'unlinked_manual';
  sourceId?: UUID; propertyId?: UUID; estimateId?: UUID;
  reservationKind: 'appointment' | 'project';
  appointmentType?: AppointmentType;
  targetKind?: 'appointment' | 'project'; targetId?: UUID;
}
```

`sourceId` is mandatory for lead/customer and forbidden for unlinked; unlinked also forbids property/estimate. Target kind/id are paired and must match reservationKind. Projects forbid appointmentType. A new appointment's omitted type uses native inspection default. Editing with omitted type uses the locked existing appointment type; an explicit proposed type controls its inspection gate without replacing the original version/fingerprint. Do not fabricate target/source IDs for create context. Native enum values come from the generated schema.

Lead source resolves its real contact; a selected property must belong to that contact and match the lead's recorded property when present. Estimate must belong to the lead. Existing appointment/project context verifies the original source, including returning-work root contact/property where present. A truly unlinked target cannot acquire a selected customer through review; only an original lead-linked legacy appointment with NULL stored contact may resolve its real contact through that same original lead. Native projects still require their existing lead; returning-work uses its existing command identity.

## Rules, zones and evidence

`context.applicableRules` is authoritative review data. Enabled policy supplies its gap and company ceiling. Disabled/unconfigured policy supplies gap0/company null. Applicable inspection ceiling is separate; a noninspection appointment/project receives null. Inspection limit accepts a positive safe integer, including legacy101; company ceiling remains1..100 or null. The JSON fixtures pin enabled60/3/2, disabled0/null/2, project60/3/null and revision0 inspection101.

Company zone is `organizations.timezone`. Inspection windows retain their independent rule-source zone. Effective inspection rules are normalized deterministically and tagged `recorded`, `legacy_default` or `legacy_normalized`; the latter two are compatibility provenance, not owner approval. Digests include effective rules, provenance and company/rule zones. Changing company zone never rewrites inspection windows. Inspection or zone changes advance a configured policy; even revision0 affected inspection reviews become stale. Full submitted context, including rules/source/version/fingerprint, is compared against the authoritative context under admission locks.

Invalid saved policy/digest/zone is an actionable hold. A platform administrator can correct an invalid **unconfigured** company zone using its exact observed expected value. Corrupt configured evidence is retained and held for separate reviewed recovery; ordinary saves do not replace it silently.

Today now uses company-zone calendar bounds, including DST days, and returns `schedulingPolicyState` (`unconfigured`, `configured`, `invalid`) and nullable `schedulingPolicyRevision`. Invalid company zone returns409 with an administrator recovery message. Invalid current policy does not erase historical appointment/project display. Existing financial and UTC service-obligation date semantics remain unchanged. The prior inspection-zone/UTC-fallback assertions are superseded by the authoritative company-zone spec; differing company/rule zones and DST are covered explicitly. The legacy generated timeZoneSource union remains compatible, but this implementation emits only `configured` on success.

`projectSchedulingEvidence(kind,row)` emits only a closed, target-bound `ReservationSnapshot` or null, `schedulingEvidence:'legacy'|'versioned'|'invalid'`, and `schedulingTargetFingerprint`. Active capacity-consuming rows additionally require actual interval and normalized resources to agree with the snapshot; a protected active NULL actual end is invalid. Core `effectiveReservation` normalizes equivalent UTC instants and resource set order/duplicates in private math-only candidates; these candidates never emit source authority. Malformed, wrong-target or mismatched active evidence is flagged invalid and never leaked as a snapshot/legacy-zero; GET review holds. Terminal/date-cleared released history retains its saved interval/resources, and legacy NULL snapshots retain fixed-end compatibility. None of this requires current policy. The fingerprint includes kind/id/version/endpoints/type/status/source IDs/sorted resources/snapshot revision, excluding notes. It changes for a material row change even with identical updatedAt. Today implements these row projections; the native list/create/update schema fields are declared for Task5 integration.

## Transaction helper contract for Task4/5/6

```ts
type SchedulingActor = { organizationId: UUID; userId: UserId }; // trusted server only
type SchedulingBookingScope = {
  reservationKind: 'appointment' | 'project'; appointmentType?: AppointmentType;
};
lockSchedulingConfiguration(tx: ScheduleTransaction, org: string, requireActive = true): Promise<void>;
assertSchedulingActor(tx: ScheduleTransaction, actor: SchedulingActor,
  permission: Permission, platform = false): Promise<UserRow>;
readSchedulingContext(tx: ScheduleTransaction, orgId: UUID,
  target?: SchedulingCandidate, bookingScope?: SchedulingBookingScope): Promise<{
    policy: SchedulingPolicy | null; context: SchedulingReviewContext;
    effectiveInspection: InspectionAvailabilitySettings;
  }>;
revalidateSchedulingContext(tx: ScheduleTransaction, orgId: UUID,
  reviewed: SchedulingReviewContext, target?: SchedulingCandidate,
  bookingScope?: SchedulingBookingScope): Promise<the same reader result>;
saveSchedulingPolicy(actor: SchedulingActor, input: PolicySaveInput): Promise<PolicyReadResult>;
setSchedulingCompanyTimeZone(actor: SchedulingActor, orgId: UUID,
  zone: string, expectedZone: string, name?: string): Promise<void>;
```

The timezone helper retains its frozen four-argument call compatibility. Its optional fifth argument carries the existing route-validated name for a mixed update in the same org/settings/policy/audit transaction; it is not a new wire field. The lock helper uses the existing lifecycle key `customer-lifecycle:<org>` (hashtextextended) then existing schedule key `<org>:inspection-booking` (hashtext), with local3s lock/10s statement limits. It checks lifecycle unless explicitly called with false by an authorized read. It must run at transaction entry, never after acquiring schedule/participant locks. Actor recheck takes SHARE and verifies active, email verified, accepted/non-invite and current permission; platform mode verifies isPlatformAdmin independently of target org membership. Existing source-specific ordering/authority remains mandatory.

Policy/context reader accepts only the caller's transaction and performs SELECTs only; it rejects the global db handle. It never calls lazy `getOrgSettings`, starts another transaction, acquires lifecycle, or invents actor authority. An optional target supplies proposed scope/source while its existing same-org row supplies ORIGINAL version/fingerprint. New candidate IDs may be absent from storage and produce null target tokens. Internal callers must validate real source binding under their ordered participant locks; the reader does not authorize a supplied candidate source. The HTTP wrapper performs its own locked source/target validation. Admission later derives candidate scope from its actual proposed type and compares the complete review via revalidation.

`initializeOrgSettings(tx,org)` is the shared default-only initializer in settings.ts. Its caller owns lifecycle/schedule and applicable actor authority; it locks org/settings rows and never overwrites existing policy. The legacy global wrapper may initialize only this compatibility row under its own enclosing transaction. Existing inspection-booking capacity and appointment-reminder helpers already use supplied-tx SELECTs; no new global initializer call was inserted into their transaction paths.

**Receipt replay is a distinct boundary.** Task4 must validate the closed original `ManualSchedulingCommand`, pure original source/body binding and exact canonical hash, then acquire lifecycle/schedule/accepted actor/global operation ordering and look up prior receipt **before any live source/policy read**. It must not call `readSchedulingContext`, `getSchedulingReviewContext`, or revalidation to authorize an existing receipt. A missing/deleted source, changed/corrupt policy or missing target does not invalidate exact prior receipt custody. Task4 owns its pure binding/refusal type; this task does not supply a live-reader substitute. The core canonicalizer remains unchanged.

## Declared command/ack surface for downstream implementation

OpenAPI declares `POST /scheduling/operations/reconcile` with exact original `ManualSchedulingCommand` and `ManualSchedulingAck`; Task4 adds the handler. The endpoint is not implemented in Task3 and has no placeholder no-commit response. Native create inputs add optional `operationId`/`schedulingReview`, native update adds `schedulingReview`/`expectedTargetFingerprint`, and native responses may carry `schedulingOperation`. Task5 owns enforcement/wiring. Existing `expectedUpdatedAt` remains the targetVersion carrier.

The command body is a closed native business shape without nested operationId/review/snapshot/actor/digest. The outer command owns operationId and review. Keep exact original command through unknown outcomes and same-tab refresh/remount; never automatically resubmit, replace operation ID, refresh its context, or infer no-commit from GET/missing target/list matches/errors. No closed-tab/device custody is claimed.

Implemented structured errors are `stale_scheduling_review`409, `invalid_scheduling_policy`400/409, `invalid_reservation_snapshot`409, `invalid_scheduling_context`400, `scheduling_access_denied`403, `organization_missing`404, `scheduling_source_missing`404, `scheduling_target_missing`404, `customer_reference_mismatch`400, `estimate_lead_mismatch`400 and existing `customer_lifecycle_paused`423. Internal global-reader misuse is `scheduling_transaction_required`503. Unknown database/lock errors remain unknown, never terminal no-commit evidence. Future gates use the already frozen core/domain error names in the plan; no conflict authority is added here.

## Task5 native admission and original-operation responses

Native appointment/project CREATE with `operationId` validates and hashes the original `req.body` spelling, omissions and array order before generated Date coercion. Reviewed CREATE without `operationId` returns400 `scheduling_operation_required`; eligible old unreviewed/unconfigured calls retain their wrapper compatibility. A server-constructed `SchedulingActor` is rechecked under lifecycle/schedule locks. The native callback uses `createAppointmentInTransaction` or `createProjectInTransaction` inside the receipt's enclosing transaction. Exact prior replay precedes live policy, source, default or native-create reads. Available fresh/replay returns the original row plus `schedulingOperation`, with201/200 respectively. Appointment booking observers run only for a newly created original target; their failure cannot change the committed response.

Native CREATE refused/unavailable409 is the closed `ManualSchedulingError` type, validated by the runtime export **`ManualSchedulingErrorSchema`** from `@workspace/api-zod`:

```ts
{
  error: string;
  code: 'manual_scheduling_refused' | 'manual_scheduling_target_unavailable';
  schedulingOperation: ManualSchedulingAck;
}
```

Validate the terminal acknowledgement independently of HTTP success. A refused original remains `no_commit_refused`; a deleted original target remains `committed` with `target.available:false`. Ordinary errors do not establish no-commit. Native deterministic adaptation is deliberately bounded to actual `NativeSchedulingDomainError`, whitelisted `ScheduleError`, and whitelisted `SchedulingPolicyError` instances. Raw SQL, transaction misuse, authentication/lifecycle failures and code-shaped lookalikes propagate without a receipt. The generated correction preserves the existing20 scheduling and18 PR57 strict boundaries, and separately closes the new error envelope and its nested acknowledgement. No UI prop or literal fixture changed.

Native material admission validates actual and raw claimed staff evidence across appointments/projects before applying the1440-minute maximum travel horizon. Each physical query is bounded at10001; the combined unique kind/id population holds above10000. Company overlap and inspection populations have separate10000 budgets and use core half-open true peak. Native reviewed/protected inspection admission writes through the supplied transaction without the old intersection-count helper; eligible legacy compatibility retains that helper until Task6D integrates it. All native source/staff, target-version/fingerprint, snapshot, transition audit, reminder and invoice-task changes use the original transaction.

Locked classification precedes live policy on notes/confirmation, terminal closure and pure resource release. Corrupt raw historical JSON remains in its column for allowed notes/closure and never becomes emitted legacy evidence; active partial release/admission holds. Protected active end-only clearing holds even with no assigned staff. Project both-date clearing releases capacity and retains the last snapshot. Appointment start-only edits preserve duration; project start-only edits keep the absolute end. Supplied workday execution preserves its original transaction, task-plan flag and completion ID without reacquiring lifecycle locks after participants.

`scheduling.reservation_transition.v1` metadata is the closed `schedulingTransitionSchema` exported from `scheduling-admission.ts`. It carries actual target, trusted origin/source ID, validated before/after snapshots, exact transition, source, recordedAt and `invalidHistoricalEvidenceRetained`. All new callers supply explicit facts to `appendSchedulingTransition`; ambiguous null/equal snapshots without facts throw. Task7 owns subsequent history projection. Task6 source writers must construct their authority only after their own locked source approval; actorless compatibility cannot mint protected authority or snapshots.

## Controlled UI seam

Use the exact exported `SchedulingPolicyPanelProps`, `SchedulingIntervalFieldsProps`, `SchedulingTravelReviewProps`, `PolicyViewState`, `PolicySaveResult`, `IntervalInput`, `ResourceChoice`, `GateView`, `AuthorizedConflict`, `SchedulingDraft` and `SchedulingProposalView` types. Scope includes organization and actor. Root owns draft, review, requests and custody. Current companyTimeZone is explicit and may be null during loading/hold; saved approvedTimeZone is historical provenance only.

Before each draft/preset/resource/context change, interval fields call `onReviewChange(null)` then `onDraftChange(exactChangedDraft)`. Only a complete valid current draft can emit a non-null review. Root rejects callbacks from stale draft/context closures and builds body/review atomically from the same root state. Invalid/nonexistent/ambiguous input holds review null and submit disabled. Task9 implements the proposal builder; current types do not infer availability from partial lists. Configured gates remain held with the explicit text `Rechecked when saving` until final transactional admission.


## Task6 source writers and generated contracts

Task6A/B/C source writers retain their own original command custody and their own source validators. They use the common admission gate only after source authorization under the existing lifecycle → schedule → source/parent/member ordering. `appendSchedulingTransition` receives the explicit six arguments and actual source facts. There is no conversion to a manual operation receipt, fabricated lead, source UUID, customer-work root, staff actor or approval.

| Source | Exact current request/read/result contract | Original committed proof |
| --- | --- | --- |
| Returning-customer projects | `createCustomerWorkProjectSchema`, `updateCustomerWorkProjectSchema`, `customerWorkProjectSchema`, `customerWorkProjectMutationSchema`; generated `CreateCustomerWorkProjectBody/Response`, `UpdateCustomerWorkProjectBody/Response` | `customerWorkProjectOutcomeSchema`: original request/action/actor/hash/root/target/resultWorkVersion. HTTP409 `customer_work_result_unavailable` is committed with `target.available:false`, validated by `CustomerWorkProjectUnavailableSchema`; it is never no-commit evidence. |
| Service care | `serviceCareBookingSchema`; GET care accepts optional `appointmentType` and exposes required `scheduling:serviceCareSchedulingReadSchema`; dedicated `serviceCareBookingResultSchema` (`appointmentId`, `replayed`, `bookingOutcome`) | Original booking audit, requestId/requestFingerprint/responseId/expectedUpdatedAt/actor/obligation/appointment binding. Reminder approval still uses its separate original response. |
| CALLIE | `callieBookingSchema`; GET `/communications/callie/{id}/scheduling-context` uses `callieSchedulingContextQuerySchema` and `callieSchedulingContextReadSchema`; dedicated `CallieBookingResult` (`detail` nullable, `replayed`, `bookingOutcome`) | Original office booking audit, requestId/requestFingerprint/expectedVersion/expectedFingerprint/customerConfirmed/actor/intake/appointment binding. A replay may have null detail; ordinary office commands retain their separate response. |

A/B/C accept omitted historical `schedulingReview` for original receipt lookup. Omission is distinct from null. Fresh material staff admission requires the exact current reviewed source context. Read results distinguish `ready` from `held`; a held read grants no scheduling authority. Read/outcome cross-field consistency must be validated using each accepted source validator plus retained original command bindings. JSON Schema/Zod generation closes object shapes but does not reproduce source `superRefine` rules or establish committed identity by itself. Verify the original acknowledgement independently of HTTP success; a generic error or a missing display never proves no commit and never permits automatic resubmission.

`scripts/scheduling-source-api-spec.mjs` projects only the 17 selected source components and six selected path graphs from the accepted A/B/C schemas. It checks anchors, rejects unrelated semantic changes, and is byte-idempotent. The generator runs separately before the normal API codegen. For selected source command/outcome datetime strings it retains the actual exact datetime pattern and removes only the Orval Date-triggering `format`. Source timestamp spelling, fractional precision, UUID casing, parsed trim, omission/null and array order remain unchanged through generated parsing and JSON transport. In particular, B's historical `expectedUpdatedAt` may contain submillisecond precision. Never normalize it using `new Date(...).toISOString()` before original-hash verification.

A's hash remains `customerWorkHash({action,targetId,input,actorUserId})`; B remains `careFingerprint(parsedInput)`; C remains SHA256 of browser-safe `canonicalCallieBookingInput`, equal to the existing source fingerprint. B's canonical helper currently imports Node crypto: only Node-side spec/tests may import it here. Task9 owns extracting its pure browser helper without changing the original hash. No browser imports of that module were added. C's accepted pure helper is retained. Generated schemas do not independently implement source trim/cross-field semantics: preserve the original source-parsed command for custody.

The strict correction keeps the original20 scheduling boundaries/counts, `ManualSchedulingErrorSchema`, and the original18 PR57 estimate delivery boundaries. It separately pins12 source operation/member boundaries, including only the new `GetServiceCareResponse.scheduling` member inside that historical read envelope. It adds the closed named `CustomerWorkProjectUnavailableSchema`. Generated path-validator naming collision is resolved by exporting `GetCallieSchedulingContextParams` as the query type and `GetCallieSchedulingContextPathParams` as the path validator, following the existing service-care alias pattern. No global Orval date policy or unrelated endpoint changed.

## Task6D concierge offers, replay and inspection compatibility

`conciergeInspectionOfferSchema`/`ConciergeInspectionOffer` bind an actual server-stored conversation offer: version, organizationId, conversationId, proposed appointmentId, label/full UTC start/end, actual source, material sourceFingerprint and original scheduling review. Existing publicOrg installation/Origin routing and the conversation remain the public entry boundary; there is no signed concierge offer token. Only a matching stored offer and locked current conversation/source lineage authorize fresh booking. The future native target UUID is allocated once per offer and is not a command capability. Org-only previews cannot create configured source authority. Historical bare offers in a conversation require reoffer.

`generateInspectionSlots(org,{conversationId})` and `bookInspectionSlot` use `prepareInspectionInTransaction`, which delegates to the accepted core evidence/admission gate. Offers and final writes therefore share active inspection population, legacy two-hour effective ends, half-open true peak, project/appointment company ceiling, saved travel and actual/raw claimed-resource validation, 1440-minute horizon and combined10000 relevant-resource limit (each physical query requests10001). An unassigned company offer says nothing about a particular technician's availability. The configured company policy and inspection ceiling remain independent.

Offers search tomorrow through the fourteenth rule-zone calendar date, honor recorded weekdays/windows/blackout dates, and display company-zone time with the independent rule-zone label when different. End hour24 means the next local midnight. Ambiguous/nonexistent configured endpoints are skipped because this chat has no occurrence selector; ordinary windows remain eligible. Full instants, including seconds/milliseconds, must match the offered window. Manual staff inspection writes retain their existing ability to use agreed intervals outside anonymous offer hours.

Fresh booking acquires lifecycle → schedule → actual conversation → actual source/parent/member locks, revalidates lifecycle/rules/context/source and writes native appointment/snapshot/explicit transition/activity/original audit/conversation proof/supplied-transaction reminder atomically. Trusted authority is actor null, origin `concierge`, sourceId the actual conversation ID and `reviewMode:existing_workflow_transaction`. No staff approval is invented. Original matching conversation/audit proof is checked before current lifecycle, policy, source or window state; replay returns the original ID without new admission, reminder or booking observers. Unknown SQL/timeout errors propagate rather than becoming no-commit proof. Known stale offers produce truthful changed-details/reoffer text.

The booking transaction marks the conversation completed; a later outer message save locks and merges committed booking custody so an older message cannot erase it. Duplicate booking handlers return before observers and finalization. Confirmation and organization automation effects remain existing postcommit behavior; the database result does not promise delivery or restart recovery of an interrupted observer.

All four inspection compatibility wrapper signatures remain. Global wrappers establish lifecycle/schedule ordering; supplied-transaction wrappers use the caller's transaction and do not reacquire lifecycle locks after participants. Actorless legacy compatibility is limited to what the accepted admission gate permits; it cannot fabricate protected approval or a configured snapshot. Common helper consumers validate operational members and actual customer lineage. Today remains a read-only historical work queue (including its original no-show/on-hold semantics); D's runtime writer matrix verifies saved snapshots survive policy changes in Today projection. No Today production change was needed.


Task6D review round1 corrections: company-zone window labels include minutes, including fractional-offset rule zones (for example Kolkata22:00–24:00 becomes Los Angeles08:30–10:30). Source projection requires all seven existing component anchors and accepts only their exact reviewed pre-D shape or authoritative source projection. The ten newly authorized components may be absent for initial insertion; when present, their shapes must match the authoritative projection. Every historical ServiceCareReview member is checked against the reviewed old shape before adding the scheduling member. Missing or altered existing schemas now throw before replacement. Both the reviewed pre-D spec and the current spec project idempotently to the unchanged current output.
