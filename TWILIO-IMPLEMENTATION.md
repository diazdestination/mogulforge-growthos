# Twilio implementation and access audit

## September 28 update: Painless readiness and independent voice configuration

Local voice routing and signed voice callbacks no longer require an SMS Messaging Service. SMS still requires its service, registration, consent and launch controls. Voice now requires an explicit bounded `TWILIO_VOICE_BUSINESS_NAME`; both caller and staff prompts use that name with XML escaping, and the missed-call fallback has no platform URL. Missing/invalid names disable voice. The tested [disabled client template](TWILIO-CLIENT-DISABLED.env.example) contains Painless's draft display name, empty account/tenant/credential bindings and all live flags off.

Focused validation: **35 tests passed** in the isolated PGlite runner, including incoming and requested outgoing voice with SMS disabled and no Messaging Service; invalid signatures/account/number, other-tenant access, configurable escaped prompts, the exact disabled template and the voice kill switch remain enforced. API TypeScript passed. These are synthetic results, not carrier acceptance.

The adapter still binds exactly one organization and still contains MogulForge public SMS disclosures. It is not a ready shared Painless connector. Read [TWILIO-CLIENT-READINESS.md](TWILIO-CLIENT-READINESS.md) for the client-account decision, outstanding tenant binding/SMS branding work, staged activation and rollback. The separate paid-beta P0/CI workstream remains authoritative for release; no production deployment or secret changes occurred.

Fresh read-only Fly inspection still shows release v4 with image `mogulforge-growthos-staging:growthos-63a440bf`, digest `sha256:e22d35041e9a8404cc98d460b25655cedc74a95152dec27788d951097fb003fe`, a stopped/autostart machine with minimum zero, and no Twilio secret names. The remote PR head remains `cd3f551` with failed CI. Neither is proof that the new local implementation is deployed.

Earlier September 28 authenticated account evidence is saved at `C:/Users/diazd/dev/jarvis/TWILIO-ACCOUNT-AUDIT-2026-09-28.md`: a paid account exists and its visible Serenity business profile was Draft. Historical personal/Starter verification and the full resource inventory remain unknown. Later in this run, both Chrome and the in-app browser required sign-in; secure sign-in was requested and the Chrome tab retained. A draft business profile does not establish that personal verification never occurred. WillowNote's separate trial account was created earlier; its operator decision is independent of Painless.

## September 27 implementation baseline

Audit date: September 27, 2026. Status then: local implementation and synthetic validation; provider setup blocked by authentication and verified identity. No account/resource creation, number purchase, account upgrade, campaign submission, real SMS, call, push or deployment occurred in that September 27 baseline.

## Verified inventory

| Item | Observation |
| --- | --- |
| Repository | `diazdestination/mogulforge-crm`, local `C:/Users/diazd/dev/projects/mogulforge` |
| Working branch | `agent/mogulforge-growthos-recovery`; safely fast-forwarded from `548e6a2` to existing remote `cd3f551` before local changes |
| Remote main | `debdb73867357e0d0312df7a98aa55ff02bd10a2` at audit |
| Marketing | `https://mogulforge.ai`, HTTP 200, separate marketing application |
| Product | `https://app.mogulforge.ai`, HTTP 200, GrowthOS |
| Host | Fly app `mogulforge-growthos`, region iad; one stopped/autostart machine, 1GB shared CPU; release v4, image tag `mogulforge-growthos-staging:growthos-63a440bf` |
| Deployed source | Image tag observed; exact source commit/branch not cryptographically established. It is not this new local implementation. |
| Fly secret names | `APP_ORIGIN`, `AUTO_MIGRATE`, `SESSION_SECRET`, `DATABASE_URL`; no `TWILIO_*` secrets |
| Local project secret names relevant to audit | `SESSION_SECRET`, `OPENAI_API_KEY`, `DATABASE_URL`, `PORT`, `NODE_ENV`, `ENABLE_DEV_LOGIN`; no `TWILIO_*` credentials |
| CLI / tools | No Twilio CLI on PATH, no profiles at standard Windows locations, no Twilio environment variable names at process/user/machine scope, no callable Twilio MCP tools |
| Browser | Both in-app browser and connected Chrome reached Twilio login. Chrome left at secure password form for `Adam@mogulforge.ai`; no credentials extracted or password saved by this run. |
| Twilio accounts, subaccounts, trial/paid status | **Unknown until authenticated audit**, not evidence that none exist |
| Numbers, capabilities, Messaging Services | **Unknown**; preserve/reuse suitable existing resources after audit |
| Trust Hub, brands/campaigns, toll-free verification | **Unknown**, including pending/rejected submissions; do not create duplicates |
| Provider webhook configuration | **Unknown**; source routes and proposed callback URLs below are not configured or live-verified |

The prior Painless packet is a historical draft, not evidence of Twilio resources or verified client identity. The original `pnpm-workspace.yaml.bak` was preserved.

Existing source had generic contact/channel `consent_records` with a disclosure version and public opt-out routes. Those rows did not prove control of the current phone or consent to a specific SMS purpose, so they are insufficient for the new send gate. No current Twilio-specific public terms/privacy or phone-proof CTA was verified in production. No production contact/consent rows were exported or modified for this audit.

## Structure and scope

Prefer a separate top-level account for MogulForge and a separate top-level account for WillowNote's verified operator, preserving any suitable existing accounts. Subaccounts share their parent's balance; different businesses must not silently inherit each other's billing. No account has been created or reassigned. Account owners and billing responsibility need confirmation after login.

Initial GrowthOS configuration maps exactly one Twilio account, Messaging Service, sender and explicit `TWILIO_ORGANIZATION_ID` to MogulForge's own business. A different organization cannot borrow this sender or consent. Future client businesses require verified legal identity, brand/campaign, consent, dedicated routing and credentials; subaccounts under a MogulForge account are appropriate only with an explicit billing/service agreement. The one-org adapter must be replaced by an audited tenant-to-provider registry before client rollout. Painless is excluded.

Implemented locally:

- Existing provider and appointment paths call the new consent gate with tenant, contact, purpose and stable operation key. Customer care and appointments are allowed only after phone proof. Existing promotional playbooks/automation and SMS portal authentication are deliberately blocked from borrowing this consent. Email behavior is unchanged.
- Public optional, unchecked purpose form at `/sms-preferences.html`. The customer must already have a matching number in this organization's CRM and prove control by texting `JOIN <one-time code>` from that phone. Requests alone grant nothing. Codes expire in 24 hours and are hashed; disclosure version, phone, purpose, source and timestamp are retained.
- Authenticated SMS inbox/replies and a five-minute phone bridge in Settings. Calls first ring an approved staff phone; press 1 connects the requested customer call. This is not a browser microphone/softphone. Inbound calls route to the staff phone; missed connection statuses are recorded for manual review, without automatic SMS. No recording, speech capture, emergency calling or autonomous dialer.
- Official Twilio SDK signature validation against pinned external origin plus original path/query; missing token fails closed. Account, number, operation and tenant are bound. Corrected legacy unsigned/global-phone routing in source. This fix is not deployed, and the older production image was not tested for that behavior.
- Durable send/call claims, idempotency, daily app allowances, status progression, STOP suppression and no blind retry after ambiguous acceptance. A 429 fails closed for staff review. An uncertain operation is never automatically resubmitted under its original key.
- SMS use/failure/reconciliation counts and 80% allowance warning in Settings. These are app-operation controls, not a dollar cap on Twilio or its other clients.

START removes only a STOP transport suppression. It does not restore purpose consent. HELP/STOP/START confirmation replies are supplied by the Messaging Service's Advanced Opt-Out configuration; these exact provider replies have not been configured or live tested. The app returns empty SMS TwiML to avoid duplicate keyword replies.

## Configuration map

Secrets belong in Fly's secret manager, never client bundles or Git. Use a product-specific restricted API key permitting the required Messages/Calls actions if supported for the chosen account; otherwise a least-privilege account-scoped standard API key. Retain the account Auth Token server-side solely for webhook verification. Verify grants with the actual account before activation; do not use a master account's credentials across products.

| Variables | Purpose |
| --- | --- |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Account binding and signature verification |
| `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` | REST authentication; never exposed to browser |
| `TWILIO_MESSAGING_SERVICE_SID` | Required for SMS only; leave unset for a voice-only stage |
| `TWILIO_PHONE_NUMBER` | Dedicated sender; voice capability required for calling, registered SMS capability separately required for texting |
| `TWILIO_ORGANIZATION_ID` | Verified MogulForge organization UUID; not a demo/client tenant |
| `TWILIO_PUBLIC_ORIGIN` | `https://app.mogulforge.ai` after host/path verification |
| `TWILIO_SMS_ENABLED`, `TWILIO_REGISTRATION_APPROVED`, `TWILIO_ADVANCED_OPT_OUT` | All explicit `true` only after matching provider setup, approvals and evidence |
| `TWILIO_LAUNCH_APPROVED`, `TWILIO_GEO_PERMISSIONS_REVIEWED` | Only after operator/policy/support review, publication approval, US geographic permissions and high-risk restrictions verified |
| `TWILIO_DAILY_SMS_LIMIT` | Explicit integer 1–1000; unset means off; not a spending authorization |
| `TWILIO_VOICE_ENABLED`, `TWILIO_VOICE_APPROVED` | Separate voice activation approval |
| `TWILIO_VOICE_BUSINESS_NAME` | Required reviewed public business name for the one configured organization; 1–120 characters, no control characters; no platform-name fallback |
| `TWILIO_STAFF_PHONE`, `TWILIO_DAILY_CALL_LIMIT` | Specifically authorized staff handset and integer 1–100 call operations/day; unset means off |

Prepared callbacks (POST, source only):

| Function | URL |
| --- | --- |
| Incoming SMS | `https://app.mogulforge.ai/api/v1/public/sms/inbound` |
| SMS delivery | `https://app.mogulforge.ai/api/v1/public/sms/status?operation=<generated UUID>` |
| Incoming voice | `https://app.mogulforge.ai/api/v1/public/voice/inbound` |
| Incoming-number call status | `https://app.mogulforge.ai/api/v1/public/voice/status` |
| App call instructions / connect / completion / status | `/api/v1/public/voice/{answer,connect,complete,status}?operation=<generated UUID>` on the pinned origin |

Do not substitute the marketing apex or trust arbitrary forwarded headers. One sender per service initially; the code intentionally rejects another From/To sender. Disable unused countries and high-risk destinations in Twilio for both voice and messaging. `+1` format alone does not establish US geography.

The five new `twilio_*` tables are in `lib/db/src/schema/twilio.ts`. No production schema push was run. Review generated SQL, take an approved backup and apply with the repository's established migration procedure before deployment. Do not run a force push on production. Fly min-machines-zero cannot independently guarantee scheduled appointment reminders; an approved always-running scheduler or authenticated external schedule is required before enabling automated reminders. Changing host resources can change hosting costs.

## Validation and release limits

- `pnpm --filter @workspace/api-server test:twilio`: **33 tests passed** across Twilio, unsubscribe, provider and route-authorization suites. Fresh in-memory PGlite PostgreSQL engine and loopback socket, no existing DATABASE_URL, synthetic identities, intercepted provider calls. It verifies actual SQL/routes/auth, not a live carrier or multi-process PostgreSQL race.
- API and frontend TypeScript checks passed; API and frontend builds passed. Existing CSS-import placement and large-bundle warnings remain unrelated to Twilio.
- Browser review of the local consent HTML verified separate unchecked choices, disclosure text and disabled enrollment when the provider endpoint is unavailable. [Local screenshot](design/twilio-2026-09-27/optional-consent-local.png) is implementation QA, not proof of a live registration CTA. Staff SMS/call UI was typechecked/built; its actual route authorization was integration tested.
- Tests cover bad signature/missing secret/wrong account/service, matching phone proof, purpose denial, tenant isolation, recipient change, stable-key send deduplication, status binding/progression, STOP/START, no retry after ambiguous SMS/call acceptance, 429 handling, app origin checks, incoming/requested voice, replay-safe customer dial, recording off and missed calls without texts.
- No live SMS, phone, HELP response, carrier delivery, Twilio test-credential API call, production webhook or sender registration was tested. Live test recipients must be specifically authorized.
- Broader paid-beta P0 release gates remain outstanding. This focused implementation does not certify the whole product for release.

## Resume in order

1. Complete the existing secure Twilio browser sign-in. Enumerate every accessible account/subaccount with owner, billing/trial status; redact identifiers in the handoff. Enumerate numbers/capabilities/voice+SMS URLs; Messaging Services and sender pools; Trust Hub profiles; brands/campaign statuses/rejections; toll-free verifications; keys by name/scope only; geo permissions and alerts. Do not recreate anything before this inventory.
2. Verify MogulForge formation/legal name/entity/address/EIN and Adam Mach's representative role using private authorized records. Do not reuse Kingdom AI identity. Resolve product ownership/billing with WillowNote independently.
3. Finalize the registration draft, production operator/support/privacy/retention text and intended launch volume. Publish reviewed pages only after owner approval; capture actual public form screenshots. Current HTML is a visibly marked local draft and is not ready to submit.
4. Show actual Console number/registration fees, taxes/top-up requirements and proposed recurring budget; obtain one-time and monthly spending limits before purchases, upgrades or fee-bearing submissions. Obtain the proper representative's exact legal attestations before submitting business/tax data.
5. Apply reviewed schema and deploy the exact reviewed commit after release approval. Keep flags off until registration approval, correct sender callbacks, Advanced Opt-Out, geo restrictions and scheduler are verified. Set budget alerts at agreed thresholds; distinguish them from app-operation limits and provider-wide hard caps.
6. With specifically authorized staff and customer test handsets, test incoming/outgoing SMS, STOP, HELP, fresh START+consent, delivery events, inbound/outbound voice and disabled recording. Save redacted provider SIDs/statuses. Do not interpret an accepted API response or successful submission as delivery/approval.

Cost proposal and registration language: [TWILIO-REGISTRATION-DRAFT.md](TWILIO-REGISTRATION-DRAFT.md). Current approved Twilio spend: **$0**; additional Twilio charges initiated by this work: **$0**. Existing account charges are unknown.
