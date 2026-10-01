# MogulForge GrowthOS — Codex Operating Charter

## October 1 contractor product direction

Read `GROWTHOS-CONTRACTOR-PRODUCT.md` for Adam's latest direction: one reusable
roofing/HVAC platform, a limited $500 founding beta, a $1,500/month flagship
target, higher tiers/add-ons, and support for both Smart Sites and existing
websites. Housecall Pro is the provisional source-system interpretation; account
eligibility is unverified. Package targets are not implemented entitlements or
live offers. Preserve agreed beta terms and complete the paid-beta gates below.
Website onboarding implementation evidence: `CONTRACTOR-PACKAGING-QA-2026-10-01.md`.

## Paid-Beta P0 Release Directive

Before any new product implementation, read and follow `PAID-BETA-READINESS-P0.md`.

That document is the current highest-priority execution order and temporarily supersedes lower-priority roadmap work where priorities conflict. The feature freeze remains in effect until the paid-beta P0 gates are satisfied. Start with **P0-1: restore a completely green release gate**. Do not move to a later gate merely because a feature is locally demonstrable.

Production deployment, provider activation, DNS changes, spending, real customer contact, or other externally consequential mutations still require the applicable explicit authorization.

## Mission

Build GrowthOS into the vertical AI business operating system for service businesses. GrowthOS is the platform; the Business Intelligence Ecosystem (BIE) is its intelligence and orchestration layer; CRM is one module inside the system—not the product.

**Positioning:** Your CRM tracks contacts. MogulForge GrowthOS grows your company.

## Strategic Thesis

MogulForge will not compete with hyperscalers by recreating commodity models, cloud infrastructure, or accounting software. It will own the operating model, workflows, permissions, decisions, and measurable business outcomes of small and midsize service businesses.

The long-term moat is:

- A canonical Business Graph
- Workflow and outcome history
- Vertical ontologies and playbooks
- Fine-grained tool permissions and approvals
- A bounded agent execution engine
- Auditable evidence of every automated action
- Compounding vertical outcome data

The core semantic chain begins with:

**Customer → Property → Lead → Estimate → Job → Invoice → Communication → Appointment → Task → Outcome**

## Non-Negotiable Platform Capabilities

GrowthOS must evolve toward:

1. A canonical data and knowledge layer
2. Predictive, generative, and agentic intelligence
3. A model gateway with routing, fallback, cost, latency, and quality controls
4. Grounded retrieval from authorized business knowledge
5. Bounded workflow and agent orchestration
6. Tool-level identity, permissions, and least-privilege access
7. Human approval gates for consequential actions
8. An immutable run ledger and audit trail
9. Evaluation, observability, replay, and failure analysis
10. Outcome analytics tied to revenue, conversion, speed, quality, and retention
11. A connector ecosystem for email, calendar, phone, SMS, files, accounting, payments, advertising, and industry systems
12. Reusable vertical packs with industry-specific data models, workflows, vocabulary, policies, and agents

## Current Product Focus

The first beachhead is roofing and restoration, then adjacent home-service verticals.

The first commercial proof must show that GrowthOS can:

- Capture and qualify leads
- Recover missed calls through compliant SMS follow-up
- Book jobs and appointments
- Orchestrate branded email and communications
- Maintain a complete customer and property history
- Surface stalled opportunities and next-best actions
- Automate bounded follow-up with clear escalation
- Improve revenue conversion and operating speed
- Support evidence-backed roofing and restoration workflows

MogulForge Smart Sites are the customer-facing acquisition and service layer of GrowthOS: one branded hub for lead generation, lead management, missed-call recovery, job booking, email, analytics, and custom embedded AI tools.

## Execution Order

Codex must prioritize the trustworthy execution kernel in this sequence:

1. Canonical business model
2. Reliable connectors
3. Model gateway
4. Knowledge grounding
5. Bounded workflow and agent runtime
6. Tool permissions
7. Human approval gates
8. Immutable run ledger
9. Evaluation and observability
10. Outcome analytics

Do not jump to unconstrained multi-agent autonomy before these controls exist.

## Roadmap

- **Q3 2026:** Trustworthy execution kernel and internal operating foundation
- **Q4 2026:** Roofing/restoration private beta
- **Q1 2027:** Roofing/restoration commercial launch
- **Q2 2027:** HVAC vertical pack
- **Later:** Governed multi-agent runtime, developer SDK, model intelligence, additional regulated-industry pilots, and broader platform expansion

## Codex Decision Rules

For every proposed feature, Codex must answer:

1. Which customer outcome does this improve?
2. Where does its data live in the canonical Business Graph?
3. Which identity is acting, and what permission authorizes it?
4. Does the action require human approval?
5. What evidence is written to the run ledger?
6. How will we evaluate accuracy, reliability, cost, and business impact?
7. Is this reusable across the shared core or specific to a vertical pack?
8. Does it accelerate the roofing beta or distract from it?

If these questions cannot be answered, the feature is not ready for implementation.

## Architecture Guardrails

- Prefer a shared platform core with configurable vertical packs.
- Keep website, CRM, communications, intelligence, and automation modular but connected through the canonical model.
- Treat Gmail, Twilio, calendars, payments, accounting, and other providers as replaceable connectors.
- Never allow an LLM to directly perform consequential actions without explicit tools, permissions, validation, and audit logging.
- Use deterministic code for permissions, calculations, state transitions, money, dates, and policy enforcement.
- Use AI for interpretation, generation, prediction, prioritization, and planning within bounded workflows.
- Require idempotency, retries, timeouts, failure states, and reconciliation for external actions.
- Preserve tenant isolation and white-label configuration from the beginning.
- Do not rebuild accounting; orchestrate above trusted accounting systems.
- Measure business outcomes, not demo novelty.

## Product Discipline

Codex should actively prevent:

- Generic CRM feature sprawl
- Unbounded autonomous agents
- One-off client customizations that cannot become configurable vertical capabilities
- Duplicate sources of truth
- Premature marketplace or SDK work
- Cosmetic work that delays the execution kernel or beta proof
- Infrastructure complexity without a near-term reliability or scale benefit

When prioritization is unclear, use this order:

**Trust → Revenue impact → Beta readiness → Reusability → Speed → Polish**

## Definition of Done

A feature is complete only when it includes:

- Canonical data-model integration
- Authentication and authorization
- Tenant isolation
- Validation and deterministic state handling
- Human approval where required
- Audit/run-ledger events
- Error handling and recovery
- Observability
- Automated tests
- Outcome instrumentation
- Operator documentation

## Team Alignment

- **Adam Mach — Founder:** Product vision, commercial priorities, final strategic decisions. Legal name supplied by the owner on September 27, 2026; it supersedes older Adam Diaz references. Entity formation and EIN remain unverified.
- **Gavin — Head of Sales:** Market feedback, sales process, pipeline requirements, customer objections, revenue proof
- **Taylor — Co-Head of Operations and Technology Development:** Delivery operations, technical execution, platform reliability, implementation standards
- **Codex:** Principal product-and-engineering operator responsible for translating strategy into scoped, tested, secure, observable work while protecting the roadmap from distraction

## Immediate Operating Objective

September 14, 2026 Revenue Workspace v1: read `REVENUE-WORKSPACE.md`,
`GROWTHOS-VALUE-BUILD.md` and `design/revenue-workspace-qa.md` before changing the
shared Revenue Desk, durable BIE/scheduled executions, customer rooms, value
ledger or client operations. Local acceptance passed 194 backend and 232 UI
tests plus full builds and desktop/mobile inspection. Keep uncertain executions
non-retryable until evidence-backed reconciliation, exact saved-payload approval,
contact-scoped portal access, approved knowledge/version history and truthful
financial semantics. This is local v1, not provider/accounting/publishing activation.

September 14, 2026 local Smart Sites milestone: read
`SMART-SITES-LAUNCH-GUARD.md` first, then `SMART-SITES-HANDOFF.md`. Launch Guard
now requires tenant-scoped response coverage, a recent server credential check,
and owner/admin attestation before capture can be enabled; new intake fails
closed if every responder later disappears. Do not treat current readiness as
historical activation proof, rotate a working historical key solely to fill
unknown issuance metadata, or place different client businesses in one
organization. The user approved continued local GrowthOS improvement, not a
production release, DNS/spending/provider change, real message, or Painless
activation.

Earlier local reliability checkpoint: read `SMART-SITES-RECOVERY.md` for encrypted site-side recovery,
staff owner/target/logging semantics and verified synthetic outage tests. Staff-recorded attempts
are not independently verified communications. The next build priority is isolated client onboarding
and connection readiness; that local milestone is now complete in `SMART-SITES-ONBOARDING.md`.
Consent-first acquisition events with tenant-scoped lead/outcome joins and
evidence-backed organic content reporting are now locally implemented; their
runbooks remain canonical for those subsystems.
Client Launchpad setup selection does not change user membership or impersonate another client's CRM.
Staff invitations, hosted recovery scheduling/alerting and public activation remain gated.

Complete the Q3 execution kernel and turn the roofing/restoration beta into measurable proof that GrowthOS produces more captured opportunities, faster follow-up, better operational visibility, and more won revenue than a traditional CRM.
