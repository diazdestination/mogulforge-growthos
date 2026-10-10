# GrowthOS contractor launch-completion checklist

## October 8 current source snapshot

Main `2162aa296281473dda170291ff95d64e0e6e9b79` passed exact-main CI `37500458053`.
The CALLIE conversation, Contractor Workday and returning-customer source waves
are merged through PR #27 (141-table source). Earlier pending-implementation
wording below is historical where it conflicts with this snapshot.

The current private candidate adds exact notification-to-lead ownership and one
initial claim, with accepted-staff locking and retry/conflict UX. It addresses
part of L9; no full launch item is closed. It also removes the generic forced
schema release path and fixes Git failure identity handling for L10. Hosted
rollout must leave the retired `AUTO_MIGRATE` startup flag disabled and follow a
separately reviewed migration procedure. Evidence:
`reports/production-gaps-2026-10-08.md` and `reports/release-safety-2026-10-08.md`.
Actual hosted/provider/device/company acceptance remains open. In particular,
dual-recipient coverage, actual alerts, after-hours response, source migration,
subscription proof and both complete contractor replacement cards are unaccepted.


Owner approved this fixed finish-line approach on October 2, 2026 after the
operations release c01bea0. This is not authorization to activate providers,
change hosted schema/credentials, send customer messages, spend money, or cancel
an incumbent subscription. Both companies must replace their actual required
workflows; payment collection inside GrowthOS is deferred.

October6 update: PR24 CALLIE source and exact-mainCI37407237259 are complete,
not liveL4 acceptance. Owner-approved researched Contractor Workday source adds
property equipment, reviewed company checklists, saved typed/photo visit work,
explicit office held-draft recovery and atomic original completion/selected
service successor/follow-up. Its six-table139-total release proof is recorded
in the current workday receipt/GitHub/Jarvis STATE, not assumed from UI tests.
This addresses the equipment/checklist portion of L7 and recorded completion
portion of L5 only. Contact-only billable jobs, actual samples/migration mappings,
all required mailbox/campaign scope and actual two-company/provider/device/
managed staging/recovery gates remain. Earlier candidate descriptions below
are historical; no full launch item closes merely from this engineering wave.

## How this checklist closes

Each requirement needs separate code/test, exact-release staging, provider/device
and contractor acceptance evidence where applicable. A missing feature is not
renamed a testing gate. A manual substitute requires explicit acceptance. Only
confirmed critical contractor requirements may expand this list; optional ideas
go below the launch line. The detailed company sign-offs remain in
HOUSECALL-PRO-REPLACEMENT-GATE.md.

| ID | Required outcome | Current gap / next acceptance |
| --- | --- | --- |
| L1 | An email reply reaches the correct lead or service work item and responsible office staff | Microsoft tracked-service loop is integrated; the lead-replies candidate adds individually prepared/reviewed native BIE email, separate lead permission and canonical hold/task/handling. General compose/campaign/Gmail typed intake is not delivered; actual required mailbox contexts, authorization, continuity and reply acceptance remain open. |
| L2 | Staff can reliably join/sign in and recover access | Durable verification/reset/invitation send ledger, exact signed callback reconciliation and staff delivery evidence implemented in the candidate. Configure stable platform context and prove actual inbox receipt/access separately; uncertain attempts cannot be automatically retried. |
| L3 | Customers receive usable invoices; staff see accurate external balances | PR18/mainfa7c827 and its exact CI passed: append-only attempt history and explicitly reviewed proven-no-dispatch retry or additional copy are built. Hosted/provider/document acceptance remains required. The bounded invoice-page view is not a global delivery-state exception filter. No payment processing. |
| L4 | Missed calls are recovered promptly without uncontrolled messages | Bounded keypad/one-call acknowledgment and office booking are built. October5 conversation engineering now follows the frozen CALLIE contract: natural intake, voice-only v2 approval and a controlled original-call handoff over existing Twilio routing. Its implementation/new source gates are pending; actual audio/routing/consent/stop/transfer/failure and any required autonomous confirmed booking still need acceptance. L4 remains open. |
| L5 | HVAC service obligations produce timely reminders, responses and visits | Current standing-service candidate adds exact forward-only series approval, shared one-reminder ownership, signed service SMS evidence/office holds and typed Microsoft reply authority. No backlog, warranty inference or automatic booking. Close exact release CI, then prove each actual agreement, sender, response, visit and completion/next date. |
| L6 | Lead recovery and campaigns produce accountable opportunities | Current finite two-message Microsoft candidate adds exact review/start/stop, permanent ownership, shared contact allowances and fresh completed-sync/reply gates. Finish exact release verification; confirm remaining required campaign scope and prove actual reply/opt-out stops and accountable outcomes. This bounded slice does not close full L6. |
| L7 | The office and technician can find and finish each customer's work simply | October5 candidate implements canonical nine-section customer history, exact appointment links and explicit new-service property selection. Finish exact release CI; confirm actual equipment/checklist needs, repeat-customer jobs, multi-property work and required scheduling details. No duplicate customer or invented acquisition lead. |
| L8 | Both businesses can migrate and cut over without losing required work/history | Obtain approved source samples; map required customers/properties/equipment, open jobs/appointments/media and balances. Existing finance loader is normalized JSON, not universal Housecall Pro import. Reconcile counts, exceptions, one writer, rollback and export. |
| L9 | Smart Sites and phones deliver the right work to the right staff | Accept each website/company connection, owner/day/after-hours routing, actual installed phones, background/locked/offline behavior and correct lead/service deep links; manual SMS compose is not delivery evidence. |
| L10 | The selected release is recoverable, isolated and supportable | Exact-head/main CI, reviewed hosted schema, compatible restore, always-on scheduler, actionable failure alerts, two-company isolation, privacy/export/retention and AI cost/runtime acceptance. |
| L11 | Selling/onboarding is repeatable and honestly valuable | GrowthOS subscription test flow (separate from contractor collection), explicit included scope/allowances, setup/support effort, complete company workday acceptance and one conservatively evidenced inquiry-to-outcome chain. |

## Active implementation: CALLIE conversation

PR23/mainafcb72a and exact-main CI37390525754 passed. The owner approved the next
wave in `reports/callie-conversation-contract-2026-10-05.md`. It targets confirmed
L4 reception work for both contractors: natural caller statements, one original
office workflow, explicit voice-only policy and a governed custom Twilio cold
handoff. Expected review-only0015 adds three tables (133total). Preserve legacy
DTMF/SMS authority and unknown receipts. New full candidate/main, synthetic
recovery and built UI proof are required; hosted/provider/company gates remain.
This wave does not invent equipment or source-migration facts or close all L4.

## Previous implementation: NEW manual-appointment property selection

PR22/main6cbf0ae and exact-main CI37383108807 passed. Continue only the frozen
`reports/manual-appointment-property-contract-2026-10-05.md`: explicit optional
customer property for NEW manual visits, coherent parent locks through native
creation, preserved historical visits/notes and focused UI/real-PG barrier tests.
This uses the existing130-table schema and needs its own candidate/main gate.
Equipment/checklist, repeat-job and migration choices still need actual approved
contractor inputs. L7/L8 and both complete replacement cards remain open.

## Previous implementation: bounded L7 customer workspace

Base PR21/main d4b8c0a and exact-main CI37154526789 passed. The resumed October5
slice follows `reports/customer-workspace-contract-2026-10-03.md`; see its October5
integration report and operator guide. Customer history and companion navigation
are built over canonical records; new service property selection is explicit and
parent-stable through creation. No new schema (130tables); compatible synthetic
restore has47read-only app probes. Require exact candidate/main PostgreSQL CI and
separate hosted/provider/company proof. This does not close all L7 or cutover.

## Previous implementation: bounded L6 source nurture

Base L5 PR20/main110f145 and exact-main CI37148428665 passed. Current contract:
`reports/source-nurture-contract-2026-10-03.md`. Use its integration report and
operator guide for scope and evidence. Existing Win-back, Account and lead
Messages/Today provide the finite owner-reviewed Microsoft sequence. Source is
130tables with reviewed0014after0013; synthetic recovery has36SELECT-only app
probes and15new constraint negatives. Require exact candidate/main PostgreSQL CI,
then separate hosted/provider/company evidence. No complete L6/launch/cutover
claim follows from this finite slice.

Next fixed-checklist engineering remains actual required L7 customer history/
workday gaps and source-specific L8 migration when approved exports are available.
Remaining required L1/L4/campaign capabilities and both company cards stay open.

## Previous implementation: bounded L5 standing service reminders

PR19/mainf91e1c3 and exact-main CI37134529680 passed. The next owner-authorized
slice is `reports/standing-service-contract-2026-10-03.md`. See its integration
report and operator guide. Existing Service Desk and MAINTAIN now expose separate
series authority, occurrence receipts and reply review. This extends L5 source
readiness, not live acceptance. Candidate schema is125tables with reviewed0013
after0012; the synthetic restore checks31SELECT-only app reads and14new constraint
negatives. Keep exact candidate/main CI separate from hosted/provider/phone proof.

Next fixed-checklist engineering is bounded ongoing lead nurture (L6), then the
remaining required customer-history/workday gaps (L7) and source-specific migration
once actual approved exports are available (L8). Required L1/L4 capability and
contractor acceptance gaps remain explicit; keypad intake is not a conversational
receptionist. Do not silently mark the full checklist complete.

## Previous implementation: bounded L4 CALLIE intake

Owner requested the next wave after PR18/mainfa7c827 and green exact-main
CI37092275861. See `reports/callie-intake-integration-2026-10-03.md` and its operator
guide. Three lanes implement finite intake, guarded one-call acknowledgment and
explicit office review/booking; original calls/tasks and response ownership remain
canonical. Source expects121tables with reviewed0012after0011. Require exact
candidate/main CI and separate hosted/provider/company acceptance. No L4 closure
or silent substitution of keypad intake for a required conversational assistant.

## Previous implementation: two-wave L1 then L3 continuation

The owner requested two consecutive waves. Tracked Microsoft lead replies are
merged at51da543 from green84cd928/CI37089194639; see
`reports/lead-replies-integration-2026-10-02.md`. Exact-main CI37090103299 also
passed. Active second-wave contract:
`reports/invoice-recovery-contract-2026-10-02.md`, delivery exceptions and safe,
explicitly reviewed recovery. Unknown effects must never be rearmed by new keys
or staff attestation. This extends source readiness, not hosted/client acceptance.

## Previous implementation: L1 service context and L2

Three coordinated lanes implement typed service replies, an explicit Microsoft read
connector, and separate platform identity delivery evidence. Existing sender
selection, claims, holds and scopes remain protected. Incoming email is untrusted
data: it cannot command tools, authorize sending, grant consent, book a visit or
determine warranty coverage. No automatic retry of an uncertain provider effect.

Coordinator owns shared integration, lifecycle inventory, schema review,
recovery, exact release checks and readiness updates. See
reports/launch-communications-contract-2026-10-02.md.

## Owner inputs and activation gates

- Azure first sign-in on owner return; inspect existing account/app, no new signup.
- Explicit actual contractor mailbox/read-scope/retention choices and authorized
  test identities. Owner Hotmail is a test identity, not contractor proof.
- Approved source exports, required equipment/service facts and office/field users.
- Held-staging upgrade and administrator-credential rotation approval remain
  separately pending. Select the final reviewed code/schema before that rollout.
- No real onboarding/cutover until both complete replacement cards pass. Old
  subscription cancellation is the owner's separate action.

## Below the launch line unless a critical workflow proves otherwise

Contractor payment processing, speculative industry packs, broad advertising/
accounting connectors, unbounded agent autonomy and cosmetic redesigns. Calendar
sync, signatures, route optimization, pricebooks, progress billing and change
orders are conditional on actual replacement requirements, not assumed absent
or automatically promoted into a competitor-parity project.
