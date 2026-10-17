# GrowthOS Smart Sites — consent-first acquisition measurement

September 14, 2026. Implemented and verified only in the isolated local Smart Sites
environment. This is not a production release.

## Latest checkpoint — landing-content attribution

The next organic-content milestone is now implemented locally. The acquisition report returns the
first recorded landing path within the selected window for each consented browser and joins that path to real Smart Site lead
receipts and recorded wins. The command center labels homepages, service guides, service areas, and
project stories in a dedicated `Landing content` card. Returning visits and cross-device identity
remain incomplete by design, and search visibility/rankings still require separate Search Console
evidence.

Painless now emits 20 evidence-backed, prerendered service/location/project routes with canonical,
schema, sitemap, and robots controls. Full content and QA details are in
`C:\Users\diazd\dev\projects\painless-roofing-site\design\organic-acquisition-qa.md` and
`design\organic-content-workflow.md` in that repository.

Final local verification: 1,036 executed API tests passed with 15 intentional skips; 219/219
command-center tests; repository type checks/builds; 51/51 Painless tests; desktop/mobile browser
QA; empty consoles; clean diff checks. Nothing was pushed or deployed, and no measurement setting,
production database, Search Console/Business Profile account, real customer record, or provider was
changed.

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

## Unusable measurement no longer blocks a lead (October 16, 2026; owner-approved)

Measurement is optional; the inquiry is not. When a lead arrives with a well-formed
`measurement` block that cannot be used, GrowthOS saves the lead **without** the
measurement. That happens when the site's analytics is off or the browser consented under
a stale policy version. A malformed measurement block still fails strict validation with
400, as before. When measurement is dropped, nothing about it is kept: no visitor link on the lead,
no `lead_saved` analytics event, and no measurement values stored. The `201` receipt and
the `smart_site.lead_saved` audit metadata carry only `measurementDropped:
"analytics_disabled" | "analytics_policy_version_mismatch"`. Previously these leads were
rejected with `503 site_measurement_disabled` / `409 analytics_policy_version_mismatch`.
Paused companies (`423 customer_lifecycle_paused`) and disabled capture
(`503 site_capture_disabled`) are unchanged, and the acquisition-events route still
rejects events for a disabled site or stale policy.

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

Prepare the controlled production release and evidence baseline: owner fact/photo approval,
current-site backup and redirect mapping, reviewed migrations/settings, exact-source public smoke
tests, one separately approved labeled acceptance inquiry, and authorized Search Console/Business
Profile baselines. Do not publish, enable measurement, create production data, or touch DNS without
the applicable explicit approval.
