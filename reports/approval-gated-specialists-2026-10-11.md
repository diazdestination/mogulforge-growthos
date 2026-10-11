# Approval-gated specialists: SCOUT, INVO and assistant proposals

October 11, 2026 · Branch `agent/growthos-approval-agents-20261011` (based on `87adc3e`). Local implementation
and synthetic tests only. No push, deployment, provider activation, customer contact or schema rollout.

## Scope

Upgrade #2 turns two roster specialists into server-backed, **proposal-only** workflows and puts an explicit
approval gate on the CRM assistant's tools:

- **SCOUT**: deterministic follow-up proposals for unanswered estimates and quiet open leads.
- **INVO**: deterministic invoice-exception proposals (staff tasks only).
- **Assistant**: every tool declares `effect: "read" | "propose"`. Two propose tools can queue a follow-up task or
  a stage change for one lead; nothing is executed from chat.

Nothing in this change approves, executes, sends or retries anything. The only route to an effect stays the
existing Revenue Desk path: approve with the exact saved `expectedPayload`, then execute through the durable
`revenue_executions` ledger. If an outcome is unknown, it stays `indeterminate` and is never replayed.

## Design decisions

- **No schema change.** `bie_agent_runs.kind` is unconstrained `text` in every reviewed SQL file. The reviewed
  preview `reports/staging-schema-preview-2026-09-30/0000_isolated-staging-initial.sql` has no CHECK on `kind`,
  `action_type` or `status`. The only changes are the TypeScript union `BieAgentRunKind` (`specialist_scout`,
  `specialist_invo`, `assistant_proposal`) and proposal evidence fields (`specialist`, `subjectKey`, rule facts).
  No `0020` SQL file or table-count change was needed.
- **Attribution comes from the server.** Specialist identity comes from the run's kind through a join. It is never
  taken from client data. `GET /bie/actions` now returns `specialist` on each row.
- **One insert path** (`services/specialists/contract.ts`):
  - `insertSpecialistProposals` always writes `status: "proposed"`.
  - It rejects drafts that carry extra keys such as `status`, a reviewer, the run or an execution detail.
  - It skips any subject key that still has an open proposal (`proposed`, `approved`, `processing` or
    `indeterminate`).
  - Runs hold the same per-tenant advisory lock as BIE's generator. Each run writes a run row and a
    `bie.specialist_<key>_run` audit event in one transaction.
- **Idempotency.** Subject keys are deterministic:
  - SCOUT: `scout:estimate:<id>:step:<n>` and `scout:lead:<id>:stale:<last-contact-day>:task|stage`.
  - INVO: `invo:<id>:v<version>:<rule>` and `invo:<id>:overdue:w<week>`.
  - Assistant: `assistant:lead:<id>:task` and `...:stage:<target>`.

  Re-running a specialist never duplicates open work. An `indeterminate` step blocks the cadence until it is
  reconciled.
- **INVO money comes from the invoice service.** INVO reads each invoice through `getInvoice`, so it uses the
  service's own balance calculation and tenant/role checks. Invoice financial and delivery logic is unchanged.
- **One execution-gate exception.** BIE's executor blocks actions when a lead has moved on
  (won/completed/…) or has new customer activity. Those gates exist to protect outreach. INVO's internal staff
  tasks are expected on won or completed work, so `executeBieProposalEffect` skips those two gates (and the
  reply hold) only for `create_task` proposals whose run kind is `specialist_invo`. Permission, tenant, durable
  ownership and audit checks still apply.

## Owner-workflow grounding

- **HVAC owner intake** (`CSS_OWNER_INTAKE_2026-10-09.md`):
  - An unanswered estimate gets 3 reminders, 24 hours apart, then a staff phone call (`SCOUT_CADENCE`).
  - Multi-repair invoices are reviewed by the office before sending.
  - Nothing is sent without a staff choice.
- **Real invoices.** The owner supplied two redacted invoices. **No PII or real values are committed.** Tests use
  synthetic invoices with the same shape:
  - **HVAC:** "upon receipt" terms; two flat-rate repair lines with component lists and no per-part prices; no
    warranty dates.
  - **Roofing:** "due on receipt"; one lump-sum line; nothing paid; estimate and warranty wording carried into the
    invoice.

INVO rules, each proposing a staff `create_task`:

1. **Office review before sending.** An invoice with 2 or more lines and no delivery attempt gets an office-review
   task.
2. **Warranty-validity dates.** The rule applies when the run sets `warrantyDatesRequired` (the HVAC requirement)
   or the invoice mentions a warranty. If the invoice text has no date, INVO proposes a task to add one. It never
   invents dates. As reference evidence it attaches existing `service_obligations` warranty coverage and the count
   of active `property_assets` records.
3. **Overdue balance.** An issued invoice with a balance from the invoice service that is 7 or more days past due
   gets a follow-up call task. A missing or non-ISO due date means due on receipt, measured from `issued_at`. At
   most one proposal is open at a time, with one weekly bucket after it settles.
4. **Estimate wording.** Invoice text containing "estimate" gets a wording-review task.

## Approvals model

| Actor | Can do | Cannot do |
| --- | --- | --- |
| SCOUT / INVO run (`POST /bie/specialists/:key/run`, `crm.write`; INVO also `invoices.read`) | Insert `proposed` rows with evidence | Approve, execute, edit, retry or send |
| Assistant (interactive session with `crm.write`) | `propose_follow_up_task` and `propose_stage_change` (`contact_attempted`, `follow_up`, `nurture`) for a lead in its own company | Any other effect. Read-only users and API keys get no propose tools |
| Staff in Revenue Desk | Prepare email (send_email), approve the exact payload, execute | n/a. These paths are unchanged |

The assistant streams `data: {"proposal":{...,"status":"proposed","reviewPath":"/bie"}}`. The UI shows
"Proposed — awaiting approval in Revenue Desk" with a review link and no approve or execute controls.

## Files

- **API:**
  - `artifacts/api-server/src/services/specialists/{contract,scout,invo,assistant-proposals,index}.ts`
  - `services/assistant.ts` (tool effects, `resolveToolCall`, `offeredTools`, prompt and capability)
  - `services/bie.ts` (specialist on the list, INVO task gate)
  - `routes/v1/bie.ts` (two routes)
  - `routes/v1/assistant.ts` (capability and proposal event)
  - `lib/db/src/schema/bie.ts` (type only)
- **API tests:**
  - `services/specialists/{specialist-planners,specialist-guard,specialists}.test.ts`
  - `services/assistant-proposals.test.ts`
  - `routes/v1/bie-specialists.test.ts`
  - Updated: `routes/v1/assistant-chat.test.ts`, `routes/v1/route-inventory.test.ts`
- **UI:**
  - `components/{specialist-badge,assistant-proposal-marker}.tsx`
  - `pages/bie.tsx` (badges, "Find follow-ups (SCOUT)", "Check invoices (INVO)")
  - `pages/agent-team.tsx` and `.css` (pending-approval counts for signed-in users)
  - `pages/assistant.tsx` (markers)
  - `lib/agent-team.ts` (SCOUT and INVO task copy)
  - Test: `pages/bie-specialists.test.tsx`
- **Docs:** `AGENT-TEAM-DELIVERY.md`, `REVENUE-WORKSPACE.md`, `GROWTHOS-ARCHITECTURE.md`, this report.

## OpenAPI

The BIE routes, apart from `prepare-email`, are not declared in `lib/api-spec/openapi.yaml`. The new specialist
routes follow that existing untyped pattern, so no codegen was run. Route permissions are enforced by
`route-inventory.test.ts`.

## Verification (local, disposable Postgres via `scripts/local-dev.mjs`)

| Check | Result |
| --- | --- |
| Focused API DB tests | 15 files, 146 tests passed. Files: `bie`, `bie-capabilities`, `bie-email-provider`, `bie-reviewed-email`, `bie-email-review`, `bie-specialists`, `assistant`, `assistant-proposals`, `assistant-chat`, `assistant-history`, `route-inventory`, the 3 specialist suites and `invoices` |
| Full command-center suite | 117 files, 1039 tests passed |
| Typecheck (`pnpm run typecheck`) | Passed (libs, api-server, command-center, scripts) |
| Builds | `@workspace/command-center` and `@workspace/api-server` built |

The guard test checks two things:

- **Statically:** specialist modules never import or call review, execute, autopilot, prepare or send functions.
  They never update or delete proposal rows, and only `contract.ts` inserts them.
- **At runtime:** drafts that try to set a status, reviewer or run are rejected.

## Limitations and open gates

- **No live send verified.** SCOUT reminder emails are ordinary `send_email` drafts. They still need prepare,
  exact approval and a connected per-user mailbox. No provider was activated.
- **No SMS reminder action.** The BIE queue has no SMS action type. When a lead has no email, a text reminder is
  proposed as a staff task. The intake asks for both text and email reminders.
- **No INVO reminder email.** BIE's `send_email` path is built for lead outreach: it blocks won or completed
  leads and applies outreach consent. It cannot correctly target an invoice customer, so INVO proposes tasks only.
- **Customer-work invoices are skipped.** Invoices with no acquisition lead (`customer_work_id`) are counted as
  skipped, because `bie_action_proposals.lead_id` is NOT NULL. Supporting them needs a reviewed queue-scope
  change.
- **Warranty-date requirement is per run.** `warrantyDatesRequired` is a run option because no company or trade
  setting exists yet. A persisted per-company policy needs an owner decision.
- **Not covered by these specialists:** missed-call return within ~30 minutes (CALLIE's domain), and the roofing
  request to alert both owners with one owner claiming each lead.
- The assistant's real OpenAI round trip was not exercised. Tests mock the model.

## Owner input needed

1. Confirm the cadence (3 reminders, 24 hours apart, then a call; quiet lead after 7 days; overdue after 7 days)
   and whether these should become per-company settings.
2. Decide whether "warranty dates required on invoices" becomes a persisted company setting (HVAC yes, roofing
   unspecified).
3. Approve an SMS action and channel (consent, sender registration) before SCOUT can propose text reminders
   directly.
4. Decide whether invoice reminder emails are wanted, which requires a separate invoice-customer email path.
