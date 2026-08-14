# Cloudflare Email Intelligence intake

This Worker is the inbound transport boundary for the GrowthOS founding beta.
Cloudflare Email Routing receives mail only on the dedicated
`intake.mogulforge.ai` subdomain. The Worker parses the message in memory,
discards attachments, signs a bounded plain-text payload, and sends it to the
tenant alias on the GrowthOS API.

It does not use Gmail OAuth and it does not change the MX records for the root
`mogulforge.ai` Google Workspace domain.

## Deployment gates

Do not deploy until all of the following are complete:

1. Copy `wrangler.toml.example` to an ignored `wrangler.toml` and verify the
   production URL and dedicated intake domain.
2. Generate a high-entropy `INTAKE_WEBHOOK_SECRET`; set it as a Worker secret
   and set the identical value in Fly as `EMAIL_INGESTION_WEBHOOK_SECRET`.
3. Set a separate 32-byte Fly `EMAIL_INTELLIGENCE_ENCRYPTION_KEY`.
4. Set Fly `EMAIL_INGESTION_DOMAIN=intake.mogulforge.ai`.
5. Enable Email Routing for the `intake` subdomain and route its catch-all to
   this Worker. Preserve the root Google Workspace MX records.
6. Run synthetic, allowed-forwarder, unauthorized-forwarder, attachment,
   duplicate, replay, purge, and two-tenant tests before customer activation.

Worker secrets and production DNS are external account changes and are not made
by source-code commits.
