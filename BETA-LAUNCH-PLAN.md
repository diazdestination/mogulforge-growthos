# GrowthOS beta launch plan — October 29, 2026

**Status:** ACTIVE. This replaces `PAID-BETA-READINESS-P0.md` and
`PUBLIC-LAUNCH-READINESS-2026-09-30.md` as the working plan. Those files are
kept as history and are no longer binding.

## The actual model

- Beta customers sign up on the website and pay the normal monthly price for
  the tier they choose. The build and setup fee is waived for beta testers.
- There is no separate "paid beta readiness" gate. GrowthOS is ready when it
  does what the website and the specialist roster say it does.
- The existing V1 production database is not migrated. GrowthOS deploys the
  current schema fresh. The Fly migration/recovery tooling under `scripts/`
  is retired from the release path (see below).

## What stays non-negotiable (already built, keep green)

- Tenant isolation on every route and service (`route-inventory.test.ts`,
  `tenant-isolation.test.ts`).
- Human approval before anything reaches a customer (BIE proposals, Zapier
  writes, estimate/invoice sends).
- Encrypted credentials with tenant-bound AAD; provider secrets never in git,
  logs, bundles, or ordinary JSON columns.
- Durable execution receipts: no blind retry of an effect that may have
  happened.
- Audit events on every consequential write.
- The data-lifecycle table catalog must classify every table.

## What is retired

- The C1 "source preservation" amendment ritual, release-attestation pins,
  production75/staging drills and the V2 migration suites. They stay under
  `scripts/` and can be run on demand; they are no longer a CI gate (the
  owner flips `scripts/package.json`'s `test` script to the on-demand name).
  Schema changes ship as reviewed SQL previews plus `drizzle-kit push` on the
  fresh database, with the data-lifecycle catalog bumped.
- The feature freeze. Work proceeds against the specialist roster below.

## CI gate

`pnpm -r run test` for api-server, command-center and libs; `pnpm run typecheck`;
both production builds; Docker parity. That is the whole gate.

## Specialist roster — gaps to close

From `artifacts/command-center/src/lib/agent-team.ts`. "workspace" items work
today. "setup" items are built and need provider activation. "planned" items
are code to write.

| Specialist | Setup (needs a credential) | Planned (needs code) |
| --- | --- | --- |
| ESTI | — | Price books & margin guidance |
| BILL | — | Card & bank collection (Stripe) |
| INVO | Invoice email delivery (Gmail OAuth / Resend) | — |
| SCHED | — | Automatic route optimization |
| APPT | Customer confirmations (SMS/email) | External calendar sync — **closed by Zapier Connected Apps (PR #73)** |
| CALLIE | Keypad/voice intake, approved human handoff (Twilio/ElevenLabs) | — |
| MAINTAIN | Customer service reminders (SMS/email) | — |
| SCOUT | Consented outreach (email/SMS) | — |

Zapier Connected Apps (`ZAPIER-CONNECTED-APPS.md`) lets CALLIE, SCHED and
MAINTAIN text customers from the contractor's own number, which does not
depend on MogulForge's Twilio A2P registration.

## Owner inputs still required

1. Google OAuth client id/secret (Gmail sending) and a Resend domain.
2. Zapier MCP embed id and secret (`mcp.zapier.com` → Manage → Embed; allowed
   domain `app.mogulforge.ai`).
3. Stripe keys for card/bank collection when BILL's collection ships.
4. Website tier names and monthly prices, for Billing.

## Order of work

1. Merge PR #73 (Zapier Connected Apps) and this plan.
2. Close the retired Fly PRs (#34, #35, #45–#55, #58, #60, #62, #66).
3. Land #63 (SMS carrier handoff) and #70 (CSS onboarding) rebased on main.
4. Activate providers from the owner inputs; run a staff-only test window.
5. Build the planned four: price books/margin, Stripe collection, route
   ordering; calendar sync is done.
6. Beta customers on the website.
