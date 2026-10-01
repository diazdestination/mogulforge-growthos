# P0-6 restore drill: preparation, not acceptance

Date: 2026-09-30 EDT. Status: **prepared only**. No backup was restored, no
GrowthOS application was started against restored data, no provider was called,
and no Fly resource was created or changed for this drill.

## Decision boundary

The separate `mogulforge-growthos-staging-db` MPG cluster
(`zp2wjrejd2zodn4q`) is provisioned but currently contains no GrowthOS schema
or meaningful synthetic fixture. Its initial backup cannot demonstrate
GrowthOS recovery. The old, stopped staging app still points at a logical DB
on the production-shared cluster. Neither is an acceptable source for this
drill today. See [staging preflight](../STAGING-PREFLIGHT-2026-09-30.md).

Fly's managed-backup command **always restores into a new, separately billed
cluster**, leaving the source untouched. A short-lived third cluster is thus
necessary to prove recovery from Fly's managed backup/PITR mechanism, but it
should be created **only after** the new staging cluster holds a meaningful,
synthetic-only GrowthOS fixture and a completed backup of it. Restoring the
empty backup now would incur cost without moving P0-6. [Fly CLI reference](https://fly.io/docs/flyctl/mpg/),
[Fly MPG restore announcement](https://community.fly.io/t/fly-mpg-restore-now-supports-naming-and-point-in-time-restore/28464).

A no-third-cluster alternative is a `pg_dump`/`pg_restore` **logical** drill
from that synthetic staging database into a sibling
`growthos_restore_drill` database on the same staging cluster. It can test
application-level logical backup and restore, but it does **not** prove Fly's
managed backup, point-in-time recovery, or cluster-level disaster recovery.
Record it as a narrower rehearsal, not as a managed-backup pass. The final
P0-6 decision must say which recovery mechanism GrowthOS actually depends on.

## Proposed beta recovery objectives

Provisional planning targets: **RPO at most 2 hours** and **RTO at most 4
hours** for database recovery, excluding separately restored object stores or
third-party provider state. These are **targets, not an SLA or achieved
measurements**. Before launch, an operator must confirm Fly's actual backup
cadence/recovery window for the specific cluster and measure a complete drill
from decision to verified application health. Fly says MPG includes rolling
automatic backups and keeps them for ten days; its restore creates a new
cluster. [Fly MPG](https://fly.io/mpg/).

## Synthetic fixture and backup prerequisites

1. Complete the reviewed schema release onto the isolated staging cluster,
   with the app stopped, outbound hold on and scheduler off. Do not copy any
   customer or old staging data into it.
2. Create one clearly named synthetic organization with slug beginning
   `restore-drill-`. Populate synthetic staff membership, lead/contact,
   property, BIE proposal, audit event, project, project story, stored object,
   and an encrypted **fake** Gmail credential record. Add relevant Revenue
   Desk and service-obligation records. No real recipient, token, phone,
   mailbox, provider authorization or customer upload is needed.
3. Use an MPG **Reader** login for the read-only verifier; never use
   `fly-user` or an admin credential for that check. Fly documents Reader as
   read-only across the cluster. Keep the URL in a secure environment source,
   not the shell transcript, repository or drill report. [Fly roles](https://www.fly.io/docs/mpg/cluster-configuration/).
4. Run `scripts/restore-drill-readonly.mjs` against the source synthetic org
   (`RESTORE_DRILL_MODE=source`) and record its non-secret fingerprint. The
   script refuses production's cluster, requires the exact source/target
   database pattern, requires a login without write privileges on core tables,
   uses a read-only transaction, and emits only counts and
   aggregate digests. It fails on an empty or incomplete fixture. It does not
   prove that any backup exists.
5. Record a **completed** backup ID whose creation time is after the fixture
   freeze. `fly mpg backup list zp2wjrejd2zodn4q` is the read-only inventory
   command. Record the backup timestamp and the time of the last fixture
   change to calculate observed RPO. Do not print `fly mpg status` unfiltered;
   its output can include a connection credential.

### Minimum fixture recipe (preparation only; no seed run yet)

Use a single `restore-drill-...` slug and generated IDs inside one transaction
on the **new isolated staging database only**, after its schema review and
release. All identities must use the reserved `.invalid` domain, with no phone
number, no real provider account and no external webhook URL. Set the contact's
do-not-contact flags and keep the global outbound/scheduler holds in place.
The application should create the encrypted fake credential using its own
staging-only key and context; do not insert plaintext or invent ciphertext.

| Order | Required table                   | Minimal dependency and synthetic content                                                                                                         |
| ----- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | `organizations` (fixture anchor) | Unique `restore-drill-...` slug; generated UUID.                                                                                                 |
| 2     | `users`                          | `organization_id` from step 1; `restore.operator@example.invalid`, active test owner.                                                            |
| 3     | `contacts`                       | Same organization; `homeowner@example.invalid`, all do-not-contact flags true.                                                                   |
| 4     | `properties`                     | Same organization; optional `contact_id` from step 3; clearly fake address and postal code.                                                      |
| 5     | `leads`                          | Required `contact_id` from step 3; `property_id` from step 4; synthetic source, no outreach.                                                     |
| 6     | `bie_action_proposals`           | Required `lead_id` from step 5; `create_task` proposal in `proposed` state with synthetic rationale. No execution.                               |
| 7     | `audit_events`                   | Same organization; synthetic actor from step 2 and entity ID from step 5.                                                                        |
| 8     | `projects`                       | Required `lead_id` from step 5; no estimate dependency if `estimate_id` stays null.                                                              |
| 9     | `project_stories`                | Required `project_id` from step 8; version 1, synthetic body/source reference, draft state.                                                      |
| 10    | `stored_objects`                 | Explicit generated UUID, same organization, small deterministic text payload in `bytea`, matching content type and byte length. No real upload.  |
| 11    | `gmail_connections`              | Same organization and step-2 user; `.invalid` email, **fake** encrypted refresh value, no granted scopes, revoked state. Never authorize Google. |

The read-only verifier requires nonzero rows in the ten tables in steps 2–11;
`organizations` supplies its scope. This is only the minimum gate against an
empty restore. For full P0-6 evidence, also seed and check an inert
`revenue_executions` row with its `revenue_execution_events` trail, a
`value_entries` row tied to the synthetic lead, and an inert
`service_obligations` row if its required CRM-task dependency has been
prepared. `decision_rooms` requires a linked estimate, so include it only
through the reviewed application workflow; do not fabricate an estimate to
make counts green. The verifier reports counts for these extra tables but
does not require them, so a passing fingerprint alone cannot establish
Revenue Desk or customer-workflow recovery.

No direct seed script is shipped at this point. The fake Gmail ciphertext
depends on `OAUTH_TOKEN_ENCRYPTION_KEY` plus the precise
`<organizationId>:<userId>:gmail` context, several rows have FK/enum
dependencies, and the isolated staging schema is not yet applied. Docker is
unavailable on this host for an offline PostgreSQL insertion test. A script
written now would have untested write behavior against a real remote database;
that is a poor trade for this release gate. Use this recipe during an
operator-reviewed fixture build after a local/isolated PostgreSQL test is
available, then record its exact schema SHA and inserted IDs in a private
evidence location without putting emails, tokens or media into Git.

Example verifier configuration (the database URL is intentionally omitted):

```powershell
$env:RESTORE_DRILL_MODE = 'source' # later: logical or managed
$env:RESTORE_DRILL_EXPECTED_LOGIN = 'growthos-restore-reader'
$env:RESTORE_DRILL_SYNTHETIC_SLUG = 'restore-drill-fixture-1'
# Supply RESTORE_DRILL_DATABASE_URL through an approved secret channel.
# For logical/managed targets also set RESTORE_DRILL_EXPECTED_FINGERPRINT
# to the 64-character fingerprint recorded from the source.
# For managed mode also set RESTORE_DRILL_EXPECTED_CLUSTER_ID to the exact
# new cluster ID reported by the authorized Fly restore operation.
node scripts/restore-drill-readonly.mjs
```

## Rehearsal A: no additional cluster (limited assurance)

An authorized operator creates **only** the new logical
`growthos_restore_drill` database on the already isolated staging cluster,
then takes a custom-format logical dump of the synthetic source and restores
it into that database with `pg_restore --exit-on-error --no-owner --no-acl`.
Use a database-specific dump, never a whole-cluster dump. Ensure the dump file
is encrypted, access-limited, excluded from Git and securely removed after
the evidence window. `pg_dump` is a new logical backup, **not** a Fly managed
backup. The verifier must run in `logical` mode and match the source
fingerprint before app boot. Exact `pg_dump`/`pg_restore` connection commands
must be filled in by the operator using the approved proxy/direct connection,
matching PostgreSQL client version and non-production URLs. Do not aim a
restore at `growthos_staging` or production.

This path can provide a useful no-third-cluster rehearsal but leaves the
managed-backup recovery gate unproved.

## Rehearsal B: Fly managed-backup restore (fuller assurance)

After the prerequisites and a recorded cost/time boundary, an authorized
operator selects the completed backup ID and invokes:

```text
fly mpg restore zp2wjrejd2zodn4q --backup-id <COMPLETED_SYNTHETIC_BACKUP_ID> --name <UNIQUE_TEMP_RESTORE_NAME>
```

This asynchronously provisions a **new, billable cluster**. Confirm its new
cluster ID and `ready` state without exposing its connection URL/password.
Use a Reader login and run the verifier in `managed` mode against its restored
`growthos_staging` database, with the source fingerprint supplied. The
verifier requires the exact new cluster ID and rejects both the production and original staging cluster as a
`managed` target. A passing fingerprint proves the selected synthetic rows
match; the backup ID, Fly operation and new cluster ID must still be recorded
separately. Stop and investigate any mismatch before starting the app.

The temporary cluster must not be silently left running. After evidence is
captured and an authorized operator confirms its exact ID and that no app
depends on it, use Fly's controlled deletion path; document the time it was
created and removed and the actual/prorated charge. Do not delete the source
staging cluster.

## Same-release and credential acceptance (both rehearsals)

The read-only verifier is a pre-boot integrity check, **not** a substitute for
starting GrowthOS. A later operator must run the **same exact release SHA and
image digest** against the restored target with `AUTO_MIGRATE=false`,
`SCHEDULER_AUTOSTART=false`, `GROWTHOS_OUTBOUND_HOLD=true`,
`STAGING_OUTBOUND_APPROVED=false`, no live provider credentials, no public
routing and only synthetic identities. Check health and read the restored
synthetic organization, lead, property, BIE, Revenue Desk, audit and project
room through the application. Record the SHA, image digest, environment,
start/health timestamps and any database writes made by startup seeding.

**Unresolved safety detail:** the current staging boot guard pins the staging
app identity to the original isolated staging cluster. A restored cluster
cannot be started under that same staging identity. An alternate app identity
would bypass that guard and therefore needs an explicit restore-only identity
guard and an operator-reviewed, no-send startup configuration before this
step. The current app also performs idempotent startup seeding; inspect the
restored data with the read-only verifier **before** boot. Do not claim this
step passed based on the verifier alone.

With synthetic ciphertext and secure original key references, prove positive
decryption with the correct `OAUTH_TOKEN_ENCRYPTION_KEY`/record context and
negative decryption with a wrong key/context. Where synthetic webhook secrets
or retained email content are included, also test their distinct
`SESSION_SECRET` and `EMAIL_INTELLIGENCE_ENCRYPTION_KEY` contexts. Never log
plaintext, tokens, ciphertext, or keys. The verifier deliberately does not
decrypt anything. A database backup is not a backup of these environment
secrets; their secure recovery is a separate operator dependency.

## Evidence required to mark P0-6 green

- Exact source backup ID/type/time, source cluster and synthetic fixture
  freeze time; automatic-backup status and observed RPO.
- Isolated target cluster/database/login, restoration start/end and measured
  restore time; actual billing interval if the managed path was used.
- Source and target verifier fingerprints/counts, with no PII or credentials.
- Same GrowthOS SHA/image boot, health and application-level record checks;
  measured end-to-end RTO.
- Positive **and** negative credential-context decrypt checks, without secret
  disclosure; customer/project-room/media verification.
- Operator name, date, failures/remediation, safe cleanup and independent
  review. Any missing line means P0-6 remains open.

`scripts/restore-drill-readonly.test.mjs` covers the parser, production-host
rejection, target-mode separation, missing/empty fixture, session identity,
fingerprint comparison and redacted output with a mocked SQL client. It is
**code/test evidence only**; it does not show an actual database restore.
