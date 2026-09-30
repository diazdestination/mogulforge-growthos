# Painless Twilio integration readiness — September 28, 2026

## September 30 tenant-binding engineering update (local only)

The global single-organization account/number fallback described below has
been replaced in local code with a disabled-by-default, one-organization/
one-subaccount/one-number binding. Signed inbound events select by exact
account and number; callbacks bind to the original operation. Two synthetic
tenants and per-client revocation are covered by `test:twilio`. See
[TWILIO-TENANT-BINDING.md](TWILIO-TENANT-BINDING.md) for the actual contract.
This is not a migrated deployment or a live Painless/HVAC connection. The
client-branded public SMS opt-in page, real provider inventory, approved
numbers/registration, credentials, exact-head release gate, staging and
real-handset proof remain outstanding. Older statements below are historical
snapshots, not the current local binding design.

## September 30 local code update (not live)

The existing single-organization voice callback now creates one high-priority staff callback task when a signed inbound call's staff leg returns busy, no-answer, failed or canceled. A tenant-scoped staff review can link an existing contact with a matching phone or explicitly create one opportunity and assign its callback task. It is idempotent by call/review request, audited, and creates no SMS consent, automatic text, playbook enrollment, AI booking or provider call. The Calls screen exposes this review path. Synthetic tests cover callback replay, unknown caller, cross-tenant denial and no SMS. The older statements below describe the prior baseline; do not read them as the current code state.

**Still blocked for both-client operation:** voice configuration and signed inbound routing remain bound to one global organization/account/number. There is no separate Painless/HVAC provider binding, approved numbers, on-call roster, registered SMS sender, tenant-specific disclosure or live missed-call acceptance. Do not activate this code for either client or claim both missed-call automations are functioning in production. The per-client mapping and provider release sequence below still applies.

**Preparation only. Painless is prospective and is not authorized for activation.** Start with client onboarding, then voice routing plus call history, then approved two-way SMS. The local implementation now separates voice configuration from SMS, but shared client routing and release readiness are still blockers. Do not promise service immediately after an onboarding form is completed.

## Account choice

| Model | Ownership and registration | Readiness |
| --- | --- | --- |
| Platform-managed | Verified platform legal operator owns billing; one Painless subaccount, dedicated number, credentials and Messaging Service; Painless supplies its own legal identity and sender registration. | Existing paid account may be reusable after inventory and authority review. Its visible Serenity primary business profile was Draft/Direct. An approved individual profile, if found, would not satisfy the documented ISV business-profile prerequisite. |
| Client-owned pilot | Painless owns an upgraded account, billing, number and its own business/sender registration; grants narrowly scoped integration access. | Recommended fallback if platform legal identity is the delay. Requires Painless's agreement, account eligibility and the same tenant adapter work. It is not an exemption from A2P/TFV or an automatic reclassification of an ISV as Direct. |

Twilio's [ISV API guide](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api) requires an approved Primary Business Profile with ISV Reseller or Partner identity before client onboarding. Its [architecture guide](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv) prefers one customer per subaccount with the customer's secondary profile, brand and Messaging Service. Subaccounts do not separate parent billing liability.

For a client independently operating its own messaging, [Twilio's direct registration guide](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/direct-standard-onboarding) describes the client's primary profile, brand and campaign. The proposed GrowthOS operating relationship must be truthfully classified before submission. [Twilio Connect](https://www.twilio.com/docs/iam/connect) supports customer-paid accounts, but [Connect limitations](https://help.twilio.com/articles/36665782139931-Twilio-Connect-Limitations) include incompatibility with Trust Hub and inability to create API keys/subaccounts or manage verified caller IDs. Connect is not the selected shortcut; account-owner Console registration and explicitly authorized integration access are the pilot candidate. No account/access/resource has been created for Painless.

Serenity and K. Rae Kreations are separate operator candidates from the WillowNote discussion. Neither is Painless's messaging brand. No SSN should be obtained or entered as an EIN. Existing private K. Rae information is already available in the original handoff and coordinating conversation; do not ask for it again, copy it into Git, or substitute it for client data. The reported IRS address and current physical address differ. A missing IRS letter does not block drafting; the actual selected verification flow and any mismatch determine the supporting evidence required.

## Source, hosting and provider evidence

- Local starting commit: `eec372f`, private `diazdestination/mogulforge-growthos`. The voice-only fix separates base voice account/number/origin/organization validation from SMS service validation. Default webhook validation still requires the SMS configuration; only voice routes opt into voice validation. `TWILIO_VOICE_BUSINESS_NAME` now supplies both spoken prompts, requires a reviewed 1–120 character name without control characters, and fails closed when absent/invalid. The missed-call fallback no longer directs callers to MogulForge.
- [TWILIO-CLIENT-DISABLED.env.example](TWILIO-CLIENT-DISABLED.env.example) is the concrete local client configuration path: Painless draft display name, blank bindings/credentials, zero daily allowances, all voice/SMS/approval flags false. The actual application configuration functions and routes consume this exact template in tests and reject call initiation/callbacks without making a provider request. It is not installed into any environment and does not add multiple-tenant routing.
- Focused gate: 35 tests across four suites passed; API TypeScript passed. Tests use a new in-memory PGlite database and intercepted provider requests. No existing local/production database or live phone is used.
- Fly: release v4, image `mogulforge-growthos-staging:growthos-63a440bf`, digest `sha256:e22d35041e9a8404cc98d460b25655cedc74a95152dec27788d951097fb003fe`. One stopped machine, iad, autostart/autostop, minimum zero. Fly reports app status suspended; this observation does not establish a billing suspension. Secret names are APP_ORIGIN, AUTO_MIGRATE, SESSION_SECRET and DATABASE_URL only.
- Remote PR1 head `cd3f55129de15fcb15f80c6ea1c964135e6cb8d6` has [failed CI](https://github.com/diazdestination/mogulforge-growthos/actions/runs/36189250988/job/108250105168). Current local Twilio work is not the deployed release. Preserve the independent WILLOWFORGE P0 repair; this task does not fix or certify the general release gate.
- Twilio: earlier authenticated audit found the upgraded account with $8.40 and an incomplete Serenity business profile. The separate Serenity trial was suspended; WillowNote is a separate trial. Both browsers later returned to login. Approved individual/Starter/history, all numbers, services, brands/campaigns, TFV and voice trust/limits are **not yet inventoried**. Balance and account creation date do not prove identity approval or upgrade date.

## Concrete implementation work still required before client traffic

1. Replace the global single-organization provider binding with an audited organization-to-provider mapping. Outbound identity comes from the authenticated member's organization. Inbound resolution uses an allowlisted Account SID and called number to select the candidate secret, then verifies the exact external URL/full payload signature before any read/write. Never accept organization ID from a callback as authority, try every tenant's credentials, or fall back to a global sender.
2. Store secret references server-side and keep credentials, numbers, service, budgets and launch flags per client. Enforce uniqueness for the provider account/number binding and bind operation callbacks to their original organization, account, number and recipient. Revocation disables only the selected client. Give the client authorized staff access; platform client selection is not CRM impersonation.
3. Voice prompts are now configurable and the incorrect platform fallback URL is removed. The public SMS disclosures/enrollment still need reviewed client-specific routing and branding before SMS activation. Retain recording off, staff press-1 for requested outbound calls, and no automatic text for an unanswered call. Current inbound logging associates exactly one matching contact; an unknown caller creates call history with a null contact, not a new qualified lead/task. The pilot scope explicitly retains staff review of the call-history phone/status followed by a separately recorded manual lead/task until the bounded linking workflow below is implemented.
4. Keep Painless website `worker/growthos.js` bound to its own Smart Site. Existing general contact authorization is not the Twilio-specific purpose/phone-proof record. Existing public enrollment at `/sms-preferences.html` is MogulForge-specific and expects an existing CRM contact; it needs client routing/branding before Painless enrollment. Do not derive texting consent from a missed call or a required service-contact checkbox.
5. Implement and test the client mapping, branding, permission boundaries and revocation with two synthetic tenants. Reuse the existing signed callback, idempotency, consent/suppression and uncertain-send safeguards. Review PostgreSQL concurrency separately from PGlite tests. Finish the whole paid-beta release gate and exact-commit staging before release approval.

The older `C:/Users/diazd/dev/projects/missed-call-revenue-agent` starter is **not a deployable workaround**: its queue sends SMS without purpose/phone-proof gates, its TwiML claims a text was sent before delivery, CRM forwarding is a generic unauthenticated payload rather than GrowthOS's tenant contract, and ambiguous retries can duplicate effects. This audit did not modify or deploy that starter. Use the existing GrowthOS call records as the pilot foundation and keep the starter outside the launch path.

### Engineering ownership and next implementation

These gaps are **not blocked by Twilio login**. They belong to this GrowthOS/Twilio integration workstream; the separate WILLOWFORGE P0 workstream owns the general release repair. They are deferred to a separately reviewed integration change because replacing global account credentials affects every SMS/voice callback, consent lookup, durable operation and authorization boundary, and requires schema/secret-lifecycle/rollout work beyond the bounded configuration repair. Neither a restored login nor changing one environment UUID implements client isolation.

The smallest next mapping change is a disabled-by-default `organization_communication_accounts` binding with organization/account/number uniqueness, secret references, business display name, channel limits and activation/revocation state, plus pure outbound/inbound resolvers. Prove with two synthetic clients that the wrong account/number/signature/operation cannot select another tenant, that revoked bindings cannot initiate traffic, and that status callbacks resolve the original operation. Then wire the existing SMS/voice handlers to those resolvers without a legacy-global fallback. It can be developed offline after reconciling the current P0 branch; real credentials and release are later steps. Do not migrate or enable production as part of that implementation.

The smallest unknown-caller change is an authenticated, tenant-scoped staff action to link one existing call to an existing contact or explicitly create a lead and follow-up task in one idempotent transaction keyed by the call ID. It must verify the contact's organization and phone, record who approved it, avoid automatic enrollment/sending, reject cross-tenant and duplicate attempts, and leave the original provider call history intact. It is deferred because automatic lead creation could trigger existing playbooks and invent consent/qualification. Manual call-history review is the intentionally smaller pilot workflow, not a claim that automatic recovery is built.

## Staged activation and acceptance

| Stage | Concrete action after its approvals | Acceptance |
| --- | --- | --- |
| Client onboarding | Collect private legal/authorized-representative information, billing ownership, existing-number ownership, staff routing, hours, website/policy URLs, consent method and expected volume. Provision an inactive isolated GrowthOS organization/site and authorized staff through the approved onboarding flow. | No cross-tenant records/keys; manager and responder present; credential handshake and real-inbox/contact-policy/HTTPS attestations pass Launch Guard. |
| Voice pilot | Resolve the account model and eligibility. Reuse only a suitable number owned/authorized for Painless; otherwise request one approved local voice/SMS-capable number. Deploy a green, reviewed tenant adapter with all sending off; configure reviewed voice callbacks and US geographic restrictions. | Signed callbacks bind to Painless; staff handset bridge, caller ID, answered/busy/no-answer/failed/canceled paths and call history tested using explicitly authorized handsets. No SMS, recordings or invented lead/booking/revenue proof. |
| Two-way SMS | Use Painless's approved sender registration, dedicated service, approved public opt-in evidence and purpose-specific phone proof. Configure STOP/HELP and callbacks. | Staff reply, inbound text and actual carrier delivery receipt verified. STOP suppresses only Painless; START alone does not restore purpose consent; changed phone requires fresh proof; unknown callers cannot receive automatic recovery texts. |
| Consented follow-up | After reliable scheduled execution and approved templates/purposes, enable bounded reminders/follow-up. | Restart/ambiguous-send reconciliation, duplicate callbacks, tenant separation, delivery events, alerts and a real opted-in test pass. |

Keep the existing business number and carrier service. The first number can be a separate pilot line, or the carrier can conditionally forward unanswered calls after an approved test. Forward to a distinct staff destination that does not forward back to Twilio; test no loop and voicemail timing. Forwarding voice does not migrate SMS. Do not port/cancel the incumbent number for this pilot. Traffic cutover and rollback remain explicit approved actions.

Voice and SMS approval are independent. [Twilio confirms TFV messaging restrictions do not apply to voice](https://help.twilio.com/articles/20212966914075-Toll-Free-Verification-and-Developers-Navigating-the-New-Restrictions), but account suspension, number capability, region permissions and concurrency still apply. [Current call-limit guidance](https://help.twilio.com/articles/223180028-How-fast-can-I-place-or-receive-phone-calls-with-Twilio) distinguishes individual/business profiles and upgrade dates. Verify the actual account's limit; do not infer grandfathering from its August 2025 creation date. A bridged call can consume two call legs.

## Kill switch and rollback

Current local controls: `TWILIO_VOICE_ENABLED=false` prevents new voice initiation/bridging; `TWILIO_SMS_ENABLED=false` prevents new SMS; `TWILIO_LAUNCH_APPROVED=false` disables both. The shared adapter needs equivalent per-client controls before activation. Signed status updates should continue for existing operations. These controls are not cancellation of an active call or accepted provider message, do not stop number rent/campaign fees, and are not a dollar cap.

Before changing any live routing, save the existing number callbacks and carrier forwarding setting. On failure, use the pre-approved carrier revert to restore normal business calls, disable client initiation, preserve logs/uncertain operations, and reconcile Twilio before retrying. An urgent in-progress call termination needs its own authorized provider action. Never release a number or delete a profile as rollback.

## Launch decision record

All remain unapproved: chosen account/legal operator; client authority; exact number/resource; one-time and monthly caps; allowed destinations; provider secret destination/access scope; production migration/deployment/webhooks; registration attestation; named test recipients; traffic cutover and rollback. Recording remains off and is not requested.

Prepare the final account-specific quote after inventory, then obtain approval for the exact action/data/destination/cost. No blanket authorization is requested here. User-facing cost comparison and short intake: `C:/Users/diazd/Documents/Codex/2026-09-28/realtime-voice-chat/outputs/painless-growthos-twilio-readiness.md` and sibling `painless-client-intake.md`.
