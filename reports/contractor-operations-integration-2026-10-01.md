# Contractor operations: integration and release evidence

Private engineering candidate `agent/growthos-contractor-operations`, based on
`8bef3c03c481b2f510ee82a3eb302c2e37df59aa` (draft PR9, CI36955582998 succeeded).
The latest candidate's exact commit/CI belongs to its own draft PR and the Forge
handoff. Previous green CI is not a release pass for this wave.

## Product direction and delivered work

Adam identified scheduling, invoices, warranty tracking and unclear navigation
as the beta customers' concerns. GrowthOS now has an explicit native replacement
direction in `GROWTHOS-CONTRACTOR-OPERATIONS.md`. Housecall Pro is optional migration
support. Native customer invoicing, field-day acceptance and warranty recurrence
remain separate milestones; this wave does not claim replacement readiness.

- Accepted staff coverage and audited tenant invitations, including safe unknown
  delivery recovery, expiry/reissue/revocation and verified mailbox acceptance.
- Signed outbound evidence and signed normalized incoming reply correlation,
  audited ambiguous-reply review, opportunity holds and preserved uncertain receipts.
- An Owner report with explicit UTC periods, previous-period comparisons, original
  imported dates, unknown value coverage, record links and a matching financial range.
- Private website worker heartbeat/health and consistent SQLite backup tools in
  both the reusable adapter and the Climate site candidate.
- Reviewed additive schema preview, updated99-table lifecycle inventory and an
  actual application read after synthetic database upgrade/snapshot/restore.

Beta terms remain $500/month. $1,500 is a future value target requiring measurable
customer outcomes and sustainable delivery costs. No price/entitlement expansion
or real invoice collection is implied.

## Verification before integration

| Scope | Local evidence |
| --- | --- |
| Staff invitations/readiness |33 API pass;1 multi-session PostgreSQL case reserved for CI;13 UI pass |
| Reply controls/evidence |111 API pass;3 multi-session PostgreSQL cases reserved for CI; independent reply rerun27 pass/3 reserved |
| Owner reporting |14 focused API,27 prior outcome,22 UI checks pass |
| Lifecycle inventory |62 checks pass,99 classified tables/96 tenant-counted/3 explicit shared exceptions |
| Script/recovery suite |225 pass across18 files |
| Reusable adapter/operations |18 adapter +8 operations tests pass |
| Climate site |19 tests, lint, types, Next build and formatting pass |
| Shared types |Workspace TypeScript checks pass before final source freeze; final integrated CI remains required |
| Actual component browsers |Staff4, replies10, reports6 width/theme cases; zero final axe A/AA violations or horizontal overflow; synthetic local API fixtures only |

Do not add overlapping test totals from this table. The full workspace CI is the
authoritative aggregate and executes real PostgreSQL locks plus the Docker gate.
Browser evidence is under the specialist reports' local artifact paths; it uses
actual components with synthetic API responses, not deployed authentication or
provider acceptance. No recordings, traces or video were collected.

Independent review found and resolved request-ID lock races, unverified OIDC
mailbox adoption, reply CSRF/JSON checks, untrusted activity metadata, omitted
manual-send evidence, heartbeat normalization and recovery-setup cleanup. New
nullable reply effects and legacy invite retry contracts were corrected in OpenAPI;
generated clients were rebuilt. See the three specialist reports for exact cases.

The first full CI run 36960497654 on 869e2df caught nine integration-test failures:
the new guarded routes needed explicit permission-inventory entries; normal-mode
report tests still expected tenant-query overrides to be ignored instead of
rejected; a financial disclaimer assertion used the earlier wording; and the
invitation test URL extractor assumed HTTPS while CI uses a local HTTP origin.
The repairs retain the strict runtime guards and verify both rejection and
successful tenant-scoped reads. Synthetic invitation extraction verifies the
actual configured origin and acceptance path. No test or permission gate is
disabled. A subsequent complete CI run at the repaired head is required.

The second run 36961422539 on cd54dd4 passed all 1,744 API tests (15 existing
skips), 225 script checks and 16 library checks. All new reply and invitation
PostgreSQL concurrency cases ran and passed, as did the older concurrent BIE
execution case. The frontend reached 402 passes and one failure: the old
report response fixture in the cross-page accessibility suite omitted the new
period fields and caused a related unhandled render error. The repaired fixture
uses the generated report type, includes a valid period ledger, and waits for
the loaded report regions before applying the unchanged accessible-name guard.
All 403 frontend tests and the frontend typecheck pass locally with no unhandled
errors. The complete final-head pipeline remains required.

## Synthetic upgrade and recovery

`scripts/contractor-recovery-drill.mjs` starts with the pinned90-table schema and
two synthetic companies, applies reviewed0002–0005, and matches current99-table
and column coverage. It restores an in-memory PGlite snapshot into a separate
instance. Every table's row digest/count matches; a post-snapshot marker is absent.
It verifies existing private-object/credential fixtures and wrong-key/context
rejection, uncertain checkout, company pause, pending invitation, and durable reply
hold after raw message deletion.

The production bundler compiles the actual application into an owned disposable
directory. A reduced-environment child reads the restored database using a role
with SELECT grants only, validates8 actual GET routes, denies cross-company reads
and HTTP writes, and leaves all table fingerprints unchanged. External fetch is
blocked, all data is synthetic, and no provider credential is supplied. The tool
accepts no external database target. Temporary bundle cleanup covers setup failures.

The8 operations tests separately verify live-WAL journal backup, immutable request
identity, wrong-key rejection, authoritative synthetic receipt deduplication after
a lost acknowledgement, active-claim preservation, private paths, heartbeat/queue/
capacity observations and zero health-side mutation. A real host's secret recovery,
CRM receipt retention, monitor alerts and managed backup are still unverified.

`0005_contractor-operations.sql` adds only `staff_invitations` and
`email_response_reviews` with reviewed indexes/checks/FKs. It is a preview, never
production migration approval. Preserve records on rollback. Historicalc050067
hosted pilot source hashes stay immutable; a hash-verified historical durable
execution fixture supports old contract tests while new tests exercise current code.

## Release and live acceptance

Review the stack toward canonical main; this wave sits on PR9→8→7→6→1. Climate's
worker candidate PR2 sits on site PR1. Do not treat either draft as merged/deployed.
Require the exact new head's full tests/types/builds/Docker CI, approved hosted
schema rehearsal, sender/mailbox ownership, office response acceptance, supervised
worker/alerts, separate-key backup recovery and real outcome reconciliation.

No deployment, production migration, provider message, charge, invite, account
cancellation, public launch or real customer cutover was performed. GEEKOM retains
Microsoft/Azure provider acceptance. Local ForgeLink coordination does not prove
cross-machine task synchronization.
