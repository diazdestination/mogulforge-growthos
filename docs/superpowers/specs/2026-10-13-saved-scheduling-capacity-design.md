# GrowthOS saved scheduling capacity and travel — Wave1 design

Status: written spec draft for owner review. The owner approved preparing the saved-buffer design; this document is not yet an approved implementation plan.
Date: October 13, 2026.
Repository: private diazdestination/mogulforge-growthos.
Baseline: PR57/06499416b4f2ca6e2ff890f1d55dfae55ce3d32e, on reviewed PR56/PR44.
Design branch: agent/growthos-scheduling-design-20261013.
Coordination authority: Adam directly authorized WILLOWFORGE/GEEKOM communication and scoped agents. His follow-up "Go ahead and" is interpreted as approval of the presented saved-travel-buffer design/spec-writing stage.

## 1. Outcome and acceptance target
Staff can set company-approved job-duration presets, a minimum travel gap and an optional company concurrency ceiling. They can schedule explicit work intervals against real accepted staff, review the service/travel/capacity rules that will apply, and receive a truthful conflict or stale-review explanation. A booking retains its reviewed service interval and travel protection when defaults later change.

CSS reported two-hour diagnostics, three-hour maintenance and about one hour of travel. These remain optional owner-reported examples, not automatically activated company settings. No helper account, crew pool, service category, operating hours or route is inferred.

Existing stored reservations keep their UTC endpoints, null-end compatibility and customer/property lineage. An old record without travel evidence receives no invented historic buffer. Completed email, financial, customer-work, service-care and CALLIE behavior remains subject to its existing authority and acceptance requirements.

The native scheduling outcome comprises:
- actual service start/end and explicit accepted staff assignment;
- a saved minimum inter-reservation travel gap for each occupied staff member;
- a separately reviewed company concurrency ceiling, when enabled;
- the existing inspection-company cap as a distinct admission gate;
- coherent company-zone/DST display, stale reviews and transactional writer coverage.

## 2. Chosen model and scope
Use protected per-reservation travel snapshots. Current defaults supply new snapshots, but a later policy decrease/disable does not shrink a surviving booking's earlier travel protection.

A duration preset is an explicit suggestion for a new or deliberately changed interval. Resolve it once into UTC endpoints and save those endpoints. Never reinterpret saved duration using a renamed, changed or deleted preset. Explicit manual and multi-day ranges remain supported by the existing interval rules.

One accepted assigned user is one occupied staff resource; appointments use their assignee and projects use every distinct crew user ID. The same user cannot overlap in active work. The optional company ceiling counts work reservations, not people or helper capacity; a multi-user job counts once toward that ceiling but occupies every assigned user. Unassigned work can consume company/inspection capacity without establishing technician availability.

This wave introduces source/local scheduling behavior and one additive schema step. Customer confirmations, automated rescheduling, routing/geocoding, helper pools, leave calendars, payments, provider activation and real-company configuration are separate work.

## 3. Versioned policy
Add nullable org_settings.scheduling_policy JSONB. A missing policy is legacy/unconfigured revision0. The first explicit save creates revision1. Every supported policy-affecting change advances the revision monotonically; disabling retains the envelope and revision. Do not reset a configured policy to null or reuse revision0.

Closed version1 policy envelope:
- formatVersion:1 and revision:positive safe integer.
- enabled:boolean.
- canonical company timeZone, copied from organizations.timezone by the server.
- minimumTravelGapMinutes:integer0..1440.
- maxConcurrentReservations:null or integer1..100.
- durationPresets:0..50 entries with stable server-admitted ID, nonblank label1..80 characters and elapsedMinutes:integer1..1440.
- server-owned normalized digest and update actor/time, for provenance and review.

Disabling a configured policy stops offering its presets and applying its default travel gap/company ceiling to new admissions; those admissions use zero new travel and no general company ceiling. Existing inspection and resource gates still apply. Earlier reservation snapshots retain their saved gaps. Disabled configuration retains its revision/provenance and still requires reviewed context for material admissions; it is distinct from missing legacy configuration. Re-enabling advances the revision and applies the reviewed defaults to later admissions only.

These are technical input limits, not client facts. New configuration has no automatic CSS presets or company cap. Staff review all values before save. The server validates closed objects, unique preset IDs/labels, finite integers and a valid IANA company zone.

Read the policy without incidental settings creation/normalization. Use a transaction-scoped reader where a mutation needs it; existing getOrgSettings uses global db and is not the transaction reader. Unknown/corrupt configured policy holds new scheduling admissions and reports an actionable configuration error; it does not invent a fallback configuration.

Policy save requires existing settings.manage authorization plus accepted active verified staff context, existing origin/session protections, exact organization, expected revision and reviewed canonical-zone context. The root-owned settings integration submits the dedicated scheduling-policy operation; generic settings writes cannot set/reset this new field.

InspectionAvailability changes and company-timezone changes participate in the same schedule lock and advance the configured scheduling revision. Inspection offers/admissions also carry a server-computed digest of the effective inspection-availability configuration, including its rule-source timezone and legacy/unconfigured state, alongside the reviewed company zone. Compare that digest and both applicable zone contexts under the lock even when scheduling policy is null/revision0. These changes make a preceding affected availability/zone review stale. Existing inspection configuration remains a separate object and gate, rather than merging travel into its occupancy counts.

## 4. Canonical timezone and interval rules
organizations.timezone is the authoritative company zone for scheduling inputs, display and day-query bounds. The policy stores the server's matching company zone for provenance; it is not independently editable. The platform-admin org timezone PATCH writer must serialize with scheduling, update the configured policy's company zone/revision/digest and audit the change. A mismatched stored scheduling policy/organization zone holds new admissions.

Existing InspectionAvailabilitySettings.timezone remains the rule-source zone for its windows, weekdays and blackout dates until an explicit reviewed inspection-configuration change. An org company-zone change must not reinterpret those recorded rules. When no inspection configuration was recorded, retain and identify the deterministic existing legacy effective rule configuration rather than invent owner approval. Inspection offers/admission evaluate these rules in their effective rule-source zone and return explicit UTC instants. Display those instants in the company zone; expose both named zones when different, without treating a valid difference as configuration corruption. Inspection settings editing must visibly review its rule-source zone. The availability digest and affected review context include that zone as well as the company zone, so changing either invalidates the review.

The policy read and every native scheduling projection return the effective zone and revision. Schedule and Today scheduling inputs, displayed dates and day-query bounds use that same zone. Preserve existing nonscheduling financial/reporting timezone semantics; do not reinterpret stored UTC values.

Scheduling requests retain explicit UTC instants. For newly edited wall-clock input, carry the reviewed company zone and explicit selected UTC offset; validate on the server that the instant projects back to that wall time/offset in the current zone. Reject nonexistent DST wall times. For ambiguous fall-back times require an explicit occurrence/offset choice, never guess silently. Existing unchanged instants render in the current company zone with an offset label, while their original approved zone remains in reservation history.

Preset minutes and travel minutes are elapsed time. Manual multi-day endpoints remain exact instants; do not convert elapsed presets into calendar-day duration. Any client timezone conversion helper is shared/root-owned and verified against the backend rules. Do not assume the browser zone equals the company zone or merely replace a timezone label.

## 5. Reservation snapshot and history
Add nullable appointments.scheduling_reservation and projects.scheduling_reservation JSONB. No new table is needed; the existing142-table count remains while column/schema identity changes.

A valid version1 snapshot records:
- reservation revision and source policy revision/digest;
- canonical approved company zone;
- effective inspection rule-source zone/digest when the admission uses inspection rules;
- exact service start/end instants;
- sorted admitted resource IDs;
- minimumTravelGapMinutes;
- duration provenance (explicit, preserved interval, inspection interval or explicitly selected preset);
- copied preset ID/label/minutes when a preset was actually selected;
- admission actor/time and target linkage.

The server computes all snapshot fields. Client DTOs cannot write snapshots, resource identities outside the reviewed existing assignment, policy digests or actor fields. Derive insert/update schemas with server-owned fields omitted and close the wire contracts.

The snapshot on a row is the current reservation revision. An explicitly reviewed material admission can replace it. A pure partial resource release creates a release revision as defined below. The prior and resulting snapshots are retained in append-only scheduling audit evidence. No ordinary note, status-confirmation-only or terminal edit rewrites its snapshot. Active snapshot fields must match the row's effective endpoints/resources.

Legacy null snapshots retain fixed source compatibility: two hours for an appointment missing an end; one day for a project with a start but no end. Legacy travel is zero because no travel protection was recorded. Do not backfill or infer prior approved travel. If such a record is explicitly rescheduled under configured policy, including disabled configuration, it gets a new reviewed snapshot without changing its earlier history.

Unconfigured legacy writes retain null snapshot behavior. Work without a capacity-consuming state and usable interval does not invent service endpoints or a reservation snapshot; existing source/assignment checks remain. Its first effective capacity-consuming admission uses the then-current applicable rules. A transition out of active capacity preserves any existing snapshot/history, as a release.

Terminal transitions retain the snapshot/history but release active capacity. Reactivation is a new material admission using current rules. A later booking edit never resurrects an earlier snapshot as new admission authority.

Invalid versioned evidence holds new conflicting admissions, not ordinary historical notes, cancellation or completion. Existing same-org historical staff/customer rules continue to permit closure after staff access is revoked.

## 6. Exact travel and capacity mathematics
Capacity-consuming appointments are scheduled/confirmed; projects are scheduled/in_progress with a usable start interval. Keep the existing terminal/unscheduled treatment.

For each shared staff resource, service intervals must not overlap. For two adjacent intervals A then B, require:
B.start - A.end >= max(A.savedMinimumTravelGap, B.savedMinimumTravelGap).
A null legacy snapshot contributes zero travel, but its effective legacy end remains unchanged. Equality is valid. Check both chronological directions and every shared staff member. Same-property work has no automatic exemption; no location/route facts are inferred.

Use service endpoints for inspection and company concurrency. Travel does not enlarge stored service endpoints or inspection-window counts. A minimum inter-booking gap is applied once, not summed twice.

A company ceiling compares true peak simultaneous active reservations over the candidate service interval, with the candidate counted once and the edited row excluded. Use half-open intervals and end-before-start boundary handling. Do not reject a long candidate by simply counting every intersecting reservation when those existing reservations do not overlap each other. A cap reduction does not automatically reschedule or invalidate old work; it governs new/material admissions.

Resource lookup must find old saved gaps even when current defaults are lower/disabled. Bound lookup using the validated maximum gap horizon and actual occupied intervals, not current minimum only. If a configured snapshot/coverage cannot be validated, hold the admission rather than undercounting.

Inspection slot offers and final admission use the same active-inspection population, effective ends and policy context. Assigned-staff travel/company capacity apply where the offered booking has that binding. Unassigned inspection slots remain a company offer, not proof that a named technician is free.

## 7. Material changes, preservation and lock order
Classify the resulting transition under the lock as admission, release-only or preservation. Admission runs for create, reactivation, any endpoint/type change affecting an active reservation, and resource additions/replacements. A pure resource subset removal with unchanged effective endpoints, type and consuming state is release-only. A terminal transition releases all capacity; moving between consuming states without other effective changes is preservation. Compare resulting values with the locked existing record, not only whether a field appeared in a PATCH. A combined release and material admission uses admission rules.

For a valid versioned reservation, a pure partial resource release advances the reservation revision, stores the remaining resource subset, and preserves its endpoints, saved gap, duration/preset and original policy/zone provenance. Append old/new evidence and release actor/time; do not adopt current defaults or silently shrink surviving protection. A legacy null snapshot remains null on pure release. Full terminal release retains its snapshot/history. Reassignment or reactivation later is a new current-policy admission, even if the resource was previously assigned.

Notes, crew notes, unchanged scheduled-to-confirmed transitions, ordinary confirmation-only changes and release-only transitions retain existing authorization and earlier intervals. Do not make old close bookings uneditable after a policy increase. Invalid versioned evidence permits terminal closure and historical notes but holds partial edits that would produce unverifiable active evidence until repaired through a reviewed recovery path.

Preserve server start-only rescheduling duration and PR56 end-only-clear refusal for assigned crew reservations. A UI save must not send a fabricated two-hour end on an unrelated legacy edit. Property/customer or other preexisting authority checks remain effective; historical scheduling exemptions do not bypass them.

Retain existing lock order: lifecycle/admission context before org schedule lock, then policy/settings and target/participant row locks in deterministic order; existing command/effect locks keep their established enclosing order. Document each writer's exact order in the implementation plan and cover reversed contenders in real-PG tests. Do not acquire schedule locks after locking policy rows or use a global db reader inside the transaction.

Within the schedule transaction: read locked effective policy/zone and source record, compare reviewed context/version, derive explicit endpoints/resources, enforce all applicable gates, write row/snapshot/history and commit together. Settings initialization, policy saves, inspection settings and timezone updates use the same serialization point.

All mutations preserve tenant and participant locks and accepted staff checks. Never weaken lifecycle holds, property/source lineage, exact historical references or current membership to admit work.

## 8. API/consumer boundary
Root owns OpenAPI, generated clients/Zod/types and API fixtures. Add dedicated read/save scheduling-policy contracts and expose active snapshot/provenance and scheduling review context in relevant appointment/project/Today/settings views.

Review context includes current policy revision and canonical company zone, plus existing target version for updates and effective inspection-availability digest/rule-source zone for affected inspection offers/admissions; it is organization/source scoped. A stale context returns409 with a specific refresh-and-review reason. New UI always submits its reviewed context for material changes. All configured-policy admissions, including disabled policy, and admissions changing versioned reservations require that context. Release-only operations require the existing target version and authorization, preserve saved protection, and do not require adoption of current policy defaults.

Existing internal booking workflows obtain and retain explicit source/offer review context or transaction-fresh authoritative context appropriate to their existing approval flow. They do not invent a human approval or omit their final policy recheck. Old unconfigured external DTO compatibility is preserved where no new policy or protected reservation is involved; configured enforcement cannot be bypassed by omitting new fields.

A changed or uncertain policy save/booking never automatically retries a mutation. A GET refresh updates authoritative state for another explicit review. Uncertainty does not display confirmed success.

An unknown booking CREATE retains the exact submitted operation identity and reviewed payload/context, scoped to actor, organization and source, across refresh/remount. It blocks a fresh equivalent booking until the original committed result or proven no-commit refusal is reconciled. A list match, missing row, expired request, generic HTTP error or timeout is not no-commit proof. Existing explicitly idempotent returning-customer commands retain their same durable request identity and established reconciliation; never replace it with a new UUID.

Native CRM CREATE requires a dedicated manual scheduling receipt in the existing audit_events UUID/metadata substrate, keyed by the submitted operation UUID and bound to tenant, actor, action, source and exact payload/context hash. Serialize each operation and commit native booking plus receipt/evidence atomically. Exact authorized reconciliation returns the original committed target without repeating creation or booking side effects; changed payload/context/actor or conflicting receipt identity is refused. A proven no-commit result must be a retained terminal refusal under the same operation serialization, preventing a still-pending original request from later committing. Retain the receipt when its target changes or disappears and through cleanup/export/recovery. Do not borrow customer_work_commands for unrelated manual work, invent a returning root or infer failure from target absence. Freeze the typed acknowledgement/lookup/retention and exact lock/uniqueness details in the reviewed plan. Until this new path is verified, unknown-create remains held with no fresh submit. This is required new source acceptance, not a claim that existing CRM creates already have durable idempotency.

Writer coverage: CRM appointments/projects; returning-customer project commands; service-care visits; CALLIE staff booking; concierge inspection offers/admission; policy/inspection settings; org timezone mutation. Apply shared gates instead of local approximations.

## 9. UI contract and file ownership
WILLOWFORGE root owns shared settings.tsx integration, contractor-schedule/date helpers, project/customer-work/service/CALLIE shared seams, schema/migrations, backend, API/generated contracts, full integration and pushes.
GEEKOM owns assigned appointments.tsx/today.tsx presentation/tests, new extracted scheduling policy/interval/travel-review UI components and consumer fixtures. It implements against the published reviewed contract commit in a separate clone/worktree.

Policy UI must distinguish loading, unconfigured, read error, invalid configuration, current revision, changed local draft, saving, stale conflict and uncertain save. Display only authoritative saved state as active. Disable unsafe mutation on read error or tenant/actor change; retain unsaved edits without carrying them to a different tenant.

Appointment/job review shows exact company-zone service start/end, elapsed duration, assigned resource list, applied travel requirement and separate company/inspection gates. Explain the adjacent reservation responsible for a conflict using only authorized same-tenant data. No helper capacity, route optimization or provider delivery badge is implied.

New presets require explicit selection; never map inspection/other into diagnostics or maintenance. Existing edits distinguish unchanged saved interval, deliberate new preset/range and start-only duration preservation. Cards show saved end/duration/property where available. Today job intervals and offset/zone labels remain consistent.

Tenant/actor/source/version changes invalidate a pending review. Use accessible keyboard controls, readable mobile content, exact error recovery and stable UI request ownership. Root preserves the completed initial-email component; Wave2 is not implemented in this design.

Retain the original unknown-operation fence during navigation/remount instead of replacing it with a blank fresh form. Expose reconciliation and confirmed original result/proven refusal without implying that an ordinary refresh makes another CREATE safe. A changed tenant/actor may only access its own authorized state and must not expose or reuse another context's pending payload.

## 10. Migration, retention and recovery
Append reports/staging-schema-preview-2026-10-01/0019_saved-scheduling-policy.sql after0018. It adds the three nullable fields and strict version/bounded-value safeguards. Preserve the19 existing canonical SQL inputs,142 table identities, prior columns/constraints/data and old work intervals, alongside these explicit additive fields/safeguards. Implementation schema/manifests/fixtures must identify new column shape and SQL hash; prior recovery receipts remain historical evidence.

No hosted migration, schema push, backfill, cluster/copy or production rollback is authorized by this spec. The later exact-candidate release packet must include the new SQL, unchanged predecessor hashes, restore/upgrade/rollback and audit/export/snapshot proof. Source-local disposable recovery must preserve snapshots, versions and legacy nulls.

Writable rollback must use an artifact that enforces these saved snapshots. A prefeature binary cannot provide that protection merely by retaining the columns. It may be used only after a complete scheduling-mutation hold is verified across every listed booking/settings/timezone writer, and that hold remains until compatible enforcement returns. If complete hold coverage or a compatible artifact cannot be demonstrated, prefeature writable rollback is unavailable. Do not down-migrate snapshots/audits or restore a pre-upgrade database over later admissions; recovery must preserve those records. The local release rehearsal must demonstrate the compatible rollback path or complete hold plus forward recovery, as well as evidence retention. This specifies a release requirement, not an assertion that an adequate hold already exists or authorization to activate one.

Extend existing organization exports with closed scheduling policy/snapshot/history fields; retain privacy redaction and exact source ownership. No new export dataset is inferred merely because columns are added. Ordinary cleanup and migration/import paths must not erase saved reservation evidence or reinterpret policy history. Unsupported legacy/deferred rows remain marked without invented history.

## 11. Acceptance evidence
Meaningful source acceptance must cover:
- explicit preset selection; persisted ends after preset deletion/rename/change; manual/multi-day and start-only preservation;
- old null snapshots/fixed null ends/PR56 end-clear/notes and confirmation-only edits after policy tightening;
- travel equality versus one-minute-short rejection in both directions across appointment/project combinations and every assigned crew resource;
- old larger saved gaps after policy decrease/disable; new changed reservations use new reviewed snapshots with prior history retained;
- pure partial resource release preserves surviving gaps/provenance and releases only removed resources; combined release/admission and later reassignment/reactivation use current rules;
- company true peak concurrency, touching boundaries, long candidate across nonoverlapping neighbors and multi-user jobs counted once;
- separate inspection caps, corrected offer/admission population and truthful unassigned availability;
- same-staff/different-staff and cross-tenant isolation; accepted/revoked staff, terminal closure and reactivation;
- concurrent booking/reschedule/policy/inspection-settings/timezone races and deterministic lock order;
- stale review/row versions, settings read failure, partial/uncertain saves and no automatic POST retries;
- unknown CREATE fences after manual resubmission/refresh/remount, exact original command identity, payload mismatch/cross-context refusal and committed-result/proven-no-commit reconciliation;
- disabled configured admissions still require review; inspection changes invalidate affected review even with policy revision0;
- browser/company-zone differences, DST nonexistent and explicitly ambiguous inputs, offset/day bounds and elapsed-versus-calendar duration;
- inspection-rule/company-zone differences and org-zone changes preserve recorded rule interpretation while invalidating affected review;
- forged snapshots/policy provenance, strict generated DTOs, corrupt evidence holds, exports/privacy and source-local recovery;
- compatible rollback or verified complete scheduling-write hold plus forward recovery preserves enforcement and post-upgrade admissions/history;
- integrated real local API plus desktop/mobile/keyboard UI and no leaks across tenant/actor switches.

Run existing relevant real-PG scheduling/CRM/inspection/returning/service-care/CALLIE suites and meaningful new cases, then fresh full local tests, types, both builds, Docker parity, redacted secret scan and independent whole-branch review. GEEKOM fixture-only success is consumer evidence; integrated runtime acceptance is a separate required check. Preserve existing skips explicitly.

## 12. Execution and release boundaries
After owner review of this written spec, prepare the detailed implementation plan with stable per-file interfaces and scoped subagents. The owner already selected the multiple-agent method; keep cross-machine ownership and independent reviews. No product dependencies, source implementation or new tests were installed/run to produce this spec.

Wave2 remains its own quote/document/channel/reply/follow-up specification. Telnyx/ElevenLabs planning, current Twilio code and marketing tiers are distinct records; this scheduling wave changes none of them.

Hosted Fly Reader upgrade/rollback, real mailbox/SMS/phone/provider evidence, payment/import/contractor acceptance, source merge, deployment and public launch remain outstanding under their applicable separate approvals. Source/local acceptance must preserve the full promised contractor capabilities and report any still-open G-04 requirements instead of declaring the entire replacement accepted.
