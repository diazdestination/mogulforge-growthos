# GrowthOS server release preparation - November 11, 2026

Merge order: beta PR #83 first, command center PR #84 second. Do not merge the
command center into the beta branch; retarget it to main after #83 merges.
Run the full CI gate on the final #84 head before its main merge.

## Server checks before deployment

- Reauthenticate Fly as diazdestination@gmail.com; verify the personal Adam Diaz
  organization, app mogulforge-growthos, iad region and currently deployed image.
- Read machine state, config, secret names/statuses and the database binding.
  Record a rollback image and preserve existing resources and data.
- Follow BETA-LAUNCH-PLAN.md: provision the current schema only on a confirmed
  fresh database. Never run drizzle-kit push against the historical V1 database.
  New paid resources need the owner's cost approval before creation.
- fly.toml no longer invokes the retired release-schema.mjs, which always exits
  with a refusal. Schema provisioning and verification are separate steps.
- Confirm the OpenAI credential choice and install OPENAI_API_KEY only in the
  server secret store. Inspect names/statuses without displaying values. Confirm
  model access and run an owner-only assistant/draft check after deployment.
- Confirm platform identity email delivery is configured (Resend sender/domain,
  credential and delivery context). An API acceptance response alone does not
  prove inbox receipt. Verify the real owner mailbox through a single-use link;
  never set emailVerifiedAt manually or reuse an invitation placeholder.
- Keep Stripe mode test unless the owner separately authorizes real payment
  activation. Keep customer-contact automation Off until the specific contractor,
  sender registration, destination and approval flows have been verified.
- Resolve PR #83's documented estimate e-signature wording and unverified live
  provider/import behavior before representing those features as accepted.

## After deployment

Verify HTTPS, health/readiness, actual image/build identity, owner sign-in,
verification-link completion, the command center's real feeds, phone navigation,
assistant and AI draft generation. Check for failed requests and server errors.
Record the commit, merged PRs, image, database/schema identity and provider proof
separately. Revert the application image if admission fails; do not delete or
overwrite a database as rollback.

## Current source changes

- Plain menu names, with legacy terms retained as search keywords.
- Email verification screen before staff pages; signed-in users can use their
  verification links. Active identity-provider accounts can request a link even
  without a local password. Tokens remain single-use and delivered to the account
  mailbox through the existing audited, rate-limited identity flow.
- Failed service feeds appear in the command-center warning. An incomplete read
  no longer claims everything is caught up; retry excludes hidden invoice feeds.

Local/source verification does not establish hosted or contractor acceptance.
