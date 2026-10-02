# GrowthOS operating entry points

Read `AGENTS.md`, `PROJECT_STATE.md` and `PAID-BETA-READINESS-P0.md` first.
Use an isolated branch, verify identity/target and preserve other agents' work.

- Product and scope: `GROWTHOS-CONTRACTOR-PRODUCT.md`.
- Current candidate: `reports/swarm-integration-2026-10-01.md` and specialist reports.
- Pilot operations: `PILOT-OPERATOR-RUNBOOK.md`; scheduler: `SCHEDULER-OPERATIONS.md`.
- Additive schema preview: `reports/staging-schema-preview-2026-10-01/0003_swarm-foundation.sql`.
  Preview only; do not bypass `scripts/release-schema.mjs` staging approval/hold.
- Source import limits: `reports/swarm-opportunity-history-2026-10-01.md`.
- Scope assignment/billing limits: `reports/swarm-subscription-controls-2026-10-01.md`.
- Tenant/photo matrix: `reports/normal-mode-tenant-acceptance-2026-10-01.md`.

Local verification uses disposable synthetic databases. The guarded isolated
runner is `artifacts/api-server/scripts/test-scheduler-isolated.mjs`; the normal
tenant matrix wrapper is `test-tenant-acceptance-isolated.mjs` alongside it.
Real PostgreSQL full CI remains required for multi-session lock/concurrency
acceptance. No provider credentials or production data belong in test fixtures.

Preserve indeterminate execution history. Do not replay an uncertain external
effect until reconciled with evidence. Roll back application code without
automatically dropping newly stored source history or entitlement audit records.
Provider, billing and customer activation require their own acceptance evidence.
