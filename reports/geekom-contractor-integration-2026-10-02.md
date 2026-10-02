# GEEKOM review and cumulative contractor-day integration

## Scope and preserved work

The owner requested retrieval, review and integration of WILLOWFORGE PR #11 at
`caec65a6f2ffa7821721e9ea97a31a4fafd4afc8`, including its earlier implementation
waves. The existing GEEKOM source `2c12ddc1f5c431fee1f3f99f5290b6566546cd13` is
a direct ancestor (ten commits behind the supplied branch). The Microsoft/mobile
work is included, not replaced. The original local recovery branch and unrelated
untracked workspace backup are preserved. No client website repositories are merged.

The intended cumulative integration covers PRs #1 and #6–#11. PR #4's separate
old brand branch is not part of this request. A merge commit must retain the
stack's original ancestry, and no branch needs to be force-pushed or deleted.
The integration PR records the exact repair commit, CI and eventual main merge.

## Assessment

This is meaningful progress toward a usable contractor workday: Today,
Customers & Jobs, Schedule, Invoices, and Warranties & Service form a much
clearer operating surface. Native estimates/jobs, invoice records, internal
cash reconciliation, staff coverage and agreed service recurrence belong in
the shared roofing/HVAC core. The evidence and tenant controls are substantial.

It is not yet a verified live Housecall Pro replacement. Issuing/printing an
invoice is not email delivery or payment processing. Staff-recorded cash is not
bank settlement. A service task is not a booked appointment, customer reminder
or warranty-coverage guarantee. Keep the agreed limited beta scope and collect
actual customer outcomes before selling the larger flagship promise.

## Independent review repairs

Three scoped reviewers reproduced failures before applying bounded fixes:

1. Invoice drafts now keep their original optimistic version with the actual
   edited document. Refresh cannot pair an old form with a newer version token.
   Unsaved fields survive a conflict; loading the latest document requires
   explicit discard/review. External issuance/voiding leaves the old form read-only.
2. Duplicate-lead merge refuses imported provenance or unresolved reply holds
   on either record with an actionable 409. It preserves both records and their
   original evidence instead of silently transferring outreach authority.
   Fresh company-scoped reads use the existing schedule/reply lock ordering.
3. Microsoft checks company lifecycle before preparation and immediately
   before dispatch. A pause during refresh/mailbox validation does not become
   a provider failure or credential revocation. A request already handed to
   Microsoft can still finish; this is not an atomic emergency stop.
4. Appointment status conflicts/lost acknowledgements require refreshed review,
   not repeated submission of an obsolete expectedUpdatedAt token.
5. Service history remains visible, with explicit version-checked review to
   reopen cancelled service. Reopening clears recurrence approval and does not
   book appointments or contact customers.
6. Active-service filtering runs before the 500-record limit. Bounded pages
   expose a lookahead header, stable due-date/ID order and honest partial counts.
   The legacy array body remains compatible; the OpenAPI/generated clients
   document optional status/offset and the result-limit header.
7. Customer-only schedule entries show the server's customer label, rather
   than indistinguishable generic visits.

## Verification boundaries

The original supplied commit had successful GitHub CI run `36966416273`.
That is baseline evidence, not proof for these repairs. Focused reviewer tests
reproduced and then passed the repaired cases. GEEKOM then passed all 458 UI
tests across 75 files, regenerated the additive API contract, passed workspace
typechecks and built both applications. The scripts suite passed 225 tests,
the shared API-client suite 13 and the reusable website adapter 26. These are
local checks, not independent-session database or hosted acceptance. Final full suites,
independent PostgreSQL concurrency, Docker parity and exact committed recovery
results belong in the integration PR's release evidence. After merging, dispatch
CI explicitly on main (there is no push trigger) and verify its exact SHA.

Synthetic recovery builds the reviewed 90-table base through deltas 0002–0006,
validates 103 tables, restores data and boots the actual app under a restricted
Reader. It is not a fresh Fly managed-backup restore or live provider proof.

## Fresh hosted inventory, October 2 at 18:50 UTC

A Reader-only transaction freshly confirmed the existing isolated staging
cluster/database and 95 tables. Only the two existing restore fixture companies
were present. Historical done/failed scheduler receipts were retained; no
reactivation campaigns or webhook deliveries were queued. The Reader had zero
writable application tables and no superuser/create-role/create-database/RLS-bypass
attributes. No database writes or provider calls were made by that inspection.

The single existing staging machine still ran the 77f6d63 image:
`sha256:bcde7c17a03643b711262ad9aeb073bec840a1f9f9654c8e6325cc8a5e78d0a3`.
Outbound sending, scheduler startup, push, automatic migration and staging
schema approval remain held; the recipient allowlist is empty. The newer
cumulative source must not be attributed to this old deployed image.

## Release gates that remain separate

October 2 follow-up: the temporary managed restore, 95-to-103 rehearsal and
restricted exact-image app inspection below now have fresh evidence in
`managed-contractor-recovery-2026-10-02.md`. This does not close the held original
staging rollout, provider, full native-workday or customer-activation gates.

- Review/rehearse the exact 95-to-103 additive SQL on an approved restored
  target. Verify fresh backup, lock budget, original-column row preservation,
  defaults, constraints, tenant guards and negative Reader/Writer privileges.
  The older one-time 90-to-95 release script must not be reused or repinned.
  Independent review counted eight new tables, fifteen existing-table columns,
  thirty FKs, seventeen CHECKs, twenty secondary indexes (ten unique) and eight
  PK indexes. No drop, type change or data backfill is present. Confirm the full
  catalog, not only table names. Once new workflows are used, an old-image
  rollback must stay stopped/maintenance or verified read-only; the old app
  lacks the new hold/billing/invoice/recurrence controls even with additive SQL.
- Apply only the reviewed schema to the isolated staging target, then deploy
  a green exact-source image with holds retained and verify hosted identity,
  normal-mode tenant isolation, scheduler restart/idle/failure and owned alerts.
- Complete fresh managed recovery with the intended app; a recent backup
  inventory and an older successful restore are different evidence.
- Azure is explicitly deferred: the owner reports a new account but has not
  completed first sign-in here. Confirm directory/app registration and test
  delegated Microsoft send/refresh/revocation using approved test identities.
- Complete allowlisted email receipts/failure paths, voice/SMS registration,
  consent/STOP/quiet-hour behavior, payment-provider tests, and iPhone Home
  Screen/push/manual-SMS acceptance. Do not contact the contractors as a test.
- Obtain each company's confirmed identities, operating configuration, approved
  source data/cutover, staff rehearsal, retention policy and customer-activation
  approval. Keep Painless and HVAC separate and preserve their beta agreement.

Source integration is authorized. Production release, wider billing, customer
activation, and lifting communication holds are not implied by merging this work.
