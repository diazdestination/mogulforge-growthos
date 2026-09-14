# GrowthOS Smart Sites — local integration milestone

September 12, 2026. Implemented and locally verified; not a production release.

## Latest checkpoint — organic content to recorded inquiry

September 14, 2026. Painless now has 20 evidence-backed, prerendered service, service-area,
and project routes with canonical/schema/sitemap controls. GrowthOS acquisition reporting adds a
`Landing content` breakdown based on each consented browser's first recorded path in the report window, joined only to
real Smart Site receipts and recorded wins. It does not claim rankings, completed calls, cross-device
identity, cash/profit, or causal uplift.

Final local verification: 1,036 executed API tests passed with 15 intentional skips, 219/219 UI
tests, 51/51 Painless tests, both builds/type checks/diff checks, desktop/mobile rendering, primary
interactions, and empty browser consoles. Read `SMART-SITES-MEASUREMENT.md` and the Painless
`design/organic-acquisition-qa.md` plus `design/organic-content-workflow.md` first. No push,
deployment, production data/settings, account access, real lead, outbound message, or DNS change.

Next gate is a controlled release package and authorized SEO baseline—not automatic publication.

## Latest checkpoint — consent-first acquisition measurement

September 14, 2026. The next priority described below is now implemented and locally
verified. Read **SMART-SITES-MEASUREMENT.md** and the Painless
`design/acquisition-measurement-qa.md` first. Measurement is disabled by default, requires
literal browser consent, keeps tenant/site secrets server-side, supports retention and
browser erasure, and joins bounded first-party events only to real GrowthOS receipts and
recorded outcomes. It does not collect files/transcripts/contact content or claim that a
phone-link click is a call.

Latest verification: 126 guarded backend + 219 UI + 46 Painless tests, builds/type checks,
desktop/mobile rendered checks, empty browser consoles, and a passing loopback event-to-lead
receipt. The isolated fixture contains three clearly labeled synthetic acquisition QA leads,
zero real customers, appointments, estimates, wins, or won value. No production migration,
push, deployment, provider, public-site, DNS, real-message, or spending action occurred.

Next local priority: reusable evidence-backed organic service/location/project pages plus
canonical/schema/sitemap and content-to-inquiry attribution. Avoid bulk doorway pages.

## Latest reliability checkpoint

**Latest completed priority:** Client Launchpad and repeatable isolated draft onboarding are now
locally implemented. Read **SMART-SITES-ONBOARDING.md** and `design/client-onboarding-qa.md` first.
Verification is now 123 backend + 218 UI + 41 Painless tests. Setup selection does not impersonate
another client's CRM identity. Staff invitations and production activation remain separate gates.
The next local build priority is consent-first acquisition events and real lead/outcome joins.

The next priority is now locally implemented: independent encrypted Painless delivery journal,
automatic local outage recovery, staff ownership, future-only follow-up targets and explicitly
staff-recorded first-attempt evidence. Read **SMART-SITES-RECOVERY.md** for the current runbook,
acceptance IDs and launch gates. Latest verification: 85 backend + 208 UI + 41 Painless tests.
Earlier numbers below document the original capture milestone, not the final fixture size.

## Approved direction

The user explicitly approved resuming local GrowthOS development as the shared operational core for Painless, an upcoming HVAC site, a commercial construction site, and Dawsonville Nutrition. Keep each branded website and organization separate. This supersedes the earlier pause for this specific integration work, not the publishing/provider gates or the separate MogulForge marketing project.

One GrowthOS system of record. Independent Smart Sites. Configurable business intake profiles. No second customer database or editable CRM inside Painless.

## Implemented

- Owner/admin controls at `/capture`: create a draft connection in the current organization, choose a profile, obtain a one-time server key, enable/disable capture, and rotate/revoke the key. A new client needs its own organization; creating another site in Painless is not client onboarding.
- Four starter intake profiles: roofing/exteriors, HVAC, commercial construction, local retail/tea shop. These configure accepted services, not complete vertical operations, scheduling, inventory, POS or payments.
- New server-only endpoint: `POST /api/v1/public/smart-sites/:siteId/intake`, authenticated by a per-site bearer key stored only as a SHA-256 hash in the database. Browser Origin headers are rejected; site identity determines the organization. Browser-supplied organization IDs are rejected.
- One database transaction saves the lead, consent receipt, activity, follow-up task and audit event. A transaction-scoped organization lock serializes Smart Site contact matching and receipt creation. Failure rolls the transaction back; a retry can succeed without a stranded pending reservation.
- Same site + request UUID + same normalized payload returns the existing lead/receipt. Changed data with the same UUID returns 409. A new project request creates a new lead even for an existing contact. Conflicting contact matches return an honest review-required error, not a guessed merge.
- Property is optional. A property row is only created when address, city, state and ZIP are supplied. ZIP-only inquiries preserve their information in the lead activity. Submitted contact details are preserved without silently overwriting an existing contact.
- Contact permission, policy version, channel list and receipt timestamp are stored per inquiry. An absent channel list is unknown/empty, never permission for all channels. Painless planned requests permit phone/email; its damage-check wording permits phone/SMS. These are inquiry-response permissions, not bulk marketing enrollment.
- Optional campaign/referrer attribution is accepted only with separate analytics permission. Fixed site source still identifies the operational intake channel. No anonymous visitor identity, cross-client tracking, raw URLs with query strings, photos, claim PDFs or voice transcript are forwarded by this adapter.
- Dashboard metrics come from saved receipts and lead outcomes: captured inquiries, unassigned active leads, recorded wins and recorded won contract value, with service breakdown and direct lead links. Unknown/error states use dashes, not invented zeros. Contract value is not collected cash, ROI or profit.
- Fresh Smart Site inquiries receive a review/respond recommendation. Capture is not counted as staff follow-up. Lead notes and stage changes refresh the recommendation and relevant views.

## Canonical model and authorization decisions

| Charter question | This milestone |
| --- | --- |
| Customer outcome | Preserve inquiries, make staff follow-up visible, identify which services generate saved requests. |
| Canonical data | Existing contacts/properties/leads/CRM tasks/activities/audit tables; new site configuration and receipt tables only. |
| Acting identity | Authenticated organization member for setup/read; scoped site server credential for intake. |
| Permissions | `settings.manage` for setup/key management, `crm.read` for reporting; no public tenant selector. |
| Human approval | No automatic communication, booking, pricing or dispatch. Staff chooses the next action. Publishing/provider activation still needs specific approval. |
| Evidence | Persistent receipt linked to real lead ID, contact consent, activity, task and audit event. This is not yet a tamper-evident universal agent run ledger. |
| Evaluation | Cross-tenant/role tests, retry/concurrency/conflict/rollback tests, provider-failure mocks, browser acceptance and authoritative outcome counts. No revenue uplift claim from synthetic tests. |
| Reuse and focus | One shared contract, four service configurations; Painless is the browser-verified proof. No new industry-specific CRM or platform fork. |

## Painless boundary

Project: `C:\Users\diazd\dev\projects\painless-roofing-site`.

Its `worker/growthos.js` validates the fixed website identity, bounded payload, origin, consent and service. It forwards server-to-server with a 10-second timeout and refuses redirects. Allowed destinations are HTTPS `app.mogulforge.ai`, or loopback HTTP only when the incoming request is itself local. Production use of that hostname is allowed by code but was not called or verified this turn.

Server-only settings: `PAINLESS_GROWTHOS_ENABLED`, `GROWTHOS_API_ORIGIN`, `GROWTHOS_SITE_ID`, `GROWTHOS_SITE_SECRET`. Never use VITE-prefixed variables for credentials. In the absence of valid settings, the new route stays disabled. The legacy email bridge remains separate and disabled; a GrowthOS failure does not silently fall through to email.

Both planned-project forms and `/api/lead` damage checks use the connector when enabled. Success requires a returned database lead UUID and receipt UUID. A receipt means saved in the staff workspace, not email delivery, a booked appointment, dispatch or a sale.

**Current outage boundary:** the optional encrypted D1-compatible journal now retains accepted
inquiries independently of GrowthOS and returns `queued` rather than CRM success. The local launcher
enables and verifies automatic recovery; hosted D1/scheduling/alerting are not activated. With the
outbox disabled, the earlier direct adapter still only retains failed fields in the open form.

## Repeatable local setup

An isolated Docker container named `mogulforge-smart-sites-dev` holds database `mogulforge_smart_sites_test`, exposed only on `127.0.0.1:55432`. No existing or production database was modified. Keep it running to inspect this milestone; do not remove it or its data without a scoped user request.

The generated local connection file is ignored at `.local/smart-sites/painless-connection.json`. It is a private test server key, not a production credential. Do not print, commit or screenshot it.

Local preview endpoints while the processes are running:

- GrowthOS: `http://127.0.0.1:5173/capture`
- GrowthOS API: `http://127.0.0.1:3001`
- Painless: `http://127.0.0.1:4173/`

Synthetic staff login: `owner@painless-local.example.test` / `LocalPreviewOnly!2026`. This identity exists only in the guarded local test database. Never create it in production.

From the API-server directory, `node scripts/smart-sites-local-run.mjs api` starts the built API with a whitelisted OS environment, fixed local test database, loopback binding and no inherited provider secrets. Build first with `pnpm --filter @workspace/api-server run build`. The same runner with `test` executes the six bounded backend suites against that exact database. `AUTO_MIGRATE=false` remains explicit.

From the repository root, run the frontend with `API_PORT=3001` and `pnpm --filter @workspace/command-center exec vite --host 127.0.0.1 --port 5173 --strictPort` (set the environment variable using PowerShell syntax). For an existing fixture, the separate guarded `smart-sites-local-seed.mjs` requires the exact local test `DATABASE_URL` and a running API. It creates/enables only the local test connection and saves its key privately. It does not rotate a missing/lost key silently.

Start Painless with `node scripts/smart-sites-local-preview.mjs` in its repository to reuse that
fixture and enable the independent local journal/retry loop. Existing provider settings remain
untouched; no voice session or external evidence upload was exercised in this checkpoint.

Schema changes are in `lib/db/src/schema/smart-sites.ts`, exported from the schema index. The repository's existing Drizzle push workflow was used only against the fresh isolated database. Before any production deployment, inspect the generated schema plan, take/verify a backup and review an additive migration; do not assume a force push is safe because the local push succeeded.

## Verification

- Backend: **81/81** across Smart Sites (14), legacy capture (13), tenant isolation (24), tenant list scoping (9), attribution (10), next-best-action (11).
- GrowthOS frontend: **203/203**, 39 test files, including Smart Sites operator permissions, one-time key reset on organization change, malformed/error reporting and recommendation refresh after note/stage changes.
- Painless: **31/31** server/connector/packaging regressions with external providers mocked.
- API and frontend type checks and production builds passed. Painless production build and Sites packaging passed.
- Browser: planned siding and mobile gutter submissions returned real local receipts; records, consent/activity and follow-up tasks were found in the correct workspace. Staff note/stage changes were saved on synthetic local records. Desktop 1440 and narrow 390/320 layouts were inspected; new form keyboard trap, Escape/focus return, consent rejection and phone fallback exercised. Original damage flow acceptance and final screenshots are recorded in Painless `design/smart-sites-qa.md`.
- Fixed during QA: duplicate navigation shell on Capture, malformed-report crash, organization-scoped UI cache/one-time-secret state, stale next-action recommendation after staff edits, and narrow advanced-button wrapping.
- Existing build warnings remain: GrowthOS font-import ordering and large frontend chunk, plus Painless's lazy voice chunk size. They are not a clean Lighthouse/performance certificate.

Screenshots: Painless `design/qa-smart-sites-2026-09-12/`. The database contains explicitly labeled synthetic QA inquiries, not business results.

## Next implementation sequence

1. **Reliability and staff ownership — local milestone complete:** see SMART-SITES-RECOVERY.md.
   Remaining production readiness includes edge abuse protection, scheduled draining, operator
   alerts, key backup/rotation and retention. Actual staff roster/working-hour policy is not inferred.
2. **Client onboarding — local draft/readiness milestone complete:** see SMART-SITES-ONBOARDING.md.
   Three labeled browser-created client drafts, platform-only setup selection and credential-only
   checks are verified. No cross-client CRM impersonation, automatic invitation or one-click launch.
3. **First-party acquisition measurement:** versioned page/form/voice-to-lead events with consent, retention, opt-out, bot filtering and lead/outcome joins. Add response speed, qualification, appointment and estimate stages. Current counts are not a visitor/conversion-rate dashboard.
4. **Organic discovery:** indexable service and real project pages, canonical/sitemap/schema/performance, then verified service-area content around the outer Atlanta market. No fabricated local offices, doorway city-page sprawl, guaranteed rankings or synthetic reviews. Search Console/Business Profile access remains unverified.
5. **Communications and voice:** owner-approved sending identity, recipient roster, consent enforcement, unsubscribe/suppression, provider acceptance and delivery tests; approved agent tool for a structured, consented lead handoff. No automatic forwarding of claim documents or transcripts. Existing voice itself was not modified or re-verified this turn.
6. **BIE outcomes and economics:** feed verified events into bounded recommendations and the run ledger; reconcile appointments, estimates, won contracts, collected payments, job cost and margin through appropriate connectors. Keep estimates, cash and profit distinct. No autonomous ad purchasing or campaign publishing without budget/policy approval.

**Launch gates:** specific deployment target/release approval, database backup/migration review, separate client organization and staff access, server secret installation, HTTPS/browser acceptance, contact/privacy/retention policy, failure recovery and alert destination tests. None were bypassed. No push, public release, DNS change, production tenant edit, real outbound message or paid provider call occurred.

Technical references: [Drizzle transactions](https://orm.drizzle.team/docs/transactions), [PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html).
