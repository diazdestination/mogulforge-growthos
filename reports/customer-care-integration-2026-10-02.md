# Customer-care integration — October 2, 2026

Owner direction: continue toward both contractors' required Housecall Pro
replacement, with **contractor payment collection deferred**. Existing invoices,
balances and truthful external receipt/correction records remain in scope.
GrowthOS subscription billing is separate. No new contractor processor, payment
link, charge, bank action or settlement claim is introduced.

Candidate: `agent/growthos-customer-care-20261002`, based on main
`ae6b6e4f5a1d4203f40a8b494a6990518cf8b188` (runtime baseline `47aca5b`).
This report starts with local synthetic evidence. Exact-head CI and integration
results must be recorded separately below; local PGlite is not PostgreSQL
multi-session, hosted deployment or customer/provider proof.

## Implemented and reviewed

Three parallel lanes were independently cross-reviewed and integrated into the
canonical tenant-bound records, common dispatch controls and scheduler.

| Workflow | Implemented | Deliberate limit |
| --- | --- | --- |
| Service care | Exact expected-service reminder review, one scheduled logical send, quiet/hold deferral, visible receipt, office response attestation, confirmed conflict-checked booking and retained recurrence/completion behavior. | Each occurrence needs review. No automatic contact-only inbox, customer self-booking or inferred warranty terms. A response recorded by staff is not independently verified. |
| Missed calls | Default-off hours/owner policy, individual exact customer-care SMS approval, current consent, fixed send identity, signed-text review, no-response/deadline escalation and callback resolution. Reviewed opportunity creation queues canonical staff push. | Not an autonomous unknown-caller receptionist. Caller ID grants no SMS consent. No automatic replies, appointment promise, general emergency dispatch or unsolicited enrollment. |
| Invoice email | Complete immutable issued document as plain text, exact recipient/selected sender preview, ten-minute actor-bound approval, one logical send and visible accepted/held/uncertain evidence. | No payment processing, attachment/public document link, live bounce/delivery feed or resend/rearm workflow. Provider acceptance is not inbox receipt. |

Lane evidence and operating details:

- [Service care](customer-care-service-2026-10-02.md)
- [Missed-call care](customer-care-calls-2026-10-02.md)
- [Invoice delivery](customer-care-invoices-2026-10-02.md)

## Shared correctness repairs

- Pin the selected provider/mailbox and recheck current staff, recipient,
  workflow approval, consent/suppression, lifecycle and outbound hold at the
  actual provider boundary, after credential preparation. Never fall back to a
  different mailbox or reinterpret imported history as marketing permission.
- The installed Google OAuth library can replay 401/403 message requests even
  with `retry:false`. Gmail now prepares the token first, then dispatches once
  through the bare transport with the frozen token, no redirects/retry and a
  ten-second timeout. Tests exercise the actual library with synthetic transport.
- Twilio disables HTTP redirects for the irreversible message POST and rechecks
  the latest phone/purpose proof/program. Revocation wins consent timestamp ties.
- Human care approvals reject API keys and browser cross-origin/ambient-cookie
  bypasses. An arbitrary Authorization header does not qualify as Bearer auth.
- Service preflight defers before durable ownership; after a receipt exists,
  expired or uncertain work goes to review, not another key/channel. The real
  scheduler row ID is passed as trusted context, not accepted from action JSON.
- Retain permanent logical ownership for an uncertain/accepted invoice or call.
  An operator reconciliation does not authorize another send. Known late holds
  remain visible and do not silently free the slot.
- Harden the disposable test runner against Drizzle's zero-exit setup errors.
  Historical crash/restore attestations use the exact c050067 automation-schema
  fixture; current source cannot be substituted for historical fingerprints.
- Browser QA exposed horizontal overflow at 390px in the service desk. Narrow
  page/grid/file-input constraints and wrapping care controls fixed the overflow
  without hiding content or changing permissions.

## Schema, recovery and retained history

Additive [0007_customer-care.sql](staging-schema-preview-2026-10-01/0007_customer-care.sql)
adds two tables: disabled-by-default missed-call policies and retained care cases.
The candidate expects **105 tables**, not 103. Parent composite unique constraints
precede six tenant-composite user/call foreign keys. Offline regeneration:

```text
node scripts/customer-care-schema-preview.mjs
```

The synthetic recovery drill applies the whole 90-to-105 delta chain, snapshots
and restores both fictional companies, preserves invoice/recurrence/uncertain
receipts and disabled care policies, rejects six cross-company foreign-key
links, and runs 15 read checks through the real app with a SELECT-only role.
Writes/foreign records remain blocked, fingerprints are unchanged, and provider
calls are zero. A narrow synthetic unknown-care exception requires the exact
reviewed receipt/case, paused company and disabled policy; omission, a processing
receipt or enabling its policy is rejected. Default restore guards stay strict.

Data-lifecycle inventory v5 accounts for 105 tables (101 direct tenant, one
indirect tenant, three explicitly excluded). The core export remains a bounded
18-dataset export with explicit exclusions, not a whole-account backup/export.

The earlier managed recovery at `47aca5b` tested 103 tables and its temporary
clone was deleted. It does **not** validate this new image/delta. Do not replay
the retired one-use scripts or create a third cluster. The original held-staging
upgrade/admin-rotation request still needs its separate authorization.

## Local verification

All local records/provider responses are synthetic; hosted/provider credentials
are excluded. No customer message was attempted.

- Command Center: **477 tests passed**, 78 files. The final mobile layout change
  was followed by the focused service UI suite: **10 passed**, and a new build.
- Combined customer-care/transport/scheduler/inventory API gate: **223 passed,
  three explicit real-PostgreSQL concurrency skips**, 17 files.
- Additional voice/call-origin/transport gate: **27 passed**, three files
  (overlaps the combined transport cases; do not add these as unique totals).
- Scripts: **226 passed**, 18 files, including full synthetic upgrade/recovery.
- Reusable website adapter: **26 passed**.
- Full workspace TypeScript and both production builds passed. The UI build
  retains its existing large-chunk warning; no success is inferred from silence.
- The attempted all-API local PGlite run stalled and was stopped. It is **not a
  pass**. Full exact-head CI with real PostgreSQL and Docker remains the gate.

Browser verification uses `preview-runtime-isolated.mjs --customer-care`, a
fresh in-memory loopback fixture at port 4192, with all outbound traffic held.
Verified immutable invoice/unsent labels and the missing-mailbox send guard,
staff-recorded service response -> explicit confirmed native appointment ->
linked service/task state, and the saved result after reload. The initial Today
load showed an unavailable state; later navigation rendered the expected actual
fixture task and timezone warning successfully. Phone-width service QA after
repair has no horizontal overflow. Calls likewise fits 390px, clearly shows
the disabled policy/environment hold, and saves a fictional case as handled by
staff without sending. These are local browser results, not an
iOS installed-app/push or provider acceptance test. Generated screenshots stay
in the private Jarvis customer-care handoff, not the public/repository data.

## Exact-head CI and integration

[PR #14](https://github.com/diazdestination/mogulforge-growthos/pull/14) is the
canonical integration/check record. The implementation commit is
`9e4eb263d70d25f5f3b8b5cf591270f81855b3e2`; test-integration fixes follow it.
Always match the check's head SHA to the candidate rather than inferring green
from this report's date or from an earlier run.

The initial [CI37070893118](https://github.com/diazdestination/mogulforge-growthos/actions/runs/37070893118)
applied the fresh PostgreSQL schema, passed 1,982 API tests and reported seven
test failures across five files (15 existing API skips). It was not merged or
waived. The failures exposed a stale 103/100 inventory expectation, a cleanup
order missing the new call-care child, two HTTP fixtures assuming the isolated
runner's Origin, and an older expectation for the deliberately sanitized final
email-dispatch hold error. The follow-up preserves strict FK/security/error
contracts, updates fixture/count expectations and adds explicit configured-origin
coverage; all **34 tests across those five suites pass** in the combined isolated
rerun. It does not disable or skip those tests. Bounded independent reviews
found no concrete invoice/service transaction leak or concurrency deadlock.

All test/type/build/Docker checks still must pass on the actual candidate head.
The workflow has no push trigger; explicitly dispatch an exact-main run after
integration. Record its actual SHA/run in the PR and private Jarvis checkpoint;
neither merging nor CI proves a hosted image or live provider acceptance.

## Still required before either contractor cuts over

Both cards in [the replacement gate](../HOUSECALL-PRO-REPLACEMENT-GATE.md) remain
**not accepted**. Required migration/open balances/native-source adoption,
trusted incoming-mail integration, communication exception coverage and actual
office/field usability gaps remain engineering/acceptance work. The new slices
do not make those items disappear. Conditional features are driven by the
contractors' actual accepted workflows, not speculative competitor parity.

Complete exact-release schema/recovery/normal-mode staging acceptance, approved
provider send/receipt/reply/STOP tests, actual staff phone installation/push,
website routing and staff rehearsal before customer activation. Azure first
sign-in remains deferred until the owner is present. No deployment, hosted
schema change, credential rotation, provider activation, live contact, purchase,
production start or old-subscription cancellation was performed in this wave.
