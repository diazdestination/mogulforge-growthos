# Mobile lead response and mailbox compatibility candidate

Date: October 1, 2026. This is source/local verification, not a live-client launch.

## Implemented scope

- Microsoft delegated send-only customer mailbox integration alongside Gmail,
  with explicit per-user provider choice and company/assigned-member identity.
- Opt-in, session-bound staff Web Push, saved company routing by IANA zone,
  days and hours; transactionally queued canonical new-lead notifications.
- Home Screen manifest/icons and push-only worker, with no offline customer cache.
- Exact-lead/company deep links, safe sign-in return and wrong-company guard.
- Three editable requested-service text drafts, fresh consent/DNC checks and
  human-controlled native SMS handoff. Preparation is not sending or contact.
- Five-table review-only schema export; no hosted schema application.

Actual contractor contacts, routing assignments and confirmed intake details are
kept outside this repository and Docker contexts. No real owner was invited,
mailbox connected, device enrolled or customer message sent during this work.

## Local evidence

- Full Command Center suite: **333 tests passed across 60 files**.
- Full operator/scripts suite: **222 tests passed across 17 files**; includes
  additive schema composition and existing real-time historical scheduler tests.
- Focused isolated API tests passed for Microsoft (103), manual SMS (42),
  notification policy/transport/integration (99), stage isolation (6), and route
  inventory (7). These focused groups are not a full real-PostgreSQL release run.
- `pnpm run build` passed: workspace TypeScript checks, API bundle and Command
  Center production build. Existing large-client-chunk warning remains.
- `git diff --check` passed; changed files scanned for the private pilot owner
  addresses/phones and private-key markers, with no matches.
- Loopback browser QA uses only an in-memory fictional company with all provider
  credentials omitted. At a 390 x 844 viewport, lead reply controls fit without
  horizontal document overflow. Missing SMS permission blocks both native draft
  handoff and copy; recheck remains usable. Profile shows honest disconnected
  Microsoft/Gmail and held-notification states. Routing editor loads without
  silently saving synthetic members or a policy.

The broad API suite was not claimed locally: its existing independent-session
concurrency and safe test-database requirements are not represented by this
single-backend PGlite runner. Exact-head CI with PostgreSQL is still required.
No native phone composer, real push receipt or Microsoft OAuth acceptance has
been claimed from Chromium screenshots or mocked network tests.

## Historical evidence preservation

The prior hosted image/schema remains the c050067 release, with its original
source/hash pins and one-shot receipts intact. Current changes are not deployed.
Test-only frozen fixtures for the three diverged attested source files let old
90-table scheduler/drill unit tests retain that historical stage contract. Their
default hosted readers still reject changed current source. This is not a full
old-image reconstruction or permission to replay hosted drills. New notification
and current scheduler tests exercise current source separately.

An unscoped scheduler sequencing test now stubs the push worker so its expiry
housekeeping cannot mutate another concurrent suite's fixtures. It explicitly
tests stage success/failure/ownership loss; production housekeeping is unchanged.

## Next release gates

Follow `MOBILE-EMAIL-PILOT.md`, `STAFF-PUSH-PILOT.md` and
`CUSTOMER-EMAIL-PILOT.md`. Require exact-head CI, a separately approved held
staging/schema release, correct tenant and owner identities, verified mailbox
hosting, secure provider configuration and opt-in real-device acceptance.
No automatic hold release, provider activation, migration, customer import,
DNS change, phone forwarding or paid provisioning is part of this candidate.
The broader P0 lifecycle, normal-mode hosted isolation and owned external-alert
receipt gates remain open; these features alone do not declare pilot readiness.
