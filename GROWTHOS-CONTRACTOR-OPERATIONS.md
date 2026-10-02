# GrowthOS contractor operations and Housecall Pro replacement

Owner direction, October 1, 2026. This supersedes the assumption that GrowthOS
must remain an add-on to Housecall Pro. It does not establish replacement
readiness or authorize a customer cutover, charge, message or public launch.

## Product target

Adam wants GrowthOS to replace Housecall Pro for the two beta companies. He
reports that they find the existing platform confusing, poorly organized and
unreliable. The specifically named daily needs are **scheduling, invoices and
warranty tracking**, with additional workflows to be established from actual
use. This is customer feedback reported by Adam, not a general finding about
Housecall Pro's reliability.

Build a simple daily operating system for roofing and HVAC companies. Retain
one shared platform with configurable trade terminology and workflows. Smart
Sites and existing websites both feed the same native operating workflow.
Housecall Pro access is optional migration or transition support. Native
GrowthOS work must not require a continuing Housecall Pro subscription.

Preserve the existing limited $500 beta agreements. The $1,500 flagship is a
value target requiring actual customer results and sustainable service costs.
Additional automation is useful when it removes repeated work or missed
handoffs. Feature count is not an acceptance metric.

## Daily organization to validate with the beta staff

1. **Today:** assigned work, appointments, overdue follow-up and exceptions.
2. **Customers and jobs:** one customer/property/job history with notes, photos,
   estimates, appointments and responsibilities.
3. **Schedule:** assigned people, availability, conflicts, rescheduling and
   customer confirmation state.
4. **Invoices:** draft, approve, send, payment status, overdue work and receipts.
5. **Warranties and service:** covered equipment/work, evidence, dates, due tasks
   and the next approved maintenance visit.

Use plain action labels, stable navigation, role-appropriate visibility and
clear saved/pending/failed states. Hide advanced configuration from the daily
path. A customer request stays pending until office confirmation. Measure task
completion, errors and support requests during actual staff acceptance.

## Native capability inventory at the 8bef3c0 starting candidate

| Need | Existing source | Replacement acceptance still required |
| --- | --- | --- |
| Customers/properties/history | Native contacts, properties, leads, activities and private project records | Approved migration, duplicates, attachments and staff usability |
| Scheduling | Assigned appointments, time windows, conflicts and reminder machinery | Office/field day rehearsal, full crew capacity and multi-day/reschedule behavior appropriate to each beta |
| Jobs | Native projects with status, crew IDs, notes and start/end dates | Verify assignment constraints, completion handoffs and mobile work under real operating conditions |
| Estimates | Native line items, totals, status and project linkage | Actual customer approval and delivery workflow; accepted amounts must not become invented collections |
| Invoices/payments | Staff-recorded payment/refund/cost evidence in the value ledger; Stripe billing for GrowthOS subscriptions | A native customer invoice lifecycle and invoice/payment reconciliation are missing. Subscription checkout is not contractor invoice collection. Define invoice numbering, immutable issued versions, balances, partial payments, corrections, cancellation and approved tax/payment rules before implementation |
| Warranties/maintenance | Service obligations support warranty_check, maintenance and service_plan, equipment labels, dates, staff tasks and appointments | Coverage/claim evidence as required by actual agreements, approved recurrence and reconciliation; do not invent coverage promises |
| Communications/automation | Follow-up proposals, playbooks, reminders, missed-call tasks, review/referral foundations | Verified reply/stop handling, account/provider acceptance, agreed automation policy and visible exceptions |

Code anchors: `lib/db/src/schema/projects.ts`, `appointments.ts`, `estimates.ts`,
`service-obligations.ts`, `artifacts/api-server/src/services/crm.ts`,
`services/service-obligations.ts`, `services/revenue-workspace.ts` and
`services/billing-checkout.ts`. These are source capabilities, not proof of
field adoption, successful provider delivery or a complete replacement.

## Current approved engineering wave

Branch `agent/growthos-contractor-operations` starts from the exact green
`8bef3c03c481b2f510ee82a3eb302c2e37df59aa` candidate. Current work:

- First-owner/staff invitations and accepted response coverage.
- Verified reply correlation and pending follow-up stop/review controls.
- Consistent report periods, cohorts and truthful monthly outcome evidence.
- Integrated release/schema/recovery rehearsals and deployable operating guidance.

These repairs support both native operation and a controlled migration. They
do not implement the missing invoicing/field-operation scope by implication.
Implementation and evidence are recorded in the lane reports and final wave
report. Existing imported-data holds remain in force.

## Replacement milestones after this foundation

1. Validate a native office/field day: inquiry, schedule, job, estimate, completion,
   invoice and warranty follow-up. Resolve each missing critical path before
   claiming that the beta can retire Housecall Pro.
2. Complete native customer invoicing and payment reconciliation through an
   approved processor; keep accounting exports/integration modular. No banking,
   tax filing, payroll or accounting platform rewrite is implied.
3. Finish approved warranty/maintenance recurrence and accountable handoffs.
4. Simplify the daily navigation around the tested tasks and role permissions.
5. Rehearse an approved migration: contacts/properties, open jobs and estimates,
   appointments, invoice balances, warranty/service obligations, documents and
   consent history. Preserve provenance, original dates and an exception report.
6. Run a bounded parallel acceptance period with one authoritative writer for
   each record type, reconciled balances and explicit customer sign-off. Keep
   a rollback/export path. Never cancel the old account or enable duplicate
   automation as part of an inferred migration.

Imported records become eligible for automated action only after an explicit,
audited authority/cutover decision and reconciliation of current status. Editing
a source label or loading a CSV cannot grant current-source verification.

## Automation priorities

- New inquiry -> correct staff owner -> overdue-response escalation.
- Confirmed appointment -> appropriate reminder; rescheduling/cancellation
  invalidates obsolete reminders.
- Verified reply/booking/accepted estimate -> stop outdated follow-up.
- Completed job -> invoice preparation/review, then a verified payment update
  stops overdue reminders when invoice capability is implemented.
- Completed service -> next agreed maintenance task; warranty reminders respect
  the actual coverage dates and never invent coverage or renewal terms.
- Completed eligible work -> bounded review/referral request where authorized.

Each automation needs a visible owner, trigger, stop condition, activity history
and an actionable exception. Uncertain external effects require reconciliation.
Existing company holds, tenant isolation and contact preferences remain enforced.

## Evidence and scope

Housecall Pro's official feature and training pages identify scheduling,
dispatching, estimates, invoices, payments and service plans as operational
workflows. Reviewed October 1, 2026:

- https://www.housecallpro.com/features/
- https://help.housecallpro.com/en/articles/4372680-scheduling-invoicing-and-payments-training

Replacement scope is governed by these two companies' actual required work,
not exhaustive competitor parity. Real configuration, customer acceptance,
provider proof, hosted restore and approved release remain distinct gates.
