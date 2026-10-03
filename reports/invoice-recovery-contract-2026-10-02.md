# Invoice delivery recovery: second authorized wave

Authorized implementation, October 2, 2026. PR17 is merged at
51da543db898f9907a4198fbc0ada880c378900d with an identical tree to the green
84cd928 candidate, CI37089194639. Main CI37090103299 also passed.
Active branch: agent/growthos-invoice-recovery-20261002. A main failure pauses
adoption; no hosted or live activation is included.

One append-only invoice_delivery_attempts table, at most five lifetime attempts
including any historical fixed-key invoice delivery. Initial key remains
invoice-delivery:<id>; successors use immutable server ordinals and one-successor
predecessor keys. No resets, deletion, rewritten receipts or invented legacy proof.

Invoice-specific kernel atomically claims attempt, revenue execution and event;
provider call occurs outside that transaction. Finalization CAS atomically records
the actual typed outcome, event, receipt and accepted activity/audit. Unknown
effect/finalization failures remain permanently held. Generic durable action
semantics do not change.

Safe retry needs an exact typed server no-dispatch proof plus matching terminal
blocked receipt. Additional copy needs exact provider acceptance plus succeeded
receipt, a new actor-bound current preview, reason, and post-preview duplicate
acknowledgement. The message is clearly a COPY of the original invoice, not a new
bill, balance statement, charge or payment. Reconciliation alone is never proof.
Legacy first receipts remain virtual ordinal one with their retained evidence.
Source review found old previews stored hashes but no frozen participant/sender
context. Those old-format receipts therefore remain read-only: even recorded
acceptance cannot authorize a new copy key. Do not reconstruct old authorization
from today's customer or mailbox. Modern v2 context-bound acceptance supports
copies. Older blocked text is not proof. Invalid, orphaned, missing or
contradictory chain links fail closed.

Final dispatch checks exact latest head, receipt actor/hash/state/expiry, current
accepted manager, lifecycle/holds, immutable invoice version/document, recipient,
source/contact/assignment and selected mailbox after OAuth. Preserve existing
transactional invoice eligibility, not marketing adoption or universal lead hold.

Use the existing Invoices workspace, canonical links, read-only bounded invoice
pages and kernel-derived attempt status/next review modes. Do not represent a
page-local list as globally filtered exception counts; that filter is not in this
slice. Distinguish accepted from delivered. No mailbox read/bounce monitoring,
payment collection, blanket policy, scheduling or automatic resends.

Ownership when greenlit:
- review_contractor_workday: new attempt schema/kernel/tests; narrow exact-FK
  parent uniques in revenue schema/audit schema and schema export.
- review_identity_and_comms: invoice-delivery service/contract/tests, real-adapter
  synthetic integration, accepted-staff/final dispatch and preview invalidation.
- review_financial_controls: worklist service/tests, invoice routes/HTTP tests,
  existing invoice UI and bounded worklist/attempt review/history. Delivery-only
  stricter cookie Origin/session guard; other CRUD compatibility preserved.
- root: OpenAPI/generated clients, inventory/export, offline delta0011 and
  compatible restore/tenant negatives, local visual fixture/browser, complete
  release checks/PR/main integration and checkpoint.

No agent commits shared partial work. Preserve unrelated pnpm-workspace.yaml.bak.
Provider-free local fixtures only; full PostgreSQL races belong to exact CI. No
deployment/hosted migration/credentials/providers/live message/DNS/spend/cutover.
Payment collection stays deferred; both complete contractor cards still gate
real onboarding. Azure first-login and held-staging/admin rotation remain owner
return/separate approval items.
