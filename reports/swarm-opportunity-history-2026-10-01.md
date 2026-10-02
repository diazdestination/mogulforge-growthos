# Opportunity history import repair

October 1, 2026. Local development on `agent/growthos-swarm-foundation`, based
on `58ab300`. Synthetic data only. No provider requests, customer contact,
deployment, account changes, commits or pushes were performed by this worker.

## Delivered behavior

- Stable source/account key and external **opportunity** ID identify a job
  independently of the person. A tenant-scoped unique index protects that
  identity; new jobs may reuse an existing contact.
- Original opportunity date, source update date, status date, last actual
  contact, export snapshot date, and first/last ingestion dates are separate.
  Local `leads.createdAt` remains the local record creation time. Missing source
  dates and values remain null; known zero is preserved.
- External customer/estimate IDs are retained. Source identity fields are not
  accepted through the generic lead insert schema. A strict JSON schema
  validates stored provenance; hashes detect changed payloads and intervening
  staff edits without copying contact details or free-text messages into it.
- Identical repeats do not create another opportunity or pretend to refresh
  its source. Changed repeats require a strictly newer source update date,
  consistent mapped fields/customer identity and non-regressing known history.
  Conflicts leave the existing record unchanged and produce a review reason.
- Matching a shared phone is insufficient when known email/phone details or
  an existing source customer ID contradict the row. Multiple matching contacts
  are held for review. Contact details are never overwritten by this importer.
- Missing mapped columns, truncated rows, invalid/ambiguous/future dates,
  unknown status values, unsupported mappings, and unverified currency units
  are rejected. Estimate amounts require an explicit USD currency column;
  this release performs no currency conversion. Property/address import is not
  implemented and address mappings are explicitly rejected.
- Original marketing attribution remains in `source`; a valid newer snapshot
  updates `latestSource`. Intervening local attribution edits require review.
- Age/inactivity segmentation uses source dates for imports. Unknown original
  age is not inferred from ingestion. Recent actual source contact excludes a
  row from an inactive cohort. Segment preview includes original date, source
  snapshot date and required source verification.
- Import history separately reports added, updated, unchanged, conflicts and
  invalid rows, with capped row issue samples and explicit snapshot/upload
  dates. Upload controls preserve the file/mapping after request failure and
  are locked during submission.

## Automated outreach boundary

CSV history supports analysis and staff work. It does not establish current
status, reply/opt-out state, permission or freshness. The pure helper
`needsSourceVerification` returns true for both current snapshots and legacy
`creationMethod=import` records. The coordinator integrated that boundary into
shared automated-send paths and BIE history consumption. No freshness-attestation
button or bypass was added. These imported opportunities remain blocked from
automated outreach until a separately implemented current-source verification
workflow passes acceptance.

Campaign enrollment also checks the hold before creating an enrollment,
scheduled step, or changing the lead stage. Held campaign rows finish as skipped
with `source_verification_required`; lost/completed source stages remain intact.
Normal fresh inquiries retain the existing enrollment path.

## Files

- `lib/db/src/schema/leads.ts`: source identity, unique index, strict history
  schema and public insert boundary.
- `lib/db/src/schema/reactivation.ts`: batch counters and source snapshot metadata.
- `artifacts/api-server/src/services/reactivation.ts`: validated import/upsert,
  conflict behavior, source-aware segments.
- `artifacts/api-server/src/services/source-history.ts`: source date, amount and
  conservative eligibility helpers.
- `artifacts/api-server/src/routes/v1/reactivation.ts`: scoped import contract.
- `artifacts/command-center/src/pages/reactivation.tsx`: existing import wizard.
- `lib/api-spec/openapi.yaml` and five generated contract files: request/result
  metadata and segment preview. Standard Orval generation produced only these
  intended textual contract changes; no unrelated schema expansion.
- Tests: `source-history.test.ts`, `opportunity-import.test.ts`, and
  `reactivation-import.test.tsx`. Existing reactivation tests remain intact.

## Verification

Executed from `artifacts/api-server`:

```text
node scripts/test-scheduler-isolated.mjs src/services/source-history.test.ts src/services/opportunity-import.test.ts src/services/reactivation.test.ts
```

**26 tests passed**: 12 opportunity import regressions, three history validation
tests, and 11 reactivation tests. The added campaign regression checks three held
imports (including a legacy import), preserved stages, no enrollment or scheduled
action, explicit skipped reasons, and a fresh inquiry that still enrolls.
The guarded runner creates a fresh
disposable PGlite database on loopback and removes provider environment settings.
Coverage includes repeated/concurrent requests, distinct jobs for an existing
person, cross-tenant/source identity, unknown versus zero amounts, out-of-order
updates, changed mappings, truncated rows, ambiguous/shared contact information,
intervening staff edits, attribution and historical segmentation. PGlite does
not prove PostgreSQL independent-session advisory-lock exclusion; normal
PostgreSQL CI remains required for that acceptance.

Executed from `artifacts/command-center`:

```text
pnpm exec vitest run src/pages/reactivation-import.test.tsx
pnpm run typecheck
```

**Four UI tests passed**: stable source identity/mapping payload; failure retains
work; pending controls; conflict/snapshot reporting. Command Center and API type
checks passed during integration. `pnpm exec orval --config ./orval.config.ts`
completed normally in `lib/api-spec`. Impeccable's scoped detector returned `[]`.

The coordinator's actual-component browser pass covered desktop, 390px, 320px
and dark mode. No layout overflow or browser errors were reported for the
importer. It found filename badge contrast in light mode and primary-button
contrast in dark mode; the local filename badge now uses the outline variant
and wraps, and the import button uses a scoped dark text color. The coordinator
confirmed zero axe violations, overflow, browser errors or real writes in the
final eight-case ImportCard/Billing browser pass. Full integration CI is recorded
separately by the coordinator.

## Remaining limitations

- This is a CSV snapshot importer, not a Housecall Pro connector or live sync.
  No actual client export, account eligibility or provider endpoint was tested.
- New/legacy imports without external opportunity IDs keep conservative
  contact matching and cannot update historical jobs by guessed identity.
- Conflict records are not applied. The original file and a capped batch issue
  list support operator reconciliation; a dedicated reconciliation editor and
  automatic source-status mapping are not part of this change.
- Amounts use the existing USD/cents model. Source creation/contact timestamps
  require explicit ISO dates or timezone-qualified timestamps. Other source
  status vocabularies need an approved mapping before import.
- Source history is used by the updated analysis/segment paths. This change does
  not redesign every existing lead detail/report surface to display provenance.
- Freshness verification, live provider behavior, backup/restore, full tenant
  acceptance, lifecycle and the other paid-beta P0 gates remain separate work.
  No claim of recovered revenue, causal lift, production readiness or flawless
  operation follows from these synthetic tests.
