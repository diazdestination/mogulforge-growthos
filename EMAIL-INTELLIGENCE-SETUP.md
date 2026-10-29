# Email Intelligence Inbox setup

> **Current context — October 29, 2026:** The described Worker/intake path exists as source. Treat its domain/provider setup as a proposed configuration until actual routing, secrets and live intake are verified; the words selected transport do not establish a live inbox connection.
> See [current build](CURRENT-BUILD.md) and [documentation map](docs/DOCUMENTATION-MAP.md).


## Selected beta transport

The founding beta uses Cloudflare Email Routing on the dedicated
`intake.mogulforge.ai` subdomain and the versioned Worker in
`lib/integrations/cloudflare-email-intake`.

This keeps the root `mogulforge.ai` Google Workspace MX records unchanged. It
also avoids Gmail mailbox-reading OAuth: customers manually forward selected
business threads to their tenant-specific GrowthOS address, Cloudflare parses
the message in an Email Worker, and the Worker sends a bounded HMAC-signed
plain-text event to GrowthOS.

Resend remains appropriate for outbound transactional mail. It was not selected
as the default inbound transport because its documented standard email-data
retention is longer than GrowthOS's seven-day founding-beta raw-content target.

## Data path

```text
Customer-selected manual forward
  -> intake.mogulforge.ai MX (Cloudflare Email Routing)
  -> MogulForge Email Worker
     - validates generated tenant alias
     - parses MIME in memory
     - reports attachment count but never forwards attachment bytes
     - identifies the authorized forwarding account
     - extracts the original sender from a standard forwarded-message block
     - signs the normalized event with HMAC-SHA256
  -> POST app.mogulforge.ai/api/v1/public/email-intelligence/intake/:alias
     - verifies signature and five-minute timestamp
     - verifies source is active and forwarding identity is allowed
     - encrypts bounded raw text with tenant/source/message AAD
     - stores a SHA-256 digest and seven-day expiry
     - redacts direct identifiers
     - creates deterministic, review-required facts
  -> BIE Email Intelligence review queue
```

## Required production configuration

GrowthOS/Fly secrets or environment:

- `EMAIL_INGESTION_DOMAIN=intake.mogulforge.ai`
- `EMAIL_INGESTION_WEBHOOK_SECRET=<high-entropy shared Worker secret>`
- `EMAIL_INTELLIGENCE_ENCRYPTION_KEY=<independent 32-byte base64 or 64-hex key>`

Cloudflare Worker variables and secret:

- `GROWTHOS_INTAKE_URL=https://app.mogulforge.ai`
- `INTAKE_DOMAIN=intake.mogulforge.ai`
- `INTAKE_WEBHOOK_SECRET=<same value as EMAIL_INGESTION_WEBHOOK_SECRET>`

The email-content encryption key must not be reused as the webhook secret,
OAuth token key, session secret, database password, or any other credential.

## Activation sequence

1. Review and merge the application and Worker code only after local validation.
2. Create separate high-entropy webhook and email-content encryption secrets.
3. Set the GrowthOS secrets without printing or committing their values.
4. Copy `wrangler.toml.example` to an ignored `wrangler.toml`, authenticate
   Wrangler to the approved Cloudflare account, set the Worker secret, and
   deploy the exact reviewed Worker version.
5. In Cloudflare Email Routing, enable the `intake` subdomain and route its
   catch-all to `mogulforge-email-intake`. Do not modify the root Google MX.
6. Reserve two GrowthOS tenant inboxes and activate them only after the API
   reports the provider, domain, and encryption boundary are configured.
7. Manually forward synthetic fixtures from each authorized business account.
8. Prove allowed delivery, unauthorized rejection, attachment rejection,
   duplicate idempotency, signature tampering/replay rejection, tenant isolation,
   fact review, immediate purge, seven-day expiry, and audit-event creation.
9. Activate the first founding customer only after documented owner authority,
   approved forwarding streams, privacy terms, and data-processing disclosures.

## Current boundary

The code, schema, Worker adapter, tests, and local UI are implemented on the
review branch. The Cloudflare Worker, subdomain Email Routing, Fly secrets,
production schema, and real customer forwarding rules are not activated by a
source commit and require deliberate external-account setup and acceptance.

Official references:

- Cloudflare Email Routing subdomains:
  https://developers.cloudflare.com/email-service/configuration/subdomains/
- Cloudflare Email Worker handler:
  https://developers.cloudflare.com/email-service/api/route-emails/email-handler/
- Google Gmail scopes:
  https://developers.google.com/workspace/gmail/api/auth/scopes
