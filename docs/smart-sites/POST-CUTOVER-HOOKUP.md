# Smart Site hookup after cutover: Painless and CSS

October 16, 2026. Package D of the GrowthOS launch. This runbook connects the two live
contractor websites to GrowthOS once production cutover is done. **Nothing here runs
before cutover.** Production site records stay forbidden until then. The staging TEST
variant (section 5) runs first and needs no production access.

Who does what: Codex (WILLOWFORGE ROOT) owns production, secret-store writes and deploys.
Adam approves each production step (provisioning, secret install, the flag flip and the
labeled TEST lead). Claude prepared the tooling and runs it only against local or
staging, and only when asked.

## 0. Tools

| Tool | Purpose |
| --- | --- |
| `scripts/smart-sites/provision-site.mjs` | Create or verify the company's site record, check the credential, set analytics, turn capture on. Dry run unless you pass `--apply`. Production needs `--i-have-owner-approval`. A new secret goes to **stdout only**. The JSON report goes to stderr. |
| `scripts/smart-sites/acceptance-lead.mjs submit` | Sends one labeled TEST lead through the real intake contract. Checks the saved receipt, the replay, the office task, the inquiry follow-up record and owner-alert coverage. |
| `scripts/smart-sites/acceptance-lead.mjs cleanup` | Removes that TEST lead in one transaction. Dry run unless you pass `--apply`. It refuses any lead without every TEST marker. |

Inputs are read only from environment variables, never from arguments:
`GROWTHOS_OWNER_SESSION` is an owner/admin session ID (the GrowthOS session cookie value).
Sign in, use the value for one command, then sign out to revoke it. `GROWTHOS_SITE_ID` and
`GROWTHOS_SITE_SECRET` are for the TEST lead. `DATABASE_URL` is for cleanup, run by the
database owner.

GrowthOS has no per-site allowed-origin column, and the scope freeze rules out adding one.
Intake is server-to-server only and rejects any request that carries a browser `Origin`
header. Each website worker pins `GROWTHOS_API_ORIGIN`, serves its own `SITE_PUBLIC_ORIGIN`,
and binds outbox rows to `siteId|origin`. Pass `--site-origin` as the exact public origin;
the script validates it and echoes it in the report.

## 1. Values per site

| | Painless Roofing & Water Restoration | Climate Simulation Solutions (CSS) |
| --- | --- | --- |
| Hosting | Cloudflare Sites project (worker `worker/growthos.js`, `worker/index.js`) | Cloudflare Worker `climate-simulation-solutions-site` (`site/`) |
| GrowthOS profile | `roofing-exteriors` | `hvac` |
| `--site-key` | `painless-roofing-website` | `climate-simulation-solutions-website` (= `growthos.sourceKey` in `site/site.config.mjs`) |
| `--site-origin` | Live public origin. **Owner to confirm:** `https://painless-roofing-preview.dripdiaz.chatgpt.site` today; `https://painlessroofingandwaterrestoration.com` once DNS moves | `https://csshvac.com` |
| `--company` | Exact production organization name after cutover (read it from GrowthOS; do not guess) | same |
| GrowthOS on/off flag | `PAINLESS_GROWTHOS_ENABLED` | `SMART_SITE_GROWTHOS_ENABLED` |
| `GROWTHOS_API_ORIGIN` | `https://app.mogulforge.ai` (the worker hard-pins this host) | `https://app.mogulforge.ai` (`growthos.apiOrigin`, default production) |
| `GROWTHOS_SITE_ID` | site ID from provisioning (secret or var) | secret |
| `GROWTHOS_SITE_SECRET` | **secret**, from provisioning stdout | **secret** (Secrets Store binding), from provisioning stdout |
| Outbox | `PAINLESS_OUTBOX_ENCRYPTION_KEY` already set (backed up, fingerprint `efba7c8f`), `PAINLESS_OUTBOX_ENABLED=true` | `SITE_OUTBOX_ENCRYPTION_KEY`, `SITE_OUTBOX_DRAIN_SECRET` already present, `SITE_OUTBOX_ENABLED=true` |
| Email fallback today | `PAINLESS_EMAIL_ENABLED=true` (damage check). Project inquiries already require GrowthOS and show the phone fallback | `SITE_EMAIL_ENABLED=true`, `emailBridge.preGrowthOS=true` |

Analytics: provision with `--analytics off` unless Adam approves measurement for that
site. Both sites offer measurement only when GrowthOS reports it ready. Leads never fail
because of measurement any more (see `SMART-SITES-MEASUREMENT.md`, NEEDS OWNER OK).

## 2. Order (production, per site, after cutover)

Run Painless and CSS one at a time. Do not start the second until the first passes step 6.

1. **Readiness.** Confirm cutover is complete and the company workspace exists with at
   least one active manager and one active responder. The launch guard enforces this.
   Get Adam's go for this site's hookup.
2. **Provision (dry run).** Expect `create_site`, `credential_check`, `enable_capture` and
   no stdout.

   ```sh
   GROWTHOS_OWNER_SESSION=... node scripts/smart-sites/provision-site.mjs \
     --env production --api https://app.mogulforge.ai --i-have-owner-approval \
     --company "<exact org name>" --site-key climate-simulation-solutions-website \
     --site-name "Climate Simulation Solutions website" --profile hvac \
     --site-origin https://csshvac.com --analytics off --confirm-launch
   ```
3. **Provision (apply) piped straight into the secret store.** No file, no terminal echo.
   The script refuses to print the secret to a terminal. Its stderr report gives the site
   ID, `final.isActive: true`, `blockers: []` and `verified: true`.

   ```sh
   # CSS (Worker): stdout = secret only
   GROWTHOS_OWNER_SESSION=... node scripts/smart-sites/provision-site.mjs <same flags> --apply \
     2> provision-report.json | npx wrangler secret put GROWTHOS_SITE_SECRET
   ```
   For Painless, pipe the same stdout into the Sites secret setter for
   `GROWTHOS_SITE_SECRET`. If a step after key issuance fails, the secret is still on
   stdout, because the previous one is already invalid. Capture stays off until a rerun
   passes. Rerunning without `--rotate-key` verifies the site and issues nothing.
4. **Set the remaining config, then redeploy or flip the flag.** Set `GROWTHOS_SITE_ID`
   (from the report) and confirm `GROWTHOS_API_ORIGIN=https://app.mogulforge.ai`. Then set
   `PAINLESS_GROWTHOS_ENABLED=true` or `SMART_SITE_GROWTHOS_ENABLED=true` and redeploy as
   each host requires. Check that `GET /api/lead` (Painless) or the CSS readiness endpoint
   reports GrowthOS configured.
5. **One labeled TEST acceptance lead** (Adam's go, owners warned beforehand). Submit it
   through the real site form or with the script. The script sends no channel permission
   and uses a reserved `example.test` address, so nothing is sent to that address.

   ```sh
   GROWTHOS_SITE_ID=... GROWTHOS_SITE_SECRET=... GROWTHOS_OWNER_SESSION=... \
   node scripts/smart-sites/acceptance-lead.mjs submit --env production \
     --api https://app.mogulforge.ai --i-have-owner-approval --site-label css
   ```
   Check:
   - `intake_201_saved`, `receipt_uuids`, `receipt_contract`: a GrowthOS receipt UUID and
     lead UUID came back.
   - `idempotent_replay`: the same request ID returns the same receipt.
   - `office_task_created`: a "Review … inquiry" task (`smart_site.lead_saved`) is due at
     the response target.
   - `inquiry_followup_record`: the inquiry appears in Smart Site follow-up.
   - `owner_alert_coverage_recorded`: `ownerAlert.status` is `evaluated` with recipient
     outcomes, or `policy_disabled` / `policy_unavailable` if staff alerts are not
     configured. Under `GROWTHOS_OUTBOUND_HOLD=true` (staging, or production before
     provider activation), deliveries stay `pending` and are **held**. They are
     **allowed** only after the owner-approved provider activation.

   When the lead goes through the real site form, also confirm the site shows "saved"
   with the GrowthOS reference and the site outbox row for that request is `saved`.
6. **Email fallback switches off automatically.** With the GrowthOS flag `true`, Painless
   routes `/api/lead` to GrowthOS, and CSS `growthOSOwnsLeadAutomations()` returns true,
   so the email bridge cannot send. Confirm the TEST lead created **no** owner email.
   Leave `*_EMAIL_ENABLED` as it is; it is the rollback path.
7. **Delete the TEST lead.** The database owner (Codex) runs a dry run, reads the
   per-table counts, then applies. Audit events stay; they hold IDs only.

   ```sh
   DATABASE_URL=... node scripts/smart-sites/acceptance-lead.mjs cleanup --env production \
     --lead-id <leadId> --request-id <requestId> --apply --confirm-delete-test-lead \
     --i-have-owner-approval
   ```
8. Record the site ID, receipt UUID, task ID, alert status and cleanup result in the
   Forge launch log. Never record the secret.

## 3. Rollback

- **Fast (no GrowthOS change):** set `PAINLESS_GROWTHOS_ENABLED` or
  `SMART_SITE_GROWTHOS_ENABLED` to `false` (or unset it) and redeploy if required. The
  site returns to its pre-GrowthOS email fallback; email was never disabled. Painless
  project inquiries go back to the visible phone fallback. Rows already queued in the
  outbox stay encrypted under `siteId|origin` and are not emailed. Check the outbox
  status before rolling back, and do not change `GROWTHOS_SITE_ID` while rows are queued.
  The drain only selects rows that match the current site ID and origin.
- **Full:** also unset `GROWTHOS_SITE_ID` and `GROWTHOS_SITE_SECRET`, and in GrowthOS turn
  capture off (Smart Sites settings, or `PATCH /smart-sites/:id {isActive:false}`) or
  rotate the key (`provision-site.mjs --rotate-key`, which also disables capture). An
  intake with the old secret then gets `401`/`503` and never creates a lead.
- Saved leads are never deleted by rollback.

## 4. Failure meanings

| Intake response | Meaning | Action |
| --- | --- | --- |
| `401 invalid_site_credentials` | wrong or rotated secret | re-provision with `--rotate-key`, reinstall the secret |
| `503 site_capture_disabled` | capture off or key rotated | rerun provisioning with `--confirm-launch` |
| `423 customer_lifecycle_paused` | company paused in GrowthOS | owner decision; the site outbox holds the lead |
| `503 site_staffing_unavailable` | no active responder | invite or activate staff |
| `409 contact_match_needs_review` | the email/phone matches two contacts | staff review; not a hookup fault |
| `201` with `measurementDropped` | lead saved; measurement ignored (analytics off or stale policy) | none; optional analytics review |

## 5. Staging TEST variant (run first)

Adam's October 16 exception allows staging TEST company and site records. Production is
never touched.

1. Codex brings up staging and shares the staging API origin and a staging owner sign-in.
2. Create a staging TEST workspace (for example `Painless Roofing TEST`) through the
   platform client flow or the acceptance package C setup.
3. Provision. The script refuses staging records whose company or site name lacks the
   word TEST:

   ```sh
   GROWTHOS_OWNER_SESSION=... node scripts/smart-sites/provision-site.mjs --env staging \
     --api https://<staging-origin> --company "Painless Roofing TEST" \
     --site-key painless-roofing-website --site-name "Painless Roofing TEST website" \
     --profile roofing-exteriors --site-origin https://<preview-origin> --analytics off \
     --confirm-launch --apply --stdout env 2> staging-provision.json | <staging secret holder>
   ```
4. Run `acceptance-lead.mjs submit --env staging --api https://<staging-origin>`. Expect
   all checks to pass and `ownerAlert` deliveries **held** (outbound hold).
5. Clean up with `cleanup --env staging --apply --confirm-delete-test-lead` (database
   owner), then confirm the lead, receipt and contact are gone.

**Limitation:** the deployed website workers cannot point at staging. Painless hard-pins
`app.mogulforge.ai`. CSS pins `growthos.apiOrigin`, which defaults to production. Staging
therefore exercises GrowthOS through the same intake contract the workers use, called
directly by the script. A full site-to-staging run needs a reviewed site config or code
change (an owner/Codex decision). The site-side path is covered by each site's own
mocked tests and by the production TEST lead in step 5.

## 6. Local rehearsal

`node scripts/local-dev.mjs test src/routes/v1/smart-site-hookup-scripts.test.ts` runs
the full flow against a disposable local Postgres and the in-process API: guards,
dry run, create/verify/rotate, the TEST lead and its cleanup.
