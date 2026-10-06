# Returning customer work — runtime lane

2026-10-06. Implements the frozen `returning-customer-work-contract-2026-10-06.md`
on the shared candidate branch. This is working-source/local synthetic evidence,
not a deployed schema, provider connection, actual payment/refund, production
acceptance or contractor replacement approval. Root owns source identity,
disposable PostgreSQL execution, candidate/main CI and release.

## Implemented contracts

- Exactly two new tables: immutable customer/property lineage and transactional
  original staff-command results. Four native work/money tables use an explicit
  lead XOR returning-work root. There is no native-history backfill, invented
  acquisition lead, duplicate project model or contact-wide cash pool.
- Browser-safe closed schemas, four session-only native command routes, exact
  saved versions, actual/effective accepted human authority, explicit property
  or null, current coherent native reads and original-request reconciliation.
  Changed actor/action/payload/target cannot reuse a retained command. A replay
  returns the original receipt version and current original target; it never
  creates again. Returning estimates record staff acceptance only.
- One estimate and one job per root; estimate conversion preserves its price
  and acceptance. Legacy unversioned edits/deletes refuse returning records.
  Ordinary property ownership changes are refused after root use, while address
  edits remain possible and invalidate semantic delivery reviews.
- Native crew/window/resource checks and exact job invoice-preparation task
  are reused. Returning preparation retains contact/project identity without a
  lead and preserves office description, assignee and deadline. No completion
  automatically issues an invoice or records cash.
- Existing invoice kernel supports returning job/root and standalone customer
  sources. Legacy create parsing and `JSON.stringify` request fingerprints stay
  literal. Issued document snapshots, original numbering/operations, opening
  cutoffs, scope-wide complete-read caps and retained allocation history remain.
- Money is scoped to one explicit legacy lead or one returning root. External
  refunds are append-only, linked to their original same-root payment, constrained
  by cumulative original cash and the exact invoice's original-payment allocation.
  Allocation reversal never erases the cash fact. Unallocated refunds hold the
  balance for reconciliation. Source references stay company-wide unique.
- `readInvoiceDetail(reader,...)` and `readReturningInvoiceLineage(reader,...)`
  validate all current populated parents and financial integrity without another
  transaction, pooled reentry, settings creation or network. Locked final reads
  retain actual member/invoice/root/contact/property/project/estimate row locks.
  Returning source hashes include semantic name/email/address/native parent
  content rather than timestamp equality alone. Delivery v3 is owned and tested
  independently by the delivery lane; it uses these exact helpers.
- Participating mutation prefix is lifecycle, schedule, invoices, exact command
  or cash-reference lock, then actual rows. Legacy property writer now obtains
  its real row `FOR UPDATE` before the new immutable-lineage retention check.
  Root updated preexisting PG barrier matchers to observe that actual statement;
  no actual writer/exclusion assertion is replaced with simulated concurrency.
- Root-reviewed final retention clarification: ANY retained legacy invoice
  (draft/issued/void) prevents replacing/removing its job's estimate, changing
  its lead's property, or reparenting that property's customer. Any recorded
  value kind similarly preserves its original lead/property scope and refuses
  merging either side. Same-parent edits, address corrections and ordinary
  operational edits remain possible; there is no cash relinking/backfill.
  `updateLead` already excludes contact reassignment and bulk lead edits expose
  no parent mutation. Truthful `invoice_history_retained` / `value_history_retained`
  409 responses keep the original native records available.
- Root's general value-entry writer now retains the shared financial prefix and
  actual coherent lead/contact/property rows. The legacy financial-import commit
  adds a sorted locked-lineage check before writes, separate from its existing
  v1 context: review payload/digest/hash/cutoffs remain unchanged. A property
  owner change committed first refuses stale cash/import; an original financial
  write claimed first retains its parents through commit.
- Returning delivery evidence reads a selected project's actual populated
  estimate ancestry even if the original invoice's estimate field is null.
  It hashes/locks the current semantic ancestor without rewriting that null or
  altering the literal legacy v2 snapshot/request branch.

## Local checks actually run

Commands run from the canonical repository, through the existing isolated
allowlisted-environment harness. It creates a fresh loopback in-memory PGlite,
applies the complete schema and removes its own server/database on exit. No
Docker, existing database, live provider or customer contact was used.

```text
pnpm --filter @workspace/api-server typecheck
pnpm --filter @workspace/api-server exec tsc -p tsconfig.json --noEmit

node artifacts/api-server/scripts/test-scheduler-isolated.mjs \
  src/services/returning-customer.test.ts \
  src/services/returning-customer-concurrency.test.ts \
  src/services/invoices.test.ts \
  src/services/financial-migration.test.ts \
  src/services/invoice-retention.test.ts \
  src/services/contractor-scheduling.test.ts \
  src/routes/v1/returning-customer.test.ts \
  src/routes/v1/invoices.test.ts
```

- First full API typecheck and later API-only typecheck passed. Root will run
  final workspace checks after integration; no final candidate hash is asserted here.
- Final combined eight-file selection: **85 passed, 16 PostgreSQL-only skipped**
  (101). Returning ordinary domain file has 15 passes. Seven skips are this lane's
  new real-PG cases; nine are retained invoice/migration/retention/scheduling cases.
- Within that selection actual HTTP checks: **10 passed, no skips**. Four new tests parse
  actual responses against the generated API schemas, comparing normalized wire
  JSON without losing fields, as well as the closed service contract. They cover
  estimate/accept/job/invoice/issue/payment/refund, explicit null/direct work,
  strict selectors and current staff/tenant/API-key gates. Six legacy invoice
  HTTP tests remain unchanged.
- Earlier selections overlap these results and must not be added. Earlier failures exposed a legacy
  invoice error-code propagation mismatch (fixed in source without weakening its
  old assertions), then a generated invoice `leadId` nullability mismatch (fixed
  by root's projection). New retention fixtures initially omitted required
  synthetic address fields/explicit cash confirmation; only those fixtures were
  corrected, without changing assertions or production requirements. The final
  checks above are the reruns after all fixes.

## Seven actual PostgreSQL obligations (not executed by PGlite)

`services/returning-customer-concurrency.test.ts` uses real independent PIDs,
test-only trigger barriers in a disposable database, actual application writers
and observed `pg_blocking_pids`. Each barrier cleans up its exact trigger/function.

1. `retains actual returning-work contact, property and accepted member locks through native command commit while ordinary writers wait`
2. `waits for an actual property reassignment then refuses stale returning customer selection with no root or native command`
3. `serializes actual estimate conversion with duplicate creation and accepted-price writers into one retained native job`
4. `retains one returning invoice number and original issue operation under concurrent exact-request recovery`
5. `serializes original returning cash allocation and refund corrections without exceeding the exact receipt or invoice allocation`
6. `retains original legacy cash and imported invoice lineage against actual property and merge writers`
7. `rereads actual property ownership before original legacy cash or historical import commit with no financial writes`

The final two each exercise both the actual value-entry command and historical
financial import. They observe the actual property row wait plus real merge/lead
property writers under the shared prefix; reverse-order tests observe the current
financial command blocked on the actual property writer before refusing stale
ownership, with zero invoices/value entries. PGlite deliberately skips them.

Real PostgreSQL16 local/candidate/main execution remains a release gate. Delivery
owns additional final-admission/ordinary-writer races. Full generated/UI/export/
recovery/browser/schema/CI acceptance belongs to root. No operator attestation,
new request ID or source-mode change authorizes replay of an uncertain provider
effect; this lane adds only atomic local staff commands and external-cash records.

## Handoff

Pure/runtime seam and exact API descriptions are saved in the private
`growthos-returning-customer-2026-10-06/API-CONTRACT.md`. Root owns shared STATE,
release evidence and Git. This lane did not commit, push, start Docker, change
provider configuration, issue a live send or touch real customer/cash data.
