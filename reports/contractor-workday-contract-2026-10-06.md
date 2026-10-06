# Contractor Workday Completion — frozen researched-baseline contract

Frozen October 6, 2026 BEFORE product implementation. Owner approved common
HVAC/roofing research and the proposed workday wave without waiting for exports;
later actual samples may require revisions. Research basis is the adjacent
contractor-workday-research-2026-10-06.md. Base main3f1f1b54f8436303d66e53083f62155431e9adef,
tree d01f9a404cc0d4d2f71231650cc1e8af2f5e7408, exact-mainCI37407237259 accepted.
Branch agent/growthos-contractor-workday-20261006. Completed PR24/heartbeat are
closed and never replayed. Preserve unrelated pnpm-workspace.yaml.bak.

This is a bounded L7/L5 source slice, not full contractor replacement or launch.
It removes free-text-only equipment and unstructured technician visit evidence.
It does not create a second job/calendar/CRM or fabricate acquisition records.

## Scope and selected decisions

1. Add exactly SIX tables: property_assets, work_checklist_templates,
   work_checklist_revisions, appointment_work_entries,
   appointment_work_completions, appointment_work_photos (133 ->139).
   Reuse the exact native appointment as the visit. Multiple explicit entries
   permit multiple units; one original completion owns the visit transition.
   Native projects/estimates/invoices and their existing lead lineage are unchanged.
2. Assets have immutable tenant/customer/property identity, an explicit type/name,
   optional recorded make/model/serial/location/install date/notes, optional
   recorded warranty dates plus source note, and up to20 bounded descriptive
   label/value attributes. Unknown values remain null. No serial/address/label
   dedup inference, manufacturer lookup, generated facts, asset move or destructive
   delete. Versioned edit and retirement preserve historical snapshots. New writes
   validate and retain actual current customer/property row locks.
3. Company templates are explicit drafts copied from a short researched starter
   or made from blank. GET never seeds or approves. Stable item keys, exact saved
   content, immutable revisions and owner/admin exact actor-bound expiring review
   protect history. Edits create revisions, not rewrites of used instructions.
   Retiring/replacing a template blocks NEW enrollment; existing pinned reviewed
   instructions remain until explicit office cancellation. No warranty/compliance
   certification, recurring interval or operating threshold is inferred.
4. Explicitly prepare an active nonterminal native visit with an actual coherent
   customer. Property selection is required for an asset; explicit null asset is
   allowed for non-equipment work. An entry may name only a coherent service
   occurrence already linked to this exact appointment. Never adopt historical
   labels or completed/canceled/no-show work; do not create or relink a service.
   Asset/service linking is occurrence-level only. Do not add persistent asset
   fields to standing-policy fingerprints, carry links/answers into successors,
   renew agreements or acquire new reminder/send authority this wave.
5. Bound20 entries/visit,50 items/revision,50 photos/visit and10MiB/photo. These
   are engineering limits, not majority-practice claims. Item kinds are result,
   text, number with explicit reviewed unit, and photo. Result choices are done,
   needs_attention and not_applicable. Requiredness and N/A permission belong to
   the reviewed revision. Required unanswered items block final completion;
   N/A and attention require a reason. Numeric observations do not auto-pass
   workmanship/safety. New entries have no default passed answers.
6. Draft answers/notes persist by exact version/request identity. Completion uses
   an exact actor-bound expiring preview of SAVED entries, photos and native
   parent/service/task versions; a submitted draft is not physical proof.
   Staff explicitly attests performed work and chooses completed or needs_followup.
   Any attention result requires needs_followup plus an explicit bounded office
   note, accepted responsible staff and next-action deadline. Create ONE original
   follow-up task atomically; never overwrite another staff note/owner/deadline.
   Completion is staff-recorded work, not warranty entitlement or customer acceptance.
7. The final command explicitly selects which coherent linked service occurrences
   were performed. Appointment completion alone never completes a service. Reuse
   transaction-aware native appointment/service algorithms in ONE transaction:
   immutable evidence, native transition/reminder reconciliation, explicitly
   selected service/task transition, existing anchored zero-or-one successor,
   follow-up and audit commit or all roll back. No separate pooled transaction,
   provider/OAuth/storage network call, duplicated recurrence algorithm, new
   appointment, message, invoice or payment. Preserve existing finite/end-of-month
   recurrence and original pending/unknown/accepted communication ownership.
8. Required work applies ONLY after explicit enrollment. BOTH generic appointment
   status completion and old service completion paths must fail closed without
   that exact sealed work evidence; a neutral transaction-level guard avoids
   circular service imports. Prevent generic reopening/reparenting from replaying
   sealed completion. Legacy unenrolled paths keep their current honest semantics.
   Same original request/payload returns the original result; changed payload
   conflicts. Later corrections are append-only NOTES referencing the original,
   never edited answers, silent reopening or another native effect.

## Authority, concurrency and private media

Read APIs derive company from current authenticated staff. All new write/review
commands require a human session (reject even an empty x-api-key header), trusted
origin/JSON and fresh accepted/active/verified membership/effective role checks.
Template review/retirement is settings.manage (owner/admin). Asset writes use
crm.write. Visit preparation/draft/photo/completion/correction requires crm.write
AND current appointment assignment, or owner/admin/office acting explicitly on
behalf of the performer with a note. Sales roles do not gain unassigned office
authority. Server capabilities/reasons, not stale UI role guesses, govern actions.

Use a fixed lock order: applicable lifecycle prefix, shared contractor schedule
advisory lock, sorted current actor/parent/service/task/asset/entry rows. Retain
concrete SHARE/UPDATE locks through final mutation; ordinary property/task/member
writers do not share the schedule lock. Revalidate real mutable authority and
expected versions after waiting. Parent/asset identity edits after preparation
must produce a hold or explicit re-preparation, never silently replace snapshots.
Historical reads use original scope/snapshots and never a moved property's new
customer data. Reads remain SELECT-only and do not lazily create work.

Photos require exact work-entry upload reservation and server-owned stored-object
identity with tenant-composite FK, not an arbitrary URL or same-tenant guess.
Reuse validated native signed upload/private read primitives; do not broaden
legacy GCS/Replit or lead/portal grants. JPEG/PNG/WebP only, bounded actual metadata
and count, final actor/parent/version check, inert original-request replay and
expiry. A photo is private work evidence, not public marketing or AI/video input.
Freeze confirmed references in completed evidence. Expose only exact authenticated
content routes and safe availability states, not bucket keys/capabilities.
New storage references must be protected from orphan cleanup and verified against
actual deletion/attachment races. Expired unattached reservations need bounded
cleanup/tombstones; do not delete linked evidence first then discover a DB FK.
No provider access is assumed by local tests or preview; unavailable storage is
visible, not a silently successful upload. Corrections never remove original proof.

## Existing UI surfaces

Keep Today as field-day entry and the existing exact appointment URL as visit
anchor. Add a lazy Equipment & assets panel INSIDE the current customer Service &
equipment section, retaining the nine existing history sections/cursors. Add
Company checklists inside Service Desk and a Visit work panel on exact appointment
detail. Preserve original scheduling notes and all old CALLIE/service panels.
Service Desk links to actual recorded visit work; show native visit/service/next
task outcomes separately. No broad Projects redesign, unsupported old-job link,
new dashboard or full CRM fetch/filter. Keep membership polling/draft retention,
actual authority reset, exact scope validators, stale/unknown-mutation fences,
literal text, accessible forms and 320/390px layouts.

## Lane ownership

Runtime lane: six-table schema module; pure DTO/command contract; assets,
checklists, appointment work/guards/routes/tests; minimal native transaction
extraction and generic completion guards; scoped media and upload-cleanup
integration. Publish private API-CONTRACT.md EARLY before UI depends on fields.
Root exports schema and mounts the router; coordinate shared files first.
Experience lane: new customer-assets/checklist/visit-work components, exact
appointment and existing customer/service integrations plus focused UI tests;
no backend/schema/generated/preview/recovery edits.
Companion: independent contract/source review, operator guide and private review
notes only. Root: researched starter module and citations, shared docs/API spec/
generated alignment, schema delta/inventory/export/recovery/preview, full checks,
browser QA, Git/CI/release. Agents do not commit/push, operate Docker/providers,
send/import real data or mutate shared STATE.

## Required verification and release

Cover strict two-company and same-company wrong-parent/actor/API-key/origin/JSON
paths; current assignment/role/parent/version changes; draft vs reviewed templates;
immutable old revisions/history; missing/invalid/N/A/attention answers; multi-unit
visits; generic bypass/reopen refusal; unknown save and changed-payload replay;
single completion/successor/follow-up; finite/month-end/late/canceled/no-show cases;
original staff notes; exact media ownership/expiry/type/size/cleanup; no invented
lead/booking/send/warranty/payment. Preserve all earlier independent PG barriers.

New independent PostgreSQL16 barriers must use real writer functions and observed
distinct backends/pg_blocking_pids: retained final parent/task/actor locks versus
actual generic writers; reverse committed property/assignment edit refused;
two finishers/legacy completion contend for one original result/successor;
entry/asset/template edits preserve or invalidate exact snapshots as defined;
photo attachment versus actual cleanup/deletion retains one coherent outcome.
PGlite/mocked locks/skipped required PG cases are not acceptance.

Root reviews additive0016 offline after0015,6newtables/139total, explicit pair/null/
state/version/exact-parent SQL constraints. Deliberately classify lifecycle/export:
bounded business metadata/answers may be added by allowlist; no binary, private
object key, preview token or secret export. Compatible synthetic upgrade/restore
must preserve old companies/history/unknown receipts plus new assets/revisions,
progress/completions/corrections/private photo refs, actual encryption boundaries
where present and SELECT-only app probes. Built UI needs real save/reopen/review/
completion with fictional HVAC/roofing records at320/390/desktop widths.

Require full exact reviewed candidate PostgreSQL CI (all test/type/both-build/
Docker/cleanup gates and new+old barriers), then accepted-tree guarded merge/safe
main sync, ONE explicit ci.yml main dispatch and full exact-main proof. Do not
cancel/duplicate active runs or blindly retry unchanged heads. Preserve .bak.
No deployment, hosted schema/credentials, new accounts/providers, real messages/
calls/imports, spending/payments/subscription cancellation. Samples, actual
company requirements, hosted/provider/device proof and both acceptance cards
remain explicit later gates. Do not call this fullL5/L7/launch/replacement complete.

## Review clarification — October6, before candidate freeze

Independent source/built-UI review clarified the recovery already required above.
Fresh office authority has a separate server-derived canCancel capability for
held DRAFT entries; answer editing/completion remain held. Cancellation retains
original history and clears preparation choices for an explicit re-prepare.
Once ANY work history exists, including cancelled entries, native customer,
property and lead IDs cannot be changed or implicitly backfilled on that visit.
A different lineage requires a separate explicit visit. Address-content and
assignment changes still hold the original draft for office review/cancellation.
This preserves exact customer validators instead of widening their data scope.
Actual original completion also refreshes its surrounding native appointment
summary/schedule from validated saved records, without guessing success or
discarding the displayed immutable evidence. These are bounded review repairs,
not new equipment, migration, provider or completion authority.
