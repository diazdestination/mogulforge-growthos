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
cp .env.example .env          # set SESSION_SECRET + BETA_SIGNUP_ALLOWLIST
docker compose up -d db
docker compose run --rm app sh -lc \
  "cd /app && pnpm --filter @workspace/db run push-force"   # one-time schema (enables pgvector first)
docker compose up -d --build app
# open http://localhost:8080 → register an email listed in BETA_SIGNUP_ALLOWLIST
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
  OIDC, no `REPL_ID`. Per-IP brute-force limiting. Production self-registration
  is fail-closed behind `BETA_SIGNUP_ALLOWLIST`; pre-provisioned team invites
  remain valid without an allowlist entry.
- Replit OIDC routes remain but are dormant without `REPL_ID`.
- Private image uploads use signed, short-lived URLs backed by Postgres by
  default, so assessment and portal photos work in Docker/Fly without the
  Replit Object Storage sidecar. The legacy Replit/GCS adapter remains opt-in.
- Gmail through the Replit connector is optional. Resend is the portable email
  provider; without either provider, development uses an explicit no-delivery
  mock and surfaces that state in the UI/logs.

## Production notes

- **HTTPS:** the session cookie is `Secure` in production — serve behind TLS on a
  real domain (Fly gives this automatically; on a VPS use Caddy/Cloudflare).
  `localhost` is exempt, so the compose demo works over http locally.
- **pgvector (open gate):** the schema includes `retrieval_chunks.embedding vector(1536)`,
  so Postgres must have the pgvector extension available and enabled
  (`CREATE EXTENSION vector`) before the schema is applied. Local, compose, CI
  and parity use the pinned `pgvector/pgvector:0.8.0-pg16` image. Do not assume
  the hosted Fly Postgres cluster has it: confirming availability and enabling it
  there is a separately approved owner/provider step, done before the reviewed
  `0019_pgvector-retrieval.sql` is applied. Embedding spend
  (`EMBEDDINGS_PROVIDER=openai`) is a separate owner approval.
- **Migrations:** quick-start uses `drizzle-kit push --force` (fine for a fresh
  DB / early beta). Switch to generated migrations as the schema stabilizes.
- **Secrets:** never commit `.env`. `SESSION_SECRET` must be stable across
  restarts or all sessions invalidate.
- **Public origin:** set `APP_ORIGIN` to the canonical HTTPS origin. It is used
  for trusted same-origin checks and outbound links.
- **Beta access:** set `BETA_SIGNUP_ALLOWLIST` to approved new-company owner
  emails. Invited teammates are approved through the in-app invite flow.
- **Object storage:** `OBJECT_STORAGE_PROVIDER=postgres` is the zero-service
  default. For larger production media volumes, add a dedicated S3/R2 adapter
  behind the same object-service interface before moving bytes out of Postgres.
- **Image size:** the runtime copies the whole built workspace for simplicity;
  `pnpm deploy --filter @workspace/api-server` can slim it later.
- **Repository:** this deployment belongs to the private
  `diazdestination/mogulforge-growthos` repository, not the older CRM template.
