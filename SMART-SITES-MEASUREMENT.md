# GrowthOS Smart Sites — consent-first acquisition measurement

September 14, 2026. Implemented and verified only in the isolated local Smart Sites
environment. This is not a production release.

## Outcome

GrowthOS can now measure a bounded, first-party Smart Site journey from an explicitly
consenting browser to an authoritative lead receipt and later recorded CRM outcomes.
The branded website remains independent; GrowthOS remains the tenant-scoped system of
record. The collector is disabled by default for every site.

Painless now presents a real allow/decline choice, exposes persistent privacy controls,
and sends only an allowlisted event contract through its same-origin server facade. The
site secret never enters the browser. Turning measurement off removes that browser's
pseudonymous event history and unlinks its identifier from retained operational lead
records; it does not delete the customer's inquiry.

## Stored contract

- Schema version `1`, literal consent `true`, current policy version, random visitor ID,
  random session ID, and at most 20 events per request.
- Allowlisted event names only: page view, project/damage starts, voice or quiet-text
  starts, phone-link clicks, gallery opens, and review-source opens.
- Bounded values only: path without query text, referrer host, source, medium, campaign,
  service code, surface, and step.
- Excluded: contact details, full/raw URLs, files, photos, claim documents, transcripts,
  message content, full user agents, fingerprinting fields, and cross-site advertising IDs.
- Site/event idempotency rejects an edited replay instead of silently rewriting history.
- Collection ignores obvious crawler/monitor user agents. Privacy erasure remains
  available even when the user agent is automated.

## Truthful metrics

- `Consented visitors`: distinct first-party browser identifiers, not unique humans.
- `Saved inquiries`: distinct leads backed by GrowthOS Smart Site receipts, not clicks.
- `Phone-link clicks`: clicks only; not proof of a placed, answered, or completed call.
- `Median to staff-recorded attempt`: an explicit staff log, not provider delivery or reply.
- `Appointments` and `estimates`: corresponding GrowthOS records, excluding cancelled
  appointments and draft estimates.
- `Recorded wins` and `won contract value`: recorded CRM outcomes and contract value;
  not collected cash, margin, ROI, or profit.
- Source and service rows do not put the same visitor into an unknown bucket when an
  explicit value exists. A browser can still show explicit interest in more than one
  service, so dimensional rows are not promised to be additive.

## Operator and public routes

- `GET /api/v1/smart-sites/acquisition?days=30` — organization-scoped report.
- `PATCH /api/v1/smart-sites/:id/measurement` — owner/admin enablement and retention.
- `GET /api/v1/public/smart-sites/:id/acquisition-status` — server-key status.
- `POST /api/v1/public/smart-sites/:id/acquisition-events` — bounded event batch.
- `POST /api/v1/public/smart-sites/:id/analytics-opt-out` — browser erasure/unlink.

The Painless worker exposes only fixed same-origin `/api/acquisition/*` paths and adds
the secret server-side. It cannot be used as an arbitrary proxy.

## Local acceptance

The schema change was pushed only to Docker container `mogulforge-smart-sites-dev`,
database `mogulforge_smart_sites_test` on loopback port `55432`. Painless measurement
was enabled only for local site `5c516d6f-50ea-4b26-a7d3-5710864221d8`.

`C:\Users\diazd\dev\projects\painless-roofing-site\scripts\smart-sites-acquisition-acceptance.mjs`
is a loopback-only acceptance harness. It creates a visibly labeled synthetic inquiry,
never a customer record. Final acceptance produced three consented events, a GrowthOS
lead ID, and a receipt ID. Two earlier runs also reached `saved` but exposed a harness
field-name mismatch; all three local records are labeled
`LOCAL ACQUISITION QA — NOT A CUSTOMER`. They must never be contacted.

Latest local report after acceptance: 4 consented browser IDs, 3 starters, 3 synthetic
saved inquiries, zero appointments, zero estimates, zero wins, and zero won value.
The fourth browser was the rendered page-view check and has no lead. Browser console
checks returned no warnings or errors.

Verification: 126 guarded backend tests, 219 GrowthOS UI tests, 46 Painless tests,
GrowthOS type/build, Painless build, clean diff checks, and desktop/mobile rendered QA.

## Production gates still open

- Reviewed production migration and database backup.
- Specific deployment/release approval for both GrowthOS and the Painless site.
- Approved privacy language, retention period, and owner/admin measurement enablement.
- Production server secret installation and current HTTPS browser acceptance.
- Monitoring/alerting for collector or erasure failures.
- Real staff workflow and client-owner acceptance.

No production database, provider, public preview, domain, DNS, ad account, real customer,
or outbound communication was changed by this milestone.

## Next priority

Build the reusable organic acquisition layer: indexable, evidence-backed service,
location, and project pages; canonical/schema/sitemap controls; a project publishing
workflow; and explicit GrowthOS content-to-inquiry attribution. Avoid mass-produced
doorway pages and do not make local-ranking claims without Search Console and Business
Profile evidence.
