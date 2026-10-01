# GrowthOS staging runbook

Staging is a separate Fly app with a separate managed Postgres cluster and application user. It must
never share production's `DATABASE_URL`, session secret, customer data, custom
domain, or OAuth credentials.

Read [the current staging preflight](STAGING-PREFLIGHT-2026-09-30.md) before
using this runbook. Historical app bindings must not be assumed isolated.

September 30 evening: the reviewed schema, managed restore drill and held
`c050067` application cutover passed. The temporary recovery cluster was
deleted. The current exact identities and dated outcomes are in the
[controlled-pilot ledger](reports/controlled-pilot-2026-09-30.md). Do not rerun
one-time provisioning merely because its instructions remain below.

## Fixed identities

| Environment | Fly app                       | Config             | Origin                                        |
| ----------- | ----------------------------- | ------------------ | --------------------------------------------- |
| Staging     | `mogulforge-growthos-staging` | `fly.staging.toml` | `https://mogulforge-growthos-staging.fly.dev` |
| Production  | `mogulforge-growthos`         | `fly.toml`         | `https://app.mogulforge.ai`                   |

Both configs reserve `min_machines_running = 1` so scheduled work can run while
the app is idle. Staging is deliberately stopped during database/provider
preflight; keep its scheduler and outbound holds enabled until the specific
acceptance step is authorized.

## One-time provisioning gate

Provisioning can create Fly charges. Do not run these steps until the owner has
approved the estimated cost.

1. Create the staging Fly app named exactly `mogulforge-growthos-staging`.
2. Use the dedicated staging cluster, database and application user documented
   in the current preflight. A different database name on a shared cluster
   does not establish the required privilege isolation.
3. Set staging-only secrets:
   - `DATABASE_URL`
   - `SESSION_SECRET`
   - `BETA_SIGNUP_ALLOWLIST` containing the owner/tester emails permitted to
     create new organizations
   - `RESEND_API_KEY` for a staging-scoped Resend key
   - `RESEND_FROM_EMAIL` using a verified MogulForge staging sender
   - `RESEND_WEBHOOK_SECRET` copied securely from this staging endpoint's
     Resend webhook configuration; unsigned requests are rejected in every
     environment
4. Keep `ENABLE_DEV_LOGIN` unset.
5. Add provider credentials only when that integration is actively under test.
   Use non-production OAuth clients and Stripe test mode.

The Resend channel above belongs to MogulForge and is used only for account
verification, password recovery, and invitations. Each beta user connects their
own Gmail separately for their business outreach. A user's Gmail credential is
never used as the platform fallback for identity email.

Invited teammates do not need to appear in `BETA_SIGNUP_ALLOWLIST`; an
organization owner pre-approves them from the in-app invite flow.

## Bounded email acceptance

Staging real email dispatch requires all three settings together:

- `GROWTHOS_OUTBOUND_HOLD=false` for the authorized test window.
- `STAGING_OUTBOUND_APPROVED=true`.
- `STAGING_EMAIL_RECIPIENT_ALLOWLIST` containing a comma-separated list of at
  most 20 exact approved test inboxes. An empty or malformed list blocks all
  staging email. Domains, wildcards, display names, recipient lists and
  header injection do not authorize a recipient. This list is independent
  of the signup allowlist and applies to both Resend and connected Gmail.

Keep the scheduler stopped for manual email acceptance. Releasing the shared
outbound hold also releases its non-email guards, so leave SMS, voice and
external webhook integrations unconfigured until their separate test window.
Restore the outbound hold immediately after the controlled email checks.

Register the Resend endpoint as
`https://mogulforge-growthos-staging.fly.dev/api/v1/public/webhooks/resend`.
Verification uses the original request body, a `whsec_` signing secret,
Svix `v1` signatures and a five-minute timestamp tolerance. Database errors
return failure to the provider for retry; durable delivery/suppression writes
commit together, and repeated terminal callbacks do not duplicate activities.

Resend delivery correlation currently covers existing Resend playbook touches:
the provider ID must resolve unambiguously to the same provider/channel and
recipient in one tenant. Unknown IDs and changed contact addresses cannot
suppress contacts by address. Platform account emails have no playbook touch;
their live acceptance must record the external Resend receipt and inbox result
separately until a platform receipt ledger is implemented. Gmail does not use
this Resend webhook. If the provider account contains other products, configure
this as a GrowthOS-only endpoint and signing secret. Unknown provider IDs are
acknowledged without storing message bodies or creating cross-product records.

Only a permanent Resend bounce or complaint creates a permanent suppression.
Transient, unknown and delayed failures are visible as delivery states requiring
review and can later recover to delivered. Customer email sender setup is
documented in [Customer email pilot](CUSTOMER-EMAIL-PILOT.md).

## Explicit deploy commands

Never use a bare `fly deploy`. Always name both the app and config:

```powershell
# Staging
fly deploy --app mogulforge-growthos-staging --config fly.staging.toml

# Production (only after staging acceptance)
fly deploy --app mogulforge-growthos --config fly.toml
```

The duplicate app identity is deliberate. If a config file is edited to point at
the wrong environment, the explicit `--app` value makes the mismatch visible
instead of silently selecting another target.

## Fast Docker staging-parity gate

Before publishing a release candidate or deploying to Fly, run the production
image against a clean, restricted PostgreSQL role:

```powershell
./scripts/verify-docker-staging-parity.ps1
```

This isolated gate builds the same Dockerfile used by Fly, creates a
provider-owned `pg_stat_monitor` view, applies the GrowthOS schema as a
non-owner application role, starts the production image, and verifies health,
login, signup, and password-recovery routes. It deletes its containers, network,
and database volume after the run. Pass `-Keep` only when the failed stack needs
manual inspection.

The parity gate catches application, schema, permission, and production-image
failures locally. Real Fly networking, secrets, OAuth callbacks, DNS, Resend,
and Gmail behavior still require staging acceptance.

## Acceptance before production

- Health endpoint returns 200 after a cold start.
- Unknown signup is rejected with `BETA_INVITE_REQUIRED`.
- An allowlisted beta owner receives a verification email, cannot sign in
  before verifying, and can create an organization afterward.
- An invited teammate can register into that organization without being
  allowlisted.
- Password recovery returns the same response for known and unknown emails;
  its link works once, expires, and revokes existing sessions after reset.
- Two organizations cannot read or mutate one another's records.
- A member can update their own display name but cannot change role or status.
- Gmail connection, send, disconnect, and revocation use a staging OAuth client.
- Logs contain no passwords, session cookies, OAuth tokens, or customer content.
- Backup and restore are exercised against staging data.
