# Manual appointment property selection — frozen implementation contract

October 5, 2026. Owner-authorized bounded continuation of L7, after PR22 merged
as `6cbf0ae93f4daf9d0a3f7e8b932d959b65f2870b` and exact-main CI37383108807 passed.
The base tracked tree is `e2fe11ead39ec84935d7a8308f79165c50af01fd`. Contract frozen
before implementation on `agent/growthos-manual-appointment-property-20261005`.

## Customer outcome and canonical authority

Office staff can explicitly choose the worksite when creating a NEW manual
appointment for an existing customer with multiple properties. A service-only
customer needs no invented acquisition lead. Contact, property, optional lead,
appointment and native reminder retain their existing canonical IDs/writers.
No schema change is expected: 130 tables and reviewed-only delta0014 unchanged.

The acting identity is the current active company member with `crm.write`.
Existing API authentication, tenant scope and permission checks remain mandatory.
Saving the native form is staff approval for the appointment, not permission for
provider activation, a new outbound campaign or changed consent. Existing native
appointment/audit/reminder semantics remain; this slice adds no duplicate ledger.

## Fixed implementation scope

1. NEW manual form reuses `CustomerPropertySelect` and the authorized paged
   customer-workspace properties route. Optional picker defaults to **No property
   linked**, including when exactly one property exists. Only a property in the
   current successfully loaded set may become the submitted selection.
2. Choose an explicit customer to load properties. An optional lead may still
   identify its customer server-side without choosing a property; do not infer a
   worksite from a lead, similar address/name or list order. Contradictory selected
   customer/lead/property combinations must fail closed, not silently relink.
3. A customer or lead change immediately clears selection and invalidates old
   property-page responses. A semantic member/company/role/active-state change
   closes/remounts the form and prevents stale options/results from acting.
   Unchanged profile polling must preserve valid drafts; timestamps are not
   identity. Failed/foreign/stale pages are not an empty-property success.
4. The property picker has appointment-specific accessible text while retaining
   current service wording by default. Preserve pagination, retry, refresh-clear,
   abort/sequence protections and keyboard/mobile operability.
5. Creation submits the explicit chosen property or explicit null. Editing an
   existing appointment does not expose this new relinking control or include a
   synthetic replacement property. Keep exact original appointment/version/notes
   from its native editor, never reconstruct edits from redacted workspace DTOs.
   No historical backfill, bulk mutation or rewriting old property/notes.
6. Within the native scheduling transaction, validate and share-lock every selected
   customer/lead/property parent coherently through appointment/reminder insertion.
   Recheck a competing reassignment after lock wait. Missing/foreign/moved or
   contradictory parents create no appointment/reminder. Preserve stable lock
   ordering and inspect all `appointmentCustomer` callers for compatibility.
7. Continue using `crm.createAppointment` and the native reminder writer. Preserve
   advisory schedule serialization, staff/crew/resource conflicts, inspection
   capacity, past-start grace, optimistic versions, historical status handling,
   service reconciliation and non-replayable external-effect guards. No alternate
   appointment path, fabricated lead or automatic customer message is introduced.

## Ownership (one shared checkout; no overlapping source writers)

- Runtime agent: `artifacts/api-server/src/services/contractor-scheduling.ts`,
  narrowly necessary `crm.ts` changes, new appointment-parent coherence tests,
  focused existing backend test updates. Report any broader caller/API change
  before touching it. No Git operations, GitHub actions or Docker management.
- Experience agent: appointment page, reusable customer-property picker and
  related UI tests. Do not change runtime, database/schema or generated clients.
- Companion agent: independent contract/source review and operator guide only;
  report findings to root/runtime/experience, no implementation-file edits.
- Root: contract, shared readiness/state/integration docs, coordinated verification,
  isolated test/preview harness, final review, commit/PR/CI and source release.
  Root also aligns the existing OpenAPI AppointmentInput.propertyId with explicit
  null and regenerates types/validators. The DB already permits null; this is no
  new endpoint, table or migration and leaves existing update semantics intact.

## Required acceptance

- Service-only customer with at least two properties, explicit null, one-property
  non-auto-selection and selecting a property from a later page.
- Customer/lead/semantic membership changes, unchanged membership refresh, stale
  deferred responses, foreign-context/error pages and untrusted option values.
- Foreign/missing/moved property and contradictory optional lead rejected without
  an appointment/reminder; coherent selected parents retained through insertion.
- Exactly one native appointment and native reminder for a successful create, no
  acquisition lead; historical appointment property/notes remain unchanged.
- Real independent PostgreSQL16 barrier in both directions: creator retains parent
  lock through insert while actual CRM property reassignment waits, and creator
  waits for a competing reassignment then rejects old-customer selection. PGlite
  must skip those cases explicitly, never be reported as proof of row-lock races.
- Existing scheduling/capacity/optimistic-version/reminder/service-booking tests,
  focused UI, workspace types/builds, complete fresh candidate CI and exact-main
  CI after reviewed integration. Every source revision needs its own evidence.
- Synthetic built-UI walkthrough on desktop/mobile; no real customers/providers.
  Compatible recovery/source identity evidence is distinct from hosted acceptance.

## Stop line and remaining inputs

No deployment, hosted schema/credential mutation, provider activation, customer
messages, real imports, spending, payment collection or subscription cancellation.
Keep unrelated `pnpm-workspace.yaml.bak` and existing Docker fixtures/backups.
Read the private Docker REBOOT handoff before local Docker work; no automatic
reboot/reset/reinstall/update or permanent-repair claim.

No equipment/checklist requirements, warranty/manufacturer standards, source
mappings or repeat-billable-work semantics may be invented. Approved contractor
workday examples/forms/exports are required for those later choices. This reusable
roofing/HVAC scheduling improvement is not completion of L7/L8, the fixed launch
list, either contractor replacement card or live acceptance. Document actual
tests and limits; do not imply provider delivery or business lift from fixtures.
