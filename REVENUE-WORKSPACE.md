# GrowthOS Revenue Workspace v1

> **Current context — October 29, 2026:** The original Revenue Workspace contract below is historical implementation detail. Current source also supports selected Microsoft sending and native contractor/service work; older Gmail-only or missing-Outlook statements are not the complete current build. Revenue attribution and provider/customer acceptance still require evidence.
> See [current build](CURRENT-BUILD.md) and [documentation map](docs/DOCUMENTATION-MAP.md).


September 14, 2026 · Local implementation and synthetic acceptance, not a production release.

## What this release delivers

The Revenue Desk at `/` joins the existing BIE, next-action service and Smart Site response records.
It is not a second CRM. Leads, contacts, estimates, projects, appointments and activities retain their
canonical tenant-owned IDs. The existing visual system and permission model are preserved.

| Surface | Working local capability | Important boundary |
| --- | --- | --- |
| Today's priorities | Ownership, source, age, first-attempt target, next step, review/edit/approve/dismiss/execute and action receipts | A suggestion, acknowledgement or staff log is not a delivered message or booking. |
| Business knowledge | Versioned, explicitly approved services, area, hours, materials, warranties and escalation policy | Saving does not reconfigure an external voice agent or authorize outreach. |
| Customer decision room | Approved scope, up to three material comparisons, warranty text, estimate snapshot/history, appointments and customer questions | Not e-signature, contract acceptance or payment processing. |
| Value ledger and ROI Report | Accepted estimates, source-linked staff-recorded payments/refunds/costs/cost refunds, evidence drill-down | Not an accounting/bank feed, verified profit, or proof of incremental revenue. |
| Project stories | Completed-project source outline, immutable draft versions and separate factual/content approval | Nothing automatically publishes, requests a review or contacts a customer. |
| Client Launchpad | Allowlisted client staffing, knowledge version, unowned/overdue inquiries, credential freshness and uncertain executions | Selection grants no CRM membership or impersonation. Cost/support-hour accounting remains separate work. |

## Execution and approval invariants

- `revenue_executions` owns an action by a unique `(organization_id, action_key)` plus a canonical payload
  digest. BIE keys are `bie:<proposal id>`; scheduled-work keys are `scheduled:<scheduled action id>`.
- A second worker never repeats an owned effect. Ownership expires after 15 minutes into **indeterminate**,
  not retryable. A thrown effect may already have reached a provider; it is never blindly replayed.
- Every ownership/state transition has an append-only `revenue_execution_events` record. A late worker
  returns the current receipt instead of replacing an operator's reconciliation with stale state.
- Reconciliation is an owner/admin attestation with evidence. It does not resend, update provider records,
  retroactively prove delivery, or rewrite a proposal's history. Check the downstream task/message before
  preparing any new action. Creating a different action key is not a safe substitute for reconciliation.
- Proposal generation is serialized per organization. Approval requires the exact saved payload and
  compare-and-set state/content; approval plus audit is transactional. Approved drafts cannot be edited.
- Execution rechecks active staff permissions, current policy, lead stage, newer customer activity,
  appointment, approved provider readiness, suppression/consent, quiet hours and cap where applicable.
- BIE's current outbound path is per-user Gmail. It remains blocked without that actual connection.
  This does not implement Outlook sending. Concurrent pending/uncertain email reservations consume the
  rolling 24-hour cap; provider acceptance is not labelled delivery.
- Recovery freshness uses recorded customer interaction/estimate-send time or lead creation, not assignment,
  enrichment or internal notes. A customer reply takes precedence over an older follow-up suggestion.

## Customer access and content

`/project-room/:workspace/:leadId` starts with a tenant-scoped one-time-code sign-in. The contact must own
the lead in that organization. Portal tokens stay in component memory and authenticated headers, never in
URLs or browser storage. Closing the room revokes its session. One code can mint only one session under
concurrent verification, and concurrent wrong attempts consume the limit atomically.

Only approved package fields reach the customer. Draft estimates, staff IDs and internal approval/source
notes are omitted. If the source estimate changes, the package is labelled outdated; saved snapshots and
earlier versions remain available. Customer-supplied photo paths use the existing contact-authorized stream,
not public object URLs. Photos have private loading/error states. Live customer OTP delivery still depends
on the business's approved transactional provider; local seeded-code acceptance is not an inbox test.

Scope, pricing, warranties and material claims require explicit client approval. The code does not infer
manufacturer certification, insurance coverage, job completion or the right to publish customer media.

## Financial evidence

Each USD entry requires a lead, positive integer cents, event timestamp, unique source reference and
staff confirmation. An identical retry returns the existing record; a changed payload using that reference
returns a conflict. Corrections are new refund/cost-refund events, not deletion or silent rewriting.

Totals aggregate all records, not just the latest 200 rows displayed. Missing receipt or cost categories
are labelled **Not recorded**, not zero. Contribution is unavailable until both categories have evidence;
even then it is only recorded receipts minus recorded direct costs. Incomplete costs, tax, overhead and
collection reconciliation prevent a profit claim. Financial event dates are stored at UTC midnight and
displayed as UTC dates, so a September 14 entry never appears as September 13 in the US evening timezone.

This v1 supports explicit staff reconciliation entry. Accounting adapters, validated bulk imports,
invoice/payment matching, period comparisons and cost-completeness attestations are follow-on work,
not silently assumed capabilities.

## APIs and permissions

All endpoints below are under `/api/v1`; member routes derive organization from the authenticated identity.

- `GET /revenue/desk`, `/revenue/profile`, `/revenue/rooms/:leadId`, `/revenue/value`,
  `/revenue/evidence/:leadId`, `/revenue/growth`, `/revenue/executions/:id`: `crm.read`.
- `POST /revenue/leads/:id/claim`, `POST /revenue/growth`, `PATCH /revenue/proposals/:id`: `crm.write`.
- Approve/save business profile and customer package, record financial entry, approve story,
  or reconcile an uncertain execution: `settings.manage`.
- `GET /platform/clients/health`: active platform-admin session, not an ordinary owner or API key.
  At most 100 organizations; only allowlisted aggregate/setup fields, no customer records or secrets.
- Portal request/verify routes include workspace slug and rate limits. Portal room/photo/question
  routes use the existing contact-scoped portal session; a staff session alone grants no portal access.
- Existing BIE approval HTTP requests now require `{ expectedPayload: <the saved proposal payload> }`.
  A changed, unavailable or already-reviewed proposal returns 409; refresh and review, do not auto-approve.

## Local verification and recovery

Canonical checkout: `C:\Users\diazd\dev\projects\mogulforge`.

1. Preserve the existing `mogulforge-smart-sites-dev` Docker database and fixture data.
2. From `artifacts/api-server`, `node scripts/smart-sites-local-run.mjs schema` applies the additive schema
   **only** to `127.0.0.1:55432/mogulforge_smart_sites_test`. Review any unexpected destructive prompt; stop.
3. At repository root, `pnpm run build` checks types and builds API/UI.
4. From API directory, `node scripts/smart-sites-local-run.mjs api` starts `127.0.0.1:3001` with an
   allowlisted environment. No provider credentials are inherited. Restart this process after rebuilding
   its non-HMR API bundle. The Vite preview is `http://127.0.0.1:5173/`.
5. `node scripts/smart-sites-local-run.mjs test` runs the selected tenant/action/portal/Smart Site
   regression suite against that same isolated database. Mock-provider log lines are not deliveries.
6. `pnpm --filter @workspace/command-center exec vitest run` runs the complete command-center suite.
7. For browser fixtures, `revenue-local-seed.mjs` requires exactly the isolated DATABASE_URL documented
   in the runner. It adds two labelled fictional leads, sent/accepted estimates, a completed project and a
   known one-time code for `revenue-qa@example.invalid`; it never sends a code or resets existing records.
   Do not run fixture scripts against production or weaken their exact database guards.
8. Owner UI: existing `owner@painless-local.example.test` fixture. Operator UI: separate
   `operator@smart-sites-local.example.test` fixture. Their local-only passwords are in the existing seed
   scripts. Never promote a customer owner to perform platform tests or read a browser's cookies.

Evidence: `design/revenue-workspace-qa.md`; implementation ledger: `GROWTHOS-VALUE-BUILD.md`.

## Still required before real customer use

The user approved this local build, not publishing, migrations, sending or client activation.

1. Receive the owner's approved staff/sender/recipient identities and contact policy.
2. Select and verify that actual communications provider; connect approved facts to selected agent/draft
   adapters and verify the exact deployed version. Keep manual response usable meanwhile.
3. Obtain the pilot's accounting/job-source choice, data permissions, retention and measurement definition
   before implementing a financial adapter/import or claiming reconciled collection and job profit.
4. Validate a real owner-visible inquiry → response → estimate/customer-room → outcome flow with separately
   authorized test recipients. Confirm HTTPS, privacy, backups/restore, monitoring and schema rollout.
5. Obtain release/activation approval. Launch Guard and the Painless real-capture pause remain unchanged.

Longer-term roadmap items remain research/pilot-dependent: calendar/signature/payment/publishing adapters,
review/referral campaigns, usage and support-labor economics, outcome-learning/holdout evaluation, and full
HVAC/commercial/retail workflows. This release provides a shared v1 foundation across the five investments;
it does not establish live integrations, organic ranking, business lift, or commercial profitability.
