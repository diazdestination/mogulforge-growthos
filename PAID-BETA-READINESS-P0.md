# GrowthOS Paid Beta Readiness — P0 Execution Order

**Status:** ACTIVE RELEASE DIRECTIVE  
**Primary branch:** `agent/mogulforge-growthos-recovery`  
**CI-green starting baseline:** `ee7f39cc124dfcfa299b9daa165ba2579166756b` (September 29; [run 36523072054](https://github.com/diazdestination/mogulforge-growthos/actions/runs/36523072054))
**Product goal:** Turn GrowthOS from a strong local/founding-beta build into a trustworthy, measurable, sellable paid-beta product for roofing/restoration and adjacent home-service companies.

## Mission

**October 3 customer-workspace scope:** PR21/main d4b8c0a passed exact-main
CI37154526789. The owner authorized the next fixed-checklist L7 slice under
`reports/customer-workspace-contract-2026-10-03.md`: canonical customer history,
safe exact navigation and explicit property selection for new service work.
No new schema is expected (130 tables); require fresh candidate/main CI,
synthetic recovery and separate hosted/provider/company acceptance. This does
not close all L7 or either replacement card, or alter any release/activation gate.

**October 3 current standing-service scope:** PR19/mainf91e1c3 passed exact-main
CI37134529680. The next authorized L5 candidate follows
`reports/standing-service-contract-2026-10-03.md`: exact, finite, forward-only
owner-reviewed service-series reminders and signed SMS reply review. Require
reviewed0013/125-table compatible recovery and fresh exact candidate/main CI.
No backlog, warranty inference, consent grant, automatic booking, provider or
hosted activation is implied. Read the integration report for local evidence;
both contractor replacement cards and the fixed launch checklist remain open.
This dated scope supersedes earlier active-wave wording, not release gates.

**October3 current CALLIE scope:** PR18/mainfa7c827 passed exact-main CI37092275861.
The next authorized candidate is bounded L4 intake under
`reports/callie-intake-contract-2026-10-03.md`: new-call-only standing policy,
keypad choices, caller-originated one-call acknowledgment and explicit staff
booking. Require reviewed0012/121-table compatible restore and exact candidate/
main CI. Its integration report distinguishes source, synthetic and live proof.
No general consent, autonomous booking, freeform receptionist, emergency dispatch,
payment collection or hosted/provider/customer activation is authorized here.
L4 and both complete contractor replacement cards remain unaccepted. This dated
scope supersedes older active-wave wording below, not any release/activation gate.

**October 2 second-wave active scope:** PR17 integrated lead replies at51da543
matches green84cd928 / CI37089194639 (3,087 passed,15 unchanged skips,26 adapter,
types/builds/Docker). Exact-main CI37090103299 passed. Continue only the
bounded invoice-delivery recovery contract; require additive0011/118-table
restore, full source-release checks and separate hosted/provider/client gates.
Safe retry requires machine no-dispatch proof and a matching blocked receipt;
additional copy needs actual acceptance and fresh explicit review. Unknown
effects are never rearmed. This still excludes contractor payment processing.

**October 2 two-wave continuation:** owner authorized tracked lead replies then
invoice delivery exceptions/reviewed recovery. First-wave contract and evidence:
`reports/lead-replies-contract-2026-10-02.md` and its integration report. Native
individually reviewed Microsoft BIE sends now use separate lead permission,
canonical reply holds/tasks and final-dispatch checks. Schema remains117tables
with reviewed0010after0009. Base mainc2d999b passed CI37085822984; require fresh
candidate/main evidence. Hosted/provider/device/customer acceptance remains
separate. This does not authorize rollout, sender activation or collection.

**October 2 launch-completion authorization:** the owner approved closing the
remaining engineering against `LAUNCH-COMPLETION.md`. The current L1/L2 contract
is `reports/launch-communications-contract-2026-10-02.md`; local integration is in
`reports/launch-communications-integration-2026-10-02.md`. The first tracked
Microsoft-service reply loop and platform delivery ledger are implemented;
general lead/Gmail coverage remains actual engineering, not merely provider
setup. All later exact-release, hosted, provider and contractor gates
remain required; no new scope may be silently added or a manual substitute
treated as accepted. Main c01bea0 passed its exact-main release gate; this new
candidate requires its own evidence. No activation is authorized by this note.

**October 2 operations-wave continuation:** the owner authorized the next wave
after customer-care PR14/main602131d passed exact-main CI37074053979. The contract
is `reports/operations-wave-contract-2026-10-02.md`; current evidence is in its
integration report. Service-watch/typed staff alerts, audited source adoption
and bounded separately reviewed email, and normalized historical finance are
the specific exception to earlier feature freeze. Schema is now111tables (`0008`
after `0007`), not yet hosted. Prior 103-table managed or105-table source evidence
must not be relabelled as this release. Payment collection stays deferred;
staging credentials/schema, providers, devices and both actual contractor
replacement acceptance gates remain. Azure first sign-in stays owner-deferred.

**October 2 customer-care candidate:** reviewed service reminders and office
booking, individual missed-call recovery and invoice email delivery are now
implemented for synthetic verification. See
`reports/customer-care-integration-2026-10-02.md`. Additive `0007` raises the
candidate from 103 to 105 tables. Exact-head CI, fresh reviewed held-staging
schema/recovery/application acceptance and actual provider/device/company
acceptance are still required. The earlier managed restore tested 103 tables,
not this candidate. No deployment, credential rotation or sending was enabled.

**October 2 payment scope clarification:** contractor payment collection is
deferred to a future add-on, not required for this initial replacement release.
Invoice delivery and accurate balances/staff-recorded external receipts remain
in scope. Do not choose or activate a contractor processor. The existing Stripe
test requirements below concern GrowthOS subscription billing and are unchanged.
The owner authorized continued useful engineering; the bounded customer-care
wave is recorded in `reports/customer-care-contract-2026-10-02.md`. It does not
authorize hosted deployment, credential changes, spending or real customer sends.

**October 2 replacement acceptance requirement:** the owner requires both
contractors to be able to replace their actual required Housecall Pro workflows
before onboarding/cutover. `HOUSECALL-PRO-REPLACEMENT-GATE.md` records the missing
engineering and separate company acceptance cards. Green CI or a smaller assisted
pilot does not satisfy that outcome. The approved temporary managed recovery
exercise is tracked in `reports/managed-contractor-recovery-2026-10-02.md`; it
does not authorize production, customer sends/charges, a permanent third database,
or cancellation of either contractor's old subscription.

**October 1 native replacement addendum:** after the complete PR10 gate passed
at `48c3491`, Adam explicitly authorized finishing the next wave and further
useful engineering. The invoice/schedule/service and daily-navigation scope in
`reports/native-contractor-day-contract.md` is an owner-approved exception to
the earlier general module freeze. It changes no staging, provider, financial,
customer contact, production or public-launch acceptance requirement.

**Communications-provider addendum (September 30):** The owner chose to
continue with Twilio for GrowthOS after reviewing alternatives. The earlier
[provider review](COMMUNICATIONS-PROVIDER-REVIEW-2026-09-30.md) is retained as
historical evidence, not an instruction to pause Twilio engineering. This
decision does not authorize live provider registration, paid resources, phone
forwarding, deployment or customer traffic. Twilio-specific acceptance below
remains required. Voice/missed-call handling can be prepared separately from
SMS registration, but customer-facing automatic SMS stays disabled until that
client's sender/use-case approval, consent and full release acceptance pass.
The per-client queue estimate and staged rollout are recorded in
[TWILIO-CLIENT-ONBOARDING-TIMING-2026-09-30.md](TWILIO-CLIENT-ONBOARDING-TIMING-2026-09-30.md).

September 29 continuation: non-overlapping/distributed scheduler ownership, durable-action retry and restart checks, secret-free operator health, and always-on configuration are implemented for verification. See [SCHEDULER-OPERATIONS.md](SCHEDULER-OPERATIONS.md) for evidence, operating cost and known legacy failure windows. This is not staging or provider acceptance; P0-2 is not yet declared passed. GrowthOS's local landing copy now uses the BIE identity and separates sample-data exploration from live activation. No pricing package or launch promise is being introduced before the required gates.

GrowthOS is not waiting for more feature invention. The immediate objective is to make the existing Revenue Intelligence + Recovery system boringly reliable in production, prove that it creates measurable customer value, and establish a repeatable paid-beta operating model.

The commercial wedge is:

> **GrowthOS Revenue Intelligence + Recovery** — find neglected revenue already inside a contractor's operation, help the right person recover it through controlled action, and prove the result with an inspectable evidence trail.

The system should connect this chain without unsupported attribution:

**Opportunity → evidence → recommendation → approval → execution → provider receipt → response → appointment → estimate → win → recorded/collected revenue**

## Non-Negotiable Feature Freeze

Until every P0 gate below is satisfied:

- Do not add major product modules.
- Do not redesign the architecture without a demonstrated release blocker.
- Do not build speculative multi-agent autonomy.
- Do not broaden Google scopes merely to make demos more impressive.
- Do not clone commodity CRM features already covered well enough for the pilot.
- Do not deploy production changes, enable live campaigns, alter DNS, spend money, or contact real customers without the applicable release/owner approval.
- Do not call pipeline value, opportunity value, staff-recorded revenue, or provider acceptance "recovered revenue" unless the attribution/evidence definition supports it.
- Prefer the smallest bounded repair that moves a paid-beta gate from red to green.

Priority order is:

**Trust → reliable execution → measurable revenue impact → beta readiness → repeatability → scale → polish**

---

# P0-1 — Restore a Completely Green Release Gate

## Current known issue

The original audited head failed CI on loopback-environment and test-cleanup issues. These were repaired; run 36523072054 passed the complete gate at `ee7f39c`. Every subsequent candidate still needs its own exact-head green result; an older green run does not approve newer code.

## Required work

1. Fix local-database safety guards so they safely accept both approved loopback hostnames without weakening protection against non-loopback databases.
2. Fix Revenue Workspace/server teardown so hooks terminate deterministically.
3. Eliminate test cleanup races without hiding FK/integrity defects.
4. Re-run the entire repository CI pipeline on the exact branch head.
5. Ensure CI always reaches:
   - frozen-lockfile install
   - schema application
   - all test suites
   - workspace TypeScript checks
   - Command Center production build
   - API production build
   - Docker/Fly staging-parity gate
6. Add regression coverage for the environment-guard defect.

## PASS evidence

A GitHub Actions run on the exact release-candidate SHA must show all required jobs green. Record the run URL, exact SHA, total tests passed/skipped, build results, and Docker parity result in PR #1 / release notes.

**No staging or production release candidate exists while this gate is red.**

---

# P0-2 — Make Scheduled Revenue Work Actually Reliable

## Current risk

GrowthOS starts its scheduler inside the web application process. Both Fly configs allow `min_machines_running = 0` and auto-stop. A sleeping app cannot be trusted to run reactivation, reminders, webhook retries, retention work, or other scheduled execution on time.

## Required beta architecture

Use the smallest safe architecture for paid beta:

1. Keep at least one execution process alive continuously.
2. Preserve the existing durable-execution ownership/idempotency model.
3. Ensure scheduled actions are claimed atomically and cannot double-send.
4. Add bounded retry/backoff for clearly retryable internal work.
5. Preserve the current rule that ambiguous provider effects are **not** blindly replayed.
6. Add dead-letter/indeterminate visibility for work requiring operator reconciliation.
7. Add a scheduler/worker heartbeat visible to operators.
8. Add a restart acceptance test:
   - queue work
   - stop worker mid-cycle
   - restart
   - prove no duplicate effect
   - prove due work resumes or becomes explicitly reconcilable
9. Document the beta topology and operating cost.

## PASS evidence

- Always-on execution confirmed in staging.
- Heartbeat visible.
- Restart test passes.
- A deliberately failed scheduled action becomes visible and actionable.
- No duplicate send occurs under concurrent/restart testing.

---

# P0-3 — Establish Exact-Commit Staging Discipline

## Required work

1. Deploy the exact green release-candidate SHA to `mogulforge-growthos-staging`.
2. Ensure staging has its own:
   - database/database user
   - session secret
   - OAuth clients
   - provider test credentials
   - Stripe test configuration
   - allowlist
3. Expose a non-secret release identity in the application/readiness surface:
   - git SHA
   - build/release timestamp
   - environment
4. Run staging acceptance against that exact SHA.
5. Do not approve production if staging evidence refers to a different commit.

## PASS evidence

One staging acceptance report ties every result to one exact commit SHA.

---

# P0-4 — Prove Real Provider End-to-End Behavior

Mocks and local adapters do not count as provider acceptance.

## Gmail

Prove with at least two authorized test users:

- connect using the intended OAuth client
- correct scopes only
- send as User A
- send as User B
- token refresh after access-token expiry
- disconnect/revoke
- revoked token produces a visible, safe failure
- no fallback to another user's mailbox
- provider message ID appears in evidence/audit

## Resend / platform transactional email

Prove:

- verification email
- password reset
- team invitation
- correct verified sender
- failure visibility
- webhook handling where used
- no customer Gmail fallback

## Twilio SMS

Prove:

- outbound SMS from the configured number
- consent gate blocks a non-consented recipient
- suppression/STOP blocks later outreach
- START/UNSTOP only reverses the appropriate STOP suppression
- quiet hours defer instead of dropping
- frequency cap works
- delivery-status callback reaches GrowthOS
- provider message SID correlates to the touch
- permanent recipient errors create suppression
- transient failures do not create false permanent suppression

Verify whether every outbound send explicitly supplies the Twilio `StatusCallback` URL or whether an account/service-level callback is relied upon. Whichever design is chosen must be documented and proven in staging.

## OpenAI / AI runtime

Prove:

- dedicated production/staging project separation
- explicit approved model allowlist
- timeout handling
- fallback behavior where allowed
- no unsafe silent mock fallback in production
- usage/cost logging
- budget/alert thresholds
- Evidence Intelligence structured-output acceptance

## Stripe

In test mode prove:

- checkout
- subscription creation
- webhook verification
- subscription-state synchronization
- customer portal
- cancellation
- failed/incomplete state handling
- enforcement behavior with `BILLING_ENFORCE` both off and on

## PASS evidence

A provider acceptance matrix shows each flow, test identity, timestamp, provider receipt/message ID where safe, result, and relevant GrowthOS audit/event.

---

# P0-5 — Production Observability and Alerting

## Required work

Implement enough operational visibility that a paying customer's revenue workflow cannot silently fail.

Minimum:

- structured application errors
- request correlation IDs
- external uptime check
- deployment/release SHA visible in health/readiness
- scheduler/worker heartbeat
- failed scheduled work alert
- Gmail/provider connection health
- Twilio/Resend failure alerting
- webhook retry exhaustion visibility
- database connectivity/readiness
- AI provider failure/timeout visibility
- redaction so secrets, auth tokens, message bodies, and unnecessary PII do not leak to logs
- alert destination owned by MogulForge operators
- incident runbook with severity and first-response actions

## Acceptance tests

Simulate at least:

- OpenAI unavailable
- Gmail revoked
- Twilio send failure
- webhook endpoint failing
- scheduler heartbeat stale
- database connectivity failure where safe

Each must be visible to an operator without inspecting raw database tables.

---

# P0-6 — Backups and Restore, Not Just Backups

## Required work

1. Enable automated managed Postgres backups.
2. Define beta RPO and RTO targets.
3. Restore a backup into an isolated non-production database.
4. Start the same GrowthOS release against restored data.
5. Verify:
   - users/org membership
   - leads/contacts/properties
   - Revenue Desk/BIE state
   - audit history
   - provider credential records remain decryptable only with the correct secret context
   - customer/project-room data
6. Document the restore command/process and who may execute it.

## PASS evidence

A dated restore-drill record with source backup, isolated restore target, exact app SHA, checks performed, result, and measured restore time.

---

# P0-7 — Finish Trust, Privacy, and Customer Data Lifecycle

Before external paid beta, product behavior and public disclosures must match.

Required surfaces/processes:

- Privacy Policy
- Terms of Service
- Google data-use disclosure
- retention/deletion disclosure
- security contact
- customer account/data export process
- account deletion process
- OAuth disconnect/revocation
- Email Intelligence raw-content retention enforcement
- deletion behavior for selected Google/forwarded data
- subprocessors/provider disclosure as appropriate
- incident/privacy contact workflow

Do not claim deletion exists merely because individual rows can be manually removed. The customer-facing lifecycle must be defined, tested, and supportable.

---

# P0-8 — Two-Tenant Adversarial Isolation Acceptance

Create two isolated staging organizations with separate users and data.

Attempt cross-tenant access using:

- direct record IDs
- list/search endpoints
- API keys
- lead/contact/property/estimate/project routes
- Revenue Workspace/BIE
- Smart Sites
- customer project rooms
- photos/object storage
- Gmail connections
- Email Intelligence
- reports/exports
- automations/playbooks
- webhooks
- billing metadata
- platform/client-launchpad boundaries

Test read, write, delete, search, export, and send paths where applicable.

## PASS standard

Org A cannot discover, read, mutate, export, authorize, send from, or execute against Org B's customer data or provider identity.

Record the exact test matrix and result.

---

# P0-9 — Controlled Founding-Customer Revenue Pilot

The first commercial proof should use an explicitly authorized founding contractor. Painless Roofing may be used only after owner/access/contact-policy approval and the relevant release gates are green.

## Pilot scope

Start narrow. Do not launch an uncontrolled bulk campaign.

Suggested first cohort:

- a bounded set of legitimate dormant leads / unsold estimates
- known consent/contact status
- human approval on outbound actions initially
- no unsupported insurance/damage promises
- clear stop rules

For every candidate, preserve:

- original lead source/date
- opportunity reason
- known pipeline/estimate amount
- recommended action
- approver
- provider receipt
- delivery state
- response
- appointment
- estimate change
- win/loss
- recorded payment/collection evidence when available

## Primary proof metrics

Do not optimize for message volume.

Track:

- neglected opportunities surfaced
- known pipeline value surfaced
- contacts eligible for outreach
- conversations restarted
- appointments booked
- estimates reopened/created
- recorded wins
- directly attributable recovered revenue
- collected revenue when independently recorded
- time to first response/action
- opt-out/complaint rate
- failed-send rate
- operator time required

Attribution must remain conservative and inspectable.

## PASS evidence

At least one complete real inquiry/opportunity-to-outcome evidence chain is visible in the Recovered Revenue/Value Ledger without unsupported claims.

---

# P0-10 — Paid Beta Packaging and Repeatable Onboarding

Only after P0-1 through P0-9 have acceptable evidence.

## Required work

Define no more than 2–3 beta packages. Sell the measurable outcome, not the feature count.

Recommended initial positioning:

**MogulForge GrowthOS — Revenue Intelligence + Recovery**

Possible packaging to validate:

- setup/onboarding fee
- monthly managed platform fee
- usage allowances for communications/AI
- optional Smart Site / deeper integration tier

Avoid percentage-of-revenue pricing until attribution and customer economics are proven.

## Onboarding must become repeatable

Document a standard onboarding path covering:

1. organization creation
2. staff/roles
3. data import
4. consent/contact policy
5. Gmail/communications connections
6. business knowledge
7. Smart Site connection when applicable
8. recovery segment preview
9. first approved campaign/action
10. success-metric baseline

Measure setup time and manual support hours. Anything requiring founder-only tribal knowledge becomes a product/ops task.

---

# Release Decision Rule

GrowthOS may be called **paid-beta ready** only when:

- the exact release SHA is green in CI;
- exact-SHA staging acceptance is green;
- scheduled execution is reliable while idle;
- live Gmail/Resend/selected communications provider/OpenAI/Stripe test flows
  have evidence (including Twilio if any Twilio path is enabled);
- operators receive meaningful failure alerts;
- a backup restore has been proven;
- legal/privacy/data-lifecycle surfaces exist;
- adversarial tenant isolation passes;
- a real controlled revenue pilot has an inspectable evidence chain.

A beautiful UI, high test count, local mocks, or feature breadth cannot substitute for these gates.

---

# P1 — Explicitly Deferred Until Paid Beta Is Proven

Do not pull these ahead of P0 unless a real pilot proves they are necessary for conversion or retention:

- full Google Calendar adapter
- Drive/Sheets Picker and normalized fact adapters
- Search Console adapter
- Google Ads adapter
- Business Profile adapter
- accounting/QuickBooks synchronization
- e-signature
- customer payment collection inside project rooms
- full voice AI telephony
- full Gmail inbox reading
- additional industry vertical packs
- complex multi-agent autonomy
- broad developer platform/SDK
- cosmetic redesigns not blocking beta use

---

# Codex Operating Instruction

For each P0 item:

1. State the exact defect/risk being removed.
2. Identify the smallest files/components that must change.
3. Implement on the existing recovery branch unless repository safety requires an isolated branch.
4. Add/repair tests before declaring completion.
5. Record evidence, exact SHA, and remaining limitations.
6. Do not infer provider success from mocks.
7. Do not perform a production/provider/DNS/spend/customer-contact mutation unless explicitly authorized.
8. Stop expanding scope when the acceptance criterion is satisfied.
9. Move immediately to the next P0 gate.
10. Keep PR #1's release evidence current so an operator can determine readiness without reading the entire git history.

## Immediate next action

Start with **P0-1**.

Fix the loopback CI guard and Revenue Workspace teardown/cleanup instability, run the entire CI pipeline, and do not move to P0-2 until the exact head has a fully green release gate.

The objective is not to make GrowthOS look finished.

The objective is to make GrowthOS **safe to sell, difficult to replace, and able to prove the revenue it creates.**
