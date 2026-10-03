# CALLIE missed-call intake — office guide

This guide describes the bounded source implementation, not an activated phone
line. Existing Twilio approval, company isolation, provider tests, selected-release
staging and contractor acceptance are still required before real use.

## What the caller experiences

The normal staff line rings first. For a new call admitted under a separately
approved CALLIE policy, an unanswered bridge can offer a short keypad menu:
repair/replacement/maintenance/other, callback or visit request, then morning,
afternoon or no preference. A preference is not a promised appointment.

The caller can finish without texting; the original office callback task remains.
To request one fixed acknowledgment, the caller hears the complete disclosure,
chooses the text instructions and sends `CALLIE <eight-digit code>` from the same
phone to the shop number within 15 minutes. That signed incoming text authorizes
only this call's acknowledgment. Keypad input and caller ID alone do not authorize
SMS, verify identity, create a customer/opportunity, or book a visit. The grant
expires after 24 hours; current hours, limits, opt-outs and holds still apply.

This is not a freeform AI receptionist, recorded/transcribed call, emergency
dispatch guarantee, price quote, warranty determination or recurring-text signup.

## Configure once, review exactly

1. Open **Calls → Automatic intake setup → Review standing owners, hours and exact messages**.
2. Choose the company's timezone, normal business days/hours, accepted daytime
   and after-hours owners, response deadline and enabled/disabled state.
3. Prepare the review and read the exact prompts, text and non-secret sender
   identity. Explicitly approve the unchanged preview within ten minutes.
4. Inspect readiness. Approval does not configure Twilio, lift holds or prove
   delivery. Missing sender credentials/approval, company holds, revoked owners
   or a revised binding prevent execution. The policy is off by default.

Every revision is retained. Changes apply to new calls only; old calls do not
silently acquire permission. A new policy revision invalidates remaining
automated work under its predecessor. Disabling remains available while held.
This bounded CALLIE policy requires both voice and SMS/provider readiness before
admitting a new call. Existing staff ringing/manual handoff remains separate;
voice-only CALLIE qualification while SMS registration is pending is not delivered.

## Work the queue

**Calls → CALLIE · Missed-call office desk** has Needs attention, Waiting and
History. Each page shows at most 25 requests, ordered by the relevant deadline
or history time; it does not invent a whole-company exception count.

- Open a request to see caller-supplied choices, accountable owner, the original
  callback task, one-call text evidence, saved delivery result and any appointment.
- Call or otherwise verify the actual customer through the approved office
  process. Link the existing customer. Create an opportunity only when staff
  explicitly decides it is new sales work; ordinary existing-customer visits
  do not require inventing an acquisition lead.
- For a requested visit, agree the actual time with the customer, review the
  customer's property and accepted technician, and explicitly confirm booking.
  GrowthOS checks the future interval, technician conflicts and inspection
  capacity before saving one canonical appointment and completing the original
  callback task. Completion of the visit remains separate.
- Use Assign or close office work for an explicit reassignment or documented
  outcome. Reassignment holds the old automated acknowledgment. Stopping CALLIE
  does not pretend the callback task is finished; marking handled does.
- Changes in customer, assignment, session, saved version or exact review require
  refresh/review. Errors do not automatically replay mutations.

Existing business-call history and individually reviewed recovery remain under
the expandable **Business calls and individually reviewed recovery** section.
CALLIE-admitted calls cannot be recycled through that older send path.

## Unknown results and failures

A single permanent response identity spans both legacy and CALLIE paths. An
interrupted or uncertain provider handoff keeps that identity reserved. Do not
create a new code, policy, call copy or note to obtain a second send. The request
links to the original execution for an authorized owner's evidence-based
reconciliation; that reconciliation does not authorize replay.

Provider acceptance is not delivery, reading, a customer reply or booking. Signed
callbacks can add delivery evidence without rewriting an already reconciled
receipt. STOP, DNC/suppression, another incoming text, expired grant, changed
owner/task/binding, exceeded allowance or missed safe window hold the automation
and leave accountable office work. Shared company/phone caps include old sends.

## Acceptance before a contractor uses it

Run the real company's answered/no-answer/busy/failed/unreachable/voicemail and
after-hours matrix; exact disclosure/code/decline/expiry/STOP/HELP cases; duplicate
callbacks, lost acknowledgment, owner removal/reassignment and held-provider
cases. Verify actual customer receipt separately from provider acceptance.
Then have office staff find the request, identify a repeat customer, agree/book
one visit, handle conflicts and finish the work without coaching. Required
conversational reception and autonomous booking remain unaccepted capabilities,
not implied by this keypad workflow. Follow LAUNCH-COMPLETION L4 and both company
replacement cards; do not cancel an existing subscription on source tests alone.
