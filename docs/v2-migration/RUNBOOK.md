# GrowthOS production move: Fly MPG V1 to a fresh V2 cluster (runbook for Codex)

Owner decision: Adam, 2026-10-16 (top of `C:\Forge\CONTROL_PLANE.md`). Codex runs
this runbook. Every paid resource and the production change itself still need
Adam's approval of the priced packet first. Nothing here has been run against
Fly. The tooling has only been tested on local stand-ins.

## What the tooling does

| Script | Purpose |
| --- | --- |
| `scripts/v2-migration/copy-to-v2.mjs --execute` | Reads V1 in one `REPEATABLE READ READ ONLY` snapshot. Refuses a non-empty target. In one target transaction it rebuilds the exact legacy-75 schema from the live V1 catalog, copies every row, adds FKs, then applies the reviewed SQL. It verifies the result and commits only if everything matches. Prints a JSON summary with counts, hashes and timings, never row values. |
| `scripts/v2-migration/app-privileges.mjs` | Go/no-go for the app login: every expected table (reviewed 142 inventory) checked for SELECT, INSERT, UPDATE and DELETE separately by OID, plus CONNECT, schema USAGE and enum USAGE. Exit 0 only with zero gaps. |
| `scripts/v2-migration/compare.mjs` | Independent check after the copy, using fresh read-only snapshots on both sides. Exit 0 `MATCH`, 1 `MISMATCH`/`FAILED`, 2 `TARGET_EMPTY`. Also used to reconcile an uncertain COMMIT. |

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


### Copy outcomes and exit codes

| Status | Exit | Meaning | Operator action |
| --- | --- | --- | --- |
| `COMMITTED` | 0 | Target acknowledged COMMIT after all checks passed | Continue to compare |
| `ROLLED_BACK` | 1 | Verification failed, ROLLBACK acknowledged, COMMIT never sent | Fix cause. Rerun (refuses non-empty target) |
| `FAILED` | 1 | Error before COMMIT was sent (`commitSent:false`). The server discards an uncommitted transaction; the tool's best-effort ROLLBACK is **not** proof | Run `compare.mjs`: expect `TARGET_EMPTY` (exit 2) before any rerun |
| `UNKNOWN_OUTCOME` | 3 | COMMIT was sent, acknowledgement lost. Target **may be committed** | **Do not retry. Do not drop the target.** Keep the JSON. Reconcile below |

Reconcile `UNKNOWN_OUTCOME` (or any doubt) with `compare.mjs`, same URLs, writer freeze still in force:
- `MATCH` (exit 0) => the copy committed. Continue with step 6 evidence.
- `TARGET_EMPTY` (exit 2) => not committed. A rerun is allowed.
- anything else (`MISMATCH`, `FAILED`, partial objects) => **STOP**. Preserve the copy and compare
  JSON, keep V1 frozen and the app on V1, escalate to Adam. No destructive reset of an unresolved target.

**Admission manifest (mandatory, fail closed).** Both tools require `V2_MANIFEST`, a nonsecret JSON
file reviewed in the execution packet. Run `copy-to-v2.mjs --identify` (read-only, no data) against
the real endpoints. It prints a **draft** with the observed facts (cluster system identifier,
database, session login, effective role, PG major) and the observed source sessions. The
reviewer fills in `target.ownerRole` and `allowedSourceSessions` (exact `usename` +
`application_name` of reviewed non-writers only, for example monitoring). Observed sessions are
never allowed automatically. Values must come from the providers; never invent them.

```json
{ "source": { "systemIdentifier": "...", "database": "fly-db", "sessionUser": "...", "currentUser": "...", "pgMajor": 16 },
  "target": { "systemIdentifier": "...", "database": "...", "sessionUser": "...", "ownerRole": "...", "pgMajor": 16 },
  "allowedSourceSessions": [] }
```

Before any target mutation the copy refuses on any of the following:
- **Manifest:** missing or invalid (`v2_manifest_required` / `v2_manifest_invalid`), including any
  PG major other than 16.
- **Identity:** unreadable (`v2_identity_unavailable`, no override). The **same cluster** system
  identifier on both sides (`v2_same_cluster`) is refused regardless of database names or URL
  spelling.
- **Facts:** any database, login, source effective role or PG major that differs from the manifest
  (`v2_<side>_<field>_mismatch`).
- **Target contents:** a non-empty target (`v2_target_not_empty`: relations, standalone types,
  routines or schemas other than `public` that are not extension-owned).
- **Source sessions:** a source login that cannot observe other sessions (`v2_source_sessions_unobservable`;
  the reader needs `pg_read_all_stats` or `pg_monitor` in addition to `pg_read_all_data`), or any
  client session on the source database outside the allowlist (`v2_source_unexpected_sessions`).

Inside the transaction it requires membership in `ownerRole` and verifies `current_user = ownerRole`
after `SET LOCAL ROLE`. Immediately before COMMIT it rechecks the target facts, the owner role and
the source sessions. The summary's `admitted` and `sourceSessions` fields bind the receipt to these
facts. The session check is a gate, not containment: the external writer freeze (step 1) must stay
in force through final compare and cutover.

**Error output** contains only our safe codes, our own name/count details, and for PostgreSQL
errors the SQLSTATE plus schema/table/column/constraint names. PostgreSQL message/detail/hint text,
which can contain key or row values, is never printed.

## Local test evidence (2026-10-16, Windows + WSL Docker, postgres:16-alpine)

`cd scripts && node node_modules/vitest/vitest.mjs run v2-migration/`: **15/15 pass**. With
`production75-core`, `production75-source` and `production75-scheduling0019` (4 files) it is 106/106. Two
containers, `claude-v2mig-src-*` and `claude-v2mig-dst-*` (127.0.0.1 only, `--rm`), are removed
afterwards. Synthetic data: 46 rows across 12 legacy tables in 2 fictional tenants. It covers bytea
with NUL, text[] with commas/quotes, timestamp without time zone, JSON null vs SQL NULL, Unicode,
and held/unknown-effect scheduled actions. Fault injection covers a lost COMMIT acknowledgement
(=> `UNKNOWN_OUTCOME`, then compare `MATCH`, retry refused), a failure before COMMIT
(=> `FAILED`, target empty, compare `TARGET_EMPTY`), admission refusals (unreadable identity,
missing manifest, same cluster/different database, URL alias, wrong database/login/role/owner role,
PG 17), unexpected and late source sessions, a source login blind to sessions, non-empty targets
(routine, composite type, extra schema), app-privilege gaps (SELECT-only and wholly inaccessible
tables), connection cleanup on setup failure, and a real duplicate-key error (=> output holds no
key values).

Measured locally: copy 6.4–7.7 s (connect 1.4, source read 0.4–0.6, rebuild+copy 1.9–2.4,
upgrade SQL 2.3–2.9, verify+commit 0.4), compare 2.2–2.3 s. Production `fly-db` held 65 rows at
the Oct 11 baseline. Each statement over a tunnel pays network latency (about 300 round trips), so
estimate **1 to 5 minutes** for copy plus compare (an estimate, not measured against Fly).

## Known V1 facts (dated receipts, not fresh provider checks)

- App-bound database: **`fly-db`** (65 rows at Oct 11 baseline). Session login **`fly-user`**
  (non-superuser), effective role **`schema_admin`** (NOLOGIN, owns the objects). **Only `fly-db`
  moves.** The other V1 database with the `growthos_staging` physical layout is not part of this
  cutover. The separate staging cluster `zp2wjrejd2zodn4q` is independent and not touched.
- PostgreSQL **16.14** (`160014`). Provider-owned extensions **`pg_stat_monitor` 2.3** and
  **`pgaudit` 16.1**. They are not copied (extension objects are excluded). V2's inventory must be
  checked.
- The app binding's hostname indicates PgBouncer, but its pool mode is unverified.
- Encrypted custody of the V1 binding exists (`C:\Forge\GROWTHOS_PRODUCTION_CREDENTIAL_RECOVERY_2026-10-11.md`,
  escrow under `C:\Forge\artifacts\growthos-staging-release-20261010`). It was verified offline
  only. A **fresh authentication with the recovered app password** has not been done.

## Preconditions (no-go if any is missing)

1. Adam approved the priced packet. It covers the V2 plan/size/region and monthly cost (**check
   current Fly MPG pricing**; do not reuse old numbers) and the V1 retention period.
2. **Rollback credential proven.** The recovered V1 `DATABASE_URL` authenticates now: connect,
   `SELECT current_user, session_user, current_database()` returns `schema_admin`/`fly-user`/`fly-db`
   (or the recorded equivalent). Its identity also matches the current deployed secret metadata
   (digest/name only). **Fly secrets cannot be read back after overwrite.**
3. The app image/commit to start on V2 is pinned and contains the 0019 code (#63 tip `02306ef` or
   its merged equivalent).
4. A V1 login that can read `fly-db` and observe all sessions: a dedicated reader with
   `pg_read_all_data` plus `pg_read_all_stats` (or `pg_monitor`). The tool enforces read-only
   regardless, and refuses a login that cannot see other sessions.
7. **Admission manifest reviewed** (see **Admission manifest**), with both cluster system
   identifiers different.
5. **V2 inventory recorded:** PG major is 16 (no-go on any other major without a separate decision).
   Encoding equals V1. Locale/collation are recorded; a difference requires an explicit decision,
   not a default accept. The extension list, its owners and grants are reviewed, and nothing
   non-extension exists in `public`.
6. **V2 roles and privileges** (no-go until each is shown with a query, see step 3b). No grant SQL
   ships in this tooling. Any grants go in the separately reviewed execution packet.

## Ordered steps

All `fly`/`flyctl` commands below are **unexecuted examples with unverified flags**. Before the
priced packet, check them against the installed generation-aware CLI's local `--help`: `mpg create`
plan/version flags, direct vs pooled proxy, `mpg backup`, and Machine `--autostart`. Do not run
this runbook verbatim.

1. **Verified writer freeze (required through final compare and cutover).** DNS or "not launched"
   is **not** containment. The app keeps its Fly hostname, and `auto_start_machines = true` lets
   any request wake a stopped Machine. Use the prepared containment in
   `C:\Forge\GROWTHOS_AUTOSTART_CONTROL_PREPARATION_2026-10-15.md`; its proposal is not proof until
   executed and verified.
   - Disable autostart on **every** app Machine (example: `fly machine update <id> -a mogulforge-growthos --autostart=false`)
     and stop them all.
   - **Positive check:** `fly machine list -a mogulforge-growthos --json` shows every Machine
     `stopped` with autostart disabled, and zero `started` Machines. Record it.
   - **Positive check on V1** (as an admin/monitor login on `fly-db`):
     `SELECT count(*) FROM pg_stat_activity WHERE datname='fly-db' AND backend_type='client backend' AND pid<>pg_backend_pid() AND usename='fly-user';`
     must be **0**. Also list any other client sessions (`usename, application_name, state`) and
     account for each one (monitoring, PgBouncer server connections). No session may hold writer
     privileges.
   - Repeat both checks immediately before step 5, after step 6, and immediately before step 7.
     Any change => stop. The copy's own session gate (before mutation and before COMMIT) does not
     replace this external containment.
   - Confirm the outbound/scheduler hold remains in place.
   - **Record the rollback configuration** (needed because V1 is the legacy 75-table layout and the
     PR63 image expects 142 tables plus 0019, so the new image cannot run on V1):
     - the exact pre-cutover image digest of every app Machine (example:
       `fly machine list -a mogulforge-growthos --json` -> `config.image` and `image_ref.digest`;
       `fly releases -a mogulforge-growthos --image`);
     - the current app config (example: `fly config show -a mogulforge-growthos`);
     - the secret names and digests (`fly secrets list -a mogulforge-growthos`, never values).
     Store these with the evidence. Rollback restores **old image + old config + V1 URL** together.
2. **Fresh V1 backup.** Example: `fly mpg backup list <v1-cluster-id>`, using the version-aware CLI
   used on Oct 10 for V1. Require a completed full backup taken **after** the freeze; otherwise
   request one and wait. Record its id and time.
3. **Create V2** (paid, needs the approved packet). Example:
   `fly mpg create --org adam-diaz --name growthos-prod-v2 --region iad --plan <approved> --pg-major-version 16`,
   then `fly mpg status <v2-id>` until ready. Record the V2 cluster id, the database name and the
   provider-created login(s).
   - **3b. Role checks (go/no-go, run as the V2 login):**
     - `SELECT current_user, session_user;`
     - `SELECT r.rolname, m.rolname AS member_of FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.member JOIN pg_roles m ON m.oid=a.roleid WHERE r.rolname=current_user;`
       must show the intended owner role (proposed mapping: login like `fly-user` -> `schema_admin`).
     - `SET ROLE <owner-role>; RESET ROLE;` succeeds (the copy also enforces this).
     - `SELECT nspowner::regrole, has_schema_privilege('<owner-role>','public','CREATE') FROM pg_namespace WHERE nspname='public';`
       must be true.
     - `has_database_privilege('<app-login>', current_database(), 'CONNECT')` must be true.
4. **Tunnels** (local only). Example: `fly mpg proxy <v2-id> --local-port 16432` plus the V1
   access path on another port. The copy and compare **must use direct PostgreSQL connections**,
   not PgBouncer. They need one long session transaction.
5. **Copy.** Repeat the step 1 checks first.
   ```powershell
   $env:SOURCE_DATABASE_URL = '<V1 read-only URL via tunnel>'   # from custody; never echoed
   $env:TARGET_DATABASE_URL = '<V2 owner-capable URL via tunnel>'
   node scripts/v2-migration/copy-to-v2.mjs --identify > manifest-draft.json   # review, complete, store in packet
   $env:V2_MANIFEST = '<path to the reviewed manifest>'
   node scripts/v2-migration/copy-to-v2.mjs --execute > copy-summary.json; $LASTEXITCODE
   ```
   Go only on exit 0 / `COMMITTED`, `verification.ok`, and 142 `tables` rows all `match`. For any
   other outcome follow **Copy outcomes** above. Exit 3 is never a retry.
6. **Compare.** `node scripts/v2-migration/compare.mjs > compare.json`, with the same three variables. Go only on exit 0 /
   `MATCH`. Review `warnings` (for example `database_locale_differs`) against the precondition 5
   decision. Keep both JSON files and the backup id as evidence; they contain no row values.
   Repeat the step 1 checks.
7. **App privileges (go/no-go before the secret changes).** As the **app login** on V2:
   `$env:APP_DATABASE_URL = '<V2 URL as the app login>'; node scripts/v2-migration/app-privileges.mjs > app-privileges.json`.
   It must exit 0 with `status: OK`. The tool checks the expected inventory (the reviewed 142 tables
   and 15 enum types), not what the login happens to see. Each table is looked up by OID and
   SELECT, INSERT, UPDATE and DELETE are checked separately. CONNECT, schema USAGE and enum USAGE
   are checked too, and public tables outside the inventory are reported. Do not use
   `information_schema` or a comma-separated `has_table_privilege` list: those miss inaccessible
   tables and pass when ANY listed privilege exists. Grants, if needed, belong in the reviewed
   execution packet, not this tooling. There are no application sequences.
8. **Rotate the credential and repoint.** Write the V2 app URL as a **direct** PostgreSQL
   connection, or a pooler verified to be in **session** mode. Transaction-mode PgBouncer is not
   allowed: the scheduler holds a session advisory lock (`pg_try_advisory_lock` /
   `pg_advisory_unlock`, `artifacts/api-server/src/services/scheduler-runtime.ts:64,141`).
   Example: `fly secrets set DATABASE_URL='<V2 app URL>' -a mogulforge-growthos --stage`.
   The V1 credential stays valid for rollback until acceptance.
9. **Start privately.** **Write accounting starts here:** from this first V2 app start, every write on
   V2 (including sign-in sessions and any acceptance edits) counts for rollback B below. Start one Machine with the pinned image (example:
   `fly secrets deploy -a mogulforge-growthos` / `fly machine start <id>`). Keep autostart off,
   public routing closed, `AUTO_MIGRATE` unset/false, and the outbound hold on.
10. **Health and workflow checks.**
    - `/api/healthz` and readiness OK; owner sign-in works.
    - Both tenants' record counts match `copy-summary.json`. Existing lead, estimate, project and
      invoice open. Saved-scheduling settings load.
    - `scheduled_actions` statuses are unchanged (no held or unknown effect replays).
    - Exactly one scheduler holds its advisory lock.
    - No SQL errors in logs for 10 minutes.
11. **Open traffic** as Adam approved: re-enable autostart and routing. Customer writes now land
    on V2 as well.
12. **After acceptance** (Adam confirms, suggested at least 7 days):
    - Retire the old V1 login (rotate or revoke `fly-user` and the reader). Confirm V1 refuses the
      old credential and V2 stays healthy.
    - V1 deletion needs separate owner approval and a final backup.

## Rollback

Trigger: any failed go/no-go, failed health/workflow check, data mismatch, or Adam's call.

Rollback is **old image + old config + V1 URL**, never just repointing `DATABASE_URL`. The PR63
image expects the 142-table + 0019 schema and is not compatible with V1's legacy 75-table layout.
Use the image digest and config recorded in step 1.

**A. Before the first V2 app start (step 9 not done).** Nothing has written to V2.
1. Keep (or put back) the writer freeze. Verify V2 has no app client sessions.
2. Restore old image + old config + V1 URL. Example:
   `fly secrets set DATABASE_URL='<V1 URL from custody, re-verified in precondition 2>' -a mogulforge-growthos --stage`,
   plus any other changed secret/config values, then
   `fly deploy -a mogulforge-growthos --image <recorded-image@sha256:digest>` (flags unverified).
   Confirm every Machine runs that digest.
3. **Default outcome: stopped maintenance.** The app stays stopped on the old binding. That the
   recorded pre-cutover image works with V1's legacy-75 layout is **not proven by this tooling**
   (no local old-image/V1 rehearsal exists). Start it only if Adam asks, and then only as a
   separate observed check; do not claim service is restored until its health/sign-in checks pass.
4. Keep V2 intact for diagnosis. Delete it only with approval.

**B. After the first V2 app start (step 9 or later).** V2 may hold writes that V1 does not have.
These include owner sign-in sessions from step 10 (`auth.ts` inserts/updates/deletes `sessions`),
any acceptance edits, and customer writes after step 11. Repointing alone would silently drop them.
1. Freeze V2 writers: disable autostart and stop every app Machine. Verify with the same positive
   checks as step 1, now on V2: Machines all stopped, and zero app client sessions on V2.
2. Measure what changed since the copy. Run `compare.mjs` with V1 as the source and V2 as the
   target (same manifest). Use its `writeInventory.changedTables`. This is the deduplicated list of
   every table named by **any** table-bearing problem: legacy fingerprint/count (`table`), values
   in columns added by the upgrade, including the 0019 scheduling columns (`added_column_default`),
   rows in new tables (`new_table_not_empty`), `added_column_missing`, and any future table-scoped
   kind. Do not filter by problem kind.
   **HOLD** (no revert, escalate) if compare exits `FAILED`, or if `writeInventory.complete` is
   false (catalog, sequences, encoding or other problems without a table). An empty list proves
   nothing in that case.
3. **Preserve before reverting.** Keep V2 intact and record `writeInventory` and the full compare
   JSON with the evidence.
4. **Stop for an owner decision.** Every listed table must be named, including `sessions`. Each
   one needs an explicit disposition:
   - (a) fix forward on V2 (preferred);
   - (b) a reviewed forward-copy into V1 (not provided by this tooling; needs its own review; it
     must respect the legacy-75 layout, and data held only in the 67 new tables or added columns
     has no place in V1);
   - (c) Adam explicitly accepts discarding the named data. This includes disposable TEST/session
     rows; even those are listed and accepted, not assumed harmless.
5. Only after (b) is verified or (c) is approved: continue as in A.2–A.4.

**Durations are estimates until rehearsed.** No rollback has been timed. Plan the window to allow
for stopped maintenance.

## Go / no-go summary

| Check | Go |
| --- | --- |
| Writer freeze | All Machines stopped with autostart off, verified with current evidence at execution (the dated Oct 16 receipt saw production STARTED at 18:32 UTC); zero unexpected sessions on V1; rechecked at steps 5, 6 and 7 |
| Rollback config | Pre-cutover image digest, app config and secret digests recorded |
| Admission manifest | Reviewed from `--identify`; distinct clusters, PG 16, owner role and session allowlist set; both tools run with `V2_MANIFEST` |
| Rollback credential | Recovered V1 URL freshly authenticates as `fly-user`/`schema_admin` on `fly-db` |
| V1 backup | Completed, newer than the freeze |
| V2 inventory | PG 16, same encoding, locale decided, extensions reviewed, `public` empty |
| V2 roles | Membership, SET ROLE, schema CREATE and CONNECT shown (step 3b) |
| Copy | Exit 0 `COMMITTED` and `verification.ok`; 75 preserved + 67 new-empty all `match`. Exit 3 => reconcile, never retry |
| Compare | Exit 0, `MATCH`, catalog 142/1870 |
| App privileges | `app-privileges.mjs` exit 0 / `OK` as the app login (step 7) |
| Connection | Direct, or verified session-mode pool. Never transaction-mode PgBouncer |
| App | Health OK, sign-in OK, counts equal, one scheduler lock, no SQL errors for 10 min |

## Open items for the execution packet

1. Actual V2 login/role names and any explicit grants (reviewed in the packet, not in this code).
2. V2 extension inventory versus V1 (`pg_stat_monitor` 2.3, `pgaudit` 16.1 on PG 16.14).
3. Whether real V1 data passes every CHECK added by 0003 to 0019 is proven only by the copy. A
   failure is `ROLLED_BACK`/`FAILED`; an uncertain COMMIT is `UNKNOWN_OUTCOME`.
4. Package B: keep `reports/release-preparation-2026-10-09/schema-catalog.mjs`,
   `reports/staging-observation-2026-10-10/fixtures/catalog-{95,142}.json` and, for the tests,
   `reports/production75-recovery-2026-10-11/{fixture75-*.sql,catalog75-*.json}` plus the
   transitive production75 imports. Or update the paths and rerun. SQL comes from pinned Git
   objects, which must stay reachable.
5. All flyctl flags remain unverified (see Ordered steps).
