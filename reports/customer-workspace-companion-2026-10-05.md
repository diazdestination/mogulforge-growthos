# L7 customer work record — companion implementation evidence

October 5, 2026. Shared branch `agent/growthos-customer-workspace-20261003`.
Implements only the companion scope in
`reports/customer-workspace-contract-2026-10-03.md`. This is local code/test
evidence, not hosted release, provider activation or contractor cutover approval.

## Implemented

- New-service creation has an explicit customer-property picker backed by the
  authorized customer workspace `properties` section. It starts unlinked even
  with one property, loads additional opaque-cursor pages only on request, and
  validates the closed DTO and exact company/customer/page context. Failed,
  overlapping or looping page chains clear the selected property rather than
  presenting an empty success. Contact, company, role and member changes reset
  selection and abort/ignore older responses. Unchanged membership polling
  preserves a valid draft. Creation posts an explicit selected property ID or
  null. It never patches historical service property links.
- Today now opens exact native service and appointment targets, pinned to the
  current organization. Separate canonical customer links are sibling anchors,
  not nested links or replacements for the primary work action. The work-day
  query identity uses semantic membership and hides cached work on profile error.
- `/appointments?appointmentId=...&organizationId=...` has an independent exact,
  read-only card. It validates the strict pinned location and closed appointment
  DTO. Invalid, foreign, unavailable or stale targets do not fall back to a list
  row. It can open a visit outside the displayed date range. **Show this day in
  schedule** explicitly changes the native range and clears its team filter.
- The selected summary has no mutation path. Existing native Schedule/Edit
  controls remain the only appointment editors and use their full native row,
  private notes and optimistic token, never the redacted read DTO. Appointment
  queries, assignee/contact/lead options and availability cache keys are scoped
  by semantic membership. Native delayed status-review results are discarded
  after a range/target or authority change.
- The accessibility test now waits for the actual admitted Appointments Schedule
  control. Its former spinner-only settling helper returned before the new
  text-only authority loader finished. All nonempty/name assertions remain.

## Owned code and tests

- `artifacts/command-center/src/components/customer-property-select.tsx` and test
- `artifacts/command-center/src/components/appointment-linked-card.tsx`
- `artifacts/command-center/src/components/lead-select.tsx` and scoped-cache test
- Optional `propertyId` type only in `components/service-obligation-editor.tsx`
- `pages/service-desk.tsx`, `pages/service-property-creation.test.tsx`
- `pages/appointments.tsx`, `pages/appointment-linked-navigation.test.tsx`
- `pages/today.tsx`, `pages/today.test.tsx`
- Narrow readiness assertion in `src/accessible-names.test.tsx`

Runtime owns closed DTOs/read APIs; experience owns strict shared URL helpers
and the customer page; root owns HTTP/spec, creation locks, browser/restore and
release gates. No schema/provider/tenant mutation was used by this lane.

## Verification

From the repository root:

1. `pnpm --filter @workspace/command-center run typecheck` — passed after the
   final source changes.
2. `pnpm --filter @workspace/command-center exec vitest run` — **103 files,
   774 tests passed**, 20.55 seconds, final local run at 15:50 Eastern.
3. Focused property, service-create, exact-appointment, Today, Service Desk,
   scheduling, workday-recovery, role, save-failure and lead-picker regression
   selection — **10 files, 96 tests passed** before the final accessibility/cache
   regression additions. The subsequent full suite includes those additions.
4. Scoped `git diff --check` for companion components/pages — passed. A separate
   root-owned generated API EOF whitespace warning was reported to integration.

New tests cover explicit/null submission, unchanged history, property paging,
bad/mismatched/duplicate/repeated-cursor responses, late contact/company/member/
role responses, current profile failure, exact targets outside date range,
missing/foreign/malformed target behavior, no invented unlinked customer,
preservation of full native notes on explicit edit, separate Today anchors and
optional lead-picker cache isolation.

## Boundary and next action

No commits, push, provider requests, real messages, hosted schema changes or
customer imports were performed. `pnpm-workspace.yaml.bak` was not touched.
The GrowthOS Revenue Desk skill kept projection/navigation, canonical mutation
ownership and local-versus-live evidence separate. Checkpoint source and this
report are saved to disk; root owns the shared Jarvis STATE/release checkpoint
and commit to avoid concurrent state edits. No global memory/settings were edited.

Root should complete desktop/narrow-phone workflow verification, the independent
PostgreSQL selected-property writer barrier, synthetic recovery and exact-head
CI before integration. This bounded slice does not claim complete L7, repeat
billable-job support, actual contractor sample acceptance or Housecall Pro parity.
