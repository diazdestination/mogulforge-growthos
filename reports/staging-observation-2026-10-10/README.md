# Staging database and managed-backup verification

October 10, 2026. Source baseline: main
`7091af816715cfd437925eb0af82fb47d3411e34`.
Work is isolated on `agent/growthos-db-recovery-20261010`.

## Verified source and recovery

Fly CLI 0.4.115 authenticated as `diazdestination@gmail.com` in `adam-diaz`.
The staging cluster `zp2wjrejd2zodn4q` is ready in `iad`. A session to
`growthos_staging` verified PostgreSQL 16.15, the expected
`growthos-restore-reader` login and effective role, a REPEATABLE READ READ ONLY
transaction, and finite timeouts. The owned loopback proxy used authenticated
Fly WireGuard transport; PostgreSQL TLS itself was false.

The full logical and physical application catalogs match the accepted 95-table
lineage: 1,068 columns, 319 constraints, 254 indexes, 15 enums, and no application
triggers or row policies. The logical SHA256 is
`a717ae6d79fe57095a4354b55bf1098b17085c00bd82b17a6076765434113516`;
the physical SHA256 is
`170670b17dfd2b4cbf2b5bc95b4642657294f2e67c92289ea60e9d8058f590c3`.
All 95 application tables were fingerprinted in one snapshot: 65 rows and
38,878 serialized bytes. No customer field values, URLs, or credentials were
logged. The digests provide equality evidence, not cryptographic authenticity.

Adam separately approved one temporary managed restore test, estimated at about
$0.15 for up to two hours. Copy `nlkxjo5w1x8oy93v`, named
`growthos-recovery-check-20261010-01`, was created at 13:21:20 UTC from completed
backup `20261010-000144F_20261010-130422I`. It remained unattached to applications.
The comparison finished at 13:25:34 UTC and passed all six checks: logical
catalog, physical catalog, every application-table fingerprint, privilege
metadata, extension-object metadata, and retained unresolved findings.
This proves managed-backup recovery of the observed 95-table application
database. Cleanup was verified at 13:36:17 UTC: the provider returned HTTP 200
with terminal status `deleted`, and a fresh active-cluster list contained only
the two original clusters. No HTTP 404 was observed. Source and stopped-app
configuration remained unchanged, and transport cleanup was acknowledged.

Source and restored-copy transactions rolled back successfully. Client ends,
socket closures, proxy exits, and listener removal were acknowledged. The source
staging machine `8d96936a03d058` remains stopped, with outbound, scheduler, and
migration holds intact. No source data, schema, roles, secrets, or application
configuration were changed. See [the restore record](RESTORE-PLAN.md).

## Local validation

All 28 focused tests pass using the repository's existing Vitest/CI discovery.
The complete scripts suite also passed: 22 files, 283 tests, in 67.88 seconds
(`scripts-vitest-integration.json` in the private artifact directory).
Independent review accepted the observer and runner, including the bounded
extension-view adjustment. All three catalog fixtures were generated from the
19 exact canonical Git blobs on an owned local PostgreSQL 16 container.

The final real-PostgreSQL smoke passed 18 checks. It proved complete-row digest
sensitivity by changing a non-key value without changing row count, then
restoring the value and original digest. It also verified actual READ ONLY write
rejection (`25006`), rollback, socket closure, and owned-container removal.
Local results and remote CI status remain separate evidence.

## Remaining gates

- The provider view `public.pg_stat_monitor`, extension 2.3, was identified and
  never queried. It is outside application-table fingerprints; full cluster-data
  coverage remains false.
- Reader inherits `pg_read_all_data` and `reader`. No effective application-table
  DML privileges were found, but reachable SET-role paths and the broader
  permission policy remain unresolved. Both Reader and Writer have 95 table
  entries; this alone does not establish application least privilege.
- Two executable C security-definer event-trigger functions belong to
  `pgaudit` 16.1: `pgaudit_ddl_command_end` and `pgaudit_sql_drop`. Neither was
  invoked. Their unresolved finding remains present in source and restored copy.
- Protected status/domain semantics and actual tenant/application journeys need
  separate acceptance. Complete-row fingerprints include unknown values.
- The application's effective `DATABASE_URL` endpoint has not been read or
  inferred from attachment labels. Fly lists `DATABASE_URL`,
  `OAUTH_TOKEN_ENCRYPTION_KEY`, `EMAIL_INTELLIGENCE_ENCRYPTION_KEY`, and
  `SESSION_SECRET`; recoverable key bytes, decryption, and legacy external
  objects remain unverified.
- The restored backup chain is verified; PITR, a migration rehearsal, and
  recovery of the current 142-table candidate are not. Source staging still has
  95 tables and requires a separately reviewed `0003`–`0018` migration sequence.
  No DDL, deployment, startup, provider delivery, or public launch is authorized
  by these results.

Private live receipts remain outside Git in
`C:\Forge\artifacts\growthos-db-recovery-20261010`, especially
`staging-observation-2026-10-10T13-14-51-793Z.json` and
`restore-observation-2026-10-10T13-25-00-320Z.json`.
Independent review verified all six comparisons against that restore receipt,
SHA256 `66794693202c1758cb4747f1556280ae5e42c5744071ee5c8fa86e8cccc4a724`.
The final cleanup receipt is
`restore-final-reconciliation-2026-10-10T13-36-04-737Z.json`. The original
strict-404 checker remains recorded as unconfirmed; a separately reviewed
read-only reconciliation verified the retained deleted record and active-list
absence without repeating DELETE. Final billing remains unverified.
Checked-in fixture evidence uses source-defined schema and synthetic local data.

## Running local checks

```powershell
pnpm --filter @workspace/scripts exec vitest run staging-observation-core.test.mjs staging-observation-fixtures.test.mjs staging-observation-runner.test.mjs
node scripts/staging-observation-local.mjs --run-local
```

The local smoke uses only an owned PostgreSQL 16 container. The hosted observer
requires an independently reviewed exact-byte admission file, the owner's CLI
login, and a fixed staging target. It has no deployment, DDL, grant, or restore
API action. Historical consumed operators remain unchanged.
