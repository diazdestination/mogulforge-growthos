# Reviewed historical financial migration — October 2, 2026

Local engineering under `operations-wave-contract-2026-10-02.md`. This is not
permission to import either contractor's actual records, modify hosted schema,
send invoices, move money, change subscriptions or cancel the previous system.
No actual Housecall Pro export or accounting reconciliation has been accepted.

## Implemented workflow

The owner/admin page `/financial-migrations` accepts a bounded **normalized JSON
version 1** source, not arbitrary vendor CSVs or PDFs. Staff load the file, inspect
exceptions, then review every original invoice/document, mapped customer, exact
receipt evidence/allocation and control total. Two explicit confirmations cover
the exact financial review and frozen cutoff/one-writer agreement. Approval sends
only the server's digest and review ID. It does not create leads, consent,
acquisition events, outbound communications, charges or settlement evidence.

An invalid source returns visible path/message exceptions and is uncommittable;
the system does not silently skip unsupported rows. Maximum: 50 invoices, 200
receipts, 100 lines/invoice, 512,000 source bytes. The dedicated HTTP envelope cap
is 1 MiB, coordinated in `app.ts`, and does not broaden other routes.

### Supported financial bases

- **Full history:** original immutable source document/number/issuance date and
  separately evidenced, dated payment/refund transactions. A receipt may cover
  several included invoices on the same existing opportunity, but its entire
  amount must be allocated exactly once. Historical receipts are staff-attested
  source evidence, not bank-verified cash or newly recovered GrowthOS revenue.
- **Opening receivable:** original complete invoice document plus outstanding
  amount as of the cutoff. It creates **zero** `value_entries`. Original total
  minus opening balance is never called a payment. Native balances begin at the
  opening receivable, and only evidenced post-cutoff receipts/refunds can be
  allocated. Refund allocation cannot exceed known later net receipts. Prior
  receipts remain unknown. The invoice page shows the basis and cutoff explicitly.

These modes cannot be mixed for one source invoice. The importer does not infer
tax, discounts, credits, write-offs, gross overpayments, unapplied cash, cross-job
shared-payment splits, ambiguous dates, missing source identity or customer/job
relationships. Those need an approved expanded contract after inspecting the
actual export. A complete original document is required even for opening mode;
a balance-only CSV is not sufficient and is not turned into a replacement invoice.

## Contract and data

Authoritative input: `services/financial-migration-contract.ts`.
Synthetic examples only: `src/test-helpers/financial-migration-fixture.ts`.

Source fields: format/version; stable lowercase source-system and source-account
keys; cutoff timestamp with timezone; invoices; receipts; control totals. Each
invoice has stable external ID, original invoice number and issue timestamp,
existing native opportunity ID, basis, source balance and complete document with
declared line/subtotal/tax/total cents. Each receipt has an external transaction
ID, opportunity, payment/refund kind, positive cents, original timestamp,
reviewable evidence and exact invoice allocations. No arbitrary destination URL,
sender, account credential, guessed vendor column mapping or payment link exists.

Two tables:

- `financial_migration_reviews`: actor-bound normalized review, raw-input hash,
  exact approval/context digests, expiry, state and immutable commit result.
- `financial_migration_items`: durable source identity and normalized digest,
  pointing to the retained native invoice or value entry. Unique identity is
  company + source system + source account + entity type + external ID.

Invoice fields are additive: `balance_basis` (default `full_history`), nullable
`opening_receivable_cents`/`opening_as_of`, and closed historical-source JSON.
Composite tenant foreign keys protect review actor and item review/invoice/value
targets. Referenced org/ID pairs use UNIQUE constraints, not separately created
indexes, so schema creation can install the foreign keys in order.

Routes, under `/api/v1`, all require active, verified, accepted owner/admin:

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/financial-migrations` | Current actor's 30 most recent reviews |
| POST | `/financial-migrations/preview` | `{sourceJson}` → exceptions or exact review |
| GET | `/financial-migrations/:id` | Actor-owned saved review/status |
| POST | `/financial-migrations/:id/commit` | `{expectedDigest, confirmed:true, sourceFrozen:true}` |

Reads are no-store and do not acquire row write locks, preserving SELECT-only
recovery operation. All requests reject API keys and company/query overrides.
Mutations require JSON and trusted Origin, or a syntactically valid Bearer session
that ordinary authentication still validates; Basic/ambient-cookie bypass is
rejected. Direct service calls repeat accepted-owner/admin checks. Another tenant
or another review actor cannot inspect or commit the review.

## Transaction, identity and reconciliation

- Preview does not create invoices/cash. Thirty-minute approval binds raw input,
  normalized source, company, actor and current mapped customer/opportunity
  versions. Date-valued versions are explicitly serialized into the digest.
- Commit uses global lock order **lifecycle → schedule → invoice → staff/rows**,
  matching service-watch and native invoice operations. Existing company holds,
  active accepted membership, mappings, source identities, numbers and digests
  are rechecked. Transaction timeouts and fixed row limits remain bounded.
- The dedicated historical transaction never calls native issue to fabricate a
  new number/date. It hashes the database-round-tripped original JSONB snapshot,
  preserving the same integrity contract on PGlite and PostgreSQL.
- Original invoice-number collisions are exceptions. Imported `INV-…` numbers
  advance the shared native sequence under the same lock; numbers are not reused
  or renamed and cannot exhaust the supported sequence range silently.
- Same source identity/content deduplicates across row order, file formatting,
  new reviews and lost HTTP acknowledgments. Changed source content or another
  allocation set for an existing receipt conflicts. A new review cannot overwrite
  later local receipts, reversals or void history. New historical cash against an
  already imported invoice requires a separately reconciled delta, not reimport.
- All invoice, receipt, allocation, identity and audit changes commit together.
  Final saved balances must exactly equal source control balances, with no
  unresolved refund. A failed final reconciliation rolls everything back,
  including numbering and audit. No transaction calls a provider.
- Post-commit correction uses retained native financial operations. Allocation
  reversal does not create a cash refund. There is no delete-import/reset-history
  action. Restoring an older database after subsequent work is a separate
  recovery decision, not a migration button.
- A lost commit acknowledgment disables new approval/preview until staff check
  the same saved review. A second request cannot duplicate source identity.

Core export (coordinator-owned) includes opening basis, historical provenance and
source-to-invoice/value mappings. It excludes private review payloads/approvals;
therefore it remains a bounded core export, not a full financial database restore.
Raw source files are not retained by this flow; their hash and normalized reviewed
payload are. Actual archival, retention, wider export and document requirements
must be approved separately for each company.

## Verified local evidence

Guarded fresh in-memory database, provider credentials excluded:

```
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/financial-migration-contract.test.ts src/services/financial-migration.test.ts src/routes/v1/financial-migration.test.ts src/services/invoices.test.ts
```

**36 passed / 5 skipped** across four files. Five skips are independent-session
PostgreSQL concurrency checks (three existing native tests, two new migration
tests); they remain required in CI. New coverage includes exact historical
documents/dates, non-cash opening balances, cutoff/refund constraints, shared
receipts, reordered duplicates, immutable corrections, stale dates/mappings,
expired/wrong approvals, owner/admin/accepted-user/tenant checks, DB tenant FKs,
native numbering and rollback after a late reconciliation failure. New export
regression verifies opening provenance without cash or private review/actor IDs.

```
pnpm --filter @workspace/command-center exec vitest run src/pages/financial-migrations.test.tsx src/pages/invoices.test.tsx
```

**24 passed** (7 new financial screen tests and 17 native invoice-page tests).
They cover role isolation, unsupported-source errors, both approvals, exact body,
source-edit invalidation and lost-acknowledgment status recovery. Command Center
and API no-emit typechecks passed on the current integrated local source. The
intermediate API run's source-adoption declaration mismatch was resolved by the
coordinator's declaration rebuild. Coordinator owns final regenerated-schema, complete-suite, build, real-PG,
SELECT-only recovery and 390/320px integrated browser evidence.

## Still required for actual cutover

Approved source sample/export and written mapping, original documents, actual
opening balances, receipt/credit semantics, original numbering policy, source
freeze/delta and one-writer decision, archival/recovery/export path, owner/accountant
reconciliation and company-specific acceptance. Neither synthetic tests nor a
successful import implies full Housecall Pro replacement, inbox delivery, bank
settlement or permission to cancel the previous system. Hosted/schema/provider,
customer activation and payment-processing gates are unchanged.
