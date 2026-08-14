# GrowthOS staging runbook

Staging is a separate Fly app and a separate logical Postgres database. It must
never share production's `DATABASE_URL`, session secret, customer data, custom
domain, or OAuth credentials.

## Fixed identities

| Environment | Fly app | Config | Origin |
|---|---|---|---|
| Staging | `mogulforge-growthos-staging` | `fly.staging.toml` | `https://mogulforge-growthos-staging.fly.dev` |
| Production | `mogulforge-growthos` | `fly.toml` | `https://app.mogulforge.ai` |

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
4. Keep `ENABLE_DEV_LOGIN` unset.
5. Add provider credentials only when that integration is actively under test.
   Use non-production OAuth clients and Stripe test mode.

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

## Acceptance before production

- Health endpoint returns 200 after a cold start.
- Unknown signup is rejected with `BETA_INVITE_REQUIRED`.
- An allowlisted beta owner can register and create an organization.
- An invited teammate can register into that organization without being
  allowlisted.
- Two organizations cannot read or mutate one another's records.
- A member can update their own display name but cannot change role or status.
- Gmail connection, send, disconnect, and revocation use a staging OAuth client.
- Logs contain no passwords, session cookies, OAuth tokens, or customer content.
- Backup and restore are exercised against staging data.
