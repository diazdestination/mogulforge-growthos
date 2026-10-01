# Controlled contractor pilot — September 30–October 1, 2026

This is the launch evidence ledger, not a statement that a client is live.
The owner asked to finish the controlled-pilot preparation. Work is restricted
to private GrowthOS, its isolated staging environment, and synthetic records.
Production, Painless and HVAC customer databases have not been changed.

**Current state at October 1, 04:04 UTC:** isolated staging is running the
verified `c050067` image with outbound delivery, automatic migrations and the
normal scheduler held. Managed recovery, source scheduler timed cycles,
graceful worker restart and a bounded crash-after-task drill passed. No client
traffic or real-provider acceptance is authorized or established. The temporary
third database cluster is deleted. First-client/test-identity choices remain
outstanding; see the remaining gates at the end of this ledger.

## Scope and success criteria

Start with one contractor and staff-owned test contacts. Keep the roofing and
HVAC organizations, Smart Site installation keys, sending mailboxes, phone
bindings and consent records separate. The named agents are workflow entry
points, not a promise of autonomous work beyond tested capabilities.

| Workflow                           | Required acceptance before enabling for clients                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Smart Site lead capture            | Correct tenant receives a test lead, source, consent and one staff follow-up; duplicate submit does not create another lead or action.                                                                                                |
| Imported customers                 | Review a small CSV first; verify dates, equipment, owner and source; import does not imply marketing consent.                                                                                                                         |
| CALLIE missed-call recovery        | A controlled call creates exactly one correct-tenant callback task; answered calls do not; SMS stays off until that client's sender and consent checks pass.                                                                          |
| APPT appointment reminders         | Correct timezone, staff calendar/booking ownership, confirmation/reschedule and duplicate protection. No promise of calendar sync unless separately connected and tested.                                                             |
| MAINTAIN service/warranty          | Verified service obligations create the right staff task before due date. Customer reminder automation is a separate gate; do not claim staff-task creation automatically notifies a customer or preserves a manufacturer's warranty. |
| Lead follow-up and campaigns       | Explicit contractor Gmail sender, contact eligibility, sending hours, opt-out and pause; approve a small segment and copy before any campaign.                                                                                        |
| ESTI / BILL / INVO / SCHED / SCOUT | Staff-reviewed proposals, records and next actions only where implemented. No autonomous quoting, charging, collections, route optimization or revenue guarantees implied.                                                            |

Pilot exit criteria: all selected test cases pass, the contractor can find new
leads and overdue work without assistance, failures have an owner, and every
external action has a visible record. Launch only the workflows whose rows
have dated evidence; keep others disabled or clearly labeled assisted.

## Fresh provider inventory

Authenticated read-only checks this turn established:

- Resend: `mogulforge.ai` and `updates.mogulforge.ai` are verified sending
  domains. A key named **GrowthOS Staging Identity Email** exists. Presence is
  not proof that the app's stored key matches or can send.
- Resend has **no configured webhooks**. The account also has an unrelated
  product; do not retain or apply unrelated product events in GrowthOS.
- Google Cloud project `mogulforge-growthos-staging` has Gmail API enabled and
  one web OAuth client. Its redirect is exactly
  `https://mogulforge-growthos-staging.fly.dev/api/v1/integrations/gmail/callback`.
- Google OAuth is External / Testing with two existing test users. Configured
  scopes are `openid`, user email/profile and `gmail.send`; no restricted
  Gmail-read scope is configured. Branding is incomplete for publication.
  Two enabled secrets are listed; neither was exposed or rotated. Match the
  app's active secret through an actual approved OAuth test before retiring one.
- No OAuth consent grant, mailbox connection, email, text, call, campaign,
  registration, forwarding change or provider fee was submitted in this check.

Google testing mode is suitable only for the listed test audience, not general
customer onboarding. An approved pilot mailbox must be added if needed and its
owner must grant the actual consent. Do not infer permission from the browser
account that happens to be signed in.

## Isolated database bootstrap — completed

The new cluster `zp2wjrejd2zodn4q` / `mogulforge-growthos-staging-db` is separate
from production `kzpwm0j18eg04nv3`. Immediately before application, read-only
inspection confirmed zero application tables in `growthos_staging` and the
only staging app Machine `8d96936a03d058` was stopped.

`scripts/pilot-staging-bootstrap.mjs --apply-reviewed-schema` applied the two
reviewed, hash-pinned SQL files in one transaction. It confirmed **90 tables**
before committing. The second file adds only the nullable contractor sender
reference and its FK. The operation cannot accept another target, URL or SQL
file and refuses a nonempty database. Six regression tests cover its guards,
rollback and redacted output. No app was started by this operation.

| File                                | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| `0000_isolated-staging-initial.sql` | `b27d33a59a8a0f083fefe3271936d197309db5d683bd4254bbd28d7bc7315a10` |
| `0001_pilot-email-sender.sql`       | `8d2d49f344e4900e5304d1f7b23ce23b929121f9af04362d50902a692605883f` |

The script obtains the selected Fly admin credential in memory and owns its
loopback proxy. It never prints/stores that credential. This bootstrap is not
a restore drill, scheduler proof, or permission to run `drizzle push --force`
on a populated environment.

The staging application login was independently connected through an owned
Fly proxy and verified against the 90-table database. The exact isolated
`DATABASE_URL` is now staged with `fly secrets import --stage`, without
starting/deploying the app or exposing credentials. `pilot-staging-connection`
uses the installed CLI's MPG **v2** credential endpoint (not the legacy v1
cluster endpoint), validates the target at both source and secret sink, and
has 39 mocked transport/secret-handling tests. Existing provider, OAuth and
session secrets were not rotated. The stopped app's old running configuration
is not evidence that the pending secret has been consumed yet.

The runtime login has now been reduced from `schema_admin` to **Writer**. A
separate `growthos-restore-reader` login was created with **Reader**, and its
connection is securely staged as `RESTORE_DRILL_READER_DATABASE_URL` for the
private recovery harness. Schema ownership was not transferred to the app.
The two synthetic-session/decryption checks never require a live mailbox.

The authenticated cluster dashboard initially showed Transaction pooling.
Changing to Session returned a success notice; immediate read-back lagged the
change. A later fresh navigation confirmed **Session selected**. This is
configuration evidence, not yet independent-session locking or a running
scheduler. Keep `SCHEDULER_AUTOSTART=false` until those checks pass.

## Release candidate and operator controls

Application candidate: `c050067000f3ea1f2d94aa53b3a9c4f71f0d3b41`.
The remote production-image build succeeded and pushed
`registry.fly.io/mogulforge-growthos-staging:growthos-c050067`, digest
`sha256:0111edc86aaf844e83b0250be7a9deb7accf604d983a66dfbe876f7cd03a42ce`.
This was **build-only**, not app deployment. Exact-head CI run
[`36809476022`](https://github.com/diazdestination/mogulforge-growthos/actions/runs/36809476022)
**passed** on that full SHA: all test suites, workspace TypeScript, both builds
and Docker staging parity. The parity step reported
`DOCKER_STAGING_PARITY_PASSED` at 2026-10-01 03:21:42 UTC. This is exact-release
CI evidence; it does not prove the Fly app or a provider sent a message.

The [pilot operator runbook](../PILOT-OPERATOR-RUNBOOK.md) records the minimum
private test-identity/coverage inputs, capability boundaries, daily queue
review, abort criteria and fail-closed staging pause/rollback templates.
The requested first contractor, mailbox and staff test contacts have not yet
been supplied. No real-message test window is open.

## Hosted synthetic source and managed backup

The exact candidate image ran the code-only `hosted-pilot-drill` harness in a
temporary console Machine `28655600be7798` at 2026-10-01 03:24:43–03:24:46
UTC. Its Machine record confirmed the immutable digest and **zero public
services**; the CLI confirmed its automatic destruction afterward. The main
staging app remained stopped. Fly's CLI automatically upgraded itself from
0.4.102 to 0.4.111 on the console invocation. Explicit console CPU kind/count
and memory avoided an empty-CPU-kind validation error before any Machine was
created on the first attempt.

Both tenants (`restore-drill-pilot-a` and `restore-drill-pilot-b`) received 19
connected inert synthetic records. Only A received the pre-backup inspection
session. Last fixture freeze: **2026-10-01T03:24:46.032Z**. Reader verification
passed graph, private-media bytes, actual application credential decryption,
wrong-key/context rejection and no-contact state. Independent pooled Reader
sessions had distinct stable backends, excluded the competing advisory lock,
and released/reacquired it successfully. This is transport/session-lock proof,
not yet scheduler idle/restart acceptance.

| Evidence                      | Value                                                              |
| ----------------------------- | ------------------------------------------------------------------ |
| API bundle SHA-256            | `4804605287b786e2b65102fcf2a4dec0f2f823947d7b33951d8d51482ff9efaa` |
| Tenant A fingerprint          | `5a6dfddf7797c7c4c9dc20fcf1ce328ef98349014cfeb4b537db8379c84fc7d5` |
| Tenant B fingerprint          | `71ef779eea0efe09fd42f586ab06066caed94313d3d87bc8370f4e542fcf8e00` |
| Completed managed full backup | `20261001-032516F` — started 2026-10-01T03:25:16Z                  |
| Temporary managed restore     | `dzx6qo652zg0jpv5` / `mogulforge-pilot-restore-20261001`           |

The source fingerprints were independently re-read through the owned
workstation proxy with the Reader login and matched the hosted values. The
manual full backup is newer than the fixture. Under the owner's conditional
temporary-cluster approval, `fly mpg restore` accepted that exact backup and
returned the new cluster ID above. It is **provisioning, not yet verified**.
Keep the new cluster private and remove only that exact temporary resource
after recovery evidence/no-dependency checks; never delete the source or
production clusters. Record actual provisioning, app-read and cleanup times
below before declaring the recovery gate passed.

The temporary cluster subsequently reported **ready**. The first restored
Reader attempt returned SQLSTATE `08P01` before application inspection. A
read-only user inventory confirmed the Reader role exists; an authenticated
credential comparison (boolean output only) established that Fly generated a
**different password on the restored cluster**. Reusing the source Reader
credential is therefore not a valid recovery procedure for this restore.
The source secrets remain unchanged; the correction uses a separately named,
strictly target-pinned recovered-Reader secret. The failed console Machine
`812453b9462618` was automatically destroyed and had no public services.

A separate actual-scheduler-runtime probe also failed without exposing a raw
driver error. Its code is being checked for PgBouncer startup-parameter
compatibility. This is not a scheduler pass. Its ephemeral Machine
`8d9652df055e98` was automatically destroyed; the normal staging Machine
remains stopped. Neither failure triggered a provider call or customer send.

## Managed restore acceptance and cleanup — completed

The subsequent application read failure was in the harness, not a demonstrated
application defect: `/api/auth/user` returns `{ user: ... }`, not a top-level
user ID. The corrected harness checks that contract and now exposes only a
fixed route label/status/failure category on an error, never a body or bearer.

The successful private console run `d8d9973dbe1e68` completed at
**2026-10-01T03:42:18.499Z** (started `03:42:12.406Z`) on the pinned candidate.
The CLI selected the immutable digest above; the harness verified the source
manifest and compiled API bundle. The console auto-destroyed. Both recovered
tenant fingerprints matched the source, with all graph/private-file/decryption
and wrong-key/context checks passing. The same compiled API booted loopback-only
using the restored Reader, with seeding, migrations and scheduler disabled and
provider credentials excluded from its child environment. It passed:

- Nine authenticated record reads and byte-for-byte private-file download.
- Four cross-tenant read denials and five write/authentication-route denials.
- Unchanged tenant fingerprints after HTTP inspection; no provider calls.

This is correlated with the **actual completed managed backup and restore
operation**, not just a logical copy. Observed fixture data loss was zero for
the frozen synthetic records. Backup start to successful application inspection
was **17 minutes 2.499 seconds**, including diagnosis/retries; this is an
observed exercise window, not an advertised RTO or continuous-production RPO.
The provider reported the restored cluster ready earlier, by approximately
03:28 UTC; the exact restore-request timestamp was not independently retained.

At `03:42:50.876Z`, a fresh check found no attached apps on the temporary
cluster and only the stopped main staging Machine. The exact temporary cluster
`dzx6qo652zg0jpv5` was then destroyed. At `03:46:22.695Z`, active inventory
contained **only the original production and isolated staging clusters**; a
separate deleted-resource listing confirmed the temporary ID as `deleted`.
The meaningful source backup remains. The three temporary Reader/bearer secret
references were removed from the staging app before cutover. Actual temporary
resource charges require the provider invoice; no third recurring cluster is
being retained.

## Hosted scheduler runtime and held staging cutover

The final narrow runtime probe passed in Machine `811d650be39e18`. Its live
Machine record confirmed the exact image, zero services and auto-destroy; the
console exited successfully and was destroyed. Independent backend sessions
1204 and 1205 were stable. Actual `runSchedulerCycle` respected an external
lock, excluded concurrent work, released/reacquired ownership, recorded healthy
and failed-stage heartbeats, and recovered to healthy. It removed only its own
runtime row and left the default row unchanged. No actual scheduled stage or
provider was invoked by that probe. Earlier reservation failures remain recorded;
their root cause was not established merely because the later run passed.

A later aggregate inventory found one reserved marker left by the failed
03:34 probe, not the normal `automation` row. At `03:53:28.174Z`, its exact
nonce/name, reserved owner, stopped state, timestamps, empty failed stages
and absent work queue were verified under the marker's advisory lock and
`FOR UPDATE`; only that owned test marker was removed in a transaction.
There was no task, send or delivery receipt to replay. The probe now reports
when reservation may have committed so an uncertain acknowledgement cannot
be mistaken for an empty database. The original failure's precise cause
remains unproven.

The source Writer independently has SELECT/INSERT/UPDATE/DELETE privileges on
`scheduler_runtime`. Immediately before cutover, the source Reader confirmed
only the two fixtures, **zero Twilio bindings**, no active Gmail connection,
no scheduled actions/reactivation campaigns/webhook deliveries or active
webhook endpoints. Credentials and customer payloads were not printed.

The main Machine `8d96936a03d058` was updated atomically to the exact green
image and the isolated database secret. `--skip-release-command` was used only
because the reviewed schema was already applied; `AUTO_MIGRATE=false` and
`STAGING_SCHEMA_PUSH_APPROVED=false` remained in force. No old image ran on
the new database. A controlled start passed at 03:45 UTC:

- `/api/healthz`: 200 and `status=ok` after the database identity guard.
- Anonymous contacts and operator-runtime requests: 401.
- Unsigned Resend callback: 403, matching its signature rejection contract.
- Outbound hold true, staging outbound approval false, empty email recipient
  allowlist, scheduler autostart false; one Machine, not a spare HA pair.

The app was deliberately stopped again with autostart disabled before the
remaining synthetic scheduler restart exercises. This is **successful held
staging cutover and smoke acceptance**, not active client access or always-on
scheduler proof. Normal boot seeds database defaults even with scheduler held.
The voice hold boundary is recorded in the operator runbook: inbound TwiML
dialing also requires disabled tenant voice bindings/routing; the REST send
hold is not a universal network firewall.

A secret-metadata-only comparison confirmed staging and production session
secrets both exist and have **different digests**. The staging signup allowlist
is present, all temporary `RESTORE_DRILL_*` secret references are absent, and
`RESEND_WEBHOOK_SECRET` is still absent. No secret value or digest was printed;
metadata does not prove the provider key is usable or a recipient is approved.

## Final synthetic scheduler exercises — October 1 UTC

The first full source-scheduler rehearsal passed in private console
`80e9676b5006e8`: two normal 60-second cycles and a graceful replacement worker,
with unchanged tenant state and no provider HTTP attempts. Its independent
Machine record confirmed the image, zero services and automatic destruction.
An independent review then tightened final lock-release/session-loss checks in
the helper. The hardened second run on `d895175a5d6d28` also **passed** and
auto-destroyed, with independent image/zero-service/auto-destroy inspection.
The first worker completed cycles at `04:00:33.047Z` and `04:01:38.364Z`,
with the second starting 60.011 seconds after the first completion. The new
worker completed at `04:01:40.533Z`. Both exited normally and reported stopped.
Two seeded automation rules and four templates were preserved; all tenant
state fingerprints were unchanged; the owned runtime row was removed; provider
credentials were absent and measured HTTP attempts were zero. This proves
bounded hosted real-scheduler timed operation and graceful child-process
restart, not continuous production uptime or whole-server rolling deployment.

The crash-after-task exercise used public synthetic nonce
`359ad94a182d865ea02e002b5afc9d91`. This is an evidence label, not a credential.
It ran after idle acceptance in private console `811eeec9930e58`, whose live
Machine record confirmed the exact image, zero services and auto-destroy.
It **passed** and the console exited 0 and was destroyed. Read-only verification
at `04:03:47.119Z` independently confirmed these retained records:

| Synthetic action                       | Action state | Durable receipt |
| -------------------------------------- | ------------ | --------------- |
| `8dcc3ea2-bf13-5e62-ad2e-c0a9cb9a9f75` | failed       | indeterminate   |
| `78d62b2a-3deb-5427-af92-2a811677c699` | done         | succeeded       |

The supervisor witnessed the first task committed while its receipt remained
processing, killed only its own worker, then started a fresh scoped processor.
There were exactly **two tasks and two receipts**, zero duplicate effects,
visible operator reconciliation, unchanged normal scheduler runtime and zero
provider HTTP attempts. Both actions were created at `04:02:27.828Z`; receipt
creation times were `04:02:29.898Z` and `04:02:31.261Z`. The first effect was a
labelled synthetic INSERT inside the actual durable owner, not the private
first dispatcher. Only that receipt's deadline was deliberately advanced;
this does not claim a real 15-minute wait. The restart used actual
organization-scoped scheduled processing, not all global failure paths.

All action/task/receipt/audit evidence is retained. Never change the nonce or
delete these records to retry. Earlier empty-queue probes are deliberately
not rerunnable over this evidence without a new reviewed fixture plan. The
failed/indeterminate record is a **synthetic acceptance artifact**, not a
customer-message incident.

## Final held staging state and local verification

After the private probes ended, the same immutable image was redeployed with
the checked-in fail-closed staging configuration, reviewed-schema release
command skipped, and `AUTO_MIGRATE=false`. At `04:04:25.858Z`, live inventory
confirmed exactly one **started** main Machine `8d96936a03d058`, autostart true,
on-failure restart and minimum one in the primary region. Scheduler autostart
is false, outbound hold true, staging approval false, schema push false and
the email recipient allowlist empty. Both original clusters are ready, and no
temporary console or restored cluster remains. This final state supersedes
the deliberately stopped intermediate test windows above.

Final HTTPS smoke at `04:04:14.360Z` again passed health 200, both anonymous
auth denials 401 and unsigned Resend webhook denial 403. Read-only source
inventory found zero pending scheduled actions, zero runtime leftovers, zero
Twilio bindings and zero active Gmail connections. It did not delete the
synthetic failed/succeeded actions. Normal background work stays off until a
recorded pilot test window, permitted sender/recipient identities and remaining
workflow checks are approved.

The final local scripts suite passed **202/202 across 13 files**, including
real-source timed scheduler and crash-recovery tests. Full workspace TypeScript
checks passed. These operations-only changes leave application, schema,
dependencies, Dockerfile and staging config unchanged from `c050067`. The final
branch head requires its own GitHub CI; the hosted application evidence remains
explicitly attached to the already-green application candidate, not relabelled
as a later documentation commit.

## Remaining live acceptance gates

1. Keep exact-head CI green for subsequent operator-harness/document commits.
   The application candidate/image and hosted evidence remain explicitly
   pinned to `c050067`; later operations-only commits are not a new app image.
2. Retain the completed managed-recovery evidence above. Any later schema or
   application change needs its own appropriate recovery/compatibility review.
3. Preserve the passed hosted scheduler runtime, timed idle/restart and bounded
   crash-after-task evidence. Evaluate remaining legacy/global failure windows,
   actual provider behavior and operator coverage before always-on release.
   Preserve uncertain delivery receipts for operator review; never blindly
   retry an ambiguous provider result.
4. Choose first pilot company, contractor sending mailbox, staff test inboxes
   and test phones. Exact recipient allowlists are mandatory for staging.
5. Test platform verification/invite/reset through Resend and contractor
   connect/send/revoke through Gmail. Check receipt in the approved inbox and
   provider dashboard. Do not mark delivered merely because the send API
   accepted a message. Platform identity mail currently has no durable
   application receipt correlation; the legacy callback path applies only to
   known playbook message IDs.
6. Run correct-tenant Smart Site and missed-call acceptance; SMS requires
   separate sender readiness, consent, STOP and delivery tests. Keep live
   campaigns and automatic customer warranty reminders disabled until their
   own acceptance passes.
7. Record support owner, daily queue review, pause/rollback steps, privacy
   export/deletion checks, and the contractor's signed-off pilot scope.

No production deployment or broad public launch is implied by this ledger.
