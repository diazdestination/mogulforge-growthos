# GrowthOS swarm release audit — October 1, 2026

## Decision and evidence boundary

The shared platform is suitable for advancing the limited $500 founding beta and
the proposed $1,500 flagship. It is **not yet demonstrated paid-beta ready**.
More parallel engineering can shorten independent code work; it cannot replace
customer source access, approved provider tests, lifecycle decisions, or observed
customer value. No completion date or flawless-operation claim is justified.

Inspected checkout: `agent/growthos-swarm-foundation`, starting at `58ab300`.
The parent verified exact-head CI run `36936007265` successful before delegation;
this audit did not independently query GitHub. Other workers are changing imports
and billing, so those forthcoming changes require separate review and a new CI run.
No live environment, provider, customer record, billing subscription or deployment
was changed by this audit.

Historical hosted evidence was read from
`reports/controlled-pilot-2026-09-30.md`; it is dated evidence, not a fresh hosted
inspection. That ledger records managed restore, held staging, scheduler timed
cycles/restart and a bounded crash-after-task exercise. It explicitly does not
establish live provider acceptance or the full normal-mode isolation matrix.

## Customer journey capability matrix

| Journey step | Current source capability | Local evidence | Remaining live/release proof |
| --- | --- | --- | --- |
| Website inquiry | Website-independent Smart Site contract; site credential, Launch Guard, response coverage, per-request fingerprint and transaction; repeated inquiry and repeated request are distinct. `services/smart-sites.ts:371`, `:383`, `:410`, `:415`, `:519`; `routes/v1/smart-sites.ts:195`. | Existing Smart Site route/service tests and previous packaging UI checks. This audit has not rerun their entire acceptance. | Install and test each site's supported secure relay/backend, actual retries/outage recovery, company responder and activation evidence. Generic website compatibility is not proven by the shared endpoint. |
| CRM and source history | Org-scoped contact/lead/property/estimate graph. The baseline import does not preserve the full historical opportunity identity/date contract; assigned import worker is addressing this. | Fresh audit run: 24 service tenancy tests, nine list-scoping tests and one API-key HTTP tenancy test passed. | Representative approved Housecall Pro export/access, exact mapping, source ownership/freshness, reconciliation and repeated jobs. CSV is not live sync. |
| Owned follow-up | Site follow-up assignment/attempts and Revenue Desk proposals; exact saved-payload approval and execution-time current lead/reply/appointment checks. `services/smart-site-followup.ts:59`, `services/bie.ts:696`, `:835`, `:871`. | Existing BIE/Revenue Workspace regressions and prior exact-head CI; the new 15-case normal-mode matrix passes locally. | Office responder rehearsal, follow-up coverage, correct company data and a current source-status check. |
| Controlled execution | Tenant/action-key durable receipt with fingerprint; ambiguous failure becomes indeterminate and is not automatically replayed. `services/durable-execution.ts:21`, `:67`, `:95`. Global scheduler has session advisory ownership and stage health. `services/scheduler-runtime.ts:38`. | Existing durable/scheduler tests; dated hosted synthetic task/restart evidence in controlled-pilot ledger. | Normal scheduler enablement for the exact candidate, remaining legacy failure windows, real provider effect and visible incident handling. |
| Outbound email | Explicit user-selected Gmail/Microsoft identity, active tenant membership, no mailbox fallback, outbound hold, evidence distinguishes acceptance from delivery. `services/user-email.ts:118`, `:136`. | Provider adapters are mocked in tests; GEEKOM owns Microsoft's separate provider acceptance. | Approved OAuth identities, expiry/revoke cases, intended sender, real inbox receipt and correctly correlated evidence. Azure setup alone would not complete the matrix. |
| Incoming response | Portal messages and Twilio inbound paths exist; Email Intelligence accepts signed normalized forwarded mail and stores reviewed facts. | Source inspection and existing route tests; no fresh provider proof here. | Full mailbox reply-to-opportunity correlation is not implemented by Mail.Send/gmail.send or by the current intelligence fact store. See finding R3. |
| Appointment/outcome/value | Appointments, estimates, job state and org-scoped value ledger; source references deduplicate recorded payments/costs. `services/revenue-workspace.ts:413`, `:484`. | Existing route/service tests; new normal-mode matrix passes selected direct evidence, CSV and payment tenant boundaries. | Actual customer outcome/collection evidence; ledger is staff-recorded, not bank sync or proof of causal lift (`:546`). Booking requests must not be advertised as confirmed third-party capacity. |
| Subscription | Single-price Stripe integration and optional paywall; new explicit operator-assigned entitlements gate automated execution. | Independently reviewed runtime and synthetic test source; worker test results are recorded in its subscription report. One checkout lifecycle defect was corrected during review. | Agreed beta grants/limits, complete checkout/retry/replacement lifecycle, Stripe test-mode acceptance, queue and downgrade behavior; no real price or subscription creation authorized. |
| Offboarding/export | Session-only owner/admin bounded inventory; complete/export/deletion explicitly false. ROI CSV is only a report. `services/data-lifecycle-inventory.ts:194`, `:247`; `routes/v1/reports.ts:27`. | Fresh audit run: 49 inventory service, 21 session guard and 13 inventory HTTP tests passed. | Full tenant archive, complete ownership/media inventory, hold/revocation, reviewed deletion plan, retained exceptions, delivery/reconciliation and truthful policy. |
| Recovery/support | Public process/database probes; operator queue/runtime view; dated same-image managed restore evidence. `routes/v1/revenue-workspace.ts:72`; `READINESS-OPERATIONS.md`. | Scoped synthetic tests and earlier hosted record, not a current endpoint probe. | Owned external alert destination and receipt, exact-candidate acceptance, coverage/runbook rehearsal, repeat restore after material schema changes. |

Source paths in this report are relative to `artifacts/api-server/src/` unless a
repository-relative document or schema path is named. Line anchors describe the
starting source; concurrent changes may move them.

## Priority findings

### R0 — P0: reproduced photo cross-tenant read, repaired locally (requires release integration)

The new normal-mode matrix reproduced an actual isolation failure in both tenant
directions. With a real authenticated `crm.write` session and a known foreign
photo UUID, `POST /leads/{ownLead}/activities` accepted
`type: photos_attached` plus the foreign path (201). A later staff photo GET
returned 200 with the other tenant's exact synthetic bytes. Direct foreign GET
before the forged reference was correctly 404; thus reference creation bypassed
the dedicated attachment validator. This was not blind path discovery and no
real customer record or provider was involved.

Under explicit parent fix assignment, the generic activity route now requires
the dedicated photo endpoint, and both staff and portal photo reads supply
the authenticated organization to object lookup. Existing forged links and
null-owned objects are rejected independently of the write fix. The legacy
GCS/Replit adapter has no authoritative tenant ownership registry, so tenant
reads and attachment validation fail closed for that provider; only verified
Postgres ownership is supported by this milestone. No hosted GCS migration is
implied. Detailed reproduction, invariant manifest and acceptance results are in
`reports/normal-mode-tenant-acceptance-2026-10-01.md`.

### R1 — P0-7: complete lifecycle is absent (blocks external paid beta)

The inventory is deliberately honest and bounded, not a lifecycle workflow.
`data-lifecycle-inventory.ts:194` and `:247` return `complete: false`,
`exportReady: false`, `deletionReady: false`. The explicit catalog's blockers
(`data-lifecycle-inventory-catalog.ts:128–137`) include unresolved JSON/text
links, global sessions, null/shared/external media, providers/backups, retention
and revocation. `routes/v1/orgs.ts` has create/list/update, not account closure.
Individual CRM row deletion and test cleanup do not provide a safe whole-account
operation. No complete archive/delivery or account-wide execution hold was found.

Consequence: a paying contractor cannot be promised a supported complete export,
closure or deletion process. Build the approved archive and ownership manifest
first; preserve unknown categories and replay/suppression history. Resolve policy
choices before irreversible implementation. Do not expose a raw database dump or
reuse `deleteTestOrgs` as a customer tool.

### R2 — P0-8: hosted normal-mode isolation acceptance remains missing (blocks production confidence)

Existing source tests establish many useful boundaries. The hosted restore
runner sets `RESTORE_DRILL_ONLY: "true"`
(`scripts/hosted-pilot-drill.mjs:415`), and
`lib/restore-mode.ts:164` rejects writes before normal handlers. A 405 from that
guard does not test authorization or mutation in the normal product.

The audit's six selected suites passed. The new 15-case normal-mode HTTP matrix
also passes with successful same-tenant controls, foreign-tenant denials,
post-state checks and zero unintended provider calls. Those cases are not the
complete required read/write/delete/search/export/send/provider-identity matrix
across every module and role. Extend the manifest for uncovered modules, then
run the approved equivalent against one exact staging SHA. The local matrix is
not hosted P0-8 completion.

### R3 — High: response intake is not a complete email-to-opportunity loop (blocks unattended flagship promise)

`services/bie.ts:235–255` and `:879–901` recognize lead-linked
`customer_reply`/`email_received` activities. Current Email Intelligence ingestion
(`services/email-intelligence.ts:369–471`) stores messages, facts and a source
audit event, but does not attach a reply activity to a lead. The message schema
(`lib/db/src/schema/email-intelligence.ts:63`) has no opportunity/thread linkage.
The Microsoft connector asks for `Mail.Send` and `User.Read`; Gmail sending
scope is not inbox synchronization. Search found these two BIE checks as the only
non-test uses of `customer_reply`/`email_received` in current API source.

Consequence: an actual mailbox response can exist without the stale-follow-up
guard knowing. Initially require staff review of current source/inbox state;
later implement reviewed, tenant-safe thread/opportunity correlation with
ambiguous matches held, stop/escalation behavior and real provider acceptance.
Do not silently broaden mailbox scopes or claim the fact inbox stops every reply.

### R4 — High: remote revocation evidence is incomplete (part of P0-7)

`services/gmail-oauth.ts:415–451` deliberately removes the local token even if
Google revocation fails. It clears error state and returns `true`, while the
route (`routes/v1/gmail-integrations.ts:152–168`) returns only `disconnected`.
The existing test explicitly expects this behavior
(`services/gmail-oauth.test.ts:253–266`). Local credential removal is correct;
remote grant revocation must remain separately pending/confirmed in an
offboarding record. Microsoft already returns `remoteConsentRevoked: false`
(`services/microsoft-oauth.ts:445–466`), which is a more explicit boundary.
Gmail's warning also includes arbitrary provider error text; use a redacted fixed
category when the revocation evidence path is repaired.

### R5 — P0-4/5: delivery and incident response lack fresh end-to-end proof

No current report examined establishes the full real-provider acceptance matrix
or receipt of an external operator alert. `emailAcceptanceEvidence` explicitly
returns `deliveryConfirmed: false`. `GET /api/readyz` proves a bounded SELECT 1,
not scheduler freshness or delivery. These are evidence gaps, not proof that a
configured provider is broken. Preserve historical restore/scheduler evidence,
then perform the exact-candidate, approved test-identity matrix and an operator
incident rehearsal. A stopped or held scheduler is an intentional safe state,
not evidence of normal operating reliability.

## Shortest critical path

1. Complete independently assigned historical import and entitlement foundations;
   review together, update the schema/lifecycle catalog as necessary, and obtain
   new exact-head full CI and Docker parity.
2. Integrate the local normal-mode HTTP isolation milestone and its photo repair.
   Build the complete archive/lifecycle process separately, with explicit owner
   policy decisions and no destructive customer operations.
3. Confirm each beta's Housecall Pro identity/plan/source access, named responder,
   agreed feature scope, approved contact policy and baseline. Use one common
   source-aware workflow; preserve the $500 agreement.
4. In an approved held-staging window, accept the exact artifact/schema, normal
   tenant boundaries, owned alerts/recovery, selected provider identities and
   genuine receipt/revoke/error cases. Record unavailable channels as unavailable.
5. Rehearse the real office workflow on synthetic records, including failed sends,
   new replies, opt-outs, stale proposals, plan changes and cancellation access.
6. Only after applicable release approval, run a bounded real beta and measure
   actual responses/outcomes, collections, staff time and service/provider costs.
   Those results justify the flagship and inform reusable trade packs.

## Fresh checks performed by this auditor

Executed `node artifacts/api-server/scripts/test-scheduler-isolated.mjs` with:

- `src/services/data-lifecycle-inventory.test.ts` — 49 passed
- `src/services/data-lifecycle-inventory-session.test.ts` — 21 passed
- `src/routes/v1/data-lifecycle-inventory.test.ts` — 13 passed
- `src/services/tenant-isolation.test.ts` — 24 passed
- `src/routes/v1/api-key-tenant-isolation.test.ts` — 1 passed
- `src/routes/v1/tenant-list-scoping.test.ts` — 9 passed

**Result: 117 tests in six files passed; exit 0; 31.75 seconds reported by Vitest.**
The inspected runner creates a disposable in-memory PGlite database on loopback,
strips inherited credentials, pushes only that synthetic schema and runs serially.
It does not establish PostgreSQL advisory-lock concurrency, hosted configuration,
actual provider behavior, customer data correctness or paid-beta readiness.

Parent-assigned follow-up initially covered the new normal-mode matrix only.
After the concrete canary failure, the parent explicitly expanded ownership to
repair staff/portal storage lookup, the generic activity handler and the legacy
object-provider ownership boundary. The import/billing workers' source remains
outside this auditor's edit scope.

The fixed wrapper `scripts/test-tenant-acceptance-isolated.mjs` then passed all
15 normal-mode HTTP cases (exit 0, 7.28 seconds). The expanded related photo
selection passed 58 tests in eight files but exited 1 on the existing
`assessment-photo-flow.test.ts` five test timeouts plus teardown. That unresolved
emulator result is documented in the matrix report and must be arbitrated by
real PostgreSQL CI; it is not counted as a pass. Tests were not weakened.

## Independent subscription review

Reviewed the worker's schema, assignment service, HTTP guards, Stripe
reconciliation, BIE execution hooks and synthetic tests. No new tenant self-grant
or webhook customer-binding bypass was found in this review. This is a bounded
source review, not a claim that every subscription workflow is accepted.

- Platform enrollment is session-only, rejects API keys and ordinary tenant
  roles, validates a strict policy, rechecks the active platform operator in the
  transaction, and writes its audit atomically (`services/entitlements.ts:115`).
  Tenant reads derive organization membership from authentication. The shared
  billing lock serializes enrollment and webhook policy changes.
- Signed events reconcile current provider subscription state under the tenant
  lock, check the persisted customer binding and metadata, deduplicate event IDs,
  and preserve manual/legacy scope (`services/billing.ts:153`). Unknown mappings
  or ambiguous line items fail closed for managed capabilities. Provider reads
  are bounded; no live Stripe calls were made by this review.
- **Found and corrected during review:** checkout could create a second
  subscription even though reconciliation refuses to replace a bound
  subscription. The worker added a pre-provider 409 and disabled checkout in
  status for any bound subscription, including canceled ones
  (`services/billing.ts:55`, `:89`; `routes/v1/billing.ts:124`). Synthetic tests
  explicitly cover active and canceled bindings. Replacement remains an
  operator reconciliation requirement.
- **Open billing lifecycle blocker:** before any subscription has bound, initial
  customer/session creation still has no persisted in-flight attempt or provider
  idempotency key (`services/billing.ts:75`, `:100`). Two initial requests, or a
  retry after an unknown response, can create multiple customers/sessions and a
  subscription this strict reconciler cannot bind. This is a preexisting path,
  not a demonstrated live charge. The worker documents the limitation; the
  slice must not be accepted as a complete live charging lifecycle.
- The implemented tier boundary is only `revenue.autopilot`; null policy retains
  legacy access. Usage limits, paid add-ons, self-service purchase selection,
  other feature gates and complete cancellation/offboarding remain outside this
  slice. Explicit beta enrollment and accurate agreed scope are still required.

## Final shared integration review

Read-only review of `reports/staging-schema-preview-2026-10-01/0003_swarm-foundation.sql`
found the delta matches the three changed schema modules: eight additive columns
and the tenant/source/opportunity unique index. Nullable history and entitlement
fields preserve legacy rows; import counters default to zero. The representative
upgrade test (`lib/swarm-schema-upgrade.test.ts`) uses an isolated temporary
schema in a rollback transaction, checks retained values and nulls, and verifies
same-source opportunity IDs can coexist across tenants but collide within one
tenant. The parent reports this test passing. The SQL remains a review artifact,
not a hosted migration receipt; target backup, transaction and lock-budget review
remain required.

The shared outreach gate resolves the actual tenant/contact/opportunity tuple
before evaluating imported provenance (`services/send-gate.ts:271`). BIE and
automation/playbook callers now provide their current opportunity. Contact-only
outreach is held when an imported opportunity makes provenance ambiguous;
separate fresh inquiries remain usable when explicitly identified. Transactional
contact policy retains its existing behavior. No caller-supplied freshness flag
was added.

**Integration finding repaired and independently reviewed:** the first shared
gate change sent source-review holds through playbooks' generic nonfatal skip
path and then claimed/advanced the step. Reactivation also enrolled held imports
and changed cold terminal status to `nurture` before the later gate. An imported
sequence could therefore consume every touch with zero outreach and mutate
historical status while unable to send.

The opportunity worker added the source check immediately after the
tenant-scoped lead lookup (`services/reactivation.ts:945`), before enrollment,
scheduling or stage mutation. Its regression (`services/reactivation.test.ts:206`)
covers CSV lost/completed records plus legacy imports, unchanged statuses, zero
enrollment/queue rows, explicit skipped reasons and a separate fresh inquiry that
enrolls. The worker reports 26 isolated tests passing.

The subscription worker now prioritizes the actual imported provenance before
playbooks' deferred/nonfatal handling (`services/playbooks.ts:495`). A
tenant/active/current-step compare-and-set pauses the exact step, clears its next
run, appends pause history and records the blocked reason. It never advances or
sends. Existing suppression/global-DNC stops remain in place. The new
`services/playbook-source-hold.test.ts` checks email first step, SMS final step,
retained history, repeated/resumed holds, missing email, missing SMS consent,
permanent DNC, a foreign tenant and a separately identified fresh inquiry for
the same contact. The worker reports all eight cases plus five source-gate cases
passing. Those are worker-run results; this auditor independently inspected the
final runtime diff and test assertions without rerunning them.

No additional blocking regression was found in the bounded migration,
send-gate/BIE and repaired source-hold review. Full exact-candidate CI and hosted
acceptance remain required. No freshness override or wider live-sync work was
introduced; historical imports still cannot authorize automated outreach.
