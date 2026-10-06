# CALLIE conversational reception — frozen engineering contract

Frozen October 5, 2026 America/New_York (October 6 UTC), before product changes.
Owner approved the next big wave after the final manual-appointment CI completed.
Base is main afcb72a810a55ea32c42adb2f342477bb0e7299f, accepted tree
1e52585c923890adc52d5e03575f0f666461af67. PR23 and exact-main CI37390525754
attempt1/job112034246138 passed and were independently accepted. Never replay
those completed release operations. Work branch:
agent/growthos-callie-conversation-20261005.

This contract closes a bounded part of launch L4: natural missed-call intake,
accountable office work and a controlled human-handoff attempt. It does not close
the whole four-package onboarding plan or either contractor acceptance card.

## Required behavior

1. Preserve the signed, company-bound, staff-first Twilio incoming call flow.
   Only a genuinely new eligible call can acquire the reviewed conversation
   policy. After the original signed missed Dial result, use ElevenLabs register-
   call to supply natural conversation. Answered original calls never enter it.
2. CALLIE collects bounded caller statements: name, described location/problem,
   repair/replacement/maintenance/other, callback/visit request, urgency and callback
   preference. Facts remain explicitly unverified. One original callback task,
   owner and deadline remain canonical. No duplicate customer or invented lead.
3. Provide only call-scoped tools: initialize/read approved reception context,
   save bounded caller facts and request one approved human handoff. No generic
   CRM, arbitrary HTTP/MCP, private customer lookup, email/SMS, payment or autonomous
   appointment tool. Existing explicit staff review and native booking remain.
4. Include a GrowthOS-controlled cold handoff of the original in-progress Twilio
   Call resource to an owner-reviewed fixed staff target. It is our own redirect,
   not ElevenLabs's native transfer feature. Separate original staff Dial and
   later handoff identities/outcomes. Provider acceptance is only an attempted
   redirect. A normal completed Dial may be voicemail; show a phone answer as
   such unless a signed staff acceptance step provides stronger evidence.
5. Caller request and actual saved work are separate. Retain failures, interrupted
   calls, declined/incomplete intake and uncertain effects in the office queue.
   A summary, model success score, preferred date or transfer attempt must never
   imply identity, messaging permission, warranty coverage, emergency arrival,
   confirmed booking or completed callback work.

## Chosen integration and provider boundaries

Use register-call, retaining GrowthOS's existing Twilio routing. Do not import
or reconfigure a company number into native ElevenLabs during this wave. Native
import is a different future routing design, and register-call has no ElevenLabs
transfer support. Our narrow handoff adapter uses the documented Twilio Call
update/TwiML path with absolute signed callback URLs and parent/child checks.
Actual audio interruption, phone/voicemail/transfer behavior must be accepted on
approved real test lines before activation.

Registration supplies initiation data itself; do not assume a later initiation
webhook will run. The generated agent configuration uses a secret__ per-call
capability in tool headers, never ordinary model-visible text. Store only its
hash/expiry and protected encrypted replay material where strictly necessary.
A separate non-secret session locator is not permission. Bind the conversation
through an authenticated initialization/tool interaction; an unmatched signed
post-call event cannot adopt a guessed locator or a public-widget conversation.

Pin selected agent/environment/configuration identities and a small versioned
prompt/tool contract. Agent setup/configuration export is local preparation only;
no provider API configuration or account capability is presumed. Require known
8kHz mu-law-compatible TwiML and fixed expected provider destinations. Invalid
responses, redirected network requests and unknown provider effects fail closed.

## Policy, persistence and office ownership

- Preserve every v1 snapshot, DTMF receipt, signed-handset one-call SMS grant and
  permanent original SMS key. Add an explicit versioned conversation policy and
  intake mode; do not create fake keypad receipts or reinterpret SMS accepted.
  Exactly one mode/workflow owns each original call. Historical calls cannot be
  adopted by enabling a new policy. Legacy recovery remains excluded for admitted
  conversational calls.
- Conversation policy can be voice-only while SMS is unavailable. This is a
  separately reviewed version with voice binding requirements, not a bypass of
  old v1 SMS/program/disclosure guards. Current legacy policy behavior remains.
- Bind preview/approval to exact actor, version, voice/provider identity, approved
  business facts and caller disclosure, owners/hours/deadline, finite conversation
  limits, content retention and optional fixed handoff targets. Disabled/held
  policies must remain savable without credentials. Revisions affect future
  calls; every new unclaimed tool/handoff rechecks current authority.
- Do not infer owner telephone numbers or contractor facts. Handoff targets are
  explicit nullable settings. Reject self/caller/called-number loops and known
  forwarding loops. The configured carrier route still needs real acceptance.
- Add exactly three bounded tables: callie_reception_bindings,
  callie_reception_sessions and callie_reception_events. Extend existing canonical
  CALLIE policy/intake representations for v2 mode without changing old evidence.
  Use tenant-composite foreign keys, original-call/conversation uniqueness,
  closed state checks, immutable event keys/hashes and bounded encrypted content.
- Reuse the revenue execution ledger for lifetime original effects:
  callie:<callId>:conversation:v1 and callie:<callId>:human-transfer:v1. No alternate
  retry key. Refusal before provider dispatch, actual acceptance, uncertain result
  and failed local final write remain distinct. Unknown/accepted effects cannot
  be rearmed by a policy revision, duplicate callback, tool request or restoration.
- Use ordered lifecycle/CALLIE and relevant native-schedule/budget locks plus
  real row locks on mutable original authority. Final claim is the authorization
  boundary: lock/revalidate current company, policy/binding, accepted owners,
  original call, original office task and session; persist the one effect claim.
  Bound provider I/O occurs without long-held SQL locks and without transport
  retries/redirects. Recheck immediately before invoking the transport; a claim
  is not delivery, and later revocation cannot recall an already dispatched call.
- Explicit staff disposition, notes, task progress, assignment and due dates are
  never overwritten/reopened by later caller/model/provider evidence. Reuse
  existing staff identity review and native office booking with version/conflict
  guards; no model impersonates a human actor or confirms an unsaved appointment.

## Content, authentication and UI

Post-call handling verifies HMAC/timestamp against exact bounded raw bytes. Accept
only original known agent/conversation/call context; exact duplicates are inert,
changed duplicates are rejected/retained as exceptions. No audio storage or raw
transcript playback. Retain bounded extracted caller facts/summary encrypted for
a reviewed finite period; content expiry/redaction preserves original ownership,
event hashes, uncertainty and staff work. Add lifecycle/inventory/restore coverage.
No secret, capability, token, raw webhook body or provider TwiML in staff DTOs,
generic tasks/activity/search/logs or export. Caller text is rendered literally.

Extend the existing Calls/CALLIE setup, paged queue and detail. Show separate
transport, conversation, transfer, SMS and native saved outcomes. Use plain Off,
Setup incomplete, Approved but held, and Approved for future eligible calls
states; no invented Live/verified timestamp. Manager-only non-secret binding and
exact policy preview/approval, current accepted staff, and explicit mode choice.
The same company cannot unknowingly run parallel keypad/conversation workflows.

UI actions depend on runtime-validated DTOs and actual server action flags. Keep
semantic member/company/role resets, unchanged-profile draft retention, stale
request cancellation, exact expiring approvals, optimistic versions and no replay
of unknown mutations. Do not merge model evidence into staff-owned form values.
Saved appointments use the tenant-pinned exact native link. Update only CALLIE's
verified capability copy; no agent-directory redesign or vendor ticket dashboard.

## Meaningful verification and release

- Synthetic fixtures for roofing leak/repair, HVAC service/maintenance, returning
  customer ambiguity, changed details, human request, interrupted/empty intake,
  unknown registration/transfer, late evidence and disabled/SMS-held conditions.
- Strict signature/account/origin/from/to/call checks, capability expiry/injection,
  cross-company/agent/conversation isolation, tool/schema/size/call limits, duplicate
  and changed payloads, known no-effect refusal versus uncertain dispatch, malformed
  TwiML, timeouts, lost final write, content expiry and recoverability.
- Independent PostgreSQL16 barriers using actual policy/task/office writers:
  concurrent missed callbacks issue one registration; a real authority writer
  waits behind final claim; tool/transfer contention retains one original effect;
  late evidence cannot undo staff work. PGlite timing is not a substitute.
- Preserve existing CALLIE, Twilio, SMS/STOP, service/lead reply, booking/reminder,
  lifecycle, customer work and source-recovery suites. Root runs focused tests,
  full UI/types/builds, compatible synthetic recovery and built phone/desktop QA.
- Root reviews the additive offline schema delta after0014 (three tables ->133),
  never applies it hosted. Require reviewed exact candidate full PostgreSQL CI,
  then safe accepted-tree merge/sync and one explicit ci.yml dispatch on merged
  main, followed by complete exact-main acceptance. No blind reruns or canceled
  active runs. Preserve the unrelated pnpm-workspace.yaml.bak and every user edit.

## Lane allocation and remaining real acceptance

Runtime lane owns new reception schema module, existing CALLIE schema/versioning
changes and schema export, backend policy/admission/provider/tools/evidence/office
integration, meaningful API/PG tests and early DTO contract publication. Experience
lane owns Calls/CALLIE components/types/tests and bounded CALLIE capability copy.
Companion owns independent contract/source review and operator guide only. Root
owns shared project docs, offline schema review, inventory/recovery/preview scripts,
integration, full checks, Git/CI and release. Coordinate before overlapping files.
Agents do not commit/push or operate Docker/providers.

No owner-at-desktop choice is needed for disabled synthetic-tested source. Actual
agent/configuration, budget/retention/disclosure, live provider routing/forwarding,
voice recording decision, day/after-hours targets, real audio/phone acceptance,
Azure/mailbox/phone connection and both contractor cards remain explicit gates.
No deployment, hosted schema/credential change, provider activation/configuration,
real calls/messages/imports, spending/payment or subscription cancellation.

Official architecture sources: ElevenLabs register-call/native integration,
personalization/dynamic variables, webhook tools and post-call webhooks; Twilio
Call resource update, Stream/Dial and webhook security. Fresh research and lane
plans are saved in the private October5 customer-workspace handoff.
