# Native invoice email delivery — October 2, 2026

Local synthetic engineering only, on `agent/growthos-customer-care-20261002`.
Payment collection is explicitly deferred by the owner. This slice creates no
checkout/payment link, processor account, bank action, charge, refund, public
document link or new provider scope. Staff-recorded external receipts and the
immutable issued invoice remain the existing canonical records.

## Implemented workflow

1. An invoice reader can inspect its email evidence. Only an active same-company
   owner/admin/office member can preview and approve delivery, through an
   authenticated staff session, strict JSON and the existing invoice-origin gate.
2. Preview renders every field of the canonical issued document as complete
   plain text supported by both existing Gmail and Microsoft adapters. It shows
   the saved opportunity contact's email, exact selected sender, subject and
   body. No editable/arbitrary recipients, attachments or public bearer links.
3. Preview creates a ten-minute, actor-bound review receipt containing only
   hashes, version and record identities. Approval requires that exact receipt
   and payload digest. Invoice/document/version, contact/email/source,
   assignment, selected provider or mailbox changes invalidate the approval.
4. Sending reserves one server-owned `invoice-delivery:<invoiceId>` execution,
   not a client-generated request key. Different previews, keys, racing clicks,
   restarts and operator reconciliation cannot create a second logical send.
5. Active invoice-manager permission, current canonical invoice/relationships,
   selected sender, customer lifecycle, global/staging holds and contact email
   suppression/do-not-contact eligibility are checked before claim and again at
   the actual provider boundary after token preparation. An issued invoice is
   genuine transactional work; imported provenance is retained and never becomes
   marketing authorization.
6. Provider acceptance adds invoice-specific audit evidence and one existing
   `email_sent` lead activity, so the signed mailbox reply-correlation mechanism
   can recognize it without introducing another outbound activity family.

Shared sender pinning and provider-dispatch callbacks are coordinator-owned;
the invoice lane supplies its late validation callback. No database schema
change is needed: existing audit and durable-execution tables retain the review
and evidence. OpenAPI integration and release checks remain coordinator-owned.

## Contracts

All endpoints use `/api/v1`, derive organization from membership, reject unknown
query selectors, and return `Cache-Control: no-store`.

| Endpoint | Permission | Input / result |
| --- | --- | --- |
| `GET /invoices/:id/delivery` | `invoices.read` | Current logical-send evidence; no mutation or automatic retry |
| `POST /invoices/:id/delivery/preview` | `invoices.manage`, session only | `{expectedVersion}` -> `previewId`, `payloadSha256`, `expiresAt`, invoice/source identity hashes, current recipient and selected sender, exact subject/body |
| `POST /invoices/:id/delivery/send` | `invoices.manage`, session only | `{previewId,payloadSha256,confirmed:true}` -> current delivery evidence |

Evidence states: `not_sent`, `processing`, `accepted`, `held`, `uncertain`,
`reconciled`. It includes the execution reference, safe provider message/request
receipt where available, acceptance time and explicit delivery limitation.
Microsoft request/client correlation is not mislabelled as a mailbox message ID.

## Honest failure and recovery boundaries

- Gmail/Microsoft send-only acceptance is **not inbox delivery**. Delivery/bounce
  monitoring is not connected by this slice. `deliveryConfirmed` remains false;
  no UI controls or staff attestations invent a delivered state.
- A failed acknowledgement, timeout, missing provider receipt or failed durable
  receipt write is conservatively **uncertain**. Do not infer definite failure
  from error text or resend with another key. Check the original selected mailbox
  and use the existing operator execution reconciliation with actual evidence.
- The concrete server-only `EmailDispatchBlockedError` proves no dispatch was
  attempted and is shown as held, with the reservation retained. An arbitrary
  provider error carrying an `effectNotAttempted` property is not trusted.
- Pre-claim holds leave the invoice unsent and allow a fresh review after the
  actual gate is corrected. A late hold after durable reservation is labelled
  held/not sent, and the slot stays reserved. A separately reviewed resend/rearm
  workflow is **not implemented**; changing/deleting receipts is not a workaround.
- Operator reconciliation does not itself send, release the logical slot, prove
  delivery or change financial records. No automatic retry queue is introduced.
- Lost UI acknowledgement disables send and demands a read-only status check.
  Stale invoice props disable the displayed approval. Existing draft-editor
  version binding and staff receipt semantics are preserved.

## Focused verification

Guarded command, fresh in-memory PGlite/random loopback, no inherited provider or
hosted credentials:

```
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/gmail-oauth.test.ts src/services/gmail-oauth-no-replay.test.ts src/services/invoice-delivery.test.ts src/routes/v1/invoice-delivery.test.ts src/services/invoices.test.ts src/routes/v1/invoices.test.ts
```

Result: **66 passed, 4 skipped** across six files. The skips are explicitly
independent-session PostgreSQL concurrency cases, including the new different-
review logical-send race; these require the real PostgreSQL CI gate.

```
pnpm --filter @workspace/command-center exec vitest run src/components/invoice-delivery.test.tsx src/pages/invoices.test.tsx
```

Result: **22 passed** across two UI files. Coverage includes exact reviewed text,
explicit checkbox approval, no HTML interpretation, read-only roles, unavailable
evidence, lost send acknowledgement and stale displayed version.

API cases cover complete immutable rendering, no cash changes, Gmail/Microsoft
acceptance distinction, same-tenant/current-role/actor/origin/API-key boundaries,
strict input, malformed/expired review, changed document/recipient/sender/source/
version, suppression/lifecycle/global holds, late provider-boundary changes,
expired ownership, and unknown-effect alternate-preview/reconciliation bypass.

## Shared Gmail transport repair

Independent inspection of installed `google-auth-library` 11.0.0 found that
`OAuth2Client.requestAsync` has a 401/403 refresh-and-replay path independent of
Gaxios's `retry:false`. It can occur when access-token expiry is absent (or
force-refresh-on-failure is enabled), and does not repeat the workflow approval
callback. A provider-free probe of the real library recorded two synthetic
transports and one refresh despite `retry:false`.

The Gmail send adapter now obtains and freezes the access token before final
approval, then calls the bare transporter with explicit Bearer authentication,
`retry:false`, `maxRedirects:0` and a ten-second timeout. It does not enter the
OAuth client's reauthorization wrapper for the irreversible message POST.
Identity, current credential, membership and lifecycle/hold checks remain.

The installed real OAuth client is exercised by
`services/gmail-oauth-no-replay.test.ts`, with only token preparation and the
bare transport stubbed. 401/403/500 cases prove one transport and no OAuth
request wrapper; withdrawn approval/missing tokens prove zero transports.
Together with existing Gmail tests and expanded invoice tests, the additional
guarded run passed **42 tests, 1 real-PostgreSQL concurrency skip**. No actual
Google, Microsoft or other provider request occurred.

This evidence is not a full release/typecheck/build, hosted migration, live
mailbox send/receipt/reply, authenticated provider delivery event, accountant
acceptance or customer activation. Actual contractor invoice receipt, external
payment reconciliation and staff acceptance remain on both replacement cards.
Production remains stopped, staging held, and Azure first sign-in deferred to
the owner's return. No live email, provider call, deployment or fee occurred.
