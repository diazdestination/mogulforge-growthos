# Contractor operations wave - integration evidence

October 2, 2026. Owner-approved engineering from customer-care PR14/main
602131d1b0311ea5933633fedc2c25b5af218238 (exact-main CI37074053979 passed).
Branch: agent/growthos-operations-wave-20261002. This is a source candidate,
not a live rollout or completion of either Housecall Pro replacement card.

## Delivered

- MAINTAIN service-watch queue: actual overdue/blocked/unknown/no recorded reply/
  cancelled/no-show facts, accountable accepted staff, internal action deadline,
  retained transitions and source-driven resolution. Scheduler bootstrap and
  rotating refresh are bounded independently; failed source rows cannot starve
  the rest. Acknowledgement never records a customer reply or books a visit.
- Typed service staff push: separately default-off service-alert setting,
  current-owner-only devices, stable case/revision ownership, generic lock-screen
  text and company-scoped service deep link (including sign-in return). Service
  alerts use explicit any-hour owner opt-in, not lead day/after-hours routing.
  No fake acquisition lead. Stale source, ownership, policy, session, company
  hold or expired device blocks dispatch after DNS. The final authorization
  callback shares the five-second deadline; unknown network effects cannot retry.
- Source adoption: exact current source/status/cutover review, versioned audited
  approval/revocation, original CSV history retained. Separate address-specific
  staff-attested marketing permission. One frozen email touch, up to10 recipients
  per reviewed batch and25 rolling company reservations, selected Gmail/Microsoft
  sender, exact copy and unsubscribe material. Approval alone sends nothing.
  Generic imported playbooks and SMS remain held. Current source, actor, sender,
  reply/opt-out, lifecycle and timing are rechecked after OAuth preparation.
  Permanent opportunity/address claims survive unknown effects and cloned batches.
- Historical finance: owner/admin reviewed normalized v1 input, strict exact-cent
  reconciliation, original number/date/document, stable source identities and
  atomic duplicate-safe commit. Full evidenced receipts and non-cash opening
  receivables are distinct. Never infer paid cash from total minus outstanding.
  Invoices links to the restricted migration desk. No processor or customer send.
- Shared integration: eighteen documented operations and generated clients;
  invoice basis/provenance DTOs; route authorization catalog; scheduler isolation;
  lifecycle inventory111tables and core export20allowlisted datasets. Raw source
  approvals, provider secrets and staff/device identities are not core export.

Detailed contracts and operator steps:
[service watch](operations-wave-service-watch-2026-10-02.md),
[source adoption](operations-source-adoption-2026-10-02.md),
[financial migration](operations-wave-financial-2026-10-02.md),
[operator guide and fictional normalized example](operations-wave-operator-guide-2026-10-02.md).

## Independent review and integration repairs

Three workers implemented disjoint lanes; the coordinator integrated shared
schema/router/OpenAPI/push/export/recovery files. Cross-review found and repaired:

1. Duplicated signed email-parent evidence made verified replies ambiguous.
   Only canonical email_sent now carries correlation evidence; the outreach-cap
   activity keeps count metadata. Actual accepted-send -> verified-reply -> hold
   regression is included.
2. Newest-only source selectors hid older imports and uncertain campaign evidence.
   Strict bounded independent pagination now exposes both; malformed HTTP200
   payloads show an error rather than crashing or claiming an empty queue.
3. Migration lock order now follows lifecycle -> scheduling -> invoice -> staff.
   Read-only review GETs do not request row write locks, so restricted recovery
   inspection works without expanding database privileges.
4. Composite FK parents use actual UNIQUE table constraints before dependent FKs,
   including both fresh schema and generated upgrade order.
5. The final push authorization check is bounded across DNS plus DB time. Late
   callback completion/rejection cannot resume an expired request.
6. Historical c050067 harness tests now read exact frozen app and revenue-schema
   blobs where current source evolved. Historical source/image/bundle digests
   remain unchanged; current bytes are still rejected under historical pins.
7. Built-browser inspection found Win-back nested a second application shell.
   It now shares the routed shell; financial migration also uses its parent's
   main landmark. Regression tests protect single navigation/main landmarks.
   Import copy now directs operators to the separate current cutover/permission
   review without implying that import itself enables outreach.

## Local verification and release gates

- Full Command Center:516tests/82files passed after the final layout integration;
  Command Center types and production build passed again on that follow-up.
- Full workspace TypeScript checks and both production builds passed.
- Integrated export/inventory/routes/push/scheduler selection:103tests passed.
- Service watch:20API passed/1independent-PG skip;17UI passed.
- Source lane:42API passed/1independent-PG skip;23UI/accessibility passed.
- Financial/native invoice selection:36API passed/5independent-PG skips;24UI passed.
- Staff push transport:30passed, including hung final authorization and late
  resolve/reject with zero requests. Existing push/policy/transport selection
  earlier passed101; the typed service push selection passed13.
- Full scripts suite:228passed/18files, zero skips. Historical crash/idle/probe
  regression:64passed, zero skips. Website adapter
  and operations:26passed. These overlapping selections are not additive totals.
- Full API attempt on lightweight PGlite was stopped after automation-DNC timeouts;
  an isolated reproduction and bounded socket probe traced the timeouts to the
  existing default-playbook transaction awaiting a second pooled connection.
  The same path exists unchanged in base602131d; PGlite's single-backend socket
  multiplexer cannot service it before commit. See the source-lane report.
  This is not full-suite acceptance. No tests were disabled or deadlines relaxed.
  Real independent-session PostgreSQL CI is required on the exact PR head.
- Browser: built inert loopback app, fictional records only, outbound held and
  no provider credentials. Service acknowledgement/retained plan and historical
  opening-invoice preview/commit exercised. Service390/320widths have no document
  overflow; imported invoice390/320widths also fit, retaining $125 original,
  $45 opening due and $0 post-cutoff receipts. Source management preview, approval
  and revocation retain original history and never grant email permission. Both
  source review and financial migration also fit390/320without document overflow.
  The initial source-index unavailable state cleared on explicit Retry; bounded
  subsequent actual HTTP contract/concurrency reads passed, without reproducing
  a source defect or masking the error. See the source report for exact limits.
  Further source proof is in the private checkpoint. This is not physical iPhone
  push or uncoached staff acceptance.
- Exact PR-head CI (all PostgreSQL tests, types, builds, Docker) and separately
  dispatched exact-main CI must pass before selecting the release. See attached
  PR/checks and private dated STATE checkpoint for their final identities.

Reproduce with built Command Center and
`node artifacts/api-server/scripts/preview-runtime-isolated.mjs --operations`.
The optional operations fixture adds only a fictional historical source with
all do-not-contact flags true; it cannot authorize customer outreach.

## Schema and recovery

Offline-generated review delta:
staging-schema-preview-2026-10-01/0008_operations-wave.sql
SHA25633dcb364229ab9bf8a05270cae9b17e4052fdbd1ed2db0fb83d050cd1acb36f6.
65statements; six new tables,105to111. Apply after0007 only under separately
approved, hash-pinned release procedure; no ambient or hosted schema push.

Only staff_push_deliveries.lead_id relaxes NOT NULL. A database check requires
exactly one complete lead target OR service/owner/case/revision/event target.
Composite tenant keys cover service owner/source/financial references.

The disposable contractor recovery drill upgrades90to111, snapshots and restores
both synthetic companies, compares all table fingerprints and boots the real app
under server-enforced read-only credentials.22restricted application checks,
13new cross-tenant FK negatives plus6older negatives, and a distinct cloned
campaign rejection preserve the reviewed boundaries. Service plans, revoked
adoption, claimed-without-receipt uncertainty, opening receivables and typed push
uncertainty survive. Provider calls0. The drill accepts no hosted URL.

Earlier managed103-table proof is not111-table hosted backup/schema proof.
An old app cannot safely become a normal-write rollback once new invariants/data
are in use. Preserve uncertainty/history; no destructive schema rollback.

## Still not finished

Hosted staging upgrade/admin-credential rotation authority remains unanswered.
Azure first sign-in is owner-deferred. Real Gmail/Microsoft receipt/reply,
Twilio routing/consent/STOP, phone install/push and source export/accounting
reconciliation still require authorized acceptance. Trusted live inbound-mail
integration, platform identity delivery reconciliation and actual critical
customer-workday gaps remain engineering/acceptance work. The loader is not an
arbitrary Housecall Pro CSV/PDF converter; unsupported adjustments and relationships
need operator reconciliation and any required scoped adapter.

Contractor payment collection remains deferred; platform subscription billing
is separate. No hosted/provider/client-site change, actual customer data/message,
third cluster, purchase, activation or Housecall Pro cancellation occurred.
