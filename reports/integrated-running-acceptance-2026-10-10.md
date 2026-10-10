# Integrated GrowthOS workday — acceptance

## Result and source

The latest contractor experience and verified local-development tooling are
consolidated in one isolated checkout. Merge fe43ba1076cf0c863f50310d3153814dd3dd8ebc
has exact parents PR30 baf2c3350ecf3a2260d7724f0dce8f9ea0057fdd and canonical main
d6be1e10c1229026ce65b76cc1e51bfa8eb96fc6. PR30 already includes PR28 and PR29.
Original worktrees and remote branches are preserved.

Only PROJECT_STATE.md conflicted. Both dated histories were retained and current
scope/status added. Independent review found no actionable integration defects:
PR30 application, UI, schema and release guards remain unchanged; every PR31
functional file matches main byte for byte. The source still has 142 tables and
review-only migration 0018. Unsafe forced schema/startup paths remain refused.

## Verification

- Frozen dependency install succeeded with lifecycle scripts disabled.
- Workspace types and both production builds passed.
- Frontend: 1,035 passed; scripts/recovery: 255 passed; library suites: 16 passed.
- Full PostgreSQL 16 API and website-adapter outcome is recorded in the final PR
  verification and C:\Forge\artifacts\growthos-integrated-running-20261010\acceptance-receipt.json.
  The local gate was still running when this report was prepared; the receipt
  records its actual exit/result rather than predicting a pass here.
- Docker parity passed: restricted schema ownership, preserved pg_stat_monitor,
  exact release identity, health/public routes, database outage and recovery.
  The owned application/database containers and network were removed.
- All 228 changed files relative to main passed the redacted secret scan.
- Signed-in native browser acceptance passed eight workflow checks and 17
  desktop/mobile layout measurements; no uncaught errors or unexpected failed
  responses. Real fixture corrections persisted after reload and were restored
  through a second audited save. See integrated-running-browser-2026-10-10.md.
  Smart Site claiming and evaluated recipient/device delivery remain outside
  this browser fixture; historical unknown coverage was exercised explicitly.
- Exact-head GitHub CI is required for the published candidate; use its live PR
  checks. This document does not pre-claim a future CI run or source merge.

Local raw logs are retained under the task workspace
C:\Users\diazd\Documents\Codex\2026-10-10\is-there-anything-we-can-do as
growthos-integrated-{setup,tests,build,parity,preview}.log. These are local test
evidence and are not provider or actual contractor acceptance.

## Try the product locally

The loopback preview at http://127.0.0.1:4193 contains fictional HVAC/roofing
visits, customer/property records, jobs, invoices, service work and lead history.
The owner fixture is runtime-qa@example.invalid / Local-QA-only-2026! (deliberate
public disposable test credentials). The signed-in Codex browser tab is retained.

Start a fresh preview after building with:

```powershell
node artifacts/api-server/scripts/preview-runtime-isolated.mjs --returning-customer --contractor-workday --customer-care
```

The runner excludes inherited provider credentials, binds loopback, disables
communications/scheduler/autostart migrations, and holds outbound effects. Its
in-memory records disappear when the process stops; never enter real client data.
The standard Codex Run action continues to start the smaller returning-customer
fixture. The richer preview above reuses existing fixture flags without changing
runtime source or account configuration.

## Next work toward the owner's complete system

1. Accept the consolidated source, then prepare a new exact-source release
   manifest and read-only staging observer. The current old observer lacks the
   full catalog, physical/default, role/privilege and data-fingerprint checks
   required by the reviewed held-staging procedure. Test its new implementation
   on disposable databases before any provider use.
2. Close structured warranty snapshots from recorded same-customer/property
   equipment through draft review, immutable invoice issue, print/email/export.
   Preserve historical issued documents and do not infer coverage dates.
3. Add explicit configurable service durations/travel capacity. CSS reported
   diagnostic 2h, maintenance 3h and about 1h travel; current defaults use 2h and
   conflicts consider service intervals only. These are editable policy inputs,
   not guarantees about every job or another contractor's defaults.
4. Finish required estimate follow-up, customer correction form and payment
   workflows against the October 9 CSS requirements. That intake supersedes
   older contractor-payment deferrals; provider choice, financial authority and
   actual costs/payouts remain unverified. Urgent automatic-booking fallback and
   quiet-hour/stop/escalation rules still require decisions.
5. Obtain source exports and actual invoice/report/warranty samples; preserve
   contacts, completed jobs, original values, media and open work through a
   reconciled migration. Existing normalized financial import is not a universal
   Housecall Pro importer.
6. Complete exact-source hosted recovery and held staging, real staff/device/
   mailbox/voice acceptance, both contractor workdays and controlled cutover.

Existing managed-backup metadata and the older local 95-to-142 rehearsal retain
their original source/evidence scope. Ordinary fly deploy must not bypass the
reviewed stopped/manual-start topology or schema safeguards. No hosted rollout,
provider activation, financial action or production readiness is established here.
