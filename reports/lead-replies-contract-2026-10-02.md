# Wave one: tracked Microsoft lead replies

Owner authorized two consecutive launch waves on October 2, 2026. Base is green
main c2d999b0c32e349e3f70cf6c642782d1c603b582, PR16, CI37085822984. Work branch:
`agent/growthos-lead-replies-20261002`. This wave advances L1, with L3 invoice
exceptions/reviewed safe retry next. Neither is live activation or full launch.

## Outcome and invariants

Reviewed BIE lead email -> exact immutable original-mailbox outbound parent ->
bounded Microsoft reply intake -> existing canonical lead hold -> one accountable
office task and explicit evidence review. No parallel inbox, fabricated source,
customer, acquisition lead, consent, booking, or reply instruction execution.

- Extend the existing email_response_reviews store with typed mailbox provenance;
  preserve legacy source reviews and service-reply behavior.
- Freeze the exact displayed recipient, selected sender/mailbox and content before
  approval. Do not append undisplayed metadata during approval or adopt older
  approved sends. Permanent BIE action ownership cannot be reset to enable tracking.
- Keep selected send-only access unchanged. Lead monitoring requires a separate
  explicit context acknowledgement; existing service-only grants are not broadened
  silently. Preserve service parent identity/continuity; no fresh mailbox crawl.
- Exact parent, tenant, participants, original connector identity and timestamps
  are mandatory. Delayed historical replies must not stop a newer conversation.
- Save receipt, hold, pause/cancel effects and deduplicated office task atomically.
  Preserve all claimed/uncertain external effects; processing is never retried by
  inventing a new action key. Staff handling does not restart cancelled sequences.
- Recheck current actor, company, source, contact/recipient, policy, suppression,
  reply hold and execution ownership after OAuth, immediately before provider POST.
  No claim that already-dispatched work can be recalled.
- Content is escaped encrypted short-lived evidence, never agent authority. Raw
  purge must not erase hold/deduplication evidence. Reads stay SELECT-only.
- Reader revocation/reconnection stops new capture and dispatch under that old
  grant. It does not orphan already-observed work: current accepted staff may
  explicitly handle retained exact-parent evidence with a versioned office note.
  This neither accesses the mailbox nor resumes canceled work or unknown sends.
- No provider/hosted/schema/secret/DNS/spend/customer operations. Payment collection
  stays deferred; both full contractor replacement cards remain required.

## Coordinated ownership

1. Lead reply kernel: schema email-intelligence/mailbox-communication, typed parent
   reservation/binding/ingestion, response-correlation, lead reply read/review routes,
   retention helper, focused HTTP/kernel/real-handler integration tests.
2. Reviewed send boundary: BIE prepare/review/execute and route, draft-edit snapshot
   invalidation where needed, automated email/playbook final guards, focused tests.
3. Connector and UI: explicit lead-context acknowledgement preserving connector
   identity, own-mailbox routes/contracts, connection/reply/BIE review UI and tests.
4. Coordinator: shared router/OpenAPI/generated clients, scheduler retention,
   inventory/export, offline schema/recovery, isolated browser fixture, full release
   checks, documentation and integration. Agents do not commit shared partial work.

Agree function/DTO seams before writing overlapping files. Each lane reports
specific evidence; no broad formatter or shared schema push while others work.
Keep unrelated pnpm-workspace.yaml.bak untouched. Use the provider-free isolated
runner only for local tests; full PostgreSQL concurrency belongs to exact CI.

## Exclusions and acceptance

General Inbox, Gmail read, direct-compose tracking, bulk campaign parent creation,
invoice replies, shared mailboxes, attachments, old-parent adoption after reconnect,
automatic email replies, bookings and new nurture policies remain outside this
wave. Older supported paths must not be silently labelled tracked.

Require actual BIE -> selected transport -> Sent Items -> Inbox -> canonical lead
integration, hostile tenant/identity/concurrency/late-reply tests, exact UI review,
fresh compatible synthetic restore, full types/builds and exact PR/main CI.
Provider/device/contractor acceptance remains separately gated and unfinished.
