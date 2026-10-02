# Billing lifecycle reliability — October 1, 2026

## Delivered scope

Local engineering on `agent/growthos-beta-operations`, based on the previously
green `298b23a`. No Stripe account, customer, subscription, price, charge or
provider setting was changed. All provider effects in verification were mocked.
No deployment or customer communication occurred.

`billing_checkouts` now records one current checkout per organization, enforced
by a partial unique index and the existing per-company billing advisory lock.
It stores request identity, immutable price/return-URL/trial configuration,
phase timestamps, known provider IDs, a short execution lease and recovery state.
It stores no contact payload, provider key, payment URL or card information.
A SHA-256 credential-configuration fingerprint detects configuration changes
across process restarts; a changed key requires evidence reconciliation before
continuing an existing attempt.

Customer and checkout POSTs use separate stable keys derived from the persisted
attempt UUID. Their phase markers commit before the network call. Retries and
service restarts reuse the same payload and key. A 90-second durable lease
prevents overlapping workers; the Stripe client has a 10-second timeout with
zero automatic network retries. Unknown effects stop before a 23-hour retry
window ends. They cannot silently issue a fresh key. This margin follows
[Stripe's idempotency retention and retry semantics](https://docs.stripe.com/api/idempotent_requests),
including the possibility of a cached failure and pruning after 24 hours.

Known sessions are retrieved and reused. Only provider-confirmed expiry permits
a fresh checkout. A completed session can reconcile a missed webhook before
showing the linked subscription. Opening the billing portal requires an existing
customer binding and never creates a customer.

## Explicit replacement and reconciliation

- `POST /api/v1/platform/orgs/:id/billing/replacement` accepts only
  `subscriptionId` and an authorization `reason`. An active session-authenticated
  platform operator must name the current bound subscription. Stripe must report
  it canceled, with the same customer and matching organization metadata when
  present. This authorizes one replacement checkout for 24 hours; it does not
  cancel a subscription or submit payment. Cancellation is checked again before
  the new session request and at rebinding.
- The old subscription remains bound until current provider state matches the
  authorized attempt, company, customer and exact known price. Replacement
  completion and the new binding commit together. Completed replacement records
  retain the retired subscription ID, so delayed old events are audited and
  ignored. Repeated delivery is deduplicated; current provider state is retrieved
  under the company lock to avoid stale event snapshots rewinding access.
- `POST /api/v1/platform/orgs/:id/billing/reconcile` accepts `attemptId`, an actual
  `customerId` and/or `sessionId`, and `reason`. The operator reads the pending
  attempt from that company's billing audit/ledger and locates matching provider
  evidence. This endpoint retrieves and validates that evidence; it cannot mark
  an unknown request absent or force a new key. A recovered completed session is
  finalized by webhook redelivery or the company's Continue checkout action.
  Unresolved provider effects stay held for operator review.
- An expired replacement authorization can be renewed only before a session
  request was attempted. An expired session needs a new explicit replacement
  authorization. Active subscriptions cannot be replaced through this flow.

The new operator routes, checkout and portal require JSON, an authenticated
human session, and trusted browser Origin/Fetch Metadata when supplied.
Express case/slash aliases receive the same checks. Strict checkout input
rejects browser-supplied company, price, plan or trial parameters. Operator
identity is also rechecked inside the service transaction. Company reads use
authenticated tenant context and no-store responses.

Webhook verification uses the actual raw bytes. Signature failures return 400;
authenticated processing failures return 503 for redelivery, without exposing
raw provider errors. Transaction budgets are 3 seconds for lock acquisition,
15 seconds per SQL statement and 25 seconds of idle transaction time; the
replacement reconciliation path can perform two bounded provider reads.
See [Stripe webhook verification and delivery behavior](https://docs.stripe.com/webhooks),
[current Checkout Session retrieval](https://docs.stripe.com/api/checkout/sessions/retrieve)
and [current subscription retrieval](https://docs.stripe.com/api/subscriptions/retrieve).

## Customer experience and scope

Billing shows preparing, continue, authorized replacement, and operator review
states with an explicit refresh action. It preserves portal access and refreshes
durable status after a failed checkout request. Initial checkout says “Review
subscription in Stripe.” The unconditional 14-day trial was removed from new
checkout creation and copy because no such offer was approved. Existing trials,
the agreed $500 beta terms, manual/legacy access and the existing one-capability
entitlement policy are preserved. No higher-tier price or additional capability
is advertised as implemented.

The Impeccable workflow was applied as a scoped refinement of the existing
Billing surface. Its detector returned no findings. Final desktop/mobile visual
acceptance is coordinated by the parent agent.

## Verification

- Focused isolated database billing run: **49 passed, 1 skipped**, across durable
  checkout, entitlement reconciliation, HTTP billing lifecycle, entitlement HTTP
  and trusted return-origin tests. The skip is simultaneous initial claims on
  independent PostgreSQL connections; PGlite does not establish that lock proof.
  Other tests cover persisted leases, blocked overlapping callers, actual service
  reload, lost customer/session responses, retry-window and credential drift,
  cancellation-before-session, stale authorization, old-event handling,
  cross-company provider metadata, operator permissions and signature/processing
  error separation. Final combined billing/export rerun: **65 passed, 1 skipped
  in 7 files**, including subsequent review fixes.
- Billing component tests: **8 passed**, including explicit review/replacement
  states, refresh after failure, duplicate-click protection and truthful offers.
- Final API typecheck passed. The coordinator additionally reports all workspace
  typechecks and 393 UI tests green, plus eight Billing/lifecycle browser variants
  at 1440/390/320 light and 390 dark with no overflow, console or axe findings.
- Scoped `git diff --check` passed. No live provider acceptance is implied.

## Cross-review repair delivered in the lifecycle lane

Review found that export's final manager recheck and audit used an unbounded
shared pool outside its overall deadline. The entire export now uses its bounded
dedicated connection through snapshot, fresh authorization, audit and commit;
the current actor is row-locked through the audit. The 20-second deadline and
bounded cleanup retain their connection-slot limit even if closing stalls.

Review also found private export reads lacked the Origin/Fetch Metadata checks
used on mutations. Reads now reject untrusted credentialed origins, including
same-site hostile origins and Express case/slash aliases. Strict JSON applies
to mutations; same-origin downloads remain available.

The follow-up run passed **22 tests**: 10 lifecycle HTTP, 6 new export
deadline/cleanup tests and 6 billing HTTP tests. Regression covers stalled
post-snapshot authorization, audit and commit, revoked managers, stuck cleanup,
and a valid session cookie from an untrusted browser origin.

## Remaining external acceptance

1. Review and rehearse the additive schema migration, preserving this ledger
   and billing audit for dedupe/retired-binding history. Drain older application
   versions that lack durable checkout before enabling the new path.
2. Run real PostgreSQL concurrent claims and the exact candidate's full CI,
   builds and deployment-parity gate. Local service reload tests do not replace
   a multi-process hosted restart/kill rehearsal.
3. With explicit authorization, accept the correct Stripe test account, webhook
   endpoint/version, customer portal settings, actual price allowlist, signed
   completion/failure/redelivery and renewal/cancellation behavior. No configured
   price or test-mode provider operation was created in this work.
4. Confirm per-company commercial scope and payment authorization before live
   charging. The system does not auto-purchase a target $1,500 package, silently
   migrate beta terms, delete customer data or cancel billing on offboarding.
5. Operator recovery currently uses the audited API/ledger and provider evidence;
   there is no separate platform billing-reconciliation console. If the provider
   cannot establish the outcome of an old uncertain POST, it stays held.
