# GrowthOS local development

Current supported workflow, October 29, 2026. Use an isolated checkout, Node 22 or 24
and pnpm 11.3.0. CI/container builds use Node 22. No existing shared database,
provider credentials or old Windows launcher is required for this workflow.

## Install and preview

```powershell
node scripts/local-dev.mjs setup
node scripts/local-dev.mjs run
```

Setup checks pnpm 11.3.0 and installs the frozen lockfile with lifecycle scripts
disabled. Run builds the UI and starts the fictional returning-customer preview
on `http://127.0.0.1:4193`. Its allowlisted environment excludes provider
credentials and holds outbound effects. It is not a production login or real
contractor onboarding. Stop the owning terminal/session to close the preview.

## Tests and checks

```powershell
node scripts/local-dev.mjs test
node scripts/local-dev.mjs ui
node scripts/local-dev.mjs typecheck
```

Test needs the existing local Docker Engine. It owns a generated PostgreSQL 16
container, binds a random loopback-only port, applies schema only there, uses
credential-excluding fixture settings, runs suites and closes its owned resources.
It does not accept an existing DATABASE_URL. Select literal API files when useful:

```powershell
node scripts/local-dev.mjs test src/services/service-sms.test.ts
```

Windows uses the configured WSL/Docker bridge and holds its own WSL session
through work/cleanup. Do not prune unrelated containers/volumes if interrupted;
inspect the exact run's ownership label. Provider dispatch is mocked; a test
pass is not carrier or real-device proof. Never use dev-login in production.

`node scripts/local-dev.mjs parity` runs the existing Docker staging-parity gate;
it does not deploy Fly. `node scripts/local-dev.mjs browser` uses the installed
Windows shipping kit against the already-running local preview. Keep recordings
and traces disabled. Follow [RUNBOOK.md](RUNBOOK.md) and exact task evidence.

## Legacy Compose example

The checked-in docker-compose.yml still describes a PostgreSQL 15 local example,
app host8080/API3001 and DB host5433. That differs from the current disposable
PostgreSQL 16 test workflow. Its sample credentials are local fixtures, never
production credentials. Do not treat an old named container, an .env file or
`start-dev.ps1` as the canonical developer environment. Generic schema push is
not an approved hosted migration path. See [DEPLOY.md](DEPLOY.md).
