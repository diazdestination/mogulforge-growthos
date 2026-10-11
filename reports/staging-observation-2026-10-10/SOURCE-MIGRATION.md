# Existing staging migration operator

The managed-copy rehearsal has passed. `scripts/staging-source-migration.mjs`
prepares a separate packet for the existing staging database; it never reuses
the consumed copy authority. It imports the same tested migration core and exact
main7091af8 SQL. It cannot create/delete a provider resource, publish an image,
update/start the application or target production SQL.

`--prepare` uses provider GETs and Reader/admin READ ONLY transactions. It pins
the exact95 catalog, all current data fingerprints, permissions, accepted admin
policy, latest completed backup, protected original database/Machine metadata,
code/tool hashes and the successful managed-copy recovery receipts. The prepared
approval is false. The original staging application must be stopped with manual
start and delivery holds.

`--execute` first requires the separate owner approval of that exact packet.
One exclusive attempt directory prevents replay. It refreshes Reader baseline,
admin policy, backup presence/freshness and protected metadata before the write
session. Current approval and code hashes are rechecked at durable dispatch
boundaries. Writes have a12-minute work budget; a3-minute reserve covers fresh
Reader reconciliation and cleanup. The transaction itself is capped at3minutes
and packet expiry. The operator runs0003–0018 once and uses the migration core's
original-table locks, complete precommit checks and durable journal.

Acknowledged COMMIT requires a different fresh Reader proving all142 definitions,
original data/ACL/permissions,26 defaults and47 empty new tables. A failed
precommit transaction is rolled back; fresh95 preservation is checked. An
unacknowledged COMMIT is independently observed and held for review; no DDL,
COMMIT, destructive down migration or overwrite restore is retried. The app
remains stopped throughout. Unknown state or cleanup failures cannot become PASS.

This is an execution mechanism and review contract, not owner approval. Private
live baseline, recovery and authority receipts stay under
`C:\Forge\artifacts\growthos-staging-release-20261010`; they are not committed.
Freshness or input drift requires a newly prepared/reviewed packet. Do not edit
an expired packet's timestamps or weaken its guards.

Validation:8 source-admission/drift/target tests,14 migration-core tests,
339 complete scripts tests; independent review accepted the final source after
authority-expiry and shared-budget corrections. The false-approval live command
refused before provider access and attempt creation. Source execution on the
actual staging database remains pending owner authority and release evidence.
