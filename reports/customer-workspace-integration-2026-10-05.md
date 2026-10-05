# L7 canonical customer workspace — integration

October 5, 2026. Resumed after the owner reset usage. Base release: PR21,
main `d4b8c0a7b88c0f6a617bc7d4e3d82fd7d537101d`, exact-main CI37154526789.
Contract: `customer-workspace-contract-2026-10-03.md`.

## What this slice delivers

The existing Customers & Jobs area now opens a canonical customer work record.
One selected section loads at a time: visits, service/equipment, properties,
opportunities, jobs, estimates, invoices, tasks or safe event history. Sections
page at 25 records in creation order. Identity, company, contact restrictions,
actual dates, responsible staff and explicit unlinked properties are visible.
Service-only customers do not need a manufactured sales opportunity.

Contacts, lead detail, Today and Service Desk expose customer links. Visits use
an exact read outside the schedule's current range; the selected summary does not
substitute another row or reconstruct private notes. "Show this day in schedule"
moves the original schedule, where its existing full-record editor remains the
only edit path. Service and task links retain their existing workflows. Job and
estimate cards say "Open related opportunity"; they do not pretend the older
first-page highlight mechanism is a reliable exact destination.

New service creation has an explicit, paged customer-property picker. It defaults
to "No property linked", including when only one address exists. Customer/access
changes reset it; failed loads are not presented as an empty address list. Parent
customer and selected property rows are share-locked until task/service creation
commits. A later property edit is still possible; it does not rewrite history.

## Data and authority boundaries

Three new GET routes: customer header, customer section and exact appointment.
Accepted active verified staff sessions only; even an empty API-key header is
rejected before resolution. Current membership is reread, effective role cannot
elevate it, company is never accepted from query input, and invoice visibility
needs its separate permission. Query fields/UUIDs/cursors are strictly validated;
responses are no-store/no-referrer and unknown failures are opaque.

The read model uses repeatable-read, read-only transactions. Every populated
tenant/customer/property/lead/project/estimate/appointment/task relationship is
checked before pagination. Invalid parents are withheld, not made null or joined
by name/email/phone. Service ancestry must reach a coherent root within 256
occurrences; cyclic, conflicting or longer chains are not silently repaired.
Cursors preserve PostgreSQL microseconds and include company/customer/section.
Current-record browsing is not a frozen export or next-visit ranking.

No financial aggregates, document bodies, raw activity titles/body/metadata,
mailbox contents, private URLs or provider credentials enter these DTOs. History
uses fixed labels and a finite type allowlist, with unauthorized invoice events
filtered before the page limit. Company outbound holds do not prevent authorized
history reading. No GET creates settings, audit, jobs, enrollment or sends.

Semantic member/company/customer keys fence UI caches and late responses.
Unchanged profile polling preserves the current page and new-service draft;
changed authority or profile errors fail closed. Valid pinned customer/visit
links survive sign-in without arbitrary return URLs or local private-data storage.

## Verification and reproducibility

- Runtime plus HTTP and existing read regressions: 38 passed, no skips across six
  isolated database-backed suites. See `customer-workspace-runtime-2026-10-05.md`.
- Separate route inventory/service creation selection: 18 passed; two new
  independent-backend PostgreSQL writer tests intentionally skipped by PGlite.
  The actual CRM property writer must wait for creation; a prior reassignment
  must be rechecked after waiting and create no service/task for the old customer.
- Full Command Center suite: 775 passed after the final calendar-date regression;
  the existing accessibility test now waits for the real Schedule control after
  profile admission. Its nonempty/control-name assertions were not relaxed.
- Full scripts suite: 229 passed; reusable website adapter checks: 26 passed.
  Workspace types, Command Center build and API
  build passed. Existing pnpm configuration and large-bundle warnings are not
  counted as failures or silently claimed fixed.
- Compatible synthetic upgrade/restore: 90 to 130 tables, equal source/restored
  fingerprints, 47 SELECT-only real-app checks, providerCalls=0. Added service-only
  customer history, 27-property paging, exact old-range visits and foreign-company
  negatives. The existing fixture outbound-inertness guard remains unchanged;
  the added recovery service rows are completed, not granted send exceptions.
- Attempting the entire API suite on the lightweight PGlite runner timed out in
  existing automation-DNC tests; that diagnostic run was stopped, not reported
  as a pass. Full API and independent-backend acceptance belongs to PostgreSQL CI.

Browser QA uses built assets and:

```text
node artifacts/api-server/scripts/preview-runtime-isolated.mjs --customer-workspace
```

It creates a fresh fictional loopback database with no inherited provider keys,
outbound held, contacts DNC, and scheduler disabled. Desktop browser checks proved
the pinned customer sign-in path, 25+3 visit paging, an exact June2028 appointment
outside October2026 filters, native-day handoff, service-only history, linked and
unlinked properties, and canonical Service Desk navigation. This is not real-phone,
  customer-data or production proof. The isolated helper's fixture login is not an
account for deployment. No hosted database was opened.

Projection: `node scripts/customer-workspace-api-spec.mjs`, then
`pnpm --filter @workspace/api-spec run codegen`. The script preserves the existing
appointment PATCH operation. `lib/api-zod/src/index.ts` disambiguates Orval's
path-validator/query-type name collision. Whitespace-normalize generated output
without changing its behavior. Do not edit generated contracts by hand.

## Release and remaining work

Candidate and merged-main exact SHA, CI URL and final totals must be recorded in
the release receipt before declaring this source slice finished. The CI workflow
requires an explicit main dispatch; a branch push alone does not run it. The
private coordinated handoff is `C:/Users/diazd/dev/jarvis/handoffs/growthos-customer-workspace-2026-10-05`.

No new schema: source remains 130 tables; reviewed0014 hash and older hosted
attestations are unchanged. No deployment, provider/mailbox activation, customer
messages, real imports, credential changes, spending or contractor payments.
This slice does not close L7 equipment/checklist/repeat-job requirements, L8 actual
source migration, remaining L1/L4/campaign capabilities or either contractor's
replacement card. Follow the fixed launch checklist and obtain concrete workflow
acceptance; do not call the product flawless or recommend incumbent cancellation.
