# MogulForge GrowthOS — Beta Success Plan

> **Current context — October 29, 2026:** The technical contract and dated results below describe their recorded feature checkpoint. Current main includes later contractor, scheduling, service, mailbox and Twilio work; use the current inventory for implemented features and pending live acceptance. Older branch names, test totals and approvals do not become current by this documentation refresh.
> See [current build](CURRENT-BUILD.md) and [documentation map](docs/DOCUMENTATION-MAP.md).


Status date: 2026-08-13  
Product branch: `agent/mogulforge-growthos-recovery`  
Launch standard: evidence-backed, invite-only beta; no capability is marketed
as live until its acceptance evidence exists.

## The category we intend to own

**MogulForge GrowthOS is the evidence-backed Revenue Recovery OS for roofing
and home-service companies.** GrowthOS holds the customer and workflow record.
Its Business Intelligence Engine (BIE) finds neglected revenue, shows the
source evidence behind every recommendation, places safe actions into an
approval queue, and attributes outcomes without turning pipeline value into a
fake revenue claim.

This is deliberately narrower than “another all-in-one CRM” or “an AI
assistant.” Established products already compete strongly on scheduling,
dispatch, estimates, job management, payments, and generic AI assistance.
GrowthOS wins by making one urgent outcome unusually trustworthy:

> Find the revenue already hiding in the business, recover it with controlled
> action, and prove what changed.

### Beta promise

Within 14 days, GrowthOS will identify known pipeline value at risk, ensure
each eligible recovery opportunity has a clear next action, let the company
approve customer outreach from its own connected accounts, and report
directly attributable outcomes.

This is a workflow promise, not a guarantee that a customer will buy or that a
specific amount of revenue will be recovered.

## Ideal founding customers

Start with 5–10 roofing companies, then adjacent exterior/home-service trades.
The best beta company has:

- 5–50 employees and an owner or sales manager who will attend a weekly review;
- at least 100 historical leads or estimates and visible follow-up leakage;
- permission to import and contact its customers;
- one accountable internal champion;
- willingness to share measured, anonymized results and product feedback.

Avoid large enterprise replacements during beta. GrowthOS should first become
the revenue-recovery layer a company can adopt quickly, even before it replaces
the rest of its operational stack.

## The memorable product loop

1. **Detect:** BIE identifies stale estimates, dormant leads, missing next
   actions, and known lead value at risk from tenant-owned records.
2. **Explain:** Every opportunity displays the rule, source records, age,
   amount, confidence/limitations, and why it is actionable.
3. **Approve:** A human reviews/edit/rejects the task, stage change, or email.
4. **Act:** GrowthOS executes through the approving user's connected account,
   subject to consent, suppression, quiet hours, caps, and provider health.
5. **Prove:** The Recovered Revenue Ledger links action, delivery, response,
   appointment, estimate, win, and recorded revenue without unsupported
   attribution.
6. **Learn:** Weekly operating reviews tune rules and playbooks from observed
   outcomes. A model may assist, but deterministic evidence remains primary.

## What could earn industry attention

Do not launch on a large feature count. Launch after the founding cohort can
publish a proof package:

- total **known pipeline value surfaced** (clearly not called revenue);
- number and percentage of opportunities given a next action;
- median time from detection to approved action;
- reply, appointment, estimate, and win outcomes by recovery cohort;
- **directly attributable recovered revenue** with an inspectable ledger;
- opt-out, complaint, bounce, and action-error guardrails;
- two detailed customer stories with before/after operating behavior.

The headline should be the verified result and the unusual trust mechanism,
for example: “Contractors found $X in neglected pipeline; MogulForge shows the
evidence and receipts behind every dollar.” Use this only after the ledger
supports the actual number.

## Turnkey beta gates

All P0 gates are required before inviting external testers.

| Gate | Current state | Acceptance evidence |
| --- | --- | --- |
| Invite-only account and membership | Partial | Owner invites a second user; invite acceptance, role limits, deactivate/reactivate pass. |
| Tenant isolation | Partial | Two independent organizations cannot read, mutate, search, export, or send from each other's data/connections. |
| Per-user Gmail | In progress | User connects, sends, refreshes after access-token expiry, disconnects/revokes; second user sends only as their account. |
| Email Intelligence Inbox | Foundation implemented locally | Tenant intake, authorized forwarders, signed Cloudflare Worker boundary, encrypted seven-day raw retention, redaction, deterministic review facts, purge, and two-tenant tests pass before live routing. |
| Data onboarding | Partial | CSV preview/map/validate/import handles a representative customer export with error report and rollback. |
| BIE opportunity detection | Implemented | Seeded and imported stale/dormant cases match documented deterministic rules and amounts. |
| Approval-first actions | Implemented, provider-blocked | Approve/edit/reject/execute is audited; Gmail email uses the executing user and guardrails block unsafe sends. |
| Reliable scheduled work | Not implemented | Durable leased job, idempotency, retry/backoff, dead-letter visibility, and restart test pass on an always-on worker. |
| AI runtime | Credential pending | Dedicated production project/key, budgets, model allowlist, provider health, timeout/fallback, and usage logging pass. |
| Provider/setup health | Partial | Onboarding names each missing prerequisite and validates it without exposing secrets. |
| Observability | Partial | Structured errors, request correlation, uptime check, alert delivery, and a simulated provider failure are verified. |
| Backup and recovery | Unverified | Automated backup enabled and a restore drill to an isolated database succeeds. |
| Legal/trust pages | Not implemented | Privacy, Terms, Google-data use/deletion, security contact, and account deletion match product behavior. |
| Production acceptance | Partial | HTTPS, health, signup/invite, two-tenant isolation, import, Gmail, BIE action, audit, backup, and mobile smoke pass on the exact deployed commit. |

## Execution sequence

### Phase 0 — truth and security baseline (now)

- Keep marketing claims frozen until acceptance evidence exists.
- Complete per-user Gmail OAuth using only `gmail.send`, encrypted refresh
  tokens, state/PKCE, revocation, and user-scoped sending.
- Complete the dedicated OpenAI production project/key workflow; set budgets
  and keep deterministic fallbacks clearly labeled.
- Add a readiness screen that reports database, AI, Gmail, SMS, scheduler,
  backup, and app-version status without returning secrets.
- Build automated two-tenant and two-sender tests.

### Phase 1 — founding-customer activation

- Turn registration into invite-only beta access.
- Build an onboarding wizard: company, team, data import, Gmail, sending
  rules/consent, BIE scan, first approved action.
- Improve CSV onboarding with mapping templates for the first two real source
  formats encountered; do not build speculative integrations first.
- Add the Recovered Revenue Ledger with conservative outcome definitions.
- Add an always-on job runner with leases, idempotency, retry/backoff, and a
  visible failures queue. Keep autonomous customer contact off by default.
- Add the permissioned Google Business Graph in this order: Calendar
  availability, user-selected Drive/Sheets assets, Analytics, Search Console,
  Ads, and Business Profile. Keep restricted Gmail inbox reading outside the
  founding beta unless verification, security assessment, and retention gates
  are completed.

### Phase 2 — operational reliability

- Enable managed database backups and complete a restore drill.
- Add error monitoring, uptime/health checks, redaction, audit exports, and an
  incident runbook.
- Add account/data export and deletion flows and Google OAuth production
  verification materials.
- Run the production acceptance suite on two real beta organizations.

### Phase 3 — measurable founding cohort

- Concierge-onboard 5–10 companies; import data with them, not via a blind
  self-serve funnel.
- Establish each company's baseline and one recovery playbook.
- Hold weekly Revenue Recovery Reviews using the ledger and safety metrics.
- Ship only changes tied to activation, recovered outcomes, reliability, or a
  repeated cohort need.

### Phase 4 — proof-led launch

- Freeze metric definitions before aggregation.
- Obtain explicit permission for named stories; otherwise anonymize.
- Publish the verified cohort report, product demo, trust architecture, and
  two case studies together.
- Then update `mogulforge.ai` with a GrowthOS product path and claims linked to
  real evidence.

## Product and business metrics

### North-star metric

**Directly attributable recovered gross profit per active organization.**
Revenue is useful, but gross profit prevents the product from optimizing for
low-quality work. Until customers provide cost data reliably, report recovered
revenue and label the gross-profit metric unavailable.

### Activation

- time from invite to first data import;
- time to first evidence-backed opportunity;
- time to first approved action;
- percent completing Gmail connection;
- percent completing the first seven-day recovery cycle.

### Value and retention

- eligible opportunities found and acted upon;
- appointments, estimates, wins, recovered revenue, and eventually gross
  profit attributable to recovery actions;
- weekly active decision-makers;
- organizations completing four consecutive weekly reviews;
- tester willingness to pay and conversion to a paid founding plan.

### Trust guardrails

- tenant boundary violations: target zero;
- sends from the wrong identity: target zero;
- unsupported revenue claims: target zero;
- duplicate sends, action failures, bounces, unsubscribes, and complaints;
- percentage of recommendations with complete source evidence;
- time to detect and resolve provider/job failures.

## Commercial model to validate

Do not optimize pricing before value is proven. Founding beta should be free or
nominal in exchange for weekly participation and outcome data, with a written
end date. Test a paid structure after the first proof cycle:

- platform fee sized for a small operator;
- usage allowance for AI/communications;
- higher tier for multiple locations, advanced automation, and reporting;
- no percentage-of-revenue fee until attribution and customer economics are
  mature enough to avoid disputes.

Billing code may remain disabled during the founding cohort. “Free beta” must
still include an agreement, data-use boundaries, support expectations, and a
clear transition decision.

## External account actions still required

Code cannot safely create or consent to these on the owner's behalf:

1. Create separate Google Cloud OAuth projects/clients for development and
   production; configure the authorized domain and exact callback URLs.
2. Complete the OAuth consent screen, privacy/data-deletion pages, test-user
   allowlist, and sensitive-scope verification for production reliability.
3. Finish the dedicated OpenAI production key/project and budgets.
4. Approve always-on hosting cost, backup configuration, deployment of the
   reviewed commit, and DNS changes.
5. Supply or approve representative beta data and the founding-customer
   agreement.

No customer Gmail password is ever collected by MogulForge. Google performs
sign-in and consent; GrowthOS receives revocable authorization for the narrow
send scope and stores the refresh token encrypted for that user and tenant.
