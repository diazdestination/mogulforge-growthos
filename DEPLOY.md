# GrowthOS build and deployment model

Current source reference, October 29, 2026. This is not deployment authorization.
See [CURRENT-BUILD.md](CURRENT-BUILD.md) for release status and [DEV-LOCAL.md](DEV-LOCAL.md)
for local preview/tests. Current source is not verified live in production.

## Image and runtime

| Piece | Checked-in implementation |
| --- | --- |
| Base | Dockerfile node:22-slim; pnpm 11.3.0 |
| Install | Frozen lockfile, lifecycle scripts disabled |
| Build | Command Center Vite build followed by API build |
| Runtime | API dist/index.mjs and required runtime modules; frontend staged at /app/public |
| Serving | Express serves UI and API on one origin, container port 3001 |
| Database | PostgreSQL/Drizzle; exact deployed schema must be verified |
| Local examples | Compose uses PostgreSQL 15/host8080/DB5433; isolated current tests use PostgreSQL 16 |

Self-hosted email/password sessions, tenant roles and per-user provider identity
are implemented. Optional legacy connector/storage packages do not make Replit
an application-auth dependency. Private uploads use PostgreSQL-backed storage by
default; optional storage adapters need their own approved configuration.

## Why a generic deploy command is not the release procedure

fly.toml selects mogulforge-growthos and retains a release command. That command
(`node /app/scripts/release-schema.mjs`) deliberately refuses automatic schema
reconciliation. AUTO_MIGRATE or a bare `fly deploy` is not a valid shortcut.
Do not delete the refusal, force schema push or change the provider configuration
to make an unreviewed release proceed.

The last recorded cutover restored the older image/settings/database binding
together before reopen. Retained target TEST/scheduler writes and consumed
once-intents require fresh reconciliation, not a repeated reset/copy/controller.

## Required release packet

1. Verify active account/org, exact app/Machine, source/tree, image digest, schema,
   original full config and secret names; keep secret values out of logs/Git.
2. Bind the reviewed source/SQL/image/operator and backup/credential custody to
   the exact target. Resolve current clock/readiness prerequisites and retained
   target-write disposition. An old successful rollback is historical evidence.
3. Define finite maintenance, writer/scheduler/outbound holds, backup, independent
   comparison and private acceptance. Keep real provider effects disabled until
   their separately scoped approval and tests.
4. Require exact health/auth/tenant/log/scheduler and compatible-recovery evidence
   before reopen. Pre-reopen failure restores the original image/settings/binding
   together under the approved plan. After target writes/reopen, use the reviewed
   hold/forward-recovery decision rather than repointing at stale data.
5. Verify each actual provider, handset and contractor workflow separately;
   preserve full replacement, migration and workday gates.

The configured application address, prepared min-machines value and a green
source test do not prove availability or authorize new hosting cost. No production
command, purchase, provider activation or public launch is implied by this file.
