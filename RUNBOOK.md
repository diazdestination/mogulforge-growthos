# GrowthOS operating entry points

Read `AGENTS.md`, `PROJECT_STATE.md` and `PAID-BETA-READINESS-P0.md` first.
Use an isolated branch, verify identity/target and preserve other agents' work.

Active CALLIE conversation engineering follows
`reports/callie-conversation-contract-2026-10-05.md`. Baseline PR23/mainafcb72a and
exact-main CI37390525754 are fully accepted. Existing Calls remains the work entry;
selected conversational routing will keep GrowthOS's signed staff-first Twilio
flow. The custom handoff is a separately governed original-call redirect, not an
ElevenLabs native transfer. Source settings stay default-off/held until separately
approved actual providers/routes/configuration and phone acceptance are complete.
No account import, live test button, automatic booking/SMS permission, hosted
schema change or deployment is authorized by this engineering continuation.

Active bounded manual-visit extension follows
`reports/manual-appointment-property-contract-2026-10-05.md`. PR22 source release
is complete at main6cbf0ae with exact-main CI37383108807. New manual property
selection must stay optional/default unlinked and must not change historical
visits or bypass native scheduling/reminder guards. Its own candidate/main
checks and operator guide are required before selecting the next source release.
No schema/provider/hosted activation or contractor cutover follows from this work.

Current L7 customer work record: Customers & Jobs → Customers → Customer record.
See `reports/customer-workspace-operator-guide-2026-10-05.md` and its integration
report. Nine selected-section-only pages, exact appointment summary and explicit
new-service property picker reuse existing canonical workflows. No new schema.
Use `preview-runtime-isolated.mjs --customer-workspace` for provider-free local
QA; compatible recovery now includes47SELECT-only app probes. Independent PG16
property-writer tests and exact candidate/main CI remain required source proof;
local preview is not hosted/phone/provider/customer acceptance.

Current L6 candidate: `reports/source-nurture-integration-2026-10-03.md` and
`reports/source-nurture-operator-guide-2026-10-03.md`. Entry: More tools → Win-back
→ Reviewed two-message follow-up. Source adoption, exact-address permission,
selected Microsoft sender, explicit nurture reading, preview/approval/start are
separate. At most ten addresses/two fixed messages/fourteen days; step two waits
at least72hours after actual acceptance plus exact observation and fresh complete
mailbox evidence. Original unknown effects cannot retry or advance. Stop never
releases permanent ownership or recalls an in-flight provider request.

Offline review: `node scripts/source-nurture-schema-preview.mjs` produces0014
after0013 (five new tables,130total), without opening a database. API projection:
`node scripts/source-nurture-api-spec.mjs`, then API-spec codegen. The compatible
synthetic recovery drill now has36SELECT-only app probes and15new negative
constraints. `preview-runtime-isolated.mjs --source-nurture` creates a loopback
fictional stopped/unknown plan and purged-content reply. Readers/providers stay
disabled, outbound held, all contacts DNC and scheduler off. Preview credentials
are disposable; never use these fixtures/configuration for real outreach.

Current L5 candidate: `reports/standing-service-integration-2026-10-03.md` and
`reports/standing-service-operator-guide-2026-10-03.md`. Entry: Warranties & Service
→ Customer care & booking → Review automatic series reminders. Review service SMS
evidence separately; office handling does not authorize a resend or booking.
Default-off policies are fixed, forward-only and explicitly finite. Disable works
without provider readiness. Uncertain original receipts are never replayable.

Offline review: `node scripts/standing-service-schema-preview.mjs` generates0013
after0012 (four new tables,125total); no hosted database is opened. API projection:
`node scripts/standing-service-api-spec.mjs`, then API-spec codegen. Synthetic
`node scripts/contractor-recovery-drill.mjs` includes31SELECT-only app probes and
14new constraint negatives. Preview flag `--standing-service` creates fictional
services with DNC on, providers absent, outbound held and scheduler disabled.
Its ephemeral encryption key only allows local reply-storage readiness checks.
New referenced SMS needs stable encrypted-content storage in an approved hosted
environment; never paste secrets into service agreement evidence. Require exact
candidate/main CI and separately approved hosted/provider/company acceptance.

Current October3 CALLIE candidate: `reports/callie-intake-integration-2026-10-03.md`
and its operator guide. Calls is the entry point; the setup panel requires exact
owner approval, while each visit needs actual staff-reviewed identity and an
agreed appointment. Original handoff/task and permanent response identity are
reused. Never replay unknown sends or bypass a held provider with legacy care.
Generate reviewed-only0012offline with `node scripts/callie-schema-preview.mjs`;
the candidate has121tables. The compatible synthetic recovery has29SELECT-only
real routes and12new CALLIE constraint checks. Preview flag `--callie` creates
fictional records without provider credentials; scheduler off, outbound held.
Require exact candidate/main CI and separate current-release hosted/provider
acceptance. This is not conversational AI voice, a warranty decision or live
activation. Previous active-wave wording below is retained as historical.

Active second wave: `reports/invoice-recovery-contract-2026-10-02.md`, based on
integrated lead-reply51da543 / green candidate CI37089194639. Keep invoice
attempts append-only, unknowns held and additional copies explicitly reviewed.
Offline schema review uses `node scripts/invoice-recovery-schema-preview.mjs`
for0011after0010; it never opens a database or applies hosted schema. Complete
the compatible restore and exact release checks before selecting this candidate.
Use `reports/invoice-recovery-integration-2026-10-02.md` for the completed source
checks and browser/recovery evidence. Operator entry: Invoices → Invoice email
delivery → Open invoice. Old-format reviews and unknown effects remain read-only;
only exact server-derived modes may prepare a fresh review. The local invoice
preview flag is `--invoice-recovery`; it never connects a real provider.

The previous candidate and implementation entries below are historical.

Newest candidate: `reports/lead-replies-integration-2026-10-02.md`. Exact reviewed
BIE Microsoft lead sends now have a separately opted-in original-mailbox reply
loop, canonical lead hold/task and explicit staff handling. The lead Messages
section is the office entry point; no new general Inbox is introduced. Review
0010after0009 with `node scripts/lead-replies-schema-preview.mjs`; no hosted
approval is implied. The next authorized wave is invoice delivery recovery.

Newest implementation: `reports/launch-communications-integration-2026-10-02.md`
and its three lane reports. The117-table source adds tracked Microsoft service
replies and platform identity delivery evidence. It is not general inbox support.
Use `LAUNCH-COMPLETION.md` for remaining work and the new report for exact screen
entry points, reviewed0009schema, safe local QA and pending release/live gates.
No hosted upgrade or provider activation is implied by this entry point.

Historical operations wave: `reports/operations-wave-integration-2026-10-02.md`
and `reports/operations-wave-operator-guide-2026-10-02.md`. Service watch adds
internal next actions and separately opted-in current-owner notifications;
source adoption adds no consent, and reviewed outreach is one bounded email
touch with permanent uncertain-effect reservations. Financial migration accepts
only reconciled normalized v1 records; opening receivables are not cash.
`node scripts/operations-wave-schema-preview.mjs` generates offline-reviewed
`0008_operations-wave.sql` from main602131d. It adds six tables (105 to111),
composite tenant keys and invoice basis columns. Only lead_id nullability on
staff push is relaxed, guarded by an exact lead/service target XOR constraint.
No migration, provider activation or hosted credential operation is authorized.

- Product and scope: `GROWTHOS-CONTRACTOR-OPERATIONS.md` and `GROWTHOS-CONTRACTOR-PRODUCT.md`.
- New customer-care candidate: `reports/customer-care-integration-2026-10-02.md`,
  with service, calls and invoice lane reports beside it. Contractor payment
  collection is deferred; retain truthful external receipt records. Customer
  reminders/call recovery require exact individual review, not blanket consent.
- Current integration: `reports/geekom-contractor-integration-2026-10-02.md`;
  upstream scope: `reports/native-contractor-day-integration.md` and specialist reports.
- Fresh managed recovery/schema evidence and cleanup status:
  `reports/managed-contractor-recovery-2026-10-02.md`. One-use private target pins
  are not a general staging migration command. Never print raw
  `fly mpg status --json`: it includes credentials; use bounded allowlisted output.
- Customer adoption/commercial acceptance: `BETA-CONTRACTOR-SUCCESS.md` and
  `HOUSECALL-PRO-REPLACEMENT-GATE.md`. Required Housecall Pro workflows must be
  accepted before either company's real onboarding/cutover; recovery proof alone
  is not replacement readiness.
- Invoices: `reports/native-contractor-invoices.md`; internal issue is distinct from send/collection.
- Staff invitations/readiness: `reports/contractor-operations-onboarding.md`.
- Reply review/holds and trusted normalizer contract: `reports/contractor-operations-replies.md`.
- Owner report periods and evidence definitions: `reports/contractor-operations-reporting.md`.
- Billing checkout/replacement: `reports/beta-operations-billing.md`.
- Core export/company holds: `reports/beta-operations-lifecycle.md`.
- Website delivery: `examples/website-connection/README.md` and its adapter tests.
- Pilot operations: `PILOT-OPERATOR-RUNBOOK.md`; scheduler: `SCHEDULER-OPERATIONS.md`.
- Additive schema preview: `reports/staging-schema-preview-2026-10-01/0003_swarm-foundation.sql`.
  Apply reviewed `0004_beta-operations.sql`, `0005_contractor-operations.sql`, then
  `0006_native-contractor-day.sql` generated against the verified48c3491 baseline.
  The newer customer-care candidate adds reviewed `0007_customer-care.sql`
  against ae6b6e4: 103 to 105 tables, with parent composite unique constraints
  preceding the new tenant-bound foreign keys. Generate it offline with
  `node scripts/customer-care-schema-preview.mjs`; this is not hosted approval.
  Preview only; do not bypass `scripts/release-schema.mjs` staging approval/hold.
- Source import limits: `reports/swarm-opportunity-history-2026-10-01.md`.
- Scope assignment/billing limits: `reports/swarm-subscription-controls-2026-10-01.md`.
- Tenant/photo matrix: `reports/normal-mode-tenant-acceptance-2026-10-01.md`.

Local verification uses disposable synthetic databases. The guarded isolated
runner is `artifacts/api-server/scripts/test-scheduler-isolated.mjs`; the normal
tenant matrix wrapper is `test-tenant-acceptance-isolated.mjs` alongside it.
Real PostgreSQL full CI remains required for multi-session lock/concurrency
acceptance. No provider credentials or production data belong in test fixtures.

`node scripts/contractor-recovery-drill.mjs` creates only in-memory synthetic
databases. It upgrades the old90-table schema, checks current111-table/column
coverage, snapshots/restores both companies and boots the real app through the
production bundler under a SELECT-only role. It verifies tenant isolation, blocked
writes and unchanged fingerprints, issued snapshot hashes, retained cash allocation
reversals, invoice sequence and recurring service successors. The one reviewed
active synthetic successor is accepted only behind a restored company pause;
negative checks reject a removed pause, omitted exception or extra active record.
It also retains disabled missed-call policies and the exact reviewed uncertain
care execution; the narrow exception additionally requires that paused company,
disabled policy and correlated case. Six negative cross-company foreign-key
probes remain; thirteen additional tenant-key negatives, cloned claimed-send
reservation rejection and 22 restricted real-app reads cover the operations
wave. Retained service plans, revoked source reviews/claimed batches, non-cash
opening invoices and typed indeterminate push survive restore. Do not generalize
the synthetic exception to a hosted queue or another receipt.
It accepts no target URL and cannot validate a
managed backup, live keys, hosting or production RPO/RTO. Historical hosted pilot
attestations remain frozen and cannot be relabelled as current-source acceptance.

Preserve indeterminate execution history. Do not replay an uncertain external
effect until reconciled with evidence. Roll back application code without
automatically dropping newly stored source history or entitlement audit records.
After adopting the 103/105/111-table workflows, the older 77f6d63 application is not a
normal-write fallback: it does not enforce the new lifecycle/reply holds,
durable billing attempts, invoice retention or agreed service recurrence. Keep
an old-image fallback stopped/under maintenance or independently verified
read-only. An outbound-email hold alone does not disable billing or inbound
provider effects. Do not restore normal writes until the intended controls
are verified. The older one-time 90-to-95 migration script is historical;
a 95-to-103 release needs its own reviewed, hash-pinned transaction and fresh
backup/recovery evidence. Verify original-column row projections and new-column
defaults separately, plus complete types, constraints, index predicates and ACLs;
table/column counts alone are not a schema acceptance test.
Provider, billing and customer activation require their own acceptance evidence.

Company pause is a recorded operating control, not an emergency atomic kill:
not-yet-claimed covered work remains queued; already handed-off work can complete
or require reconciliation. Resume requires reviewing the queue. Mid-preparation
playbook holds retain their step and require explicit enrollment review. Opt-outs,
stops, outcomes and provider receipts remain available. Platform identity/security
notifications remain independent. Offboarding requests preserve data and billing;
separately review expanded exports, deletion, retention and credential revocation.
