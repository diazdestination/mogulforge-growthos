# Zapier Connected Apps — specialist hands in the contractor's own tools

Implemented 2026-10-29 on `feat/zapier-connected-apps`. This document is the
product-owned contract for the feature: what is built, what is deliberately
not built, and how to verify it. It uses MogulForge GrowthOS terminology only.

## What it is

GrowthOS specialists are bounded workflows, not autonomous agents. Zapier
Connected Apps gives seven of them a narrow set of *bound capabilities* in the
apps a contractor already uses, through the contractor's own Zapier account:

| Specialist | Capability | Direction | Default policy |
| --- | --- | --- | --- |
| SCOUT | `scout.reviews.list` — new public reviews become follow-up tasks | read | off |
| SCOUT | `scout.leads.list` — marketplace leads become GrowthOS opportunities | read | off |
| APPT | `appt.calendar.create_event` — explicitly request a calendar event for a booked appointment | write | off |
| APPT | `appt.sms.send` — appointment reminder texted to a consented customer from the contractor's number | write | off |
| SCOUT | `scout.inbox.list` — customer email replies from the connected mailbox become activities and follow-up tasks | read | off |
| SCOUT | `scout.sms.review_request` — review link texted once per finished visit or job from the contractor's number | write | off |
| INVO | `invo.accounting.create_invoice` — request an issued invoice export to accounting | write | off |
| INVO | `invo.accounting.record_payment` — a recorded receipt becomes a payment on the exported invoice (QuickBooks, Xero) | write | off |
| INVO | `invo.email.send` — issued invoice emailed from the contractor's own Gmail/Outlook | write | off |
| ESTI | `esti.email.send` — draft estimate emailed from the contractor's own Gmail/Outlook | write | off |
| CALLIE | `callie.calls.list` — phone-system calls become callback tasks | read | off |
| CALLIE | `callie.sms.inbox.list` — texts received on the contractor's number: known-customer replies logged, STOP/START applied to text consent | read | off |
| CALLIE | `callie.sms.send` — text back a missed caller through the existing governed path | write | off |
| SCHED | `sched.sms.send` — selected company-date day sheet texted to a crew member | write | off |
| MAINTAIN | `maintain.sms.send` — service-due reminder texted to a consented customer | write | off |
| APPT | `appt.sms.on_my_way` — On My Way text (tech name, company, optional ETA) to a consented customer, once per appointment per company day | write | off |
| BILL | `bill.sms.payment_link` — open sandbox pay link for an issued invoice's current balance, texted to a consented customer | write | off |
| ESTI | `esti.sms.approval_link` — staff-requested text of an estimate's approval link to a consented customer | write | off |

Saving or changing a binding sets its policy Off. The client explicitly enables
its policy afterward; Approve each is the recommended starting authority for
customer texts, except the two tap-sent field texts below (Automatic). A
registry's suggested mode does not activate a saved binding.

### Customer texts from the contractor's own number

`appt.sms.send`, `maintain.sms.send` and `esti.sms.approval_link` let a
contractor text customers from the business number in their own phone app
(Quo or their own Twilio account). This uses the contractor's own provider
setup; it does not bypass that provider's carrier registration or sender
approval. See [Twilio's US 10DLC prerequisites](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/quickstart)
and [Quo's business-texting registration](https://learn.quo.com/setting-up-quo/registering-for-business-texting/what-is-a2p-why-matters).

- Consent is enforced by the same send gate as built-in texting: do not
  contact, per-channel opt-out, suppression and SMS consent. MAINTAIN also uses
  the outreach gate (sending hours, caps, reply holds) and its notice window.
- Every APPT/MAINTAIN/ESTI customer text ends with "Reply STOP to opt out." Replies and STOP requests land
  in the contractor's phone app. With `callie.sms.inbox.list` bound, GrowthOS
  also reads them (see below); without it, staff mark an opted-out customer
  do not text on the customer record.
- The automated appointment reminder uses `appt.sms.send` only when built-in
  texting is not active for the company and the capability is bound with a
  policy that is not off. Built-in and own-number reminder paths share
  ownership checks. Email fallback is allowed only after a proven no-effect
  refusal and when email is eligible; an unknown or previously owned text
  remains held for review rather than causing a second contact.
- Approval re-derives the exact text from the appointment or service. A
  reschedule, cancellation, consent change or service edit after the request
  blocks the approval instead of sending stale copy. A service gets at most one
  own-number reminder while any earlier one is pending, sent or uncertain, and
  never after a built-in MAINTAIN reminder or a recorded customer response.

### Owned-app flows (mailbox, reviews, payments)

Built 2026-11-11 on `feat/zapflows-20261111`. These let a contractor work from
their own Gmail/Outlook, number and QuickBooks/Xero without a GrowthOS mail
connection or a MogulForge Microsoft app. Code: `zapier-owned-app-flows.ts`.

- **Invoice/estimate email** is a separate "send via my mailbox" path, not a
  sender option inside native delivery. The native kernels pin a GrowthOS
  mailbox credential in hash-pinned review schemas and recheck it at dispatch,
  and their attempts run synchronously; Zapier parks for approval and owns its
  own durable receipt. Mixing them would nest two receipts per send. Instead
  the two paths exclude each other: the Zapier path refuses an invoice with
  any native attempt (and a non-initial or already-sent estimate), and native
  delivery refuses while a Zapier email owns the record. Content uses the
  native renderers. Ledger `succeeded` means the mail app accepted the message
  (not delivered); `indeterminate` is never retried and holds both paths.
  An accepted estimate email marks the draft sent. Two capabilities (not one)
  so INVO and ESTI keep their own policy and budget.
- **Email replies**: `scout.inbox.list` (Gmail Find Email / Outlook Find
  Emails) logs mail only from an address matching exactly one customer
  contact; unknown, ambiguous and sender-less mail is ignored. Messages are
  deduped by `app:messageId` across windows, stored as a bounded untrusted
  snippet with provenance, never acted on, and create one review task. A reply
  pauses that lead's active playbook enrollments. It does not create a native
  reply hold (that needs signed outbound evidence Zapier cannot provide) and
  does not cancel already-scheduled actions.
- **Review request**: requested by staff for a completed appointment or
  project. Outreach send gate (consent, opt-out, sending hours, reply holds),
  the existing review engagement link, the opt-out line, once per job and at
  most once per phone in 90 days. These texts do not reserve frequency-cap
  touches.
- **Text replies and opt-outs**: `callie.sms.inbox.list` (Quo Message
  Received / Twilio New Received SMS; action keys unverified) is polled like
  the other reads and covers every own-number text (APPT, MAINTAIN, CALLIE,
  SCHED, SCOUT and later ones). Records are processed oldest first and deduped
  by `app:messageId`; outgoing records are skipped. The keyword list and
  consent effects match the built-in Twilio inbound webhook: STOP from any
  number suppresses that phone for the company and, for every matching
  contact, sets do not text and records a revoked SMS consent, so the send
  gate refuses later texts. START/UNSTOP lifts only a STOP suppression recorded
  before it, and (like the webhook) re-grants no consent and leaves do not
  text set, so fresh consent is needed before texting resumes. Non-keyword
  replies from a phone matching exactly one contact are logged as untrusted
  text with a task and pause that lead's follow-up; unknown and shared numbers
  are not logged. Opt-outs reach GrowthOS only at the next poll (default
  every 4 hours); a text requested in between can still be sent.
- **Payment**: once per receipt allocation, refused unless
  `invo.accounting.create_invoice` succeeded for the invoice to the same app,
  and refused at approval if the receipt was reversed.

### Field texts from My day (`/tech`)

`appt.sms.on_my_way` and `bill.sms.payment_link` are requested by staff from
the phone-first My day screen (`GET /contractor/my-day`, the signed-in member's
own assigned appointments). Both use the same consent gate, opt-out line,
nurture-lock serialization and pre-dispatch re-derivation as the reminders.
On My Way keys on `appt-omw:<appointment>:<company date>`; the chosen ETA is
kept in the ledger summary so approval rebuilds the identical copy, and a
cancelled visit, another day or withdrawn consent blocks it. The pay-link text
keys on `bill-paylink-text:<link>:v<invoice version>:<balance cents>` and is
rebuilt from the current open link and invoice balance; an expired, paid or
replaced link, a changed balance, or missing invoice access refuses approval.
Routes: `POST /integrations/zapier/flows/appointments/:id/on-my-way`
(`crm.write`, body `{ etaMinutes?: 1-240 }`),
`POST /integrations/zapier/flows/invoices/:id/pay-link-text` (`invoices.manage`)
and, for a tech on their own job,
`POST /integrations/zapier/flows/appointments/:appointmentId/invoices/:id/pay-link-text`
(`payments.collect`; the invoice must be linked to that job, and approval re-checks
that the job is still theirs).

These two are fixed-copy texts that a person sends by tapping a button for one
customer, so their registry default is Automatic: the tap is the approval. Like
every flow they stay Off until the owner binds them and picks a policy in
Settings; Settings recommends Automatic and the owner can choose Approve each
(office approves every text) or Off. All other capabilities keep their defaults.
Status on My day reads Sending, Sent to Zapier (the phone app accepted it, not
that the customer read it) or Waiting for approval.

CALLIE's existing phone-sync/text-back path is separate. The client action panel
does not expose it while callback eligibility and customer-consent review are
unavailable there; the APPT/MAINTAIN footer and send-gate claims above must not be
applied to that legacy path.

The registry lives in
`artifacts/api-server/src/services/zapier/zapier-capabilities.ts`. Each
capability declares its owner, direction, a typed input contract, the reviewed
Zapier apps/actions it may bind to, and a deterministic input → parameter
mapper. No model participates in choosing a capability, an action, or its
parameters. Adding an app means adding a reviewed candidate there.

## How a contractor connects

1. An owner/admin opens Settings → Connections → Zapier Connected Apps and
   clicks **Connect Zapier**. The Zapier MCP Embed (`<zapier-mcp>`) loads from
   `https://mcp.zapier.com/embed/v1/mcp.js` with the member's email prefilled.
2. The contractor signs in to (or creates) their own Zapier account inside the
   embed and connects their apps (QuickBooks, Google Calendar, CallRail,
   Twilio, Google Business Profile, Facebook Lead Ads, …).
3. The embed emits `mcp-server-url`; the page POSTs it to
   `POST /api/v1/integrations/zapier/server-url`. The server validates the host
   is `mcp.zapier.com`, probes the server's tool list once, and stores the URL
   AES-256-GCM encrypted with AAD `${organizationId}:zapier-mcp`
   (`zapier_mcp_connections`). The API never returns the stored plaintext URL.
4. GrowthOS loads enabled actions automatically and refreshes them when Zapier
   reports tool changes. The contractor selects an available action and **binds**
   each capability to one of them (`zapier_capability_bindings`), supplying
   any non-secret binding settings (calendar id, sending number, Facebook Page,
   crew phone numbers for SCHED).
5. The contractor sets the policy per capability (`zapier_specialist_policies`):
   `off`, `approve` (writes park for a human), or `auto` (bounded by a daily
   budget, default 25–96 depending on the capability).

Disconnect revokes the connection, blanks the stored credential, switches every
policy to `off`, and keeps the ledger and bindings as history.

## Execution ledger invariants

Every specialist request goes through
`requestZapierAction` in `zapier-executions.ts` and is recorded in
`zapier_action_executions`:

- One row per `(organization, idempotency key)`. A replay with a different
  request digest is rejected; an identical replay returns the original receipt
  and performs nothing.
- Writes are owned by a durable execution receipt
  (`runDurableAction`, action key `zapier:<execution id>`). A thrown or
  timed-out write becomes `indeterminate` and is never retried automatically.
- `off` blocks; `approve` parks writes as `pending_approval`; `auto` executes
  within the daily budget. Reads never wait for approval but are budgeted.
- The staging outbound hold (`GROWTHOS_OUTBOUND_HOLD`) blocks every write at
  the dispatch point.
- Approval re-derives the request from the linked GrowthOS record. If the
  record changed since the request, the action is blocked as `stale_request`
  and must be requested again. The ledger stores digests and an allow-listed
  summary only, never the full payload or the raw provider response.
- Every state change writes an `audit_events` row (`zapier.action_*`,
  `integration.zapier_*`).

Provider content is data. Inbound leads, reviews and calls become GrowthOS
records with provenance (`source = zapier:<App>`, `import_source_key`,
`source_event`); nothing in them is ever treated as an instruction.

## Platform configuration

- `ZAPIER_MCP_EMBED_ID` (non-secret, sent to the browser) and
  `ZAPIER_MCP_EMBED_SECRET` (bearer for GrowthOS → Zapier) come from
  `https://mcp.zapier.com/manage/embed/config`. The allowed domain must be the
  app's public origin. Both unset hides the feature; restore mode refuses
  `ZAPIER_*` like every other provider prefix.
- `OAUTH_TOKEN_ENCRYPTION_KEY` is reused for the server URL with a distinct
  AAD context.
- Zapier bills two tasks per successful tool call to the **contractor's**
  Zapier account. GrowthOS fronts no per-customer usage.

## Scheduler

Stage `zapier-connected-apps` (after `callie-intake`) runs the five read syncs
(leads, reviews, calls, email inbox, text replies) for every connected organization whose
capability is bound and set to `auto`. Idempotency keys use the company's poll
window (`zapier_mcp_connections.poll_interval_minutes`, default 240, choices 1h
to 24h, set in Settings), so the 60-second cadence spends at most one Zapier
read per capability per window. Writes never originate from the scheduler.

## Routes

All under `/api/v1/integrations/zapier`; permissions are declared in
`routes/v1/route-inventory.test.ts`. Connection, binding and policy changes
require `settings.manage` and a signed-in human session (API keys are
rejected). Flows require the permission of the record they act on
(`crm.write`, `invoices.manage`).

## Verification

```powershell
pnpm --filter @workspace/api-server exec vitest run --config vitest.unit.config.ts src/lib/zapier-contract.test.ts
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/zapier/zapier-executions.test.ts src/routes/v1/route-inventory.test.ts src/services/data-lifecycle-inventory.test.ts src/services/scheduler-stage-isolation.test.ts
pnpm --filter ./scripts exec vitest run contractor-recovery-drill.test.mjs
pnpm run typecheck
```

The ledger suite exercises encryption/AAD binding, host validation, binding
rules, the durable receipt, replay, approval/stale/reject, indeterminate,
policy/budget/hold gates, tenant isolation, SCOUT lead ingestion with hostile
provider content, the scheduler stage, and disconnect — all against a real
database with the MCP transport faked in memory.

## Not built (explicit gates)

- No live Zapier round trip has been run from this repository. A real embed id,
  embed secret, and a contractor Zapier account with connected apps are
  required before the feature is called beta-ready.
- Zapier app ids in the registry were verified against Zapier's catalog on
  2026-10-29 (`QuickBooksV3CLIAPI`, `GoogleCalendarCLIAPI`, `CallRailCLIAPI`,
  `TwilioCLIAPI`, `GoogleMyBusinessCLIAPI`, `FacebookLeadsCLIAPI`,
  `FacebookLeadAdsCLIAPI`, `OpenPhoneCLIAPI` (listed as Quo), `XeroCLIAPI`,
  `MicrosoftOutlookCLIAPI`, `HousecallProCLIAPI`, `JobberCLIAPI`). The Gmail
  app id `GoogleMailV2CLIAPI` (2026-11-11) was not verified. Action keys
  and parameter names were not verified against a live server; the binding
  step also matches by display name, and the first live run per app must
  confirm the action's parameter names. Angi and Thumbtack have no Zapier app.
- BILL only texts an existing sandbox pay link. ESTI's approval-link text is
  rebuilt from the link at approval and dispatch, and is refused once the link
  is revoked, expired, replaced or outdated by an estimate edit.
  Invoice/estimate email is not a sender option inside native delivery (see
  above). MAINTAIN's standing (automatic) reminder policy still uses built-in delivery; own-number service texts are requested by staff.
- No Zapier *trigger* (push) integration: reads are polled by the scheduler.
- No "GrowthOS as a Zapier app" listing; that is a separate partner-program
  decision.
