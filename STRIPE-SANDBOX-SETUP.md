# GrowthOS Stripe sandbox setup

This candidate includes the source for platform subscription billing and contractor
invoice collection. They use separate configuration. Provider acceptance remains
pending; a connected ChatGPT Stripe app alone does not configure the GrowthOS server.

## Contractor invoice collection

Use an isolated Stripe sandbox and disposable/non-customer GrowthOS database.
Store a restricted sandbox key in the environment's secret vault as
`STRIPE_CONNECT_SECRET_KEY`. Set `STRIPE_CONNECT_ENABLED=true` only for the
approved sandbox exercise. Live keys are refused by this candidate.

Configure a connected-account event destination for the exact sandbox origin:
`/api/billing/connect-webhook`. Store its signing secret separately as
`STRIPE_CONNECT_WEBHOOK_SECRET`. Subscribe to `account.updated`,
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed` and `checkout.session.expired`.
The endpoint verifies the raw request signature and rejects live-mode events.

The public origin must be the tested `APP_ORIGIN`/`APP_BASE_URL`, with reachable
`/pay/complete` and `/pay/canceled` pages. Those pages acknowledge the return;
only validated provider evidence records cash. Payment methods come from the
sandbox's Stripe settings. Verify card and US bank eligibility separately.

The outbound hold covers onboarding, account refresh, session creation and recovery.
Use an approved finite test window; actual staging also requires its existing
`STAGING_OUTBOUND_APPROVED=true` policy and `GROWTHOS_OUTBOUND_HOLD=false`.
Keep scheduler autostart disabled and other outbound providers disabled.
Restore the outbound hold when the test window ends.

## Recovery and acceptance

One durable invoice reservation covers creation, open Checkout and bank clearing.
Manual balance changes are blocked while a collection could still occur. A failed
create is an unknown outcome, not permission to issue another payment link.

Staff use **Check original payment** to recover the original request within a
23-hour safety window using its original idempotency key. After that window,
provide the exact original sandbox Checkout session ID from Stripe. Recovery
checks the connected account, sandbox mode, reservation metadata, amount and
currency. **Close unpaid link** releases a reservation only after Stripe confirms
that the original unpaid session expired. A clearing bank payment remains held.

If Stripe confirms settlement but automatic receipt recording fails, staff may
review the invoice and record the confirmed cash using the displayed exact receipt
reference. Check the original payment again to recognize the matching invoice
allocation. An unknown create with no recoverable session remains held for operator
review; never declare absence from an incomplete dashboard search.

Prove: successful sandbox card payment; delayed bank submission/success/failure;
duplicate/out-of-order signed events; interrupted Checkout recovery; concurrent
creation; confirmed unpaid expiry; unrelated tenant/session refusal; restored hold.
Record actual sandbox account IDs, source SHA, event IDs and test results without
keys, signing secrets, customer data or full Checkout URLs in shared receipts.

## Platform subscriptions and production

Platform subscriptions retain `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`,
`STRIPE_PLAN_PRICE_MAP` and `STRIPE_WEBHOOK_SECRET` (`/api/billing/webhook`).
Do not populate these just to enable contractor collection. `BILLING_ENFORCE`
remains a separate opt-in paywall setting. Commercial prices and tax registrations
must come from the owner; this setup invents neither.

Production collection is intentionally unavailable in this sandbox candidate.
Before a live implementation: complete sandbox provider acceptance, review current
Accounts v2 onboarding/capability/event requirements and migration for the existing
v1-style source, establish account ownership and approved commercial terms, finish
refund/dispute/settlement operations, and review exact hosted schema/recovery/source
and configuration. Local tests and a green source PR do not authorize a deployment,
live account changes, customer charges or legal submissions. Shopify Payments is
configured separately in Shopify and does not use these GrowthOS secrets.
