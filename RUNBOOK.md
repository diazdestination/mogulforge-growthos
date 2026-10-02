# GrowthOS operating entry points

Read `AGENTS.md`, `PROJECT_STATE.md` and `PAID-BETA-READINESS-P0.md` first.
Use an isolated branch, verify identity/target and preserve other agents' work.

- Product and scope: `GROWTHOS-CONTRACTOR-OPERATIONS.md` and `GROWTHOS-CONTRACTOR-PRODUCT.md`.
- Current candidate: `reports/native-contractor-day-integration.md` and specialist reports.
- Customer adoption/commercial acceptance: `BETA-CONTRACTOR-SUCCESS.md`.
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
databases. It upgrades the old90-table schema, checks current103-table/column
coverage, snapshots/restores both companies and boots the real app through the
production bundler under a SELECT-only role. It verifies tenant isolation, blocked
writes and unchanged fingerprints, issued snapshot hashes, retained cash allocation
reversals, invoice sequence and recurring service successors. The one reviewed
active synthetic successor is accepted only behind a restored company pause;
negative checks reject a removed pause, omitted exception or extra active record.
It accepts no target URL and cannot validate a
managed backup, live keys, hosting or production RPO/RTO. Historical hosted pilot
attestations remain frozen and cannot be relabelled as current-source acceptance.

Preserve indeterminate execution history. Do not replay an uncertain external
effect until reconciled with evidence. Roll back application code without
automatically dropping newly stored source history or entitlement audit records.
Provider, billing and customer activation require their own acceptance evidence.

Company pause is a recorded operating control, not an emergency atomic kill:
not-yet-claimed covered work remains queued; already handed-off work can complete
or require reconciliation. Resume requires reviewing the queue. Mid-preparation
playbook holds retain their step and require explicit enrollment review. Opt-outs,
stops, outcomes and provider receipts remain available. Platform identity/security
notifications remain independent. Offboarding requests preserve data and billing;
separately review expanded exports, deletion, retention and credential revocation.
