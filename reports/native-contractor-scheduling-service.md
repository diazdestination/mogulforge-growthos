# Native scheduling, job handoff and recurring service

Date: 2026-10-01. Branch: `agent/growthos-native-contractor-day`.

## Delivered

- A single company scheduling lock covers native appointment/project writes, concierge inspection booking, service changes and appointment reminder claims. Its namespace remains the existing `<organizationId>:inspection-booking` namespace. Claims take this lock before the existing lead lock; provider work stays outside transactions.
- Appointment and project reservations reject overlapping assignments across both kinds of work. New assignments require an active, verified, accepted same-company team member with `crm.write`. Closing existing work can retain an inactive same-company technician as historical staff; reactivation and new assignments still require operational eligibility.
- Appointment date edits preserve a recorded duration when only the start changes. Endpoints, customer/property references, same-opportunity estimates and optional `expectedUpdatedAt` tokens are checked. Updated forms supply the tokens, retain failed input and expose save errors.
- Appointment listing supports paired `from`/`to` instants, at most 31 days, plus `assignedUserId`, `contactId` and the existing `leadId`. It keeps the legacy array response and 200-row bound. `X-Result-Limit-Reached` and the UI's visible cap notice prevent a capped range looking complete.
- Job completion creates one task identified by `project.invoice_preparation:<projectId>`. Reopening or cancelling unbilled work withdraws that task; completing it again reopens the same task. A retained non-void native invoice fulfills the task. No invoice is issued or sent by a status transition. Invoice creation shares the scheduling lock and closes the exact task transactionally.
- Service records accept explicit coverage dates and supporting agreement evidence. Unknown coverage remains unknown. A dedicated approval action records a calendar-month recurrence, its original date anchor, optional end date, agreement note and approving staff/time.
- Explicit service completion prepares at most one next service record and staff task. A self foreign key and unique predecessor index preserve ancestry and prevent duplicate successors. Repeating the same completion returns the same `nextObligationId`. Month-end/leap-year anchors do not drift. No appointment or customer message is automatically created.
- A cancelled service must be explicitly reopened before completion; reopening clears its recurrence approval. An already-completed parent with a successor cannot silently reopen or move the promise. Explicit recurrence stop/new approval remains separate.
- Service/appointment links require the same customer and reject contradictory known properties. Appointment cancellation, no-show or completion reopens the office service task; only staff confirmation completes the service. Later appointment edits cannot invalidate the linked property unnoticed.
- Appointment reminders use the company's validated timezone, include minutes and a timezone label, and fall back explicitly to UTC. Cancellation/reschedule invalidates pending unclaimed work. An already-claimed or uncertain execution retains its receipt and creates an office reconciliation task instead of claiming the external effect was cancelled.

## API details

- `GET /appointments`: optional `from`, `to`, `assignedUserId`, `contactId`; range endpoints must be supplied together. Existing `leadId` and array shape remain.
- `PATCH /appointments/:id`, `PATCH /projects/:id`: optional ISO `expectedUpdatedAt`; stale commands return 409. Date/assignee/customer conflicts use explicit error codes.
- `POST /service-obligations` and `PATCH /service-obligations/:id`: explicit coverage fields, optional staff assignment; PATCH also accepts `completionNote` and `expectedUpdatedAt`.
- `POST /service-obligations/:id/recurrence`: required `expectedUpdatedAt`, `intervalMonths` (1–60 or null to stop), `agreementNote`, optional `endDate`. Server records the actor and approval time. Only active service may receive a new policy.
- Service PATCH retains the existing row response with `nextObligationId: string | null`. Known property mismatch returns `appointment_not_for_property`; no new response envelope is introduced.
- These office mutations enforce same-origin browser requests and JSON bodies. Existing authenticated permissions remain required.
- Parent owns the schema barrel, migration, API generation, lifecycle inventory, `/contractor/today`, native customer export and integration gates. No parallel daily-work endpoint was added.

## Verification

All data was synthetic. The isolated runner creates a disposable local PGlite database and removes provider configuration.

Final scheduling selection: **75 passed, 2 skipped** across seven files:

```text
node scripts/test-scheduler-isolated.mjs src/services/contractor-scheduling.test.ts src/services/crm-appointment-conflict.test.ts src/services/appointment-reminder.test.ts src/services/project-duplicate-estimate.test.ts src/services/service-obligations.test.ts src/services/crm-appointment-past-start.test.ts src/routes/v1/contractor-scheduling.test.ts
```

The two skips are explicitly PostgreSQL-only multi-session races: overlapping appointment/project assignment and concurrent service completion. They remain CI acceptance checks; PGlite does not establish those lock semantics.

Frontend: **21 passed** in `contractor-scheduling.test.tsx`, `service-desk.test.tsx`, `project-form-modal.test.tsx`, and `role-gating.test.tsx`. API and Command Center `tsc --noEmit` both passed before the parent's final task-GET code generation. An unrelated Task-modal selector regression in `save-failure-toasts.test.tsx` was reported to the owning UI lane for its full-suite repair.

Actual Appointments, Project and Service forms were tested in headless Edge at 1440, 390 and 320 pixels in light mode, plus 390 pixels in dark mode: **12 cases, zero axe WCAG A/AA violations, zero horizontal overflow, zero page errors** after scoped label/contrast/focus corrections. Mobile screenshots were visually reviewed. Recordings and traces stayed disabled. Temporary entry files were removed and the owned 5193 preview was stopped. Local evidence: `C:\Forge\logs\growthos-native-scheduling-qa\result.json` and adjacent screenshots. The Impeccable detector returned no findings for the five changed form/page targets.

Independent source audit covered invoice fixed-point arithmetic, immutable issued snapshots, request replay/version guards, tenant references, role/origin/API-key boundaries, sequence/receipt locks and reversal semantics. No further blocking finding remained after the invoice owner's always-scheduling-lock fix. Independent invoice service/HTTP/retention/Today/export checks: **36 passed, 5 PostgreSQL-only skips**. This includes parent integration tests and is not a second implementation of those lanes.

## Remaining boundaries

- This is a native office/field workday candidate, not a deployment or real-customer acceptance claim. PostgreSQL CI, migration rehearsal and the parent's complete integration gate still apply.
- No live provider send, billing action, account mutation, commit, push or deployment was performed in this lane.
- Scheduling reserves each staff member for the full supplied appointment/job interval. Travel routing, split crew shifts, leave/holiday calendars and external calendar synchronization are not implemented here. Existing inspection capacity rules remain in force.
- Appointment/project form inputs explicitly show the browser timezone; Today and reminder copy use the configured company timezone. They store absolute instants. Cross-timezone staff must read the displayed timezone when entering a window.
- If a recurring service's next-task assignee has lost eligibility, completion rejects the inherited assignment until the office assigns eligible staff or explicitly unassigns the service. It does not silently schedule work for a disabled account.
- Coverage and recurrence evidence is staff supplied; the system does not infer a warranty, renew a paid agreement, promise coverage or book a visit.
- A provider effect already dispatched is reconciled from retained execution evidence. Cancelling the local appointment does not assert that a delivered message can be recalled.
