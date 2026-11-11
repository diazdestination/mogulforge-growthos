# GrowthOS Stripe payments setup (test and live)

Contractors collect invoice payments (card and US bank) through **their own**
Stripe account via Stripe Connect (Standard accounts). Money settles straight to
the contractor; MogulForge never holds funds. A deployment runs in exactly one
mode: **test** (the default, no real money) or **live**. Switching is
configuration only.

Platform subscription billing is separate (`STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `/api/billing/webhook`) and never enables collection.

## Environment variables

| Variable | Test | Live |
| --- | --- | --- |
| `STRIPE_CONNECT_ENABLED` | `true` | `true` |
| `STRIPE_CONNECT_MODE` | `test` (or unset) | `live` |
| `STRIPE_CONNECT_SECRET_KEY` | `sk_test_…` or `rk_test_…` | `sk_live_…` or `rk_live_…` |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | signing secret of the **test** endpoint | signing secret of the **live** endpoint |
| `STRIPE_CONNECT_LIVE_CONFIRMED` | not needed | `true` (required when `NODE_ENV=production`) |
| `STRIPE_CONNECT_APPLICATION_FEE_BPS` | optional platform fee in basis points (0 = none, max 2000) | same |
| `APP_BASE_URL` / `APP_ORIGIN` | public origin (Stripe returns to `/settings`, `/pay/complete`, `/pay/canceled`) | same |

A key that does not match the mode (a live key in test mode, a test key in live
mode), a missing webhook secret, or live in production without the confirm flag
is refused as `not_configured`: the server logs the reason at startup, payment
links and onboarding are refused, the webhook answers 404, and Settings →
Connections shows the reason to the owner. Keys are never shown or logged.
Keep keys and secrets in the deployment's secret vault only. A restricted key
needs write access to Accounts, Account Links and Checkout Sessions.

## Stripe dashboard settings (once per mode)

1. **Connect → Settings**: enable Connect for the platform, allow **Standard**
   accounts, and set the platform's branding and support details.
2. **Connect onboarding**: allow the business types your contractors use
   (individual and company), United States.
3. **Payment methods** for connected accounts: enable Cards and
   **ACH Direct Debit** (US bank account).
4. **Developers → Webhooks → Add endpoint**: URL
   `https://<your app origin>/api/billing/connect-webhook`, listen to
   **events on Connected accounts**, and select:
   - `account.updated`
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `charge.refunded`
   - `charge.dispute.created`
   - `charge.dispute.closed`

   Put that endpoint's signing secret in `STRIPE_CONNECT_WEBHOOK_SECRET`. Test
   and live endpoints are separate in Stripe and have different secrets.

## How it behaves

- **Onboarding**: Settings → Connections → *Card & bank payments* shows
  Not started / Needs info / Ready / Restricted. The owner clicks *Start* (or
  *Continue*) *Stripe setup*, finishes Stripe's hosted onboarding and lands back
  in Settings. `account.updated` keeps the status current. Pay links can only be
  made once Stripe enables charges; techs and the office see a plain reason
  otherwise. Each company has a separate connected account per mode.
- **Webhook**: signature-verified; events from the other mode are refused;
  each event id is processed once (duplicates and replays change nothing);
  out-of-order events cannot rewind a payment or an account's status; unknown
  events are acknowledged and ignored. A paid Checkout is recorded on the
  invoice once, through the normal payment-recording path.
- **Refunds and disputes** are flagged on the payment for office review with
  an audit event. The invoice balance is never changed automatically; the
  office records the refund (or lost dispute) on the invoice after review.
- **Failures**: a create Stripe certainly never ran (rate limit, rejected key)
  is released so staff can try again. Anything else that might have created a
  link is held; *Check original payment* reuses the original idempotency key
  (within 23 hours) or asks for the exact Checkout session id.
- The outbound safety hold (`GROWTHOS_OUTBOUND_HOLD`) still blocks every Stripe
  request. Field techs collect only on invoices linked to their own assigned
  job (`services/field-collect.ts`).

## Test-mode check

With test keys: connect a Stripe test account from Settings, finish onboarding
with Stripe's test data, create a pay link on an issued invoice, pay with card
`4242 4242 4242 4242`, and confirm the invoice shows the payment. Also try a
bank payment, an expired link, a refund, and a dispute (test card
`4000 0000 0000 0259`) from the Stripe test dashboard.

## Go-live steps

1. In the **live** Stripe dashboard, repeat the dashboard settings above and add
   the live webhook endpoint.
2. Set `STRIPE_CONNECT_MODE=live`, the live `STRIPE_CONNECT_SECRET_KEY`, the
   live endpoint's `STRIPE_CONNECT_WEBHOOK_SECRET` and
   `STRIPE_CONNECT_LIVE_CONFIRMED=true`, then restart. The startup log should
   say `Stripe Connect collection configured` with `mode: live`.
3. Each contractor re-runs onboarding in live (Settings → Connections → *Start
   Stripe setup*). Test accounts do not carry over; open test-mode pay links are
   retired, and no test payment is ever recorded in live.
4. The owner makes **one small real payment** (for example $1 on an issued
   invoice to their own company) with their own card, confirms it is recorded on
   the invoice and shows in the Stripe live dashboard, then refunds it in Stripe
   and confirms the refund is flagged for review.

To go back to test, set the mode and keys back to test; live records stay as they are.
