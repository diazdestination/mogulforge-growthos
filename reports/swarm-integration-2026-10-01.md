# GrowthOS swarm foundation — integrated candidate

October 1, 2026, WILLOWFORGE. Three specialist workers and one coordinator worked
in the same isolated branch with disjoint ownership and cross-review. The scope
and next waves are in `GROWTHOS-SWARM-PLAN.md`. This is the first engineering wave
toward the limited $500 founding beta and a $1,500 flagship; it does not declare
the entire platform ready or change either customer's commercial agreement.

## Integrated result

- Historical imports preserve explicit opportunity identity, original dates,
  source updates/contact dates, known USD amounts and ingestion provenance.
  Same-customer repeat jobs remain distinct. Stale, ambiguous, truncated or
  locally edited records cannot silently overwrite the current CRM. Unknown
  history stays unknown. Original and latest attribution remain distinct.
- The Revenue Desk uses known original history for age and the latest actual
  customer contact for inactivity. Undated legacy imports are excluded from
  age-based recovery claims. Opportunity value is not recovered revenue.
- The central send gate holds imported opportunities from automated outreach;
  automation, playbooks and BIE carry their source opportunity ID to that gate.
  Synthetic email/SMS attempts record the hold without contacting a provider.
  Held imports are skipped before campaign enrollment or status changes; existing
  source-held sequences pause without consuming a touch. A separate new inquiry
  for the same customer remains eligible for its own checks. Requested-service
  transactional controls retain their existing rules.
- One real commercial capability, `revenue.autopilot`, now has server-side
  entitlement enforcement. Explicit beta assignments exclude it unless an
  audited grant allows it; Growth/Scale include it. Legacy organizations require
  explicit scope review before migration. Downgrade preserves approved queue
  work; execution rechecks capability and actor membership before effects.
- Stripe webhook reconciliation validates identity, current subscription state,
  known price mapping, signature and duplicates under bounded locks/timeouts.
  Bound subscriptions cannot start a second checkout, including after canceling.
  Actual prices, purchases and live billing have not been configured or tested.
- Normal-mode tenant tests reproduced and then closed a private-photo disclosure
  through forged activity references. Postgres object reads require authoritative
  organization ownership, including old malformed links and portal downloads.
  Legacy GCS/Replit tenant reads stay closed pending trusted ownership support.
- Import and billing screens explain current scope, unknown source freshness and
  review conflicts. Mobile controls, long filenames and contrast were checked
  in a real browser using synthetic API fixtures.

## Review and verification

Cross-review found and repaired shared-phone identity confusion, inverse customer
identity disagreement, truncated-row data loss, stale latest-source attribution,
and checkout of an already bound subscription. The coordinator inspected the
private-photo fix and integrated source/entitlement checks. The QA worker
independently reviewed billing, the additive schema delta and shared guards.

Local evidence (do not sum overlapping selections):

| Check | Evidence |
| --- | --- |
| Import/date/amount/identity | 26 isolated API tests; 4 importer UI tests; campaign hold preserves status and creates no enrollment/scheduled step |
| Entitlements and billing | 40 isolated API tests in 5 files; 4 billing UI tests |
| Shared automation/source integration | 43 isolated API tests in 5 files; includes preclaim hold, raced revocation, source age, provider-not-called assertions |
| Final combined source/automation/migration check | 45 tests in 7 files passed after final hold repairs; includes 8 playbook hold cases and the representative upgrade |
| Normal-mode two-company HTTP matrix | 15 cases passed; exact canary bytes, real local sessions/API keys, own positive controls and foreign read/write/effect denials |
| Representative schema upgrade | Reviewed additive SQL applied inside a disposable transaction; existing rows/history/value retained, same-company duplicates rejected, different-company IDs allowed |
| Browser | Import and billing at 1440, 390, 320 light and 390 dark: 8 cases, no horizontal overflow, page errors or scoped axe violations; no live mutation |
| Workspace | Typechecks, complete 375-test UI suite in 65 files and both production builds passed locally; final CI totals/status recorded with the candidate PR |

The local PGlite runner cannot prove independent PostgreSQL session/advisory-lock
behavior. Expanded local selections timed out on existing concurrent BIE/default
automation seeding and the assessment-photo-flow default-org path. Those runs
are not recorded as passes. Their tests and production locking were preserved;
the complete real-PostgreSQL CI suite is the required arbiter. A later dedicated
source-send test avoided unrelated lead-created enrollment seeding and passed
through the real lead-updated automation rule path.

Full CI must pass on the exact pushed head, including all test suites, types,
both builds and Docker staging parity. The candidate PR records the run URL/SHA
and result; an earlier branch's green CI is not this candidate's acceptance.
The coordinator also scans changed files for secrets before committing.

Browser evidence is local at
`C:\Forge\workspace\growthos-swarm-2026-10-01\results.json` with screenshots.
No browser recording, trace, customer identity or real provider send was used.

## Schema and release boundary

`staging-schema-preview-2026-10-01/0003_swarm-foundation.sql` is a review-only
delta from base `58ab300`: eight additive columns and one unique index. No
historical dates, entitlement choices or prices are backfilled. New counters
default to zero. The representative upgrade test is not a full hosted restore.
Before an approved deployment, inspect the actual target delta, backup/restore
evidence, table size and index lock budget; preserve the existing staging schema
approval and outbound-hold gates. Application rollback can retain these additive
columns; do not drop newly stored history as an automatic rollback action.

## Remaining product/release work

1. Rehearse both beta companies from their actual website through owned response,
   appointment/estimate and recorded outcome. Establish starting volume and
   conversion metrics before making ROI or $1,500-value claims.
2. Confirm Housecall Pro identity/plan/access and representative data. A reliable
   live connector and current-source verification still need implementation and
   acceptance; imported history remains analysis/staff-task material meanwhile.
3. Complete approved live email/SMS/provider failure/receipt tests. GEEKOM's
   Microsoft/Azure lane was preserved; no remote coordination is inferred.
4. Finish lifecycle/offboarding, hosted normal-mode tenant acceptance, scheduler
   and alert operations for the exact release candidate. Resolve the legacy
   GCS/Replit ownership compatibility gate for any customer using that adapter.
5. Complete the agreed tier inventory, quotas/usage margins and add-on enforcement.
   This candidate gates only approved-work BIE autopilot, not every automation.
6. Before live charging, implement persisted/idempotent initial checkout attempts
   and safe subscription replacement/reconciliation, then test with approved
   Stripe test-mode identities. An unbound retry may still create more than one
   session; bound-subscription protection does not complete that lifecycle.

Detailed evidence: `swarm-opportunity-history-2026-10-01.md`,
`swarm-subscription-controls-2026-10-01.md`,
`normal-mode-tenant-acceptance-2026-10-01.md` and
`swarm-release-audit-2026-10-01.md` in this directory. No merge, deployment,
public launch, customer outreach or subscription action is implied.
