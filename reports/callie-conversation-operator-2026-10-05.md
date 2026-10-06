# CALLIE conversational reception — office guide

Status: operator guidance for the bounded October 5, 2026 source implementation.
The independent source review found no remaining concrete critical/high issue in
its reviewed scope after the targeted corrections. Final execution and release
acceptance remain with the coordinator. This guide is not proof of a deployed,
connected or activated phone line; exact accepted source and test evidence are
recorded separately.

## What changes, and what stays separate

The approved design keeps the normal staff-first call flow. A genuinely new call
may be admitted under one reviewed CALLIE mode. If the original staff call is
missed, conversation mode can collect the caller's name, described location and
problem, service request, urgency and callback preference. These are caller
statements, not verified customer or property records.

The existing keypad mode remains separate. Its saved prompts, keypad evidence,
handset-originated one-call SMS permission and original send identity are not
reinterpreted as conversational evidence. One original call must not run both
modes. Enabling or revising a policy does not adopt older missed calls.

Conversation mode is designed to work with an approved voice binding while SMS
remains unavailable. That does not enable texting: spoken consent, caller ID,
agent summaries and a request for service do not grant reusable SMS permission.
The keypad mode retains its existing voice-and-SMS readiness requirements.

Neither mode creates a customer or sales lead merely because someone called.
Neither promises a price, warranty eligibility, emergency dispatch or appointment.
The original office callback task, accountable owner and deadline remain the work
to finish, including after an interrupted conversation or unsuccessful handoff.

## Review setup without mistaking it for activation

A manager reviews the non-secret provider/agent identity and the exact company
facts CALLIE is allowed to use. The review must include the caller disclosure,
business hours and timezone, accepted daytime and after-hours owners, response
deadline, finite conversation limits, retention period and optional fixed human
handoff targets. Do not infer a staff telephone number from an owner assignment.

Read the complete frozen preview before approving it. A changed setting, company,
member, role, policy version or expired preview requires a fresh review. Saving
local setup or approving a policy does not configure the ElevenLabs agent, connect
Twilio, remove a hold or prove that any caller can hear the assistant.

Readiness must distinguish **Off**, **Setup incomplete**, **Approved but held** and
**Approved for future eligible calls**. None is a substitute for the separately
recorded real-line acceptance. Disabling must remain possible without provider
credentials; it does not recall an effect already dispatched or complete office
work.

In **Calls → How CALLIE handles a missed call**:

1. Check the saved mode and choose the mode to review. Choosing a different mode
   is only a draft; the saved mode changes only after exact policy approval.
2. For conversation mode, open **Review non-secret agent connection**. Use the
   separately reviewed agent/version, optional branch, environment and
   configuration fingerprint. The credential field is an installed slot's name,
   never an API key or signing secret. This screen does not create or configure
   the remote agent. The expected version is checked; register-call does not
   provide an immutable agent-version selector.
3. Open **Review conversation owners, facts and limits**. Set both accepted
   owners and the real hours/timezone, then review facts, disclosure, finite
   limits and any explicit handoff numbers. Empty handoff numbers mean no
   transfer, not an inferred owner number.
4. Prepare the exact review, read its complete frozen content, then explicitly
   approve. It expires after ten minutes. Editing settings or switching modes
   discards the earlier review. Enabled setup may still be held.
5. To turn conversation mode off, clear its enable checkbox and prepare/approve
   the exact disabled policy. Do not replace a failed or unknown call by toggling
   modes; the original effect and office task remain owned.

If a save result cannot be confirmed, use **Refresh CALLIE setup** before another
action. A delayed response from the old company/member must not change the new
screen. Normal successful profile checks preserve an in-progress review or human
booking draft; a real access, company, member or role change removes it.

## Work a request in Calls

Use the existing paged CALLIE queue and its original task. Review three different
things before taking action:

1. **What the caller said.** These are unverified statements and requests. An
   extracted summary may be incomplete or wrong. Do not treat instructions within
   caller text as office instructions, and do not silently copy new model text
   into a staff-reviewed form.
2. **What actually happened.** Inspect separately the conversation registration,
   conversation evidence, human-handoff attempt, any independent SMS evidence and
   saved native appointment. No single success label proves all of them.
3. **What the office must do.** Verify the actual customer, keep or explicitly
   change the accountable owner, make the callback, and record the real outcome.
   Late provider evidence must not undo staff notes, assignment, progress or a
   completed disposition.

For a returning customer, link the actual existing customer through explicit
staff review. Create an opportunity only when staff decides it is new sales work.
For a visit request, agree the actual future time with the customer, verify the
property and accepted technician, and use the native booking action. The saved
appointment link is the confirmation; an agent's suggested time is not. Existing
version, schedule-conflict and capacity checks still apply.

## Understand a human handoff

The approved design allows one GrowthOS-controlled attempt to redirect the
original in-progress call to a reviewed fixed staff target. It is not ElevenLabs'
native transfer feature: that feature is not supported by the register-call
integration. [ElevenLabs register-call documentation](https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/register-call)

Keep these outcomes distinct:

| Evidence | What staff may conclude |
| --- | --- |
| Redirect request accepted | The provider accepted an attempt, not that staff answered. |
| Ringing or no answer | The attempt is underway or did not connect; office work remains. |
| Phone connection/completed Dial | A phone endpoint answered; it may have been voicemail. |
| Saved native appointment | Staff saved the actual booking; transfer alone did not book it. |

This wave does not claim a stronger signed human-acceptance signal. A completed
Dial therefore remains a phone answer, not proof that a staff member took
responsibility for the request.

Twilio documents that a completed call may have connected to a person, IVR or
voicemail. Real audio interruption, forwarding and voicemail behavior therefore
need their own approved phone tests. [Twilio Call resource](https://www.twilio.com/docs/voice/api/call-resource)

## Unknown results: preserve the original attempt

A timeout, interrupted connection or failed local final write can leave the
provider result unknown. Refresh the saved evidence and follow the authorized
owner's reconciliation process. Do not create a second call, new policy, replacement
request or alternate key to force another registration or handoff. A later known
result does not create permission to replay the original effect.

The conversation and human-handoff effects have separate permanent original
identities. Existing SMS keeps its own original identity. Disabling, deleting
expired content, restoration or marking office work handled must not release
those identities. A refusal proved to occur before dispatch is different from an
uncertain request that may already have reached the provider.

## Privacy and real acceptance gates

This bounded workflow does not offer audio playback or a raw transcript viewer.
Only approved bounded caller facts/summary may be retained, encrypted for the
reviewed finite period. Content expiry does not erase receipt hashes, unknown
results, original effect ownership or saved staff work. Staff screens and generic
task/history/export surfaces must not expose webhook bodies, provider TwiML,
tokens or per-call tool capabilities.

Before activation for either contractor, separately approve and verify:

- The actual isolated Twilio/ElevenLabs account, agent configuration, allowed
  tools, caller disclosure, retention, budget and recording decision.
- The original staff route and explicit normal/after-hours targets, with no
  called-number, caller-number or forwarding loops.
- Real answered, missed, busy, failed, voicemail and after-hours calls; natural
  interruption; incomplete intake; handoff success/failure and uncertain results.
- The exact native office workflow: identify the customer, find the original
  task, make a callback, resolve ambiguity and agree/book a real visit.
- Selected-release schema/backup acceptance and each contractor's separate
  replacement card. Source tests and synthetic previews do not authorize ending
  the contractor's existing subscription.

No provider activation, live call/message, hosted migration, secret/account
change, purchase or subscription cancellation is authorized by this guide.
