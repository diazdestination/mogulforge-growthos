# GrowthOS staging preflight — September 30, 2026

Status: **separate staging cluster provisioned; deployment and provider
activation still blocked**. The original inventory below was read-only against
the previously green `15d9704507325a98c0fd719d15b9ac841ea68f0b`
candidate. Safety commit `ee903b3f8502e27452bcb22a341a1ea4c07937b0`
subsequently passed [exact-head CI](https://github.com/diazdestination/mogulforge-growthos/actions/runs/36789655005).
Host-pinning commit `3d54f766560e22f8a14ca51d9809064c8801ca11`
also passed [exact-head CI](https://github.com/diazdestination/mogulforge-growthos/actions/runs/36802652403)
(1,387 passed, 15 skipped; types, builds and Docker parity green). No staging
app was started or accepted; subsequent changes require their own exact-head CI.

## Owner-approved isolated resource — later September 30 update

The owner approved a separate Fly Managed Postgres Basic cluster at the
[published $38/month plus storage](https://www.fly.io/docs/mpg/).
`mogulforge-growthos-staging-db`
(`zp2wjrejd2zodn4q`) was created in `iad` with the minimum 10 GB storage.
Fly reported status `ready`, plan `basic`, disk `10`; the published base is
approximately $40.80/month ($38 + 10 × $0.28), excluding other charges. It is
separate from production cluster `kzpwm0j18eg04nv3`. The new cluster contains
its own `growthos_staging` database and `growthos-staging-live` user. Passwords
were not printed, copied into files or committed. The new user currently has
`schema_admin` within **only the new cluster**; least-privilege runtime-role
separation remains future hardening.

No application was attached to the new cluster, no data was copied, no schema
was applied, and no send occurred. `fly mpg attach` is intentionally deferred:
it sets `DATABASE_URL` and triggers a deployment, which could start the old
staging image before the safety and schema gates are satisfied. The stopped
staging app still has its old shared-cluster secret until a controlled cutover.
Fly lists an initial full backup as completed; no restore drill has been run,
and that empty-cluster backup does not prove recovery of GrowthOS data.
The owner later approved a temporary third cluster **if genuinely necessary**
for a full managed-backup restore drill. Fly's managed restore creates a new,
separately billed cluster; doing that now with an empty backup would prove
little. The staged synthetic-fixture plan and narrower no-third-cluster
logical rehearsal are in
[`reports/p0-6-restore-drill-plan-2026-09-30.md`](reports/p0-6-restore-drill-plan-2026-09-30.md).

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

1. **The stopped app is still bound to the old shared cluster.** The earlier
   staging and production logical databases are on the same Managed Postgres
   cluster. The old staging login has Fly's `schema_admin` role. Fly documents
   this role as able to read, write,
   change schema and connect across **all databases** in a cluster. A distinct
   database name and login therefore do not prevent a staging credential from
   reaching production data. The new app boot guard and release-command guard
   reject a wrong configured host/database/session, but they are defense in depth,
   not a substitute for database-level isolation. The owner-approved new
   cluster resolves the _resource_ problem, but the app must be safely cut
   over and its new host asserted before a staging release. Do not use
   `fly mpg attach` on the stopped old image as a shortcut.
2. **No reviewed schema delta or restore proof.** `fly.staging.toml` invokes
   `scripts/release-schema.mjs` on deploy, and that script uses
   `drizzle-kit push --force`. The new `STAGING_SCHEMA_PUSH_APPROVED=false` gate
   deliberately makes an ordinary staging deploy fail before schema changes.
   A generated initial-source SQL preview is preserved under
   `reports/staging-schema-preview-2026-09-30/`: 90 new tables, no destructive
   statements and no Fly schema change. The installed Drizzle Kit does not
   support `push --explain`, so this is **not** the verified Fly push delta or
   approval to apply it. Review the exact schema operation, take/verify the
   backup and demonstrate a restore before an operator explicitly permits a
   release command. Do not
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

1. Keep the draft PR unmerged and the staging app stopped. Re-run exact-head
   GitHub CI after each later code or runbook change.
2. Verify a safe app-secret cutover method that cannot start the old image.
   Do not point a paid-beta staging app at the shared production cluster merely
   because its URL names a different DB.
3. Review the initial SQL preview and restoration plan with the isolated database;
   verify pool mode and provider-test identities. Keep customer sends and the
   scheduler held during the initial app/health inspection.
4. Only then request the separate release/provider approvals in
   `PAID-BETA-READINESS-P0.md` and record exact SHA, image and acceptance
   results. The owner approved the separate Basic staging cluster and a
   conditional short-lived restore cluster when meaningful backup data exists;
   this did not approve provider sends, production deployment or customer
   traffic.

The reusable read-only script is `scripts/staging-readonly-preflight.mjs`. It
prints counts and non-secret identity only; it does not certify isolation or
restore readiness.
