# GrowthOS staging preflight — September 30, 2026

Status: **blocked for deployment and provider activation**. This is a read-only
inventory against the previously green `15d9704507325a98c0fd719d15b9ac841ea68f0b`
candidate, not acceptance of the new local safety changes, the running app, or
production. The current changes need their own exact-head CI result.

## Evidence gathered without starting the staging app

- Fly app `mogulforge-growthos-staging` has one stopped Machine in `iad`; remote
  `min_machines_running` was `0` and its image predates the current candidate.
  The database inspection used an ephemeral `fly console` Machine with no app
  process, no scheduler and a read-only SQL transaction. The console printed
  the result, then the Windows CLI reported `The handle is invalid` during
  teardown. A subsequent Machine list showed only the original stopped Machine.
- The staging secret's connection target identified logical database
  `growthos_staging` and login `growthos-staging-live`. SQL confirmed
  `current_database()=growthos_staging` and
  `session_user=growthos-staging-live`. Password and URL were never printed.
- The database was not synthetic-only: 2 organizations, 2 contacts (including
  an address on a public mail domain), 5 staff users (all on a public mail
  domain), and 3 leads. Four scheduled actions were already `done`; no pending
  scheduled action, reactivation campaign, webhook delivery, active webhook
  endpoint, abandoned-chat candidate or imminent API-key reminder was found at
  inspection time. These counts can change and are not a standing clearance.
- A `RESEND_API_KEY` secret name exists on the staging app. Its value was not
  read. No live email, text, call, webhook, scheduler cycle or customer-data
  mutation was performed.
- The Managed Postgres cluster has recent completed backups, but no restore
  drill was witnessed. The actual PgBouncer pool mode was not verified. Fly's
  [cluster documentation](https://www.fly.io/docs/mpg/cluster-configuration/)
  says Session mode is the default and is compatible with advisory locks; the
  default is not evidence of this cluster's current setting.

## Release blockers

1. **No strict database privilege isolation.** Staging and production logical
   databases are on the same Managed Postgres cluster. The staging login has
   Fly's `schema_admin` role. Fly documents this role as able to read, write,
   change schema and connect across **all databases** in a cluster. A distinct
   database name and login therefore do not prevent a staging credential from
   reaching production data. The new app boot guard and release-command guard
   reject a wrong configured database/session, but they are defense in depth,
   not a substitute for database-level isolation. Resolve this before a
   customer-facing paid-beta staging release. A separate cluster would add
   recurring cost and needs owner approval; do not create one by inference.
2. **No reviewed schema delta or restore proof.** `fly.staging.toml` invokes
   `scripts/release-schema.mjs` on deploy, and that script uses
   `drizzle-kit push --force`. The new `STAGING_SCHEMA_PUSH_APPROVED=false` gate
   deliberately makes an ordinary staging deploy fail before schema changes.
   Review the exact schema delta, take/verify the backup and demonstrate a
   restore before an operator explicitly permits a release command. Do not
   casually persist the approval flag between releases.
3. **Real recipient and provider risk.** The staging DB contains non-test mail
   domains and a Resend secret is configured. The new
   `GROWTHOS_OUTBOUND_HOLD=true` guard blocks actual email, SMS, outbound voice
   and webhook dispatch; `STAGING_OUTBOUND_APPROVED=false` makes staging fail
   closed even if the hold flag is accidentally missing or set false. The
   scheduler remains off. These code guards must pass CI and be deployed before
   they can protect a running environment. Do not release the hold for a real
   provider test until recipient/sender identities and consent are approved.
4. **Scheduler acceptance not yet observed.** The staged app is stopped, the
   pool mode is unverified, and no real-PostgreSQL idle/restart/failure drill
   has been run. P0-2 and P0-3 remain red.
5. **Other staging identity gates remain unproved.** Distinct session secret,
   OAuth clients, provider test credentials, Stripe test mode and allowlist
   were not authenticated end to end in this inspection. The presence of
   secret names alone is not evidence that they are isolated or usable.

## Safe next sequence

1. Run local tests, builds, Docker parity and exact-head GitHub CI for the
   safety commit. Keep the draft PR unmerged.
2. Decide on a genuinely isolated staging database topology and approve any
   additional recurring spend. Do not point a paid-beta staging app at the
   shared production cluster merely because its URL names a different DB.
3. Review the migration diff and restoration plan with that isolated database;
   verify pool mode and provider-test identities. Keep customer sends and the
   scheduler held during the initial app/health inspection.
4. Only then request the separate release/provider approvals in
   `PAID-BETA-READINESS-P0.md` and record exact SHA, image and acceptance
   results. This report does **not** authorize deployment, traffic or spend.

The reusable read-only script is `scripts/staging-readonly-preflight.mjs`. It
prints counts and non-secret identity only; it does not certify isolation or
restore readiness.
