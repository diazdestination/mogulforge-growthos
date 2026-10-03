# Typed service replies — original mailbox to office review

Local engineering lane on the launch-completion candidate, October 2, 2026.
This closes a bounded service-reply gap. It is **not** complete lead-inbox support,
customer/provider acceptance, either contractor's replacement acceptance, or a
production activation. No real account, recipient or hosted database was used.

## Actual supported path

1. An accepted staff member reviews one expected-service reminder using the
   existing service-care approval. If the selected sender has a deliberately
   enabled Microsoft read connector, the approval freezes that connector,
   sender/account/connection revision and exact content alongside the service.
2. The original scheduled durable execution reserves one immutable communication
   parent before dispatch. The service occurrence, customer, approved message,
   recipient, execution fingerprint and random `x-growthos-parent-id` are fixed.
   An alternative key or second dispatch-header claim cannot replay it.
3. Microsoft `sendMail` acceptance still has no message ID. Acceptance is not
   delivery or a reply. The authenticated original mailbox's Sent Items must
   independently expose the exact frozen header, sender, recipient, subject and
   timing. Only then are its immutable provider ID and RFC Message-ID bound.
   Request/client correlation IDs never substitute for a message ID.
4. A deliberately connected Inbox observation must reference that exact original
   RFC parent and match the frozen customer/mailbox participants and timing.
   The current read grant, selected send revision, actor and company lifecycle
   are rechecked transactionally. Raw email content or a legacy forwarded payload
   cannot assert this authority.
5. The service receives retained reply evidence and an office-work hold. The
   canonical service task opens for review; service watch shows
   `reply_received_review`, with its existing assignment/acknowledgement/deadline
   and separately opted-in staff alert policy. No acquisition lead is created.
6. Staff explicitly reviews the evidence, with a version token and note. This is
   **not** a recorded customer outcome. The separate existing conversation
   attestation and conflict-checked customer-confirmed booking remain required.

## Boundaries preserved

- No inferred agreement, warranty terms, marketing/SMS consent, appointment,
  service completion, inbound autoresponse or outbound follow-up is introduced.
- A reply to a completed/cancelled or changed occurrence is history-only. It does
  not reopen that service or hold a newer recurrence. Current-date/contact edits
  also project previously stored evidence as history in reads and watch checks.
- A claimed/unknown send remains claimed/unknown even if a matching Sent Items
  record or reply is later observed. The new lane cannot reconcile or rearm it.
- Office dismissal removes only that receipt's service hold. It does not release
  other holds, reset the original dispatch slot or send another message.
- Read revocation, connector pause/gap, sender reconnection or selected-provider
  changes stop new intake/review. Reconnection does not silently adopt old parent
  identities; retained evidence can still be read. Staff can use the separate
  actual-conversation workflow, but this lane has no old-parent adoption/recovery
  command and must not advertise automatic continuity after such a change.
- An unrelated mailbox message is not retained as a retry candidate. A reply
  arriving before parent observation can be retried only when an exact-company,
  exact-connector, same-participant post-dispatch parent awaits observation. This
  is **not** fuzzy correlation: the eventual RFC parent must still match exactly.
- Email is plain-text untrusted evidence, never agent instructions. No HTML is
  executed, remote content loaded, attachment retrieved, tool invoked, or trusted
  sender bypass applied. Metadata prefiltering lets the reader avoid unrelated
  message bodies. The Microsoft reader owns its fixed Graph routes/cursor/lease.
- Message text/subject is AES-GCM encrypted for seven days, authenticated to the
  company and reply ID. GETs withhold expired/undecryptable content without any
  write. Explicit retention processing purges at most 100 expired bodies per
  pass; provider identity, hashes, review, hold and unknown effects remain.
- Reads and reviews are same-company, accepted-staff, role guarded. Browser
  mutations retain JSON/origin checks and reject programmatic API-key review.
  A lost acknowledgement/stale version requires explicit refresh/review; the UI
  never silently adopts a fresh version or retries a write.

## Schema and integration contracts

`lib/db/src/schema/mailbox-communication.ts` exports:

- `mailboxCommunicationParentsTable` (`mailbox_communication_parents`)
- `mailboxServiceRepliesTable` (`mailbox_service_replies`)

Both use non-cascading company/connector FKs. The reply's composite parent key
binds the exact company, parent, service, customer and connector together. Parent
header, original action key and service-occurrence ownership are unique.
The schema admits a typed lead target for future work, but this lane's only
parent creator and ingestion handler is the reviewed **service** path.

`artifacts/api-server/src/services/mailbox-communication.ts` supplies the internal
reservation/one-time dispatch-header/observation/intake functions and the read-only
`isMailboxReplyCandidate` prefilter. The separate Microsoft adapter calls these
with its currently validated `MailboxIdentity`. These are not public APIs.

`GET /api/v1/service-obligations/:id/mailbox-replies` is a SELECT-only, no-store,
25-item page with explicit `hasMore` and bounded offset. It returns evidence and
history without provider secrets, raw headers or dispatch-header values.
`POST .../mailbox-replies/:replyId/review` accepts only a request UUID, exact version,
`office_follow_up`/`not_customer_reply`, note and explicit review confirmation.

The customer-care panel exposes the reply review. Service watch distinguishes
arrived evidence from silence and staff-recorded interpretation; an older
unreviewed arrival cannot disappear behind a newer reviewed message.

Coordinator owns route mounting/OpenAPI, scheduler retention, schema exports,
new-release migration/recovery, inventory/export exclusions and global state.
Delete/purge tooling must remove reply children before communication parents,
then connector rows; ordinary connector disable never deletes retained evidence.

## Verification

All database checks used the approved fresh disposable PGlite runner, with
provider credentials stripped. UI transport and Graph/OAuth responses were
synthetic; no real provider request was made.

- Initial kernel + existing service-care/watch selection: **64 passed**, two
  existing independent-PostgreSQL skips, three files.
- Expanded kernel + real HTTP routes: **29 passed**, one new explicit independent-
  PostgreSQL concurrent-arrival test deferred to real PostgreSQL CI, two files.
  One earlier HTTP assertion exposed an unverified-actor 400/403 inconsistency;
  accepted-staff authorization was repaired and all five route cases now pass.
- Real-code integration (no module handler mocks): **1 passed**. The actual
  scheduler, selected sender, Microsoft send adapter, immutable parent kernel,
  connected reader, reply review and service watch run together with synthetic
  transport. Exactly one POST, no invented lead/appointment/conversation,
  duplicate arrival suppression, retained succeeded execution and blocked review
  after read revocation are asserted.
- UI service replies plus existing customer-care/watch panels: **22 passed**,
  three files. Plain-text rendering, permissions/holds, stale/lost-ack recovery,
  older pages, malformed/foreign data, expiration and slow old-selection responses
  are covered.
- Final combined local service selection: **74 passed**, three explicit
  independent-PostgreSQL skips, five files. This rerun includes the final
  metadata-only Graph delta: only the tracked reply body is fetched and an
  unrelated mailbox message in the same delta is ignored.
- Final UI selection including the service desk: **25 passed**, four files.
- A later integrated typecheck found a test-only async callback narrowing issue
  in the new real-code integration test. Its explicit message type was repaired;
  API and Command Center TypeScript then exited successfully. Final whole-
  repository checks and exact-head CI belong to the coordinator.

Independent review found one additional adapter/kernel contract defect: a Graph
metadata item with `<bad>` instead of a valid RFC Message-ID passed the adapter,
then kernel validation could throw and halt the whole connector. The actual
integration regression reproduced this (`checked: 0` instead of `1`). The kernel
now treats invalid metadata prefilter/Sent observation as ineligible evidence,
aligns provider IDs to the adapter's 1,024-character bound, and keeps strict RFC
identity requirements. The adapter separately records malformed known IDs for
review. Repaired kernel plus actual integration: **25 passed**, one independent-
PostgreSQL skip. The malformed item comes first; the later valid tracked reply
still arrives, the connector/read credential remains active, and no unrelated
body is retrieved. No validation was weakened to accept a forged parent.

Requested read-only independent review of the platform identity-delivery lane
found no concrete new blocker: permanent logical send ownership, unknown-effect
invitation reissue guard, source authority, signed original-byte callbacks,
permanent-bounce/conflict handling and human-only redacted status were inspected.
No peer files were edited. Old provider-account-context callbacks are not silently
adopted into a new context.

These are overlapping selections, not an additive all-suite total. PGlite does
not prove independent PostgreSQL session exclusion or any hosted/provider path.

## Deliberate remaining scope

This is **tracked Microsoft service reminders only**. Gmail/service, general
lead campaigns, arbitrary existing outbound mail, historical mailbox imports,
invoice replies, SMS replies and a unified inbox are not added by this lane.
Existing signed lead correlation and the legacy normalized intake are unchanged;
the legacy HMAC/alias boundary is not promoted into typed mailbox authority.
Neither a From address nor copied `In-Reply-To` text in forwarded intake can call
the new internal binding path.

Azure first login, explicit read consent, retained custom-header behavior in
actual Microsoft Sent Items, real send/receipt/reply acceptance, installed staff
phone alerts and owner/staff rehearsal remain separate approved acceptance gates.
Both contractors' actual required Housecall Pro replacement cards remain open.
