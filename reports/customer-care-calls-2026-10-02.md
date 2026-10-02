# CALLIE customer-care recovery — 2026-10-02

## Scope and status

Implemented locally for the canonical private GrowthOS application. This is a guarded, individually reviewed missed-call response workflow, **not** an autonomous unknown-caller receptionist and **not** live provider acceptance. No provider, number, registration, webhook, credential, customer account, hosted schema or production setting was activated in this lane. Twilio remains the transport; no SIM gateway or verification-code service was substituted.

The existing signed tenant-bound voice intake remains authoritative. Completed/answered calls do not create missed-call handoffs. Inbound dialing now uses `answerOnBridge: true`. The existing one-call/one-task handoff creates an internal recovery case, never SMS consent or an automatic customer send. A reviewed new opportunity now enqueues the existing canonical staff lead notification inside the same transaction; duplicate review does not create another lead/notification, and no `lead.created` outreach-enrollment event is emitted.

## Contractor workflow

1. In **Calls**, review the missed caller and link an existing customer or explicitly create an opportunity. Caller ID alone is not identity review or consent.
2. An owner/admin explicitly approves company recovery settings: disabled by default, accepted active business-hours and after-hours staff, an IANA time zone, business days/hours and a response deadline. This saves configuration; it does not approve all past calls.
3. For each reviewed call, preview the exact branded customer-care SMS and current recipient. A separate unchecked approval queues one reply. It must have current generic SMS and customer-care-purpose proof for the current SMS disclosure program, no suppression/DNC/reply hold, approved Twilio binding and no company/environment hold.
4. The bounded scheduled stage checks the exact approval again and uses the shared Twilio transport with a final pre-dispatch callback. The message asks what service is needed and a suitable callback time. It does not confirm an appointment or promise emergency dispatch.
5. The owner sees the assigned staff member, deadline, linked callback task/opportunity, provider status and recent signed texts from that company/phone. Phone-level inbound text association explicitly requires staff review; it does not assert precise campaign attribution or booking.
6. A missing reply or failed delivery escalates the existing callback task, not another text. **Mark handled by staff** atomically closes the case and original callback task. **Cancel recovery** stops the workflow but leaves callback work open. An unknown provider result must first be reconciled through the existing execution-receipt workflow; reconciliation never authorizes a resend.

## Safety and durable ownership

- Two narrowly scoped tables: `missed_call_care_policies` and `missed_call_care_cases`, with tenant-composite call/user foreign keys, unique call ownership and approval/case versions. Root owns additive SQL, schema exports, recovery, export/offboarding guards and scheduler registration.
- One fixed durable action/transport identity: `missed-call-care:<callId>:sms:v1`. A new click, changed body, policy version or reconciliation cannot create a new logical send for the same call. Retained receipts are not rewritten.
- Exact approval binds call/handoff/contact/lead, phone, reviewed timestamp, missed status, policy version/deadline/owner, template version, rendered message, account/binding/sender/service/disclosure/business name/public origin. Approval expires after 24 hours; calls older than seven days cannot send through this workflow.
- Customer texts wait for the explicitly approved business window, including after-hours calls. Routing to the after-hours staff owner does not override quiet hours. Another dispatch to the same company/phone within 24 hours defers the new call response. All dispatch statuses count conservatively.
- Both owner roles and approvers must still be active, verified, accepted same-company staff with appropriate permission. A changed decision, phone, policy, binding, consent, membership or hold blocks the old approval. A late guard cancellation is conservatively retained for operator reconciliation; it is not automatically retried.
- The stage processes at most 20 missing cases, 20 due approvals and 50 monitored cases per pass. Paused companies are filtered before limits. Unchanged monitored cases rotate by last-checked update time so an old blocked case cannot permanently hide later replies/deadlines. No new standalone worker was added.
- Signed delivery callbacks remain correlated by the existing Twilio dispatch operation and provider identity. Provider acceptance, provider-reported delivery and customer response are distinct evidence. `delivered` is not proof of reading or appointment confirmation.
- Human mutations reject API keys before lookup, non-JSON, foreign/malformed Origin and cross-site/same-site browser requests. Missing Origin is allowed only for a syntactically valid Bearer session which membership middleware actually authenticates; Basic/garbage Authorization cannot bypass ambient-cookie protections. Tenant identity always comes from membership.
- Inbound customer text is displayed as data, not executed as agent instructions. No AI tool execution, payment collection, automatic appointment booking, voicemail recording or emergency handling was added.

## Local verification

Provider-free disposable PGlite runner (explicit fresh test database and scrubbed environment):

```text
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/routes/v1/missed-call-care.test.ts src/services/missed-call-care-policy.test.ts src/services/missed-call-care.test.ts
```

Result: **28 passed** across three files. These exercise the actual shared Twilio delivery adapter with synthetic provider responses, not a live Twilio account. Cases include defaults and duplicates; answered calls; foreign/inactive owners; exact preview/version guards; changed purpose consent/DNC/policy/phone/owner/reply; consent absence; final pre-dispatch policy withdrawal; company/environment holds; after-hours routing; frequency cap; reply deadline escalation; signed inbox/STOP evidence; unknown outcomes and fixed receipt identity; abandoned processing ownership; canonical staff push; and HTTP authentication/tenant/origin/JSON/API-key boundaries.

```text
cd artifacts/command-center
node node_modules/vitest/vitest.mjs run --config vitest.config.ts src/pages/calls.test.tsx --maxWorkers=1 --no-file-parallelism
```

Result: **6 passed**. UI coverage includes read-only/default read behavior, canonical deep links, exact explicit one-time approval, stale-preview invalidation with no automatic retry, viewer controls, unknown-result reconciliation navigation and policy-checkbox reset after edits.

Command-center `tsc --noEmit -p artifacts/command-center/tsconfig.json` passed. Root owns combined API/type/build and full-suite release results. The local PGlite checks do not attest independent multi-connection PostgreSQL races, hosting, the production scheduler, signed live calls, handset reception or push receipt. Those remain explicit release/customer-activation checks.

## Review and remaining acceptance gates

Cross-review found and repaired a real cookie-Origin bypass caused by treating any Authorization header as bearer authentication. Regression checks now cover a valid cookie plus `Authorization: Basic ...` from an untrusted sibling Origin, real Bearer credentials from a foreign Origin, null/path/missing origins and fetch-site restrictions.

An independent read-only review of the invoice-delivery service/contract, HTTP boundary, shared sender-resolution chain and focused tests found no additional concrete bypass. That review does not replace root's combined checks or live provider acceptance.

Before a controlled contractor pilot, root/operator must finish exact-head CI/release checks, additive schema and recovery/export verification, configure accepted staff and the actual company schedule, verify the client's Twilio account/number/program/registration and SMS consent enrollment, inspect disabled-safe provider settings, then authorize a small controlled signed call/SMS/reply/STOP/delivery test. No unknown caller should receive an unsolicited text merely because this feature exists. Azure/Microsoft first-sign-in work remains a separate deferred owner gate.

Known deliberate boundary: this first recovery slice still requires individual staff caller/message approval. It can automate the approved send and follow-up attention tracking, but does not autonomously enroll or text arbitrary missed callers. Case owners configured after an older case was created become the approved owner at preview/approval; older unapproved internal cases can still show an owner-assignment reminder.

## Official references consulted

- [Twilio Dial TwiML: outcomes, action callbacks and answerOnBridge](https://www.twilio.com/docs/voice/twiml/dial)
- [Twilio webhook request security and signatures](https://www.twilio.com/docs/usage/webhooks/webhooks-security)
- [Twilio Advanced Opt-Out and inbound opt-out handling](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out)
- [Twilio Messaging Policy](https://www.twilio.com/en-us/legal/messaging-policy)

The GrowthOS revenue-desk skill kept scope on the canonical isolated contractor workflow and honest release evidence. The Twilio missed-call skill informed signed callbacks, consent, exact tenant routing, durable operations and separate live approval gates. The checkpoint skill is satisfied for this lane by the durable code/tests/report handoff; root retains sole ownership of the final Jarvis `STATE.md` update, combined commit and push. No memory, settings or unrelated starter-project files were changed.
