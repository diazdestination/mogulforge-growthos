# GrowthOS production move: Fly MPG V1 to a fresh V2 cluster (runbook for Codex)

Owner decision: Adam, 2026-10-16 (top of `C:\Forge\CONTROL_PLANE.md`). Codex runs
this runbook. Every paid resource and the production change itself still need
Adam's approval of the priced packet first. Nothing here has been run against
Fly. The tooling has only been tested on local stand-ins.

## What the tooling does

| Script | Purpose |
| --- | --- |
| `scripts/v2-migration/copy-to-v2.mjs --execute` | Reads V1 in one `REPEATABLE READ READ ONLY` snapshot. Refuses a non-empty target. In one target transaction it rebuilds the exact legacy-75 schema from the live V1 catalog, copies every row, adds FKs, then applies the reviewed SQL. It verifies the result and commits only if everything matches. Prints a JSON summary with counts, hashes and timings, never row values. |
| `scripts/v2-migration/compare.mjs` | Independent check after the copy, using fresh read-only snapshots on both sides. Exits 1 on any mismatch. |

Schema route and why: the target is produced by **the same reviewed SQL that
was rehearsed for the in-place production upgrade**. That SQL is the 19 pinned
blobs at `7091af8` (the selected 0000 bridge, then 0001 to 0018) plus the pinned
0019 at `91b7fd2`, verified byte-for-byte by the existing
`buildProduction75Source` / `buildScheduling0019Source`. The legacy schema is
rebuilt with the same construction as `production75-local.mjs` `fixtureSql`, and
the test proves the output is byte-identical to the committed fixtures for both
physical layouts. After the copy the tool requires the following:

- The rebuilt legacy catalog must **physically equal** the V1 catalog.
- After 0018 the catalog must equal `deriveProduction75Catalogs(...)` for that
  layout. This is the same expectation the native rehearsal used.
- After 0019 it must pass `assertScheduling0019Catalogs` (142 tables, 1870
  columns).

We did not use "apply a fresh 142 schema, then transform-copy" because no
reviewed transform exists for it. A fresh 0000 install also gives different
physical column ordinals than the rehearsed upgrade, so it would not match the
pinned 142 catalog digests.

Fingerprints are computed for each legacy table: sha256 over the table name,
the sorted original column names, and every row as exact PostgreSQL text values
(SQL NULL is kept separate from JSON `null`). Rows are ordered by primary key
`::text COLLATE "C"`. Session settings are fixed (UTC, ISO dates,
`extra_float_digits=3`, `bytea_output=hex`), so V1 and V2 produce the same text.

Other checks:

- The 67 new tables must be empty.
- The 16 columns added to old tables (13 from `ORIGINAL_DEFAULTS` and 3 from
  0019) must hold their reviewed default value.
- Sequences must be equal (none exist), and there must be no identity or
  generated columns.
- Every constraint must be validated and every index valid.
- Encoding must match. A locale difference only produces a warning.

## Local test evidence (2026-10-16, Windows + WSL Docker, postgres:16-alpine)

`cd scripts && node node_modules/vitest/vitest.mjs run v2-migration/`: 6/6 pass
(see the receipt for the related suites). The run uses two containers,
`claude-v2mig-src-*` and `claude-v2mig-dst-*`, both 127.0.0.1-only and `--rm`,
and removes them afterwards. The synthetic dataset has 46 rows across 12 legacy
tables in 2 fictional tenants, covering bytea with NUL, text[] with
commas/quotes, timestamp without time zone, JSON null vs SQL NULL, Unicode, and
held/unknown-effect scheduled actions.

Measured locally:

| Step | Time |
| --- | --- |
| Connect | 1.4 s |
| Source read | 0.4 s |
| Rebuild and copy | 2.0 s |
| Upgrade SQL | 2.3 s |
| Verify and commit | 0.4 s |
| **Copy total** | **6.5 s** |
| **Compare** | **2.3 s** |

Production is about 65 rows in the app database. Through `fly mpg proxy` / the
V1 proxy, each statement pays network latency (about 300 round trips for the
copy), so plan on **1 to 5 minutes** for copy plus compare.

## Preconditions (no-go if any is missing)

1. Adam approved the priced packet: the V2 cluster plan/size/region and its
   monthly cost (**check current Fly MPG pricing**; do not reuse old numbers).
   The packet must also cover the V1 retention period.
2. The current V1 `DATABASE_URL` for `mogulforge-growthos` is held in
   encrypted custody and was tested by connecting to it. **Fly secrets cannot be
   read back after they are overwritten.** This value is the rollback.
3. The exact app image or commit to start on V2 is pinned. It must contain the
   0019 code (#63 tip `02306ef` or its merged equivalent).
4. You know which V1 database the app uses. The reviewed operator pins `fly-db`
   with writer `fly-user` and role `schema_admin`. V1 also has a
   `growthos_staging`-layout database. The copy moves one database per run.
5. A V1 login that can read the app database. Use a dedicated read-only login
   (`pg_read_all_data`) if possible. The tool enforces read-only either way.

## Ordered steps

All `fly` commands below are written out but **not run**. Confirm flags with
`--help` on the current flyctl first.

1. **Freeze writes.**
   - Confirm the production Machine is stopped and stays stopped: run
     `fly machine list -a mogulforge-growthos`. `fly.toml` has
     `auto_start_machines = true`, so incoming traffic can wake it.
   - For the window, disable autostart on the Machine:
     `fly machine update <machine-id> -a mogulforge-growthos --autostart=false`.
     Alternatively, keep the Fly proxy from routing by confirming no
     public-launch DNS points to it.
   - Confirm `GROWTHOS_OUTBOUND_HOLD` / the scheduler hold is still in place.
   - The copy reports `sourceOtherSessions`. Expect 0 client backends from the
     app. Investigate any others before continuing.
2. **Confirm a fresh V1 backup.**
   - List backups with `fly mpg backup list <v1-cluster-id>`. This may need the
     version-aware CLI used on Oct 10 for V1.
   - Require a completed full backup taken after the freeze. If the latest one
     is older, request one (`fly mpg backup create <v1-cluster-id>`) and wait
     for it to complete.
   - Record its id and time.
3. **Create the V2 cluster** (paid, manual, needs the approved packet):
   - `fly mpg create --org adam-diaz --name growthos-prod-v2 --region iad --plan <approved-plan> --pg-major-version 16`
     (the app and V1 run in iad; keep PG 16 to match V1).
   - `fly mpg list --org adam-diaz` and `fly mpg status <v2-cluster-id>` until it is ready.
   - Create or locate the app database and its login/role in V2 (MPG V2 UI or
     `fly mpg` user/database subcommands). Record the role that should own the
     tables (see Open questions).
4. **Open tunnels** (local only, from the operator machine):
   - `fly mpg proxy <v2-cluster-id> --local-port 16432`, plus the established
     V1 access path on another port.
   - Use **direct (non-PgBouncer) connection strings.** The copy needs one long
     session transaction.
5. **Run the copy:**
   ```powershell
   $env:SOURCE_DATABASE_URL = '<V1 read-only URL via tunnel>'   # from custody, not typed into logs
   $env:TARGET_DATABASE_URL = '<V2 owner URL via tunnel>'
   $env:TARGET_OWNER_ROLE   = '<V2 owner role, e.g. schema_admin>'   # optional
   node scripts/v2-migration/copy-to-v2.mjs --execute > copy-summary.json
   ```
   Go only if `status` is `COMMITTED`, `verification.ok` is true, and all 142
   rows in `tables` have `match: true`. `ROLLED_BACK` or `FAILED` leaves V2
   empty and V1 untouched; fix the cause and rerun. If V2 is no longer empty,
   drop and recreate the V2 database.
6. **Run compare:**
   `node scripts/v2-migration/compare.mjs > compare.json`. Go only on exit 0 and
   `status: MATCH`. Review `warnings` (for example `database_locale_differs`)
   before going on. Keep both JSON files and the backup id as evidence; they
   contain no row values.
7. **Rotate the credential and repoint the app:**
   - `fly secrets set DATABASE_URL='<V2 app URL>' -a mogulforge-growthos --stage`
     (or `fly mpg attach <v2-cluster-id> -a mogulforge-growthos`, if that is the
     approved method).
   - Pick the same login/role model the app used on V1 (see Open questions).
   - The old V1 credential stays valid for rollback until acceptance.
8. **Start the app privately:**
   - Deploy or start the pinned image: `fly secrets deploy -a mogulforge-growthos`
     or `fly machine start <machine-id> -a mogulforge-growthos`.
   - Keep public routing/DNS closed. Keep `AUTO_MIGRATE` unset or false (the
     app refuses anything else). Keep the outbound hold on.
9. **Health and workflow checks:**
   - `/api/healthz` and readiness return OK.
   - Owner sign-in works.
   - Both tenants' records are visible (counts match `copy-summary.json`).
   - Open an existing lead, estimate, project and invoice.
   - Saved-scheduling settings load (0019 columns).
   - No scheduled action replays a held or unknown effect (the
     `scheduled_actions` statuses are unchanged).
   - App logs show no SQL errors for 10 minutes.
10. **Open traffic.** Re-enable autostart
    (`fly machine update <id> --autostart=true`) and public routing, as Adam
    approved.
11. **After acceptance** (Adam confirms, suggested at least 7 days):
    - Retire the old V1 login: rotate or revoke the V1 `fly-user` / reader
      passwords.
    - Confirm V1 refuses the old credential and that the V2 app is healthy.
    - Then follow the approved plan for V1 retention or deletion. Deleting V1
      needs separate owner approval and a final backup.

## Rollback (any time before step 11)

Trigger: any failed go/no-go check, failed health/workflow checks, data
mismatch, or Adam's call.

1. `fly secrets set DATABASE_URL='<V1 URL from custody>' -a mogulforge-growthos --stage`
2. `fly secrets deploy -a mogulforge-growthos`, or restart the Machine.
3. Run the health check.

Expected time is **2 to 5 minutes**. V1 was never written, so it is exactly as
it was at the freeze.

Writes made on V2 after traffic opened are **not** copied back. Before rollback
after opening, export or record them, or accept losing them; this tool has no
reverse copy. Leave V2 in place for diagnosis and delete it only with approval.

## Go / no-go summary

| Check | Go |
| --- | --- |
| V1 backup | Completed, newer than the freeze |
| Copy | `COMMITTED`, `verification.ok`, 75 preserved + 67 new-empty all `match` |
| Compare | Exit 0, `MATCH`, catalog 142/1870 |
| App | Health OK, sign-in OK, record counts equal, no SQL errors for 10 min |
| Rollback ready | V1 URL in custody and tested |

## Open questions for Codex

1. Which V2 roles to use: MPG V2 user/role names and whether `schema_admin`
   exists. Tables are owned by the login or by `TARGET_OWNER_ROLE`. If the app
   login is not the owner, it needs grants. No grant SQL is included, because
   the scope freeze allows no new SQL.
2. Extension differences: V2 may preinstall extensions such as `pg_stat_monitor`
   or `pgaudit`. Extension-owned objects are ignored. Any other preexisting
   object in the target makes the copy refuse, with counts.
3. Use the PgBouncer endpoint or the direct one? The copy must use the direct
   one. For the app, confirm that transaction-mode pooling is safe (session
   `SET`, advisory locks, LISTEN), or use direct.
4. PG major version and locale on V2. The copy tool warns on a collation
   difference; text ordering in unique indexes is the same for this data, but
   decide explicitly.
5. Is only `fly-db` in scope, or should the `growthos_staging`-layout database
   on V1 also move? The tool handles either layout, one run each.
6. Whether real V1 data passes every CHECK added by 0003 to 0019 is proven only
   when the copy runs. A failure rolls back safely.
7. Package B moves `reports/**` out of git. These tools import
   `reports/release-preparation-2026-10-09/schema-catalog.mjs` and read
   `reports/staging-observation-2026-10-10/fixtures/catalog-{95,142}.json`, like
   the existing production75 tooling. Keep those files, or update the paths,
   when B lands. The SQL is read from Git history, so it is unaffected.
