# MogulForge GrowthOS

**Revenue Intelligence and Recovery Operating System for home-services businesses.**

[MogulForge](https://mogulforge.ai) helps operators turn fragmented customer,
pipeline, communication, and operational data into clear next actions. GrowthOS
combines a multi-tenant CRM with evidence-backed business intelligence,
approval-first automation, and an expanding permissioned business-data graph.

The product is designed for roofing and adjacent home-services businesses where
slow follow-up, disconnected systems, and incomplete operational visibility can
cause otherwise recoverable opportunities to disappear.

## Platform

### Revenue Command Center

- Lead, customer, property, appointment, task, estimate, and pipeline workflows
- Attribution and operational reporting
- Organization-aware access and tenant isolation
- Homeowner communication and lead-capture experiences

### Business Intelligence Engine

- Deterministic opportunity detection grounded in tenant-owned records
- Evidence-backed explanations with confidence and limitations
- Reviewable action proposals with approve, edit, reject, and execution states
- Guardrailed automation policies and immutable activity history
- Outcome tracking designed to distinguish recovered revenue from pipeline value

### Evidence Intelligence

- Approved, tenant-scoped source artifacts
- Local redaction and citation-bounded AI drafting
- Human review before conclusions are finalized
- Tamper-evident Loss Evidence Certificates

### Permissioned Business Graph

- Per-user Gmail sending foundation with no platform-account fallback
- Incremental Google module authorization and explicit scope disclosure
- Planned connectors for Calendar, selected Drive and Sheets assets, Analytics,
  Search Console, Google Ads, and Business Profile
- Phased email intelligence architecture that begins with customer-controlled
  sources and reserves unrestricted mailbox analysis for formal verification

## Trust principles

- Tenant-private by default
- Least-privilege, incremental authorization
- Human approval before consequential outbound actions
- Connected documents and messages treated as untrusted data, never instructions
- Evidence and provenance retained for material recommendations
- No shared-model training on customer data by default
- Clear separation between implemented foundations, verified integrations, and
  planned capabilities

## Current status

| Surface | Status |
| --- | --- |
| Corporate site | Live at [mogulforge.ai](https://mogulforge.ai) |
| Founding-beta application | Live at [app.mogulforge.ai](https://app.mogulforge.ai) on the approved production baseline |
| Current development branch | Under review; not deployed to production |
| Per-user Gmail sending | Secure application foundation implemented; real production OAuth acceptance remains pending |
| Google Business Graph | Permission and module foundation implemented; source adapters remain in development |
| Email Intelligence Inbox | Secure tenant intake, redaction, retention, review, and synthetic-test foundation implemented; live provider routing remains pending |
| Full Gmail inbox intelligence | Restricted-scope connector intentionally deferred pending verification and security readiness |

Product documentation does not imply that an unfinished connector is available
to customers. Release claims must be supported by the exact deployed version and
its acceptance evidence.

## Technology

- React, TypeScript, and Vite command center
- Express API and background services
- PostgreSQL with Drizzle ORM
- Self-hosted email/password authentication
- Optional OpenAI, Google, Stripe, and communications adapters
- Single-container production build with Docker Compose and Fly.io configuration

```text
artifacts/
  api-server/       Express API and background services
  command-center/   React and Vite application
lib/
  api-spec/         OpenAPI source
  api-zod/          Generated request and response schemas
  api-client-react/ Generated React Query client
  db/               Drizzle schema and database tooling
```

## Development

Copy `.env.example` to `.env`, provide development-only values, and start the
local stack:

```powershell
docker compose up -d --build
```

The application is then available at `http://localhost:8080`, with PostgreSQL on
`localhost:5433`. Never commit `.env` or expose secret values in logs.

For the Windows development workflow and database bootstrap, see
[DEV-LOCAL.md](DEV-LOCAL.md).

## Operations and architecture

- [BETA-SUCCESS-PLAN.md](BETA-SUCCESS-PLAN.md) — founding-beta gates and success measures
- [DEPLOY.md](DEPLOY.md) — container and self-hosting model
- [BETA-LAUNCH.md](BETA-LAUNCH.md) — Fly.io release checklist
- [EVIDENCE-INTELLIGENCE.md](EVIDENCE-INTELLIGENCE.md) — evidence architecture and trust gates
- [GOOGLE-OAUTH-SETUP.md](GOOGLE-OAUTH-SETUP.md) — per-user Gmail authorization
- [GOOGLE-BUSINESS-GRAPH.md](GOOGLE-BUSINESS-GRAPH.md) — permissioned Google source strategy
- [EMAIL-INTELLIGENCE-ARCHITECTURE.md](EMAIL-INTELLIGENCE-ARCHITECTURE.md) — phased email intelligence model
- [EMAIL-INTELLIGENCE-SETUP.md](EMAIL-INTELLIGENCE-SETUP.md) — Cloudflare intake bridge and activation gates
- [GROWTHOS-RESUME.md](GROWTHOS-RESUME.md) — verified implementation state and continuation point

## Repository policy

This private repository contains the GrowthOS application. The corporate
marketing site and upstream reference template are maintained separately.
Changes reach production only after review, validation, and explicit deployment
authorization.

Copyright © 2026 MogulForge. All rights reserved.
