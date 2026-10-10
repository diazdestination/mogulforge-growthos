# Staging database observation and recovery verification

Owner request: sign the Fly CLI into Adam's existing account and continue database
and recovery verification. Engineering and read-only observation are authorized.
Adam subsequently approved one temporary managed restore test, estimated at
about $0.15 for up to two hours. That approval was consumed by isolated copy
nlkxjo5w1x8oy93v, created at 2026-10-10T13:21:20Z. It grants no further copies.

Source baseline: main 7091af816715cfd437925eb0af82fb47d3411e34. New work is isolated
on agent/growthos-db-recovery-20261010. Historical operators and receipts remain
unchanged. No application import/start, source schema change, role grant,
deployment, production access, or customer/provider delivery belongs to this
observer. The separately approved restore and exact-copy cleanup use their own
reviewed private operators; the observer itself remains read-only.

## Fixed observation target

CLI identity diazdestination@gmail.com; organization adam-diaz (personal alias).
Staging MPG zp2wjrejd2zodn4q, database growthos_staging. SQL login/effective role
growthos-restore-reader. Production MPG kzpwm0j18eg04nv3 is excluded.
The CLI's authenticated private proxy must bind only to an owned loopback port.
SQL TLS and private-tunnel protection are reported separately and truthfully.

One bounded REPEATABLE READ READ ONLY transaction captures actual session/role,
PostgreSQL 16, full logical and physical metadata, every application table's row count and
deterministic complete-row digest, and effective privileges/role membership.
Finite statement, lock, idle transaction and whole-operation timeouts are required.
Results must be bounded and structurally validated; unexpected catalog, hidden
rows/RLS, privileges, unsupported objects, incomplete reads and unknown protected
domains remain explicit unresolved gates. Never turn partial evidence into a GO.
Raw customer rows, credentials, arbitrary provider errors and URLs are not logged.
Rollback and client/proxy exit must be positively acknowledged even on failure.

## Independent lanes

- Root: this contract, fixed-target runner/authentication, provider observations,
  review/integration, recovery procedure, receipts and durable Forge state.
- Observer lane: scripts/staging-observation-core.mjs and its Vitest file only.
  Import-safe injected-client observation, bounded catalog/fingerprints/privileges,
  classification against explicit fixtures, safe errors and focused tests.
- Fixture lane: scripts/staging-observation-fixtures.mjs and its Vitest file,
  plus the assigned local integration smoke and fixture evidence. Generate fresh 95/141/142
  catalogs from the 19 exact canonical Git blobs in the existing source manifest
  using an owned local PostgreSQL 16 container. Verify the accepted 95-table digest; prove
  cleanup and preserve all historical files. No hosted/provider/credential access.

## Acceptance and limits

Exact metadata selects 95, 141, or 142; same-count drift is unresolved. Catalog
classification never authorizes DDL. Local tests cover bounds, identity mismatch,
read-only protection, full-row inclusion and cleanup/secret-safe error handling.
Independent review precedes hosted SQL. Fresh provider backup metadata is distinct
from a verified managed restore. A logical dump restored locally is a separate
recovery proof and must never be labelled a Fly managed-backup/PITR restore.
Only completed, independently assessed evidence may advance the held-staging plan.

## Observed acceptance

All 28 focused Vitest tests and 18 real local PostgreSQL smoke checks passed.
The complete scripts suite passed 283 tests in 22 files in 67.88 seconds;
scripts-vitest-integration.json records that local result.
The hosted source matches the accepted 95-table catalog and contains 65 rows.
At 13:25:34 UTC, the approved managed restore passed all six source/copy checks:
logical and physical catalogs, every application-table fingerprint, privilege
metadata, extension-object metadata, and the same unresolved findings. The
private receipt is restore-observation-2026-10-10T13-25-00-320Z.json under
C:\Forge\artifacts\growthos-db-recovery-20261010.

Exact-copy cleanup was verified at 13:36:17 UTC. One DELETE received HTTP 202;
the provider retained an HTTP 200 record with terminal status deleted. The
initial strict-404 checker remains recorded as unconfirmed. A separately
reviewed read-only reconciliation then verified terminal deletion, absence from
the fresh active list, unchanged source/stopped-app configuration, and transport
cleanup. It issued no mutations and observed no HTTP 404. The final receipt is
restore-final-reconciliation-2026-10-10T13-36-04-737Z.json in the same artifact
directory. Final billing remains unverified.

The current 142-table candidate remains unmigrated; permission-policy review,
encryption-key recovery, PITR, external objects, and actual application
acceptance remain separate gates.
