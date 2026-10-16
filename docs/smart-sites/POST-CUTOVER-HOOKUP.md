# Smart Site hookup after cutover: Painless and CSS

October 16, 2026. Package D of the GrowthOS launch. This runbook connects the two live
contractor websites to GrowthOS once production cutover is done. **Nothing in sections 2–4
runs before cutover.** Production site records stay forbidden until then. The staging TEST
variant (section 6) runs first and needs no production access.

Who does what:
- **Codex (WILLOWFORGE ROOT)** owns production, secret-store writes, deploys and every
  hosted TEST-lead cleanup (section 2 step 9).
- **Adam** approves each production step: provisioning, secret install, the flag flip and
  the labeled TEST lead.
- **Claude** prepared the tooling and runs it only against local or staging, and only when
  asked. Claude hands back IDs (organization, site, lead, request, receipt, task, contact)
  and never credentials.

## 0. Tools

| Tool | Purpose |
| --- | --- |
| `scripts/smart-sites/provision-site.mjs` | Creates or verifies the company's site record, checks the credential, sets analytics and turns capture on. Dry run unless `--apply`. Production needs `--i-have-owner-approval`. A secret is issued only when the site is created, or with an explicit `--rotate-secret --expected-credential-version <n>`. It goes to **stdout exactly once**, as soon as GrowthOS confirms it. The JSON report goes to stderr. |
| `scripts/smart-sites/acceptance-lead.mjs submit` | **GrowthOS contract check only.** First checks that the session belongs to `--company` and owns `GROWTHOS_SITE_ID`. Then sends one labeled TEST lead straight to the intake API. Checks the receipt, the replay, the lead in that workspace, the office task, the follow-up record and owner-alert coverage. It never goes through a website. |
| `scripts/smart-sites/acceptance-lead.mjs cleanup` | Removes that TEST lead in one transaction. Dry run unless `--apply`. Database owner only (section 5). |

Allowed environments are fixed in `scripts/smart-sites/common.mjs`:
- `local` is a loopback API only.
- `staging` is exactly `https://mogulforge-growthos-staging.fly.dev`, and every record name
  must contain `TEST`.
- `production` is exactly `https://app.mogulforge.ai` plus `--i-have-owner-approval`.

Aliases are refused. That includes the production app's Fly hostname under `--env staging`
and any other host under `--env production`.

**Session (`GROWTHOS_OWNER_SESSION`).** Use an owner/admin session issued by the app for
the exact target workspace. API keys cannot manage Smart Site settings. To get one:

1. Sign in through the normal application login.
2. Keep the session only in this command's environment.
3. Let the script verify it against `/me`.
4. Revoke it afterwards with `POST /api/auth/logout`, sending it as a Bearer token.

Never read or copy a browser cookie store, never print the session, and never persist
browser storage state. On staging, reuse the approved TEST owner sign-in in
`C:\Forge\artifacts\growthos-staging-acceptance-20261016\test-owner-auth.mjs` and its
existing Windows Credential Manager target. Do not create a second owner.

**Other inputs.** `GROWTHOS_SITE_ID` and `GROWTHOS_SITE_SECRET` are only for the TEST lead.
`DATABASE_URL` is only for cleanup. All of them come from environment variables, never from
command-line arguments.

**Allowed origin.** `--site-origin` is validation and reporting only; it is not an
app-side allowed-origin registration. GrowthOS has no per-site origin column, and the scope
freeze rules one out. Intake is server-to-server only and rejects requests that carry a
browser `Origin` header, but that rejection does not prove which website sent a request.
The **site secret** is the authentication boundary. Each worker pins
`GROWTHOS_API_ORIGIN`, serves its own `SITE_PUBLIC_ORIGIN`, and binds outbox rows to
`siteId|origin`. Verify all of that on the exact deployment.

## 1. Values per site

| | Painless Roofing & Water Restoration | Climate Simulation Solutions (CSS) |
| --- | --- | --- |
| Hosting | Cloudflare Sites project (`worker/growthos.js`, `worker/index.js`) | Cloudflare Worker `climate-simulation-solutions-site` (`site/`) |
| GrowthOS profile | `roofing-exteriors` | `hvac` |
| `--site-key` | `painless-roofing-website` | `climate-simulation-solutions-website` (= `growthos.sourceKey`) |
| `--site-origin` | Provisional: `https://painless-roofing-preview.dripdiaz.chatgpt.site`, the recorded deployed host. Re-verify the host and config when you run this. `https://painlessroofingandwaterrestoration.com` is the post-DNS candidate only; do not assume DNS has moved. | `https://csshvac.com` |
| `--company` | Read the exact production workspace name from GrowthOS after cutover. Never invent it. | same |
| GrowthOS on/off flag | `PAINLESS_GROWTHOS_ENABLED` | `SMART_SITE_GROWTHOS_ENABLED` |
| `GROWTHOS_API_ORIGIN` | `https://app.mogulforge.ai` (the worker hard-pins this host) | `https://app.mogulforge.ai` (`growthos.apiOrigin`, which defaults to production) |
| `GROWTHOS_SITE_ID` | site ID from the provisioning report | secret |
| `GROWTHOS_SITE_SECRET` | **secret**, from provisioning stdout | **secret** (Secrets Store binding), from provisioning stdout |
| Outbox | `PAINLESS_OUTBOX_ENCRYPTION_KEY` set (backed up, fingerprint `efba7c8f`), `PAINLESS_OUTBOX_ENABLED=true` | `SITE_OUTBOX_ENCRYPTION_KEY` and `SITE_OUTBOX_DRAIN_SECRET` present, `SITE_OUTBOX_ENABLED=true` |
| Email fallback today | `PAINLESS_EMAIL_ENABLED=true` (damage check). Project inquiries already require GrowthOS and show the phone fallback. | `SITE_EMAIL_ENABLED=true`, `emailBridge.preGrowthOS=true` |

**Analytics.** Provision with `--analytics off` unless Adam approves measurement for that
site. A well-formed measurement block that cannot be used is dropped and the lead is still
saved. That covers analytics turned off for the site and a stale policy version (see
`SMART-SITES-MEASUREMENT.md`). A malformed measurement block is still rejected with 400.
Adam approved this behavior on October 16.

## 2. Order (production, per site, after cutover)

Run Painless and CSS one at a time. Do not start the second until the first passes step 7.

1. **Readiness.** Confirm cutover is complete. The workspace must have at least one active
   manager and one active responder; the launch guard enforces this. Get Adam's go.
2. **Provision (dry run).** Expect `create_site`, `credential_check`, `enable_capture` and
   empty stdout. For an existing site, note `current.credentialVersion`.

   ```sh
   GROWTHOS_OWNER_SESSION=... node scripts/smart-sites/provision-site.mjs \
     --env production --api https://app.mogulforge.ai --i-have-owner-approval \
     --company "<exact org name>" --site-key climate-simulation-solutions-website \
     --site-name "Climate Simulation Solutions website" --profile hvac \
     --site-origin https://csshvac.com --analytics off --confirm-launch
   ```
3. **Provision (apply), piping stdout straight into the secret store.** Nothing goes to a
   file or the terminal; the script refuses to print a secret to a terminal.

   ```sh
   # CSS (Worker): stdout = secret only
   GROWTHOS_OWNER_SESSION=... node scripts/smart-sites/provision-site.mjs <same flags> --apply \
     2> provision-report.json | npx wrangler secret put GROWTHOS_SITE_SECRET
   ```
   For Painless, pipe the same stdout into the Sites secret setter for
   `GROWTHOS_SITE_SECRET`.

   Check the stderr report:

   | Exit code | `status` | Meaning |
   | --- | --- | --- |
   | `0` | `READY` | `missing: []`, `secretOutcome: "DELIVERED"`, `secretCheck: "verified"`, `final.isActive: true`, analytics and retention as requested, `blockers: []`. The origin is echoed. |
   | `2` | `CONFIGURED_NOT_READY` or `INCOMPLETE` | The report lists every unverified condition in `missing`, for example `blocker:active_responder_required`, `readiness_readback_failed` or `analytics_state`. Fix the cause, then rerun without `--rotate-secret`. A rerun only verifies and never issues a secret. |
   | `3` | `UNKNOWN` | See section 3. Do not retry blindly. |
4. **Set the remaining config, then redeploy or flip the flag.**
   1. Set `GROWTHOS_SITE_ID` from the report.
   2. Confirm `GROWTHOS_API_ORIGIN=https://app.mogulforge.ai`.
   3. Set `PAINLESS_GROWTHOS_ENABLED=true` or `SMART_SITE_GROWTHOS_ENABLED=true` and
      redeploy as the host requires.
   4. Check that `GET /api/lead` (Painless) or the CSS readiness endpoint reports GrowthOS
      configured.
5. **GrowthOS contract check** (optional, recommended): `acceptance-lead.mjs submit`. This
   proves the GrowthOS side only. It does **not** prove anything about the website.

   ```sh
   GROWTHOS_SITE_ID=... GROWTHOS_SITE_SECRET=... GROWTHOS_OWNER_SESSION=... \
   node scripts/smart-sites/acceptance-lead.mjs submit --env production \
     --api https://app.mogulforge.ai --i-have-owner-approval --company "<exact org name>" \
     --site-label css
   ```
   Every check must pass:
   - `intake_201_saved`, `receipt_uuids`, `receipt_contract`
   - `idempotent_replay`
   - `lead_saved_in_target_workspace`: read back from GrowthOS, not taken from the intake
     response
   - `lead_labeled_test`
   - `inquiry_followup_record`
   - `office_task_created`
   - `owner_alert_coverage_recorded`

   For owner alerts, `ownerAlert.status` is one of:
   - `evaluated`, with recipient outcomes.
   - `policy_disabled` or `policy_unavailable`, if staff alerts are not configured.

   Under `GROWTHOS_OUTBOUND_HOLD=true`, deliveries stay `pending`, which means **held**.
   They are **allowed** only after the owner-approved provider activation.
6. **Required: one labeled TEST lead through the real deployed website** (Adam's go, owners
   warned beforehand). The hookup is accepted only after this step.
   1. Submit the site's real form. Use name `TEST GrowthOS Acceptance`, a reserved
      `example.test` email, and a message starting `TEST lead`.
   2. Confirm the site shows "saved" with the GrowthOS reference.
   3. Confirm the site outbox row for that request is `saved`, with the same receipt UUID.
   4. Read the same request and receipt back in GrowthOS: lead, office task and alert
      coverage.
7. **Email fallback is off.** With the GrowthOS flag `true`, Painless routes `/api/lead` to
   GrowthOS, and CSS `growthOSOwnsLeadAutomations()` returns true. Confirm the step 6 lead
   created **no** owner email. Leave `*_EMAIL_ENABLED` as it is; it is the rollback path.
8. **Hand-off.** Record the organization, site, lead, request, receipt, task and contact
   IDs, the alert status and the outbox state in the Forge launch log. Never record a
   secret or session.
9. **Delete the TEST lead(s)** as described in section 5 (database owner).

## 3. Secret recovery

A secret is shown once and cannot be read back. The script never rotates on a rerun. A
rotation needs `--rotate-secret --expected-credential-version <n>`, where `<n>` is the
version a dry run just showed. If someone (or an earlier run) has already rotated, the
version differs and the script refuses.

- **Exit 3, `UNKNOWN`.** The create or rotate request did not return a definite answer:
  a network error, a 5xx, or a malformed reply. Nothing was printed, and nothing was
  retried.
  1. Run the same command without `--apply`.
  2. Compare site presence and `current.credentialVersion` with the values from before
     the run.
  3. If they are unchanged, nothing was issued. Rerun once.
  4. If the site now exists, or its version went up, a secret was issued and lost. The old
     secret is invalid and capture is off; the site's outbox holds leads and the site shows
     its fallback. Issue exactly one replacement with `--rotate-secret
     --expected-credential-version <current>`, piped into the secret store.
- **Exit 2 after `secretOutcome: "DELIVERED"`.** The secret was already written to stdout
  (and so into the secret store) before any later step. Fix what `missing` names, then
  rerun **without** `--rotate-secret`.
- **The pipe or the secret store failed** after `DELIVERED`. Treat the secret as lost and
  rotate once with the current expected version.

## 4. Rollback

- **Fast (no GrowthOS change).** Set `PAINLESS_GROWTHOS_ENABLED` or
  `SMART_SITE_GROWTHOS_ENABLED` to `false` (or unset it) and redeploy if required.
  - The site returns to its pre-GrowthOS email fallback; email was never disabled.
  - Painless project inquiries go back to the visible phone fallback.
  - Rows already queued in the outbox stay encrypted under `siteId|origin` and are not
    emailed. Check the outbox status first, and do not change `GROWTHOS_SITE_ID` while
    rows are queued: the drain only selects rows matching the current site ID and origin.
- **Full.** Also unset `GROWTHOS_SITE_ID` and `GROWTHOS_SITE_SECRET`. Then in GrowthOS,
  either turn capture off (in Smart Sites settings) or rotate the secret with
  `--rotate-secret`, which also disables capture.
- Rollback never deletes saved leads.

## 5. TEST-lead cleanup (database owner only)

Codex ROOT, as database owner, owns every hosted cleanup. GrowthOS has no API for deleting
a lead, so cleanup is a single database transaction with these fences:

- **Target identity comes from the server, not the URL.** A loopback URL can be a tunnel
  to any cluster, so the script reads `current_database()` and `session_user`:
  - `local` must be a `*_test` database.
  - `staging` must be `growthos_staging` as `growthos-staging-live`.
  - `production` must match `--expected-database` and `--expected-login`, attested by the
    database owner, and also needs `--i-have-owner-approval`.
- **Tenant.** Required: `--expected-organization-id`. Outside production, the workspace
  name must contain `TEST`.
- **Fixture provenance.** Required: `--receipt-id`, `--task-id` and `--contact-id` from the
  submit report. The lead and contact must carry every TEST marker, and the contact must
  have no other lead.
- **Allowlist only.** The script deletes only the rows intake created: the receipt, the
  `lead_captured` activity for that receipt, the `smart_site.lead_saved` task, alert
  coverage and staff alert deliveries for that lead, then the lead and the contact. If any
  other row still references the lead or contact (estimate, appointment, invoice,
  follow-up, property, analytics), the script stops with `downstream_work_present` and
  rolls everything back. Audit events are kept; they hold IDs only.

Run a dry run first, read the per-table counts in its report, then apply:

```sh
DATABASE_URL=... node scripts/smart-sites/acceptance-lead.mjs cleanup --env staging \
  --lead-id <id> --request-id <id> --receipt-id <id> --task-id <id> --contact-id <id> \
  --expected-organization-id <org id>                      # dry run
# then add: --apply --confirm-delete-test-lead
# production also needs: --i-have-owner-approval --expected-database <db> --expected-login <login>
```

Website-form TEST leads (section 2 step 6) have no submit report. The database owner reads
their IDs from GrowthOS and checks the TEST markers by hand before running the same
command.

## 6. Staging TEST variant (run first)

Adam's October 16 exception allows staging TEST company and site records. Production is
never touched. Respect the staging operator's current window (the saved window ends
15:00 PDT on 2026-10-16).

1. Use `https://mogulforge-growthos-staging.fly.dev`. Codex brings it up.
2. Use the recorded TEST workspace `TEST Contractor Acceptance 2026-10-16` (see the staging
   `test-owner.json`) with its approved TEST owner sign-in. Give it a **separate** TEST site
   record.
3. Provision. The script refuses staging names without the word TEST:

   ```sh
   GROWTHOS_OWNER_SESSION=... node scripts/smart-sites/provision-site.mjs --env staging \
     --api https://mogulforge-growthos-staging.fly.dev \
     --company "TEST Contractor Acceptance 2026-10-16" \
     --site-key painless-roofing-test-website --site-name "Painless Roofing TEST website" \
     --profile roofing-exteriors --site-origin https://painless-roofing-preview.dripdiaz.chatgpt.site \
     --analytics off --confirm-launch --apply --stdout env 2> staging-provision.json | <staging secret holder>
   ```
4. Run `acceptance-lead.mjs submit --env staging --api https://mogulforge-growthos-staging.fly.dev --company "TEST Contractor Acceptance 2026-10-16"`.
   Every check should pass, and `ownerAlert` deliveries should be **held**.
5. Hand the IDs to Codex for cleanup (section 5).

**Limitation.** Direct staging intake proves the GrowthOS contract only. It does not prove
the website form, Turnstile, the outbox, or the secret binding. The deployed public sites
pin production and must **not** be repointed. A full site-to-staging test would need a
reviewed, isolated website variant with staging credentials and an explicit staging
target. The real site-to-GrowthOS receipt and outbox proof is section 2 step 6, after the
approved cutover.

## 7. Local rehearsal

`node scripts/local-dev.mjs test src/routes/v1/smart-site-hookup-scripts.test.ts` runs the
whole flow against a disposable local Postgres and the in-process API:

- **Guards:** exact origins, aliases, TEST labels.
- **Provisioning:** dry run, create, verify, rotate, and refusal of a second rotation.
- **Failure paths:** secret delivery when every readback fails, the `UNKNOWN` outcome, and
  not-ready reporting.
- **TEST lead:** company/session preflight, submit, and verify.
- **Cleanup:** allowlisted removal, refusal when downstream work exists, and database and
  organization identity fences.
