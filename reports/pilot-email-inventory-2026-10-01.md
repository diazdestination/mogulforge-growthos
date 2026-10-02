# Controlled pilot: email reliability and bounded data inventory

Source follow-up to held-staging release `77f6d63`, October 1, 2026.
This is engineering evidence, not customer activation or provider-delivery proof.
The exact candidate commit and full PostgreSQL CI result are recorded in the
existing draft [PR #1](https://github.com/diazdestination/mogulforge-growthos/pull/1).

## Completed in this change set

- Bound the Resend request and complete receipt to ten seconds, refuse redirects,
  cap receipt size, require a valid accepted-message ID and redact provider errors.
  Uncertain outcomes are not automatically retried or described as definitely unsent.
- Preserve attempted API-key-reminder claims through partial/unknown results and
  audit failures. Saving an unchanged expiry cannot re-arm a prior attempt. Safe
  outcome counts distinguish provider acceptance from delivery and require review
  before another attempt; this is not a per-recipient delivery ledger.
- Remove invitation UI's blind Retry action and incorrect activation/delivery
  claims after an unconfirmed send or lost response.
- Add an owner/admin, session-only, manually requested data-count preview in
  Settings. Its explicit 95-table catalog, bounded read-only authentication and
  count transactions, tenant scope, schema-drift checks and safe failure modes do
  not authorize export, erasure or provider operations.
- Separate and narrowly pin the synthetic Docker monitoring view and the actual
  hosted `pg_stat_monitor` 2.3 metadata. Neither view's records are queried. Unknown
  metadata fails closed before company counts. The real pin was independently
  compared with the sanitized staging observation at 18:02:16.729 UTC.

## Local validation

| Check | Result |
| --- | --- |
| Combined isolated API regression suite | 211 passed, 15 files |
| Complete Command Center suite | 355 passed, 62 files |
| Complete scripts suite | 222 passed, 17 files |
| Full workspace TypeScript checks | Passed |
| API and Command Center production builds | Passed |
| Whitespace/diff check | Passed |
| Independent scoped source review | No remaining consequential findings |

The local API runner uses a fresh disposable PGlite fixture and mocked provider
boundaries. It does not substitute for the full real-PostgreSQL CI release gate.
The full UI run exposed an existing test race: Send was clicked before the draft
effect populated its state. Only the test was changed to wait for the expected
draft and enabled button; original request and feedback assertions remain.

Fresh signed-in loopback browser acceptance used a fictional owner and database:

1. The new Settings tab rendered without a count request/result on entry.
2. Manual **Check data inventory** returned a matched catalog: **92 tables counted,
   three shared/unscoped tables excluded**, with a 10,000 per-table cap disclosed.
3. The screen labelled counts as table records, not a customer total, and kept
   export/deletion, media/provider copies, shared identity and retention limitations
   visible. No real invitation, provider connection or message was attempted.

## Fresh read-only readiness findings

- The platform's approved sender domain/key is present on held staging; provider
  inventory showed verified sending domains. This is not inbox-delivery proof.
- No Resend webhook was configured and staging had no callback signing secret.
  The existing callback correlates supported playbook touches, not every platform
  verification/reset/invitation. Full platform delivery/suppression correlation
  remains an engineering and supervised-acceptance gap.
- Microsoft client configuration is absent on staging. Both available browser
  paths reached Microsoft sign-in without an authenticated tenant. Public DNS
  suggests Microsoft 365 behind the contractor's mail gateway but does not prove
  mailbox licensing, Graph policy, consent or sender choice.
- Only metadata of the isolated staging database was inspected. No monitor rows,
  contractor records, secrets or database writes were needed for the compatibility
  pin. Private intake and provider evidence remain outside Git/build contexts.

## Boundaries and next gates

The hosted app remains on `77f6d63`; this source follow-up requires its own exact
green CI and separately approved held-staging release. No schema migration is
introduced by this change set. Outbound hold remains active, staging send approval
false, recipient allowlist empty, and scheduler/push disabled. No email, SMS, push,
call, owner invitation, provider consent/configuration, DNS or production change
was performed. No cluster or other paid resource was added.

The owner's four privately supplied inboxes are test-recipient options, not an
open send window. Confirm the contractor's default sender, complete the authorized
Microsoft setup, finish delivery correlation, then obtain a bounded app-originated
test window with an exact recipient/sender, message count and stop/re-hold plan.
Do not use another email connector to manufacture GrowthOS delivery proof.

P0-7 remains open: a bounded database count is not complete account lifecycle
support. See [the lifecycle plan](../CUSTOMER-DATA-LIFECYCLE-PILOT.md) and
[the email runbook](../CUSTOMER-EMAIL-PILOT.md) for the unresolved work.
