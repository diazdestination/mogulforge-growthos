# GrowthOS operating entry points

Updated October 29, 2026. Start with [CURRENT-BUILD.md](CURRENT-BUILD.md),
[PROJECT_STATE.md](PROJECT_STATE.md) and [NEXT_ACTIONS.md](NEXT_ACTIONS.md).
Use current source/identity checks and isolated worktrees. Older runbooks and
plans are indexed as historical; their once-intents/approvals are not reusable.

## Local operations

Use Node 22 or 24, pnpm 11.3.0 and the frozen lockfile:

```powershell
node scripts/local-dev.mjs setup
node scripts/local-dev.mjs run
node scripts/local-dev.mjs test
node scripts/local-dev.mjs ui
node scripts/local-dev.mjs typecheck
```

Run is an outbound-held fictional preview at 127.0.0.1:4193. Test owns its
disposable PostgreSQL 16 and excludes provider credentials; selected API files
can follow `test`. UI/typecheck are local checks. See [DEV-LOCAL.md](DEV-LOCAL.md)
for cleanup, optional browser/parity actions and legacy Compose distinctions.
These commands do not deploy, activate providers or migrate a hosted database.

## Runtime and source checks

Current code is a single production app image: Vite UI plus Express API on 3001,
backed by PostgreSQL. Exact image/source, schema, database binding, secret names,
writer/scheduler/outbound holds and recovery custody must be checked together.
Do not print secrets, request the app URL merely to inspect a stopped Machine,
or infer deployed settings from fly.toml. Configured scheduler minimums are not
actual live scheduler proof.

## Release and recovery

Read [DEPLOY.md](DEPLOY.md), [BETA-LAUNCH.md](BETA-LAUNCH.md) and
[STAGING.md](STAGING.md). Automatic generic schema reconciliation is retired;
the release-schema command deliberately refuses. Use reviewed source/SQL/target/
backup/recovery inputs with applicable authority. Preserve legacy history,
retained target writes, uncertain effects and consumed cutover intents. Source
verification does not authorize replaying a failed cutover or resetting a target.

For Forge operators, fresh private receipts and the current exact action scope
live in `C:/Forge/CONTROL_PLANE.md`. Repo guides describe the build and gates;
they are not substitutes for those fresh environment-specific records.
