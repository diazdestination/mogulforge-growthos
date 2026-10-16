# Package C: reviewed TEST execution contract

The original ef52778 local API slice and pre-repair staging smoke are historical
evidence. Their artifacts remain unchanged. They do not establish today's schema,
provider holds, complete company acceptance or permission to run this successor.
ROOT supplies fresh fixtures, attestation and execution authorization after source
review. This document grants none of those actions.

`lib.mjs` accepts only exact parsed origins `http://127.0.0.1:4192`,
`http://127.0.0.1:4193`, or `https://mogulforge-growthos-staging.fly.dev`.
Production Fly aliases, HTTP staging, custom ports, paths, credentials, query and
fragment components are refused. `STAGING_HOST_ALLOW` has no effect.

## Manifest and actual read-only admission

The staging CLI requires `ACCEPTANCE_MANIFEST` and its exact file-byte SHA256 in
`ACCEPTANCE_MANIFEST_SHA256`. ROOT reviews/pins those bytes. It must contain no
password, site secret, cookie or saved browser state. Keys are resolved from only
`TEST_PAINLESS_SITE_KEY` / `TEST_CSS_SITE_KEY` in process memory; staff sign-in
modules read Credential Manager into memory. Each module's file-byte SHA256 is
bound in its staff entry and checked before import.

The manifest shape enforced by `guards.mjs` is:

```text
kind: GROWTHOS_ACCEPTANCE_EXECUTION_V1
runId: fresh UUID (also the immutable evidence directory identity)
origin: exact approved origin
preparedAt / expiresAt: finite current window, at most 15 minutes
reviewedBy: ROOT
source: { commit: exact harness HEAD, tree: exact HEAD tree, clean: true }
companies: exactly painless and css, distinct TEST organizations/sites/staff:
  { key, name: TEST..., slug: test-..., organizationId, siteId,
    siteName: TEST...,
    staff: [{ id, role, last, credentialModule: file:///...,
              credentialModuleSha256: exact module byte hash }, ...] }
  Painless: owner + owner; CSS: owner + office; all accepted active staff.
attestation: ROOT's fresh nonsecret read-only provider/fixture receipt:
  { kind: ROOT_PROVIDER_READ_ONLY, observedAt, stopAt,
    origin, app: mogulforge-growthos-staging,
    configSha256, imageSha256,
    release: { sha, builtAt, environment: staging },
    frontendIndexSha256: exact deployed index.html response-byte hash,
    schema: { database: growthos_staging, cluster: zp2wjrejd2zodn4q,
              tables: 142, columns: 1870, catalogSha256 },
    holds: { outbound: true, scheduler: false, communications: false,
             stagingOutboundApproved: false, recipientAllowlistEmpty: true },
    fixturesSha256: SHA256(JSON.stringify(companies)) }
attestationSha256: SHA256(JSON.stringify(attestation))
```

SHA fields are lowercase hex (40 for source commit/tree/release SHA; 64 for
SHA256). Freshness is limited by both manifest expiry and ten minutes after the
attestation. Expiry cannot exceed the actual attested staging stop window.
Missing, stale, mismatched or secret-bearing input holds before browser launch.
Manifest facts are safety inputs. Their authority/provenance comes from ROOT's
reviewed attestation and file-byte pin, not a caller's environment label.

Before any business mutation, both browser staff sessions must pass existing
read-only `/api/readyz`, `/api/v1/session`, `/api/v1/me`, `/api/v1/smart-sites` and
`/api/v1/users` reads. The actual release, fetched frontend bytes, exact actor,
role, non-platform-admin status, TEST organization name/slug/ID, tenant-scoped
site ID/name, and accepted staff roster must match. No new product API is used.
The application does not expose all provider holds/schema facts; those remain
ROOT-attested, never inferred from a browser page. Login is the necessary
authentication-only exception: it requires the validated manifest and exact
origin before sign-in; business writes remain blocked until session admission.

Every API and public-intake mutation rechecks the signed-in session, origin,
expiry and fixture token. Browser request interception applies the same boundary
to form submits. Delivery/send, dispatch, DELETE and platform mutations are not
part of the workday slice. Public intake/check calls must use the admitted site.
Temporary after-hours policy changes restore their original TEST policy in a
`finally` path; a failure is reported, never silently graded PASS.

## Fixture setup and permission truth

ROOT coordinates separately authorized setup; this workday runner does not
provision companies, issue/rotate keys or change memberships. The selected
cross-organization `/platform/clients/.../key` setup route needs platform admin.
Owner/admin users with `settings.manage` can create/manage their own tenant's
sites and rotate their own keys through ordinary tenant routes. An office user
does not gain that permission. Do not require platform administration merely to
manage an owner's own site key, or put two client companies in one organization.

Use TEST labels and fictional values only. Hours/timezones/checklists are TEST
placeholders until recorded company decisions. Creating real customer records,
enabling a sender/provider, making real sends or extending the staging window
requires its separate authorization. No cleanup deletion is implemented.

## Authorized execution and evidence

After ROOT explicitly authorizes the fresh manifest's execution:

```powershell
$env:BASE_URL = 'https://mogulforge-growthos-staging.fly.dev'
$env:ACCEPTANCE_MANIFEST = '<ROOT fresh nonsecret manifest path>'
$env:ACCEPTANCE_MANIFEST_SHA256 = '<ROOT reviewed exact file-byte SHA256>'
# ROOT injects site secrets into the two named process variables in memory.
node scripts/acceptance/run-workday-acceptance.mjs
```

The read-only `staging-smoke.mjs` uses the same bound manifest and first staff
member, then GET/page observations only after authentication. Its sign-in is not
a business mutation. This source correction itself ran neither command.

Each execution creates a new exclusive
`C:/Forge/artifacts/growthos-launch-codex-20261016/acceptance-guardfix/run-<runId>/`.
Existing run IDs/results/screenshots are never overwritten. JSON headers bind
harness commit/tree, actual reviewed deployment release, frontend byte hash,
schema attestation and fixture identities. Arbitrary response/credential extras
are excluded. No storageState, browser recording, HAR or video is saved.

The corrected link includes organizationId and appointmentId. Completion API
responses are recorded as API observations. A refreshed image has a separate
UI subclaim: invalid-link state is a harness FAIL; otherwise completed-UI proof
is honestly NOT_RUN until a real settled UI assertion is added and executed.
Screenshots alone never turn it into PASS. The historical 17 API-slice case
passes are not mechanically reduced or converted to product completion FAILs.

## Disposable local run

After committing/reviewing the harness source and setting up local dependencies,
`node scripts/acceptance/acceptance-runtime.mjs --run` creates a new isolated local
runtime and runs the harness in the same process. The runtime builds both API
and frontend from its clean source into its owned temporary cache, captures the
actual schema/release/index identities, creates a local fixture manifest with
`LOCAL_RUNTIME_READ_ONLY` / runtimeId, and keeps credentials/site keys in memory.
Only the nonsecret public manifest is written. There is no password/key-bearing
manifest for a second process. Without `--run`, it starts the owned local runtime
but does not execute the workday chain. Existing listeners are preserved.

Static ownership/cleanup code and pure guard tests do not prove teardown after
forced termination, process crashes or setup faults. That limit remains open.

## Separate acceptance boundaries

Keep all nine STATE rulings: current schema/backup belongs to operator evidence;
provider/inbox/phone/device paths need real authorized proof; synthetic customer
CSV is not full history/balance migration; real company inputs remain required;
engineering P2 is not a company waiver; card/bank collection is owner-deferred
while signed scope/invoices/delivery/balances/external receipts stay separate;
unautomated UI/concurrency/date boundaries remain open; crash cleanup is unproven;
C2/cutover/CI/merge/billing/launch have their own authority and evidence.
