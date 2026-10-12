# Source-gap map

Prepared against PR #35 head `87adc3e`. In this file:

- `api/` means `artifacts/api-server/src/`.
- `ui/` means `artifacts/command-center/src/`.
- `schema/` means `lib/db/src/schema/`.
- `:N` is a one-based line number at that commit.

"Implemented" means reviewed source plus synthetic tests only. It never means
hosted, provider, device or company acceptance (`HOUSECALL-PRO-REPLACEMENT-GATE.md:57-63`).
"Not found" means this packet's source search found no implementation. Treat a
"Not found" row as a gap until engineering shows otherwise.

Private intakes, which stay outside the repository and must not be copied:

- CSS: `C:\Forge\CSS_OWNER_INTAKE_2026-10-09.md` (cited below as `CSS:N`).
- Painless: `...\release-package\owner-contact-and-routing-2026-10-05.md` (cited below as `PR-route:N`).

## A. Requirement → evidence or gap

| # | Requirement (source) | Launch item | Current implementation evidence | Status |
| --- | --- | --- | --- | --- |
| 1 | New-lead phone alerts to **both** daytime owners; after-hours set (`HOUSECALL-PRO-REPLACEMENT-GATE.md:108-111`, `PR-route:20-21`) | L9 | Policy recipients `api/services/staff-push-policy.ts:24`; queue `api/services/staff-push.ts:241`; per-recipient coverage table `schema/staff-push.ts:57`, `api/services/staff-push-coverage.test.ts`; contract `STAFF-PUSH-PILOT.md:56-77` | Implemented; device receipt unproven |
| 2 | One owner claims; no auto round-robin (`PR-route:21-22`) | L9 | `api/services/smart-site-followup.ts:212`, `api/services/smart-site-followup.test.ts`, `ui/pages/lead-detail-smart-site-owner.test.tsx`; `reports/production-gaps-2026-10-08.md:20-36` | Implemented |
| 3 | Home-screen notification → lead → three human-send SMS drafts (`HOUSECALL-PRO-REPLACEMENT-GATE.md:111`) | L9 | `api/services/manual-sms.ts:138`, `api/services/manual-sms.test.ts`; `MOBILE-EMAIL-PILOT.md:38-42` | Implemented; handset replies not synced (G-18) |
| 4 | Missed call → recovery without uncontrolled messages (L4) | L4 | CALLIE conversation `api/services/callie-reception-runtime.ts`, `api/services/callie-reception.test.ts`; office review `api/services/callie-office.ts`; keypad one-call ack `api/services/callie-ack-transport.ts:14`; guide `reports/callie-conversation-operator-2026-10-05.md` | Implemented (bounded); live audio/routing unproven |
| 5 | CSS urgent-call triage, alert both, fallback schedule + confirmation text (`CSS:43-54`) | L4 | CALLIE captures caller-stated urgency (`reports/callie-conversation-operator-2026-10-05.md:15`) but does no autonomous booking (`LAUNCH-COMPLETION.md:54`) | **G-10** |
| 6 | CSS after-hours: text alert to both owners **and** automatic customer reply (`CSS:57-60`) | L4/L9 | Staff alerts are Web Push, not SMS (`STAFF-PUSH-PILOT.md:1-4`); conversation mode is voice-only (`reports/callie-conversation-operator-2026-10-05.md:23-25`) | **G-11** |
| 7 | Customer-details confirmation text with correction-form link (`CSS:61-63`) | L7 | Corrections are staff-only: `api/services/customer-detail-correction-contract.ts:10` requires an accepted office/admin/owner session | **G-09** |
| 8 | Appointment yes/no confirmation text; unconfirmed → call, hold, reschedule (`CSS:36-38`) | L5/L7 | Booked-appointment reminders exist (`HOUSECALL-PRO-REPLACEMENT-GATE.md:72`); yes/no reply capture and an unconfirmed hold not found | **G-08** |
| 9 | Diagnostic 2h / maintenance 3h / ~1h travel (`CSS:22-29`) | L7 | Conflict checks `api/services/contractor-scheduling.ts:79`, `api/services/contractor-scheduling.test.ts`; durations are entered manually | **G-04** (`reports/integrated-running-contract-2026-10-10.md:34-35`) |
| 10 | Tech diagnostic notes, findings, photos (`CSS:74-77`) | L7 | `schema/contractor-workday.ts:52-96`; `api/services/contractor-workday.test.ts`; guide `reports/contractor-workday-operator-2026-10-06.md` | Implemented (JPEG/PNG/WebP ≤10 MiB; no HEIC) |
| 11 | Equipment and major components with warranty dates (`CSS:110-112`) | L5/L7 | `schema/contractor-workday.ts:11` (`property_assets.facts`); warranty dates require a source reference (`reports/contractor-workday-operator-2026-10-06.md`, section 1) | Implemented on asset |
| 12 | Warranty-validity dates **on the customer invoice** (`CSS:77`, `CSS:111-112`) | L3 | No structured warranty snapshot on invoices (`reports/integrated-running-contract-2026-10-10.md:31-33`; `NEXT_ACTIONS.md:12-13`) | **G-03** |
| 13 | Multi-repair invoices reviewed by office; techs may send simple maintenance invoices (`CSS:67-70`) | L3 | A single `invoices.manage` capability on every invoice mutation (`api/routes/v1/invoices.ts:220-298`); no role-conditional review rule | **G-12** |
| 14 | Invoice delivered to customer; accurate balances (L3) | L3 | Issue/void/receipts `api/services/invoices.ts`, `api/services/invoices.test.ts`; email via selected Gmail/Microsoft sender `api/services/invoice-delivery.ts:113`; `api/services/returning-invoice-delivery.test.ts` | Implemented (plain text) |
| 15 | Invoice with images and assessment report; invoices/estimates by text (`CSS:75-77`, `CSS:84-86`) | L3 | Plain text "without links, attachments" (`api/services/invoice-delivery-contract.ts:74-75`); no delivery/bounce feedback (`HOUSECALL-PRO-REPLACEMENT-GATE.md:73`) | **G-13** |
| 16 | External cash/check receipts, partial balance, refunds | L3 | `api/routes/v1/invoices.ts:284` (payments), `:299` (refunds), `:320` (reverse allocation); `BETA-CONTRACTOR-SUCCESS.md:38-39` | Implemented |
| 17 | **Customer payment collection** (reader/phone/link; Stripe/PayPal/Apple/Google Pay evaluated) — Oct 9 scope change (`CSS:117-139`) | L3/L11 | None. Supersedes the deferral in `LAUNCH-COMPLETION.md:25-26`; recorded in `NEXT_ACTIONS.md:14-15`, `PROJECT_STATE.md` (Oct 10 section) | **G-01** |
| 18 | Signed estimate approval, deposits, progress payments, financing (`CSS:123-127`) | L3/L7 | "No native estimate e-signature" (`HOUSECALL-PRO-REPLACEMENT-GATE.md:72`); nothing found for deposits, progress payments or financing | **G-02** |
| 19 | Estimates for repeat customers without fake leads | L7 | `api/services/returning-customer.ts`, `api/routes/v1/customer-work.ts:19-20`, `api/services/returning-customer.test.ts`; totals `api/services/estimate-totals.test.ts` | Implemented |
| 20 | Estimate delivered to the customer (email/text) | L3/L6 | Estimate routes create and update only (`api/routes/v1/estimates.ts`, `api/routes/v1/customer-work.ts:19-20`); no send path found | **G-06** |
| 21 | Estimate follow-up: 3 reminders × 24h, text **and** email, then a staff call (`CSS:88-94`) | L6 | Only a generic lead-playbook category exists (`schema/playbooks.ts:80`); promotional playbooks cannot borrow SMS consent (`TWILIO-IMPLEMENTATION.md:51`) | **G-07** |
| 22 | Maintenance: residential every 6 months, commercial quarterly; reminder ~1 month before (`CSS:100-104`) | L5 | Calendar-month recurrence `api/services/service-obligations.ts:65`, `:314`; standing reminders `api/services/service-standing-runtime.ts`, `api/services/service-standing.test.ts`; guide `reports/standing-service-operator-guide-2026-10-03.md` | Implemented (single channel) |
| 23 | Maintenance reminders on **both** text and email (`CSS:102`) | L5 | Each standing series selects one channel: `reports/standing-service-operator-guide-2026-10-03.md:26`, `schema/service-standing.ts:10` | **G-14** |
| 24 | Due date may shift after major service; annual plan billing (`CSS:105-109`) | L5 | Recurrence anchors on a fixed date (`api/services/service-obligations.ts:261`); no service-plan billing (`HOUSECALL-PRO-REPLACEMENT-GATE.md:74`) | **G-15** |
| 25 | Service-reminder reply / STOP handling | L5 | `api/services/service-sms.ts`, `api/services/service-sms.test.ts`; quiet hours `api/services/send-gate.ts:351` | Implemented; live carrier unproven |
| 26 | "On the way" texts; invoice payment follow-ups (`CSS:84-86`) | L3/L7 | Not found | **G-16** |
| 27 | Email reply reaches the right lead/service and staff (L1) | L1 | Microsoft tracked replies `api/routes/v1/lead-mailbox-replies.ts`; Gmail is send-only (`GOOGLE-OAUTH-SETUP.md:22-23`) | Partial: **G-17** |
| 28 | Per-user Gmail connect/send/revoke | L1 | `api/services/gmail-oauth.ts`, `api/services/gmail-oauth.test.ts`, `api/services/gmail-oauth-no-replay.test.ts` | Implemented |
| 29 | Microsoft mailbox send | L1 | `api/services/microsoft-oauth.ts`, `api/services/mailbox-microsoft-dispatch.test.ts`; Azure first sign-in deferred (`LAUNCH-COMPLETION.md:159`) | Implemented; blocked on owner |
| 30 | Staff invitations, verification, reset (L2) | L2 | `api/services/invite-email.ts`, `api/services/platform-email-delivery.ts` and tests | Implemented; inbox receipt unproven |
| 31 | SMS consent, STOP/START, quiet hours, caps | L4–L6 | `TWILIO-IMPLEMENTATION.md:49-58`, `:93-99`; `api/services/send-gate.ts:351` | Implemented; no live carrier test |
| 32 | Painless shared Yahoo inbox | L1 | Not supported (`MOBILE-EMAIL-PILOT.md:89`, `HOUSECALL-PRO-REPLACEMENT-GATE.md:113`) | **G-19** |
| 33 | Direct phone/mailto clicks create work (`PR-route:22`) | L9 | They do not create leads; Smart Site API only | **G-20** (or a manual-logging decision) |
| 34 | Multi-day roofing job, crew windows, reschedule (`HOUSECALL-PRO-REPLACEMENT-GATE.md:119`) | L7 | Project/crew windows and conflicts `api/services/contractor-scheduling.ts:79`; invoice-prep task `:96` | Implemented; no calendar sync/routing |
| 35 | Whole-business Housecall Pro migration (`CSS:175-183`; `HOUSECALL-PRO-REPLACEMENT-GATE.md:117`, `:133`) | L8 | Partial loaders: reviewed source adoption `api/services/source-adoption.ts`; normalized finance `schema/financial-migration.ts:21`, `ui/pages/financial-migrations.tsx`; service CSV (`HOUSECALL-PRO-REPLACEMENT-GATE.md:89`). No open-job/appointment/media/communications loader (`HOUSECALL-PRO-REPLACEMENT-GATE.md:77`) | **G-05** |
| 36 | Export / rollback path | L8/L10 | `api/services/customer-lifecycle-export.ts`, `api/services/native-customer-export.test.ts`; bounded scope (`HOUSECALL-PRO-REPLACEMENT-GATE.md:89`) | Implemented (bounded) |
| 37 | Hosted recovery of the selected release | L10 | Historical managed 95-table restore (`reports/staging-observation-2026-10-10/RESTORE-PLAN.md:57-62`). October 11 control-plane receipts also record original staging migration to 142, held private runtime, production binding/custody and read-only 75-table baseline. Actual PostgreSQL backup restoration and production migration/cutover remain separate; reconcile current evidence and the exact remaining plan before any new paid-resource decision | Remaining release-specific recovery evidence; no replay of completed work |
| 38 | GrowthOS subscription test flow (L11) | L11 | Stripe test-mode matrix `PAID-BETA-READINESS-P0.md:341-352` | Not run |
| 39 | Portfolio reuse of job photos (`CSS:78-80`) | — | Deferred by the owners; below the launch line | Not a launch test |

## B. Known-gap register

| ID | Gap | Affects | Decision or input that unblocks engineering |
| --- | --- | --- | --- |
| G-01 | Contractor payment collection (October 9 scope change) | CSS (Painless need unconfirmed) | Provider, methods, surcharge/fee policy, payout account type; redacted current statement (`CSS:141-156`) |
| G-02 | Signed estimate approval, deposits, progress payments, financing | CSS | Terms, approval roles, financing provider/eligibility, sample documents |
| G-03 | Equipment/warranty snapshot on invoices (draft → issue → print/email/export) | CSS (Painless to confirm) | Warranty evidence standard and wording; sample invoice |
| G-04 | Configurable service durations and travel capacity | CSS | Confirm the 2h/3h/1h defaults, install/major-repair durations, helper capacity |
| G-05 | Housecall Pro migration adapters | Both | Actual exports per company (`owner-input-checklist.md`, section C) |
| G-06 | Estimate delivery to the customer | Both | Channel and format; sample estimate |
| G-07 | Estimate follow-up cadence with stops and a call task | CSS | Quiet hours, stop events, call-task owner and deadline (`CSS:93-94`) |
| G-08 | Appointment yes/no confirmation and unconfirmed hold | CSS | Confirmation wording, timing, no-response rule |
| G-09 | Customer self-service details-correction form | CSS | Editable fields, identity check, staff review rule |
| G-10 | Urgent triage, dual urgent alert, fallback scheduling | CSS | Urgency criteria, escalation timer, slot rules, safeguards |
| G-11 | After-hours staff SMS alert and automatic customer reply | CSS | Hours/timezone, reply wording, consent basis |
| G-12 | Role-conditional invoice review (multi-repair → office) | CSS | Approval rule (count, amount or job type) |
| G-13 | Invoice/estimate delivery with photos and report; text delivery; bounce feedback | CSS | Sample assessment report and invoice layout |
| G-14 | Dual-channel (SMS + email) service reminders | CSS | Confirm both are required for each series |
| G-15 | Due-date shift after major service; plan billing and renewal | CSS | Reset rule, anchor choice, billing/renewal terms |
| G-16 | "On the way" texts; invoice payment follow-ups | CSS | Confirm required, timing and wording (current settings not inspected, `CSS:84-87`) |
| G-17 | Monitored Gmail reply intake; Microsoft read awaits Azure | Both | Mailbox provider per company; Azure first sign-in |
| G-18 | Handset SMS replies/STOP not synced from manual drafts | Painless | Accept the manual recording step, or require Twilio two-way SMS |
| G-19 | Shared Yahoo inbox unsupported | Painless | Choose a supported sender mailbox |
| G-20 | Phone/mailto contacts do not create leads | Painless | Connect phone/email sources, or accept a manual logging path |
