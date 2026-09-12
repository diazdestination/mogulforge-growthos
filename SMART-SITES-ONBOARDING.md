# Smart Sites client onboarding — local acceptance

September 12, 2026. Local implementation passed. **Not a public release or completed production onboarding.**

## What is now usable

`/platform` is the Client Launchpad, linked in navigation only for platform administrators.
It extends the existing platform console; `/onboarding` remains the existing organization setup
wizard and `/capture` remains that organization's lead workspace. Advanced legacy organization
creation/rename controls are preserved in a collapsed section.

Create a new client with a company name, unique identifier, timezone, service profile and an internal
elapsed-time first-attempt target. Explicit confirmation is required. Organization, neutral settings,
starter service catalog, inactive site, provisioning receipt and audit event commit atomically.
Four profile configurations are supported: roofing/exteriors, HVAC, commercial construction and
local retail/tea shop. They are not complete vertical products (no invented inventory, POS, estimates,
appointments or industry-specific automation).

The creator is **not joined to the client organization**. Selecting a client only changes this
bounded configuration/readiness view. It never overwrites `users.organizationId`, impersonates a
staff member, or opens another client's CRM. The existing identity model still has one organization
per user. Cross-client CRM switching and client-owner invitations are not implemented by this flow;
approved staff access remains a separate launch gate, not an implied capability.

No client staff, customer records, subscriptions, public domains, provider connections, legacy
capture installations, playbooks or outbound automations are created by the new draft operation.
The widget's capture and concierge flags start disabled. Template reminder/concierge copy is stored
as neutral configuration only. No Painless credentials, branding, contact data or service areas are copied.

## Authorization, retries and evidence

- The existing `requirePlatformAdmin` gate rereads an active session user; ordinary owners, inactive
  admins, anonymous requests and API keys cannot provision clients or manage another client's key.
- All new platform routes use that gate. The route-inventory regression test now enforces it and
  includes the previously omitted Smart Sites permission declarations.
- Strict request schemas reject tenant injection, unknown fields, invalid profiles/timezones,
  unconfirmed mutations and unreasonable response targets. Browser requests must match APP_ORIGIN.
- A stable UUID plus normalized configuration hash reconciles retries and concurrent double-submits.
  Changed payload with the same actor/request UUID conflicts. A different UUID with a taken slug
  conflicts instead of silently reusing another business. Receipt failure rolls back the entire draft.
- `smart_site_onboardings` records configuration identity and IDs only, never customer payloads or keys.
- New drafts start with an unissued random key hash whose plaintext is discarded. Explicit issuance
  returns a fresh server key once, increments its version, clears its credential check and disables
  intake. The platform action requires the expected version, so a stale operator cannot rotate over a
  newer change unknowingly. Rotation through the existing `/capture` endpoint also clears the check.
- The UI holds the one-time key only in component state, not a query/mutation cache, URL or browser
  storage. Hide, organization changes, site changes and unmount discard it. Never screenshot it.
- Handoff template uses credential placeholders and includes the fixed site/profile/source/target.
  Its organization ID is configuration context only; public intake still rejects browser tenant IDs.

## What each readiness state proves

| Readiness item | Actual evidence / limit |
| --- | --- |
| Isolated organization | Existing organization ID and identifier. |
| Service profile | Stored starter intake configuration; confirm actual offerings before public use. |
| Staff access | Counts of active managers/responders in that organization. Not approved roster or completed invite acceptance. |
| Credential issued | Recorded issuance time/version. Null historical dates stay unknown, not backfilled. Preserve an already installed historical key. |
| Credential handshake | A caller authenticated the current per-site key. No customer record is created. Older than 24 hours is labeled Recheck needed. Not proof that a public website is installed or operating. |
| Intake save observed | Latest saved receipt timestamp. Can be synthetic or from an earlier key; not current public-form acceptance or revenue. |
| Capture switch | API enabled/disabled only, not a deployment or domain assertion. |
| Launch review | Always not assessed by this screen. No manual green-check checklist masquerades as verified release approval. |

Readiness queries return allowlisted organization/site configuration, staff counts and the most recent
receipt time. No contacts, customer names, lead details, staff email addresses or credential hashes.
Failed/malformed reads show unavailable instead of zero counts or successful checks.

Credential-only server check:

```text
POST /api/v1/public/smart-sites/:siteId/check
Authorization: Bearer <server-only-site-key>
Content-Type: application/json

{"schemaVersion":1}
```

It rejects browser Origin, wrong-site/stale keys and extra data; is bounded by a 20/minute IP rate
limit; locks the site during verification; and writes a credential-only audit event. It works with
capture disabled and creates no lead/task, campaign, message or payment. It cannot assess whether
the caller is a website server versus an authorized developer running the check manually.

`node scripts/smart-site-check.mjs` reads GROWTHOS_API_ORIGIN, GROWTHOS_SITE_ID and
GROWTHOS_SITE_SECRET from its environment. Default target is loopback; the only allowed remote origin
is `https://app.mogulforge.ai`, additionally gated by `--allow-live`. Do not use that flag without
approved production acceptance. Redirects are refused, timeout is eight seconds and output excludes
the key. No production check was performed in this milestone.

## Schema / implementation

- `lib/db/src/schema/smart-sites.ts`: new provisioning table; nullable credential issuance/check
  timestamps and a credential version column on `smart_sites`.
- `services/client-onboarding.ts`, `routes/v1/client-onboarding.ts`: atomic provisioning, bounded
  readiness and credential-only acceptance. No external provider request in these services.
- `components/client-launchpad.tsx`, `pages/platform.tsx`, `components/shell.tsx`: operator UX and
  role-gated navigation. Form entries and retry UUID survive recoverable failures; save feedback
  receives focus and scrolls into view. Client changes reset sensitive local state.

Schema was pushed only to the explicitly guarded local PostgreSQL database. Before production,
inspect the additive schema plan, back up the database and approve the migration with the preceding
Smart Sites migrations. No production schema, user, credential or tenant was altered.

## Reopen locally

1. Keep Docker `mogulforge-smart-sites-dev`, database `mogulforge_smart_sites_test` on
   `127.0.0.1:55432`. Do not delete its fixture data or the Painless journal/keys.
2. Build the API; from `artifacts/api-server`, run `node scripts/smart-sites-local-run.mjs api`.
   It fixes the isolated DB, strips provider credentials, binds loopback:3001 and leaves auto migration off.
3. Use the existing GrowthOS Vite preview on `http://127.0.0.1:5173/platform` (API_PORT=3001).
4. Separate synthetic operator: `operator@smart-sites-local.example.test` / `LocalOperatorOnly!2026`.
   This identity is only a local fixture, never a real login to create in production.
5. To restore the fixture, `client-onboarding-local-seed.mjs` requires the exact local test DATABASE_URL.
   It refuses mismatched existing identity/org data, does not promote the Painless owner, and does
   not reset an existing password. `client-onboarding-local-inspect.mjs` is read-only and prints no keys.
6. The Painless owner remains `owner@painless-local.example.test` / `LocalPreviewOnly!2026` in its
   original organization. Sign in as that identity to inspect its `/capture` CRM workflow; selecting
   Painless in the platform setup view intentionally does not grant its CRM membership.

Browser-created labeled fixtures:

| Workspace | Organization ID | Site ID | Status |
| --- | --- | --- | --- |
| HVAC — LOCAL ONBOARDING QA | 082748aa-67ed-4106-be07-e5fc2e312315 | 61de9962-e418-495a-98ff-be77d69f67fe | Draft; one UI-issued QA key hidden, not installed or retained; rotate explicitly for any further acceptance. |
| Commercial Construction — LOCAL QA | b3d0acb1-cf85-457a-b907-723ec7de2d60 | 73fb8904-2fef-464e-b266-d693ebeb6704 | Draft; no key issued. |
| Dawsonville Nutrition — LOCAL DRAFT QA | 75aaef58-9833-4563-a852-d73c82b66644 | e2480a2f-1257-46e1-b91b-2a54e8e47be9 | Draft; 120-minute internal target; no key issued. |

All three have zero staff and zero leads. They are not operational client accounts. The separate
operator organization is `b07db1b5-a5c2-4f28-a3ce-368886152d53`; its user is
`d4e55ddf-1ce8-4ae2-9ad3-f056e84cdda4`. Painless retains its original site credential/version,
six synthetic leads, six initial tasks and one synthetic staff log. A local credential check was
recorded at 17:49:56.646 UTC on September 12, 2026 without rotating its key or changing intake status.

## Verification / next priority

Automated: 123 backend tests across nine suites; 218 frontend tests across 41 files; 41 Painless
regressions. API/UI TypeScript and both GrowthOS builds passed. Existing font-order, bundler
deprecation and large-bundle warnings remain; this is not a Lighthouse certificate.
Browser QA and screenshots: `design/client-onboarding-qa.md`, `design/qa-client-onboarding-2026-09-12/`.

The next build priority is **consent-first acquisition measurement**: durable, tenant-scoped
page/form/voice events with opt-out/retention and real lead/outcome joins. No visitor-conversion rate,
revenue uplift, collected-cash or profitability claim is supported by these synthetic fixtures.

Before any client goes live: approved owner/staff access, real business profile/service confirmation,
server secrets, a reviewed migration, HTTPS/browser acceptance, recovery scheduling/alerts,
retention/key backup, abuse protection and explicit release approval. This launchpad does not
provision staff invitations or bypass those gates. No push, deployment, DNS, payment, live email/SMS,
production tenant mutation, marketing-repo change or Painless website code change occurred.
