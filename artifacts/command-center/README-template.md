# MogulForge GrowthOS — Client Template

> **Current context — October 29, 2026:** This is a legacy client export description, not the canonical GrowthOS product README or a verified current deployment. Current product development is in mogulforge-growthos; exporting/syncing a template is a separate reviewed distribution action.
> See [current build](../../CURRENT-BUILD.md) and [documentation map](../../docs/DOCUMENTATION-MAP.md).


A full-stack roofing CRM: pipeline board, lead management, scheduling, automated emails, portal access for homeowners, and an AI roof concierge. Built on React + Vite (frontend) and Node/Fastify + PostgreSQL (API server).

---

## ⚡ First thing after cloning: activate the sync workflow

This repository ships with a **Sync from upstream monorepo** GitHub Actions workflow that lets a maintained client template pull approved updates from its upstream CRM monorepo. It needs a one-time setup step to become dispatchable:

**Option A — GitHub Codespaces (automatic)**

Open this repo in a Codespace. The devcontainer runs the activation script automatically on container create — nothing else to do.

**Option B — local clone (one command)**

```bash
bash scripts/install-sync-workflow.sh
```

This moves the staged workflow file into `.github/workflows/` and pushes it. After that, go to **Actions → "Sync from upstream monorepo" → Run workflow** to pull future updates.

> The script is safe to re-run; it exits immediately if the workflow is already in place.

---

## Rebranding for a new client

**Everything client-specific lives in two config files. Edit both before your first deploy.**

| File | Audience | What to change |
|---|---|---|
| `artifacts/command-center/src/lib/client.config.ts` | **Frontend** (browser bundle) | Business name, short name, app title, primary color (hex + HSL), phone, timezone |
| `artifacts/api-server/src/lib/client.config.ts` | **Backend** (server process) | Default org name, org slug, fallback business name, AI assistant name, AI greeting |

### Why two files?

The frontend config is baked into the browser bundle at build time (Vite replaces references at compile time — values are never fetched from the server). The backend config is loaded by the Node.js process at startup and seeds the database on first boot. Merging them into one file would require shipping server-only secrets alongside client JS, or adding a runtime fetch step before the app renders — neither is worth the trade-off.

### Values that must stay in sync

A few values appear in both configs and need to match:

| Value | Frontend key | Backend key |
|---|---|---|
| Business name | `businessName` | `defaultOrgName` |
| Short business name | `businessShortName` | `businessShortName` |
| Phone number | `phone` | `phone` |

If these drift apart, the UI and outbound messages (email, SMS) will show different names — update both whenever you change one.

### After editing those files

1. **Logo** — replace `artifacts/command-center/public/favicon.ico` and any logo assets with the new client's logo.
2. **Domain/origin** — set the `DOMAIN` environment variable (used by the API server to build portal links and OG cards).

> **No manual edits to `index.html` or `index.css` are needed.** The browser tab title, Open Graph meta tags, and the `--primary` CSS variable are all injected automatically from `client.config.ts` at build time via the `clientBrandingPlugin` in `vite.config.ts`.

---

## Local development

### Prerequisites
- Node 22+
- pnpm 9+
- PostgreSQL 15+ (or a `DATABASE_URL` pointing at one)

### Setup

```bash
# Install dependencies
pnpm install

# Push the database schema
pnpm --filter @workspace/db run push

# Start the API server
pnpm --filter @workspace/api-server run dev

# In a separate terminal, start the CRM frontend
pnpm --filter @workspace/command-center run dev
```

The CRM will be available at the URL printed by Vite (usually `http://localhost:5173`).

### Environment variables

Copy `.env.example` (if present) or create a `.env` file in `artifacts/api-server/` with:

```
PORT=3001
DATABASE_URL=postgresql://user:pass@localhost:5432/yourdb
SESSION_SECRET=a-long-random-string
# Optional: OPENAI_API_KEY for the AI concierge
```

---

## Deploying

This monorepo is designed for Replit deployment (Autoscale or Reserved VM). On Replit:

1. Fork or import this repo into a new Repl.
2. Add the required secrets via **Secrets** in the Replit sidebar.
3. The `artifacts/api-server` and `artifacts/command-center` workflows start automatically.

For other platforms, build both packages (`pnpm --filter @workspace/command-center run build` and `pnpm --filter @workspace/api-server run build`) and deploy the resulting artifacts as two services (API + static SPA).

---

## Architecture

```
artifacts/
  api-server/       Node.js API (Express + Drizzle ORM)
  command-center/   React + Vite SPA (Tailwind, shadcn/ui, Wouter)
lib/
  api-zod/          Shared API schema (Zod)
  api-client-react/ React Query hooks generated from the schema
  db/               Drizzle schema + migrations
  replit-auth-web/  Auth hooks (Replit OIDC)
```
