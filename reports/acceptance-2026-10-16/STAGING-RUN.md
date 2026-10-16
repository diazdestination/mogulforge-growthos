# Staging run: contractor acceptance automation (package C)

Run this only against the staging URL that Codex published in the progress log of
`C:\Forge\CODEX_REQUEST_GROWTHOS_LAUNCH_DIVISION_2026-10-16.md` or in its handoff.

As of October 16, 2026 that URL is `https://mogulforge-growthos-staging.fly.dev`:

- PR63 `02306ef` image
- outbound holds on
- auto-stop at 15:00 PDT

Never point these scripts at production. `lib.mjs` refuses any host that is not
loopback or listed in `STAGING_HOST_ALLOW`, and it refuses production-looking
hosts.

## 0. Gate: schema compatibility (currently FAILING)

Run the read-only smoke first:

```powershell
cd C:\Forge\worktrees\growthos-claude-acceptance-20261016
$env:BASE_URL = 'https://mogulforge-growthos-staging.fly.dev'
$env:STAGING_HOST_ALLOW = 'mogulforge-growthos-staging.fly.dev'
node scripts/acceptance/staging-smoke.mjs
```

The smoke signs in the Codex TEST owner and makes GET requests only. It keeps the
credential in memory and saves no storageState, trace or video. It writes
`C:\Forge\artifacts\growthos-launch-claude-20261016\acceptance\staging-smoke-results.json`.

**Proceed only when every READ and PAGE row is PASS.** On October 16 these
returned 500 because migration 0019 is missing (GAPS.md GAP-01):

- `/api/v1/settings`
- `/onboarding`
- `/contractor/today`
- `/appointments`
- `/projects`

Do not work around it. Applying 0019 is a ROOT decision under the scope freeze.

## 1. TEST record setup (Codex, platform admin, staging only)

Only Codex can do this setup. The staging TEST owner is not a platform admin,
and site keys need a platform admin. Create **TEST-labeled records only**,
through the same normal API the local runtime uses (`scripts/acceptance/acceptance-runtime.mjs`,
`provisionTestCompanies`).

1. **Create two TEST companies.**
   - Call `POST /api/v1/platform/clients` once per company, as a platform admin,
     with `Origin` equal to the staging origin.
   - Painless:
     `{requestId:<uuid>, name:"TEST Painless Roofing", slug:"test-painless-roofing", profile:"roofing-exteriors", timezone:"America/New_York", responseTargetMinutes:30, confirmed:true}`
   - CSS:
     `{…, name:"TEST Climate Simulation Solutions", slug:"test-climate-simulation-solutions", profile:"hvac", timezone:"America/New_York" (placeholder until O-15)}`
2. **Issue each TEST site key** with
   `POST /api/v1/platform/clients/:orgId/sites/:siteId/key`, body
   `{confirmed:true, expectedVersion:1}`.
   - Store each `secret` in Windows Credential Manager, or pass it via an env var
     (for example `TEST_PAINLESS_SITE_KEY` and `TEST_CSS_SITE_KEY`).
   - Never put it in a file in Git.
3. **Provision two accepted TEST staff per company** with the same method used for
   the existing TEST owner (`provision-test-owner.mjs`):
   - Painless: Owner A and Owner B, both `owner`.
   - CSS: Owner-Tech (`owner`) and Office Lead (`office`).
   - Use `@example.invalid` emails and Credential Manager targets.
   - Expose a sign-in module per staff member, like `test-owner-auth.mjs`.
4. **Write the staging manifest** to the private artifact folder, never to Git.
   Use the same shape as `local-runtime-manifest.json`, with credential modules
   instead of passwords:

```json
{
  "environment": "STAGING mogulforge-growthos-staging (TEST records only)",
  "companies": [
    { "key": "painless", "name": "TEST Painless Roofing", "organizationId": "…", "siteId": "…",
      "siteKeyEnv": "TEST_PAINLESS_SITE_KEY",
      "staff": [
        { "id": "<userId>", "last": "Painless Owner A", "credentialModule": "file:///C:/Forge/artifacts/…/painless-owner-a-auth.mjs", "signInExport": "signInTestOwner" },
        { "id": "<userId>", "last": "Painless Owner B", "credentialModule": "file:///…/painless-owner-b-auth.mjs" } ] },
    { "key": "css", "name": "TEST Climate Simulation Solutions", "…": "same shape" }
  ]
}
```

Do not create demo companies or any non-TEST records. Each company's
`timezone`/hours policy in the run is a TEST placeholder and does not record a
company decision.

## 2. Run the same automation against staging

Run this only after step 0 is all PASS and step 1 is done:

```powershell
cd C:\Forge\worktrees\growthos-claude-acceptance-20261016
$env:BASE_URL = 'https://mogulforge-growthos-staging.fly.dev'
$env:STAGING_HOST_ALLOW = 'mogulforge-growthos-staging.fly.dev'
$env:ACCEPTANCE_MANIFEST = 'C:\Forge\artifacts\growthos-launch-claude-20261016\acceptance\staging-manifest.json'
$env:TEST_PAINLESS_SITE_KEY = '<from Credential Manager, in-memory only>'
$env:TEST_CSS_SITE_KEY = '<from Credential Manager, in-memory only>'
node scripts/acceptance/run-workday-acceptance.mjs
```

The results go to `…\acceptance\workday-staging-results.json` and the screenshots
to `…\acceptance\screenshots\`. The script does the following:

- It never calls `/delivery/send`. It stops at the email preview.
- It changes the TEST staff-alert policy temporarily for the after-hours routing
  check, then restores it.
- It creates TEST customers, leads, visits, assets, checklists, invoices,
  receipts and service records inside the two TEST orgs only.

Staging data is disposable. Do not try to delete it from the scripts.

## 3. Expected staging differences from local

| Item | Local | Staging |
| --- | --- | --- |
| Alert coverage outcomes | `no_eligible_device` (no devices) | `no_eligible_device`, because web push is disabled. A queued push needs O-11 and real iPhones (device-only). |
| Email previews (G06-01, N-03, standing reminders) | BLOCKED: no sender | BLOCKED until an approved Gmail/Microsoft TEST sender is connected (O-04/O-05) **and** an approved recipient is on `STAGING_EMAIL_RECIPIENT_ALLOWLIST`. Even then, the script only previews. A real send needs Adam's per-send approval. |
| Manual SMS drafts (P-D/H-K) | FAIL (GAP-02) | Expected to FAIL the same way until GAP-02 is decided |

## 4. Still not automatable (device or people only)

These need real devices, providers or people:

- iPhone install, lock-screen, Focus, offline and tap-through cases (P-01…P-10)
- CALLIE and voice cases (V-01…V-12)
- Twilio SMS S-01…S-08, plus handset send for S-09
- mailbox receipt, reply and revocation (E-01…E-10)
- real HCP export reconciliation (P-A/H-A with O-12/O-13)
- unassisted workdays (P-L/H-L)
- growth/nurture (P-K)

Record them with `RESULT-TEMPLATE.md` against the exact deployed release.

## 5. After the run

1. Append one dated line to the request file's progress log with the PASS, FAIL,
   BLOCKED and NOT-RUN counts.
2. Update the Staging column in `CASES.md`.
3. Stop staging when the window ends, if Codex requires it. Codex owns the stop
   step (`stop-staging.mjs`).
