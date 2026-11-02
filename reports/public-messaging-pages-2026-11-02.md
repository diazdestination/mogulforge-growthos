# Public messaging page restoration - November 2, 2026

The production `mogulforge-growthos` Machine `d8de506c72d608` is running
`registry.fly.io/mogulforge-growthos-staging:growthos-63a440bf`, digest
`sha256:e22d35041e9a8404cc98d460b25655cedc74a95152dec27788d951097fb003fe`.
The image tag points to September 14 source; the messaging assets were added
September 27. Read-only SSH confirmed all five assets are absent from
`/app/public`, while `index.html` is 1,540 bytes. Both the custom hostname and
the direct Fly hostname return that SPA shell at the privacy URL. All three
HTML routes and both support assets return the same shell hash:
`e2eaca83a1ac3b95239eec5aed13e798e19a537a8bcbd76c60e7b8bd9e6cf0d1`.

## Bounded release

Restore the five existing assets from main `d4381b3bdd648ec5f792736552fe6e9835448083`.
Do not deploy the current backend or run `release-schema.mjs`. The policy text
is unchanged, including its explicit prelaunch-draft notice. No legal operator,
address, retention policy or consent is invented. SMS enrollment still requires
the existing approved-program selector and backend readiness; an unqualified
preferences URL keeps the form hidden. This is page restoration, not SMS or
carrier acceptance.

For this repair, use the supported
[existing-Machine file update](https://fly.io/docs/machines/flyctl/fly-machine-update/)
to install only these files while keeping the existing image and configuration.
This avoids releasing unrelated source and schema changes. Machine files are
stored in configuration and rewritten at boot, rather than being an ephemeral
SSH copy. No `fly.toml` settings change. Future full application releases must
include the existing Vite public assets and pass the verifier below.

Before updating, save `flyctl machines list --app mogulforge-growthos --json`,
verify the exact Machine/image above, and confirm `STATIC_DIR=/app/public`.
From a clean checkout of this release, run:

```powershell
flyctl machine update d8de506c72d608 --app mogulforge-growthos `
  --image registry.fly.io/mogulforge-growthos-staging@sha256:e22d35041e9a8404cc98d460b25655cedc74a95152dec27788d951097fb003fe `
  --file-local /app/public/messaging-privacy.html=artifacts/command-center/public/messaging-privacy.html `
  --file-local /app/public/messaging-terms.html=artifacts/command-center/public/messaging-terms.html `
  --file-local /app/public/sms-preferences.html=artifacts/command-center/public/sms-preferences.html `
  --file-local /app/public/messaging.css=artifacts/command-center/public/messaging.css `
  --file-local /app/public/sms-preferences.js=artifacts/command-center/public/sms-preferences.js `
  --yes
node scripts/verify-public-messaging-pages.mjs --origin https://app.mogulforge.ai
```

Compare the post-update Machine config against the saved version: only the
five file entries and the exact-digest pin of the same image may change. Keep
the executable image, secrets, environment,
services, resource size and autostop settings. Record the new Machine version.
Rollback uses `--machine-config` with the saved pre-update config on the same
Machine; do not deploy current backend source to roll back a static repair.

## Validation

- Six HTTP asset-verifier cases pass, including rejection of a 200 SPA response
  for every HTML/CSS/JS path. The verifier correctly fails against unrepaired
  production, not merely on a non-200 response.
- Existing SMS preferences tests: six pass (missing/malformed selectors,
  program isolation, closed enrollment and approved HTTPS links).
- Workspace TypeScript checks, frontend production build and API build pass.
  Frontend output includes all five assets unchanged.
- JavaScript syntax and whitespace checks pass. There is no separate lint script.
- Initial sandbox test runs hit network/temp-file permission failures; the
  focused tests pass outside that sandbox. No application assertions were relaxed.
- Full PostgreSQL/backend suite and Docker parity are not run for this static
  file-only release. No claim of full current-main backend release acceptance.
- Production deployment and live rendered-page verification are pending at the
  time this candidate is published; record their actual result separately.
