# Housecall Pro replacement gate

Current L5 source addendum: base PR19/mainf91e1c3 passed exact-main CI37134529680.
`reports/standing-service-integration-2026-10-03.md` adds default-off exact
forward-only series reminders and signed SMS office evidence/holds in the existing
Service Desk. This supersedes the historical matrix's every-occurrence approval
limitation only for a separately approved eligible service series. Individual
review remains available; original send ownership, consent and all other holds
remain. No catch-up sweep, automatic booking or warranty determination. Source
schema125tables/reviewed0013 and local recovery are not hosted or contractor proof.
Both company cards remain NOT ACCEPTED; use LAUNCH-COMPLETION for the fixed gaps.

Current October3 source addendum: PR18/mainfa7c827 passed its exact-main gate.
The new `reports/callie-intake-integration-2026-10-03.md` candidate adds separately
approved automatic keypad intake, caller-originated one-call acknowledgment and
explicit office-confirmed native visits. Caller ID is not identity/consent and
keypad intent is not booking. This is not a conversational receptionist or
autonomous confirmed appointment. Source schema121tables/reviewed0012 and synthetic
recovery do not attest hosted/provider acceptance. Both company cards remain NOT
ACCEPTED. Use LAUNCH-COMPLETION for current remaining engineering; older matrices
below are historical where superseded by later integration reports.

Current October 2 operations-wave addendum:
`reports/operations-wave-integration-2026-10-02.md` supersedes older missing-work
claims below for service watch/typed staff notifications, reviewed source
adoption and normalized invoice/opening-receivable migration. Current schema is
111 tables (`0008` after `0007`); historical managed recovery covered103tables.
Neither contractor has accepted replacement. Operator workflows and remaining
boundaries are in `reports/operations-wave-operator-guide-2026-10-02.md`.

Owner requirement recorded 2026-10-02. Original source audit baseline:
`47aca5beeb06e665bddfff23545640d779de51cc`. The matrix now includes the
`agent/growthos-customer-care-20261002` candidate; its
[integration report](reports/customer-care-integration-2026-10-02.md) records
separate local and CI evidence, not hosted or contractor acceptance.

## Binding outcome

**Both contractors must be able to replace their actual required Housecall Pro workflows before real onboarding/cutover.** Neither company has passed this gate. Do not substitute a smaller pilot, ongoing Housecall Pro dependency, or a full-parity claim without an explicit owner decision.

Replacement means the accepted critical work of Painless Roofing and Water Restoration and Climate Simulation Solutions runs correctly in GrowthOS. It does not mean reproducing a speculative competitor feature catalog. Housecall Pro access is optional migration support, not an ongoing runtime dependency. Preserve the existing beta terms and one isolated organization per business.

This gate supplements [contractor operations](GROWTHOS-CONTRACTOR-OPERATIONS.md), [product scope](GROWTHOS-CONTRACTOR-PRODUCT.md) and [staff success acceptance](BETA-CONTRACTOR-SUCCESS.md). It does not supersede [paid-beta release requirements](PAID-BETA-READINESS-P0.md).

**Latest owner clarification, October 2:** payment collection inside GrowthOS is deferred to a future add-on. Initial release work includes invoice delivery, accurate balances and staff-recorded external receipts/corrections, not card/bank processing. Contractor processor selection is no longer a launch input blocker. This does not remove GrowthOS subscription billing checks, invent settlement evidence, or cancel either company's external collection arrangements. The current bounded engineering wave is [customer care](reports/customer-care-contract-2026-10-02.md).

## Release evidence is not replacement readiness

- Exact-commit CI, reviewed schema, hosted tenant isolation, scheduler/alerts and compatible managed restore remain separate release gates. The approved recovery lane owns their dated results; do not infer them from a local fixture or this document.
- The original managed-tested candidate expects 103 tables; the new customer-care candidate expects 105. Keep release identities separate. Older 77f6d63/95-table hosted snapshots in documents are historical, not a fresh inventory. The completed restore does not attest the new 0007 delta.
- “Built” below means reviewed source and synthetic coverage, not customer adoption or fresh provider success. See [customer-care evidence](reports/customer-care-integration-2026-10-02.md), [earlier integration](reports/geekom-contractor-integration-2026-10-02.md) and [native-workday evidence](reports/native-contractor-day-integration.md).
- A restore does not implement a missing customer workflow. Provider acceptance does not prove inbox receipt, customer reply, appointment completion or bank settlement. Staff-recorded money is not independently verified collection.
- Customer activation, provider configuration, spending, real messages/charges and old-subscription cancellation retain their applicable approval requirements.

## Built, missing, and not yet accepted

| Workflow | Built with synthetic coverage | Missing engineering / product boundary | Required live or staff proof |
| --- | --- | --- | --- |
| Customer/property/equipment/history | Native contacts, properties, opportunities, activities, jobs, private-object boundaries and service history. | Equipment is a text label, not a structured asset register. Contacts is a directory/editor, not a unified customer history card. Billable jobs/estimates/invoices require an opportunity. | Repeat customers and multiple properties; required historical documents/equipment facts; quick office/field lookup without duplicate people. |
| Leads, websites and growth | Pipeline/website intake/CSV; versioned audited source adoption with retained provenance; independent exact-address marketing permission and separately approved one-touch email batches. | Generic imported playbooks/SMS remain held. Reviewed email is bounded to10/batch,25 rolling company reservations and one lifetime lead/address touch; unknown effects cannot be cloned/rearmed. Not paid-ad management. | Actual source cutoff and permission evidence; correct website/company/responder; permitted delivery, opt-out/reply holds, outcome evidence and failure recovery. |
| Missed calls | Signed company-bound Twilio bridge, callback task, reviewed linking/new opportunity with canonical lead push; exact individually approved SMS, default-off hours/owner policy, receipt/reply review and deadline escalation. | Not an autonomous unknown-caller receptionist or conversational booking agent. Each call/message needs staff approval and actual consent; caller ID is not permission. No automatic reply sequence or guaranteed emergency dispatch. | Actual number/forwarding, answered/missed/busy/unreachable/voicemail/after-hours cases, owner escalation and safe consent/STOP/failure behavior. |
| Estimates/jobs/schedule | Line-item estimates, project/crew windows, conflict/version guards, Today, booking and booked-appointment reminders; one invoice-preparation task on completion. | No native estimate e-signature/contract acceptance. External calendar sync, travel routing, split shifts and leave/holiday calendars are not implemented. | Quote authorization and real office/field day: multi-day roofing job, HVAC visit, reassignment, cancellation/no-show and failure recovery. Add conditional features only where needed to replace current usage. |
| Invoices/external receipts | Native issue/void/print, exact cents and external receipt/reversal records; reviewed plain-text email; normalized historical invoice/receipt or non-cash opening-receivable import with exact original documents/IDs and atomic dedupe. | No connected delivery/bounce confirmation, public invoice portal, PDF attachment or approved resend/rearm. Financial loader is strict normalized v1, not an arbitrary Housecall Pro CSV adapter; unsupported adjustments require reconciliation. Contractor collection deferred. | Actual migration totals, original document/number/date/cutoff, receipt allocations, customer invoice receipt, partial/refund balances and accountant/owner acceptance. |
| Warranty/service plans | Evidence/recurrence and service care; bounded watch queue flags overdue/no recorded response/blocked or uncertain send/cancelled/no-show, with accepted owner, internal next-action deadline, retained history and typed staff notification. | Every occurrence still needs reminder approval. Office plans are not customer replies/booking. No autonomous mailbox/self-booking, warranty determination, renewal or service-plan billing. | Due -> permitted reminder -> reply/office escalation -> agreed visit -> completion -> next date; no-response/opt-out/expired agreement and missed office deadline cases. |
| Email/replies | Selected Gmail/Microsoft sender, company default, no mailbox fallback; signed normalized reply identity and staff review/holds. | Send-only OAuth does not monitor a mailbox. Trusted live inbound bridge is not delivered by the reply wave. Complete platform identity/invite delivery ledger/callback reconciliation is unfinished. | Real mailbox send/receipt/reply, refresh/revocation, invitation/reset/verification delivery and safe unknown effects. Owner Azure first sign-in remains deferred. |
| Owner/mobile | Canonical lead push/manual SMS drafts plus default-off typed service-watch alerts to the actual current accepted owner. Generic lock-screen text, service/company deep links, stale case/session/policy cancellation and final pre-network recheck. | Not general call/invoice exception paging. Service alerts are current-owner any-hour opt-in, separate from lead day/after-hours routing. Push acceptance is not receipt/read. Handset replies/STOP are not synced. | Each actual phone: install/permission, background/locked/Focus/offline, routing/ownership, correct lead/service/login/company, logout and manual compose/send. |
| Migration/continuity | Opportunity/service CSVs, reviewed native adoption, normalized historical finance, bounded consistent20-dataset core export and company holds. Local111-table restore preserves typed push, watch, revoked adoption/claimed effects and non-cash opening balances. | No whole-business open-job/appointment/media loader; real export layouts need mapping. Core export excludes raw approvals, binary media, full communications/automation and secrets; expanded scope needs review. | Approved source counts/balances/history/exceptions, fresh hosted compatible backup/restore, one writer and cutoff per domain, rollback/export and both contractor sign-offs. |

## Exact source anchors

Anchors are one-based at the **original** source baseline, not the later customer-care implementation. `api/` below means `artifacts/api-server/src/`; `ui/` means `artifacts/command-center/src/`. Paths and test names identify historical audit evidence. For updated calls, service and invoice behavior, use the three customer-care lane reports and current integration report instead of these older line numbers.

1. Customer/equipment: `lib/db/src/schema/service-obligations.ts:33` (`equipmentLabel`); `lib/db/src/schema/projects.ts:25` (required opportunity); `ui/pages/contacts.tsx:11` (directory); `api/services/crm.ts:908` (lead activity history). Native data does not itself provide a complete customer workday screen.
2. Imported outreach: `api/services/source-history.ts:35` explicitly states no freshness attestation exists; `api/services/send-gate.ts:282` checks current tenant-owned provenance; `api/services/reactivation.ts:949` skips imported enrollment. `api/services/send-source-history.test.ts:39` verifies the hold; `:54` distinguishes legitimate transactional work.
3. Missed calls: `api/routes/v1/twilio-voice.ts:342` tries the configured staff number; `:566` handles the missed result. `api/services/missed-call-handoff.ts:21` creates a task, `:83` performs explicit review without `lead.created` auto-enrollment. `api/routes/v1/twilio.test.ts:646` and `:695` explicitly test no missed-call SMS/auto-enrollment.
4. Schedule/service: `api/services/contractor-scheduling.ts:27` (shared lock), `:61` (resource conflict), `:78` (invoice task); `api/services/service-obligations.ts:107` (staff task), `:217` (completion), `:303` (recurrence approval). `api/services/automation.ts:568` reminds about an already-booked appointment, not a due-service request. `api/services/contractor-scheduling.test.ts:118` covers month-end/leap anchors; `api/services/contractor-today.test.ts:112` covers DST.
5. Invoice boundary: `api/services/invoices.ts:693` issues, `:847` records a receipt, `:918` reverses allocation. The routes in `api/routes/v1/invoices.ts:98` expose internal document/receipt operations, not delivery/checkout. `api/services/invoices.test.ts:234` verifies issue creates no sent/paid evidence; `:444` verifies allocation reversal is not new cash.
6. Email/mobile: `api/services/customer-email.ts:117` uses the selected sender; `api/services/microsoft-oauth.ts:21` requests send-only mail scope. `api/services/response-correlation.ts:34` requires trusted original-mailbox identity or staff review. `api/services/staff-push.ts:135` enqueues canonical new-lead notices; `api/services/manual-sms.ts:138` records draft preparation only. [Email limitations](CUSTOMER-EMAIL-PILOT.md) and [device acceptance](STAFF-PUSH-PILOT.md) remain applicable.
7. Migration/export: `api/services/service-obligations.ts:340` imports customer/service rows, not a complete account. `api/services/customer-lifecycle-export.ts:9` lists 18 datasets, `:29` exclusions, `:52` bounded snapshot behavior (2,000 rows/table, 10 MiB; fails rather than truncates). `api/services/native-customer-export.test.ts:219` covers financial/recurrence preservation. [RUNBOOK](RUNBOOK.md) retains compatible-release recovery and older-app rollback restrictions.

## Prioritized bounded engineering

Keep engineering work separate from the pinned recovery candidate; review each slice and its release evidence before adoption. Reuse canonical records, transport gates, locks and audit rather than creating client-specific systems.

1. **P1: Release and accept the bounded customer-care candidate.** The service reminder/staff-response/office-booking and reviewed missed-call response/escalation slices are implemented. Complete the candidate's release gates, actual delivery/reply/booking proof and staff acceptance; do not call individually reviewed work a fully autonomous receptionist. Trusted inbound integration and wider exception paging remain unfinished.
2. **P1: Accept invoice delivery and external receipts.** Exact reviewed plain-text dispatch and durable acceptance/held/unknown evidence are implemented. Prove actual receipt and external partial balance/refund reconciliation. Delivery/bounce feedback and a safe separately authorized resend path remain absent. Defer contractor processing; do not treat subscription billing as contractor revenue or staff evidence as bank settlement.
3. **P1: Accept reviewed native-source adoption and normalized financial migration.** Implemented in the operations wave, not live. Reconcile actual approved source/export layouts, current permission, customer mappings, counts and exact balances. Add only required missing adapters/relationships; never discard provenance, relabel marketing or fabricate cash.
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

Inputs still required: runtime company/site and accepted staff identities, accountable lead assignee, actual website/capture configuration, verified sender, main voice number/forwarding, approved export/documents, open balances, equipment/service promises and retention policy. Microsoft was assumed, not verified; no shared Yahoo/send-as capability is implied. In-app payment collection is deferred.

Acceptance checklist (each entry needs dated result, release, tester and evidence):

- [ ] Approved source sample and migration reconcile customers/properties, repeat jobs, required photos/documents, open estimates/jobs/appointments, service promises and opening balances.
- [ ] Website and missed-call inquiry reach the correct company and accountable staff, including both daytime recipients and the designated after-hours owner; no duplicate or unauthorized contact.
- [ ] Office and field staff find today/customer/property/history, quote and schedule a roofing job, handle a conflict/reschedule, finish work and prepare the correct invoice without coaching.
- [ ] Customer receives the agreed invoice; staff can reconcile externally collected receipts, partial balances and corrections without charging through GrowthOS. Staff evidence is distinguished from settlement.
- [ ] Required warranty/service due reminder, response/exception, appointment, completion and next-date paths work with actual agreement evidence.
- [ ] Selected email and each approved phone pass receipt/reply/revocation, notification/deep-link/logout and manual-SMS tests; failures have visible owners and next actions.
- [ ] Source-of-truth, cutover/delta, rollback/export and recovery are rehearsed; company owner plus office/field representatives accept the required workflows.

## Acceptance card: Climate Simulation Solutions (HVAC)

**Status: NOT ACCEPTED.** A private HVAC Smart Site candidate is not a connected or activated customer account. Never reuse Painless owners, routing, credentials, consent or hours.

Inputs still required: accepted company/staff identities, actual website and provider identities, technicians/territory/durations, business and after-hours policy, approved exports/open balances, and actual equipment/maintenance agreements with warranty standards, notice lead times, coverage/end dates and checklists. In-app payment collection is deferred.

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
