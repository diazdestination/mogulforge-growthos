# Saved Scheduling Capacity and Travel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give staff dependable configurable durations, retained travel protection, resource/company capacity checks and recoverable booking saves without altering established customer history.

**Architecture:** A small pure scheduling package supplies the same closed models, interval mathematics and timezone conversion to server and native UI. Organization scheduling serialization protects policy, reservations and source writers; manual CREATE uses permanent audit receipts and explicit non-creating reconciliation. Existing internal commands retain their own identity and authority.

**Tech Stack:** Existing TypeScript, PostgreSQL16/Drizzle, Express, React, Orval/Zod4.4.3 and Vitest/Testing Library. Proposed new shared workspace package `@workspace/scheduling-core` uses exactly `@js-temporal/polyfill@0.5.1` plus existing Zod; no native-Temporal/global patch assumption. Dependency installation happens only during approved execution.

**Spec:** `docs/superpowers/specs/2026-10-13-saved-scheduling-capacity-design.md` at immutable b788a7f0baacf1a145a972613eb7865cab1eecd3, SHA256 d23d15e7a72848c4c18acd4c47569afdcb9fa6783bfa026f4b1a6545ed2db98e. Adam approved that written spec with his latest direct request to get this done for GrowthOS and its clients. This plan is pending owner review; it does not authorize implementation yet.

## Global Constraints

- Policy `formatVersion:1`, positive safe `revision`; unconfigured is null/revision0. Disable retains the envelope/revision; no reset/rearm.
- `minimumTravelGapMinutes:integer0..1440`; `maxConcurrentReservations:null or integer1..100`; `durationPresets:0..50`; unique stable preset IDs/nonblank unique labels1..80; `elapsedMinutes:integer1..1440`.
- Preserve UTC endpoints. Legacy null-end compatibility: appointment2h, project1day, legacy travel0. Presets are explicit elapsed-minute selections; no inferred CSS defaults, helper identity, crew pool, service category, route or company configuration.
- Appointments scheduled/confirmed and projects scheduled/in_progress with usable start consume capacity. Same staff cannot overlap; adjacent gap is `max(A.savedGap,B.savedGap)`, equality allowed. General company cap counts reservations once, half-open true peak; inspection cap remains distinct.
- Company zone is `organizations.timezone`; recorded inspection rule-source zone remains independent. Review both zones/digest where applicable; reject nonexistent local time and require an explicit ambiguous occurrence/offset.
- Three nullable JSONB fields only, no backfill/default and no new table: policy on org_settings, reservation on appointments/projects. Append0019 after0018; preserve142 table identities, all19 prior canonical SQL bytes and prior columns/data/constraints.
- All new DTOs closed; clients cannot supply server snapshot/digest/actor metadata. Current notes/confirmation/terminal closure preserve legacy authority; pure resource removal preserves surviving protection/provenance through a release revision.
- Manual operation receipt UUID never expires/rearms. GET/missing target/list match/error is not no-commit proof. No automatic mutation retry; retain exact submitted command through same-tab refresh/remount. No claim of closed-tab/device/browser-loss custody.
- Preserve existing customer-work/service/CALLIE command identities, participant and lifecycle rules, reminders/tasks and PR57 permanent initial-email claim. No borrowed returning-work root, generic replay, provider activation, live messages, spending, hosted migration, merge, deployment or launch.
- Exact whole-branch source/local/CI evidence remains distinct from Fly, real provider/device and contractor replacement acceptance. Writable rollback needs compatible enforcement or proven complete scheduling-write hold plus forward recovery.

## Review Focus

1. Lost acknowledgement, denied sessionStorage or corrupt retained command: hold new dispatch, restore original identity, reject mismatched acknowledgement (Tasks4,9,10).
2. Revoked staff/corrupt policy followed by completion or crew removal: preserve authorized historical closure; do not readopt tightened defaults or permit an unverifiable active release (Tasks5,6).
3. A 30-minute DST shift, browser/company mismatch or timezone-data disagreement: explicit occurrence/offset, elapsed duration and server revalidation; no silent date shift (Tasks1,3,10).
4. An old larger/corrupt saved gap beyond today's lower lookup horizon or a saturated query: complete validated resource coverage or actionable hold, never false availability (Tasks1,5,6).
5. Malformed/foreign/orphan history, deleted target and cleanup racing unknown CREATE: retain immutable receipt, close projections and withhold invalid links (Tasks4,7,8).

## Ownership and execution graph

Root owns this plan, all pushes/integration, backend/schema/OpenAPI/generated packages, shared date/command helpers, settings.tsx, project/customer-work/service/CALLIE seams and recovery/export. GEEKOM owns only new extracted presentation components plus assigned appointments.tsx/today.tsx and their consumer tests. Each PC has its own clone/isolated worktree. Never copy an active directory, force-push, revert another agent or edit a shared file from both lanes.

Root source sequence:1→2→3→4→5→6A–D→7→8→9→12. After5, source sublanes6A/B/C may run independently in disjoint owned files/worktrees; root alone integrates shared changes. GEEKOM10A/B/C may start after a reviewed Task3 contract commit is published;11 waits for10B and9. Root9 host imports wait for10A/B. Integration12 waits for5–11. Task13 follows12 and independent whole-branch review. A fresh scoped implementer and reviewer gate each task/subtask; parallelize only separate owned files. Four local slots include root; GEEKOM agents use its own slots. Read this spec and the plan in every execution brief.

After plan approval, create the product worktree/branch `agent/growthos-saved-scheduling-20261013` from the approved plan commit using the worktree skill; reuse a suitable attached checkout first. If the projectless native tool still cannot find Git, validate canonical origin/base and use the documented manual Git worktree fallback. Preserve the separate spec/PR57/main checkouts. Runtime dependencies and disposable test databases are prepared only in that execution worktree.

## Frozen shared interfaces

Task1 exports these names from `lib/scheduling-core/src/index.ts`; later tasks use them, not local copies. `ISO` is an explicit RFC3339 instant normalized to UTC milliseconds; `UUID` is a canonical lowercase UUID; `UserId` is an existing accepted staff string. Runtime validation rejects missing/extra keys, nonfinite numbers and invalid identifiers.

```ts
type DurationPreset = { id: UUID; label: string; elapsedMinutes: number };
type SchedulingPolicy = {
  formatVersion: 1; revision: number; enabled: boolean; timeZone: string;
  minimumTravelGapMinutes: number; maxConcurrentReservations: number | null;
  durationPresets: DurationPreset[]; digest: string;
  updatedAt: ISO; updatedByUserId: UserId;
};
type InspectionContext = { ruleTimeZone: string; availabilityDigest: string;
  sourceState: 'recorded' | 'legacy_default' | 'legacy_normalized' };
type ManualSourceRef = { sourceKind: 'lead' | 'direct_customer' | 'unlinked_manual';
  leadId: UUID | null; contactId: UUID | null; propertyId: UUID | null; estimateId: UUID | null };
type SchedulingReviewContext = {
  organizationId: UUID; policyRevision: number; policyDigest: string | null;
  companyTimeZone: string; inspection: InspectionContext | null;
  source: ManualSourceRef | null; targetVersion: ISO | null; targetFingerprint: string | null;
};
type WallTimeEvidence = { localDateTime: string; offset: string; timeZone: string };
type DurationChoice = { kind: 'explicit' | 'preserved_interval' | 'inspection_interval' | 'preset'; preset: DurationPreset | null };
type ReservationSnapshot = {
  formatVersion: 1; reservationRevision: number;
  sourcePolicyRevision: number; sourcePolicyDigest: string;
  approvedTimeZone: string; inspection: InspectionContext | null;
  startAt: ISO; endAt: ISO; resourceUserIds: UserId[];
  minimumTravelGapMinutes: number; duration: DurationChoice;
  admittedAt: ISO; admittedByUserId: UserId | null;
  target: { kind: 'appointment' | 'project'; id: UUID };
  lastTransition: { kind: 'admission' | 'release'; actorUserId: UserId | null; at: ISO };
};
type EffectiveReservation = { kind: 'appointment' | 'project'; id: UUID;
  startAt: ISO; endAt: ISO; resourceUserIds: UserId[]; savedGapMinutes: number };
type SchedulingMutationReview = { context: SchedulingReviewContext;
  duration: DurationChoice; startWallTime: WallTimeEvidence | null; endWallTime: WallTimeEvidence | null };
type NativeAppointmentCreateInput = { scheduledStart: ISO; scheduledEnd?: ISO;
  leadId?: UUID; contactId?: UUID; propertyId?: UUID | null; assignedUserId?: UserId;
  type?: AppointmentType; status?: AppointmentStatus; notes?: string };
type NativeProjectCreateInput = { leadId: UUID; name: string; estimateId?: UUID;
  status?: ProjectStatus; scheduledStart?: ISO; scheduledEnd?: ISO;
  crewUserIds?: UserId[]; crewNotes?: string };
type ManualSchedulingCommand = { operationId: UUID; review: SchedulingMutationReview } &
  ({ kind: 'appointment_create'; body: NativeAppointmentCreateInput } |
   { kind: 'project_create'; body: NativeProjectCreateInput });
type ManualSchedulingAck = {
  operationId: UUID; organizationId: UUID; actorUserId: UserId;
  kind: ManualSchedulingCommand['kind']; source: ManualSourceRef; payloadSha256: string;
  outcome: 'committed' | 'no_commit_refused';
  target: { kind: 'appointment' | 'project'; id: UUID; available: boolean } | null;
  refusalCode: string | null;
};
```

Native business shapes above mirror the current AppointmentInput/ProjectInput; Task1 pins the existing enum values from lib/db/src/schema/enums.ts and Task3 proves generated type/schema compatibility. Body excludes operationId/review/snapshot/actor fields and is not arbitrary JSON. Operation hash is SHA256 of a canonical sorted-key JSON envelope `{organizationId,actorUserId,kind,body,review}`; preserve array order and omitted-versus-null values. Hash exact validated submitted wire values before applying server defaults, never a default-expanded or refreshed body. Client/server share canonicalizer/UTF8 bytes. Reviewed context.source contains the server-resolved original lead/contact/property/estimate lineage (including a lead's real contact), rechecked under participant locks and echoed in ack/retained receipt. Company-policy-only reads have source:null; new staff commands require reviewed source. Preserve existing legitimate customerless manual appointments via explicit unlinked_manual/all-null source and org/actor custody, not an invented customer or new prohibition. Native projects still require their existing lead. Returning customer-work uses its own command. Do not hash refreshed review into an old command.

New wire fields are `operationId` and `schedulingReview`; native CREATE returns its existing row plus optional `schedulingOperation:ManualSchedulingAck`. The new UI requires a matching ack for its own operation. Legacy unconfigured DTOs with no protected reservation keep their response shape; configured admissions cannot omit scheduling review. Preserve PATCH expectedUpdatedAt as targetVersion and add expectedTargetFingerprint for versioned material/release operations. Read projections expose schedulingTargetFingerprint without requiring a valid policy. The server hashes the closed row's kind/id/version/endpoints/type/state/source IDs/sorted resources/snapshot revision, so a same-millisecond competing change cannot defeat the old Date token. Create context has both target values null. Preserve existing customer-work expectedWorkVersion and source-specific versions alongside them; historical edits/closure do not require current-policy adoption.

`GET /v1/settings/scheduling-policy` returns PolicyReadResult `{policy:SchedulingPolicy|null,context:SchedulingReviewContext}`. PolicySaveInput is `{expectedRevision:number,expectedCompanyTimeZone:string,enabled:boolean,minimumTravelGapMinutes:number,maxConcurrentReservations:number|null,durationPresets:{id:UUID|null,label:string,elapsedMinutes:number}[]}`; null preset ID requests a server UUID. `PUT` returns PolicyReadResult; actor/zone/digest/revision stay server-owned. Policy/review reads require active accepted crm.read authority; save requires settings.manage. `GET /v1/scheduling/review-context` takes `{sourceKind:'lead'|'direct_customer'|'unlinked_manual',sourceId?:UUID,propertyId?:UUID,estimateId?:UUID,targetKind?:'appointment'|'project',targetId?:UUID}`; sourceId required for lead/customer, forbidden for unlinked, target pair both present/absent. Resolve true selected lineage; no body-derived invented customer. `POST /v1/scheduling/operations/reconcile` takes exact original ManualSchedulingCommand and performs no booking, only returns/stores terminal outcome. No GET claims no-commit.

Task3 also creates root-owned `artifacts/command-center/src/lib/scheduling-ui-contract.ts` with exact controlled props/types. `PolicyViewState` is `{kind:'loading',scope}` | `{kind:'unconfigured'|'loaded',scope,value:PolicyReadResult}` | `{kind:'read_error'|'invalid',scope,message}` | `{kind:'saving'|'stale'|'unknown',scope,value:PolicyReadResult,draft:PolicySaveInput,message}`. Scope is `{organizationId,actorUserId}` and must be defined/authorized. `PolicySaveResult` is `{kind:'saved',value:PolicyReadResult}` or `{kind:'stale'|'unknown'|'refused',message:string}`. IntervalInput is `{startAt:ISO|null,endAt:ISO|null,legacyEffectiveEnd:ISO|null,reservation:ReservationSnapshot|null,evidence:'legacy'|'versioned'|'invalid'}`; ResourceChoice is `{id:UserId,label:string}`. GateView is `{kind:'not_configured'|'available'|'held',message:string|null}`; AuthorizedConflict is null or `{reservationKind:'appointment'|'project',reservationId:UUID,resourceLabel:string,startAt:ISO,endAt:ISO,reason:string}`. Row readers project only closed valid snapshot fields; invalid raw evidence is flagged, never leaked or presented as legacy-zero. These are view types, not new permission authority.

Use stable scheduling error codes: `stale_scheduling_review`, `invalid_scheduling_policy`, `invalid_reservation_snapshot`, `scheduling_coverage_limit`, `travel_conflict`, `company_capacity_conflict`, `inspection_capacity_conflict`, `invalid_wall_time`, `ambiguous_wall_time`, `operation_identity_conflict`. Conflict bodies contain only authorized same-org reservation references and distinct service/travel/company/inspection reasons. Existing role/lineage errors retain their own codes.

## Transaction order

All helpers take the existing `ScheduleTransaction`; none obtains lifecycle after schedule or uses global db within a transaction. Policy reads after schedule are side-effect-free. Existing extra command/effect/participant locks retain their sequence; acquire newly needed policy/target row locks before dependent participant writes, with users/targets ordered by identifier.

| Entry | Required enclosing sequence and replay position |
|---|---|
| Native CRM create/update | lifecycle/admission → org schedule → accepted actor SHARE → manual operation lock/receipt lookup for new commands → target UPDATE/classification for edits → side-effect-free policy/org read only for admission → ordered source/member locks → gate/write/audit/reminder. Prior receipt returns before newly changed/corrupt policy parsing. Preservation/terminal and valid pure release do not parse/adopt current policy; they retain original protection. Workday's supplied transaction already owns lifecycle/schedule and is reused. |
| Returning command | preserve lifecycle → schedule → invoices → actor SHARE → existing request lock → prior command lookup → work; policy recheck applies only after replay. |
| Service-care | move lifecycle lock/check into transaction entry → schedule → actor SHARE → existing replay → obligation/customer and current response/version → participant locks → policy/resource/inspection gate → appointment/task/audit. |
| CALLIE | preserve lifecycle → schedule → CALLIE → existing replay → intake UPDATE/call SHARE/handoff-task UPDATE/customer-property-lead SHARE/ordered accepted members → shared gate. |
| Concierge/inspection | preserve actual source/offer authority → lifecycle/admission where existing public path requires it → schedule → effective policy/inspection read → parent/staff locks → final gates/insert. Offer context travels to admission; no fabricated staff approval. |
| Policy/inspection/settings initialization | lifecycle/active staff authority → schedule → org/settings row locks → expected revision/zone check → atomic config/revision/audit. Public new-org initialization is exempt only before the organization can have reservations. |
| Existing org timezone PATCH | verified platform-admin authority → lifecycle/schedule → org/settings row locks → atomic org zone/configured policy revision-digest/audit; never rewrite inspection rules. |
| Manual reconciliation | same authorized CRM lifecycle/schedule/actor/operation ordering as CREATE; prior receipt first, otherwise insert terminal no_commit_refused under that lock. No target creation. |

The operation advisory key is `manual-scheduling:<operationUUID>` and is global, matching the audit PK uniqueness. Acquire it only after the org schedule lock, consistent with existing command lock ordering. Never acquire it first in reconciliation. A UUID already used by another tenant/actor/action or ordinary audit event is an identity conflict with no leaked details. Domain validation after receipt lookup may create a retained terminal refusal; transaction/lock/database errors remain unknown.

---

### Task1: Pure models, time conversion and reservation mathematics — WILLOWFORGE

**Files:** Create `lib/scheduling-core/{package.json,tsconfig.json,vitest.config.ts}`, `src/{index.ts,models.ts,time.ts,reservations.ts,canonical.ts}` and `src/{models,time,reservations,canonical}.test.ts`. Package test script is `vitest run --config vitest.config.ts`, include src/**/*.test.ts; dev Vitest4.1.10, existing Zod catalog and pinned Temporal dependency. Modify root tsconfig references, consumer package/tsconfig references and pnpm-lock.yaml only for the approved package/dependency.

**Interfaces:** Consume exact existing enum values in lib/db/src/schema/enums.ts without importing db at runtime. Produce AppointmentType/AppointmentStatus/ProjectStatus, models above and closed `schedulingPolicySchema`, `reservationSnapshotSchema`, `schedulingReviewContextSchema`, `schedulingMutationReviewSchema`, `manualSchedulingCommandSchema`, `manualSchedulingAckSchema`, `policySaveInputSchema`; `resolveWallTime(localDateTime:string,timeZone:string):{kind:'unique'|'ambiguous'|'nonexistent',choices:{instant:ISO,offset:string}[]}`, `validateWallTime(instant:ISO,evidence:WallTimeEvidence):void`, `companyDayBounds(date:string,timeZone:string):{from:ISO,to:ISO}`, `addElapsedMinutes(start:ISO,minutes:number):ISO`, `classifyReservationTransition(before:SchedulingCandidate|null,after:SchedulingCandidate):'admission'|'release'|'preserve'`, `assertTravel(candidate:EffectiveReservation,neighbors:EffectiveReservation[]):void`, `peakConcurrency(candidate:EffectiveReservation,neighbors:EffectiveReservation[]):number`, `canonicalSchedulingEnvelope(args:{organizationId:UUID,actorUserId:UserId,kind:ManualSchedulingCommand['kind'],body:ManualSchedulingCommand['body'],review:SchedulingMutationReview}):string`.

SchedulingCandidate is the closed scheduling-relevant row `{kind,id,startAt:ISO|null,endAt:ISO|null,resourceUserIds:UserId[],type:string,status:string,source:ManualSourceRef,reservation:ReservationSnapshot|null}`; effective legacy endpoints are derived separately. Create allocates a server random target UUID inside the owning transaction before snapshot creation; it is never the submitted operation ID or a client row ID. New/never-admitted unscheduled candidates retain null snapshot. An existing protected job losing its usable interval is a release: retain its last snapshot/history, including when both dates are cleared while crew remains; later reactivation requires current admission rules.

- [ ] Write model-boundary tests: gap1440 accepted/1441 refused; cap100 accepted/101 refused; preset50 accepted/51 refused; fractional/NaN/extra-key/duplicate-ID-label rejected; fixed legacy ends and sorted distinct resources.
- [ ] Write exact time/algorithm tests before code. Assert NewYork2026-03-08T02:30 is nonexistent;2026-11-01T01:30 has05:30Z/-04:00 and06:30Z/-05:00. LordHowe half-hour fold, Kolkata non-hour zone, invalid calendar date, elapsed180min across DST and company day lengths23/25h must pass. A gap60 at13:00 after12:00 passes;12:59 fails, in both orders and across all resource combinations. Long candidate across nonoverlapping neighbors yields true peak2, not summed intersections; touching ends release before starts.
- [ ] Run `pnpm --filter @workspace/scheduling-core test`; require RED assertions/import failure before implementation. Add exact dependency/package linking with pnpm11.3.0 only now, leaving other versions and install policies intact.
- [ ] Implement signatures. For wall-time candidates, use Temporal earlier/later conversions, retain only candidates whose projected PlainDateTime equals the requested input, dedupe/sort exact instants; reject a missing occurrence choice or mismatching offset on final validation. UTC elapsed addition uses Instant, not calendar arithmetic. No global Temporal patch. Preserve manual multi-day endpoints and nonmaterial transitions.
- [ ] Run that suite plus `pnpm run typecheck:libs`; require GREEN. Commit only owned paths as `feat: add shared scheduling models and time math`; fresh independent task review.

### Task2: Additive schema and byte-pinned migration — WILLOWFORGE

**Files:** Modify `lib/db/src/schema/{settings,appointments,projects}.ts`; create `reports/staging-schema-preview-2026-10-01/0019_saved-scheduling-policy.sql`, `scripts/saved-scheduling-schema-preview.mjs`, its `.test.mjs`, and `artifacts/api-server/src/services/scheduling-schema.test.ts`.

**Interfaces:** Consume Task1 types. Produce nullable `schedulingPolicy`/`schedulingReservation` columns typed to their respective models; CHECK names `org_settings_scheduling_policy_ck`, `appointments_scheduling_reservation_ck`, `projects_scheduling_reservation_ck`. Insert schemas omit all server-owned fields. Audit UUID PK stays the operation uniqueness seam; no new table/index is justified.

- [ ] Write real-PG tests for null legacy rows, valid envelopes and wrong/missing JSON types/format/bounds rejected by SQL. Write preview tests asserting142 same table identities, exactly three columns/new allowlisted CHECKs, unchanged prior constraints/columns/data and19 predecessor SHA256 values.
- [ ] Run `node scripts/local-dev.mjs test src/services/scheduling-schema.test.ts` and `pnpm --filter @workspace/scripts exec vitest run saved-scheduling-schema-preview.test.mjs`; require RED. Use only the runner's owned PG16 fixture; never a provider URL.
- [ ] Implement additive Drizzle/SQL. Guard type-sensitive casts with CASE and reject missing-key SQL NULL via COALESCE(false). Deep closed key/resource/digest/zone/row agreement remains Task1/5 validation. Add no defaults/backfill or historical SQL edits.
- [ ] Run the two commands and `node scripts/saved-scheduling-schema-preview.mjs`; require GREEN and exact delta report. Explicitly provision updated disposable schema: old fixtures checking only organizations are insufficient.
- [ ] Commit owned paths as `feat: add retained scheduling policy and reservation schema`; review before Task3.

### Task3: Serialized policy, timezone and generated contract — WILLOWFORGE/root

**Files:** Create API services `scheduling-policy.ts`/`.test.ts`, `scheduling-policy-concurrency.test.ts`, route `routes/v1/scheduling.ts`; modify `services/settings.ts`, `routes/v1/{settings,orgs,index}.ts`, `services/contractor-today.ts`, `lib/api-spec/openapi.yaml`/package.json, generated api-zod/api-client-react outputs. Create root UI `src/lib/scheduling-ui-contract.ts`, `scripts/scheduling-codegen-strict.mjs`/`.test.mjs` and `reports/scheduling-consumer-contract-2026-10-13.md` with typed fixture JSON examples.

**Interfaces:** `readSchedulingContext(tx:ScheduleTransaction,orgId:UUID,target?:SchedulingCandidate):Promise<{policy:SchedulingPolicy|null,context:SchedulingReviewContext,effectiveInspection:InspectionAvailabilitySettings}>`; `saveSchedulingPolicy(actor:SchedulingActor,input:PolicySaveInput):Promise<PolicyReadResult>`; `setSchedulingCompanyTimeZone(actor:SchedulingActor,orgId:UUID,zone:string,expectedZone:string):Promise<void>`. SchedulingActor is server-only `{organizationId:UUID,userId:UserId}` with active accepted role rechecked under the appropriate staff/platform authority. Produce frozen routes/DTO/error names and authorized read projections. Transaction reader never calls lazy/global getOrgSettings.

- [ ] Write tests for unconfigured side-effect-free reads, first revision1/save increments, disable retained revision/presets provenance, corrupt configuration holds admissions, active accepted settings.manage actor, unknown keys and forged revision/zone/digest refused. Inspection settings and org-zone races must produce stale review in both orderings, including policy revision0 and differing rule/company zones.
- [ ] Write strict codegen tests rejecting snapshots/actor/digest in body, preserving PR57 estimate strictness, and fixture type compatibility. Run `node scripts/local-dev.mjs test src/services/scheduling-policy.test.ts src/services/scheduling-policy-concurrency.test.ts`; `pnpm --filter @workspace/scripts exec vitest run scheduling-codegen-strict.test.mjs`; require RED.
- [ ] Implement dedicated policy handlers and atomic existing inspection/init/zone writers under the order table. Digest normalized effective inspection rules, explicit sourceState and both rule-source/company zones; a company-zone change invalidates review without reinterpreting stored windows. Generic settings DTO omits policy. New presets receive canonical UUIDs on explicit save; existing IDs stay stable. Expose default/normalized inspection provenance as legacy compatibility, not owner approval.
- [ ] Add OpenAPI context/new command/ack/projection fields and strict generated schemas, source binding/target fingerprint and controlled UI types above. Task4 wires reconciliation implementation; its declared contract is stable now. Today uses company zone/day bounds; financial/reporting semantics remain unchanged. Invalid timezone/unknown context is an actionable hold, never browser fallback.
- [ ] Run focused suites, `pnpm --filter @workspace/api-spec run codegen`, `node scripts/local-dev.mjs typecheck`; require GREEN. Root publishes this reviewed contract commit/fixtures before GEEKOM Task10; commit `feat: serialize scheduling policy and publish consumer contract`.

### Task4: Permanent manual operation receipt and non-creating reconciliation — WILLOWFORGE

**Files:** Create services `manual-scheduling-receipt.ts`/`.test.ts`, `manual-scheduling-receipt-concurrency.test.ts`; extend root `routes/v1/scheduling.ts`, create `routes/v1/scheduling.test.ts`; create closed receipt schema/projection in `scheduling-history.ts` (shared with Task7 under sequential ownership).

**Interfaces:** `runManualSchedulingCreate(tx,actor,command,create:(tx:ScheduleTransaction)=>Promise<{kind:'appointment'|'project',id:UUID}>):Promise<{ack:ManualSchedulingAck,newlyCreated:boolean}>`; `reconcileManualScheduling(actor,original):Promise<ManualSchedulingAck>`. Callers own lifecycle/schedule/actor locks. Receipt action is `scheduling.manual_operation.v1`, audit `id=operationId`, entity target nullable, closed metadata `{formatVersion:1,kind,source,payloadSha256,outcome,target,refusalCode,recordedAt}`. Target and source IDs are original, not mutable derived replay state. Business transition/refusal audits use separate random IDs; ordinary listAuditEvents excludes raw operation receipt rows, which would otherwise expose operationId via outer audit.id.

- [ ] Write two-session races: CREATE-first reconciliation returns the original target; refusal-first delayed CREATE returns terminal refusal and inserts no target/reminder/event. Same UUID/payload inserts once; actor/tenant/kind/hash collision holds. Inject receipt insert rollback, lock timeout and lost response; never manufacture no-commit from failed transaction.
- [ ] Assert edited/deleted target keeps original committed outcome/UUID; no expiry/rearm; existing ordinary-audit collision leaks nothing. Run `node scripts/local-dev.mjs test src/services/manual-scheduling-receipt.test.ts src/services/manual-scheduling-receipt-concurrency.test.ts src/routes/v1/scheduling.test.ts`; require RED and actual independent PG sessions.
- [ ] Implement receipt lookup under shared operation lock before fresh policy/source admission. Commit booking/receipt/history together via supplied tx; do not use global recordAudit. Run the native create callback inside a SAVEPOINT created after receipt locks: only recognized domain refusal may roll back that savepoint and commit a retained no_commit_refused. Raw SQL/lock/transport failures roll back the outer transaction and remain unknown. A deterministic refusal after a partial callback write leaves no booking/reminder/history side effects. Reconciliation returns prior exact outcome or commits a terminal refusal without creation; its lock fences a pending original. Return target.available:false if subsequently absent; never infer failure.
- [ ] Wire non-creating endpoint with crm.write, contractorMutation/session-origin protections and active accepted actor; reject server-authority fields in closed original command. Prior committed/refused result is returned before current defaults can reinterpret it. Receipt replay validates structural shape/hash/binding, not current timezone/source/policy liveness. Authorization/identity/DB failure keeps unknown unless a terminal refusal committed.
- [ ] Run focused suites/types GREEN, commit `feat: retain manual scheduling outcomes and safe reconciliation`; fresh review.

### Task5: CRM admission, preservation, release and native route effects — WILLOWFORGE (one crm.ts owner)

**Files:** Modify `services/contractor-scheduling.ts`, `services/crm.ts`, `routes/v1/{appointments,projects}.ts`; create `services/scheduling-admission.ts`/`.test.ts`, `scheduling-admission-concurrency.test.ts`, `services/manual-scheduling.ts`/`.test.ts`; extend `contractor-scheduling.test.ts`, `crm-appointment-conflict.test.ts`, `appointment-parent-coherence.test.ts`, `contractor-workday-concurrency.test.ts`.

**Interfaces:** `prepareSchedulingAdmission(tx:ScheduleTransaction,authority:ServerSchedulingAuthority,before:SchedulingCandidate|null,after:SchedulingCandidate,review:SchedulingMutationReview|null):Promise<{transition:'admission'|'release'|'preserve',snapshot:ReservationSnapshot|null}>`; `appendSchedulingTransition(tx:ScheduleTransaction,authority:ServerSchedulingAuthority,before:ReservationSnapshot|null,after:ReservationSnapshot|null,target:{kind:'appointment'|'project',id:UUID}):Promise<void>`. ServerSchedulingAuthority is `{organizationId,actorUserId:UserId|null,origin:'manual'|'returning_command'|'service_care'|'callie'|'concierge'|'workday',sourceId:UUID|null,reviewMode:'reviewed'|'existing_workflow_transaction'}` constructed only after existing locked source/actor approval; no DTO accepts it. Only a legitimately nonhuman existing source workflow may use transaction-fresh mode; staff native booking stays reviewed.

Refactor native internals to `createAppointmentInTransaction(tx,orgId,input,authority):Promise<Appointment>` and `createProjectInTransaction(tx,orgId,input,authority):Promise<Project>`; existing wrappers still own their transaction. New manual-scheduling.ts exports `createManualScheduledAppointment(actor:SchedulingActor,command:ManualSchedulingCommand):Promise<{record:Appointment|null,ack:ManualSchedulingAck,newlyCreated:boolean}>` and equivalent createManualScheduledProject with Project. These own one enclosing tx/receipt, use native primitives without nested db.transaction and fetch the original available replay target by its bound ID. Route selects this path for submitted operationId, otherwise preserves eligible legacy wrapper. Supplied update execution.transaction/preserveServiceTaskPlan/originalCompletionId stays intact. Fresh/available replay responses retain their row plus schedulingOperation. Refused or committed-unavailable operation returns typed409 with the same ack; new hook validates terminal ack independently of HTTP success. Never substitute a new row or retryable generic error.

- [ ] Write both-order real-PG contenders for travel/cap/policy changes; all appointment/project combinations and crew members; saturation10001 rows yields coverage hold. Query validation includes active same-resource corrupt snapshots outside the lower current horizon. Do not use the UI200-row list for capacity.
- [ ] Write legacy null-end/start-only/PR56 end-clear tests and notes/confirm/completion after stricter/disabled/corrupt policy. Clearing both dates of an existing protected project while crew remains releases active capacity and retains the last snapshot/history; reactivation uses current admission rules. A valid pure crew subset creates a release revision preserving endpoints/gap/preset/original policy-zone/admission actor; mixed addition/reschedule is admission. Same-millisecond changed resources with old target fingerprint return stale instead of silently removing new crew. Invalid active evidence holds partial release, while terminal closure still retains history. Same-org revoked staff closure remains authorized.
- [ ] Run `node scripts/local-dev.mjs test src/services/scheduling-admission.test.ts src/services/scheduling-admission-concurrency.test.ts src/services/manual-scheduling.test.ts src/services/crm-appointment-conflict.test.ts src/services/appointment-parent-coherence.test.ts src/services/contractor-workday-concurrency.test.ts`; require RED.
- [ ] Implement complete transactional neighbor query using actual row effective end and saved gaps, with max1440-minute horizon for validated records; validate active relevant-resource evidence before trusting that horizon. Limit each relevant active scan to10001 and hold above10000; never undercount. Company overlap uses half-open true peak/excluded edited target; multi-user job counts once. Classify locked existing row before reading policy on preservation/terminal/release, so corrupt policy cannot block historical closure. All applicable gates and snapshot/audit/reminder writes share tx.
- [ ] Integrate receipt before native CREATE, lifecycle at correct entry and locked source/target versions. Move project.created audit into transaction. Emit appointment.booked only for newlyCreated original commit, never replay/reconcile. A postcommit observer error cannot become a no-commit result. Preserve old unconfigured external DTO compatibility; new native UI always supplies operation identity.
- [ ] Run focused suites/types GREEN; commit `feat: enforce saved scheduling reservations in native CRM`; fresh review of the single shared owner diff.

### Task6: Returning, service-care, CALLIE and inspection writer coverage — WILLOWFORGE

Run four independently testable subtask gates; each follows the RED/implementation/GREEN/commit/review steps below on its own files:6A returning-customer/workday and returning concurrency tests;6B service-care and source route/tests;6C callie-office and source route/tests;6D inspection-booking/concierge/Today and their tests. Only root owns the shared scheduling-writer-coverage ledger and generated contracts.6A/B/C may run in separate worktrees after5;6D integrates their common inspection assumptions. Each subtask has its own source-ledger row and commit, so a reviewer can reject one without reopening an accepted peer.

**Files:** Modify `services/{returning-customer,service-care,callie-office,inspection-booking,concierge,contractor-today,workday-shared}.ts` and relevant routes/closed source booking DTOs; extend `returning-customer-concurrency.test.ts`, `service-care.test.ts`, `callie-office.test.ts`, `concierge-booking.test.ts`, `concierge-slots.test.ts`, `contractor-today.test.ts`; create `scheduling-writer-coverage.test.ts`.

**Interfaces:** Consume Task3 reader/review and Task5 admission/transition functions in the existing ScheduleTransaction. Existing requestId/expectedWorkVersion/responseId/expectedFingerprint/customerConfirmed/expectedUpdatedAt remain original command authority, not a new manual operation.

- [ ] Write one authority/race case per writer: replay after policy/zone change returns original work; fresh booking stale context holds; service lifecycle pause wins before admission; CALLIE source response/accepted staff changes hold; workday completion preserves its existing transaction/task reconciliation.
- [ ] Write inspection offers/admission using the same active-inspection population/effective ends, independent rule-source zone/digest, current general cap and assigned-staff travel. An unassigned offer explicitly does not prove a technician free. Include revision0 inspection-settings change and org-zone change that preserves old windows/blackouts.
- [ ] Run `node scripts/local-dev.mjs test src/services/scheduling-writer-coverage.test.ts src/services/returning-customer-concurrency.test.ts src/services/service-care.test.ts src/services/callie-office.test.ts src/services/concierge-booking.test.ts src/services/concierge-slots.test.ts src/services/contractor-today.test.ts`; require RED.
- [ ] Integrate through existing enclosing tx/order, with transaction-fresh service lifecycle and locked effective inspection reader. Anonymous concierge carries actual offer/source authority and final recheck, not invented staff approval. Preserve existing manual/staff out-of-inspection-hours warning/override semantics; concierge offers/admission enforce their existing windows/weekdays/blackouts, and all applicable capacity/travel gates remain mandatory. Material source booking DTOs carry reviewed context; transaction-fresh context only for existing nonhuman workflow. Preserve original replays before fresh validation.
- [ ] Run focused actual-PG suites/types GREEN; commit `feat: apply shared scheduling gates across booking workflows`; fresh review and writer coverage ledger.

### Task7: Retained history, cleanup and closed export — WILLOWFORGE

**Files:** Extend `services/scheduling-history.ts`/`.test.ts`, `services/{crm,demo-data,onboarding,customer-lifecycle-export}.ts`; create `scheduling-history-concurrency.test.ts`; extend audit-events-filter/native-customer-export/returning-customer-export/contractor-workday-export/customer-lifecycle-export-deadline/data-lifecycle-inventory tests.

**Interfaces:** `projectSchedulingAudit(event:AuditEvent):ClosedBusinessSchedulingSummary|null`; `assertNoSchedulingParticipantHistory(tx:ScheduleTransaction,orgId:UUID,selectedSourceIds:UUID[]):Promise<void>`; `projectSchedulingPolicyExport(policy:SchedulingPolicy|null):ClosedPolicyExport|null`; `projectReservationExport(snapshot:ReservationSnapshot|null,authorizedHistoricalLinks:Set<string>):ClosedReservationExport|null`. ClosedPolicyExport contains formatVersion/revision/enabled/timeZone/gap/cap/presets/updatedAt, no internal digest/actor. ClosedReservationExport contains reservationRevision/approvedTimeZone/inspection ruleTimeZone/service endpoints/same-org historical resources/gap/duration/target, no operation/digest/actor internals. ClosedBusinessSchedulingSummary is `{event:'policy_updated'|'reservation_admitted'|'reservation_released'|'reservation_deleted'|'operation_committed'|'operation_refused',occurredAt:ISO,target:{kind:'appointment'|'project',id:UUID,available:boolean}|null,source:ManualSourceRef|null,before:ClosedReservationExport|ClosedPolicyExport|null,after:ClosedReservationExport|ClosedPolicyExport|null,reasonCode:string|null}`. Root Task7 defines strict projector schemas, verifies retained original-org evidence for a deleted target and withholds malformed/foreign links; target absence alone cannot erase trusted history.

- [ ] Write committed/refused/orphan/malformed/foreign history cleanup guards and deletion races. Project deletion retains final snapshot/release audit before row deletion. Contact/test-lead/demo cleanup cannot erase any selected participant's receipt/history. Assert retention before deliberately calling synthetic deleteTestOrgs teardown.
- [ ] Pin export placement explicitly: keep existing28 datasets; add closed current organization.schedulingPolicy and organization.schedulingHistory metadata, read within the existing bounded repeatable-read snapshot. Add manifest.schedulingPolicySha256/schedulingHistorySha256 and history count/withheld-invalid-link coverage; preserve manifest.dataSha256's existing data-only semantics. History reads use existing maxRows2000+1 and total10MiB budget, refusing over-limit export without partial output. Appointment/project datasets gain closed reservation fields. There is no existing generic audit export dataset to extend: scheduling business summaries live in the explicit organization metadata. No raw org_settings/audit dataset, provider settings, operation capabilities or invented audit rows.
- [ ] Run `node scripts/local-dev.mjs test src/services/scheduling-history.test.ts src/services/scheduling-history-concurrency.test.ts src/services/audit-events-filter.test.ts src/services/native-customer-export.test.ts src/services/returning-customer-export.test.ts src/services/contractor-workday-export.test.ts src/services/customer-lifecycle-export-deadline.test.ts src/services/data-lifecycle-inventory.test.ts`; require RED.
- [ ] Implement exact selected-source guards under enclosing locks and closed projectors next to the existing estimate-delivery projector. Keep immutable full receipt/snapshot evidence in database inventory/recovery, expose only authorized business fields in UI/export. Invalid links are withheld/flagged, not recast as legacy-safe history. No runtime org/audit purge is introduced.
- [ ] Run suites and PR57 estimate-delivery-history regression GREEN; commit `feat: retain scheduling evidence through cleanup and export`; independent privacy/retention review.

### Task8: Local additive recovery and enforcing rollback boundary — WILLOWFORGE/root

**Files:** Create `scripts/saved-scheduling-recovery-fixture.mjs`; modify `scripts/{contractor-recovery-drill,contractor-recovery-drill.test,contractor-recovery-app-probe,release-schema,release-schema.test}.mjs`; create `reports/saved-scheduling-recovery-2026-10-13.md` and `scripts/saved-scheduling-rollback-boundary.test.mjs`.

**Interfaces:** New fixture adds configured/disabled policy, legacy nulls, old larger gaps, release revisions and committed/refused/deleted-target audit receipts. Serialization set includes scheduling_policy/scheduling_reservation. Existing historical migration packets/source hashes remain untouched; this new candidate has an independent0019/schema identity.

- [ ] Write fixture before/after restore equality for rows/policy/snapshots/audits, SQL predecessor byte pins and returned original outcomes after target deletion. Write rollback eligibility test refusing any writable artifact without saved-snapshot enforcement; do not certify old PR57 as compatible.
- [ ] Run `pnpm --filter @workspace/scripts exec vitest run contractor-recovery-drill.test.mjs release-schema.test.mjs saved-scheduling-rollback-boundary.test.mjs`; require RED.
- [ ] Append fixture/0019 to local drill only. Pin a compatible rollback artifact as the newly reviewed scheduling-capable source artifact and prove its API still rejects the old-gap conflict using the restored fixture. Re-running a local same-feature candidate is enforcement proof, not provider deployment reversal proof. If no second independently verified compatible artifact exists, release eligibility remains held; a prefeature binary is unavailable unless every listed scheduling/config writer has a separately verified complete mutation hold. Do not invent an existing hold or down-migrate/drop history.
- [ ] Run fixture/drill suites GREEN, retain owned-container/temporary cleanup receipt and new exact source/schema/SQL hashes. No hosted DB push/copy/migration, Fly call or restored data promoted into live worktrees.
- [ ] Commit `test: verify saved scheduling recovery and rollback boundaries`; fresh independent recovery review. Final report distinguishes local restore/enforcement proof from still-open hosted rehearsal.

### Task9: Shared native review/unknown-command state and root-owned host forms — WILLOWFORGE

**Files:** Create `artifacts/command-center/src/hooks/use-manual-scheduling-command.ts`/`.test.tsx`, `src/lib/scheduling-command.ts`/`.test.ts`; modify root-owned `src/lib/contractor-schedule.ts`, `pages/settings.tsx`, `components/{project-form-modal,customer-work-form,service-care-panel,callie-case-panel}.tsx`, and the mixed `pages/contractor-scheduling.test.tsx`; extend existing host tests and create `components/scheduling-shared-consumers.test.tsx` plus `src/lib/contractor-schedule.test.ts` for shared helper cases.

**Interfaces:** `useManualSchedulingCommand({scope:{organizationId,actorUserId,canWrite:boolean}|null,kind,sourceKey,dispatch:(command:ManualSchedulingCommand)=>Promise<unknown>,reconcile:(original:ManualSchedulingCommand)=>Promise<unknown>}):{state,submit:(command:ManualSchedulingCommand)=>Promise<void>,reconcileOriginal:()=>Promise<void>,acknowledgeRefusal:()=>void}`. State is idle/preparing/submitting/unknown/reconciling/committed/refused/blocked_custody/blocked_scope, with original command/ack only in its authorized current scope. Require defined current member authority and canWrite before dispatch; missing query cache is not permission. Capture exact command and expected hash before dispatch in same-tab sessionStorage, keyed `growthos.scheduling.pending.v1:<org>:<actor>:<kind>:<sourceKey>`; verify readback. Acknowledging a typed refusal permits new explicit review, never mutates the old terminal ID. Task10/11 consumers use this root hook without editing it.

- [ ] Write denied/quota/corrupt storage and deferred-ack tests: no POST before custody succeeds; remount restores original command without automatic replay; refresh/list absence cannot clear unknown; exact reconciliation only; mismatched IDs/actor/org/kind/hash/source remain held; committed unavailable target stays committed. Tenant/actor switches hide prior payload and never transfer its identity. No expiry/new-UUID replacement.
- [ ] Write root-form tests for explicit preset/range/start-only preservation, unchanged legacy edit omitting fabricated end, pure release/closure despite read-error hold on material edits. Service/CALLIE retain their exact source booking request/payload through remount and only offer their established same-request reconciliation; a generic response/error cannot rearm a fresh booking. Keep other source command controls and completed email unchanged.
- [ ] Run `pnpm --filter @workspace/command-center exec vitest run src/hooks/use-manual-scheduling-command.test.tsx src/lib/scheduling-command.test.ts src/lib/contractor-schedule.test.ts src/components/scheduling-shared-consumers.test.tsx`; require RED.
- [ ] Implement explicit no-retry transport/state machine and strict acknowledgement matching; resolve sourceKey from reviewed immutable source IDs, fence another CREATE in that original source context. Use Task1 timezone helper/shared generated DTOs and Task10 components after their reviewed commit. Root alone imports the policy editor into settings and updates shared project/customer-work/service/CALLIE hosts. Keep existing returning-customer hook/request identity; no raw fetch shape guessed by consumers.
- [ ] Run focused suites/types GREEN; commit `feat: retain native scheduling review and uncertain command state`; fresh review.

### Task10: Extracted scheduling policy and interval/travel UI — GEEKOM

**Files:**10A creates `artifacts/command-center/src/components/scheduling-policy-editor.tsx`/`.test.tsx`;10B creates `components/{scheduling-interval-fields,scheduling-interval-review}.tsx` and matching tests;10C creates `components/scheduling-reservation-summary.tsx`/`.test.tsx` and modifies `pages/today.tsx`/`today.test.tsx`. GEEKOM coordinator owns one new `src/test/scheduling-ui-fixtures.ts` typed against Task3, separate from shared test/render/setup/mock-api. No settings.tsx/shared-helper/backend/generated-package edits. Each subtask is its own RED/GREEN/commit/fresh-review gate; disjoint files may run in parallel.

**Interfaces:** Editor props `{saved:PolicyViewState,canManage:boolean,onSave:(input:PolicySaveInput)=>Promise<PolicySaveResult>,onRefresh:()=>Promise<PolicyReadResult>}`; interval props `{context:SchedulingReviewContext,durationPresets:DurationPreset[],existingInterval:IntervalInput,resources:ResourceChoice[],onReviewed:(review:SchedulingMutationReview)=>void}`; summary props `{reservation:ReservationSnapshot|null,serviceInterval:IntervalInput,inspectionGate:GateView,companyGate:GateView,authorizedConflict:AuthorizedConflict}`. Task3 root UI contract defines types; root supplies transport/defined authority. Today preserves four queues/exact navigation/truncation/error states and uses backend company-zone bounds/projections. Contract pins exact fixtures/props before GO.

- [ ] Write role/tenant/read-error/stale/unknown policy fixtures and tests, no false saved success. Exact draft values retained in the same context; new context cannot inherit them. Explicit preset selection, two named zones, invalid/ambiguous DST choice and no inferred service type are required.
- [ ] Write mobile/keyboard interval/travel/cap summary tests: service endpoints never inflated by travel; staff resource conflict distinct from general/inspection cap; same tenant adjacent reference only; unassigned availability truthful; old saved end/preset/decrease/disable provenance visible.
- [ ] Run each subtask's owned tests:10A policy-editor.test.tsx;10B interval-fields.test.tsx/interval-review.test.tsx;10C reservation-summary.test.tsx/pages/today.test.tsx, with `pnpm --filter @workspace/command-center exec vitest run <these exact src paths>`; require RED before its implementation.
- [ ] Implement using existing shadcn/Radix styles, Task1 shared helper and exact reviewed Task3 contract. No invented provider/helper/crew badges or current-company values. Return isolated commit/owned paths/tests to root; no shared push without root review.
- [ ] Run focused UI/types GREEN; fresh peer/task review then root integrates exact commit. Root handles shared host imports in Task9.

### Task11: Appointment consumer and acceptance — GEEKOM

**Files:** Modify only `pages/appointments.tsx`, bounded `pages/appointments-property.test.tsx` and `pages/appointment-linked-navigation.test.tsx`; create `pages/appointments-scheduling.test.tsx`. Today belongs to10C. Consume root hook/components/contracts; changes to shared project/date/settings/appointment-linked-card files and mixed pages/contractor-scheduling.test.tsx return to root.

**Interfaces:** Task9 hook and Task10 components; Task3 projection includes company zone/review context and closed reservation summary. Existing day-list from/to are Task1 companyDayBounds; Today scheduling output uses the backend company zone, never the browser or inspection rule zone.

- [ ] Write appointment create lost-ack/deferred response/manual resubmit/remount tests using the exact original ID/hash; no POST retry by React Query or remount. Strict response mismatch holds. Only authoritative committed/refused reconciliation changes that fence; refreshing GET alone never does.
- [ ] Write company-day boundary/query, offset labels, DST choices, legacy saved interval preservation, detail/property cards and mobile/keyboard accessibility cases. Notes/confirmation/terminal actions remain usable when material admission context is held; edits deliberately changing schedule/resources require fresh review.
- [ ] Run `pnpm --filter @workspace/command-center exec vitest run src/pages/appointments-scheduling.test.tsx src/pages/appointments-property.test.tsx src/pages/appointment-linked-navigation.test.tsx`; require RED. Root serially updates the mixed contractor-scheduling.test.tsx appointment-zone expectations in Task9; GEEKOM does not change service-editor assertions or that whole file.
- [ ] Implement exact fixtures and no-retry state ownership. Surface actor/source changes safely and retain unknown payload internally; do not expose another context's data. Treat fixture success as consumer evidence pending integrated API acceptance.
- [ ] Run focused UI/types GREEN; fresh review and root-approved isolated commit handoff. Root integrates only assigned files and reruns combined tests.

### Task12: Integrated runtime, real races and source regression gates — WILLOWFORGE/root + independent QA

**Files:** Add `artifacts/api-server/src/services/saved-scheduling-acceptance.test.ts` and local synthetic browser acceptance fixture/report `reports/saved-scheduling-acceptance-2026-10-13.md`; fixes go to existing owning lanes, not reviewer edits.

**Interfaces:** Actual local API/generated consumers, all writers/config/retention, Task8 recovered fixture and exact integrated source identity. Independent QA observes; root owns owned fixture processes/containers, source integration and pushes.

- [ ] Write final actual-PG matrix for both contention orders (policy, inspection, timezone, lifecycle, same operation/refusal, resource travel/general cap, release/cleanup); assert exact snapshots/audits/reminders/tasks/results, source/tenant isolation and no duplicate event. PGlite cannot count as multi-session lock evidence.
- [ ] Run `node scripts/local-dev.mjs test src/services/saved-scheduling-acceptance.test.ts` and source recovery suites; require meaningful RED for any discovered gap, then owner-lane fix/review/GREEN. Preserve the15 existing baseline skips explicitly; no new skipped scheduling race.
- [ ] Run `node scripts/local-dev.mjs test`, `node scripts/local-dev.mjs ui`, `pnpm --filter @workspace/scheduling-core test`, `pnpm --filter @workspace/scripts test`, generated contract tests, `node scripts/local-dev.mjs typecheck`, both app builds and `node scripts/local-dev.mjs parity`. New totals are observed, not hardcoded prior4760.
- [ ] Start only an owned synthetic local preview/API with test-only session/organization. Verify desktop/mobile/keyboard settings→appointment→Today, saved gaps after defaults change, unknown save/reconciliation and company/inspection zones. Keep browser recordings/traces disabled. Do not use a live tenant, real customer message or stale localhost tab as evidence.
- [ ] Close only owned preview/container/listener/browser resources, retain receipts and redacted secret scan. Obtain fresh independent whole-branch review plus GEEKOM consumer acceptance of the integrated contract. Source/local claims require actual runtime evidence, not fixture screenshots or green types alone.

### Task13: Reviewable source PR and release packet — WILLOWFORGE/root

**Files:** Create/update `reports/saved-scheduling-{integration,operator-guide,release-boundaries}-2026-10-13.md`, new exact schema/SQL/recovery receipt; update durable C:\Forge production-gap/launch/control/handoff state. Never edit an old admitted migration packet into a new candidate.

**Interfaces:** Exact final source commit, independent reviews, CI and owned cleanup receipts. Private draft PR targets the still-correct PR57 dependent branch after confirming current PR/main state; no automatic merge/cutover.

- [ ] Write operator guidance for explicit configuration, disabled saved protection, partial releases, timezone differences, stale review, unknown original operation and terminal refusal. Separate legacy compatibility/source-live evidence and pending full G-04/G-06/business/provider acceptance.
- [ ] Verify active diazdestination identity/private canonical repo/base, clean owned worktree, predecessor/source/migration pins and secret scan. Publish the root-reviewed source branch/private draft PR; attach every created PR to this chat. Body describes actual problem/behavior and observed validation.
- [ ] Wait for exact-head CI (tests/types/both builds/Docker parity), inspect failures and fix only supported source issues. Re-review material fixes. Green CI is candidate proof, not hosted safety/launch proof.
- [ ] Save reviewed release packet with0019/new shape and compatible rollback eligibility. Supported Fly Reader rehearsal, actual provider/inbox/SMS/phone/device/contractor workflows and explicit deployment/cutover decisions remain gates. Existing paid grants are consumed; do not create a copy/helper or activate anything from this source plan.
- [ ] Record final milestone and ownership/handoff; keep unfinished release integration task open when live gates remain. Offer the next concrete source or acceptance step without claiming client replacement or market launch complete.

## Plan self-review and execution handoff

Root must self-review coverage, step decisions, interface names/types, five Review Focus cases and proportion against the immutable spec before publication. Independent technical/UI review is additional; it does not replace that self-review. Remove unresolved placeholders and guessed paths/commands before asking owner review. The existing method is scoped agents with independent review across both PCs; do not ask the owner to select it again.

Owner plan review precedes execution. After approval, read the required subagent-driven-development/worktree/TDD/review/verification skills, prepare exact scoped briefs and reviewed contract commits, and execute each task's RED→GREEN→commit→review gate. This document was produced without installing dependencies, running new product tests or writing product code.

## Named test anchors

These are minimum assertions in the owning task's failing-test step, supplementing its full case matrix. Variables describe task-local fixtures seeded through the existing source test helpers; they are not new undefined production helpers. UI render/fireEvent/screen come from the existing Testing Library harness. Each task writes the named test before its implementation.

```ts
// Task1: 'rejects DST gap and preserves explicit fold choices'
expect(resolveWallTime('2026-03-08T02:30:00', 'America/New_York').kind).toBe('nonexistent');
expect(resolveWallTime('2026-11-01T01:30:00', 'America/New_York').choices.map(c => c.instant)).toEqual(['2026-11-01T05:30:00.000Z','2026-11-01T06:30:00.000Z']);
// Task2: 'adds only the three scheduling JSONB columns'
expect(newColumnReport.map(c => `${c.table}.${c.name}`)).toEqual(['appointments.scheduling_reservation','org_settings.scheduling_policy','projects.scheduling_reservation']);
expect(predecessorHashesAfter).toEqual(predecessorHashesBefore);
// Task3: 'inspection settings invalidate revision-zero review without shifting rule zone'
expect(contextAfter.policyRevision).toBe(0);
expect(contextAfter.inspection?.availabilityDigest).not.toBe(contextBefore.inspection?.availabilityDigest);
expect(contextAfter.inspection?.ruleTimeZone).toBe('America/Chicago');
// Task4: 'reconciliation fences delayed original create'
expect(refusal).toMatchObject({operationId:original.operationId,outcome:'no_commit_refused',target:null});
expect(delayedOriginalAck).toMatchObject({operationId:original.operationId,outcome:'no_commit_refused'});
expect(appointmentCountAfter).toBe(0);
// Task5: 'crew-subset release preserves surviving sixty-minute reservation'
expect(updatedProject).toMatchObject({crewUserIds:['u1'],schedulingReservation:{minimumTravelGapMinutes:60,startAt:oldSnapshot.startAt,endAt:oldSnapshot.endAt}});
// Task5: 'clearing protected job dates retains its last reservation history'
expect(clearedProject).toMatchObject({scheduledStart:null,scheduledEnd:null,crewUserIds:oldCrewIds,schedulingReservation:oldSnapshot});
expect(activeReservationIdsAfterClear).not.toContain(clearedProject.id);
// Task6A/B/C/D: 'source replay returns original booking after defaults change'
expect(replayedTargetId).toBe(originalTargetId);
expect(appointmentOrProjectCountAfter).toBe(1);
// Task7: 'retention survives deletion and closed export excludes operation capability'
expect(originalReceiptStillExists).toBe(true);
expect(exportResult.manifest.tables).toHaveLength(28);
expect(exportResult.organization.schedulingHistory[0]).not.toHaveProperty('operationId');
// Task8: 'restore preserves terminal refusal and prefeature writable rollback stays held'
expect(restoredReceipt).toEqual(beforeRestoreReceipt);
expect(prefeatureWritableRollbackEligible).toBe(false);
// Task9: 'storage failure stops dispatch and remount cannot rearm unknown create'
expect(dispatchSpy).toHaveBeenCalledTimes(0); // denied custody fixture
expect(submittedIdsAfterUnknownRemount).toEqual([original.operationId]);
// Task10A: 'policy read error disables save and retains authoritative state only'
expect(screen.getByRole('button',{name:'Save scheduling settings'})).toBeDisabled();
// Task10B: 'ambiguous time remains unreviewed before explicit occurrence'
expect(onReviewed).not.toHaveBeenCalled();
// Task10C: 'Today keeps company zone while explaining distinct inspection zone'
expect(screen.getByText(/America\/New_York/)).toBeInTheDocument();
expect(screen.getByText(/America\/Chicago/)).toBeInTheDocument();
// Task11: 'GET refresh is not a new CREATE'
expect(createPosts).toHaveLength(1);
expect(reconcilePosts[0].body.operationId).toBe(original.operationId);
// Task12: 'both-order real-PG contention admits only permitted work'
expect(blockingObserved).toBe(true);
expect(conflictingCommittedReservations).toBe(1);
// Task13: 'source publication preserves schema predecessor pins and release holds'
expect(releasePacket.predecessorHashes).toEqual(original19Hashes);
expect(releasePacket.hostedAcceptancePassed).toBe(false);
```

Task10A fixes the accessible save label above. Task10C's differing-zone fixture supplies both labels; all other copy remains existing style. Task2 preview owns newColumnReport/hash variables; receipt/native/source/export/recovery fixtures own their respective results. UI custody cases use deferred fetch spies and the frozen typed contract, never a guessed response. Task13 assertions are release-packet checks, not an additional product-test suite for documentation.

## Technical references for the timezone choice

The proposed pinned polyfill avoids relying on native Temporal availability in Node22/browsers and shares one conversion implementation. Official Temporal supports explicit ambiguity and offset rejection, which fits the approved wall-time rules. Use Instant elapsed-minute arithmetic and company-calendar day bounds as separate operations. Primary references checked during planning: [Temporal ZonedDateTime documentation](https://tc39.es/proposal-temporal/docs/zoneddatetime.html), [polyfill v0.5.1 package](https://github.com/js-temporal/temporal-polyfill/blob/v0.5.1/package.json), [maintainer release notes](https://github.com/js-temporal/temporal-polyfill/releases). This is a dependency proposal in the reviewed plan, not installation or runtime acceptance.
