# Tracked Microsoft lead replies — kernel evidence

Date: October 2, 2026. Branch: `agent/growthos-lead-replies-20261002`.
Scope is the first wave in `lead-replies-contract-2026-10-02.md`, based on
green main c2d999b. This is local, synthetic implementation evidence, not a
provider activation, deployment, customer message or contractor cutover claim.

## Implemented path

Explicitly prepared and reviewed BIE native-lead email -> permanent one-time
outbound parent -> selected Microsoft sender -> exact original Sent Items
observation -> exact Inbox reply -> existing lead follow-up hold -> accountable
office task -> versioned staff handling. Neither sending nor receiving creates a
new acquisition lead, customer decision, consent record or appointment.

The companion reviewed-send lane owns BIE preparation and post-OAuth guards;
the connector/UI lane owns separate lead-context opt-in, bounded mailbox reading
and the lead Messages panel. This report covers the reply kernel and their
actual synthetic integration, not isolated mocks substituted for that integration.

### Canonical records and authority

- `lib/db/src/schema/mailbox-communication.ts`: reuses immutable communication
  parents with a discriminated native-lead snapshot. Existing service snapshots
  remain compatible. The lead snapshot freezes the lead/contact creation/update
  versions, original mailbox identity, BIE proposal, and separate lead-monitoring
  approval. Recipient/content hashes and original execution fingerprint remain
  on the parent. A post-dispatch claim never becomes available for another send.
- `lib/db/src/schema/email-intelligence.ts`: extends existing
  `email_response_reviews` instead of adding a parallel lead inbox. The provenance
  check allows either an existing legacy source or exact typed mailbox provenance,
  never both. A composite parent FK binds company/parent/lead/contact/connector;
  connector and office task references are also company-scoped. The approved
  narrow task parent unique lives in `lib/db/src/schema/crm-tasks.ts`.
- `artifacts/api-server/src/services/mailbox-communication.ts` exports
  `leadReplySendSnapshotSchema`, `reserveLeadMailboxParent`, metadata-only
  `isMailboxReplyCandidate`, exact sent binding/intake, retained reply listing,
  versioned handling and `purgeExpiredLeadReplyContent`.
- Parent reservation reads the saved approved BIE payload and checks its displayed
  recipient/sender/lead snapshot against the delivery snapshot and original
  processing receipt. The final claim checks current actor/grant/lead/approval
  and the exact permanent receipt. Caller-supplied correlation text is not proof.
- The authenticated adapter must observe the frozen server header in the original
  Sent Items mailbox, then observe the actual RFC parent identity and participants
  in Inbox. A Microsoft request ID or `sendMail` 202 is not that identity.
- New lead body capture requires the original connector and exact current lead
  acknowledgement before fetching content and again during intake. Revocation
  and re-enabling never adopt an old lead parent. Service-only grants are not
  broadened; unrelated or malformed metadata does not become a lead reply.

### One transaction for evidence and work

`artifacts/api-server/src/services/response-correlation.ts` reuses the existing
follow-up hold/effect implementation. Typed evidence creates one task per exact
provider reply receipt, assigned to the current accepted, authorized lead owner,
or visibly unassigned when no such owner exists. Duplicate intake retains one
receipt, one activity and one task. It does not erase claimed or uncertain work.

Pending unclaimed follow-ups are cancelled, applicable enrollments are paused,
and unclaimed BIE proposals are blocked. A claimed/indeterminate execution remains
reserved and is reported as requiring reconciliation. A newer observed typed send
also makes a delayed earlier reply historical, even when the newer POST's
acknowledgement was unknown. Historical evidence creates no current hold/task;
its timeline event retains the original customer, not a reassociated customer.

### Retention and handling

- Encrypted, bounded plain text is retained for seven days from intake. It is
  untrusted evidence, never instructions or automatic interpretation. Expired or
  unreadable text is withheld immediately; explicit bounded housekeeping purges
  ciphertext later. Hash, identity, hold, task and review receipts survive purge.
- GET `/api/v1/leads/:id/mailbox-replies` is SELECT-only, authenticated,
  accepted-staff, company-scoped and `no-store`. It returns 25 items per page with
  `hasMore`, historical/active-hold state, task owner/status, and informational
  `monitoringCurrent`. It does not refresh a watch case or renew a mailbox grant.
- POST `/api/v1/leads/:id/mailbox-replies/:replyId/review` requires a current
  accepted `crm.write` session, exact version, request UUID, explicit handled
  decision and office note. API keys, cross-site/non-JSON requests, extra authority
  fields and stale/changed replay are rejected. Its router is
  `artifacts/api-server/src/routes/v1/lead-mailbox-replies.ts`.
- Deliberate authorized policy: already-observed company evidence can be handled
  after the original reader is disconnected. Handling verifies the frozen exact
  parent/lead/contact and task, active company and current staff authority, without
  accessing the mailbox. Original reader permission is still required for any new
  capture or tracked send. This avoids orphaning existing office work.
- Handling releases only that reply's hold and completes only its exact task
  (`done`). It preserves other holds and uncertain receipts and never resumes
  cancelled work. Legacy reply review/resolve rejects typed records so it cannot
  bypass the versioned decision. A changed task context fails closed.

## Local verification

All API checks used the existing disposable `test-scheduler-isolated.mjs` runner:
fresh loopback PGlite, synthetic data, no external database/provider credentials.
No full local API suite or hosted schema operation was run by this lane.

1. Final focused lead run: **31 passed, 2 skipped**, exit 0, three files:
   - `services/mailbox-lead-communication.test.ts`: 23 passed; two independent
     PostgreSQL-only races await exact CI (duplicate arrival and stale reviews).
   - `services/mailbox-lead-integration.test.ts`: two passed, no module mocks.
   - `routes/v1/lead-mailbox-replies.test.ts`: six passed through the real app.
2. Combined lead/service compatibility run: **60 passed, 3 skipped**, exit 0,
   six files. This preceded adding the second lead integration variant; it
   includes existing service kernel, actual scheduler-to-reader integration and
   service HTTP tests. The later lead-only run verifies both current variants.
3. Existing correlation/intelligence/needs-reply checks: **38 passed, 3 skipped**,
   exit 0 (`email-response-correlation`, `email-intelligence`,
   `lead-needs-reply-filter`). Skips are the existing independent PostgreSQL cases.
4. `pnpm --filter @workspace/api-server exec tsc --noEmit`: exit 0 after current
   schema declarations and all new test sources were present.

The actual integration covers reviewed BIE preparation and approval, Microsoft
transport dispatch with the one frozen header, Sent Items identity observation,
metadata-only candidate filtering, exact body fetch, duplicate delivery, one held
native lead/task, no appointment, and handling after reader disconnection. Both
accepted and acknowledgement-lost POST variants pass. The latter keeps its
durable execution `indeterminate` and never POSTs again, even after handling.

Test corrections made during the lane: an HTTP test initially used the wrong
legacy route name (`responses` instead of the actual `replies`), and a test's
scheduled work timestamp was made explicit to precede the simulated reply rather
than relying on database sub-millisecond timing. No production guard was weakened.

Independent read-only cross-review by the reviewed-send lane found no concrete
kernel blocker. This lane's read-only review of BIE/automatic/playbook final
dispatch guards likewise found no concrete blocker. PostgreSQL concurrency,
coordinated full release checks and exact-head CI remain coordinator acceptance.

## Deliberate remaining limits

Only newly prepared, explicitly tracked BIE native-lead emails use this lead
parent path. Existing approved messages, direct compose, general Inbox, Gmail
reading, bulk/source-campaign parent creation, invoice replies, shared mailboxes,
attachments, old-parent adoption, automatic reply generation and inferred bookings
remain excluded. Existing untracked workflows are not labelled tracked.

Microsoft/Azure first-login and live consent/recipient/provider proof remain
separate user/provider gates. This slice does not claim guaranteed delivery,
complete L1 general mailbox support, full Housecall Pro replacement acceptance,
the next invoice wave, either company's onboarding, or production release.
