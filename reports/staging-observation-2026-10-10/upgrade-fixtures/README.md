# Local acceptance of the new staging migration executor

This evidence tests `scripts/staging-migration-core.mjs` on an owned local
PostgreSQL 16 container. It does not connect to Fly or establish hosted migration
authority. The exact 19 SQL blobs come from source commit
`7091af816715cfd437925eb0af82fb47d3411e34`; their existing pinned manifest and
physical 95/142 catalogs are verified before use. Only steps `0003`–`0018` are
passed to the new migration executor.

Final tested core SHA256:
`336ef191fe11b3cceb109f16fdfce0368f0de961e780966d37ea4bdfc3d391cc`.
The harness verifies that this hash is unchanged between import and completion.

## Results

- Fourteen focused Vitest tests passed. They cover source/catalog drift, an
  unregistered plan, both approved initial roles, wrong database/login/role/version/PID,
  bounded identity-check booleans, journal failures before dispatch,
  a lost BEGIN response, a lost COMMIT acknowledgment, a failed or hanging
  commit-ack journal, bounded hanging-journal cleanup, third-role ACL refusal,
  rollback proof, and mandatory independent Reader recapture.
- The final real-PostgreSQL run passed from `2026-10-10T18:57:18.098Z` to
  `2026-10-10T18:57:35.222Z`. An entirely empty 95-table database was accepted in
  a rollback rehearsal. Two synthetic tenants then populated all eight tables
  receiving legacy defaults, plus required parents: 24 retained rows in 12
  tables, with 83 other original tables empty.
- Changing a retained non-key value without changing row count caused baseline
  drift refusal before any migration step. An actual division-by-zero SQL error
  at the final step rolled back all 15 earlier acknowledged steps. Fresh Reader
  captures confirmed the original catalog, data fingerprints, and ACLs remained.
- Exact commit and a different Reader backend proved 95 original-table
  fingerprints preserved, 47 new tables empty, all 26 legacy defaults correct,
  284 table-privilege entries, and 3,734 column-privilege entries. Original table
  ownership is `schema_admin`; the local login role `fly-user` is configured with
  default role `schema_admin`, matching the observed Fly configuration. Every
  migration case verifies that initial identity, and the executor still selects
  `schema_admin` explicitly within the transaction. Reader/Writer privileges are modeled
  through `pg_read_all_data` and `pg_write_all_data` inheritance.
- Every case uses a separate journal file with `fsync` before the injected
  persistence callback acknowledges each event. All 11 clients and sockets
  closed, and absence of the uniquely labelled owned container was confirmed.

`local-migration-acceptance.json` is the latest result. Per-run result files and
`journals/<run-id>/` preserve earlier local executions; consult their exact core
hashes before using them as evidence. `focused-test-receipt.json` records the
focused command and source hashes. Receipts retain counts, digests, identities,
and journal phases, not raw seeded row values or credentials.

```powershell
pnpm --filter @workspace/scripts exec vitest run staging-migration-core.test.mjs
node scripts/staging-migration-local.mjs --run-local
```

The local harness accepts no connection URL or arbitrary target. It uses only an
existing local PostgreSQL 16 image, binds the generated port to `127.0.0.1`, and
does not import or start the application. Failed statuses, incomplete cleanup,
or a changed core hash cannot produce a successful process exit.
