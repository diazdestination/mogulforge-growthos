# Housecall Pro replacement gate

Owner requirement recorded 2026-10-02. Source baseline: `47aca5beeb06e665bddfff23545640d779de51cc`.

## Binding outcome

**Both contractors must be able to replace their actual required Housecall Pro workflows before real onboarding/cutover.** Neither company has passed this gate. Do not substitute a smaller pilot, ongoing Housecall Pro dependency, or a full-parity claim without an explicit owner decision.

Replacement means the accepted critical work of Painless Roofing and Water Restoration and Climate Simulation Solutions runs correctly in GrowthOS. It does not mean reproducing a speculative competitor feature catalog. Housecall Pro access is optional migration support, not an ongoing runtime dependency. Preserve the existing beta terms and one isolated organization per business.

This gate supplements [contractor operations](GROWTHOS-CONTRACTOR-OPERATIONS.md), [product scope](GROWTHOS-CONTRACTOR-PRODUCT.md) and [staff success acceptance](BETA-CONTRACTOR-SUCCESS.md). It does not supersede [paid-beta release requirements](PAID-BETA-READINESS-P0.md).

## Release evidence is not replacement readiness

- Exact-commit CI, reviewed schema, hosted tenant isolation, scheduler/alerts and compatible managed restore remain separate release gates. The approved recovery lane owns their dated results; do not infer them from a local fixture or this document.
- The audited candidate expects 103 tables. Keep its release identity pinned during the approved recovery work. Older 77f6d63/95-table hosted snapshots in documents are historical, not a fresh inventory.
- “Built” below means reviewed source and synthetic coverage, not customer adoption or fresh provider success. See [integration evidence](reports/geekom-contractor-integration-2026-10-02.md) and [native-workday evidence](reports/native-contractor-day-integration.md). No tests or provider operations were performed while preparing this gate.
- A restore does not implement a missing customer workflow. Provider acceptance does not prove inbox receipt, customer reply, appointment completion or bank settlement. Staff-recorded money is not independently verified collection.
- Customer activation, provider configuration, spending, real messages/charges and old-subscription cancellation retain their applicable approval requirements.

## Built, missing, and not yet accepted

| Workflow | Built with synthetic coverage | Missing engineering / product boundary | Required live or staff proof |
| --- | --- | --- | --- |
| Customer/property/equipment/history | Native contacts, properties, opportunities, activities, jobs, private-object boundaries and service history. | Equipment is a text label, not a structured asset register. Contacts is a directory/editor, not a unified customer history card. Billable jobs/estimates/invoices require an opportunity. | Repeat customers and multiple properties; required historical documents/equipment facts; quick office/field lookup without duplicate people. |
| Leads, websites and growth | Pipeline, assignment/tasks, source-aware CSV, website adapters, campaign segments/rates/pause and bounded follow-up. | Imported opportunity outreach remains blocked: no current-source/native-cutover eligibility approval exists. Campaigns are not proof of paid-ad management. | Each actual website -> correct company/responder -> reply/appointment; duplicate/outage handling; approved campaign delivery, suppression and response handling. |
| Missed calls | Signed company-bound Twilio bridge, callback task, deliberate staff linking/opportunity creation and requested callback. | No automatic missed-call SMS or conversational intake/booking assistant in this path. Callback tasks do not enqueue canonical new-lead push. | Actual number/forwarding, answered/missed/busy/unreachable/voicemail/after-hours cases, owner escalation and safe consent/STOP/failure behavior. |
| Estimates/jobs/schedule | Line-item estimates, project/crew windows, conflict/version guards, Today, booking and booked-appointment reminders; one invoice-preparation task on completion. | No native estimate e-signature/contract acceptance. External calendar sync, travel routing, split shifts and leave/holiday calendars are not implemented. | Quote authorization and real office/field day: multi-day roofing job, HVAC visit, reassignment, cancellation/no-show and failure recovery. Add conditional features only where needed to replace current usage. |
| Invoices/payments | Draft/immutable numbered issue/void/print, exact cents, partial recorded receipts and allocation/reversal with refund ambiguity visible. | No native invoice-send flow or contractor processor collection/settlement. Opening-balance migration is missing. Subscription checkout is not contractor invoice collection. | Actual invoice receipt, partial balance/refund reconciliation and agreed collection method; print/PDF and accountant/owner review. **Payment processor decision pending; already requested from owner.** |
| Warranty/service plans | Evidence-backed coverage, explicit recurrence approval, month-end/leap anchors, one next obligation/task, appointment reconciliation and completed/cancelled history. | Due dates create staff tasks, not customer due-service reminders or response-to-booking automation. No inferred warranty validation, agreement renewal or service-plan billing. | Due -> permitted reminder -> reply/escalation -> accepted visit -> completion evidence -> correct next date; no-response/opt-out/expired agreement paths. |
| Email/replies | Selected Gmail/Microsoft sender, company default, no mailbox fallback; signed normalized reply identity and staff review/holds. | Send-only OAuth does not monitor a mailbox. Trusted live inbound bridge is not delivered by the reply wave. Complete platform identity/invite delivery ledger/callback reconciliation is unfinished. | Real mailbox send/receipt/reply, refresh/revocation, invitation/reset/verification delivery and safe unknown effects. Owner Azure first sign-in remains deferred. |
| Owner/mobile | Home-screen push path for canonical new leads, tenant policy, lead deep links, revocation and three human-send SMS drafts. | Not general service/call/invoice exception paging. Phone drafts are not sending or automatic handset reply/STOP synchronization. | Each actual phone: install/permission, background/locked/Focus/offline, daytime/after-hours routing, correct lead/login/company, logout and manual compose/send. |
| Migration/continuity | Opportunity and customer/service CSVs; bounded consistent 18-dataset core export, invoice hashes and explicit exclusions; company pause/offboarding request. | No whole-business loader for open jobs/appointments/issued invoices/opening cash/documents. Export excludes binary media, full conversations and automation definitions/queues; expanded export needed above its limits. | Approved migration/count/balance/history reconciliation, compatible recovery, one writer per domain, delta cutoff, rollback/export and separate contractor sign-offs. |

## Exact source anchors

Anchors are one-based at the source baseline. `api/` below means `artifacts/api-server/src/`; `ui/` means `artifacts/command-center/src/`. Paths and test names identify evidence, not fresh test execution.

1. Customer/equipment: `lib/db/src/schema/service-obligations.ts:33` (`equipmentLabel`); `lib/db/src/schema/projects.ts:25` (required opportunity); `ui/pages/contacts.tsx:11` (directory); `api/services/crm.ts:908` (lead activity history). Native data does not itself provide a complete customer workday screen.
2. Imported outreach: `api/services/source-history.ts:35` explicitly states no freshness attestation exists; `api/services/send-gate.ts:282` checks current tenant-owned provenance; `api/services/reactivation.ts:949` skips imported enrollment. `api/services/send-source-history.test.ts:39` verifies the hold; `:54` distinguishes legitimate transactional work.
3. Missed calls: `api/routes/v1/twilio-voice.ts:342` tries the configured staff number; `:566` handles the missed result. `api/services/missed-call-handoff.ts:21` creates a task, `:83` performs explicit review without `lead.created` auto-enrollment. `api/routes/v1/twilio.test.ts:646` and `:695` explicitly test no missed-call SMS/auto-enrollment.
4. Schedule/service: `api/services/contractor-scheduling.ts:27` (shared lock), `:61` (resource conflict), `:78` (invoice task); `api/services/service-obligations.ts:107` (staff task), `:217` (completion), `:303` (recurrence approval). `api/services/automation.ts:568` reminds about an already-booked appointment, not a due-service request. `api/services/contractor-scheduling.test.ts:118` covers month-end/leap anchors; `api/services/contractor-today.test.ts:112` covers DST.
5. Invoice boundary: `api/services/invoices.ts:693` issues, `:847` records a receipt, `:918` reverses allocation. The routes in `api/routes/v1/invoices.ts:98` expose internal document/receipt operations, not delivery/checkout. `api/services/invoices.test.ts:234` verifies issue creates no sent/paid evidence; `:444` verifies allocation reversal is not new cash.
6. Email/mobile: `api/services/customer-email.ts:117` uses the selected sender; `api/services/microsoft-oauth.ts:21` requests send-only mail scope. `api/services/response-correlation.ts:34` requires trusted original-mailbox identity or staff review. `api/services/staff-push.ts:135` enqueues canonical new-lead notices; `api/services/manual-sms.ts:138` records draft preparation only. [Email limitations](CUSTOMER-EMAIL-PILOT.md) and [device acceptance](STAFF-PUSH-PILOT.md) remain applicable.
7. Migration/export: `api/services/service-obligations.ts:340` imports customer/service rows, not a complete account. `api/services/customer-lifecycle-export.ts:9` lists 18 datasets, `:29` exclusions, `:52` bounded snapshot behavior (2,000 rows/table, 10 MiB; fails rather than truncates). `api/services/native-customer-export.test.ts:219` covers financial/recurrence preservation. [RUNBOOK](RUNBOOK.md) retains compatible-release recovery and older-app rollback restrictions.

## Prioritized bounded engineering

Keep engineering work separate from the pinned recovery candidate; review each slice and its release evidence before adoption. Reuse canonical records, transport gates, locks and audit rather than creating client-specific systems.

1. **P1: Finish both requested customer-care loops.** Service due -> approved reminder -> reply/unconfirmed escalation -> conflict-checked office booking -> completion -> next obligation. Missed call -> permitted customer-care response/intake -> accountable staff/after-hours escalation -> lead/appointment handoff. Include deduplication, current consent/suppression, STOP/no-response, unknown-effect review and explicit emergency boundaries. A task alone cannot satisfy the promised automation.
2. **P1: Deliver invoices and reconcile the agreed payment method.** Send the immutable issued document with durable logical request and acceptance/delivery/error evidence. Keep processor selection pending; do not choose or activate one implicitly. Add approved collection/partial payment/refund/overdue behavior required by the acceptance cards, without treating subscription billing as contractor revenue.
3. **P1: Add reviewed native-source adoption and required migration loaders.** Preserve import provenance. Record a version-bound, audited and revocable current-source/cutover decision plus channel eligibility; never clear history, merge around a hold or label marketing transactional. Build only loaders needed by approved exports and opening balances; reconcile dry-run counts and exceptions.
4. **P1: Finish communication evidence and exception coverage.** Complete the trusted incoming-email bridge and platform delivery/reconciliation gaps. Cover missed-call/service exceptions intentionally rather than assuming the new-lead queue does so. Do not blindly replay uncertain effects or silently select another sender.
5. **P1: Remove workday friction found by staff rehearsal.** If required, add a bounded role-checked customer detail view over existing properties, service, jobs and invoices; add only confirmed equipment/checklist fields. Rehearse repeat-customer billing so native opportunity linkage does not duplicate customers or inflate acquisition reporting.
6. **Conditional:** external calendar sync, split shifts, routing, pricebook, signatures, progress billing/change orders and broader advertising connectors become blockers only when a contractor's accepted critical workflow requires them. No speculative full-catalog build and no silently removed current requirement.

## Acceptance card: Painless Roofing and Water Restoration

**Status: NOT ACCEPTED.** Owner identities/contact details stay in the private pilot intake, not this repository.

Confirmed decisions to preserve:

- Normal hours: **Monday–Saturday, 09:00–18:00, America/New_York**.
- Both nominated owners receive daytime new-lead notices. Outside that schedule, route notices to the **designated after-hours owner already identified in the private intake**; do not ask the owner to choose again or substitute another person.
- The company offers 24-hour service. This is not a guaranteed emergency dispatch or blanket overnight customer-messaging authorization.
- Home-screen notification -> correct lead -> three human-send SMS drafts is required alongside the agreed missed-call automation.

Inputs still required: runtime company/site and accepted staff identities, accountable lead assignee, actual website/capture configuration, verified sender, main voice number/forwarding, approved export/documents, open balances, equipment/service promises and retention policy. Microsoft was assumed, not verified; no shared Yahoo/send-as capability is implied. **Payment processor decision pending.**

Acceptance checklist (each entry needs dated result, release, tester and evidence):

- [ ] Approved source sample and migration reconcile customers/properties, repeat jobs, required photos/documents, open estimates/jobs/appointments, service promises and opening balances.
- [ ] Website and missed-call inquiry reach the correct company and accountable staff, including both daytime recipients and the designated after-hours owner; no duplicate or unauthorized contact.
- [ ] Office and field staff find today/customer/property/history, quote and schedule a roofing job, handle a conflict/reschedule, finish work and prepare the correct invoice without coaching.
- [ ] Customer receives the agreed invoice; actual partial payment/refund/balance or approved external collection reconciliation works. Staff evidence is distinguished from settlement.
- [ ] Required warranty/service due reminder, response/exception, appointment, completion and next-date paths work with actual agreement evidence.
- [ ] Selected email and each approved phone pass receipt/reply/revocation, notification/deep-link/logout and manual-SMS tests; failures have visible owners and next actions.
- [ ] Source-of-truth, cutover/delta, rollback/export and recovery are rehearsed; company owner plus office/field representatives accept the required workflows.

## Acceptance card: Climate Simulation Solutions (HVAC)

**Status: NOT ACCEPTED.** A private HVAC Smart Site candidate is not a connected or activated customer account. Never reuse Painless owners, routing, credentials, consent or hours.

Inputs still required: accepted company/staff identities, actual website and provider identities, technicians/territory/durations, business and after-hours policy, approved exports/open balances, and actual equipment/maintenance agreements with warranty standards, notice lead times, coverage/end dates and checklists. **Payment processor decision pending.**

Acceptance checklist (each entry needs dated result, release, tester and evidence):

- [ ] Approved migration reconciles customers and all service properties/equipment, service history/documents, open work/appointments, agreements and financial opening balances.
- [ ] A real agreed maintenance/warranty due date produces a permitted customer reminder, visible company notice, reply or accountable escalation, and a conflict-checked appointment; no visit or warranty is invented.
- [ ] Technician completes the agreed checklist/evidence; exactly one correct next service is created. No-show/cancellation, no response, opt-out, expired coverage and month-end dates behave correctly.
- [ ] Office and field staff handle repeat-customer service and new installation/repair opportunities, estimates/jobs, conflict/reschedule, invoice delivery and partial payment/refund reconciliation without duplicate people or cash.
- [ ] Website, lead/campaign and missed-call workflows pass correct-company ownership, permitted follow-up, response/stop and approved after-hours escalation tests.
- [ ] Actual selected mailbox and approved staff phones pass delivery/reply/revocation, home-screen notification/deep-link and visible failure recovery.
- [ ] Source-of-truth, cutover/delta, rollback/export and recovery are rehearsed; company owner plus office/field representatives accept the required workflows.

## Shared stop/go record

The owner has reported a new Azure account. **First sign-in remains deferred until the owner is present.** Then inspect the actual directory/app registrations and use the existing integration; do not create another account. An owner's Hotmail test account is not proof of a contractor Microsoft 365 mailbox, calendar or incoming-mail bridge.

For each acceptance case record: company, agreed requirement, exact release/schema, authorized identities, timestamp, synthetic versus real evidence, provider receipt where applicable, independently observed outcome, exception/recovery result and named approver. Keep personal data and secrets out of repository evidence. Retain unknowns rather than passing them as zero or “not needed.”

Go only when **both cards' actual required workflows are accepted** and the separate release/customer-activation gates pass. Missing critical functionality cannot be waived by green CI or backup success. An intentionally manual step or scope change requires explicit acceptance, not an engineering assumption. Maintain one writer per record domain and prevent old/new automations from duplicating sends or balances. Old-system subscription cancellation remains a separate owner action after acceptance.
