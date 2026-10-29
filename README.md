# MogulForge GrowthOS

**Contractor operations, revenue intelligence and controlled follow-up for home-service businesses.**

GrowthOS joins customer history, scheduling, estimates, jobs, invoices and service
follow-up in one tenant-scoped workspace. Its Business Intelligence Engine (BIE)
turns business records into explainable recommendations and reviewable actions.
Roofing and HVAC are the current contractor workflows.

**Updated October 29, 2026.** These are source capabilities. External provider
connections, deployed behavior and customer acceptance require separate evidence.
See [the current build](CURRENT-BUILD.md) for source links and release limits.

## What is in the build

- **Daily contractor work:** Today, customer/property records, pipeline, tasks,
  appointments, crews, saved capacity/travel rules and conflict checks.
- **Estimates through invoices:** new and returning customer work, native jobs,
  issued invoice snapshots, equipment/warranty details and staff-recorded external
  receipts, allocations and balances.
- **Service Desk:** recurring obligations, reviewed reminder policies, inbound
  service replies, reply holds and accountable follow-up tasks.
- **Revenue Desk and BIE:** evidence-backed opportunities, saved-payload approval,
  execution receipts, outcome tracking and value reporting.
- **Smart Sites and existing websites:** isolated site credentials, capture,
  response ownership, onboarding checks and durable delivery adapters.
- **Communications:** selected Gmail/Microsoft senders, reviewed initial estimate
  and invoice email, Twilio SMS/staff phone bridging, missed-call tasks and CALLIE
  keypad/conversation workflow foundations.
- **Office and customer surfaces:** customer workspaces, decision rooms/portal,
  private photos, invitations, role-aware access and opt-in staff Web Push.
- **Evidence and operations:** approved artifacts, redaction, frozen manifests,
  citation validation, human review, audit history, exports and recovery controls.

## Release status

| Area | October 29 evidence |
| --- | --- |
| Canonical product | `diazdestination/mogulforge-growthos`; former `mogulforge-crm` redirects here |
| Source baseline | `f0d74ab4ab2db756637cf3b4ad306b33982c9688`; this refresh changes docs only |
| Existing full CI | [39174960772](https://github.com/diazdestination/mogulforge-growthos/actions/runs/39174960772) passed on the identical file tree to that baseline |
| Local communications checks | 314 PostgreSQL workflow tests and 45 UI tests passed; earlier isolated Twilio suite: 79 passed |
| Production | Last October 29 operator check found the older image stopped; current source is not a verified live release |
| SMS/calling | Twilio selected; account/sender inventory, installed credentials and real-phone acceptance pending. Telnyx work parked |
| Contractor acceptance | Full migration, provider/device/workday and cutover evidence remain open |

The configured application address is [app.mogulforge.ai](https://app.mogulforge.ai).
An address or a test does not establish uptime. Contractor payment collection,
financing, automatic after-hours replies and live AI phone answering are not
advertised as finished capabilities.

## Build and local development

React/TypeScript/Vite frontend; Express API; PostgreSQL/Drizzle; generated OpenAPI
clients; one Docker app image serving UI and API. CI/container builds use Node 22;
the local runner supports Node 22 or 24. Use **pnpm 11.3.0** and the frozen lockfile.

From an isolated checkout:

```powershell
node scripts/local-dev.mjs setup
node scripts/local-dev.mjs run
```

The second command starts a fictional, outbound-held preview at
`http://127.0.0.1:4193`; it does not connect a contractor or enable a provider.
See [DEV-LOCAL.md](DEV-LOCAL.md) for disposable PostgreSQL tests and other commands.

```text
artifacts/api-server/          Express API, services and tests
artifacts/command-center/      React/Vite contractor and office app
lib/db/                       Tenant-owned PostgreSQL schema
lib/scheduling-core/          Saved scheduling and conflict rules
lib/api-spec/                 OpenAPI source
lib/api-zod/                  Generated validation
lib/api-client-react/         Generated React Query client
examples/website-connection/   Server-side website adapter
```

## Documentation

- [Current build and features](CURRENT-BUILD.md)
- [Documentation map](docs/DOCUMENTATION-MAP.md) — all Markdown, including dated evidence
- [Architecture](GROWTHOS-ARCHITECTURE.md)
- [Project state](PROJECT_STATE.md) and [next actions](NEXT_ACTIONS.md)
- [Local development](DEV-LOCAL.md), [operations](RUNBOOK.md), [deployment](DEPLOY.md)
- [Twilio binding](TWILIO-TENANT-BINDING.md) and [contractor replacement gate](HOUSECALL-PRO-REPLACEMENT-GATE.md)

Dated reports, plans and recovery fixtures keep their original results and
limits. They are indexed as historical evidence rather than rewritten to imply
that an old approval or test applies to today's build.

## Repository policy

This is the GrowthOS product repository. Last verified GitHub visibility: public.
Never commit credentials or private tenant data. The old CRM export template,
marketing and client-site repositories are separate surfaces. Use reviewed
branches/PRs against canonical main; deployment, provider activation, spending
and public launch retain their separate approvals.

Copyright © 2026 MogulForge. All rights reserved.
