# Current delivery decisions

## Native contractor workday continuation - October 1

Adam explicitly authorized completing the next wave after the verified
contractor-operations foundation. Reused its isolated worktree and started
`agent/growthos-native-contractor-day` at
`48c3491c75ea31abf347deee59f8faf17d63136a` (draft PR10). Three scoped agents own
invoices, scheduling/service, and daily experience, with independent cross-review.

Use one native daily workspace, immutable issued invoices and existing cash
records, shared scheduling locks, explicitly agreed service recurrence and
reversible operational controls. Invoice issue does not imply delivery; recorded
payments do not imply a charge or bank verification. Migration0006 is additive
and review-only. Keep the $500 beta agreements; $1,500 is a value hypothesis.
`BETA-CONTRACTOR-SUCCESS.md` defines the adoption and commercial evidence needed.
No new orchestrator, provider activation, paid action or public launch is implied.

## Contractor operations clarification - October 1

Adam accepted the autonomous next wave and clarified the goal is to replace
Housecall Pro. Reported pain is navigation, organization and dependability;
named tasks are scheduling, invoices and warranty tracking. Treat source
integration as optional migration/transition support and build native daily
workflows. Record missing invoice/payment and field-operation acceptance
explicitly. See `GROWTHOS-CONTRACTOR-OPERATIONS.md`. Current reliability repairs
remain first; no source-account cancellation, data cutover or live activation
is inferred. Honor the limited $500 beta agreements.

October 1, 2026, based on Adam's contractor scope and explicit swarm request.

- Preserve one shared platform with configurable trades and existing websites.
- Honor the limited $500 beta agreement; validate premium value from actual
  recovered opportunities and operating effort before promising a $1,500 return.
- Keep the current modular platform and durable execution kernel. Add bounded
  controls to existing paths; no new orchestrator is required for this wave.
- Treat CSV imports as historical evidence. Keep unknowns null and hold
  automated outreach until current source verification is supported.
- Make entitlement assignment explicit and audited. Null legacy policy does
  not silently enroll or downgrade a customer. Scope currently gates one BIE
  capability; it is not the complete package catalog.
- Prefer an explicit compatibility hold over cross-company private-file access.
  Legacy external object storage requires a trusted ownership contract.
- Specialist workers implement separate areas and cross-review one another;
  the coordinator owns shared integration, commits and release evidence.

These decisions do not approve charging, contacting customers or deployment.

## Private beta operations wave

- Persist immutable checkout terms and provider keys before requests. Recover
  known provider records; hold unknown effects before the provider retry window
  expires. A canceled subscription needs explicit operator replacement approval.
- Offer a clearly bounded core-record JSON export with coverage, checksum and
  exclusions. Offboarding is a reviewed request; it never silently deletes data
  or cancels payment/provider contracts.
- Apply company holds at covered public intake and final outbound boundaries.
  Preserve stop signals, outcome history, opt-outs and signed provider receipts.
- Use the same credentialed server-side contract for existing sites and Smart
  Sites. The reference Node adapter stores an encrypted delivery journal on a
  persistent volume. Confirmed CRM receipt is required to claim saved delivery.
- Rehearse the two named beta companies privately with synthetic data. A rehearsal
  suffix, invented test identity or recorded synthetic value is never activation,
  real customer revenue, proven conversion improvement or market validation.
# Local development tooling — October 10 UTC

Use repository-scoped Codex environment actions and frozen pnpm 11.3.0 installs.
Keep the fictional in-memory visual preview separate from real PostgreSQL
concurrency checks. PostgreSQL tests own a fresh loopback-only Docker container;
schema changes and cleanup require its exact run label. Exclude inherited
provider, database and Docker-target variables from all local actions. WILLOWFORGE
uses Docker Engine in WSL; existing production, release and main-branch gates
remain separate.
