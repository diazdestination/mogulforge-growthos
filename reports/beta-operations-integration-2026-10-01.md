# Private beta operations — integrated engineering candidate

October 1, 2026, WILLOWFORGE. Authorized continuation of the three-specialist swarm
plus coordinator. Branch `agent/growthos-beta-operations`, based on verified PR #8
head `298b23a9d1d4b55de6319a53bc4ee55f1cf03a81`. This adds to the limited $500 beta
and $1,500 flagship direction without changing either customer's agreement.

## Delivered scope

- Durable tenant checkout ledger, stable Stripe request keys, bounded ownership,
  immutable terms and explicit recovery of known provider evidence. Verified
  canceled subscriptions can receive an operator-authorized replacement; retired
  subscription events cannot rebind the company. No invented trial offer.
- Owner/admin core CRM export: 14 allowlisted datasets, consistent snapshot,
  verified tenant relationships, 2,000 rows per dataset/10 MB whole-response limits,
  coverage/checksum/exclusions and a bounded deadline through latest-role check
  and audit. Failed exports produce no partial download. This is not a complete
  account archive, deletion or provider revocation.
- Audited pause, resume and offboarding-request controls with version checks and
  explicit queued-work review before resume. No billing cancellation is implied.
  Settings recovers from ambiguous network responses without blind mutation retry.
- Covered capture, analytics, referrals, scheduler, playbooks, reactivation, BIE,
  email/SMS/voice, staff push and outbound-webhook paths respect company holds.
  Pending batches filter held companies before their limit. Stops, outcomes,
  opt-outs, signed call/delivery receipts and existing history remain available.
  Already claimed/dispatched effects may complete or require review; the pause
  does not promise instantaneous cancellation of an external operation.
- Reusable server-side website adapter with encrypted persistent SQLite journal,
  stable request identity, fenced claims, bounded retries, destination partition,
  no redirects and explicit saved/queued/review states. It requires supported Node
  with a persistent volume. Serverless/Cloudflare compatibility is not claimed.
- Separate Climate Simulation Solutions integration preserves Book Service and
  pending office approval; see its own repository report and candidate PR.
- Real local HTTP rehearsals for Painless Roofing and Water Restoration and
  Climate Simulation Solutions: separate private draft organizations, connection
  check, qualified responder, intake, lead ownership, recorded contact attempt,
  office-created appointment, accepted estimate and separately recorded payment.
  All values/identities were synthetic. Neither company was activated.

## Review and tests

Independent review found and repaired cancellation suppression, held-company
scheduler starvation, consumed playbook steps, lost outcome hooks, referral and
voice bypasses, transaction-wait races, export cross-origin reads and incomplete
export deadlines. Billing retry/replacement received an independent source review.

Local evidence (overlapping selections are not additive):

| Check | Result |
| --- | --- |
| Full Command Center suite | 393 passed in 66 files |
| Shared API/schema/inventory/tenant/source selection | 115 passed in 10 files |
| Reusable adapter | 12 Node tests passed; also exercised over the real local GrowthOS HTTP server |
| Workspace | All typechecks; API and Command Center production builds passed |
| Browser | 8 actual-component cases: 1440/390/320 light and 390 dark for lifecycle/billing; zero overflow, page errors or scoped axe violations after two contrast fixes |
| Specialized billing/export/voice/capture | See lane reports for focused tests, concurrency limitations and exact evidence |

Browser checks used isolated synthetic API fixtures, including lost transition
acknowledgement, preserved reason, mandatory status refresh, resume confirmation,
oversized export failure and billing review states. Screenshots/results are local
at `C:\Forge\workspace\growthos-beta-operations-2026-10-01`. Recording/video/trace
were disabled. Temporary component previews were removed and the server stopped.

The additive schema preview is `staging-schema-preview-2026-10-01/0004_beta-operations.sql`.
It adds two ledgers without modifying existing organization rows. Its synthetic
upgrade test verifies existing data, uniqueness, restart eligibility and lifecycle
constraints. It is review material, not an applied production migration. The
inventory now classifies 97 tables; three are deliberately excluded from counting.

Full real-PostgreSQL CI, adapter tests, both builds and Docker staging parity must
pass on the exact pushed head. Current run/SHA/result is recorded on the candidate
PR and Forge launch ledger; an earlier green head is not this wave's acceptance.
Local PGlite does not establish independent-session locking behavior.

## Remaining customer and production gates

Actual company details, domain/hosting choice, approved source account/export,
responder/hours, communication consent, starting funnel numbers and agreed beta
scope still need customer configuration. Housecall Pro remains provisional.
Imported automated outreach stays held pending current-source verification.

Hosted schema/backup/restore, real billing and provider acceptance, secure deployment
configuration and owner release approval remain separate. GEEKOM's Microsoft/Azure
lane is preserved. No real email/SMS/call, charge, DNS change, public launch,
production migration or merge was performed by this engineering candidate.
