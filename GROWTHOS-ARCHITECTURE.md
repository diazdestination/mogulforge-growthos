# MogulForge GrowthOS architecture

Current source overview, October 29, 2026. See [CURRENT-BUILD.md](CURRENT-BUILD.md)
for capabilities and evidence, and [PROJECT_STATE.md](PROJECT_STATE.md) for holds.

## Runtime and sources of truth

```text
Contractor/office React + Vite UI and customer portal
    -> Express API: authentication, tenant/role checks, reviewed commands
    -> PostgreSQL + Drizzle: customer/property/lead/estimate/job/invoice history
       scheduling, service work, evidence, consent, audit and effect ownership
    -> Controlled adapters: selected mailboxes, Twilio, optional intelligence
Smart Sites / existing website backends -> signed/scoped capture and delivery
```

The API and tenant-owned database hold canonical business state. The frontend,
website adapters and provider callbacks cannot grant themselves business or
send authority. React Query clients and Zod validation are generated from
`lib/api-spec`; `lib/scheduling-core` shares saved scheduling/conflict rules.

## Product modules in current source

Today/Service Desk/customer workspaces join CRM, native estimates/jobs/invoices,
equipment/checklists, saved capacity/travel scheduling, recurring service and
communication history. Revenue Desk/BIE joins source facts, reviewed proposals,
owned execution and value/outcome evidence. Smart Sites use site-specific server
credentials and preserve delivery uncertainty. Customer portals and private
photos remain contact/tenant scoped. Lifecycle inventory, exports, holds and
offboarding/recovery controls operate on those same records.

Evidence Intelligence retains explicit artifact approval, frozen manifests,
validated citations, deterministic hashes, human-reviewed certificates, native
estimate claim graphs and corroboration. Route packets describe a bounded
handoff; their existence does not prove a live external claims executor.
See [EVIDENCE-INTELLIGENCE.md](EVIDENCE-INTELLIGENCE.md).

## Identity, communications and effects

- Self-hosted email/password authentication and database sessions; invitations,
  accepted membership and tenant/role checks guard private work.
- Gmail/Microsoft sending resolves the selected authorized same-company staff
  mailbox. Platform transactional mail is separate and never an implicit
  contractor sender. Microsoft tracked reply/source workflows are opt-in.
- One Twilio organization/account/number binding controls signatures, secret
  references, flags, geography, limits and purpose-specific handset proof.
  Staff bridge/missed-call and CALLIE keypad/conversation paths retain separate
  authority. Current setup choice is Twilio; Telnyx is parked.
- Permanent operation ownership and saved-payload review prevent duplicate
  effects. Unknown provider outcomes stay uncertain until evidence-backed
  reconciliation; a new key is not permission to resend.
- Background work retains scheduler/outbound/lifecycle controls. A browserless
  scheduler requires a separately verified runtime; configured min-machines is
  not proof that a deployed scheduler is awake.

## Storage and build

Private uploads use the PostgreSQL-backed storage implementation by default;
legacy optional storage/connector packages may remain. Their presence does not
make Replit an application-auth requirement. The Cloudflare email-intake Worker
is a separate optional transport, not a second customer database. Large-scale
object storage/external executors and broad Google adapters must not be promoted
from strategy to shipped integrations.

The Dockerfile uses Node 22 and pnpm 11.3.0, installs the frozen lockfile with
lifecycle scripts disabled, builds the Vite UI and API, and stages the UI under
`/app/public`. Express serves the production UI and API on port 3001. Compose is
a separate local example; the supported test runner uses disposable PostgreSQL 16.
See [DEPLOY.md](DEPLOY.md) and [DEV-LOCAL.md](DEV-LOCAL.md).

## Release boundary

Code, local/native tests, CI, deployed source/schema, provider identity/delivery
and customer acceptance are distinct. The current source has exact-tree full CI
evidence; the last production check still found an older stopped image. Generic
automatic schema reconciliation is retired. Fresh reviewed SQL/source/target,
backup/credential custody, compatible recovery or complete mutation holds and
explicit applicable release authority remain required. Preserve original
history, retained target writes and consumed once-intents.
