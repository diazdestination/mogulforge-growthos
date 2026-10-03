# Tracked lead replies — connector and contractor UI

Date: October 2, 2026. Base: green `c2d999b`, working branch
`agent/growthos-lead-replies-20261002`. This report records local synthetic
engineering, not live Microsoft/customer acceptance. Coordinator owns integration,
SQL/recovery evidence, complete API/build checks, commits and exact-head CI.

## Implemented contract

- `mailbox_connectors` has a separate `lead_monitoring_enabled` default false,
  nonnegative `lead_monitoring_version`, and approved/changed timestamps. A database
  CHECK requires positive version and both timestamps for an enabled approval.
- `POST /api/v1/mailbox/microsoft/lead-monitoring` requires an accepted verified
  current staff session, same-origin JSON mutation guard, exact owned connector and
  both expected versions, boolean enable/disable and explicit acknowledgement.
  It rejects caller-supplied alternate user/company fields. Enable requires the
  exact active selected Microsoft grant and all platform/company readiness gates;
  local revoke remains possible while globally held. Mutation and audit are atomic.
- Enabling/disabling this context does **not** change the service connector identity,
  original start, cursor, connection revision or service parents. Revoke/re-enable
  advances the lead version. A new read OAuth start defaults back to service-only,
  preventing silent adoption of prior lead conversations.
- Internal `getLeadMonitoringApproval(identity, reader?)` returns a current exact
  approval or null for an otherwise usable service-only connector.
  `assertLeadMonitoringApproval(identity, approval, reader?)` fails closed on stale
  identity or approval; transaction callers use the same reader and shared row lock.
  Previously prepared tracked sends must not fall back to untracked sending.
- All status responses, including no connector, include
  `leadMonitoringEnabled`, `leadMonitoringVersion`,
  `leadMonitoringApprovedAt`, `leadMonitoringChangedAt`. No extra Graph scopes.

## Content access and pending recovery

New delta pages already used metadata-first candidate checks. Pending exact-ID
retries now do so too: fixed immutable Inbox ID metadata GET -> current context
candidate check -> separate bounded body GET only if eligible -> independently
revalidated ingestion. Metadata rereads exclude `body` and strip an unexpected
body from the normalized result. An old lead acknowledgement cannot authorize a
pending body read after revocation. Service-context pending evidence remains
independently eligible. This changes no cursor URL trust, page bound, lease, receipt
digest, attachment exclusion or provider authentication behavior.

## Actual contractor surfaces

1. Account/settings mailbox card shows service-only as the default. Explicit
   tracked-lead approval names the selected mailbox and submits both displayed
   versions. A conflict requires refresh plus another acknowledgement; no automatic
   retry. A stopped/global-held connection can revoke the local lead permission.
2. Revenue Desk and the advanced BIE action queue have **Prepare recipient and
   sender** before new email approval. The returned saved review shows exact To,
   From, provider and tracked/untracked status; approval sends the entire displayed
   payload, not a reconstructed or freshly looked-up payload. Unsaved draft edits
   and changed server drafts remain protected. Conflicts pause controls until an
   explicit refresh. Older approved messages stay labelled untracked. Guarded
   execute/reject requests include JSON `{}`. Advanced email actions are disabled
   for non-writing users.
3. Canonical lead **Messages** contains original-mailbox evidence, exact responsible
   worker/task, held/historical/handled state and claimed/uncertain-work warning.
   Subject/body render only as escaped text and disappear at raw-retention expiry.
   The client checks returned lead, page and evidence shape before enabling review.
4. A staff handling note (10–1000 characters), explicit review checkbox, frozen
   `expectedVersion` and stable request UUID handle only that reply/task. A stale
   decision preserves the note and blocks further decisions until explicit discard
   and refresh. Handling neither sends, reconnects, adopts old parents, nor restarts
   paused/cancelled work. `monitoringCurrent=false` displays a continuity warning
   but does not orphan already-observed evidence. Current staff/tenant/lifecycle
   authorization remains enforced server-side by the kernel lane.
5. Evidence pages are bounded to 25. The existing Customer replies queue links
   typed records to `/leads/:id?tab=messages#mailbox-replies`, suppressing legacy
   relink/release controls. Lead detail accepts the exact `tab=messages` value and
   preserves reply focus. No separate inbox or broad historical download was added.
6. The new coordinator-owned `review_customer_reply` recommendation has matching
   Next Best Action, Today actions and Insights UI. It links to evidence without a
   send, mark-sent, snooze or dismiss control, even if a stale draft is present.
   Saved handling refreshes reply/Revenue/BIE/next-action/Today/task queries.

## Local evidence

Final runs after implementation and scoped formatting:

```text
node artifacts/api-server/scripts/test-scheduler-isolated.mjs \
  src/services/mailbox-connector.test.ts \
  src/services/mailbox-graph.test.ts \
  src/routes/v1/mailbox-integrations.test.ts
44 passed: connector 18, Graph 21, actual HTTP 5.
Fresh in-memory PGlite schema and random loopback only; provider transports fake.

pnpm --filter @workspace/command-center test
88 files, 558 tests passed. Runner timestamp 22:03:25, duration 17.66 seconds.

pnpm exec tsc -p artifacts/command-center/tsconfig.json --noEmit
Passed.
```

Regressions cover permission default, version/cursor preservation, stale and wrong
actor/version inputs, global-held revoke, reconnect reset, no revoked pending lead
body fetch while service retry continues, immutable metadata-only request, HTTP
Origin/Basic-cookie/API-key/viewer/unknown-field rejection, exact prepared payload,
legacy untracked execution, stale edits/approvals/handling, escaped/expired content,
read-only UI, bounded paging, mismatched evidence fail-closed, old queue routing,
deep-link selection and suppression of obsolete generic next-action controls.

Core lane separately owns and verifies actual typed BIE -> Microsoft dispatch ->
Sent Items -> Inbox -> canonical lead hold/task integration and PostgreSQL races.
The full UI suite does not substitute for those independent-session/provider tests.

## Remaining gates and exclusions

Platform read switch stays off unless deliberately activated by the owner. Azure
first sign-in, application/delegated permission acceptance, exact selected mailbox,
real Sent Items header/immutable-ID/RFC-parent proof, controlled inbound reply,
revocation/reconnect, provider delivery and real contractor acceptance remain open
provider gates. No tokens/accounts/provider settings/hosted schemas/customer data
were accessed or changed in this lane.

This is reviewed individual BIE Microsoft lead email plus existing service-context
tracking. It is not Gmail read, general inbox, direct-compose tracking, shared
mailboxes, attachments, automated replies, old-parent adoption, campaign monitoring,
invoice reply tracking, booking, consent inference or payment processing. L3 invoice
exception/retry work starts only after wave-one verification, under a separate
contract. Payment collection remains deferred.

The email security/reliability skills informed metadata-first access, exact-parent
evidence, retained deduplication identity and explicit human review. Inbox content
cannot supply instructions, authorize another effect or broaden the connector.

Worker checkpoint: this lane's durable handoff is this report and code/tests above.
Shared project/Jarvis state and Git checkpoint remain coordinator-owned; no memory
files, unrelated backup, Git history or hosted resources were changed here.
