# P0-6 restore drill: plan and dated acceptance

## Hosted outcome — September 30 evening (October 1 UTC)

The planned managed recovery was actually exercised on application candidate
`c050067`. A completed full backup of two inert synthetic organizations was
restored into temporary MPG cluster `dzx6qo652zg0jpv5`. Both source/recovered
fingerprints matched; record graphs, private-file bytes, actual credential
decryption and wrong-key/context rejection passed. The same compiled API
booted with a Reader and passed nine authenticated reads, private-file
retrieval, four cross-tenant denials and five write/authentication denials.

Successful inspection completed at `2026-10-01T03:42:18.499Z`; the full-backup
start was `03:25:16Z`. That 17-minute 2.499-second exercise window includes
diagnostic retries and is not a contractual RTO. No frozen fixture data was
lost; continuous-production RPO is not measured by a frozen sample.

Fly regenerated the Reader password on restore. The recovered credential was
retrieved securely for that exact target, never reused from the source or
written to Git. Cleanup was verified: temporary cluster deleted, no attached
apps, only the original production and isolated staging clusters remain;
temporary credential/bearer references removed. No provider was called.

See [the current evidence ledger](controlled-pilot-2026-09-30.md) for backup ID,
image/bundle hashes, fingerprints, failed-attempt diagnosis, cleanup and
remaining release gates. The original plan below is historical context, not a
request to repeat provisioning or an assertion that the source is still empty.

## Original preparation record

Date: 2026-09-30 EDT. Status: **tools tested locally; hosted acceptance still required**.
The guarded fixture builder, read-only fingerprints, real application credential
decryption, private-media checks and restore-only startup guard are implemented.
Disposable PGlite tests insert the fixture using the current generated schema,
load a separate recovered local copy and exercise actual authenticated application
reads without changing tenant records. No Fly managed backup or hosted restore
was performed by this preparation work, and no provider was called.

## Decision boundary

The separate `mogulforge-growthos-staging-db` MPG cluster
(`zp2wjrejd2zodn4q`) now contains the **90-table reviewed schema**. The app
writer and Reader have been checked/staged without starting the app. The
old Machine remains stopped; its staged database change has not yet been
consumed. A meaningful synthetic fixture, post-fixture backup and completed
recovery checks are still required before a restore can pass. The initial
empty backup is not sufficient. See the newest
[controlled-pilot evidence](controlled-pilot-2026-09-30.md) and
[staging preflight](../STAGING-PREFLIGHT-2026-09-30.md).

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

### Tested fixture builder (run only on the isolated source)

`scripts/restore-drill-fixture.mjs` now implements the fixture below. It accepts
only the pinned isolated source cluster, `growthos_staging` database and
`growthos-staging-live` writer. It checks the SQL session before inserts, takes
an advisory transaction lock, rejects a database containing nonfixture
organizations, and verifies the complete fixture before commit. A repeat run
leaves IDs, timestamps, ciphertext and receipts unchanged. A partial or changed
fixture fails and rolls back; it does not repair or overwrite existing data.

The script builds 19 connected application records, including a deliberately
unsent draft estimate and a labelled synthetic decision-room snapshot. The
snapshot is not current customer-approved scope. The one financial entry is
a labelled synthetic direct cost, never a recovered-revenue claim. The BIE
proposal is rejected, execution receipt blocked, service obligation and task
cancelled, Gmail credential revoked, and contact DNC flags all true. A private
Postgres object is linked to the lead through a synthetic `photos_attached`
activity so real application authorization and byte streaming can be tested.

The fake Gmail value is encrypted through the application's actual
`token-encryption.ts` implementation with the precise
`<organizationId>:<userId>:gmail` context. A separate
`scripts/restore-drill-acceptance.mjs` uses an actual Reader login and read-only
transaction to verify the expected graph, exact stored bytes, successful
decryption, rejected wrong-key/wrong-user decryption and inert outbound states.
It emits booleans and target metadata only. It explicitly reports
`appBootVerified: false`; SQL/application-data acceptance alone is not a boot.

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
| 6     | `bie_action_proposals`           | Required `lead_id` from step 5; `create_task` proposal in `rejected` state with synthetic rationale. No execution.                               |
| 7     | `audit_events`                   | Same organization; synthetic actor from step 2 and entity ID from step 5.                                                                        |
| 8     | `projects`                       | Required `lead_id` from step 5; no estimate dependency if `estimate_id` stays null.                                                              |
| 9     | `project_stories`                | Required `project_id` from step 8; version 1, synthetic body/source reference, draft state.                                                      |
| 10    | `stored_objects`                 | Explicit generated UUID, same organization, small deterministic text payload in `bytea`, matching content type and byte length. No real upload.  |
| 11    | `gmail_connections`              | Same organization and step-2 user; `.invalid` email, **fake** encrypted refresh value, no granted scopes, revoked state. Never authorize Google. |

The read-only fingerprint now also requires `estimates`, `crm_tasks`,
`activities`, `revenue_executions`, `revenue_execution_events`,
`decision_rooms`, `value_entries` and `service_obligations`. An empty or
partial Revenue Desk/service fixture cannot pass. Webhook endpoints stay
empty; this fixture does not need a live webhook, outbound campaign or provider.

Use a staging-only encryption key from a secure environment source. Keep the
same key for source and target checks; losing it is a failed secret-recovery
dependency even if the database rows restore. To run the builder after the
reviewed source schema is applied, set the following nonsecret controls:

```powershell
$env:RESTORE_DRILL_MODE = 'source'
$env:RESTORE_DRILL_EXPECTED_LOGIN = 'growthos-staging-live'
$env:RESTORE_DRILL_SYNTHETIC_SLUG = 'restore-drill-pilot-a'
$env:RESTORE_DRILL_SEED_APPROVED = 'true'
$env:RESTORE_DRILL_USE_FLY_PROXY = 'true'
$env:GROWTHOS_OUTBOUND_HOLD = 'true'
$env:STAGING_OUTBOUND_APPROVED = 'false'
$env:SCHEDULER_AUTOSTART = 'false'
# Securely supply RESTORE_DRILL_DATABASE_URL and OAUTH_TOKEN_ENCRYPTION_KEY.
# Optional: supply RESTORE_DRILL_SESSION_BEARER as fresh random 64-128 hex
# characters in secure environment storage, never the terminal transcript.
node scripts/restore-drill-fixture.mjs
```

The optional bearer prepares a 48-hour synthetic inspection session before the
backup, enabling read-only authenticated HTTP acceptance afterward. The builder
never prints it, never overwrites a colliding session, and never extends its
expiry on retry. Keep it in the operator's secure evidence location and complete
the restore inside that interval. A stale session requires a new reviewed
source fixture session and newer backup; the restored Reader account cannot
mint one. The no-password synthetic staff account cannot use normal login.

Repeat with a separate `restore-drill-pilot-b` slug and separate inspection
bearer to prepare a second isolated tenant. Do not use actual contractor data
for the backup drill. Record the last successful fixture freeze timestamp;
the completed backup must be newer than both tenants and any prepared session.

Example verifier configuration (the database URL is intentionally omitted):

```powershell
$env:RESTORE_DRILL_MODE = 'source' # later: logical or managed
$env:RESTORE_DRILL_EXPECTED_LOGIN = 'growthos-restore-reader'
$env:RESTORE_DRILL_SYNTHETIC_SLUG = 'restore-drill-fixture-1'
$env:RESTORE_DRILL_USE_FLY_PROXY = 'true'
# Supply RESTORE_DRILL_DATABASE_URL through an approved secret channel.
# For logical/managed targets also set RESTORE_DRILL_EXPECTED_FINGERPRINT
# to the 64-character fingerprint recorded from the source.
# For managed mode also set RESTORE_DRILL_EXPECTED_CLUSTER_ID to the exact
# new cluster ID reported by the authorized Fly restore operation.
node scripts/restore-drill-readonly.mjs
# With the same original staging-only encryption key in secure env:
node scripts/restore-drill-acceptance.mjs
```

Keep the canonical `pgbouncer.<cluster>.flympg.net` URL even on the workstation.
Private DNS is not normally available there. The opt-in proxy helper starts its
own `fly mpg proxy <validated-cluster>` process bound to `127.0.0.1` on a free
port, derives the database/login from the guarded canonical URL, and closes its
proxy on completion. Arbitrary localhost URLs and URL query host overrides are
rejected. Only the documented TLS `sslmode=require` query is accepted. The
source/target production-cluster rejection is unchanged. This avoids silently
trusting whatever an independently started proxy happens to forward to.

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

The ordinary staging identity remains pinned to its original isolated cluster.
A separate restore-only boot path now requires **all** of the following:

```text
FLY_APP_NAME=mogulforge-growthos-restore-drill
RESTORE_DRILL_ONLY=true
RESTORE_DRILL_MODE=managed  # or logical
RESTORE_DRILL_EXPECTED_CLUSTER_ID=<exact target cluster ID>
HOST=127.0.0.1
PORT=3001
APP_ORIGIN=http://127.0.0.1:3001
AUTO_MIGRATE=false
SCHEDULER_AUTOSTART=false
GROWTHOS_OUTBOUND_HOLD=true
STAGING_OUTBOUND_APPROVED=false
OBJECT_STORAGE_PROVIDER=postgres
```

Supply `DATABASE_URL` for the exact target and the
`growthos-restore-reader` login plus the original synthetic application key
references and a separate session secret through the secure environment.
The guard rejects the production cluster, managed mode aimed at the source,
wrong database/login, writable table/schema/admin privileges, missing holds,
public listeners/origins and provider environment credentials. Only original
application decryption keys and a local session secret are allowed. The server
skips migration, scheduling, platform-admin grants and every normal startup
seed specifically under this verified restore mode. Ordinary staging behavior
and its host pin are unchanged.

Run the same release image as an isolated private process where the canonical
Fly database hostname resolves (for example an operator-reviewed temporary
Machine without public service routing). Inspect it through SSH/local port
forwarding. This is a concrete startup configuration, **not** evidence that a
hosted app has already booted or authorization to leave extra resources running.
The private HTTP guard rejects write methods and authentication/provider/public
intake routes. Use the prepared synthetic session for authenticated GETs of:

- `/api/healthz` and the normal release/readiness surface;
- `/api/v1/contacts/<fixture contact>`, `/leads/<fixture lead>` and `/projects/<fixture project>`;
- `/api/v1/revenue/desk`, `/revenue/rooms/<fixture lead>`, `/revenue/value`,
  `/revenue/evidence/<fixture lead>` and `/revenue/executions/<fixture execution>`;
- `/api/v1/storage/objects/uploads/<fixture object>` and exact stored-byte comparison.

Use Tenant A's session against Tenant B's record/room/object IDs and require 404. Verify PATCH/POST and login/OAuth/intake routes return 405. Re-run the
fingerprint before and after acceptance and require no data change. Expired
sessions must fail; do not broaden the Reader's privileges to accommodate them.
`restore-app-readonly.test.ts` exercises these real routes locally with two
synthetic organizations and compares all organization-table digests. It is
application code/SQL acceptance; the dated same-image hosted boot is still due.

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

The script tests cover parser/production rejection, owned proxy lifecycle,
target separation, reader/session identity, empty/incomplete fixture,
transaction rollback, idempotence, redaction, real source-schema insertion,
two synthetic tenants, a separately recovered PGlite copy, and ciphertext/media
integrity. Restore-mode/API tests cover guarded startup prerequisites, actual
authenticated application reads, tenant denials and blocked mutations. These
are **local code/test evidence**, not a Fly-managed restore or production proof.
