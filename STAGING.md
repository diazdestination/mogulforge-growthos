# GrowthOS staging runbook

Staging is a separate Fly app and a separate logical Postgres database. It must
never share production's `DATABASE_URL`, session secret, customer data, custom
domain, or OAuth credentials.

## Fixed identities

| Environment | Fly app                       | Config             | Origin                                        |
| ----------- | ----------------------------- | ------------------ | --------------------------------------------- |
| Staging     | `mogulforge-growthos-staging` | `fly.staging.toml` | `https://mogulforge-growthos-staging.fly.dev` |
| Production  | `mogulforge-growthos`         | `fly.toml`         | `https://app.mogulforge.ai`                   |

Both configs use `min_machines_running = 0`. Staging should stay stopped when
it is not being tested.

## One-time provisioning gate

Provisioning can create Fly charges. Do not run these steps until the owner has
approved the estimated cost.

1. Create the staging Fly app named exactly `mogulforge-growthos-staging`.
2. Create a dedicated logical database and database user for staging. Reusing
   the existing managed Postgres cluster is acceptable for the founding beta,
   but reusing production's database name or connection URL is not.
3. Set staging-only secrets:
   - `DATABASE_URL`
   - `SESSION_SECRET`
   - `BETA_SIGNUP_ALLOWLIST` containing the owner/tester emails permitted to
     create new organizations
   - `RESEND_API_KEY` for a staging-scoped Resend key
   - `RESEND_FROM_EMAIL` using a verified MogulForge staging sender
4. Keep `ENABLE_DEV_LOGIN` unset.
5. Add provider credentials only when that integration is actively under test.
   Use non-production OAuth clients and Stripe test mode.

The Resend channel above belongs to MogulForge and is used only for account
verification, password recovery, and invitations. Each beta user connects their
own Gmail separately for their business outreach. A user's Gmail credential is
never used as the platform fallback for identity email.

Invited teammates do not need to appear in `BETA_SIGNUP_ALLOWLIST`; an
organization owner pre-approves them from the in-app invite flow.

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
