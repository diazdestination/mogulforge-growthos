# GrowthOS staging operations

Updated October 29, 2026. Staging uses a separate app, database, credentials and
synthetic TEST records. It must not borrow production sessions/data or enable
real outbound effects merely because a fixture uses a contractor name.

## Before an acceptance window

Verify account/org, app/Machine, exact image/source/schema, secret names,
writer/scheduler/outbound controls and the finite approved window. Existing
staging availability does not renew an expired setup/seed window or authorize a
new test record. Preserve original intent/results and uncertain operations.

Use the reviewed SQL/source/target/recovery process. Generic release-schema and
automatic forced reconciliation remain refused. Do not use force push or
AUTO_MIGRATE as a substitute for reviewed migration and backup custody.

## Bounded email acceptance controls

Only a separately approved finite real-email test window may release the hold.
Verify that the runtime is recognized as staging by its actual FLY_APP_NAME or
APP_ORIGIN; do not assume a descriptive environment label enforces these guards.
The current [outbound guard](artifacts/api-server/src/services/outbound-hold.ts)
requires all of the following together:

- `GROWTHOS_OUTBOUND_HOLD=false` for that authorized window.
- `STAGING_OUTBOUND_APPROVED=true`.
- `STAGING_EMAIL_RECIPIENT_ALLOWLIST` containing no more than 20 exact approved
  test mailboxes, comma-separated. Empty/malformed lists, domains, wildcards,
  display names and recipient/header lists do not authorize delivery.

The recipient allowlist is independent of BETA_SIGNUP_ALLOWLIST. It does not
select a sender, grant customer consent or bypass the actual provider/tenant
checks. Keep credentials scoped to the integration and synthetic company under
test, with ENABLE_DEV_LOGIN unset.

Keep the scheduler stopped for manual email checks. Releasing the shared
outbound hold also releases non-email guards, so keep SMS, voice and external
webhook integrations unconfigured or independently disabled until their own
approved test window. Restore `GROWTHOS_OUTBOUND_HOLD=true` immediately after the
bounded checks and verify restoration. Record provider acceptance separately
from inbox arrival. See [the existing guard tests](artifacts/api-server/src/services/outbound-hold.test.ts).

## What staging can establish

Record exact source, fictional organization/site/user identities, actual signed
in or API behavior, test outcomes and cleanup. Carrier/provider acceptance and
what a physical handset saw require their separate receipts. A completed script
can still contain failed, blocked or not-run cases.

Held synthetic staging is not a successful contractor cutover. Each actual
provider/company/device/workday, full migration and recovery gate remains open
until separately evidenced. See [CURRENT-BUILD.md](CURRENT-BUILD.md),
[DEPLOY.md](DEPLOY.md) and [RUNBOOK.md](RUNBOOK.md). Dated staging reports/preflight
documents retain historical checkpoints, not fresh execution authority.
