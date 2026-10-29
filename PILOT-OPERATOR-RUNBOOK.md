# Controlled contractor pilot — operator runbook

> **Current context — October 29, 2026:** The technical contract and dated results below describe their recorded feature checkpoint. Current main includes later contractor, scheduling, service, mailbox and Twilio work; use the current inventory for implemented features and pending live acceptance. Older branch names, test totals and approvals do not become current by this documentation refresh.
> See [current build](CURRENT-BUILD.md) and [documentation map](docs/DOCUMENTATION-MAP.md).


**Working checklist, not launch approval or evidence of delivery.** Start with
one selected contractor, its authorized staff, and synthetic customer records.
Keep Painless and the HVAC company in separate organizations. A staff-only
rehearsal can establish readiness; real customer outreach needs the completed
[P0 release gates](PAID-BETA-READINESS-P0.md) and a bounded, approved cohort.

## Name the people and the exact test scope

Complete this record privately; keep real exports, inboxes, phone numbers and
credentials out of Git. An empty required field means the corresponding test
cannot begin.

| Required field                                                                 | Operator entry |
| ------------------------------------------------------------------------------ | -------------- |
| Contractor / exact organization ID / environment                               | __________     |
| Release SHA / green CI URL / image digest / acceptance date                    | __________     |
| Contractor decision-maker / primary responder / backup responder               | __________     |
| MogulForge support owner / escalation contact / coverage hours                 | __________     |
| Daily review time and timezone / next review date                              | __________     |
| Company default Gmail user ID and verified connected mailbox                   | __________     |
| Assigned lead senders and their connected mailboxes                            | __________     |
| Exact approved staff test inboxes and test handsets                            | __________     |
| Smart Site ID and exact HTTPS origin, if included                              | __________     |
| Twilio tenant/account/number binding, approved channel and limits, if included | __________     |
| Test record IDs / permitted actions / maximum sends / stop time                | __________     |
| Contact-policy owner / permitted purpose / consent evidence location           | __________     |

- [ ] The owner/admin and responder sign into the correct company and can find
      **Calls, Service Desk, Pipeline, and Win-back**. Platform client selection
      does not grant access to a client's workspace.
- [ ] The support owner can see failures and take over a missed inquiry. A
      failed test has a named owner and a next review time.
- [ ] Staging uses its isolated database, credentials and approved test data;
      exact-SHA acceptance and the separate two-tenant isolation test are recorded.
- [ ] The scheduler, outbound hold and recipient allowlist state are recorded.
      Keep sends held during preparation. Follow [email acceptance](CUSTOMER-EMAIL-PILOT.md)
      and [staging controls](STAGING.md) for any separately authorized send window.
- [ ] For this staff-only run, every staging Twilio voice binding is absent or
      has `voice_enabled=false`. Contractor phone forwarding and provider
      inbound voice routing to staging remain disabled/unconfigured. The
      application outbound hold does not intercept inbound TwiML `<Dial>`
      instructions; live voice requires its own later acceptance window.
- [ ] Each test recipient has authorized the specific test. Imported phone
      numbers, warranty dates and missed calls do not establish SMS/marketing
      consent. Preserve existing opt-outs and suppressions.

## First staff-only session

Use three to five labeled synthetic records. Keep campaigns unlaunched; perform
one approved action at a time. Record expected result, observed result, time,
record/receipt ID and operator for each row.

| Workflow                             | Exercise and expected evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Smart Site inquiry                   | Check the correct site's manager/responder, credential handshake and Launch Guard. For an authorized labeled HTTPS submission, verify one contact/inquiry, consent receipt and assigned response task in this company. Replay the same submission and check no duplicate. Disable capture afterward if the test window is closed. See [Launch Guard](SMART-SITES-LAUNCH-GUARD.md) and [recovery](SMART-SITES-RECOVERY.md).                                                                |
| Lead CSV                             | In **Win-back**, map names, email/phone, source and status from a small synthetic export. Inspect the mapping, then import only that test file; verify imported/duplicate/skipped counts and the company on each lead. This lead import writes records: it has no server dry-run. Do not launch a campaign as part of import. Preserve the original export/source dates separately.                                                                                                       |
| Existing customers and service dates | In **Service Desk**, preview a customer/service CSV before **Import valid rows**. Include a duplicate and an invalid date. Verify customer, equipment, warranty/maintenance/plan kind, due date and staff task lead time; existing customers must not become acquisition leads. Mark one synthetic visit serviced and verify its task closes. See [contractor implementation](CONTRACTOR-PILOT-IMPLEMENTATION.md).                                                                        |
| Missed call                          | After voice approval, use authorized test handsets for answered, busy and unanswered cases. Verify the right business/staff route, signed call record and one callback task. Staff must deliberately link the matching contact or create an opportunity. Unknown callers receive no automatic qualification, consent or SMS. Follow [tenant binding](TWILIO-TENANT-BINDING.md).                                                                                                           |
| Email and appointments               | During the approved email test window, prove a portal code, booking confirmation and appointment reminder from the expected Gmail identity, including an unassigned lead. Test a disconnected/revoked assigned sender: it must fail without changing mailboxes. Check staff portal alerts use the company default. Record provider ID **and** actual inbox arrival; provider acceptance alone is insufficient. Independently prove platform verification/reset/invitation through Resend. |
| Follow-up and stop controls          | With sending held, inspect a segment and sample outreach, its assigned owner, next action and consent exclusions. Prove pause/cancel on a synthetic campaign. Use the [scheduler acceptance](SCHEDULER-OPERATIONS.md) for idle/restart/failure tests; do not use real messages as crash fixtures.                                                                                                                                                                                         |

The service desk currently creates **staff tasks only**. Automatic customer
warranty/service-plan reminders, recurrence rules and unattended booking from
those obligations are not implemented. Staff may arrange and record a visit
manually. Standard appointment reminders are a separate existing flow requiring
working senders and scheduler acceptance. CSV is not a live Housecall Pro sync.
Missed-call review is not an autonomous AI phone receptionist. Friendly agent
names do not expand those capabilities.

## Daily review and go/no-go

At the recorded review time, the contractor responder and support owner check
new inquiries, missed-call tasks, overdue service tasks, appointment changes,
blocked/failed sends, opt-outs and Revenue Desk execution reviews. Platform
operators inspect **Client Launchpad → Follow-up reliability**. Record the
backlog owner and next action; reconcile uncertain sends against provider
evidence before considering another action.

**Go to the next bounded test** only when the previous result has evidence,
staff coverage is available, the correct sender/recipient remains approved,
and there are no unexplained duplicates or uncertain effects. **Go to a real
customer cohort** only after the relevant P0 gates pass, the contractor approves
the exact records/purpose/copy/channel and limits, and each outbound action has
human approval initially. Keep the cohort bounded and measure conversations,
appointments and recorded outcomes; estimate value is not collected revenue.

**Abort the test immediately** for wrong-company data, wrong sender/recipient,
an unexpected or duplicate send, contact after an opt-out, missing callback
ownership, failed/stale background work, or an unavailable responsible person.
Hold sends, preserve record IDs/receipts and escalate to the named support owner.
Do not delete evidence or replay an uncertain action to make a test pass.

## Pause and rollback

In the affected company's **Win-back** campaign choose **Pause**; use **Cancel**
when ending the test. Pausing enrollment alone does not recall accepted messages
or stop every already-scheduled action. Turn off the site's capture connection
and its site-side switch if intake must pause. Clearing the company email
default blocks unassigned emails/portal codes, but does not stop assigned
senders. The application hold stops new email, SMS, external webhook and REST
outbound-call dispatches. It does **not** stop a configured inbound voice
callback or an already-accepted outbound call's callback from returning TwiML
`<Dial>` instructions. For a complete call pause, the authorized operator must
separately disable the affected tenant's voice binding and pause its provider
voice routing/contractor forwarding, then verify the call state. Do not use the
outbound hold alone as evidence that all phone activity has stopped. Keep those
bindings and routes disabled/unconfigured throughout the staff-only rehearsal.

The following is an operator-only **staging shutdown template**, never an
instruction to run it automatically. Inspect `fly machine list --app
mogulforge-growthos-staging`, confirm the exact Machine and account, then replace
the placeholder. These commands disable autostart and retain fail-closed settings;
repeat only for other individually verified Machines if more than one exists.

```powershell
$pilotMachineId = '<REVIEWED_STAGING_MACHINE_ID>'
if ($pilotMachineId -notmatch '^[0-9a-f]{14}$') { throw 'Confirm the staging Machine ID first.' }
fly machine update $pilotMachineId --app mogulforge-growthos-staging --skip-start --autostart=false --restart=no --env GROWTHOS_OUTBOUND_HOLD=true --env STAGING_OUTBOUND_APPROVED=false --env SCHEDULER_AUTOSTART=false --yes
if ($LASTEXITCODE -ne 0) { throw 'Hold update failed; escalate and verify Machine state.' }
fly machine stop $pilotMachineId --app mogulforge-growthos-staging --signal SIGTERM --timeout 30
fly machine list --app mogulforge-growthos-staging
```

Already accepted provider messages or connected calls cannot be recalled by this
hold. Reconcile them before resuming. Staged secrets alone do not change a
running process.

For an image rollback, keep the Machine stopped, select a previously verified
image compatible with the current schema, and have the release owner review it:

```powershell
$pilotRollbackImage = '<REVIEWED_IMAGE_WITH_SHA256_DIGEST>'
if ($pilotRollbackImage -notmatch '^registry\.fly\.io/mogulforge-growthos-staging@sha256:[0-9a-f]{64}$') { throw 'Review the exact rollback image first.' }
fly machine update $pilotMachineId --app mogulforge-growthos-staging --image $pilotRollbackImage --skip-start --autostart=false --restart=no --env GROWTHOS_OUTBOUND_HOLD=true --env STAGING_OUTBOUND_APPROVED=false --env SCHEDULER_AUTOSTART=false --yes
```

Do not downgrade the schema or substitute the old shared database. A data
restore follows the [restore plan](reports/p0-6-restore-drill-plan-2026-09-30.md).
Starting any reviewed image, re-enabling capture or reopening sending requires
a new recorded test window and current identity/queue checks.

## Evidence handoff

Link the completed private checklist to the release SHA and latest
[staging preflight](STAGING-PREFLIGHT-2026-09-30.md). Use the
[launch ledger](PUBLIC-LAUNCH-READINESS-2026-09-30.md) to track gaps, checking its
date against newer release evidence. Save actual provider receipts and staff
observations separately from local tests. Leave unfinished rows marked
**not run**, **blocked**, or **failed**. This checklist alone establishes no
public launch, customer activation or provider success.
