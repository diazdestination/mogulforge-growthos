# Original lead alert coverage — backend integration

October 9 UTC / October 8 Pacific, 2026. Adam requested continued progress while
GEEKOM works on UI. Frozen scope and ownership are in
[the contract](lead-alert-coverage-contract-2026-10-09.md).

## Source and product result

Branch `agent/growthos-alert-coverage-20261009` builds on private PR #28 at
`a0eb25dcc69291130a46a5478acf44f62d303e9f`, whose full CI 37885607739 passed.
Canonical main was freshly verified at 2162aa2. Integrate PR #28 before this
dependent candidate. This report does not claim that either branch is deployed.

Previously, a selected recipient with no usable device/session could leave no
alert receipt. The backend now saves every selected person and their original
admission outcome, including unavailable staff, no eligible device and elapsed
alert windows. Missing or disabled routing is also recorded. This is shared
core behavior for fresh CRM/capture/Smart Site/missed-call lead transactions,
not a one-off Painless configuration or invented recipient activation.

Admission locks the canonical lead; a saved snapshot prevents additional effects
even after policy/device changes. Legacy receipts without a snapshot remain an
unknown original cohort. Reads never evaluate routing or enqueue alerts. Existing
worker holds, final authority checks, expiry, indeterminate no-replay and separate
service alerts remain unchanged.

The exact owner/admin API validates current accepted member/session authority,
uses tenant scope and bounded database waits, rejects API keys and unexpected
request inputs, and returns no-store evidence. All recipient entries are shown
in the API; current receipt counts are separate from immutable admission.
Deleted receipts remain unavailable and provider acceptance is not phone display
or human reading. The response excludes device/session/customer content, raw
errors, effect IDs and policy fingerprints. Stored evidence is strictly validated
before projection; corrupt JSON yields a fixed unavailable response.

No Command Center page/component/style/navigation edits are part of this wave.
Generated client types and [the UI integration handoff](lead-alert-coverage-ui-handoff-2026-10-09.md)
are ready for GEEKOM's separate design work. The visible UI gap remains open until
that integration is implemented and accepted.

## Schema, export and recovery

- One additive `staff_lead_alert_coverage` table: 141→142. The offline preview
  pins the PR #28 base and verifies All 141 old table definitions unchanged.
- Review-only `0018_lead-alert-coverage.sql` follows 0017. It creates the table
  and two tenant/organization FKs, without historical DML, backfill or old-column
  changes. It was not applied to a hosted database.
- Version/status/hash/array-size checks and composite company/lead primary/FK
  constraints are enforced. Inner JSON validation also rejects duplicate IDs,
  malformed outcomes/receipt references and unexpected fields. Original effect
  references have no device/member FK so deletion cannot erase the snapshot.
- Full data inventory classifies the table as company-owned communications.
  The core customer-business export explicitly excludes staff alert evidence,
  original effect IDs and policy fingerprints. Full backups preserve them.
- The synthetic full-chain upgrade/restore now reaches 142 tables, keeps all
  prior rows unchanged at the new migration, restores both companies' populated
  snapshots, missing-effect references and legacy no-snapshot history, and checks
  twelve failing SQL constraint mutations under rollback.
- Existing 91 SELECT-only application probes still pass. New coverage restoration
  is fixture/fingerprint proof plus separate normal HTTP tests; those restored
  application probes do not exercise the row-locking new endpoint.

## Verified local evidence

| Check | Result |
| --- | --- |
| New admission/read service + existing worker/service/policy tests |120 passed; 9 PostgreSQL-only cases require full CI |
| Exact coverage HTTP + route permission inventory |32 passed (25 HTTP + 7 inventory), no skips |
| Data inventory service/HTTP and core-export privacy |65 passed, no skips |
| Full synthetic contractor recovery test |Passed; 142 tables, 12 new constraint negatives, 91 existing app reads |
| Offline additive schema comparison |Passed; 141 old definitions unchanged, no database opened |
| API/library typing and generated OpenAPI/client contract |Passed during lane verification |
| Independent runtime/route/schema/recovery/export review |Accepted after the bounded-read repair |

Runtime PostgreSQL-only checks must execute in final CI: concurrent admission;
member/session changes across read and admission lock waits; session expiry across
both saved/missing snapshot reads; bounded lock timeout with released locks; and
injected coverage-write failure rolling lead/effects back together. PGlite cannot
establish those real concurrent PostgreSQL behaviors.

The final exact source CI and external Forge receipt record workspace type checks,
both production builds, Docker parity, changed-file secret scan and final SHA.
This report intentionally does not pre-claim a future CI result or create a
self-referential commit identity. Browser testing is deferred to the separate UI
integration because this wave contains no UI component or interaction changes.

## Remaining production work

1. Integrate reviewed PR #28 and this dependent backend wave through GitHub.
2. Connect the typed coverage read to GEEKOM's UI and verify partial/unknown/error
   evidence without an automatic resend or misleading delivered/read badge.
3. Prepare a current target/source/image/SQL/backup/restore rollout procedure.
   The retired forced-schema release and AUTO_MIGRATE paths remain blocked;
   this wave does not introduce a generic hosted migration executor.
4. Accept the real selected owners' installed phones, background/locked/offline
   behavior, after-hours routing and one-claim result. Actual mail/voice, approved
   source migration, subscription allowances and both contractor workdays remain.

No merge, deployment, hosted/schema/provider/account change, real notification,
customer data import, spending or public launch occurred in this engineering wave.
