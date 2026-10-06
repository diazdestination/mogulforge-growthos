# Returning-customer work and billing — frozen source contract

October 6, 2026. Owner directly authorized beginning the next wave after PR25.
Base main `bd9df2f2ffc046756759db4703c9c21e744a551e`, tracked tree
`0578b323163d4fe248a0737498baf6f5c45f19ae`; implementation branch
`agent/growthos-returning-customer-20261006`. Root read all three private plans
in `growthos-returning-customer-2026-10-06` before freezing this contract.
Prior releases are complete and must never be replayed.

## Outcome and limits

An accepted, verified human staff member can create a native estimate or job
for an existing canonical customer, optionally at one explicitly chosen property,
without creating an acquisition lead. A saved accepted estimate can become one
native job. Staff can prepare and issue its native invoice, or create a standalone
customer invoice, record external receipts and explicit refund corrections,
reconcile allocations, review invoice email and recover only proven-safe attempts.
The Customer work record, Today, native work/billing pages, value totals and core
export show this work truthfully. There is no new CRM, scheduler or billing ledger.

This is source engineering, not deployment, schema/account/provider activation,
real import/message/call, purchase, payment processing, bank settlement,
subscription cancellation or either contractor's replacement acceptance. No new
reminder is authorized. Existing live staging/restore/mailbox/device/customer
gates stay open. Lead campaigns, estimate e-signature/email, public portals,
cross-job customer credit, accounting sync and financial-import mappings are out.

## Immutable work identity; no historical relinking

Add two tables, inventory **139 to 141**:

- `customer_work_roots`: immutable org, contact, explicit property-or-null,
  creator and creation date. It is lineage only: no duplicate price, schedule,
  status, account, assignee or job. Contact/property/actor tenant FKs and exact
  org/id uniqueness are required. No root mutation/deletion endpoint.
- `customer_work_commands`: retained, transactional human command result with
  org/request uniqueness, actor, closed action, canonical payload fingerprint,
  exact root/native target, saved version and creation date. A committed command,
  root/native write and audit are atomic. It is not an external dispatch ledger.

Estimates, projects, invoices and value entries acquire nullable `customerWorkId`;
only those four old `leadId` NOT NULL constraints are relaxed. Each row has an
explicit, SQL-enforced **exactly one** lead OR returning root. Tenant-root FKs,
indexes and same-root native relationships must fail closed. Existing rows keep
their old lead, old IDs/nulls and unchanged invoice/source/hash/request history;
there is no DML/backfill/adoption. One estimate and one project per root, using
partial unique indexes; a standalone invoice gets its own root and no fake job.
Additional invoices on an explicitly selected job share that job's exact root.
Same customer/property/email/title/date never chooses a root automatically.

New estimates/projects have positive `workVersion`; legacy ones retain null.
Every returning mutation advances it atomically. Source/root is immutable on
edit. Returning accepted estimates are explicit **staff-recorded acceptance**,
not customer signature or proof of delivery. Once converted to a job, their
price/lineage cannot be replaced; native invoices' issued snapshots remain exact.
Retained job estimate linkage cannot be changed or removed by old PATCH/delete
paths. Ordinary property ownership/customer reparent is refused once referenced
by returning work; address edits remain possible and invalidate exact reviews.
Contact display/email edits cannot change root identity or issued documents.
Existing legacy merge/delete/import semantics are not an excuse to move money.

## Staff commands, parent locks and compatibility

Use additive `/customer-work` native estimate/project command routes with strict
request UUID, source union and exact saved version. Initial source is an explicit
customer plus required property field (`null` is a deliberate selection).
Estimate-to-job uses the saved accepted estimate ID/version and retains its root.
Direct customer jobs are included. Native crew/window/capacity checks, staff
notes, job status and scheduling remain canonical. GET-by-ID must independently
load older work beyond list caps; list options are server-scoped and paged.

Keep old estimate/project request shapes and legacy invoice parsed/hash shape
compatible. New returning writes cannot be performed through an old unversioned
PATCH. Native reads expose exact org, nullable lead, root/contact/property,
safe label, source kind and version; no blank lead or guessed customer fallback.
Current effective permission, accepted active verified human membership and
tenant are rechecked in the final transaction and before replay disclosure.
New staff-only writes reject API keys, including empty-key headers. Permissions
remain `crm.write` for work versus `invoices.manage` for billing; one is not the
other. Read-only users cannot reconcile by issuing a mutation.

Lock prefix when participating: customer lifecycle, company contractor schedule,
company invoices, command/reference locks, then exact rows in stable order. Do
not introduce invoice-then-schedule inversions, pooled reentry or network inside
transactions. SHARE locks on actual contact/property/current member/selected
sender rows must persist through native commit or dispatch admission and block
ordinary writers. Relevant current values are compared as well as versions;
same-millisecond timestamps are not semantic equality. Request replay returns
the original committed target, never invokes a second create; changed actor,
payload/action/target conflicts. A lost HTTP acknowledgment remains unresolved
until the exact original request is reconciled, not retried with a new key.

## Invoices and external money

Extend existing invoice input with strict disjoint returning sources: an exact
existing work root/parent, or explicit standalone customer/property. Keep native
invoice operations, versioning, numbering, issue/void/snapshot/hash, noncash
opening cutoffs and legacy normalized financial import unchanged. Complete
only the exact job's existing preparation task; do not erase its staff notes,
owner or deadline. Returning preparation tasks pin actual contact and job, not
a fabricated lead. Work completion/preparation never issues or pays an invoice.

Refactor internal money scope into an explicit lead OR customer-work union.
Legacy lead pools remain lead pools; new work pools cannot mix with them or with
another root for the same customer. Keep complete-read caps and fail-closed
allocation integrity, source-reference org-wide deduplication, over-allocation,
unallocated-refund reconciliation holds and original allocation/reversal history.
Additional invoices on one work root may explicitly allocate a single external
receipt across that work, never across roots. Reversal changes allocation only;
it never claims a cash refund. Display staff-recorded cash, not bank settlement.

Include a narrow issued-invoice **external refund correction** command in the
existing invoice-operation ledger. It records a new append-only refund value
with exact original payment reference, source reference, occurrence time, reason
and explicit invoice allocation in the same transaction. Add nullable
`refundOfValueEntryId` (tenant-safe self-reference) to value entries; legacy refunds
stay null. Returning refunds require their same-root original payment, cumulative
recorded refunds may not exceed that receipt, and invoice allocation may not
exceed that invoice's remaining original-payment allocation. Source/reference or
request changes cannot duplicate cash or bypass an unknown result. An actual
processor refund is not performed. General returning cost-entry UI is deferred;
missing costs are explicitly unknown, not zero-profit evidence.

## Invoice email v3; same permanent effect owner

Implement usable initial / proven-not-dispatched retry / separately acknowledged
additional-copy flows in the **same existing invoice-delivery kernel**. Preserve
literal reviewVersion2 parser/objects/hashes/fixtures and pre-v2 read-only history.
Add strict reviewVersion3 with `leadId:null`, exact work/contact/property,
semantic source fingerprint and sender source literal `company_default`. No
guessed lead/assignee, fake reply-correlation signature or changed v2 snapshot.

Keep `invoice-delivery:<invoiceId>`, original execution, append-only predecessors,
five lifetime attempts total and unknown/reconciled permanent ownership across
versions. Different preview/key/root/mode cannot rearm an uncertain effect. Only
typed trusted pre-provider refusal permits retry; provider text/errors/timeouts
are not machine proof that no dispatch occurred. Copy requires exact accepted
proof, fresh reason and post-preview acknowledgment. Never renumber or pay.

Preview and final post-OAuth pre-POST guard validate exact actor/tenant, current
issued document/version/hash, root/all populated parents/customer/property,
recipient, explicit company-default user/provider/mailbox identity, company
lifecycle/outbound gates, suppressions/DNC/contact reply holds, review expiry,
original attempt/head/receipt. Reader-aware identity helpers must not lazily write
settings or pool-read under locks. No OAuth/network inside the DB transaction.
Ordinary writers must participate through real retained row locks.

Implementation clarification, root-approved after exact source inspection:
v3 requires a stored explicit sender preference plus the selected company-default
settings row, so preference insertion cannot change an implicit provider during
admission. Missing selection is an actionable configuration hold, not guessed
Gmail; existing settings can supply it. Fingerprints include stable connection/
preference identities, not refreshed token bytes or last-used timestamps. Generic
transactional email currently returns before its outreach reply-hold path; v3
therefore explicitly checks the existing reader-aware contact reply hold without
changing v2 or generic transactional/outreach policy.

Trusted adapter acceptance is finalized atomically with audit, contact-linked
activity, original execution and event from **frozen admitted participants**, not
today's post-I/O joins. Late acceptance retains held/reconciled original state;
lost finalization never enables a fresh send. Gmail/Microsoft evidence semantics
stay truthful: Microsoft correlation IDs are not message IDs; accepted is not
inbox delivered. No fabricated lead-specific reply monitoring. Chain readers,
worklist/history/retry/copy must validate all v3 proof participants. No live send.

## Safe projections, acquisition and continuity

Extend validated root/parent branches **before pagination or aggregation** in
customer history, Today, native lists, invoice details and value totals. Same
customer alone is never parent agreement; malformed/foreign roots are withheld
or block financial arithmetic. Customer work record stays exactly nine sections;
Today stays four queues. Financial permission redactions remain exact. Returning
money is included once in labelled staff-recorded business value with a source
breakdown; never inflate leads, won/acquired/recovered cohorts or causal ROI.
Lead-only evidence/ROI/campaign/portal/claim paths remain explicitly unsupported
for returning roots, not enabled by null equality. Nullable-source assistant and
project-growth consumers must not crash or manufacture acquisition attribution.

Core export adds closed work-root lineage in dependency order and safe root
references on native records/values. Same-root links must be validated; preserve
issued original digest versus separate redacted-projection digest. Exclude raw
command hashes/actor internals, sender/review/dispatch capabilities. All 141
tables are explicitly classified and restored, including command and uncertain
delivery ownership. Existing financial-import v1 remains literally compatible.

## Experience and unknown acknowledgment

Use existing Customer/Estimates/Jobs/Invoices/Today/value surfaces. Explicit
source choice: opportunity or existing customer; explicit property or no property.
Changing source/customer clears dependent options. Edit cannot change lineage.
Customer cards link to exact native records and offer permission-gated creation;
closed company-pinned URLs preserve safe login intent, never arbitrary redirects.
No `/leads/null`, no first-page-only exact record lookup, no no-lead lead advance.

Semantic member/company/role/active/error and target fences apply to reads,
mutations and late callbacks. Ordinary profile polling preserves dirty fields;
real authority change removes old visible state and ignores late results. Store
only explicitly submitted recovery requests in existing private tab-scoped
storage, never auto-replay on mount. Synchronously prevent double submit. Unknown
outcome locks new work/keys and offers exact-original reconciliation. Permission
loss is not no-effect proof. Distinct draft/issued/email-accepted/external-receipt
facts; staff acceptance/refund wording and missing-cost labels remain honest.

## Coordinated ownership

- Runtime `/root/callie_runtime`: customer-work schema + four native schema
  changes, lineage/command pure contracts and kernel/router; CRM native
  guards/list/GET/labels, contractor-scheduling task kernel; invoices/contract
  and returning refund route; focused domain/HTTP and independent PG tests.
  Do not edit delivery, root projections/export/spec, frontend or shared docs.
- Delivery `/root/callie_experience`: invoice-delivery service/contract/attempt
  kernel, narrow customer-email/user-email identity helpers and their tests;
  v3 source/unknown/actual-PG race evidence. Do not edit invoices/CRM/schema or
  root projections. Request exact runtime helper interfaces before relying on
  them. Root and runtime independently review this lane's actual changes.
- Experience `/root/appointment_experience`: existing work/billing/customer/
  Today/value UI and closed navigation, shared explicit source selector,
  recovery/member fences and focused UI tests. No backend/schema/generated/Git.
- Root: schema index/router mount, customer workspace/Today contracts and
  projections, revenue aggregation/projections/null consumers, core export,
  inventory, OpenAPI/generated clients, schema/recovery scripts and evidence,
  integration/docs/source review/Git/CI/release. No shared-file concurrent writes.

All lanes read this contract and confirm exact ownership before product edits.
Report mismatches or real scope/lock obstacles before silently changing design.
Any materially different contract is an explicit recorded root amendment.

## Review clarification: existing history retention

Root-approved narrow review closure also protects legacy invoice/value history:
refuse job estimate replacement/removal, lead property change, lead merge or
property ownership reparent when the original affected source retains invoices
or cash. Address/display edits remain possible; no money is moved or relinked.
The general legacy value writer uses the same lifecycle/schedule/invoice/reference
prefix and retains original lead/contact/property SHARE locks. Runtime additionally
owns a sorted coherent legacy-parent SHARE pass in financial-migration commit,
strictly a retention lock: its literal v1 context digest, payload, source hashes,
mapping, cutoff/noncash semantics and original evidence remain unchanged. Test
ordinary concurrent writers and retained-history responses, not broad behavior
rewrites. No new tables or import/customer authority are added by this closure.

## Acceptance and release

Actual service/HTTP/generated JSON proof: zero-lead customer, two properties and
distinct jobs/standalone invoice, explicit null property, complete quote → staff
accept → job → invoice → issue → partial/full receipt/refund/reversal journey;
one native project/root, original request replay, current/effective-role denial,
cross-company/mixed/null/version/retained-parent failures and legacy behavior.
Financial tests cover distinct-root cash, split allocation within one root,
source-reference/cumulative-refund caps, malformed allocations and noncash cutoffs.
v3 mocked Gmail/Microsoft initial/refusal-retry/copy/cap/expiry/unknown/lost-write/
late-acceptance and literal v2 regressions are required, without real provider use.

Real PostgreSQL16 independent-PID/writer barriers must observe ordinary
contact/property/membership/native-estimate/draft/sender writers blocking or
being reread/refused at retained locks; competing conversion/numbering/money/
delivery commands preserve one canonical result/effect. Preserve all prior
workday/appointment/service/reception/invoice race tests; no new skipped barrier.
141-table fresh schema plus compatible 139→141 offline recovery, SQL negative
constraints, no provider calls and preserved legacy/unknown/request ownership.

Focused and full UI/type/build/domain/API/export tests, built 320/390/desktop
fictional no-lead and legacy journeys with later-page property and old exact
records, no overflow, preserved polling drafts, unknown-request recovery and
correct customer return links. No test weakens assertions/provider guards.
Source review must include delivery independent review and complete raw proof.
One actual changed-head candidate PostgreSQL16 CI, exact reviewed-head merge,
safe main sync, accepted tracked-tree equality and one explicit `ci.yml` main
dispatch (push does not trigger it), then complete exact-main green gate. No
blind reruns or duplicate active run. Root saves precise hashes/identities/counts
and remaining live/customer gates to private receipt and Jarvis STATE. A source
pass is not paid-beta launch or Housecall Pro replacement acceptance.
