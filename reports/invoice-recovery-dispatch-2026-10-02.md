# Invoice recovery: exact review and provider-boundary evidence

Local synthetic implementation on `agent/growthos-invoice-recovery-20261002`,
based on the accepted first-wave main `51da543`. This report covers the delivery
service, pure request/message contract and actual-adapter synthetic tests. The
append-only attempt kernel/schema, HTTP/worklist/UI and release integration have
separate owners and evidence. No provider, hosted database or real customer was
contacted; payment collection remains deferred.

## Implemented decisions

- An initial review remains compatible with `{expectedVersion}`. Recovery is
  never inferred from a failed screen or a retry button: the staff member must
  choose the kernel-authorized `retry_not_dispatched` or `additional_copy`, pin
  the exact latest execution, and provide a new 10–1000-character reason.
- A ten-minute v2 review freezes the complete canonical issued document, exact
  recipient, selected sender/provider, source/contact/assignment fingerprint and
  displayed decision. Its audit retains hashes, identities and decision fields,
  not message bodies, credentials, public links or attachments. Changing any
  reviewed source or selected identity invalidates the displayed approval.
- Preview never acknowledges a duplicate: its saved acknowledgement is false.
  Sending an additional copy requires a separate post-preview acknowledgement.
  Both subject and body clearly identify a **COPY of the same issued invoice**,
  not another bill/charge, a live balance or a payment receipt.
- Only a currently verified, accepted, active same-company invoice manager can
  prepare or send. Pending `invite:` pseudo-users cannot act even if an
  inconsistent fixture marks them verified. Ordinary invoice-read permissions
  remain unchanged.
- The service uses the invoice-specific kernel for permanent logical ownership,
  the maximum-five append-only chain and atomic outcome/audit/activity recording.
  It does not modify the generic durable executor, reset old keys or release
  uncertain work. Repeated/stale requests return retained evidence without a new
  effect. Legacy `canPrepare` remains initial-only; new clients consume the
  authoritative `nextIntents` and chain integrity.
- Before claiming and again immediately before provider dispatch after OAuth,
  the service rereads the exact review and current canonical invoice, recipient,
  source, assignment and sender; rechecks lifecycle/outbound and contact email
  suppression; and checks the kernel's exact current head, receipt actor,
  fingerprint, processing ownership and expiry. Only the explicit pre-provider
  guard or known server refusal becomes typed no-dispatch proof. Arbitrary error
  names, provider text or `effectNotAttempted` fields do not grant a retry.
- A real provider acceptance is recorded even if mutable company policy changes
  after the POST. Missing/lost provider acknowledgement remains uncertain; no
  automatic retry or alternate mailbox exists. Acceptance still never means
  inbox delivery, customer reading, settlement or payment.

## Compatibility and deliberate limits

The existing transactional invoice basis is preserved. Imported opportunity
provenance is neither erased nor reinterpreted as marketing permission, and an
ordinary lead reply is not a universal ban on explicitly reviewed invoice email.
Current do-not-email/suppression/company/sender controls still apply.

Old-format hash-only preview parents did not retain the original selected
recipient/sender context. Matching historical acceptance is readable and the
receipt remains unchanged, but it cannot independently establish a new copy's
authority. These records therefore return no recovery intent and
`legacy_review_identity_unavailable`; they are not silently adopted or signed
after the fact. Old unconsumed previews also require a fresh v2 review. New v2
attempts support the separately reviewed copy flow.

A reconciliation note, `confirmed_not_performed`, old untyped "not sent" text,
unknown latest effect, malformed chain or lifetime attempt ceiling never permits
a successor. There is no automatic resend, payment processor, mailbox-reading
scope, bounce feed or provider-account activation in this work.

## Synthetic verification

Commands use the inspected disposable runner: fresh in-memory PGlite, a random
loopback port and scrubbed provider/hosted environment. External fetch in the
adapter test is restricted to synthetic responses for the expected Microsoft
token, identity and send URLs; every other external URL fails the test.

```text
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/invoice-delivery-contract.test.ts src/services/invoice-delivery.test.ts src/services/invoice-delivery-adapter.test.ts
pnpm --filter @workspace/api-server exec tsc -p tsconfig.json --noEmit
```

Final combined focused run: **70 passed across three files; one existing
independent-PostgreSQL race skipped locally.** This includes 45 service/contract
tests and 25 actual-adapter tests. API TypeScript passed afterward. The PostgreSQL
race is not waived or counted as a local pass; exact-head PostgreSQL CI remains
required. No owned test process remains running.

Coverage includes strict inputs, initial-only compatibility, roles/tenant/review
ownership, exact copy text and post-preview acknowledgement, known refusal to
reviewed retry, accepted to reviewed copy, lifetime cap, old evidence retention,
missing/tampered/expired reviews, changed invoice/customer/source/sender, and
unknown alternate-preview/reconciliation bypasses. Fifteen real-adapter cases
change authority during OAuth preparation and prove **zero customer-message
POSTs**. Timeout, similarly named guard-like error and HTTP 503 after the actual
POST each prove **one POST, no no-dispatch proof, no replay authority**.
Further adapter cases preserve late actual acceptance under interrupted
ownership without copy permission, and reject a copy whose predecessor evidence
changes during OAuth.

Independent peer review of the dispatch service and real-adapter tests found no
concrete dispatch or unknown-effect bypass. A stale compatibility comment was
corrected to match the enforced old-format-history read-only policy; no runtime
behavior changed after the passing focused run.

The GrowthOS/email reliability skills informed deterministic logical-event
ownership, clear transactional copy wording and explicit accepted-versus-
delivered evidence. Their generic retry guidance does not override the stronger
repository requirement to retain and never replay an uncertain external effect.

Local implementation is not a hosted upgrade, live invoice receipt, provider
delivery proof, accepted contractor workflow or authority to cancel an old
subscription. Those release and customer/provider acceptance gates stay separate.
