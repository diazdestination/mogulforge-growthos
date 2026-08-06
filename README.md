# MogulForge GrowthOS

MogulForge GrowthOS is an AI-powered command center for home-services businesses. It combines lead capture, pipeline management, automated follow-up, scheduling, estimates, homeowner communication, attribution, and an AI concierge in one multi-tenant CRM.

This is the product repository. It is separate from the MogulForge marketing website and from the original upstream CRM template.

## Repository identity

- **Local checkout:** `C:\Users\diazd\dev\projects\mogulforge`
- **GitHub:** `diazdestination/mogulforge-crm` (private)
- **Default branch:** `main`
- **Do not push to:** `diazdestination/MogulForge-crm-template-`
- **Marketing website:** `diazdestination/MogulForge` (a separate Next.js codebase)

## What is included

- React + Vite command-center UI
- Express API and PostgreSQL/Drizzle data layer
- Self-hosted email/password authentication
- Multi-tenant organizations and role-aware access
- Lead pipeline, contacts, properties, tasks, appointments, and estimates
- AI concierge, automations, next-best actions, and demo-data seeding
- Evidence Intelligence with approved source artifacts, grounded AI drafts,
  human review, and tamper-evident Loss Evidence Certificates
- Stripe-ready billing with an optional enforcement gate
- Single-container production build plus Docker Compose and Fly.io configuration

## Run locally with Docker

Copy `.env.example` to `.env`, provide local-only values, and run:

```powershell
docker compose up -d --build
```

Then open `http://localhost:8080`.

The local stack uses:

- App: `http://localhost:8080`
- PostgreSQL: `localhost:5433`

Do not commit `.env` or print its secret values into logs or chat.

## Run in development mode

See [DEV-LOCAL.md](DEV-LOCAL.md) for the Windows setup, database bootstrap, API/frontend processes, and troubleshooting notes.

## Deploy

- [DEPLOY.md](DEPLOY.md) covers the container and self-hosting model.
- [BETA-LAUNCH.md](BETA-LAUNCH.md) is the Fly.io launch checklist.
- `fly.toml` includes the production port and schema release command.

Set `SESSION_SECRET` before any public deployment. Stripe and OpenAI integrations remain disabled-safe when their optional keys are absent.

## Architecture

```text
artifacts/
  api-server/       Fastify API and background services
  command-center/   React + Vite application
lib/
  api-spec/         OpenAPI source
  api-zod/          Generated request/response schemas
  api-client-react/ Generated React Query client
  db/               Drizzle schema and database tooling
```

Client-facing defaults live in both:

- `artifacts/command-center/src/lib/client.config.ts`
- `artifacts/api-server/src/lib/client.config.ts`

Keep those two files aligned when changing the product name, color, assistant identity, or default organization details.

The standalone Evidence Intelligence architecture, trust gates, verification
record, and operating instructions are documented in
[EVIDENCE-INTELLIGENCE.md](EVIDENCE-INTELLIGENCE.md).

## Product status

The repository is beta-ready and has been validated as a production Docker build. A public Fly.io deployment and the first owner registration are still launch steps, not completed state.
