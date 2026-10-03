# Invoice email recovery — worklist, HTTP and contractor UI

Date: 2026-10-02. Source wave: `agent/growthos-invoice-recovery-20261002`.

This lane is implemented and locally verified with synthetic data. It does not establish live mailbox delivery, customer acceptance, deployed schema readiness, or production release. The coordinator owns exact-head CI, integration/recovery, browser QA and any release decision. No customer email, provider request, credential access, hosted mutation, payment collection, Git commit or push was performed by this lane.

## Operator flow

Open **Invoices → Invoice email delivery**. This view pages through matching canonical invoices, 25 at a time, with the existing document-status and inherited lead/project filters. Counts are **invoices**, not global delivery exceptions. There is deliberately no delivery-state exception filter or all-exceptions count in this wave.

Each row links to the existing invoice and shows the latest saved delivery evidence, lifetime attempt count and the server-permitted next review. A fresh review is not proof of current mailbox readiness. The preview/dispatch service still checks current invoice, actor, customer, sender and outbound controls.

On an issued invoice:

- **Preview invoice email** prepares the initial exact review.
- **Review a safe retry** is shown only when the server permits the successor on typed, verified pre-dispatch refusal evidence. A legacy error string or an operator reconciliation is not that evidence.
- **Review another copy** means the prior provider accepted an email, not that delivery failed. The staff member supplies a reason, reviews the newly frozen recipient/sender/complete document and separately acknowledges the duplicate-copy risk **after** seeing that preview. It remains the same issued invoice, not a new bill, balance, payment link or charge.
- Uncertain, processing, reconciled, corrupt or unsupported legacy review evidence offers no new send. Check the original mailbox and saved receipt details. A new preview, browser, reason or request identity does not authorize replay.
- The limit is **five lifetime attempts**, including retained legacy history. The UI cannot reset it.

The exact email is escaped plain text, not executable HTML. Changed invoice version, delivery head, reason, review mode or expiry disables/discards the earlier approval. Reason changes, explicit refresh, a new preview and failed sends clear both approval checkboxes. A synchronous in-flight latch prevents double clicks from dispatching multiple requests. A lost send response requires a read-only status check; the UI never retries automatically.

History is expandable. Main labels distinguish provider acceptance from inbox delivery and generic held status from verified non-dispatch. Internal execution/attempt/proof/provider references live in support details. Earlier hash-only reviews remain visible but do not qualify for a new send.

## Server and HTTP boundary

`GET /api/v1/invoices/delivery-worklist` is mounted before invoice-ID routes with `invoices.read`. It accepts only the canonical strict `page`, `status`, `leadId` and `projectId` query contract. It derives the company from membership, then verifies an active, email-verified, non-invite staff actor with invoice-read permission. It reuses the canonical invoice list and batch kernel evidence rather than recalculating recovery eligibility.

The worklist returns allowlisted identification/version/customer-display fields and latest-attempt metadata only. It performs no sender lookup, token refresh, rendering, approval creation or provider operation. Missing/mismatched batch evidence is an unavailable error, never a fabricated unsent invoice. Canonical invoice reads use their existing read-only transaction; the new lane adds only reads of application data.

Delivery preview/send additionally require the same current human session. Ambient-cookie requests need the configured same-origin page; missing Origin is allowed only for an explicit authenticated Bearer session. Basic-header/cookie fallback, foreign/null Origin, cross-site/same-site Fetch Metadata and API-key mutations are denied. JSON and strict action/query/body contracts remain enforced. Ordinary invoice CRUD compatibility was not widened or changed.

Successor preview binds `intent`, `expectedLatestExecutionId` and a trimmed 10–1,000-character reason. Send carries only the saved `previewId`, exact `payloadSha256`, explicit confirmation and, for an additional copy, the fresh `duplicateCopyAcknowledged: true`. The caller cannot select a different mode at send time. Existing `canPrepare` remains initial-only; the UI uses the authoritative bounded `nextIntents` and chain integrity.

## Files owned by this lane

- API: new `src/services/invoice-delivery-worklist.ts` and `.test.ts`; narrow `src/routes/v1/invoices.ts`, `invoice-delivery.test.ts` and `route-inventory.test.ts` changes.
- Command Center: new `src/lib/invoice-delivery-ui.ts`, `src/components/invoice-delivery-worklist.tsx` and its tests, and `src/test/invoice-delivery-fixtures.ts`; changes to invoice-delivery component/tests and canonical invoices page/tests.
- This report. Shared schema/kernel/dispatch/OpenAPI/export/inventory/recovery work belongs to the other coordinated lanes, not this report's test claims.

## Local verification

- Guarded disposable PGlite runner: **23 passed** across worklist service (8), invoice-delivery HTTP (8), and route permission inventory (7). No supplied database URL or provider configuration was used.
- Focused invoice/worklist/page UI: **43 passed** on the final UI source.
- Full Command Center UI: **575 passed in 89 files**. A subsequent display-only stale-warning adjustment was rechecked by the focused 43-test run.
- API and Command Center TypeScript `--noEmit`: passed.
- Scoped formatting and `git diff --check`: passed.

Coverage includes fixed 25-row pagination, strict selectors, company and accepted-staff isolation, metadata-only output and unchanged invoice/audit/execution records, absent/mismatched chain failure, origin/session guard bypass attempts, malformed successor contracts, fresh duplicate acknowledgement, stale invoice/head/reason/expiry, uncertain HTTP results, cap/legacy wording, and canonical navigation. Kernel real-PostgreSQL concurrent-session tests and actual fake-adapter dispatch-chain tests are owned by the other lanes; this lane does not substitute PGlite for those concurrency proofs.

## Remaining gates and explicit limits

Exact-head CI, coordinator recovery/browser checks, reviewed schema/backup/restore release gates, production image/schema coordination, owner-approved provider activation and recipient-controlled live mailbox proof remain separate. Provider accepted is never reported as delivered. No invoice bounce/read connector, global exception search, scheduled resend, marketing automation, payment processor or collection workflow was introduced.

The GrowthOS Revenue Desk skill kept this work on the canonical invoice workspace and transactional financial boundary. The email-best-practices reliability guidance informed exact approval, evidence wording and idempotent recovery; the repository's stricter permanent unknown-effect hold takes precedence over generic retry recommendations.
