# L7 customer work record — frozen implementation contract

October 3, 2026. Owner requested the next wave after PR21/main
`d4b8c0a7b88c0f6a617bc7d4e3d82fd7d537101d` and exact-main CI37154526789 passed.
This is the bounded customer-history/navigation part of the fixed launch list,
not full L7, contractor replacement acceptance, deployment or provider activation.

## Outcome and scope

Give office/field staff one customer work record at `/contacts/:id`, over existing
canonical records. A service-only customer needs no opportunity. Existing
identity, editing, scheduling, service completion, estimate, job, invoice and
communication workflows remain the owners of mutations. No duplicate customer,
synthetic acquisition lead, new business table, historical reassignment or
inferred equipment/warranty fact is introduced.

The page has a contact header and one lazy paged section at a time, not a new
dashboard of partial totals. Sections are exactly `properties`, `appointments`,
`services`, `leads`, `projects`, `estimates`, `invoices`, `tasks`, `activity`.
Default view is Appointments. Labels can say Visits, Jobs and History while the
API retains these canonical identifiers. No financial aggregate or calculated
balance is added. Authorized invoice rows lead to the existing invoice details.

## Read API and authority

- `GET /contacts/:id/workspace`: header; no query selectors.
- `GET /contacts/:id/workspace/:section`: exact section; only optional `cursor`.
- `GET /appointments/:id`: exact read-only appointment detail, including a visit
  outside the current schedule range. No query selectors.

All three use authenticated accepted active verified staff sessions and current
`crm.read`, rejecting even an empty API-key header before key resolution/writes.
Current company comes only from membership. No client organization override,
cross-company switching, default-tenant fallback or arbitrary return URL.
Invoice reads separately intersect current `invoices.read` authority; unauthorized
section requests return 403 without rows/counts. Each service read rechecks actor
membership/role in a read-only transaction. Reads never create settings, audit
events, work, admissions, projections or provider effects. Company sending holds
do not prevent appropriately authorized review of existing records.

`customer-workspace-contract.ts` is the closed Zod/TypeScript source of truth for
the DTOs. Runtime publishes it before other lanes depend on generated types.
Exports: `getCustomerWorkspace(org,userId,contactId,effectiveRole?)`,
`getCustomerWorkspaceSection(org,userId,contactId,{section,cursor?},effectiveRole?)`,
`getCustomerWorkspaceAppointment(org,userId,appointmentId,effectiveRole?)`.

Header: exact company and contact identity, existing preferred channel/DNC flags,
created/updated times, `canWrite` and `canReadInvoices`, available section IDs.
It grants no consent and does not report a person as contactable from a missing
suppression flag. No counts or invented combined customer identity.

Section envelope: `organizationId`, `contactId`, `section`,
`order: 'created_desc'`, `limit: 25`, strictly typed `items`, `nextCursor`, `hasMore`.
Fixed-size lookahead fetches 26. Opaque bounded cursor includes version, company,
customer, section, raw PostgreSQL created timestamp and UUID tie-breaker. Preserve
microsecond precision; no JavaScript-date cursor roundtrip. Unknown/repeated
selectors, malformed cursor/IDs and foreign-context cursors fail closed. This is
current record browsing in creation order, not a frozen export or chronological
"next visit" claim. Refresh starts a new page chain; date/time fields are shown
separately. Query predicates validate relationships BEFORE limit/keyset paging.

Rows are a discriminated union with `kind` as the singular canonical record kind,
`id` and `createdAt`, plus an explicit minimal allowlist:

- property: address fields and property type;
- lead: state, urgency, service type, coherent property and staff owner;
- appointment: type/state/start/end/updatedAt, resolved customer ID, lead ID,
  coherent property and owner; no notes. Reuse for exact detail;
- service: `serviceKind`, equipment label, state/due/completion, recorded coverage
  dates and recurrence index, validated predecessor/task/appointment IDs and
  coherent property/owner; no agreement/source/private notes;
- project: name/state/schedule/completion, validated lead/estimate and property;
- estimate: title/state, validated lead and property; no monetary projection;
- invoice: number/title/state/issued time, validated lead/project/estimate/property;
  no line items, balances, documents, sender or provider data;
- task: title/state/priority/due/completion, validated lead and staff owner;
- activity: closed known category, constant safe headline/time and verified lead;
  never original title/body/type/metadata or arbitrary URLs. Unknown types are
  omitted. Unauthorized financial event categories are omitted before paging.

## Relationship and privacy invariants

Require every relevant row and populated parent to be in the same company and
coherent with the same canonical customer. ID-only historical FKs are not proof.
Check optional property/lead/project/estimate/appointment/task chains, including
service predecessor coherence. Reject invalid populated relationships; do not
reinterpret them as unlinked or guess an owner from shared names/email/phones.
An actually null property remains visibly "No property linked". Same-address
people remain separate customers. An exact unlinked appointment may be read
within its company but is never adopted into a customer history.

Staff display names expose no email/credentials and only resolve within the same
company. No raw message content, private object URL, approval/provider metadata,
external document or acquisition attribution is copied into this read model.
All monetary, delivery and booked/completed states remain the existing facts,
not inferred success from a reply, email acceptance or recorded activity.

## Navigation and companion changes

- Contacts and lead detail link to the exact customer record with a pinned
  `organizationId`. Validate optional company/section URL context before fetching.
- Exact native destinations: lead `/leads/:id`; invoice `/invoices/:id`; task
  `/tasks?taskId=:id`; service
  `/service?serviceObligationId=:id&organizationId=:org`.
- Add real appointment selection at
  `/appointments?appointmentId=:id&organizationId=:org`: independent exact lookup,
  read-only selected card, existing editing only after an explicit action.
  Missing/foreign/malformed targets remain visibly unavailable, never a list
  fallback that appears to have opened the requested visit. Appointment mutation
  payloads/notes must not be reconstructed from a redacted detail DTO.
- Estimates/projects currently only highlight inside a fetched first page; use
  a truthful **Open related opportunity** link instead of promising an exact
  older-document opening. Property rows display their address here; a general
  directory link is labelled as such, not an exact property destination.
- Today services open their exact service records; appointments open their exact
  selected cards. Separate customer links use canonical contact IDs and do not
  replace the primary work action or create nested anchors.
- New service creation gains an explicit paged customer-property selector using
  the authorized properties section. Default is No property linked, even for a
  single property. Changed contact/company/role/session resets selection and
  aborts/ignores stale pages. Loading/failure is not "no properties". Only a
  currently eligible loaded ID can be submitted. Historical null property links
  are not edited or auto-filled. Server verifies and share-locks the selected
  customer/property through creation; later property moves never rewrite history.
- Existing login return behavior may preserve strictly parsed customer and
  appointment deep links, not arbitrary redirects or implicit company switching.

UI query identity includes semantic current membership (user, company, role,
active state) and customer/section. Reject scope-mismatched responses, profile
errors, late responses and stale cursors. Do not reset valid drafts on unchanged
poll timestamps. Accessible loading/error/empty/load-more/back/reload behavior
and narrow-phone layout are part of the feature, not optional polish.

## Ownership

- Runtime agent: new service/contract and read-model tests, exact appointment read.
- Experience agent: customer page/components/tests, App/login return, Contacts and
  lead-detail customer links. No Today/Service Desk/Appointments edits.
- Companion agent: Service Desk property selector, Today and Appointments exact
  destination UI/tests. Coordinate DTO first; no App router or API/spec edits.
- Root: HTTP/route inventory/OpenAPI/codegen, narrow service-creation row locks
  and backend regression, isolated preview/restore probes, integration review,
  documentation, source release checks and durable checkpoint.

All use the shared `agent/growthos-customer-workspace-20261003` branch and preserve
unrelated `pnpm-workspace.yaml.bak`. Agents do not commit/push or touch providers.

## Acceptance and stop line

Prove two-company and malformed-parent exclusion, same-name/address separation,
service-only customers, multiple properties, null links, old records beyond the
first page and same-timestamp cursor ties. Verify role changes and invoice
restrictions, SELECT-only reads, strict HTTP/session/context handling, exact links
outside normal date/page ranges and stale UI response rejection. Creation needs
a real PostgreSQL independent-writer barrier for selected-property coherence.

Run focused regressions, full UI/scripts, types/builds, browser desktop/phone
checks, compatible synthetic recovery and exact candidate/main CI. No new schema
is expected; source remains 130 tables. No schema/provider/hosted/secret/DNS
change, customer import/contact, spending, payment processing or subscription
cancellation. Actual equipment/checklist/workday requirements, repeat billable
job semantics, source-specific migration and all existing launch/company gates
remain explicit. This bounded projection does not declare either contractor ready.
