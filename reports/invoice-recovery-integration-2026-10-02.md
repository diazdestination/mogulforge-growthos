# Invoice delivery recovery — integrated second wave

Authorized second engineering wave, based on merged first-wave main
`51da543db898f9907a4198fbc0ada880c378900d`. Both first-wave candidate
CI37089194639 and exact-main CI37090103299 passed. This report is the second
wave's source/verification checkpoint; its own exact candidate and merged-main
CI must pass before release selection. No hosted deployment or client activation
is implied.

## What the contractor can do

**Invoices → Invoice email delivery** shows a canonical page of up to 25
invoices with delivery status, attempt count and an honest next review action.
Open the invoice for its complete issued document and expandable email history.
An initial send, a proven-no-dispatch retry, and another copy are separate
choices. Recovery requires a fresh reason and an exact current review; a copy
also requires a new acknowledgement after reviewing recipient, sender and text.

The immutable document is retained. Copies explicitly say COPY of the same
invoice, not a new bill or charge. There is no automatic resend, payment
processor or change to recorded financial balances. Provider acceptance is
distinct from inbox delivery. No bounce/read monitoring is claimed.

The list counts matching invoices, not all delivery exceptions. A global
delivery-state filter/count is not implemented in this bounded wave. Historical
hash-only previews lack the original participant/sender context: their history
remains visible but cannot authorize a new copy. Modern v2 reviews retain the
required exact context. Pending, unknown, reconciled, invalid or five-attempt
histories cannot be bypassed with another browser, request or note.

## Integrity and dispatch

One append-only table binds invoice, actor, review, exact execution and
predecessor/proof to the same company. Atomic reservation owns attempt + receipt
+ event before any provider effect. Atomic finalization records actual
acceptance/refusal proof, receipt, event and applicable email activity together.
Lost acknowledgement, failure after POST or failed finalization never becomes
proof of no send. A final zero-row CAS rolls back evidence instead of granting
another effect. Generic durable execution remains unchanged.

Actual post-OAuth dispatch rechecks the current accepted verified staff actor,
invoice/document/version, contact/recipient, source/assignment, selected mailbox,
review expiry, latest attempt chain and all applicable holds. Transactional
invoice eligibility remains separate from marketing consent/adoption. Additional
delivery-only session/Origin checks do not alter ordinary invoice CRUD.

OpenAPI and generated clients include the exact request modes, full attempt
evidence and bounded worklist. A real service/adapter integration test validates
all four actual response shapes against generated schemas. The lifecycle
inventory is v9 with 118 tables; attempt records participate in full backup/
inventory but are deliberately excluded from core customer exports, like other
internal dispatch/approval evidence.

## Local verification

- Kernel: **26 passed**, two independent-session PostgreSQL races explicitly
  deferred to exact CI (not treated as local passes).
- Service/contract/actual adapter: earlier combined **70 passed**, one existing
  PostgreSQL race skipped locally; coordinator added generated-contract coverage
  and reran the complete actual-adapter file: **26 passed**.
- Worklist, HTTP and permission inventory: **23 passed**.
- Inventory and customer-export regressions: **71 passed** across four files.
- Final full UI: **575 passed / 89 files**; focused UI: **43 passed**.
- Full scripts: **229 passed / 18 files**.
- Full TypeScript, Command Center/API builds, generation and diff checks passed.
  Existing chunk-size and tooling deprecation warnings are not hidden.

The actual adapter tests run real service, OAuth-preparation, transport boundary
and durable kernel code against a stubbed external network. They prove zero
customer-message POSTs after late authority changes and no retry proof after
timeout, guard-like untrusted provider errors or HTTP 503 following POST. They
are not live Microsoft/Gmail delivery acceptance. Peer cross-reviews found no
remaining concrete dispatch/ownership bypass in this bounded scope.

## Additive schema and compatible synthetic recovery

`node scripts/invoice-recovery-schema-preview.mjs` generates review-only
`0011_invoice-recovery.sql` after 0010: 16 additive statements, one new table,
118 total. It never opens a database. Normalized SQL SHA-256:
`c9491ff8eef505d8e784e004cf97af7192cefa9701f5fa2eeb3d599e6a0de063`.

`node scripts/contractor-recovery-drill.mjs` applies the reviewed 90-table base
and all additive deltas in a disposable in-memory database, restores two
fictional companies, boots the real app with a SELECT-only role and verifies
**26 read routes**, tenant boundaries and denied writes. Four invoice attempts
preserve both companies' blocked → uncertain chains, typed prior proof, exact
predecessor and empty next-intent list. Nine additional invoice constraint
negative tests roll back without changing the source fingerprint. Paused-company
fixture exceptions are exact and synthetic-only; processing, altered proof or
an active company still fails the safety assertion. Historical hosted acceptance
and its schema pin are not changed.

Final precommit run source/restored fingerprint:
`a10a28def58117ce8010cdf564b923f1b3e8f6b30d138e5abe37e864a9f93005`.
Snapshot SHA-256:
`4596c9198cd05522a86157a65d33b2666e34d041e1c7439963e25a4477c4519a`.
These are dirty-candidate local evidence, not managed-backup acceptance or
production RPO/RTO. Exact committed/CI evidence is still required.

## Browser walkthrough

Build the UI and run
`node artifacts/api-server/scripts/preview-runtime-isolated.mjs --invoice-recovery`.
It creates only fictional `.invalid` contacts, held outbound, no provider
credentials, a disabled background scheduler and loopback-only storage/server.
The disposable visual runner serializes its PostgreSQL client pool because
PGlite has a single backend; production pooling and CI concurrency are unchanged.
This corrected an observed local multi-client result mixup and a scheduler/pool
deadlock. Full-page reload of the same deep link then passed.

Browser proof: all three list states rendered; the uncertain record exposed
both attempts and no preview/send; the safe-retry record required a reason and
then clearly blocked on its absent selected mailbox. No email was sent. Phone
layout at 390×844 rendered the same history without horizontal page overflow;
the temporary viewport was reset. Screenshots are in the private two-wave
handoff folder, not customer-facing marketing or live-provider proof.

## Release and remaining work

Related evidence: `invoice-recovery-contract-2026-10-02.md`,
`invoice-recovery-kernel-2026-10-02.md`, `invoice-recovery-dispatch-2026-10-02.md`
and `invoice-recovery-ui-2026-10-02.md` in this directory.

Close this exact candidate's PostgreSQL CI, builds/Docker and separately
dispatched merged-main check. Keep the existing unrelated `pnpm-workspace.yaml.bak`
out of commits. No deployment, hosted schema/credential changes, provider
activation, DNS, purchase, real message or customer cutover occurred.

Both engineering waves are bounded additions, not a declaration that the whole
launch checklist is complete. Remaining L1 contexts, L4 missed-call automation,
L5 standing service reminders, L6 ongoing nurture, L7 unified daily history and
L8 real-source migration still need their documented work/acceptance. Azure
owner return, separately approved hosted schema/backup/rotation, live mail/
Twilio, actual phones and both contractor replacement cards remain gates.
Contractor payment collection stays deferred.
