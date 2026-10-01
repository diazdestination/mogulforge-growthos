# Controlled contractor pilot — September 30, 2026

This is the launch evidence ledger, not a statement that a client is live.
The owner asked to finish the controlled-pilot preparation. Work is restricted
to private GrowthOS, its isolated staging environment, and synthetic records.
Production, Painless and HVAC customer databases have not been changed.

## Scope and success criteria

Start with one contractor and staff-owned test contacts. Keep the roofing and
HVAC organizations, Smart Site installation keys, sending mailboxes, phone
bindings and consent records separate. The named agents are workflow entry
points, not a promise of autonomous work beyond tested capabilities.

| Workflow | Required acceptance before enabling for clients |
| --- | --- |
| Smart Site lead capture | Correct tenant receives a test lead, source, consent and one staff follow-up; duplicate submit does not create another lead or action. |
| Imported customers | Review a small CSV first; verify dates, equipment, owner and source; import does not imply marketing consent. |
| CALLIE missed-call recovery | A controlled call creates exactly one correct-tenant callback task; answered calls do not; SMS stays off until that client's sender and consent checks pass. |
| APPT appointment reminders | Correct timezone, staff calendar/booking ownership, confirmation/reschedule and duplicate protection. No promise of calendar sync unless separately connected and tested. |
| MAINTAIN service/warranty | Verified service obligations create the right staff task before due date. Customer reminder automation is a separate gate; do not claim staff-task creation automatically notifies a customer or preserves a manufacturer's warranty. |
| Lead follow-up and campaigns | Explicit contractor Gmail sender, contact eligibility, sending hours, opt-out and pause; approve a small segment and copy before any campaign. |
| ESTI / BILL / INVO / SCHED / SCOUT | Staff-reviewed proposals, records and next actions only where implemented. No autonomous quoting, charging, collections, route optimization or revenue guarantees implied. |

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

| File | SHA-256 |
| --- | --- |
| `0000_isolated-staging-initial.sql` | `b27d33a59a8a0f083fefe3271936d197309db5d683bd4254bbd28d7bc7315a10` |
| `0001_pilot-email-sender.sql` | `8d2d49f344e4900e5304d1f7b23ce23b929121f9af04362d50902a692605883f` |

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

## Remaining live acceptance gates

1. Exact-head CI and SHA-tagged image; safely replace the stopped old image
   before attaching the new isolated database. Keep migration, scheduler and
   outbound holds in place during the first health inspection.
2. Seed only the tested synthetic fixture, freeze it, then verify a meaningful
   backup and restore. Fingerprints, decryption checks and HTTP/application
   reads are distinct evidence. Do not create a third cluster for an empty
   backup. The conditional paid restore-cluster approval applies only if that
   managed-recovery mechanism is actually exercised.
3. Prove real PostgreSQL scheduler locking and idle/restart/failure behavior.
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
