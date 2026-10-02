# GrowthOS private beta operations wave

Owner authorization: October 1, 2026, complete the proposed desktop-independent
engineering work. Base: verified green `298b23a` (PR #8). Working branch:
`agent/growthos-beta-operations`. This is an engineering candidate; live activation
still requires provider access, actual business configuration and release review.

## Ownership

| Lane | Owner | Deliverable |
| --- | --- | --- |
| Billing | subscription_controls | Durable checkout retry/reconciliation, explicit replacement, truthful billing UI |
| Customer lifecycle | release_audit | Defined core export, audited pause/offboarding request and settings UI |
| Website adapter | opportunity_history | Reusable encrypted site delivery journal and CSS implementation |
| Integration | root | Runtime pause boundaries, two-company rehearsals, browser checks, schema review and full CI |

Each worker owns its files; shared schema/router/inventory wiring belongs to the
coordinator. Cross-review follows implementation. Preserve GEEKOM's Microsoft
provider lane and the first wave's source-history and entitlement controls.

## Named-company preparation

Painless Roofing and Water Restoration uses the roofing/exteriors profile;
Climate Simulation Solutions uses HVAC. Both are limited $500 beta prospects by
owner report. Domains, actual source access, approved offerings, service areas,
responders, business hours and starting conversion metrics are still unknown.
Synthetic fixtures may use these names with an explicit rehearsal suffix; they
must not be described as customer activation or real revenue.

The HVAC site keeps Book Service and office approval. Both website types use the
same server-side credential contract. The Node adapter requires persistent local
storage for its encrypted journal; it is not a serverless deployment declaration.

## Acceptance

- Concurrent/restarted checkout cannot invent a second provider request; unknown
  effects require reconciliation, and retired subscription events cannot rebind.
- Ordinary tenant sessions can export only the explicitly listed datasets for
  their own company. Secrets/opaque provider configuration remain excluded.
- Pause preserves not-yet-dispatched work. Requests already handed to providers
  may finish or require reconciliation; no blind retry after uncertainty.
- Rehearse each synthetic company from isolated draft through guarded intake,
  request retry, staff ownership/response, office-created appointment, estimate,
  and accurately labeled outcome. Test failures and cross-company denials.
- Actual component/browser checks cover mobile, desktop, error and pending states.
- Record exact-head CI, test counts/skips, builds, Docker parity and remaining
  live gates before declaring the engineering candidate verified.
