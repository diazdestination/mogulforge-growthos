# Local PostgreSQL16 catalog fixtures

These metadata-only catalogs are generated from the 19 SQL Git blobs at
`7091af816715cfd437925eb0af82fb47d3411e34`. All byte lengths and SHA256 values
match the pinned release-preparation source manifest before any SQL executes.
No application, hosted database, provider credential, or customer rows are used.

`catalog-95.json` is captured after 0002; `catalog-141.json` after 0017;
`catalog-142.json` after 0018. They retain physical column ordinals and every
section emitted by the existing metadata collector. The 95-table logical digest
matches the historical accepted digest. Table count alone never establishes a
catalog match. These fixtures establish schema expectations, not actual hosted
contents, access privileges, successful recovery, migration, or release approval.

The successful generation receipt records PostgreSQL16.15, the local image ID,
all source hashes, logical/physical catalog digests, exact JSON file hashes,
connection closure, and positive absence of the uniquely labelled owned
container after removal. The runner uses an existing local image with
`--pull=never`, publishes only to a generated `127.0.0.1` port, constructs all
connection fields internally, and inherits only the local-development OS
environment allowlist. It cannot accept a database URL or arbitrary SQL path.

Run from the repository root with installed frozen dependencies and local Docker:

```powershell
pnpm --filter @workspace/scripts exec vitest run staging-observation-fixtures.test.mjs
node scripts/staging-observation-fixtures.mjs --generate-local
```

Regeneration replaces this directory's catalog JSON and generation receipt only
after confirmed client/container cleanup. Historical source files and operators
remain unchanged. A failed generation writes a failed receipt; its pre-existing
catalog files are not fresh successful evidence.

The separate `local-observer-smoke.json` is an actual PostgreSQL16 integration
check of `observeStaging`, using the exact95 schema, one synthetic organization,
an inherited read-only role, and a separate DML-capable application role. It
checks all95 metadata/fingerprint results, effective privileges, actual database
rejection of writes in a read-only transaction, rollback acknowledgments, socket
closure, and owned-container absence. It also pins and rechecks the tested core
file hash. Two further observations prove a same-row-count non-key name change
alters the complete-row digest and restoring the name restores the baseline.
The deliberately inherited Reader role and default grants must produce exactly
`reader_set_role_paths_unassessed` and `default_grant_policy_unassessed` while
schema/data observation completes. Passing this smoke means those unresolved
policy gates were retained correctly, not that the application is release-ready.
Run it explicitly with:

```powershell
node scripts/staging-observation-local.mjs --run-local
```
