# Contractor Workday Completion — backend lane handoff

October 6, 2026. Implements the frozen `contractor-workday-contract-2026-10-06.md`
on `agent/growthos-contractor-workday-20261006`, based on accepted main
`3f1f1b54f8436303d66e53083f62155431e9adef`. This report is source/local-test
evidence, not PostgreSQL concurrency, hosted recovery, provider or client acceptance.

## Implemented boundary

- Six tables in `lib/db/src/schema/contractor-workday.ts`: property assets,
  checklist templates/revisions, visit entries, append-only completions/corrections,
  and exact visit-photo reservations. The only existing parent schema addition is
  `stored_objects_org_id_uq`. Root owns the reviewed offline delta and 139-table
  integration; this lane did not apply hosted schema.
- Browser-safe closed schemas in `services/contractor-workday-contract.ts` and
  human-session HTTP routes in `routes/v1/contractor-workday.ts`. Reads do not seed
  settings or work. Writes reject blank API-key headers, foreign origins, malformed
  JSON/selectors and stale/currently unauthorized actors. Current role caps remain
  effective. Asset pages use a scoped opaque microsecond keyset with 25 rows.
- Property assets retain immutable company/customer/property identity. Optional
  manufacturer, serial, installation and sourced warranty facts are recorded, not
  inferred. Company checklist drafts require an exact actor-bound ten-minute
  review; immutable reviewed revisions pin existing work. Retirement/replacement
  affects new enrollment, not historical instructions.
- Explicit native-appointment work supports 20 entries, 50 reviewed items and
  50 photo reservations per visit. Saved result/text/number/photo answers do not
  default to passed. Required/N/A/attention rules come from the pinned revision.
  Office work requires a note attesting for the accepted assigned performer;
  unassigned sales managers do not inherit office authority.
- Exact saved completion review includes actual customer/property identity fields,
  entry/asset/photo versions and every visit-linked service/task affected by native
  reconciliation. A same-millisecond address change cannot pass using an unchanged
  timestamp. Final work records a nonfuture performed time and explicit service
  selection; attention requires one accountable follow-up.
- One transaction seals the original evidence, native appointment transition,
  selected native service completion, anchored zero-or-one successor, original
  follow-up and audit. The native algorithms are reused, not duplicated. Original
  task description/assignee/deadline and uncertain communication claims are retained.
  A late native recurrence error rolls the entire completion back.
- Neutral `workday-guards.ts` guards both generic completion writers and the direct
  inspection writer. Any external update to a sealed visit, including a same-value
  or empty PATCH, is refused before native reconciliation. Actual lead merging
  refuses retained visit work before bulk reparenting. Corrections append notes
  and never replay native completion.
- Explicit `capabilities.canCancel` is separate from editing/completing held work:
  current accepted, verified actual/effective office staff with `crm.write` can
  cancel an original draft even after asset/parent changes. Current row locks,
  on-behalf note, exact version/request and original-completion checks remain.
  Cancelled answers/snapshots and unknown effects are retained. All retained
  entries, including cancelled history, prevent native customer/property/lead
  changes; a different lineage requires a separate visit. The guard also checks
  implicit generic lead-to-customer backfill before any native mutation. Same-
  lineage corrections can be cancelled and explicitly prepared again.
- Explicitly unperformed service work may be coherently rebooked and freshly
  enrolled later without changing the first visit's sealed evidence. Completing
  a visit does not silently complete other services or propagate assets to a series.
- A legacy appointment with a coherent explicit lead and native `contactId:null`
  exposes its validated resolved customer in the work DTO. Preparation and final
  completion preserve that stored native null and do not infer a property or lead.
- Native JPEG/PNG/WebP photos use an exact server-owned reservation/object ID,
  current version/actor/parent checks, actual byte/type/size/hash validation and
  an authenticated visit-content route. Replayed reservation commands return no
  upload capability. New work objects cannot be adopted through old lead/portal
  storage paths. Legacy GCS is held for this new feature, not silently accepted.
- Native object deletion takes a concrete row lock and rechecks attached or
  unexpired reservation references. Bounded cleanup tombstones expired unattached
  reservations; confirmed evidence is not detached or deleted by orphan cleanup.

The private `growthos-workday-2026-10-06/API-CONTRACT.md` records the integration
seam. Original completion snapshots contain `result`, selected `services`, saved
`entryEvidence`, canonical `parent`, `nativeBefore`, and `tasksBefore`. Export must
allowlist safe business fields rather than export those raw internal snapshots,
object paths, actor/request fingerprints or preview tokens. Root owns that export.

## Verification executed by this lane

All runtime tests below used the existing fresh synthetic, provider-free isolated
runner. No Docker, existing database, provider credentials, hosted mutation,
customer contact, Git/CI mutation or purchase was performed by this lane.

```text
pnpm --filter @workspace/api-server exec tsc -p tsconfig.json --noEmit
```

Passed, exit 0, after the initial backend implementation. The subsequent narrow
held-draft capability/lineage repair was functionally reverified below; root owns
the final regenerated full-workspace typecheck at the release freeze.

```text
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/contractor-workday-contract.test.ts src/services/contractor-workday.test.ts src/services/appointment-work-photos.test.ts src/services/contractor-workday-concurrency.test.ts src/routes/v1/contractor-workday.test.ts src/services/lead-merge-outreach-retention.test.ts src/services/upload-cleanup.test.ts
```

Final result after the held-draft recovery repair: **49 passed, 5 skipped**, six
passing files and one explicitly PostgreSQL-only file. Breakdown: workday 22,
actual HTTP 8, private photos 6,
existing merge-retention 6, cleanup 3, pure contract 4. The five new independent
backend tests are skipped only under `SCHEDULER_TEST_BACKEND=pglite`; no real
PostgreSQL execution is claimed. Earlier overlapping runs (33/6, 43/5 and 45/5) are
superseded by this final focused result, not additional unique passes.

The HTTP tests exercise native signed upload PUT (201), attachment, private read,
save/reopen, exact completion/replay, effective-role changes and legacy lead-only
null preservation. Ordinary domain tests also cover finite/end-of-month recurrence,
rollback, two-service partial completion/continuation, changed asset/task/assignment,
same-timestamp physical identity changes, read-only transactions, expired reviews,
generic no-op/reopen refusals and retained unknown reminder ownership.

After root generated the OpenAPI/client projection, the actual HTTP tests were
also connected to `@workspace/api-zod` response validators for assets, catalog,
work reads, preparation, saved entries, photo reservation/attachment, completion
preview, completion and original-request replay. Both contact-native and explicit
lead-derived customer paths are covered. Parsed generated values round-trip to
the complete original wire JSON (including Date coercion), so a generated schema
silently dropping a response field fails the test. The existing closed service
DTO assertions remain. The first generated-contract isolated HTTP rerun passed
6/6; the final eight-test HTTP run additionally verifies real asset/address edits,
office-only cancellation, retained native lineage and explicit re-preparation
through regenerated `canCancel` schemas. These overlap the final focused total,
not additional unique tests. No schema change was required for this repair.

The first narrow repair run exposed a new synthetic property fixture missing its
required city and an older sealed-relink assertion expecting the prior generic
error code. The fixture was completed and the refusal now asserts the exact
approved `workday_parent_locked` code/separate-visit guidance. Original no-reopen,
no-mutation, version, role and unknown-effect assertions remain intact; the final
49/5 run above supersedes that intermediate failure.

```text
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/contractor-scheduling.test.ts src/services/appointment-parent-coherence.test.ts src/services/service-property-coherence.test.ts src/services/service-obligations.test.ts src/services/service-care.test.ts src/routes/v1/rep-photo-upload.test.ts src/routes/v1/portal-add-photos.test.ts src/routes/v1/leads-photo-delete.test.ts src/routes/v1/leads-merge-photo-count.test.ts
```

Broader local result: **96 passed, 7 existing PostgreSQL-only skips, 1 failure**.
The existing portal test `concurrent attaches cannot race past the cap` failed its
second-request `limit_exceeded` assertion while background automation emitted
PGlite protocol error `08P01` (`bind message supplies 5 parameters, but prepared
statement "" requires 2`). This is consistent with the documented single-backend
local concurrency limitation, but is not permission to dismiss the assertion:
the mandatory actual PostgreSQL release gate must adjudicate it. The other eight
selected legacy files passed. No old assertion or production pool/guard was
weakened. These results overlap other runs and are not an aggregate release total.

`git diff --check` was clean at handoff. The independent reviewer read all five
new race tests and reported the four early high-risk workflow findings source-
closed. The later held-draft cancellation/lineage repair also received a separate
narrow source review with no remaining P0/P1 findings; this is source review, not
another executed test result. Root owns the final shared whitespace/type checks.

## Mandatory actual PostgreSQL writer proof still pending

`services/contractor-workday-concurrency.test.ts` contains these exact tests:

1. `retains actual property, task and performing member locks through atomic work completion while generic writers wait`
2. `waits for actual property or assignment changes and rejects stale work after the writer commits`
3. `two actual finishers and a legacy completion writer produce one original completion and one successor`
4. `actual entry, asset and template edits serialize after completion without rewriting reviewed historical work`
5. `actual native orphan deletion waits for photo attachment and then preserves the confirmed private object`

They use separate PostgreSQL backends, observed `pg_blocking_pids`, transaction
barriers and actual domain/HTTP writers. The first includes actual property/task
updates and membership HTTP mutation; the reverse case waits for actual parent
or assignment commit; photo deletion uses the real native storage remove path.
PGlite skips and source inspection do not satisfy any of these five obligations.

## Integration and release handoff

Backend source is ready for root integration/freeze. Root retains schema/export/
restore probes, built-browser workflow acceptance, full workspace tests/types/
builds, exact candidate PostgreSQL CI including all new and old writer barriers,
Docker parity/cleanup and exact-main release proof. The local portal concurrency
failure must not be silently dropped from the evidence ledger.

This slice does not add contact-only projects/invoices, manufacturer certification,
import mappings, AI photo/video processing, standing asset authority, provider
activation or customer cutover. Actual contractor data/requirements, hosted
recovery, mailbox/phone/device/provider proof and both acceptance cards remain
separate gates. No full L5/L7, public launch or Housecall Pro replacement claim.

The GrowthOS Revenue Desk skill guided the canonical/native, unknown-effect and
evidence boundaries. The Jarvis checkpoint skill is fulfilled for this lane by
persisting the implementation/API handoff and this report; the coordinator owns
shared STATE/release checkpoint and Git operations to avoid overlapping writes.
