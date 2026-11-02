# Public messaging page restoration

The three existing public messaging pages and their CSS/JavaScript dependencies
were absent from an older application image, causing SPA fallback responses.
The narrow repair installs the five unchanged public assets using the existing
Machine's saved file configuration. No policy text, backend code, schema,
outbound SMS, environment, resources, services or fly.toml settings change.

The assets already live in `artifacts/command-center/public` and are included
by the normal Vite production build. A later normal release must retain those
files and run the verifier. The policies retain their existing prelaunch draft
notices. The preferences page retains its closed-enrollment guards; this repair
does not establish working live enrollment or carrier readiness.

## Reproduction and verification

```sh
node --test scripts/verify-public-messaging-pages.test.mjs
node scripts/verify-public-messaging-pages.mjs --directory artifacts/command-center/dist/public
node scripts/verify-public-messaging-pages.mjs --origin https://your-approved-host.example
```

The verifier checks status, MIME type and exact source-byte identity for all
five assets, so a successful HTTP response containing the SPA shell fails.

Six verifier cases and six existing SMS preferences tests pass. Workspace
TypeScript checks, frontend and API builds, JavaScript syntax and whitespace
checks pass. Full PostgreSQL/backend CI and Docker parity are not run for this
static-file repair. Initial sandbox attempts failed on network/temp-file
permissions; focused tests pass with the normal local runtime. No assertions
were relaxed. There is no separate lint script.

The authorized live restoration completed. Browser navigation verified the
three distinct pages, existing draft notices and the preferences script's
closed-enrollment message. All five public responses match the existing source
bytes and use the expected content types. Detailed deployment identifiers,
configuration comparison and rollback evidence stay in the private operator
receipt rather than this public report.

## Operator procedure

Use the supported
[existing-Machine file update](https://fly.io/docs/machines/flyctl/fly-machine-update/)
to install these files at their matching `/app/public/` paths:

- `messaging-privacy.html`
- `messaging-terms.html`
- `sms-preferences.html`
- `messaging.css`
- `sms-preferences.js`

Before updating, privately save the exact Machine configuration and image
digest. Use `--file-local` for only these five reviewed files and pin the same
running image digest. Preserve all unrelated configuration. Do not substitute
a current-backend deployment or run a schema release for this repair.
Machine files are saved in configuration and rewritten at boot, rather than
being an ephemeral SSH copy. Compare the post-update configuration and image
with the saved values and verify the live pages. Rollback uses the saved
pre-update configuration on the same existing Machine. Keep identifiers and
rollback configuration in private operator storage.
