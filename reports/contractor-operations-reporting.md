# Contractor operations: truthful owner reporting

Date: October 1, 2026 (local). Candidate branch: `agent/growthos-contractor-operations`.

## Delivered

The existing Reports surface is now an Owner report with a default trailing
30-day period, equal-length previous-period comparison, record links and visible
coverage gaps. It does not claim a local calendar month, causal revenue lift,
profit, or a verified accounting feed. No pricing, entitlement or agreed $500
beta terms changed.

### Definitions and boundaries

| Measure | Definition |
| --- | --- |
| Opportunity cohort | Original creation date in the half-open UTC period. Native rows use `createdAt`; imported rows use validated `importedHistory.originalCreatedAt`. Missing imported dates remain unknown and are excluded. |
| Cohort booking rate | Distinct cohort opportunities with a lead-linked booking created in the same period, divided by cohort opportunities. Duplicate appointments never increase the numerator. |
| Bookings recorded | Lead-linked appointment records created in the period, across all creation cohorts. Canceled records are excluded using current status. These are not appointments scheduled to occur in the period or completed jobs. |
| First logged outreach | Median first recorded automated playbook touch for measured native cohort opportunities. Imported historical first-contact coverage remains unknown and is excluded. Human contact is not inferred. |
| Reply rate | Distinct opportunities contacted by a playbook in the period with a timestamped reply after sending and before period end. |
| Playbook event records | Sent messages and distinct opportunities with each outcome timestamp in the period. Booking signals also require a matching tenant-valid, non-canceled booking created in the period. Rows/columns are not an additive funnel. |
| Recorded wins/value | `wonAt` events across all cohorts. Known values form a labeled subtotal; all-unknown values remain null; known zero stays zero. Missing-value counts accompany totals and attribution. |
| Pipeline/losses | Pipeline is an explicitly current all-time open snapshot. Losses are current statuses within the creation cohort; `updatedAt` is never treated as the loss timestamp. |
| Value ledger | Optional exact report range uses financial `occurredAt`, estimate `acceptedAt`, and project `completedAt`. Undated acceptance/completion records are excluded with explicit counts. Revenue Desk retains its all-time default. |
| Comparison | Previous equal-length UTC period for booking creation, wins and known recorded win value, with its own missing-value count. No unsupported percentage uplift or fee-ROI calculation. |

Report reads use a read-only repeatable-read database transaction so numerator,
denominator, totals and evidence come from one snapshot. Linked bookings,
playbooks, enrollments, campaigns and financial records validate the tenant of
their related rows. Latest 20 win records link to existing customer evidence;
the ledger retains its existing latest-200-entry display limit.

`days` must be a whole number from 1 through 365. Optional `endAt` anchors report
and CSV requests. The ledger accepts paired `startAt`/`endAt`, no future end or
range longer than 365 days. Report, CSV and financial reads require membership
and `crm.read`; query-based organization overrides fail validation. Responses
are `no-store`. CSV text neutralizes spreadsheet formula prefixes, including
whitespace/control-prefixed formulas, and quotes carriage returns/newlines.

The UI passes the report's exact range to the ledger and anchors export to the
displayed period end. Report, export and ledger errors remain visible and have
retry paths. Missing financial evidence is not shown as verified zero value.

## Verification

The first four regression tests failed against the original implementation:
five imported/local rows counted instead of two original-date opportunities;
three wins counted instead of one bounded event; all-time receipts of 7,500
cents shown instead of period receipts of 500; and active CSV formula labels.

| Check | Result |
| --- | --- |
| Isolated service + HTTP reporting regressions | 14 passed: dates/bounds, duplicate/canceled bookings, linked-tenant rejection, source history, first-contact coverage, independent outcome timestamps, real campaign events, unknown/zero amounts, query validation, membership, export and formulas |
| Existing post-sale + won-revenue correction regressions | 27 passed |
| Owner report + existing Revenue Desk UI tests | 22 passed |
| API and command-center TypeScript checks | Passed after generated contracts synchronized |
| Impeccable scoped detector | No findings |
| Real Chrome actual-component inspection | 1440, 390 and 320 pixels, each light and dark: no page overflow or WCAG A/AA axe violations after repairs |
| Browser recovery | Synthetic report and ledger 503 errors both recovered through retry; only the two intentionally failed requests produced console resource errors |

The browser pass included long unbroken evidence/reference strings and large
amounts. Repairs improved inactive date-button contrast, made horizontal tables
keyboard reachable, and wrapped long financial references. Screenshots and
results are under `C:\Forge\logs\owner-report-qa-2026-10-01`. The temporary entry
and loopback Vite process were removed/stopped after inspection. No external
browser requests, recordings, traces or video were used.

One earlier combined three-suite PGlite run exhausted the disposable socket's
connection capacity on the third suite. Fresh scoped runs passed; this was not
treated as product or PostgreSQL concurrency proof. One UI rerun overlapped
shared code generation and could not resolve the temporarily absent generated
schema; the rerun after generation completed passed all 22 tests.

## Practical limits and remaining acceptance

- All verification used synthetic local fixtures. No provider, live tenant,
  production deployment or real financial action was performed.
- Prior periods are recalculated from current evidence. Amount corrections,
  later cancellations and updated attribution may revise them. This is not an
  immutable historical snapshot or full accounting statement.
- Backfilled data with no original dates, missing job costs and incomplete
  communication coverage cannot prove ROI. The report now exposes those gaps;
  it cannot establish a $1,500/month willingness to pay without real owner data.
- Real tenant reconciliation, hosted PostgreSQL release checks and representative
  data-volume performance remain part of deployment acceptance.
- Browser checks used the actual report/ledger components with synthetic API
  responses; they do not substitute for deployed authentication/provider tests.

## Main files

- API: `services/roi-report.ts`, new `services/reporting-period.ts`, source date
  SQL helper in `services/source-history.ts`, `routes/v1/reports.ts`.
- Bounded shared edits: `valueLedger` in `services/revenue-workspace.ts`, its GET
  route in `routes/v1/revenue-workspace.ts`, and `ValueLedger` component/types.
- UI: `pages/reports.tsx`, new `pages/reports.test.tsx`.
- API tests: new `services/reporting-periods.test.ts` and
  `routes/v1/reporting-periods.test.ts`.
- Parent coordinated the OpenAPI contract and generated API clients.

## CI integration follow-up

CI run `36960497654` on `869e2df` exposed two older test contracts that no
longer matched reporting behavior. The repair changes tests only:

- Normal-mode NM-03 now explicitly requires HTTP 400 for a query-based
  organization override on both JSON and CSV endpoints. It then verifies a
  successful canonical JSON report and CSV for the same exact period, with
  only the signed-in company's source data even when forged tenant headers
  are supplied. The existing foreign-record and unchanged-company snapshot
  assertions remain in place.
- The financial-event test now checks the current explicit boundaries: no
  bank/accounting synchronization or causal ROI, and no profit claim without
  the missing costs, tax and overhead. Product copy and service logic are
  unchanged.

Verification after the repair:

- `test-tenant-acceptance-isolated.mjs`: all 15 normal-mode tenant tests passed.
- Reporting service and HTTP suites: all 14 tests passed.
- Existing Revenue Workspace suite: 10 of 11 passed, including the repaired
  financial-event assertion. Its five-simultaneous-BIE-executions case hit the
  known PGlite multi-session socket limitation (`08P01`, bind parameter count
  mismatch), both in the combined run and one fresh scoped rerun. That case
  passed the original real-PostgreSQL CI run; its implementation and concurrency
  assertions were preserved for the parent's full PostgreSQL rerun.
- API TypeScript check and scoped whitespace check passed.

These are synthetic local checks. No provider calls, production changes,
commits or pushes were made in this repair lane.

### Second CI: accessibility fixture contract

CI run `36961422539` on `cd54dd4` passed the complete API suite: 184 files
passed, 3 skipped; 1,744 tests passed, 15 skipped. The frontend failed one
Reports accessibility case and reported its unhandled `period.startAt` error.
The local focused run reproduced both failures before the repair.

Only `accessible-names.test.tsx` changed for this repair. Its Reports fixture
now satisfies the generated `RoiReport` type, includes exact current and prior
periods plus coverage/evidence fields, and supplies a complete empty value
ledger for that period. The test waits for both report evidence and ledger
content before checking every interactive control's accessible name. Existing
control assertions remain intact; no errors are suppressed and no runtime
components changed.

After the repair, all 17 focused accessibility tests passed, followed by all
403 Command Center tests across 68 files with no unhandled errors. The full
Command Center TypeScript check and scoped whitespace check passed. This lane
is frozen for the parent's integrated release checks; no provider calls,
commits or pushes were made.
