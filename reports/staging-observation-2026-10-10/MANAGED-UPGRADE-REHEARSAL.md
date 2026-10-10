# One temporary managed-copy upgrade rehearsal

The next test restores one recent completed staging backup into an unattached
Basic Fly database, rehearses and rolls back the exact 95-to-142 upgrade, then
commits the same sequence on that copy and checks it through a fresh Reader.
The copy is deleted after either outcome. Source staging stays at 95 tables
with its original application Machine stopped. Production database contents
are outside this test.

This new financial action needs a new explicit owner approval. Earlier one-copy
restore and one-Machine secret-recovery grants were consumed. The reviewed
operator has no source-migration or application-start authority.

## Accepted preparation

Application SQL is pinned to main `7091af816715cfd437925eb0af82fb47d3411e34`.
Observer source is draft PR33 at `72b9166`. The new import-safe migration core
and actual PostgreSQL 16 acceptance are documented in
[the local evidence](upgrade-fixtures/README.md). The baseline permission policy
is accepted in [the separate review](PERMISSION-POLICY-REVIEW.md).

The core checks all 95 original-table fingerprints, permitted physical-column
changes, all 26 legacy defaults, 47 empty new tables, original ACL preservation,
284 resulting table-privilege entries and 3,734 column-privilege entries. Lost
COMMIT acknowledgments remain unknown and are never replayed automatically.
Every phase uses a durable journal; successful commit acceptance requires a
subsequent check through a distinct Reader backend.

The managed adapter was independently reviewed. Pure and mocked tests cover
unapproved/expired/changed plans, protected target refusal, copy attribution,
exact restore payload, lost DELETE acknowledgment, journal failures, terminal
deletion evidence, protected-state drift and independent transport cleanup.

## Preparation and execution

```powershell
node scripts/staging-copy-rehearsal.mjs --prepare
# Only after Adam approves the exact prepared paid-copy plan:
node scripts/staging-copy-rehearsal.mjs --execute
```

Preparation verifies the active Fly identity `diazdestination@gmail.com`,
organization `adam-diaz`, staging `zp2wjrejd2zodn4q`, Basic plan, iad, PostgreSQL16,
ready status and the stopped original Machine's complete configuration/instance.
It picks a completed backup under two hours old and writes content-free
`plan.json` and `approval.json` with `ownerApproved:false` under
`C:\Forge\artifacts\growthos-upgrade-rehearsal-20261010`.

The production cluster `kzpwm0j18eg04nv3` is a legacy provider-generation1
resource. Its newer detail endpoint returns 404 while the current CLI inventory
lists it ready. Preparation therefore pins an exact allowlisted CLI inventory
snapshot, including account/org, identity, status, plan, region and attachments.
Every protected-state comparison obtains a fresh inventory. This is production
metadata preservation, not a SQL or data-content check. The original rejected
metadata-only preparation is preserved in `preparation-attempts.json`.

The plan expires after four hours. Approval binds its digest and source hashes,
one copy, no source writes and a 120-minute operation window: 90 minutes of work
plus 30 minutes reserved for cleanup. The estimated charge is about USD0.15 for
two hours; actual Fly metering is not a hard budget cap. Official references:
[pricing](https://docs.fly.io/postgres#pricing) and
[restore endpoint](https://docs.fly.io/api/machines/postgres-clusters/restore-backup-or-point-in-time-to-new-cluster.md).

Before enabling the prepared approval file, record Adam's explicit approval
of this exact scope in the durable execution record. A timeout never counts as
approval. Do not edit the plan to bypass expiration or source drift; preserve
the obsolete packet and prepare/review a replacement.

Execution reserves an exclusive attempt directory before provider work. It
captures source data READ ONLY, makes one restore POST and attributes the new
copy using its unique name, creation window, absent prior ID, account/org,
region, plan, PostgreSQL version and lack of attached applications. The source
and production IDs can never be a migration or deletion target. A lost creation
response triggers bounded read-only reconciliation, not another POST.

The copy must match the original 95-table baseline and accepted administrative
policy before DDL. After rollback and commit/fresh-Reader verification, source
data and metadata are recaptured. Each SQL and provider phase is bounded.
Cleanup gets its own time window and attempts to close the owned client, proxy
and agent. A source-state change is reported but does not strand a positively
owned temporary copy.

One DELETE intent is journaled before dispatch. Lost acknowledgments lead only
to bounded GET/inventory reconciliation. Deletion requires terminal `deleted`
or HTTP404 together with absence from the active list; HTTP410 alone is not
accepted. The two originals must remain listed. Uncertain ownership or cleanup
is an explicit failure requiring reconciliation, never a new create/delete loop.

No receipt includes row values, provider credentials or recovered keys. Live
receipts remain outside Git. Only synthetic local evidence is checked in.
After this rehearsal passes, migration of the actual staging database and the
held application update require their own reviewed execution packet and authority.
