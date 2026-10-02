# Managed recovery and contractor replacement gates — October 2, 2026

## Scope and release identity

The owner approved one temporary billable managed-backup restore test and its
cleanup, while preserving the original staging and production databases. This
does not authorize a production release, customer activation or contact, payment
collection, an ongoing third database, or cancellation of either old subscription.

The tested runtime is integrated main
`47aca5beeb06e665bddfff23545640d779de51cc`. Exact-main
[CI 37052487433](https://github.com/diazdestination/mogulforge-growthos/actions/runs/37052487433)
passed 2,600 tests with 15 existing API skips, typechecks, both builds and Docker
parity. The frozen recovery image ends in
`sha256:294b35e07b0992ffca4be8269f22f4d40d0da23587d08ac7728ad3be6b178a64`.
It was built and pushed without replacing either regular application machine.
Later documentation commits do not change this runtime identity.

## Fresh managed database evidence

All timestamps below are UTC. This exercise used the existing synthetic staging
fixtures, not a copy of a contractor's production account.

1. At 20:06:24, the Reader captured all 95 source tables using explicit original
   columns, including private file bytes. Managed full backup
   `20261002-200726F` ran 20:07:26–20:07:31. A source recheck at 20:08:19 matched.
2. The approved separate restore was requested at 20:08:25. At 20:10:57, all 95
   restored-table fingerprints matched the source. The full-source digest is
   `a7508ff19fdd575b3cd6be673f9158746f2aa21dfad89e89a89d52de89856223`.
3. A separate canonical JSONB source contract was captured at 20:10:10, **after**
   the backup. The independent before/after-source and restored comparisons prove
   unchanged original data; the contract capture must not be called pre-backup.
4. The reviewed, hash-pinned 0003–0006 transaction committed at 20:22:51 on the
   temporary restored copy only. The full 103-table catalog matched; all original
   rows/columns and private bytes were preserved; 15 new legacy-column defaults
   were correct; all eight new tables were empty. Reader and Writer effective
   permissions, including negative/elevated-role checks, passed on all 103 tables.
5. A separate Reader connection repeated upgrade verification at 20:23:40.
   The one-use rehearsal's 37 local regressions also passed, including unsafe
   targets, altered rows/files/defaults/catalog/ACLs and uncertain COMMIT handling.

No schema, row, role or grant changes were made to the original databases. The
test operator subsequently inserted short-lived synthetic sessions into the
restored copy only. These are deliberate test setup, not original-source rows;
do not claim the clone remains byte-identical after that setup.

## Application recovery and cleanup

At **21:07:23 UTC**, the exact-image restricted application check passed in a
temporary console with no public services. Its actual production API entrypoint
booted in managed restore mode using the restored Reader and a fresh allowlisted
child environment. The console's immutable image identity was independently
verified before execution.

- All **37 HTTP assertions** passed: authenticated graph and private-file reads,
  Today/invoices/services/lifecycle/reply surfaces, six foreign-company denials
  and thirteen blocked write/auth-change requests.
- All **103 table fingerprints stayed unchanged** during application inspection.
  Reader SELECT and negative write privileges were checked across the full schema.
- The actual encryption codec decrypted the synthetic stored credential and
  rejected both the wrong key and wrong tenant/user context.
- All four measured provider-network categories remained **zero**. The app child
  stopped normally; the test console and its three temporary secret references
  were removed. Original app secret metadata remained unchanged.
- The private harness/profile regression suites passed **37 tests** locally,
  independently repeated by the coordinator; the schema suite separately passed 37.

A strict certificate-verified TLS comparison on the canonical restored pooler
confirmed that TLS-only Reader connections succeed, while the startup
`default_transaction_read_only` option is rejected with PostgreSQL `08P01`.
The harness now rejects startup-option URLs; the Reader's negative write ACLs,
explicit read-only inspection transactions, application restore mode and
provider-network blocks remain mandatory. No encryption fallback is used.

The restored source intentionally retains the earlier synthetic crash experiment:
one failed action with an indeterminate receipt and one successful companion.
See [the historical evidence](controlled-pilot-2026-09-30.md). These records must
not be deleted, replayed or relabeled successful to satisfy a zero-uncertainty
fixture assumption. The reviewed private profile verified all 38 original fixture
rows and the exact retained graph: one historical indeterminate receipt, zero
unreviewed uncertainty, and zero other unsafe categories. No historical row was
changed. Preserving that history is not a fresh rerun of the crash experiment.

The legacy `fly mpg status --json` output is credential-bearing and its nullable
attachment field is not sufficient dependency evidence. The cleanup boundary
uses the public Machines API's explicit `attached_apps` array instead; missing,
null or nonempty arrays fail closed. This follows the
[official public cluster projection](https://github.com/superfly/fly-go/blob/main/flaps/flaps_managed_postgres.go)
and the installed CLI's
[legacy status implementation](https://github.com/superfly/flyctl/blob/95b7f3e777a4c685599b6b75cfcfc0d8cbbd9fd9/internal/command/mpg/v2/run_status.go).
Four local identity/dependency tests cover this boundary.

**Cleanup passed at 21:09:46 UTC.** The one temporary restore cluster was deleted
after exact identity/dependency checks, absence of all eight test consoles and
temporary secrets, and a fresh source comparison. Inventory independently
confirmed its absence and unchanged identity/status/plan for both originals.
The managed source backup is retained. A post-deletion Reader snapshot again
matched all 95 original source tables and file bytes. The test-only copy is gone;
the original data and retained backup remain available. No ongoing third cluster
was introduced. The one-use target pin is retired to default-deny; never replay
the completed operator scripts or retarget them to an original database.

Fresh runtime inventory at 21:08:44 UTC confirmed the original staging machine
still running its older image with sending/scheduler/schema/automatic-migration
holds and an empty email allowlist. Production remained stopped. This was a
recovery rehearsal, not a staging or production application rollout.

## Gates that this test does not close

- The regular staging app remains the older 77f6d63 image on 95 tables. The held
  95-to-103 staging rollout, current normal-mode tenant/scheduler/alert acceptance
  and production release remain separate steps. Never deploy the new app before
  its reviewed schema or use the old app as an unchecked normal-write rollback.
- Fresh provider receipts, inbound replies, customer notification behavior,
  contractor payment reconciliation, actual phones and office/field workdays
  remain unaccepted. Eight empty new tables do not prove populated invoice,
  lifecycle or service workflows against a managed backup.
- Azure's first sign-in remains deferred to the owner; preserve the reported new
  account instead of repeating account creation. No outbound holds were lifted.
- A staging administrative credential unexpectedly appeared in a private tool
  response. Its value was not copied into reports. Subsequent outputs are filtered;
  coordinate administrative credential rotation and dependency verification before
  release. Do not casually rotate the separate runtime Reader/Writer accounts.
- No production recovery-time/recovery-point SLA, whole-business migration, or
  Housecall Pro replacement is established by this synthetic recovery exercise.

The owner requires **both contractors' actual required Housecall Pro workflows**
to be accepted before onboarding/cutover. The source-grounded gap matrix and
separate company acceptance cards are in
[HOUSECALL-PRO-REPLACEMENT-GATE.md](../HOUSECALL-PRO-REPLACEMENT-GATE.md).
