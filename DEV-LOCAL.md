# MogulForge — Local Windows Dev Runbook

This repo is a Replit/Linux export. Getting it running on **Windows** required
several fixes (documented below). Once set up, use the launcher and dev-login.

## TL;DR — run it

```powershell
# from the repo root
docker start mogulforge-db          # Postgres (already created)
./start-dev.ps1                     # builds + starts API (:3001) and app (:5173)
```

Then open **http://localhost:5173** and click **Create account** — the first
account becomes the OWNER (self-hosted email/password auth, no Replit login).
Instant-access shortcut (no form): **http://localhost:5173/api/dev/login**.

> **Decoupled + white-labeled (2026-08-04):** login is now self-hosted
> email/password (scrypt + DB sessions), not Replit OIDC — see the "auth
> decouple" fixes below. The app is rebranded **MogulForge** (violet) via the two
> `client.config.ts` files. For containerized self-hosting, see
> [DEPLOY.md](DEPLOY.md). Nothing pushes to the template repo — the `origin`
> remote was removed.

---

## What's running

| Piece | Where | Port |
|---|---|---|
| Postgres 16 + pgvector | Docker container `mogulforge-db` (user `postgres`, pass `mogulforge`, db `mogulforge`); image `pgvector/pgvector:0.8.0-pg16` — recreate an older PG15 container as described below | 5432 |
| API server (Express + Drizzle) | `artifacts/api-server` → `dist/index.mjs` | 3001 |
| Frontend (React + Vite) | `artifacts/command-center` | 5173 |

The API has **no dotenv** — env is injected at launch. Values live in
`artifacts/api-server/.env` (`PORT`, `DATABASE_URL`, `SESSION_SECRET`,
`NODE_ENV`, `ENABLE_DEV_LOGIN`).

---

## Fixes applied to make it run on Windows (do NOT undo)

1. **Win32 native binaries un-stripped** — `pnpm-workspace.yaml` had overrides
   deleting every non-Linux binary (`esbuild`, `rollup`, `lightningcss`,
   `@tailwindcss/oxide`). Removed the four `win32-x64` strip lines. Replit keeps
   its `linux-x64-gnu` binaries, so deployment is unaffected. Backup at
   `pnpm-workspace.yaml.bak`.
2. **`tsconfig.base.json` recreated** — the Replit export omitted this shared
   base that every package `extends`. Rebuilt at repo root.
3. **drizzle-kit schema glob** — `lib/db/drizzle.config.ts` now forces forward
   slashes (`.replace(/\\/g, '/')`); Windows backslashes are glob escape chars
   and matched nothing.
4. **Vite API proxy** — `artifacts/command-center/vite.config.ts` `server.proxy`
   forwards `/api/*` → `http://localhost:${API_PORT|3001}` (Replit serves both on
   one origin; local dev needs the proxy).
5. **Dev login route** — `artifacts/api-server/src/routes/auth.ts` adds
   `GET /api/dev/login`, double-gated on `NODE_ENV==='development'` **and**
   `ENABLE_DEV_LOGIN==='true'` (dead code on Replit). It mints a real DB session
   for a seeded local OWNER via the same `upsertUser`→`createSession` path OIDC
   uses. Requires a TLD email (`dev@example.com`).
6. **pnpm guardrails** — `pnpm config set verify-deps-before-run false`; install
   with `pnpm install --ignore-scripts` (cleanly skips the repo's
   "Use pnpm instead" preinstall guard and esbuild's postinstall).
7. **Self-hosted auth (decouple from Replit)** — added `users.password_hash`
   column, `artifacts/api-server/src/lib/password.ts` (scrypt), and
   `POST /api/auth/register | /login | /logout` in `routes/auth.ts` (reusing the
   existing DB session store + `ensureMembership` owner-bootstrap; brute-force
   rate-limited). Frontend `App.tsx` login screen is now an email/password form;
   `use-auth.ts` logout hits `/api/auth/logout`. Replit OIDC routes remain but
   are dormant without `REPL_ID`.
8. **Brand color** — `clientBrandingPlugin` in `vite.config.ts` uses doubled
   selectors (`:root:root` / `.dark.dark`) so the config-driven `--primary` wins
   over the plain `:root` value hardcoded in `index.css` (dev + prod).
9. **Git** — the `origin` remote (the template repo) was removed; there is no
   push target. Add your own private remote before pushing.

## Manual start (if not using start-dev.ps1)

```powershell
# API (terminal 1) — load .env then run
cd artifacts/api-server
# set $env:PORT / DATABASE_URL / SESSION_SECRET / NODE_ENV / ENABLE_DEV_LOGIN from .env
pnpm run build; node --enable-source-maps ./dist/index.mjs

# Frontend (terminal 2)
cd artifacts/command-center
$env:PORT='5173'; $env:BASE_PATH='/'; $env:API_PORT='3001'; $env:NODE_ENV='development'
pnpm run dev
```

## PostgreSQL 16 + pgvector (2026-10-11)

The retrieval layer stores embeddings in a pgvector `vector(1536)` column, so
every local database must run the pinned `pgvector/pgvector:0.8.0-pg16` image
(`docker-compose.yml`, `docker-compose.parity.yml`, CI and
`scripts/local-dev.mjs` all use it). The db `push`/`push-force` scripts run
`CREATE EXTENSION IF NOT EXISTS vector` first (`lib/db/ensure-extensions.mjs`).

PostgreSQL 16 cannot open PostgreSQL 15 data files, so `docker-compose.yml` now
mounts a NEW named volume (`pgdata16`); the old `pgdata` volume is left
untouched. To carry existing local data across (dump, then restore):

```powershell
# 1. Dump from the old PG15 volume with a temporary PG15 container
docker run -d --name mf-pg15-dump -e POSTGRES_PASSWORD=mogulforge -v <project>_pgdata:/var/lib/postgresql/data postgres:15
docker exec mf-pg15-dump pg_dump -U postgres -d mogulforge -Fc -f /tmp/mogulforge.dump
docker cp mf-pg15-dump:/tmp/mogulforge.dump ./mogulforge.dump
docker rm -f mf-pg15-dump
# 2. Start the PG16 + pgvector database (new volume) and restore into it
docker compose up -d db
docker compose cp ./mogulforge.dump db:/tmp/mogulforge.dump
docker compose exec db psql -U postgres -d mogulforge -c "CREATE EXTENSION IF NOT EXISTS vector"
docker compose exec db pg_restore -U postgres -d mogulforge --no-owner /tmp/mogulforge.dump
# 3. Add the new tables
$env:DATABASE_URL='postgresql://postgres:mogulforge@localhost:5433/mogulforge'
pnpm --filter @workspace/db run push
```

`<project>` is the compose project name (`docker volume ls` shows the exact
volume). Delete the old volume only after the restored data is verified. The
standalone `mogulforge-db` container in the table above must be recreated from
the pgvector image the same way (dump, new container, restore) before a push
will succeed against it.

## Schema changes

```powershell
cd lib/db
$env:DATABASE_URL='postgresql://postgres:mogulforge@localhost:5432/mogulforge'
pnpm run push-force   # enables pgvector, then drizzle-kit push --force
```

## Rebrand from "Painless Roofing" → MogulForge

Edit both config files (see README "Rebranding"):
- `artifacts/command-center/src/lib/client.config.ts` (frontend)
- `artifacts/api-server/src/lib/client.config.ts` (backend)
