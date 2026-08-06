# MogulForge — Self-Host Deploy

Runs **fully off Replit**: self-hosted email/password auth, Postgres, and a
**single app container** where the API serves both the SPA and the API on one
origin. One image, one URL.

> **✅ VERIFIED (2026-08-04):** `docker compose build` succeeds and the container
> runs end-to-end — one origin serves the SPA (`/`) and API (`/api/*`); register
> → owner → branded dashboard all confirmed in a production container.

**For a live public beta URL, use [BETA-LAUNCH.md](BETA-LAUNCH.md) (Fly.io).**
This file is the local / VPS self-host reference.

## Local self-host (docker compose)

```bash
cp .env.example .env          # set a real SESSION_SECRET
docker compose up -d db
docker compose run --rm app sh -lc \
  "cd /app && pnpm --filter @workspace/db exec drizzle-kit push --force"   # one-time schema
docker compose up -d --build app
# open http://localhost:8080 → "Create account" (first account = owner)
```

`docker compose down` stops it (keeps data); add `-v` to also wipe the DB volume.

## The image

| Piece | Detail |
|---|---|
| Base | `node:22-slim`, pnpm pinned to 11.3.0 |
| Build | installs with `--ignore-scripts` (platform binaries come from optional deps, not build scripts), builds the SPA then the API |
| Runtime | API bundle (`dist/index.mjs`) + `node_modules` (for externalized `zod`/`@resvg`/`pg`); SPA staged at `/app/public` (`STATIC_DIR`) |
| Serving | `app.ts` serves `STATIC_DIR` + SPA history fallback in production, so relative `/api/*` calls need no proxy |
| Port | `3001` (compose maps host `8080`) |

## How auth was decoupled from Replit

- **Login** is self-hosted email/password (`POST /api/auth/register · /login ·
  /logout`) using Node's built-in **scrypt** + the DB-backed session store — no
  OIDC, no `REPL_ID`. Per-IP brute-force limiting.
- Replit OIDC routes remain but are dormant without `REPL_ID`.
- Replit-only integrations (object-storage sidecar, connector proxy) guard on
  `REPLIT_*` env and stay inactive off-Replit. Features that depend on them
  (e.g. image object-storage) need an S3/GCS adapter before use; core CRM does not.

## Production notes

- **HTTPS:** the session cookie is `Secure` in production — serve behind TLS on a
  real domain (Fly gives this automatically; on a VPS use Caddy/Cloudflare).
  `localhost` is exempt, so the compose demo works over http locally.
- **Migrations:** quick-start uses `drizzle-kit push --force` (fine for a fresh
  DB / early beta). Switch to generated migrations as the schema stabilizes.
- **Secrets:** never commit `.env`. `SESSION_SECRET` must be stable across
  restarts or all sessions invalidate.
- **Image size:** the runtime copies the whole built workspace for simplicity;
  `pnpm deploy --filter @workspace/api-server` can slim it later.
- **Do not push to the template repo** (`mogulforge-crm-template-`). The `origin`
  remote was removed; add your own private remote when you want to push.
