# Subscription control slice — October 1, 2026

## Delivered scope

One real capability is enforced: `revenue.autopilot`, the built-in automated
execution of previously approved BIE proposals. The internal catalog is version
1 with stable `beta`, `growth` and `scale` IDs. Beta does not include that
capability by default; Growth and Scale do. An explicit tenant grant can preserve
an already-agreed beta workflow. This does not implement every proposed package,
workflow quota, resource limit, add-on or channel entitlement.

Organizations gain one nullable `entitlements` JSONB policy. Null preserves
existing legacy access. No tenant is silently migrated, charged or downgraded.
An active platform operator must explicitly assign a known plan, policy source,
grant list and reason. Assignment and audit are atomic. Regular company owners,
viewers and API keys cannot assign themselves a tier; public organization
creation/update still whitelist ordinary company fields. The generic insert
schema additionally excludes billing and entitlement fields.

The coordinator integrated BIE activation, scheduler and final execution hooks.
Permissions, tenant membership, saved approval, configured policy, contact/source
eligibility and durable execution protections remain required. Downgrades hold
approved work before a claim and retain history. A revocation observed after a
claim blocks its effect. Existing uncertain effects remain subject to the
existing reconciliation rules. Manual approved work is outside this capability.

## Operator and tenant surfaces

- `GET /api/v1/billing/entitlements`: active members read their own server-derived
  capability decision, reason and scope. No query/body organization override.
- `POST /api/v1/platform/orgs/:id/entitlements`: existing session-only platform
  operator authorization is reused for an explicitly selected company. Strict
  input accepts `planId`, `source` (`manual` or `stripe`), `grants` and `reason`.
  Platform cross-company access is tested; tenant role access is denied.
- Existing billing status includes the same decision. Billing UI shows it,
  no longer labels unconfigured online billing a free beta, no longer invents
  a `Pro` plan, and preserves a failed status load as an error.

An example policy body for an agreed manual beta scope is:

```json
{
  "planId": "beta",
  "source": "manual",
  "grants": [],
  "reason": "Record the specific agreed founding beta workflow scope"
}
```

This is documentation, not an executed enrollment or an authorization to alter
any customer's agreement. A beta grant for this one capability is
`["revenue.autopilot"]` only when included in that company's recorded scope.

## Billing mapping and delivery reliability

`STRIPE_PLAN_PRICE_MAP` is a server-owned JSON allowlist mapping actual Stripe
price IDs to stable internal IDs. No prices were created or configured. The
existing `STRIPE_PRICE_ID` checkout must resolve through this map before it can
create a customer or session. Checkout still uses one server-selected price;
there is no customer-driven multi-tier selector in this slice.

The legacy `organizations.planTier` field retains the provider price ID;
`organizations.entitlements.planId` carries the stable internal ID. Existing
legacy and manually managed scope are not replaced by billing webhook events.
Explicit Stripe-managed enrollment requires an existing customer/subscription
binding and a matching known price.

Signed subscription events resolve a tenant by its persisted customer binding,
validate current subscription metadata/customer identity, acquire that tenant's
advisory transaction lock, retrieve current Stripe state, and atomically save it
with an audit event. The audit's Stripe event ID deduplicates delivery. Reading
current state under the lock prevents delayed snapshots from rewinding a plan.
Unknown prices, malformed mappings and ambiguous multi-item subscriptions cannot
unlock capability access. A mapped downgrade updates only explicitly
Stripe-managed policies; explicit grant evidence remains recorded.

The Stripe client has a 10-second timeout and zero automatic network retries.
Reconciliation transactions use local 3-second lock, 15-second statement and
20-second idle-transaction limits. Failures roll back for a later Stripe
redelivery. Mapping failures are recorded as an unmapped state for operator
repair rather than silently assigning an invented tier.

Stripe-managed capability access requires `active` or `trialing`, regardless of
the global optional billing paywall flag. `past_due`, `incomplete`, `unpaid` and
`canceled` pause this capability. Cancellation scheduled for period end remains
active until current Stripe status ends. This strict policy must be part of
scope acceptance before enabling Stripe-managed entitlement enforcement.

## Verification

- Synthetic fresh-schema database tests: entitlement decision/assignment and
  tenant roles, real HTTP middleware guards, real Stripe signature verification
  with mocked provider operations, mapping failure, upgrade/downgrade, duplicate
  and old event handling, cancellation, failure rollback, customer binding and
  unmapped checkout rejection. The final selected run passed **40 tests in 5
  files**, including the route-inventory and existing billing-origin checks.
- Billing UI: 4 component tests passed for truthful scope, current plan,
  unavailable status, canceled-subscription management and absence of invented
  free/Pro claims. Browser QA identified scoped light badge/dark button contrast
  repairs, which were applied for the coordinator's final browser recheck.
- API typecheck passed after the additive schema and route tests.
- Exact aggregate BIE/full-suite counts and release SHA belong to the parent
  integration report. These local checks are not Stripe test-mode acceptance,
  production proof or multi-process PostgreSQL lock acceptance.

## Remaining boundaries

- No enrollment, subscription mutation, Stripe purchase, live provider call,
  deployment or customer communication was performed.
- Known-price allowlist and customer scope require explicit operator setup;
  historical tenants remain in legacy access until reviewed.
- A different subscription ID cannot overwrite an existing bound subscription,
  including after cancellation. Re-subscription/replacement requires operator
  reconciliation; that administrative rebind flow is not implemented here.
  Checkout is blocked before any provider call whenever a subscription is
  already bound, including canceled subscriptions. Billing status disables
  checkout and HTTP 409 directs the operator to the portal/reconciliation path.
- General usage metering, paid add-ons, workflow/resource quotas, other feature
  gates, plan purchase selection and a platform assignment UI remain pending.
- Mapping/policy failures are visible in capability state and billing audit;
  a dedicated billing alert/reconciliation console remains future work.
- Durable deduplication uses audit history. Retention/offboarding must preserve
  billing dedupe evidence for the applicable lifecycle period; subscription
  reconciliation still reads current state if a previously recorded event is
  redelivered after such evidence is removed.
- Initial checkout customer creation still has its existing reconciliation
  limitation under a lost provider response; this work does not claim the full
  billing lifecycle is ready for live charging.

## Primary references

- [Stripe webhook verification, delivery order and duplicate handling](https://docs.stripe.com/webhooks)
- [Retrieve current subscription](https://docs.stripe.com/api/subscriptions/retrieve)
- Installed `stripe` 22.4.0 `esm/lib.d.ts` and `README.md` for `timeout` and
  `maxNetworkRetries` options.
