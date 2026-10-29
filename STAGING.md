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
