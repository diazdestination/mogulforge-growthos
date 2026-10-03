# Platform identity-email delivery ledger

October 2, 2026. Engineering slice L2 of `LAUNCH-COMPLETION.md`, based on
`c01bea06d5175b1d450462653aca5ed0c6246c60`. All evidence below is synthetic local
code/test evidence. No provider, mailbox, hosted database, customer, credential,
DNS or deployment operation was performed in this lane.

## Implemented contract

- `platform_email_dispatches` owns one permanent logical event before a provider
  call: verification/reset purpose plus the actual token-record UUID, or durable
  invitation UUID plus its token revision. Request UUID changes cannot reclaim
  it. Its immutable source identifier survives token/account deletion; existing
  authorization semantics are not expanded by delivery callbacks.
- The claim stores source identity, a recipient hash, sender/account context,
  content/authority fingerprint and exact outcome: `claimed`, `accepted`,
  `rejected`, `unknown` or `not_attempted`. It stores no raw token, token digest,
  reset/invitation URL, body or plaintext recipient. Provider acceptance requires
  an actual Resend-shaped UUID receipt. Local mock transport is never called by
  identity mail and can never establish acceptance.
- Duplicate logical events return retained evidence. Changed content, recipient,
  source authority or provider context cannot reuse a claim. There is no queue,
  resend, reset or rearm endpoint. A claim older than 30 seconds displays as
  unknown; it does not expire into permission to send again.
- Before provider dispatch, recheck the active unconsumed/unexpired token or the
  current pending invitation, exact pending member, current accepted/verified
  authorizing administrator, current sender/context, suppression, outbound hold,
  staging recipient restrictions and a 15-second preparation deadline. Another
  currently authorized administrator may explicitly reissue an invitation after
  the original creator is deactivated; the current actor is the authority.
- Known Resend rejection is retained as rejection; a timeout, unexpected receipt,
  reused provider message ID or uncertain receipt persistence remains unknown.
  No blind provider retry is introduced. Every claimed/unknown invitation attempt
  blocks later reissue across all revisions, including after revocation.
- `platform_email_events` retains normalized immutable callback evidence only
  after the existing raw-byte Svix signature check. Matching requires the current
  configured platform sender/account context and exact provider message UUID,
  recipient hash and sender. Callback-before-receipt is retained and correlates
  automatically only once an exact acceptance receipt exists.
- Duplicate signed bytes are idempotent. Changed signed payload under the same
  event identifier is retained separately and reported as conflicting evidence.
  Permanent bounce/complaint takes precedence over later delivered evidence;
  only a signed event attached to a known accepted platform send suppresses later
  identity messages to that address in the same context.
- Unrelated senders are ignored by this ledger; existing playbook callback
  semantics remain. The global/pre-organization evidence tables require explicit
  lifecycle inventory treatment, not an invented tenant predicate.

## Bounded callback backlog

Unmatched callbacks are capped at 1,000 records per exact provider context under
a transaction/advisory lock. Previously recorded duplicates still acknowledge;
events matching known acceptance receipts still process when the unmatched cap
is full. New unmatched events return the fixed `platform_callback_backlog_full`
429 response. No receipt is silently discarded to make room and no delivery is
invented. The derived backlog decreases when a late exact acceptance receipt
arrives. Only a verified platform administrator can see the aggregate backlog.

Changing the configured provider context intentionally prevents new-account
correlation with the old context. Late evidence from a previous configuration is
not advertised as automatically reconciled. An unknown send lacking its exact
provider acceptance UUID remains unknown even if unrelated signed mail arrives.

## Status and legacy compatibility

Read-only, `Cache-Control: no-store`, 25-row pages:

- `GET /api/v1/platform/email-deliveries` requires an active, verified, accepted
  human platform administrator; optional exact organization/invitation filters.
- `GET /api/v1/staff-invitations/email-deliveries` requires the current accepted,
  verified company owner/admin and returns only that company's invitation mail.
  API keys cannot substitute for the required human session.

The shared status panel is used in platform and staff-invitation surfaces. It
distinguishes sender acceptance, recipient-mail-server delivery, bounce/complaint,
conflict and unknown outcome. Refresh performs only GET and sends nothing. It
does not claim inbox placement, reading, verified account ownership or invitation
acceptance. `recipientLabel` is resolved at read time only if the current linked
user or same-company invitation still hashes to the original mailbox; changed or
deleted identities display no address. Source token identifiers, fingerprints,
links and content are omitted from the public DTO and never rendered.

Legacy pending users without a durable invitation record now receive an
actionable `LEGACY_INVITATION_REVIEW_REQUIRED` 409 from the old resend endpoint.
No GET or resend silently adopts legacy authority or sends a link. Explicit
legacy invitation migration/review is a separate operator workflow, not built
as an implicit bypass here. Existing tracked invitation token adoption remains.

## Deployment prerequisites (not activated)

Real platform identity sending requires the existing Resend key/sender plus
`PLATFORM_EMAIL_DELIVERY_CONTEXT`, a stable nonsecret provider-account/environment
identifier (3–120 ASCII letters/digits and `._:-`). Secret rotation within the
same provider account does not change the context; an account/environment change
must use a distinct context. A missing context fails closed. Production public
identity endpoints retain their enumeration-resistant responses and configured
sender readiness checks; provider failures do not publish tokens or raw errors.

Before live acceptance: coordinator-reviewed additive schema/recovery/export,
exact-release CI/builds and held staging, approved context/sender configuration,
verified signed callback registration, and separately authorized real test inbox
receipt for verification, reset and invitation. Delivery never consumes a token,
creates a session, grants membership or reverses revocation. A real bounce and
unknown-outcome reconciliation drill must not resend an uncertain message.

## Local evidence

Final focused run in the provider-free disposable PGlite runner:

```text
node artifacts/api-server/scripts/test-scheduler-isolated.mjs \
  src/services/platform-email-delivery.test.ts \
  src/routes/v1/platform-email-delivery.test.ts \
  src/services/identity-token.test.ts src/services/identity-email.test.ts \
  src/services/invite-email.test.ts src/routes/identity-auth.test.ts \
  src/routes/v1/staff-invitations.test.ts src/routes/v1/resend-invite.test.ts \
  src/routes/v1/delivery-status.test.ts

9 files; 98 passed; 1 existing independent-PostgreSQL-session test skipped.
```

Included: eight simultaneous logical callers/one provider effect; no-replay
unknown and rejection; changed content/context refusal; late token consumption,
sender change, invitation revocation and actor downgrade/deactivation; valid
replacement-admin reissue; callback-before-receipt through the actual signed HTTP
route; forged callbacks; out-of-order permanent failures and suppression;
immutable conflict evidence; bounded backlog; account deletion preserving the
logical reservation; tenant/role/API-key gates; existing password reset/session
revocation; unchanged playbook callback tests.

UI command: `pnpm --filter @workspace/command-center exec vitest run
src/components/platform-email-delivery-panel.test.tsx
src/components/client-staff-invitations.test.tsx` — 12 passed. Includes malformed,
contradictory and foreign responses, recipient labels, unknown/no retry, read-only
refresh and omission of unexpected token/source/body/link fields.

`pnpm --filter @workspace/api-server exec tsc -p tsconfig.json --noEmit` passed
after the owned HTTP fixture typing and the separately owned mailbox integration
fixture narrowing were corrected. The CR-at-EOL-aware owned diff whitespace
check also passed; the existing mixed line endings in `routes/auth.ts` were
preserved rather than normalizing unrelated code.

A broader optional onboarding-org fixture run was stopped after it stalled on
the previously diagnosed nested global-query/default-playbook transaction path
in the single-session PGlite bridge. No timeout/skip or production transaction
was weakened. Its real-Resend-like synthetic registration fixture now supplies
the required nonsecret context and UUID receipt. Full independent-session
PostgreSQL CI is still the authoritative gate, including invitation races and
the complete onboarding suite.

An independent worker reviewed the current ledger, identity/invitation wiring,
signed callback route and safe read DTO without finding a concrete blocker.
Coordinator owns final shared checks, release evidence and durable STATE update.
