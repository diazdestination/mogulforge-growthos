# Native contractor invoices — implementation and acceptance

Date: October 1, 2026. Candidate branch: `agent/growthos-native-contractor-day`.
Scope: local source and synthetic acceptance. This is a staff-operated invoice
document and recorded-receipt workflow. No provider sends, charges, refunds,
account changes, deployments or changes to the agreed $500 beta were performed.

## Discovery and design

Existing estimates are editable CRM records; they cannot be the immutable
authority for an issued invoice. Projects already link to estimates/leads.
GrowthOS subscription billing is separate from contractor customer invoices.
Existing `value_entries` is the canonical staff-recorded cash ledger, with
organization/source-reference uniqueness. It has payment and refund records,
but no original-payment reference on a refund. Consequently this implementation
allocates canonical entries instead of copying them into a second cash ledger.

The generic HTTP idempotency helper does not bind a durable request fingerprint
to the business effect in one transaction. Invoice operations therefore have a
dedicated ledger committed with their state change. This permits an identical
request to return the saved invoice after an uncertain response or application
restart, while changed input using that identity is rejected.

### Owned source

- `lib/db/src/schema/invoices.ts`: invoice documents, company numbering,
  durable operations and append-only receipt allocations/reversals.
- `artifacts/api-server/src/services/invoice-contract.ts`: strict input and
  response contracts, bounded cents and exact quantity arithmetic.
- `artifacts/api-server/src/services/invoices.ts`: transactions, authorization,
  relationships, document transitions and reconciliation.
- `artifacts/api-server/src/routes/v1/invoices.ts`: nine HTTP routes and
  session/JSON/origin/error boundaries.
- Matching new service and route test files.

Root owns shared permissions, router/inventory, OpenAPI/generated clients,
migration/export/recovery and CRM retained-reference guards. Scheduling owns the
shared project lock and preparation-task producer. The UI lane owns invoice
pages and navigation. Their acceptance is recorded separately.

## Document lifecycle

1. An authorized staff member creates or edits a draft. A draft has no invoice
   number and does not assert an amount is due.
2. Issue requires explicit confirmation and the current version. A transaction
   allocates a unique company sequence number, freezes the document and its
   SHA-256 digest, and writes audit/activity/operation evidence. Issue does not
   mean sent. Later contact, estimate or draft edits cannot rewrite this copy.
3. Issued documents cannot be edited. Void retains the number, copy, reason and
   history. It requires zero net allocated receipts and does not refund money.
4. Numbers are never reused through the service. A corrupt/colliding sequence
   fails closed with no consumed number, partial audit or document transition.

USD is explicit. Amounts are integer cents. Quantities are positive decimal
strings with up to six whole digits and three decimal places. BigInt fixed-point
arithmetic rounds each extended line half-up to cents. Tax is an explicitly
entered amount; no tax calculation or legal sufficiency is claimed. Maximum
100 lines and total 1,000,000,000 cents; issue needs at least one line and a
positive total. The server rejects client-supplied totals and server fields.

## Recorded receipt and reconciliation semantics

- Record payment creates one canonical `value_entries` payment and one invoice
  allocation atomically. It records staff evidence; it does not charge a card
  or independently confirm bank settlement.
- An existing payment can be allocated without creating a new receipt. Partial
  allocations can span invoices on the same lead, bounded by both available
  source amount and invoice balance.
- Existing refund entries can be explicitly allocated, bounded by the invoice's
  net recorded receipts. The service does not create or execute cash refunds.
- Removing an allocation appends a full reversal with a reason. The original
  receipt/refund remains in the canonical ledger. This is an allocation
  correction and must never be labeled a cash refund in the UI.
- Any unallocated canonical refund on the same lead marks affected invoice
  reads `reconciliation_required`; an issued invoice's `balanceDueCents` becomes
  null. This conservatively avoids certifying a paid balance when the refund's
  invoice is unknown. Explicit allocation resolves that uncertainty; reversing
  its allocation restores the hold.
- Current receipts, original allocations and reversal relationships are checked
  together. Mismatched company/lead ownership, over-allocation and changed issued
  snapshots fail closed. Both incorrectly owned allocations and a receipt
  assigned to an unrelated invoice are checked, without returning foreign data.

Read arithmetic uses repeatable-read transactions. Totals are never silently
truncated: more than 2,000 payment/refund entries per lead, 4,000 related
allocation rows, or 4,000 invoice operations fails closed for operator review.
The available-entry picker returns at most 50 entries and explicitly signals
truncation. A full receipt-search surface is future work for very large histories.

## Authorization, concurrency and handoff

- Read roles: owner/admin/office/sales_manager. Manage roles:
  owner/admin/office. The service rechecks active membership and role for direct
  calls and retries, using the authenticated company and staff identity.
- All mutations require a staff session. API-key mutation requests are rejected
  before key resolution or usage mutations. Strict JSON, supplied Origin and
  Fetch Metadata are enforced. Same-origin clients and existing session clients
  without an Origin header are supported. Tenant overrides and unknown fields
  are rejected. Responses are non-cacheable; internal failures return a bounded
  retry instruction without raw SQL/provider details.
- One transaction holds a company invoice advisory lock, current actor share
  lock and invoice row lock; expected-version checks protect against stale
  actions. Completed request fingerprints have a company-wide unique key.
- A manual receipt also acquires the existing canonical value-entry reference
  lock. Reusing a cash source reference directs staff to allocate that record.
- Transactions set a 3-second lock timeout, 10-second statement timeout and
  15-second idle transaction timeout. No provider calls occur under these locks.
- Every draft creation first acquires the shared scheduling lock, then invoice
  locks. This includes lead-only and estimate-only drafts, to serialize against
  CRM merge/delete retention checks. Project-linked creation completes only the exact same-company,
  same-lead `project.invoice_preparation:<projectId>` task. Failure rolls back
  the invoice, audit/activity, operation and task completion together.
- Scheduling completion uses that same lock and omits preparation when a
  non-void project invoice already exists. Any invoice, including draft/void,
  must retain its CRM references; root owns merge/delete guards and tests.

## Verification

Guarded command from `artifacts/api-server`:

```text
node scripts/test-scheduler-isolated.mjs src/services/invoices.test.ts src/routes/v1/invoices.test.ts
```

The runner creates a disposable PGlite database on a random loopback port, uses
fresh schema, excludes provider configuration and runs one test worker.
Final selection, including corruption hardening:
**20 passed, 3 PostgreSQL-only skipped (23 total)**.

Covered behavior: exact arithmetic/input limits, immutable issue/numbering,
request replay and changed-request conflicts, version conflicts, no automatic
cash/sent evidence, counter rollback, partial receipts and payment rollback,
existing-receipt reuse, refund holds and allocation reversals, cross-invoice
limits, direct and HTTP role rechecks, cross-tenant IDs/references, strict request
boundaries, sanitized retry failures and atomic project preparation rollback.

Three tests intentionally require PostgreSQL independent sessions: concurrent
issue retries and numbering; concurrent project completion/draft creation; and
concurrent allocation of the same receipt to different invoices. PGlite cannot
establish those exclusion guarantees. They remain required in CI.

An initial deliberately forced unique-constraint error disrupted PGlite's socket
protocol and caused unrelated failures. A production-useful collision check now
detects a broken sequence inside the transaction before the constraint error;
the database unique constraint remains. The counter rollback test still performs
and verifies rollback after the increment. No failing assertion was suppressed.

API typecheck after this lane's fixes had no invoice errors; the final observed
errors were unknown JSON response types in the concurrent scheduling HTTP test
lane, reported to its owner. Full integration,
actual PostgreSQL CI, migration/recovery and UI/browser acceptance are root's
remaining release evidence. Local success does not establish production readiness.

## Deliberate external and product limits

No customer delivery, hosted payment link, processor settlement, real charge,
automatic cash refund, tax service, recurring invoice schedule, accounting
integration, PDF/email pipeline or legal invoice compliance is asserted here.
The native UI supports reviewing and issuing a preserved internal document and
recording receipts. Public/provider activation and real customer financial
operations retain their separate approval and proof boundaries.
