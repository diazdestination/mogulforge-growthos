# Contractor operations: accepted staff and invitations

October 1, 2026. Local candidate on `agent/growthos-contractor-operations`, starting from `8bef3c0`. No customer contacted, identity provider contacted, provider activated, deployment changed, or live data modified.

## Reproduced defect

The new `staff-readiness.test.ts` failed on the original implementation: a pending `invite:` owner and an explicitly unverified admin counted as **two managers and two responders**. The expected count was zero. An account row alone was therefore enough to claim office coverage before anyone accepted access.

`accepted-staff.ts` now requires active membership, a non-placeholder identity, and verified mailbox evidence. The check is used by client readiness, Smart Site readiness, activation and new intake. It changes readiness only. The existing schema deliberately marks migrated legacy users verified with its `email_verified_at` default; the positive regression preserves that evidence. Explicitly null new/unverified rows do not satisfy coverage. No memberships are revoked by this migration.

## Implemented workflow

- An active verified platform administrator can invite the first owner into the selected isolated client from Launchpad, then invite its office team. The operator's own organization and role stay unchanged.
- Existing organization owners/admins continue inviting their own team through `/users/invite`. Admins cannot grant or change owner access. API keys cannot manage users. Existing accounts cannot be silently moved, promoted or replaced.
- The additive `staff_invitations` ledger records tenant, request digest, pending identity, token revision, seven-day expiry, version, delivery state, acceptance and revocation. Tokens and email bodies are never returned in listing/create/action DTOs or written into audit metadata.
- Create requests use a caller request UUID. Retrying the same request reconciles its saved result without another email. Organization/request locking precedes mailbox locking; competing payloads for one UUID conflict deterministically. Reissue and revoke require the current version and explicit confirmation. Reissue has a one-minute cooldown and invalidates old links.
- Delivery is bounded to fifteen seconds. The durable `sending` record exists before a provider attempt; failed, timed-out or interrupted acknowledgements become unconfirmed. A pre-dispatch authorization/deadline check prevents a late preparation step from starting a send after timeout or revocation. An already handed-off email can still complete. Reissue is an explicit reviewed decision, never automatic recovery.
- Signed-link password acceptance and OIDC invitation adoption share a locked transaction. It rechecks active pending state, tenant, email, role, expiry and revision before replacing the placeholder identity and recording acceptance. A preexisting authentication subject is not reassigned.
- OIDC invitation adoption requires the trusted token's boolean `email_verified: true`. A login alone does not prove a mailbox. Already verified same-mailbox legacy evidence is preserved; changing the mailbox without that claim does not copy the old verification timestamp. Unsupported OIDC adoption returns a clear 403 directing the person to the signed invitation or administrator.
- Audits record creation, sender acceptance/unconfirmed result, reissue, revocation and acceptance. Pending staff never count as accepted responders.

## API and UI boundaries

Platform routes in the existing client-onboarding router:

```
GET  /platform/clients/:orgId/invitations
POST /platform/clients/:orgId/invitations
POST /platform/clients/:orgId/invitations/:invitationId/reissue
POST /platform/clients/:orgId/invitations/:invitationId/revoke
```

Every route requires current platform authority. Mutations require same-origin browser requests, JSON and explicit confirmation. The ordinary team path derives its tenant from the session; it never accepts a client-selected tenant. List and invitation DTOs include the organization identity for client-side mismatch rejection. Listings intentionally show the latest 100 with a truthful older-record review path.

Launchpad keeps one compact staff section. It names approval, pending acceptance, expiry, revoked access, and uncertain delivery. Create inputs/request UUID survive a lost acknowledgement and closing/reopening the section. A failed action requires a successful status refresh before another versioned mutation. All conflicting controls disable during mutation. No invitation link or credential is exposed to the platform UI.

## Evidence

- Baseline regression: pending/unverified staffing count was 2; expected 0. After the fix, capture rejects before writing a lead; inserting a migrated verified owner restores the positive path.
- Guarded synthetic runner: **33 passed, 1 skipped** across staff invitations, mocked OIDC callbacks, legacy resend, staffing, token and email tests. Explicit delayed-preparation tests prove zero provider calls after a delivery deadline or concurrent revocation. The skipped case deliberately requires independent PostgreSQL sessions for competing request identities and remains enabled in CI. Existing broader onboarding/Smart Site tests refused the PGlite database URL or stalled in that runner; stopped only that owned process tree. Their existing safety guards and concurrency cases were preserved for PostgreSQL CI.
- UI: **13 passed** across invitation controls and existing Launchpad regressions. Includes lost acknowledgement and stable UUID, stale version recovery, pending-action disabling, workspace mismatch rejection, expiry and revocation.
- Browser:320px,390px,1440px light and390px dark; **zero axe WCAG A/AA violations, horizontal overflow, page errors or external requests**. Synthetic create was aborted once, retried with the same UUID, and recovered truthfully. The first pass detected low dark-theme contrast on the primary confirmation button; scoped theme text tokens fixed it and the confirmation pass passed all four variants. Screenshots/results: `C:\Forge\workspace\growthos-contractor-staff-2026-10-01`. No recordings. Temporary page/module removed and the owned preview server stopped.
- Impeccable incumbent-style onboarding guidance applied. Manual detector exited 0 with no findings. Command-center types and combined API workspace types passed on the integrated local candidate; exact final-commit checks are coordinated by the parent.

## Remaining acceptance gates

1. Parent-reviewed additive migration and PostgreSQL CI must pass at the final commit, including the independent-session request race. This report does not substitute local PGlite for that gate.
2. Approved hosted origin, transactional sender credentials and actual invitation delivery/acceptance must be exercised with approved recipients. Local email was a synthetic sink throughout. Provider acceptance is not inbox delivery or human acceptance.
3. Each supported OIDC provider must supply verified-mailbox claims before invitation adoption can be claimed supported; otherwise use the signed invitation/password path. No provider scopes or identity configuration changed here.
4. A real client owner must approve the intended recipient and role. The platform operator never impersonates that owner. Website activation still requires all other existing capture/deployment/credential/recovery gates.
5. Migration/backup restore, hosted scheduler supervision, real sender authorization and operational client rehearsal remain separate parent-owned release checks. This does not claim replacement scheduling, invoices or warranty tracking complete.

## Ownership

Runtime: invitation service/schema, accepted-staff predicate, invitation token/email revision hooks, relevant auth/me/client-onboarding routes, and Smart Site/client readiness staffing predicates. UI: new staff section plus its Launchpad mount. Parent owns shared exports/catalog/router/API inventory/migrations and integration release records. No commit or push performed by this agent.

## Independent reply-lane review

The reply worker repaired the concrete findings raised during independent review: missing Origin/JSON mutation checks, omission of the actual manual-send activity type, untrusted timeline metadata masquerading as provider acceptance, and a concurrent reply hold racing resume/skip transitions. Inspected the repaired `reply-evidence.ts`, correlation matcher, real producer call sites, and shared per-lead lock ordering. The proof binds tenant, opportunity, provider, mailbox, provider message ID, actual recipient and acceptance time; unavailable evidence leaves the reply for staff review while preserving the successful send. Raw-content deletion retains the minimal hold ledger. Resolving a hold never resumes cancelled work or clears company/source holds.

Independent latest local execution of `email-response-correlation.test.ts`: **27 passed, 3 skipped**. The three skips require independent PostgreSQL sessions (claim, resume, skip ordering) and stay enabled in CI. No remaining blocking source finding identified in the repaired scope; this does not claim live provider normalization or hosted race acceptance. The other worker independently reviewed invitation request locking and OIDC verification provenance and reported no remaining source blocker after its own focused tests.
