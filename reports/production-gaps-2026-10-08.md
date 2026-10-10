# GrowthOS production-gap assistance — October 8, 2026

## Baseline and scope

Adam asked WILLOWFORGE to assist with closing production gaps. Verified private
repository `diazdestination/mogulforge-growthos`, identity `diazdestination`, main
`2162aa296281473dda170291ff95d64e0e6e9b79`, successful exact-main CI `37500458053`.
Work is isolated on `agent/growthos-production-gaps-20261008` in the existing
`C:\Forge\worktrees\growthos-revenue-queue-hardening` checkout. The old base clone
and GEEKOM working directories were not updated. PRs through #27 are merged;
October 1 local records were stale. The current source has 141 tables and supports
returning-customer work and contractor equipment/checklists. No new schema here.

Frozen scope: [Smart Site claim contract](smart-site-claim-contract-2026-10-08.md).
The source, experience and independent review lanes closed that bounded contract.
The fixed launch list and both companies' full replacement cards remain open.

## Implemented

- **Notification destination:** the native lead page reads one exact inquiry,
  independent of Capture's 25-row queue. It shows the responsible person and lets
  an eligible responder claim an unassigned open inquiry. Painless can retain its
  intended alert-both/one-claims workflow without an automatic round-robin owner.
- **Final authorization:** assignment/contact-attempt transactions recheck active,
  verified, accepted same-company staff with write access after the lead lock.
  Sorted membership locks hold actor/target authority through task/audit commit.
  Pending invitations, removed/revoked staff and ineligible owner choices fail.
- **Request safety:** owner and attempt routes require JSON and refuse API-key
  headers, foreign Origin and cross/same-site Fetch Metadata. Exact reads are
  tenant-scoped, no-store and expose only the explicit ownership DTO. Route
  permission inventory, OpenAPI and generated clients include the new read.
- **Retry clarity:** concurrent initial claims conflict; the panel never takes
  another person's lead. Unknown saves require a read before retry, including
  after navigation. Acknowledged claims survive read failure; authority changes
  discard late local results. The independent reviewer found the remount cache
  defect, which is repaired with dedicated regression tests.
- **Release safety:** generic forced schema reconciliation is retired for every
  identity before any child/database operation; Git failures in a known checkout
  cannot borrow a supplied SHA. Docker installs require the committed lockfile.
  See [operator impact and 30 focused tests](release-safety-2026-10-08.md).

Root's integration follow-up also found and retired the `AUTO_MIGRATE` startup
alternative, which independently invoked forced schema push. Disabled startup
remains a no-op; enabling the legacy flag refuses before database/child access.
The example configuration no longer recommends it. This closes the same unsafe
mutation through either hosted release or process startup, without adding a new
migration executor. The follow-up requires its own full final-head CI result.

An ordinary Fly deployment now stops at its legacy release command. This is a
deliberate closure of an unsafe mutation path, not a replacement hosted migration
executor. A reviewed exact-source/SQL/target/backup procedure is still required.

## Verification

- Full local frontend suite: **998 tests passed in 113 files**. Final workspace
  typecheck passed, and both production builds passed. Targeted component + native
  lead-detail tests passed 18/18 after the remount repair.
- Isolated API integration: **24 passed, 5 skipped** across exact HTTP, service
  and permission-inventory suites. The five skipped cases are explicitly real
  PostgreSQL only: four membership barriers and injected task-write rollback.
  Full GitHub CI must run them on PostgreSQL 16. The existing Smart Sites suite's
  synthetic staff fixture now explicitly models verified accepted responders;
  its protective local `*_test` database guard is preserved.
- Startup and restore-mode checks: **27 tests passed** in a sanitized unit runner
  without the API database setup. Enabled legacy flags cannot access the pool,
  spawn a child or log connection details; disabled and restore-only behavior is preserved.
- All release/scripts suites: **247 tests passed in 18 files**, including current
  synthetic compatible recovery and 30 focused release-safety checks.
- Both production builds passed. Existing bundle-size/toolchain deprecation
  warnings remain; no dependency upgrade was introduced.
- Browser check used local synthetic responses and the actual component/CSS at
  1440, 390 and 320px, light/dark, with keyboard activation, saved/read failure,
  lost acknowledgement, conflict and initial read failure. Five scenarios passed;
  one PATCH per attempted claim, no horizontal overflow, no page errors and no
  axe WCAG A/AA findings on inspected before/after states after contrast repair.
  This is bounded component QA; native-page placement has integration tests.
  It is not full-app accessibility certification or actual phone acceptance.
- Temporary fixture pages were removed; the task-owned loopback Vite server was
  stopped. Screenshots/results are local under
  `C:\Forge\artifacts\growthos-production-gaps-20261008`. No traces or recordings.
- Impeccable's scoped detector returned no findings. Backend and frontend received
  independent bounded review; hosted proof cannot follow from that source review.

GitHub's exact candidate PR checks are the authoritative full PostgreSQL/types/
builds/Docker result. This committed report intentionally does not pre-claim a
future run, merge or deployment. Current final SHA/PR/run and secret-scan evidence
are recorded in the external Forge release receipt to avoid a self-referential SHA.

## Remaining production gates, in order

| Gate | Current evidence / next work |
| --- | --- |
| Exact hosted release | Read-only `https://app.mogulforge.ai/api/readyz` returned HTTP 404 (`Cannot GET /api/readyz`); the staging path timed out after 20 seconds. These observations establish neither deployed SHA nor general outage. Inspect authorized Fly identity, app/image and actual database baseline before preparing the reviewed current-source SQL/recovery rollout. |
| Recovery and operation | Current approved target backup/restore, scheduler continuity, external storage and alert behavior need exact-release hosted proof. Historical synthetic/managed receipts do not prove this release or current operation. |
| Staff/device coverage | Configured notification recipients without an eligible phone/session can still be omitted by enqueue. Add visible coverage/missing-recipient evidence, then accept real Ryan/Jesse access and each installed phone, background/locked/offline delivery, after-hours response and one claimed lead. Actual lead/service notification click behavior remains a device gate. |
| Email and voice | Confirm the real authorized Microsoft mailbox/sign-in route and required email contexts, plus actual CALLIE/Twilio/voice, invoice and reply paths. No provider was connected or contacted during this wave. |
| Migration and workday | Approved source samples/mappings, reconciliation and both companies' complete required-work acceptance remain open. Returning-customer source support is now present; do not keep reporting it as absent. |
| Commercial readiness | Honor the agreed $500 beta scope, verify GrowthOS subscription test/entitlements and support/setup effort, then measure a conservative inquiry-to-outcome chain. $1,500 flagship value remains to be demonstrated with client results. Contractor payment processing remains deferred. |

No hosted schema, account, live routing, notification recipients, customer data,
messages/calls, charges, deployment or public launch were changed. Continue via
the private reviewed candidate and the specific authorized acceptance gates.
