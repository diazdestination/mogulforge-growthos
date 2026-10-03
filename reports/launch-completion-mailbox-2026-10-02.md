# Optional Microsoft service-reply connector — October 2, 2026

Status: implemented and synthetic-tested on the launch-completion branch. No
Microsoft sign-in, tenant registration, remote permission change, hosted schema
change, real email, customer data, deployment or paid activation was performed.
The platform switch remains disabled by default. This report is not live-provider
acceptance evidence.

## What is supported

An accepted active staff member with `crm.write` can explicitly opt their own
currently selected Microsoft sender into a separate read connector. The connection
screen requires two acknowledgements: exact-mailbox read permission, and the
company's inbound retention policy. The Microsoft authorization screen then asks
for delegated `Mail.Read`, `User.Read`, and `offline_access`, using an actor-bound,
single-use, encrypted-PKCE transaction. Existing send-only scopes and credentials
are not silently replaced or expanded. The read credential is separate and is
used only for token refresh and bounded Graph GETs, never sending or mailbox edits.

This first version tracks **replies to typed GrowthOS service reminders sent from
the opted-in Microsoft mailbox**. It is not a general inbox. Existing lead
conversations, Gmail, shared mailboxes, invoice replies, attachments and older or
untracked messages are not brought into this connector. The settings UI says so.
The older signed lead-reply proof path remains distinct and unchanged.

The peer-owned typed communication kernel reserves an immutable outbound parent
before the email POST. The Microsoft adapter obtains its server-owned
`x-growthos-parent-id` header only through a one-time dispatch assertion, then
reruns the complete workflow/consent guard, read identity, membership, selected
send-connection revision, lifecycle and outbound hold before POST. A late failure
is a known no-effect block; the permanent claim is not reset or replayed.

Microsoft `sendMail` acceptance still has `id: null`; neither request IDs nor the
custom header are presented as a delivered message. A subsequent exact Sent Items
observation from the same original mailbox binds the actual immutable API ID and
RFC Message-ID to that parent. Exact single direct `In-Reply-To`, participants,
mailbox/revision, parent and time checks permit an Inbox reply to become encrypted,
untrusted office-review evidence. No content is a tool instruction, consent,
booking, service completion or warranty decision. The office review/hold UI and
kernel are described in the parallel service-reply lane report.

## Interface and shared integration

Owned schema exports: `mailboxConnectorsTable`, `mailboxReceiptsTable` from
`lib/db/src/schema/mailbox-connectors.ts`. Connector/user and receipt/connector
foreign keys are composite company-scoped keys. The retained send-connection ID
is historical identity, not a cascading live-credential relationship; every use
rechecks the current same-company selected connection and its revision.

The coordinator mounts `routes/v1/mailbox-integrations.ts`:

| Route                                    | Meaning                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /api/v1/mailbox/microsoft`          | Current member's safe no-store status; no token/cursor/body                             |
| `POST /api/v1/mailbox/microsoft/connect` | Explicit acknowledgements + expected version; returns fixed Microsoft authorization URL |
| `GET /api/v1/mailbox/microsoft/callback` | Actor-bound single-use callback; fixed local redirect                                   |
| `POST /api/v1/mailbox/microsoft/disable` | Confirmed versioned local read disable; no remote-consent claim                         |

No API-key or organization/user override can manage another staff member's grant.
Browser mutations require the configured origin; cross-site/same-site requests
and Basic-header/ambient-cookie bypasses are rejected. A validated bearer session
is the only supported missing-Origin mutation path. Status always includes
nonnegative integer `pendingParentCount` and `reviewCount`, including zeros when
there is no connector.

`processMailboxConnectors(organizationId?, { transport? })` is the coordinator's
`mailbox-replies` scheduler entry point. `MICROSOFT_MAILBOX_READ_ENABLED=true` is
required for OAuth and polling provider calls. Absent, false or unrecognized values
remain disabled. `getMicrosoftMailboxIdentity(org, user)` and
`assertMailboxIdentityCurrent(identity, reader?)` are internal identity contracts;
the latter uses a passed transaction reader to avoid nested-pool deadlocks.

The peer kernel exports the exact typed parent bind, read-only candidate filter,
reply intake and one-time outbound assertion. Connector receipts and page cursors
are written only after those operations complete. If a worker dies after intake
but before saving its cursor, kernel identity and receipt deduplication make the
same observation safe to revisit; no email is resent for an ID.

## Bounds, privacy and failure behavior

- A newly completed opt-in starts at its completion time. Initial per-folder
  delta uses `receivedDateTime ge <start>`; local received/sent time checks reject
  pre-start events. There is no initial historical inbox crawl, References-based
  fallback, arbitrary provider search or automatic full resynchronization.
- Each read uses immutable-ID headers. Continuations are encrypted and validated
  against the fixed Graph v1 origin, exact original account/folder delta path and
  allowed delta query keys. Provider redirects and arbitrary URLs are rejected.
- Polling selects at most five connectors with oldest `lastCheckedAt` first.
  A 90-second exact-version lease permits only one worker. Each run budgets
  25 seconds before further work, permits two 25-item pages per folder and uses
  10-second request timeouts. A current request may finish after the run budget;
  the next guard stops additional reads without discarding the saved cursor.
- Sent Items is processed before Inbox. Delta requests metadata only, not bodies.
  Only an independently eligible exact tracked-reply candidate causes a bounded
  GET of that already-observed immutable Inbox ID. Returned metadata must still
  match before body ingestion. No attachment is retrieved or executed.
- Plain text is capped at 32,000 UTF-8 bytes; response JSON at 512,000 bytes;
  recipient/reference arrays at 25; message IDs, RFC IDs, headers and dates have
  explicit bounds. Malformed/future metadata, invalid RFC identifiers, unsupported
  or oversized bodies and missing pending IDs become metadata-only review items,
  not authorization loss. A following valid message still processes.
- Unrelated messages never become trusted replies and unrelated reply bodies
  are not fetched. Receipts retain IDs, metadata digests, state, attempts and
  timestamps, not bodies or attachments. The typed reply store separately owns
  encrypted matched content and its permanent duplicate evidence/retention.
- An exact eligible reply received before its Sent Items parent observation can
  wait in a metadata-only pending receipt. At most five prior pending IDs are
  revisited per tick; ten unsuccessful intake attempts become review. No fuzzy
  search, new send, new parent claim or historical fallback resolves it.
- A true cursor reset (410), invalid continuation, changed same-ID evidence or
  downstream ambiguity holds the connector without inventing coverage. Temporary
  network/rate/budget/oversized-whole-page errors retain the cursor and grant for
  later bounded checks. An unparseable whole page cannot be silently advanced.
- Global feature disable and company pause stop new reads; mailbox/revision,
  staff, scope or authorization changes fail closed. Local disable wipes the
  read credential and lease and cancels pending read authorization. Existing
  evidence remains; Microsoft remote consent must be revoked separately.
- Health displays current state/reason, forward-only start, last completed page
  and pending/review counts. A completed page is not proof of complete coverage.
  Review-only unsupported items currently require original-mailbox inspection;
  they do not expose a general inbox browser in GrowthOS. A new opt-in starts
  now and explicitly does not repair an earlier held/gap period.

## Verification performed

Provider-free command using the guarded fresh in-memory PGlite/random-loopback
runner, with external database/provider environment stripped:

```text
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/mailbox-microsoft-dispatch.test.ts src/services/mailbox-graph.test.ts src/services/mailbox-connector.test.ts src/routes/v1/mailbox-integrations.test.ts src/services/microsoft-oauth.test.ts
```

Final lane run: **68 tests passed** across five files: connector 14, Graph 20,
HTTP 4, one-time parent dispatch 6, existing send-only Microsoft 24. Coverage
includes separate scopes/credentials, actor and company boundaries, pause during
callback, changed mailbox/revision, no provider calls while held, exact cursor
allowlisting, malformed-then-good metadata, oversized and missing-body review,
no unrelated body fetch, durable redelivery, parent-before-reply ordering,
overlapping worker exclusion, Basic/cookie origin defense and late contact,
credential, read-disable and global-hold dispatch rejection.

UI command:

```text
pnpm --filter @workspace/command-center test src/components/mailbox-connection-card.test.tsx src/components/email-connections-card.test.tsx
```

Both files passed **9 tests**. Existing send-status error assertions distinguish
the new read-status panel's separate failure; no guard or failure assertion was
removed. New checks cover two explicit acknowledgements, exact versioned command,
disabled platform/gap visibility, local disable during a platform hold and unsafe
authorization URL rejection. API `tsc --noEmit` also passed after integration.

The peer additionally owns a real synthetic service-care → customer-email →
Microsoft POST → Sent Items → Inbox → typed office-review integration test, plus
kernel concurrency coverage. Its reported pass is complementary, not a live
provider claim. The coordinator owns full-suite, exact-head CI, real-PostgreSQL
release checks, schema preview, recovery and final review; worker-local PGlite
checks do not replace those gates.

## Required live-proof and release gates

1. Owner's first Azure sign-in and exact app/tenant account verification remain
   deferred. Configure the separate approved callback
   `/api/v1/mailbox/microsoft/callback` and delegated permission consent only in
   the approved environment. No registration or secret was read/changed here.
2. Obtain explicit company policy/retention approval and selected sender identity,
   approved synthetic sender/recipient pair, and operator authorization for read
   opt-in. Do not flip the global switch merely because code/CI passes.
3. Apply only the reviewed candidate schema through the coordinator's staging,
   backup/recovery and privilege gates. Historical hosted source attestations
   do not attest these new tables. Outbound/scheduler/production holds remain.
4. In the authorized mailbox, prove the custom header survives Sent Items, the
   exact immutable API and RFC IDs bind to the saved parent, and a real exact reply
   becomes one untrusted review item with no duplicate send or office task.
   Verify ordinary malformed/automated/unrelated mail, transport timeout, gap,
   revocation, selected-sender change, pause and read-disable behavior.
5. Confirm actual Graph continuation/folder formats and tenant behavior against
   the fixed allowlist. Unsupported responses must remain visibly held, not be
   relaxed into arbitrary URL fetches or silent history ingestion.
6. Confirm retention/purge preserves deduplication and truthful office evidence;
   manually review any missing period before restarting forward-only monitoring.
   This feature does not by itself permit client cutover or cancellation of
   Housecall Pro, and it does not complete Gmail/general lead inbox support.

## Official provider sources used

- [Graph message delta](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0): per-folder delta, projection/page/filter support and opaque continuation links.
- [Delta query for messages](https://learn.microsoft.com/en-us/graph/delta-query-messages): filtered removed/read-state events still require local boundary checks.
- [Immutable Outlook IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id): per-request header and mailbox-local ID behavior.
- [Graph sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0): custom headers and 202 acceptance without a message response body.
- [Message resource](https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0): RFC Message-ID and internet headers.
- [Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference): delegated Mail.Read versus Mail.ReadBasic and Mail.ReadWrite.
- [Delta query overview](https://learn.microsoft.com/en-us/graph/delta-query-overview): reset/gap behavior; this connector does not silently reset.

The email-best-practices and agent-email-inbox skills shaped the explicit read
consent, strict identity/correlation, bounded untrusted content, human review and
no-blind-retry implementation. The Jarvis checkpoint is this durable lane report
plus checked-in-scope source on disk; the coordinator alone updates shared STATE,
release docs and Git so parallel work cannot overwrite one another's handoff.
