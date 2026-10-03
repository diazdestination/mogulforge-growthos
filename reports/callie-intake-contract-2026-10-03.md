# CALLIE automatic missed-call intake — implementation contract

Owner requested the next launch-critical engineering wave after PR17/18 and
exact-main CI37092275861 passed on fa7c82757f3ec07d05ef1a8ace2739bec5b491c5.
Canonical private GrowthOS only. This is a bounded L4 extension, not activation,
general AI voice conversation, autonomous confirmed booking, marketing, payment,
or a declaration that either contractor can cut over. Preserve the fixed
LAUNCH-COMPLETION checklist and separate hosted/provider/customer gates.

## Contractor outcome

Keep the normal staff bridge first. With a separately approved, default-off,
forward-only standing policy, a new missed inbound call can collect deterministic
keypad choices: repair/replacement/maintenance/other; callback versus visit
request; morning/afternoon/no-preference callback window. Empty/invalid input
ends safely with accountable callback work. No recording, speech transcription,
LLM, emergency-dispatch promise or pricing/warranty representation is added.

Unknown callers remain call records. Caller ID and keypad choices do not create
a contact/opportunity, verified identity, staff review or general SMS consent.
After the complete one-call disclosure, the caller may request instructions to
text an expiring exact `CALLIE <code>` from that same phone to the approved shop
number. A signed matching inbound SMS grants only one fixed branded acknowledgment
for that call. Nothing is sent merely because the caller heard or keyed a choice.
No recurring follow-up authority or arbitrary inbound-text agent is introduced.

The office sees a paged attention/waiting/history list, current accountable owner,
deadline, caller-supplied facts and retained send evidence. It can explicitly
review/link the caller using existing canonical controls, then confirm a visit
only after agreeing an exact window with the customer. Booking is a separate
versioned action using native scheduling/capacity locks and one-request ownership.

## Authority and persistence

- Admission must be stamped transactionally with a genuinely new signed inbound
  call under the current exact approved policy. Enabling mid-call or sweeping old
  calls never admits them. Keep answered Dial outcomes outside missed intake.
- Additive typed tables: immutable `callie_policy_revisions`, one
  `callie_intakes` record per call, and `callie_ack_dispatches`. Root reviews exact
  schema, tenant-composite foreign keys/checks, source inventory and recovery.
  Do not make the existing contact-required dispatch/consent tables nullable.
- Policy revisions freeze the actual finite prompts/message, owner schedule,
  deadline, current binding/account/sender/program/origin and explicit approver.
  Preview/approval is actor-bound, exact, expiring and versioned. Saving a draft
  or an older individually reviewed care policy grants no standing authority.
  Disabling/revising is local and allowed while providers are held.
- Intake freezes its policy revision, original signed call/provider identity,
  choices and bounded stage evidence. Stage/version checks prevent backtracking;
  identical retries replay the retained next response. Store challenge hashes and
  encrypted replay material, not plaintext codes in logs, audits or staff UI.
  An ordinary hangup after code issuance does not invalidate the SMS request;
  expiry, answered Dial, cancellation or revoked policy/provider authority does.
- Persist exact signed AccountSid/From/To/MessageSid context during confirmation,
  never infer it from historical phone-level messages. STOP/START/HELP keep their
  existing priority. CALLIE never clears suppression or grants general consent.
- All modes compete for `missed-call-care:<callId>:sms:v1` in the existing durable
  execution ledger. A reviewed old send, processing/unknown receipt, policy edit,
  new code, different body or reconciliation cannot authorize a second effect.
- The new contact-free acknowledgment has a typed grant-owned dispatch ledger;
  ordinary `sendTwilioSms` consent behavior stays intact. Share the organization
  budget lock/count across both SMS ledgers and include both in phone caps.
  Reuse the established no-redirect/no-retry network safeguards. Provider calls
  remain outside database transactions. Any uncertain POST/finalization stays
  owned and non-retryable; provider acceptance is not handset delivery.
- Immediately before POST recheck exact grant, stage/version/head/receipt,
  policy/approver/eligible owner, binding/program, account/number/origin, expiry,
  company/platform holds, all matching contacts' DNC flags, phone suppression,
  other inbound activity and sending window/caps. Only the exact triggering SMS
  is exempt from the new-reply stop; no broad ignoreReplies/skipConsent option.
- Reuse the original missed-call handoff/task. Do not fabricate reviewedAt or
  reviewedBy. New admitted calls have one authoritative CALLIE workflow; the old
  care scheduler/UI must not independently approve, send or escalate them.
  Preserve historical/manual calls and their receipts without adoption/deletion.
- Requested visits stay explicitly unbooked. Office booking needs canonical
  staff-reviewed contact, same-customer property/lead, accepted technician,
  current version, future exact window and a fresh customer-confirmed checkbox.
  Atomically link the one native appointment and finish the original task; no
  duplicate appointment on concurrent retry/lost acknowledgment. Never invent
  calendar deep links that the application does not support.

## Lane ownership

1. Intake lane: new schema `lib/db/src/schema/callie.ts` and pure shared contract;
   signed voice admission/DTMF/replay/challenge and inbound SMS consumption;
   narrow hooks in twilio-voice.ts and twilio.ts; focused ingress/race tests.
2. Runtime lane: policy preview/approval/authority; grant-owned acknowledgment,
   delivery callbacks/scheduler, shared SMS allowance/caps and legacy-care
   exclusion; kernel/provider tests. Own new shared allowance helper and the
   narrow existing twilio-delivery.ts budget change; no generic consent bypass.
3. Experience lane: authenticated CALLIE list/detail/policy/office action routes,
   native office booking service and full Calls UI; concrete contract tests,
   stale/session/role controls, paginated worklist and phone layout.
4. Coordinator: contract/API alignment, schema export/SQL/inventory/export,
   scheduler/router mounting, generated OpenAPI, combined recovery/browser/tests,
   peer review, exact candidate+main CI, Git integration and durable checkpoint.

All lanes share files. Confirm schema/types/functions with peers before relying
on them; do not edit another lane's files without coordination. No commits or
shared state edits from workers. Use provider-free synthetic runners only.

## Required acceptance

Default-off and no historical/mid-call admission; all missed/answered states;
full signed URL/form/provider identity; duplicate/out-of-order/changed callbacks;
no-input interruption; wrong/expired/replayed/cross-company/code confirmations;
concurrent consume/dispatch/booking on PostgreSQL; STOP/HELP precedence; revoked
policy/owners/binding/company during preparation; no-contact/DNC/ambiguous phone;
exact trigger versus another message; quiet-window/cap contention; post-POST
timeout/lost final write/late acceptance/reconciliation; original task integrity;
no fabricated identity/consent/lead/booking; stale exact office agreement;
bounded old attention visibility; actual UI desktop/mobile and restored data.

Complete focused and full source checks plus exact candidate and merged-main CI.
Keep fixture/managed backup evidence separate. No hosted schema/provider resource,
credential, DNS, phone forwarding, purchase, live SMS/call or customer activation.
Azure first sign-in and both contractor replacement cards remain owner gates.

Official references checked October 3: Twilio Dial/Gather, webhook security,
Advanced Opt-Out and Messaging Policy. These guide engineering; they do not
attest an actual client's registration, legal basis or live delivery.
