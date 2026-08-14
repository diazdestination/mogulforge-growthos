# Per-user Gmail OAuth setup

GrowthOS uses one MogulForge-owned Google OAuth application. Each GrowthOS
member signs in directly with Google and grants the narrow Gmail send
permission to their own account. MogulForge never receives the user's Google
password and does not share Diego's mailbox with customer organizations.

## Architecture implemented in this repository

- Callback: `/api/v1/integrations/gmail/callback`
- Scopes: `openid`, `email`, `profile`, and
  `https://www.googleapis.com/auth/gmail.send`
- Authorization-code flow with PKCE and random state
- Ten-minute, single-use OAuth transaction stored by user and organization
- AES-256-GCM encrypted refresh token, bound to the user/organization as
  authenticated additional data
- One active Gmail connection per GrowthOS user
- Google revocation plus immediate local credential removal on disconnect
- BIE email sends use the executing/approving user's connection
- No automatic fallback to a platform owner's Gmail account

The application does not request Gmail read, modify, compose, or full-mailbox
access. `gmail.send` is enough for the current product behavior.

## Google Cloud configuration

Use two separate Google Cloud projects: one for staging/development testing
and one for production. This prevents beta redirects, test users, credentials,
and consent configuration from contaminating the production app.

### Production project

1. Create or select a project named `MogulForge GrowthOS Production`.
2. Enable the **Gmail API**.
3. Configure the Google Auth Platform branding:
   - App name: `MogulForge GrowthOS`
   - Support email: a verified `@mogulforge.ai` mailbox
   - Homepage: `https://mogulforge.ai`
   - Privacy policy: a public MogulForge URL that accurately explains Google
     data use, storage, sharing, retention, revocation, and deletion
   - Terms: a public MogulForge URL
   - Authorized domain: `mogulforge.ai`
4. Set the audience to external.
5. Add only the four scopes listed above. Do not add inbox-reading scopes for
   possible future features.
6. Create a **Web application** OAuth client.
7. Add the exact production redirect URI:

   `https://app.mogulforge.ai/api/v1/integrations/gmail/callback`

8. Copy the client ID and secret through a secure credential flow into the
   production host; never paste them into chat, docs, issues, or git.
9. Submit the app for verification. The homepage/privacy/terms content and the
   in-product consent explanation must match the narrow sending behavior.

### Staging/development project

1. Create or select a separate project named
   `MogulForge GrowthOS Staging`.
2. Enable the **Gmail API** and configure the same app name, support email, and
   four narrow scopes described above.
3. Keep the audience in **Testing** while running the private beta acceptance
   suite, and add only the beta Google accounts as test users.
4. Create a **Web application** OAuth client and add this exact staging redirect:

   `https://mogulforge-growthos-staging.fly.dev/api/v1/integrations/gmail/callback`

5. If the same staging project is also used for local engineering, add the
   existing combined-container redirect as a second authorized URI:

   `http://localhost:8080/api/v1/integrations/gmail/callback`

6. Put the staging client ID and secret only in the
   `mogulforge-growthos-staging` Fly app's secret vault. Never reuse the
   production OAuth client in staging.

Google Testing mode supports a small allowlist, but it is not a reliable
production substitute: external test-user authorizations for non-identity
scopes can expire after seven days. Submit production verification in parallel
with beta engineering.

## Required environment variables

```text
APP_ORIGIN=https://app.mogulforge.ai
GOOGLE_OAUTH_CLIENT_ID=<secure value>
GOOGLE_OAUTH_CLIENT_SECRET=<secure value>
GOOGLE_OAUTH_REDIRECT_URI=https://app.mogulforge.ai/api/v1/integrations/gmail/callback
OAUTH_TOKEN_ENCRYPTION_KEY=<32 random bytes as base64 or 64 hex characters>
```

Generate the encryption key locally without printing it into a shared log, then
place it directly into the hosting secret manager. Treat it as a durable
encryption key: rotating it requires a re-encryption migration or all users
must reconnect.

For Fly, these values belong in Fly secrets, not `fly.toml` or a committed env
file. Apply the staging values only to `mogulforge-growthos-staging`; production
credentials remain a separate release-gated action.

## Beta acceptance test

Use two GrowthOS organizations and at least two different Gmail accounts.

1. User A connects Gmail A. The settings page shows Gmail A.
2. User B connects Gmail B. The settings page shows Gmail B.
3. A BIE email executed by A arrives with Gmail A as the sender.
4. A BIE email executed by B arrives with Gmail B as the sender.
5. Neither user can read the other's connection status or cause a send from
   the other's mailbox, even if connection/action IDs are tampered with.
6. Access-token expiry is allowed to occur; the next send refreshes
   transparently from the encrypted refresh token.
7. Disconnect A. A subsequent A send blocks and Google's connected-app access
   is revoked. B continues to work.
8. Revoke B from Google Account security settings. The next send fails visibly,
   records provider health, and does not fall back to another sender.
9. Audit events show connect, disconnect, action approval, sender address,
   provider message ID, and outcome without containing a token.
10. Database/log inspection finds no plaintext refresh or access token.

## Sending policy

Gmail is the beta channel for individual, human-approved follow-up. It is not a
bulk marketing transport. GrowthOS must keep consent, suppression, quiet-hour,
frequency-cap, and complaint controls active. A future higher-volume campaign
channel should use a customer-verified sending domain through a transactional
provider; it must remain a separate identity and policy choice rather than a
silent fallback.

## Official references

- Gmail scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- OAuth app policies: https://developers.google.com/identity/protocols/oauth2/policies
- Google Workspace API user-data policy: https://developers.google.com/workspace/workspace-api-user-data-developer-policy
- Testing and production audience behavior: https://support.google.com/cloud/answer/15549945
- OAuth verification requirements: https://support.google.com/cloud/answer/13464321

