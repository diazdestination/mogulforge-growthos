# Customer workspace runtime — local verification

October 5, 2026. Bounded L7 customer-history/navigation implementation under
`customer-workspace-contract-2026-10-03.md`, resumed on the shared
`agent/growthos-customer-workspace-20261003` branch from main `d4b8c0a`.
This report is local source/test evidence, not a release or contractor acceptance.

## Delivered read model

- `artifacts/api-server/src/services/customer-workspace-contract.ts` is the pure,
  closed Zod/TypeScript contract for the contact header, nine section-specific
  page arrays and exact appointment detail. It imports no database connection.
- `customer-workspace.ts` exports the three frozen reads: header, selected section
  and exact appointment. Every read rechecks accepted, verified, active membership
  and intersects current role with the optional effective-role cap. Invoice reads
  require `invoices.read`; header availability and activity filtering respect it.
- Database work uses repeatable-read, read-only transactions. No settings getter,
  normalization, audit, admission, external provider or write-side helper is used.
  Existing records remain inspectable while customer lifecycle sending is paused.
- Company/customer/property/lead and optional estimate/project/appointment/task
  relationships are checked in SQL before ordering, lookahead and pagination.
  Populated foreign or conflicting parents are withheld rather than treated as
  null. Staff names come only from same-company users, with no email fallback.
- Sections fetch 26 to return 25, ordered by creation timestamp and UUID descending.
  The bounded opaque cursor pins company, customer and section, and stores the
  original PostgreSQL timestamp with six fractional digits. It does not round-trip
  through a JavaScript Date. Dates shown on rows remain separate from page order.
- Service-only customers and actual null property links remain valid without a
  manufactured opportunity. An exact same-company unlinked appointment is readable
  but is not adopted into a customer history. Lead- or property-linked appointments
  resolve a customer only through validated, mutually coherent canonical parents.
- Service ancestry must reach a coherent root. Cycles, broken ancestors, different
  customers/properties, inconsistent occurrence indexes and successors beyond
  **256 validated occurrences** are withheld. This finite defensive bound is not
  an assertion that malformed or exceptionally long history was repaired.
- No financial amounts, balances, line items, document bodies, private URLs,
  approval/provider metadata or message bodies enter the DTO. Activity uses a
  finite allowlist and constant safe labels, never stored headlines/body/metadata.
  Unknown event types are omitted; unauthorized invoice events are filtered before
  paging. Stored projection failures return a safe 503, not private validation data
  or a misleading request-input error.

## Verification

Run from `artifacts/api-server`:

```text
node scripts/test-scheduler-isolated.mjs src/services/customer-workspace.test.ts src/routes/v1/customer-workspace.test.ts src/services/contractor-today.test.ts src/services/native-customer-export.test.ts src/routes/v1/contacts-pagination.test.ts src/routes/v1/contacts-search-scope.test.ts
```

**38 passed, 6 files, no skips**, on the disposable provider-free PGlite runner:

- Runtime workspace: 16 tests.
- Coordinator-owned HTTP workspace: 6 tests.
- Existing Today: 9; native export: 3; contact pagination: 2; search scoping: 2.

Counts overlap earlier 13-, 15-, and 31-test runs; do not add them together.
The initial 13-test run had two fixture setup errors (the attempted cycle violated
the existing one-successor unique key; pause used a nonexistent organization
column). The fixtures were corrected to use a legal cyclic graph and the actual
customer-lifecycle table. No product guard or expectation was relaxed.

Coverage includes two companies, matching names/email/phone/address without merges,
service-only customers, multiple/null properties, every selected section beyond
25 rows, timestamp ties and microseconds, insertion/status changes between pages,
foreign-context/malformed cursors, current role revocation/effective-role caps,
optional and ancestor parent mismatches, old/out-of-range and unlinked visits,
unknown/financial activity filtering before LIMIT, closed DTOs and no read effects.

At repository root:

```text
pnpm --filter @workspace/api-server exec tsc -p tsconfig.json --noEmit
git -c core.autocrlf=false diff --check -- artifacts/api-server/src/services/customer-workspace-contract.ts artifacts/api-server/src/services/customer-workspace.ts artifacts/api-server/src/services/customer-workspace.test.ts
```

Both passed. The standard pnpm configuration warning remains nonblocking.

## Remaining boundary

No new schema or table; no provider, hosted, customer, commit or push action by
this lane. `pnpm-workspace.yaml.bak` remains untouched. The coordinator owns HTTP,
generated API integration, companion creation locks, actual PostgreSQL writer
barrier, UI/browser work, synthetic recovery and exact candidate/main CI. This
lane adds no PostgreSQL-only concurrency test; its 16 tests are portable real SQL
checks, and PostgreSQL CI remains required release evidence.

Creation-order paging is current record browsing, not a frozen export, a next-visit
ranking or an aggregate financial report. Existing native workflows still own all
mutations. Actual equipment/checklists, repeat billable-job semantics, migrations,
provider proof and both contractor workday acceptance gates remain open.

The Jarvis checkpoint skill was read. The lane report and code are persisted;
the coordinator retains the shared STATE/skill/release checkpoint and commit
ownership to avoid conflicting writes from collaborating agents.
