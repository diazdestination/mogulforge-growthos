# Native contractor day contract

Owner authorized the next replacement wave after verified PR10 (`48c3491`).
Branch: `agent/growthos-native-contractor-day`. Native invoice, scheduling,
service and navigation work is specifically authorized; all release and live
activation gates remain. The existing $500 beta terms stay in force.

## Ownership

- Invoice worker: invoice schema, contract/service/routes, focused tests and report.
- Workflow worker: schedule/project/service services and existing form UIs,
  recurrence/coverage schema, reminder claim coordination and focused tests.
- Experience worker: shared navigation, shell/search/App routes, Today and Invoices.
- Coordinator: permissions, Today read model, shared router/schema exports,
  OpenAPI/generated clients, lifecycle/export, merge/delete guards, additive schema
  preview, recovery, integration tests, release and durable handoff.

## Today

`GET /api/v1/contractor/today?date=YYYY-MM-DD&scope=mine|company`, `crm.read`.
Unknown query keys and impossible calendar dates are rejected. Date is optional;
the server chooses today in the stored scheduling timezone. Missing/invalid
timezone uses explicitly labelled UTC. Reads do not create or migrate settings.
Default scope is company for owner/admin/office/sales_manager, mine otherwise.
Company visibility follows existing CRM read policy; tenant comes from membership.

Response: `{organizationId, generatedAt, date, timeZone, timeZoneSource,
startAt, endAt, scope, tasks, appointments, projects, services}`. The timezone
source is `configured` or `utc_fallback`. Each queue is `{items,total,truncated}`,
limited to 50 rows with exact totals from a consistent read-only snapshot.

- Tasks: open/in-progress and due before day end, or undated. Oldest due first,
  then undated; UI label is "Due and unplanned tasks".
- Appointments: overlap the half-open local day. A legacy missing end uses the
  existing two-hour scheduling fallback for overlap. Cancelled records are excluded;
  no-show/completed states stay explicit and an unknown end remains labelled as such.
- Jobs: scheduled/in-progress/on-hold overlapping the day, plus undated active jobs.
- Services: active obligations due on/before the selected calendar date, joined to
  their current staff task. Service dates use their existing noon-UTC calendar convention.

Task fields: `id,title,status,dueAt,leadId,contactId,customerLabel,assignedUserId,
assigneeName,actionPath`. Verified same-company invoice-preparation tasks open
`/invoices?projectId=...` only for invoice readers; other tasks open `/tasks?taskId=...`.
`GET /api/v1/tasks/:id` resolves the owned record with validated references,
independent of the recent-task display cap. It never substitutes another record.
Appointment fields add `type,scheduledStart,scheduledEnd` (no task dueAt/actionPath).
Job fields: `id,title,status,leadId,customerLabel,crewNames,scheduledStart,scheduledEnd`.
Service fields: `id,title,kind,status,dueAt,contactId,customerLabel,assignedUserId,
assigneeName,taskId`. Missing identities remain null; no fabricated customer/staff names.

Invoice monetary metrics are not exposed through this broad CRM read endpoint.
Failed requests show a retry state, never fake zero counts. Truncation stays visible.

## Financial controls

`invoices.read`: owner/admin/office/sales_manager. `invoices.manage`:
owner/admin/office, authenticated sessions only. Creation/issue/payment mutations
use durable request fingerprints, expected versions, deterministic bounded cents,
strict JSON/origin checks and transaction-level actor rechecks.

Issue creates an immutable numbered document; it does not send it. Payments are
staff-recorded evidence. Existing receipts are allocated without new cash entries;
new receipts and their allocation are atomic. Allocation reversal preserves the
original cash entry and is never labelled a refund. Unallocated recorded refunds
require reconciliation rather than a false paid state. No bank/payment processor
action or tax determination occurs in this engineering scope.

## Next-step automation

Completing a job creates one invoice-preparation staff task unless a non-void
project invoice exists. Creating that draft closes the exact task. Both paths
take the same scheduling lock before invoice-specific locks.

Service recurrence is explicit agreement-backed calendar months. Completion
creates one next staff task/obligation, with preserved month-end anchors and a
unique predecessor. It does not book appointments, contact customers or invent
warranty coverage. Actual coverage dates and evidence are entered explicitly.

## Engineering references

PostgreSQL's documented local timestamp conversion supports day boundaries across
DST: https://www.postgresql.org/docs/16/functions-datetime.html#FUNCTIONS-DATETIME-ZONECONVERT
Transaction locking guidance: https://www.postgresql.org/docs/16/explicit-locking.html
