# Native contractor workday integration

October 1, 2026. Owner-authorized continuation after verified contractor PR10 at
`48c3491c75ea31abf347deee59f8faf17d63136a`. Candidate branch:
`agent/growthos-native-contractor-day`, stacked on `agent/growthos-contractor-operations`.
GitHub main remains the eventual canonical target. This is private engineering;
no production activation, provider sending, charge, migration or account cutover.

## Delivered scope

- Five daily navigation destinations with shared role-aware desktop/mobile/search
  definitions; Subscription is distinct from contractor Invoices.
- A consistent read-only Today snapshot in the scheduling timezone, explicit UTC
  fallback, exact bounded counts, retained overdue/undated tasks and direct owned
  task lookup beyond the recent-task display limit. No fabricated zero metrics.
- Native invoice drafts, immutable numbered issue, void reasons, print-ready
  customer documents, atomic receipt recording, allocation of existing receipts,
  append-only allocation corrections and visible refund reconciliation.
- Accepted operational staff, common appointment/project resource exclusion,
  valid time windows and customer/estimate/property relationships, optimistic
  edit tokens, bounded date/assignee filtering and corrected local-time forms.
- Job completion hands off to exactly one invoice-preparation task. Invoice
  creation closes it transactionally; reopened/cancelled/deleted jobs reconcile
  it. Retained invoices block destructive related deletion and silent reparenting.
- Explicit service agreement recurrence, coverage evidence, calendar-month
  anchoring, one successor/task and no invented booking or warranty promise.
  Cancelled/no-show appointments preserve actionable service follow-up.
- Reminder revalidation and scheduling-before-reply lock order. Already claimed
  or uncertain effects retain their receipt and staff review instead of replay.
- Eighteen allowlisted customer-export datasets, including service chains,
  issued snapshots and cash references; source invoice hashes verified before
  projection, with a separate digest for the exported allowlisted document.
- Additive schema0006,103 classified tables, full synthetic upgrade/restore,
  financial/service fixture preservation and12 restricted real-app read checks.

Contracts and lane details: `native-contractor-day-contract.md`,
`native-contractor-invoices.md`, and the scheduling/experience reports beside
this file. `BETA-CONTRACTOR-SUCCESS.md` defines the repeatable staff rehearsal,
baseline, cost/adoption measurements and renewal decision.

## Independent review and repairs

Three specialists used explicit file ownership and cross-reviewed one another.
Integration review repaired a non-project invoice creation/lead-merge race,
stale invoice prompts on job transitions/deletion, historical inactive staff
blocking terminal updates, service/property mismatches, company-timezone reminder
text, midnight legacy appointment overlap, inaccessible controls/contrast,
bounded-list task links, and stored-versus-exported invoice digest semantics.

Financial data uses one canonical cash ledger. Allocations are references to that
cash, not new revenue. A correction is not a refund. USD and explicitly entered
tax are the current scope. Data corruption or uncertain refund allocation fails
closed; operators see review states instead of invented balances or success.

## Verification and reproducible gates

Targeted real-route/service tests cover tenancy, role/session/origin boundaries,
immutable retry payloads, invoice arithmetic/rollback, record retention, overdue
and DST boundaries, service recurrence, scheduling conflicts and handoffs. Local
tests use disposable PGlite; independent PostgreSQL sessions are required for the
new concurrency cases in CI. No production/provider credentials are loaded.

UI checks cover denied roles, errors, stale versions, lost acknowledgements,
explicit retry/confirmation, print, refund review, and exact task lookup. Browser
acceptance exercises synthetic states at desktop,390px,320px and dark mode.
Automated axe results are scoped evidence, not universal accessibility assurance.

The synthetic recovery drill applies0002–0006 to the reviewed90-table base,
checks all103 table/column shapes, compares complete source/restored fingerprints,
verifies immutable invoice hashes/sequence, cash reversals and recurring service
successors, then boots the real bundled app using a SELECT-only database role.
It rejects HTTP/database writes, cross-company reads, a removed company pause,
an omitted service exception and another active obligation. No target URL or
real provider is accepted by the drill.

Historical c050067 attestation remains immutable. Its now-evolved restore fixture
is preserved as exact hash-checked test data; current source is never relabelled
as historical hosted proof. A local broad test attempt overlapping code generation
failed on transient removed modules; final tests run after generation completes.

Release gates: clean workspace types; full frontend/scripts/API/library suites;
real PostgreSQL concurrency; both production builds; Docker health/readiness and
database-failure/recovery; scoped redacted secret scan; final committed synthetic
recovery. The authoritative exact commit, counts and CI run are recorded on the
draft PR and in `C:\Forge\GROWTHOS_NATIVE_CONTRACTOR_DAY_2026-10-01.md` and its
external release manifest. This avoids embedding a self-referential commit hash.

## Acceptance still required

The two companies have not been activated or observed using this release.
Honor their limited $500 beta agreement. The $1,500 flagship and larger business
remain value hypotheses pending adoption, measured outcomes and support economics.

Before replacing Housecall Pro: approve/reconcile migration and opening balances,
confirm actual business/staff/timezone/website/provider configuration, accept
invoice delivery/payment collection and live communication failure/retry paths,
prove managed backup recovery and complete the hosted tenant/photo matrix.
The broader tier catalog is not fully enforced by the existing single BIE
entitlement. Do not promise premium gating or unlimited use based on this wave.

GEEKOM retains Microsoft/Azure provider work. Local Bridge records do not prove
cross-machine synchronization. Production, financial and customer-contact
approval boundaries remain separate; this candidate supplies inspectable work.
