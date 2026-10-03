# Invoice delivery attempt kernel — October 2, 2026

Local implementation evidence for the second authorized wave. This report does
not establish provider connection, inbox delivery, customer activation, hosted
migration, deployment, payment collection, or Housecall Pro replacement readiness.

## Implemented contract

- `lib/db/src/schema/invoice-delivery-attempts.ts` adds one append-only review/
  identity chain. Attempt one retains `invoice-delivery:<invoiceId>`; successors
  use server-assigned ordinals. The lifetime limit is five, with exact uniqueness
  for each invoice ordinal, execution, preview, and predecessor successor.
- Required composite foreign keys bind the company, invoice, accepted actor,
  review audit, exact receipt/key/fingerprint/actor, and predecessor receipt/proof.
  Explicit checks forbid partially null successor references and require the
  post-preview acknowledgement only for additional copies. Narrow parent unique
  constraints are in `schema/revenue-workspace.ts` and `schema/audit.ts`.
- `artifacts/api-server/src/services/invoice-delivery-attempts.ts` atomically
  reserves attempt + durable execution + processing event. No provider operation
  occurs inside that transaction. It does not change the generic durable executor.
- The saved v2 review pins the actor, invoice/document/version, payload hash,
  customer/contact, recipient, selected sender, decision, reason, predecessor and
  expiry. A separate runtime acknowledgement is required after a copy preview;
  the saved preview itself records no prior acknowledgement.
- Only a typed pre-provider refusal marker plus the exact terminal `blocked`
  receipt allows a new, separately reviewed retry. Only exact provider acceptance
  plus `succeeded` allows a separately reviewed additional copy. Reconciliation,
  free-text notes, old blocked text, timeouts, and unknown effects grant neither.
- Final dispatch checks retained ownership, exact latest head, actor/hash/expiry,
  current accepted manager, current issued document, recipient, lifecycle and
  outbound hold. The dispatch service additionally rechecks the full source/
  assignment/sender/content snapshot and existing transactional eligibility at
  the actual post-OAuth boundary. No imported marketing permission is inferred.
- Finalization atomically records receipt + event + typed proof, and accepted
  email activity where applicable. A zero-row final CAS rolls back proof/activity.
  Failed finalization retains uncertainty and ownership. A lost acknowledgement
  after a successful atomic commit reads back the existing receipt, never resends.
- Actual late acceptance is retained even if staff/company eligibility changed
  after dispatch. It cannot replace an already interrupted or reconciled receipt
  or create additional-copy permission from that held state.

## Historical and read-only behavior

The bounded SELECT-only chain loader supports batches of at most 50 invoice IDs
(the worklist uses canonical pages of 25), with at most five attempts per invoice.
Missing, orphaned, conflicting, over-cap, or mismatched evidence fails closed. It
never chooses an older usable head. Expired processing is displayed as uncertain
without mutating the receipt during a GET.

Old fixed-key sends count as virtual attempt one. Source inspection of the old
preview writer proved that it saved hashes but no frozen participant/sender
context. Consequently old-format acceptance stays visible but cannot authorize a
new copy key: `nextIntents` is empty and the reason is
`legacy_review_identity_unavailable`. Current identities are not backfilled into
historical approval. New v2 attempts have the required pinned context.

Provider acceptance remains distinct from delivery or payment. Microsoft request
IDs remain request IDs; `id: null` is not converted into a message identity. No
mailbox/bounce monitoring, blanket send policy, scheduled resend, payment attempt,
financial record rewrite, or customer auto-send is added here.

## Verification

Command (disposable in-memory PGlite, loopback only, provider credentials stripped):

`node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/invoice-delivery-attempts.test.ts`

Latest result: **26 passed, 2 skipped, exit 0** at 22:42 Eastern. The two skips are
explicit independent-session PostgreSQL races (initial claim and successor
claim), which remain required in exact-head CI, not waived by the local runner.

Coverage includes atomic ownership before effects; replay suppression; typed
refusal and explicit copy transitions; five-attempt cap; stale predecessor;
post-preview copy acknowledgement; arbitrary-error refusal forgery; lost final
write; zero-row CAS rollback; committed-but-lost acknowledgement; late acceptance
after reconciliation; post-dispatch staff/lifecycle changes; late dispatch
revocation/expiry/contact/document/hold changes; old-format history; corrupted
review/proof/receipt and duplicate/orphan evidence; and tenant/null/FK escape.

`test-helpers/invoice-attempt-fixture.ts` provides provider-free canonical issued
invoice, exact saved v2 review, and synthetic acceptance fixtures. The coordinator
owns the SQL recovery fixture, generated migration, export/inventory and release
checks. `pnpm --filter @workspace/api-server exec tsc -p tsconfig.json --noEmit`
passed after the route owner fixed its test argument.

Read-only independent review of the final dispatch service, pure review contract,
real Microsoft-adapter tests and relevant customer-email/user-email/OAuth seams
found no concrete unsafe-permission, dispatch-replay or unknown-effect bypass.
The test transport exercises the actual callback after OAuth, lookalike provider
errors cannot create typed refusal proof, and interrupted receipt ownership still
blocks a new key when late acceptance is recorded. This is a bounded code review,
not fresh live-provider acceptance or a replacement for PostgreSQL CI.

The GrowthOS Revenue Desk and email reliability skills informed the exact-review,
retained-uncertainty and accepted-versus-delivered boundaries. This report is the
lane's durable checkpoint; the coordinator owns shared project/Jarvis state and
Git integration. No provider, hosted, credential, real-recipient, or memory
changes were performed in this lane.
