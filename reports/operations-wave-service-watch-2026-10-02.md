# Service watch — bounded office follow-up

October 2, 2026. Operations wave from merged main `602131d` under
`reports/operations-wave-contract-2026-10-02.md`. This is local engineering and
synthetic evidence, not provider/device, staging, contractor or cutover acceptance.

## Delivered

- One retained `service_watch_cases` projection per canonical service obligation;
  the existing customer, property, service, office task and appointment remain
  authoritative. No new customer, lead, appointment or customer message is made.
- The scheduler independently bounds bootstrap and rotating checks to 25 each.
  Completed/cancelled records are checked too so an unknown send is not erased
  by service closure. Last-evaluated ordering includes held/resolved records;
  failed bootstrap sources are retained and rotated rather than starving newer
  work. Failures surface a sanitized stage error after other bounded work runs.
- Fixed reasons: reminder needs review; no response **recorded** three days after
  provider acceptance; blocked/unknown reminder; cancelled/no-show visit; overdue
  service; recorded response needing office action; missed office-action deadline;
  missing eligible owner; unavailable source. No mailbox reading, warranty
  interpretation, delivery claim or inferred agreement/consent is introduced.
- Active accepted staff can assign the canonical task owner and explicitly
  acknowledge a next action due within 30 days. This is an internal office plan,
  never customer contact or confirmation. The service date is not postponed.
  There is no button that marks unresolved facts resolved. Real source changes
  resolve/reopen the case; deadline expiry reopens attention. Unknown send
  evidence survives completion until its existing receipt is reconciled.
- Mutations serialize under lifecycle then contractor locks, recheck active
  accepted staff and company status, exact case version plus current source
  fingerprint, and reject unknown fields/foreign owners. Same-request lost
  acknowledgements return the original result even after the deadline passes;
  changed payloads cannot reuse that request identity.
- Existing audit events retain opened/changed/held/resolved/reopened/staff-action
  history. UI shows the latest 50 transitions with a truthful history cap.
  Lists filter before a 50-row bound and use one-row lookahead; they show the
  count of active services still awaiting the first monitor check. Source-error
  rows stay visible with an unavailable-customer label, not foreign customer data.
- Typed staff notifications enqueue inside the same DB transaction through the
  coordinator's `enqueueStaffServiceNotice`. Events use one stable case/revision
  key, target only the actual eligible owner, and never manufacture a lead.
  Acknowledgement/hold/resolution invalidates previous notification revisions.
  `serviceWatchNoticeCurrent` is a read-only final-boundary check of current
  service/owner/fingerprint/lifecycle, not reconciliation or send authority.
- The coordinator's separate default-off service-alert policy, device/session
  guards, delivery ownership and unknown-push handling remain authoritative.
  No owner or device is inferred, no unassigned broadcast, no lead routing reuse.
  Staff push acceptance does not prove the owner saw or acted on a notification.

## UI and API

`/service` now has an attention/office-plan/held watch queue and resolved history.
Each detail shows actual facts, responsible staff, next action, retained history
and the existing Customer care & booking panel. Write failures lock further
changes until explicit refresh/review; refresh resets the acknowledgement box.

`/service?serviceObligationId=<id>&organizationId=<org>` opens a scoped detail
directly, independent of the first 500 service records. The page waits for company
identity and rejects mismatched/missing company links without querying that
linked service or switching organizations. Late responses from previous views
are discarded. Layout uses wrapping controls and bounded widths; physical-phone
and built-browser mobile acceptance remain coordinator/activation gates.

- GET `/api/v1/service-watch?scope=attention|history|all&offset=0`: `crm.read`,
  accepted active staff, no-store, offset <=100000, limit50 + lookahead.
- GET `/api/v1/service-obligations/{id}/watch`: same read boundaries, no query
  overrides, current fingerprint, retained state and history.
- PATCH that detail: `crm.write`, accepted session staff, JSON/origin guards,
  no API-key attestations. Strict `action=assign|acknowledge`, requestId,
  expectedVersion, expectedFingerprint, assignedUserId, note. Acknowledgement
  additionally requires future `nextActionAt` within30days and `reviewed:true`.
- `processServiceWatch(org?, now?)`: bounded scheduler stage; timestamp injection
  is internal test support, not an HTTP parameter or customer scheduling promise.

Owned files: new `lib/db/src/schema/service-watch.ts`; API service-watch policy,
service/routes and tests; UI service-watch panel/tests and service-desk integration
and existing status-test extension. Coordinator owns schema export/parent keys,
route mounting/OpenAPI/codegen, scheduler, typed push, lifecycle/export/recovery,
release verification and Git operations. Unrelated `pnpm-workspace.yaml.bak`
remains untouched.

## Focused evidence

Safe disposable command:
`node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/service-watch.test.ts src/routes/v1/service-watch.test.ts`

Final focused run, including the source-error visibility regression:
**20 passed, 1 explicitly skipped** across two files. Fresh in-memory PGlite,
random loopback port, provider/hosted credentials removed. The skip is the
independent PostgreSQL competing-plan test, which CI must exercise. Positive
workflow, role/tenant/origin/API-key denials, stale snapshots, idempotency,
deadline/hold/reopen, unknown receipts, fairness and atomic enqueue failure are
covered. The first run exposed a test fixture unintentionally using the schema's
verified-email default; the fixture now explicitly supplies null to test denial.

UI command:
`pnpm --filter @workspace/command-center exec vitest run src/components/service-watch-panel.test.tsx src/pages/service-desk.test.tsx src/components/service-care-panel.test.tsx`

**17 passed** in three files. Includes explicit review, lost/stale acknowledgement,
no invented customer operation, held/viewer controls, bounded queue labels,
late-response discard and correct-/wrong-company deep links. Existing late-/me
status coverage is preserved. Command Center no-emit types passed. API no-emit
had no owned-file errors; concurrent source/financial test typing was referred
to the coordinator. Full integrated types/builds/suites and exact-head real-PG
CI remain separate and must not be inferred from these selected runs.

## Still not delivered or accepted

This slice does not add recurring customer-send enrollment, automatic contact-only
inbox correlation, customer follow-up sequences, self-booking, inferred coverage,
external calendar sync or guaranteed device delivery. Each customer reminder and
actual conversation/booking still uses its existing explicit review path. Actual
agreements/dates, source adoption, accepted staff ownership, provider/device
configuration and both contractors' demonstrations remain required. No hosted
schema/account/provider change, send, real import or subscription cancellation
was performed. Azure first sign-in and staging rollout authority remain deferred.
