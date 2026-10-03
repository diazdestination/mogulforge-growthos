# Standing service reminders — runtime lane

October 3, 2026. Branch: `agent/growthos-standing-service-20261003`.
Implementation contract: `reports/standing-service-contract-2026-10-03.md`.
This report records local engineering evidence, not deployment, provider
activation, delivery proof, contractor acceptance or Housecall Pro replacement.

## Implemented

- `lib/db/src/schema/service-standing.ts`: normalized immutable series
  enrollment and append-only owner-reviewed policy revisions. The latest
  revision, including disable, is authority; no mutable enabled pointer.
- `service-standing-contract.ts` and `service-standing-policy.ts`: strict
  DTOs, SELECT-only default-disabled view, persisted actor/company-bound
  ten-minute HMAC preview, exact approval and replay-safe versioned disable.
  Current accepted owner/admin authority is required for mutations. Disable
  works under provider/lifecycle holds and retains existing send ownership.
- `routes/v1/service-standing-reminders.ts`: API keys rejected before lookup;
  active verified accepted staff sessions may read, settings managers may
  preview/approve/disable. Strict JSON, origin, version and payload checks.
- `service-standing-runtime.ts`: bounded rotating admission stage before
  scheduled actions. A failed series rotates; unexpected failures are reported
  after other selected series have been processed. No provider network/OAuth
  runs inside admission transactions.
- `service-care-authorization.ts`: dependency-neutral reader-aware persisted
  authorization shared with the SMS and Microsoft parent adapters. Typed
  `approval.authorization.origin` is individual or standing. Standing proof
  binds revision, original anchor, policy/series/source fingerprints, admission
  time and finite occurrence expiry. Missing legacy authorization is individual.
- `service-care-budget.ts`, `service-care-claim.ts`, `durable-execution.ts` and
  narrow send-gate reader support: pending/unknown service reservations count
  against contact limits under the same lifecycle/scheduling lock and durable
  claim transaction. Accepted activities and their original receipts count
  once. A cap deferral does not burn a new execution key.
- `service-care.ts`: original audit/action/receipt reused for both origins;
  final current checks run after preparation, before provider POST. New SMS
  snapshots include the fixed service reply reference and reserve the typed
  SMS parent. Readiness checks encrypted reply-storage capability. The intake
  lane owns the actual transport hook and Microsoft parent compatibility.
- Scheduler stage `service-standing` follows mailbox-reply observation and
  precedes scheduled sends. SMS reply-content purge is wired into service
  retention. Scheduler failure isolation and scoped runs are covered.
- Post-provider office evidence preserves staff-written descriptions, progress,
  assignment and an earlier promised deadline. The safe acceptance note is
  appended; it does not erase a staff plan or infer booking/completion.

## Authority and preservation boundaries

One fixed reminder, one selected channel, one future eligible occurrence.
`noticeAt >= revision.approvedAt` is required; already-due/backlog notices remain
individual review. Sending expires no later than the occurrence due timestamp
or explicit agreement end, and quiet-hour/cap deferrals cannot cross expiry.
Agreement validity is distinct from warranty coverage.

Enrollment's founding anchor is immutable. A revision additionally freezes
`reviewedObligationId`, `reviewedUpdatedAt` and `reviewedOccurrenceIndex` as its
exact cutoff. The bounded canonical predecessor walk must contain root, anchor
and reviewed cutoff in order. Recurrence and scope are pinned from that cutoff
forward; legitimate completed ancestors may change status/updatedAt. A changed
recurrence needs a fresh explicit successor-cutoff review, never reinterpretation
of an old queued approval. Month-end/leap-day descendants are checked exactly.

Native versus reconciled imported-service review is explicit and binds source
and cutover evidence. Existing unrelated imported-opportunity and reply holds
remain in force. Policy approval does not grant SMS consent, marketing permission,
customer identity, booking, service completion or warranty eligibility.

The original `scheduled:<scheduledActionId>` receipt and
`service-care:<obligationId>` SMS key remain permanent. Unknown external effects
are not rearmed by disable/reapproval, another channel, restart or another worker.
Legacy saved SMS bodies are revalidated without retroactively adding the new
reference; legacy missing authorization remains individual. Newly reviewed SMS
templates include the fixed reference placeholder, and admission materializes
only the exact reviewed occurrence date/reference. The UI shows the actual
Twilio business-prefix and STOP/HELP wrapper separately.

## Verification recorded by this lane

Commands ran from `C:\Users\diazd\dev\projects\mogulforge` using disposable
synthetic databases and provider stubs, never a customer/hosted database:

```powershell
pnpm --filter @workspace/api-server typecheck

node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/service-standing.test.ts src/routes/v1/service-standing-reminders.test.ts src/services/scheduler-stage-isolation.test.ts src/services/service-care.test.ts src/services/service-standing-mailbox.test.ts src/services/service-sms.test.ts

node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/service-standing.test.ts src/services/service-care.test.ts

git diff --check -- artifacts/api-server/src/services/service-care.ts artifacts/api-server/src/services/service-care-policy.ts artifacts/api-server/src/services/service-standing-policy.ts artifacts/api-server/src/services/service-standing-runtime.ts artifacts/api-server/src/services/service-care-authorization.ts artifacts/api-server/src/services/service-care-budget.ts artifacts/api-server/src/services/service-care-claim.ts artifacts/api-server/src/services/durable-execution.ts artifacts/api-server/src/services/send-gate.ts artifacts/api-server/src/services/response-correlation.ts artifacts/api-server/src/services/scheduler-runtime.ts artifacts/api-server/src/services/automation.ts
```

- API typecheck and scoped diff-check passed after runtime cleanup.
- The six-file integration run passed **91 tests / 4 PostgreSQL-only skips**.
  That selection included the intake lane's actual standing-to-Microsoft
  OAuth/POST/parent/Sent Items/reply tests and its signed-SMS tests. No real
  provider request was permitted.
- Later added month-end/leap-day, foreign predecessor and freshly reviewed
  successor-cutoff tests passed with current care regressions: **53 passed /
  4 PostgreSQL-only skips across two files** (standing 24 passes/3 skips;
  existing care 29 passes/1 pre-existing skip).
- Scheduler isolation had **13 passes**; standing HTTP had **4 passes** in
  the wider run. Counts overlap and must not be summed as unique tests.
- The first standing run exposed two fixture-only missing required lifecycle
  reasons. Those fixtures were corrected and the subsequent runs passed.

Three new checks intentionally require independent PostgreSQL sessions and
must run rather than skip in release CI:

1. Individual versus standing admission converges on one occurrence/action.
2. Two standing admission workers return the same original approval/action.
3. Two durable service workers cannot both claim the final contact allowance
   while the first worker's external effect is still in flight.

The fourth skip in the selections is the pre-existing service-care PostgreSQL
check. Local PGlite is not evidence for these independent-session races.

## Pre-freeze review follow-up

- A completed monitor read is now published only after taking the shared
  lifecycle/scheduling locks, locking the enrollment row, and comparing the
  current immutable revision ID plus the observed checkpoint values. A stale
  future-notice result cannot postpone a newly approved policy's immediate
  wake-up, or replace a newer checkpoint from the same policy. Comparison uses
  the locked row in JavaScript rather than a lossy timestamp-to-SQL equality.
- Typed service authority now has an explicit transaction-only `lockTask`
  option. Only the SMS and Microsoft final parent-claim paths enable it;
  reservations, GET projections and historical reply reads retain their normal
  unlocked SELECT behavior. The task's `FOR SHARE` lock serializes a generic
  task writer through the committed `dispatchStartedAt` boundary even though
  that writer does not use the scheduling advisory lock. It does not recall a
  message after dispatch has begun or place provider network work in a
  transaction.
- Deterministic regressions cover old future result / revised policy / late
  checkpoint, a competing checkpoint for the same head, rejection of a lock
  request on the global reader, and a committed generic task completion
  stopping a locked service authorization check.

```powershell
pnpm --filter @workspace/api-server typecheck
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/service-standing.test.ts src/services/service-care.test.ts src/routes/v1/service-standing-reminders.test.ts src/services/scheduler-stage-isolation.test.ts
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/service-sms.test.ts src/services/mailbox-communication.test.ts
```

These current follow-up checks passed: API typecheck and **73 tests / 4
PostgreSQL-only skips across four files** (standing 27 passes/3 skips, care
29 passes/1 pre-existing skip, standing HTTP 4 and scheduler isolation 13).
Counts overlap all earlier results; they are not additional unique test totals.
The unchanged transport selection then passed **44 tests / 1 PostgreSQL-only
skip** (SMS 20 passes and mailbox 24 passes/1 skip), exercising the new final
parent task-lock flag with the actual local adapters. Scoped diff-check passed.
The intake lane separately owns the actual Microsoft final-claim independent
PostgreSQL session barrier regression and its transport-level evidence. That
new task-row exclusion check is an additional release-CI obligation, not a
claim that local PGlite proves concurrent row-lock exclusion.

## Remaining release and customer gates

Coordinator integration/review, exact candidate PostgreSQL CI, generated API/UI
contracts, built-browser QA, reviewed schema/recovery checks, source release and
separate exact-main CI remain coordinator-owned gates. Later integration results
must be recorded as later evidence, not inferred from these overlapping runs.

Hosted staging/schema/backup acceptance, Azure first sign-in, actual selected
Gmail/Microsoft and Twilio acceptance, physical-phone notifications, approved
source migration and each contractor's complete replacement workday remain
separate gates. No live message/call, provider activation, deployment, hosted
schema or credential/DNS change, spending or contractor cutover was performed.
Contractor payment collection stays deferred. The unrelated workspace backup
was preserved. This lane made no commits and changed no shared project-state
documents; the coordinator owns release and durable global checkpointing.
