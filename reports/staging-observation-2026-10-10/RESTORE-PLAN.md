# Managed-backup recovery test — comparison and cleanup passed

October 10, 2026. Adam approved one temporary restore test, estimated at about
$0.15 for up to two hours. That approval was used to create exactly one copy;
this record grants no additional creation or spending authority. The estimate
was not a provider-enforced ceiling or a final bill.

## Exact resource and recovery point

Account: `diazdestination@gmail.com`; organization: `adam-diaz`.
Source: staging cluster `zp2wjrejd2zodn4q`, database `growthos_staging`,
PostgreSQL 16 in `iad`. Production cluster `kzpwm0j18eg04nv3` and both existing
source databases were excluded from mutations.

The selected completed backup was `20261010-000144F_20261010-130422I`, finished
at 13:04:24 UTC, with full ancestor `20261010-000144F` and recorded backup size
44,679,704 bytes. This tests that full-plus-incremental chain. It is not a PITR
test. The source application-table baseline was observed at 13:14:51–13:15 UTC.

Exactly one Basic-plan copy was created in `iad`:

- ID: `nlkxjo5w1x8oy93v`
- Name: `growthos-recovery-check-20261010-01`
- Created: `2026-10-10T13:21:20Z`
- Cleanup deadline: `2026-10-10T15:21:20.719Z`
- Organization: `adam-diaz`; attached applications: none

The one-time create request restored the named backup into this isolated copy.
The ownership and attempt receipts pin the original source, excluded production
ID, approval, name, creation time, plan, region, and cleanup deadline. Unknown
creation outcomes must be reconciled; the consumed create request must not be
replayed. Credentials stayed in the existing CLI/provider credential route.

## Observed result

The independent Reader comparison ran from 13:25:00 to 13:25:34 UTC. All six
comparisons passed:

1. Logical application catalog matches the source.
2. Physical application catalog matches the source.
3. All 95 application-table row counts and complete-row digests match: 65 rows,
   38,878 serialized bytes.
4. Privilege metadata matches.
5. Extension-object metadata matches.
6. Unresolved findings match and remain explicit.

The restored copy's existing Reader credentials and an owned loopback Fly proxy
were used. No source writes were issued. No monitoring view was queried, no
provider audit function was invoked, and no raw customer rows were recorded.
Rollback, client end, socket closure, proxy exit, and listener removal were
acknowledged. The saved result is `application_database_recovery_passed` with
`managedBackupRecoveryPassed: true`.
Independent review confirmed the saved comparisons and all 95 fingerprints.
The restore receipt SHA256 is
`66794693202c1758cb4747f1556280ae5e42c5744071ee5c8fa86e8cccc4a724`.

This proves the selected managed backup recovers the observed 95-table
application database. It does not establish permission-policy acceptance,
full cluster-data coverage, PITR, decryptability with independently recovered
keys, legacy external-object recovery, an accepted RPO/RTO, or recovery of the
unmigrated 142-table candidate.

## Verified cleanup

The reviewed operator rechecked exact ownership, current identity, Basic plan,
region, organization, creation time, and no attachments before writing a durable
delete intent. It issued exactly one DELETE, acknowledged with HTTP 202.

Fly retained a GET-visible record with HTTP 200 and terminal status `deleted`.
The initial checker required HTTP 404 and therefore conservatively recorded
cleanup as unconfirmed. Its subsequent reconciliation also rejected the retained
record; neither result was overwritten or represented as successful deletion.
No DELETE was retried.

A separately reviewed read-only reconciliation finished at
`2026-10-10T13:36:17.487Z`. It verified terminal provider status `deleted`, a fresh
active-cluster list containing only the original source and production IDs, and
unchanged source/stopped-app configuration against the original pre-delete
snapshot. Transport cleanup was acknowledged. The final status is
`verified_deleted_and_absent_from_active_list`; this reconciliation issued zero
mutations, and `get404` is false.

Creation to verified cleanup took less than 15 minutes, within the approved
two-hour window. This elapsed observation is not an accepted recovery-time
objective. Final billing and charges remain unverified.

## Boundaries and evidence

No migration rehearsal, source DDL, role grant, secret rotation, deployment,
application startup, provider delivery, or public launch occurred. The hosted
source remains on the 95-table schema. The reviewed `0003`–`0018` migration,
encryption-key recovery, and actual application acceptance are separate gates.

Private receipts are under `C:\Forge\artifacts\growthos-db-recovery-20261010`:

- `recovery-point-selection.json`
- `restore-create-attempt.json` and `restore-owned-copy.json`
- `restore-observation-2026-10-10T13-25-00-320Z.json`
- `restore-final-reconciliation-2026-10-10T13-36-04-737Z.json`

The actual create and cleanup operators are private, exact-target artifacts;
this checked-in record is not a reusable hosted mutation operator.

Primary references checked October 10:

- [Managed PostgreSQL pricing](https://docs.fly.io/postgres#pricing)
- [Fly managed restore command](https://docs.fly.io/flyctl/cmd/fly_mpg_restore)
- [Restore a backup into a new cluster](https://docs.fly.io/api/machines/postgres-clusters/restore-backup-or-point-in-time-to-new-cluster)
- [Delete a PostgreSQL cluster](https://docs.fly.io/api/machines/postgres-clusters/delete-postgres-cluster)
