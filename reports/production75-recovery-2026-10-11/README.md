# Import-safe production75 mechanism and local PostgreSQL16 proof

This is local source and synthetic-fixture evidence. It grants no hosted target,
connection, migration, provider operation, application start or release authority.
Root owns actual application/database binding, complete live fingerprint and
permission capture, backup/recovery admission, durable attempt reservation and
integration. No credentials or real records were read by this lane.

The new scripts are independent of the existing staging95 executor. Its fixed
95/142 catalog hashes, staging identities, operator fences and permissions are
unchanged. `production75-core.mjs` has no filesystem, environment, transport or
application access. Its caller must explicitly provide the database, login,
effective role, allowed initial roles, Reader identity, observed principals and
reviewed complete75/95/142 privilege/ownership/ACL vectors.
Reader admission requires a different login and effective role from Writer.

`production75-source.mjs` verifies all19 exact Git SQL blobs at main
`7091af816715cfd437925eb0af82fb47d3411e34`. The first step selects exactly15 missing
CREATE TABLE statements,32 FKs and21 explicit indexes from0000 in source order.
Every selected statement retains its source bytes; rejoining the original
breakpoint delimiter is explicit and hashed. `source-manifest.json` records each
source blob and selected statement index, byte offset, first-byte line and hash.
`selected-0000-bridge.sql` is reviewable execution text. Whole0000 is never replayed.
Unchanged0001/0002 complete the92-statement bridge; unchanged0003–0018 complete142.
There is no enum change, seed, backfill, grant or credential SQL in the executor.

The selected physical75 baseline must match one of the two independently assessed
catalogs. They share logical definitions but differ in physical ordinals and are
separate targets. No target is selected by a table count or logical digest.
Every original ordinal remains unchanged. Expected added-column ordinals and full
logical95/142 definitions come from the frozen canonical source-lineage fixtures;
the local runner independently executes DDL and requires exact full physical
catalog equality before using those expectations.

The executor takes all75 originals under ACCESS EXCLUSIVE locks before its first
repeatable-read data snapshot. It hashes exactly the849 original columns in their
observed physical order, with row counts and serialized-byte bounds. It checks
the complete95 checkpoint without committing, then all142 definitions,13 added
old-row values (11 NULL,2 zero),67 empty new tables and full permission vectors.
Only original `estimates.lead_id` and `projects.lead_id` become nullable. The local
fixture's owner grants are explicit so permission negatives can restore the exact
ACL representation through ordinary GRANT/REVOKE.

One bounded transaction contains either the bridge or the full upgrade. Journal
intents must durably acknowledge before SQL dispatch. Plans and clients are
single-use. Acknowledged COMMIT still requires a distinct read-only Reader login,
effective role and backend.
Lost COMMIT acknowledgment returns `commit-unknown`; a fresh Reader may reconcile
the final schema and fingerprints, while that attempt remains non-replayable.
No automatic retry or target discovery exists. Cross-process one-attempt custody
remains the caller's durable journal responsibility.

Run the focused tests with
`pnpm --filter @workspace/scripts test production75-core.test.mjs production75-local.test.mjs`.
Run native acceptance explicitly with
`node scripts/production75-local.mjs --run-local`. It uses the existing WSL Docker
session helper, an already-installed image, no inherited provider environment and
one uniquely labelled disposable container bound only to127.0.0.1. Removal checks
the exact name, container ID and both ownership labels. If Docker creates the
container but its run response is lost or malformed, cleanup resolves one exact-name candidate,
checks both the full run nonce and task-purpose labels, then recovers its ID.
Ambiguous candidates, changed IDs, mismatched labels or wrong names prevent
deletion. A success response is recorded only if it contains a full valid ID;
empty/malformed responses leave the identity unknown for ownership recovery.
Removal uses the verified ID rather than the mutable container name.
The native proof includes a real network-isolated inert container whose creation
acknowledgment is deliberately discarded, followed by ownership recovery and
exact-ID removal. All clients, sockets and both owned containers must close before
PASS is written.

The current authoritative local receipt is `local-acceptance.json`; immutable
`local-<run-id>.json` receipts and fsync journals retain each attempt. Earlier
failed receipts document ACL representation and temporary startup-server findings;
their containers and clients were cleaned, and later accepted receipts supersede
their implementation proof.

The native cases cover both physical75 variants; two fictional tenants and22
records across9 original tables exercise all original default-bearing tables,
nested JSON/NULL/Unicode, financial values and pending/done/unknown-effect history.
They cover same-count non-key data drift, wrong column type/default, preexisting
new table, original table and column ACL changes, effective Reader permission
loss, wrong physical-ordinal input, unexpected target and unauthorized new-table
grant. Bridge/full rollback, late0002/0018 failures, full commit plus fresh Reader,
bridge-only commit, lost actual COMMIT acknowledgment and stale-plan replay refusal
are checked against real PostgreSQL16.

The generated catalogs, synthetic fixture DDL and `local-policy-*` files are local
review inputs only. They cannot substitute for actual production records, role
policy, application binding or recovery proof.

Final source verification after independent review fixes:
`verification-receipt.json` records28 passing scripts test files/351 tests,
including12 new focused tests. Native run
`90be0806-3986-480d-b7a5-3c9d19299756` passed both variants at
2026-10-11T06:44:16.340Z, with all69 clients/sockets closed, the main owned
container removed by verified ID, and the unknown-ID response-loss probe
independently recovered and removed by verified ID. Its original75 physical hashes are respectively
`2ca3d8dbc10313fb7f23bab2e87f61ad13a21e925664e190c087683aad1daf55` and
`2a56e08b2bd331d0eaedea2d504d3fff568bf4e6aaab2279467cf997648d2009`;
the verified142 physical hashes are
`307fee292bc66d8f9fe11858d9cd8fe2c2983a59563ba867d6ebf50504f3ef6e` and
`2ed9500b5fb077a19aa16003bd346f8369a1b1cb3da8ea8f9a396265b6410f7b`.
Both final logical catalogs are
`f0399b47ba79f843eab66b0fa554923fdd21e26d1e6b22cf62002ec6c353d9fd`.
