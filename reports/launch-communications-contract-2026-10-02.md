# Launch completion: communications contract

Base main c01bea06d5175b1d450462653aca5ed0c6246c60; branch
agent/growthos-launch-completion-20261002. Owner approved closing the documented
finish-line gaps; this bounded slice implements the first Microsoft-service
portion of L1 and the platform delivery-ledger portion of L2 in
LAUNCH-COMPLETION.md. General lead/Gmail intake and actual provider acceptance
remain open. Other IDs remain visible, not silently waived.

## Independent implementation ownership

1. Typed service replies: exact immutable outbound parent, original mailbox
   association, service-occurrence response review/hold and existing office UI.
2. Microsoft connector: separately opted-in read-only scope, bounded mailbox
   delta state/lease/receipt, Sent Items association and reply intake; connection
   health and revocation/gap behavior. Existing Mail.Send stays send-only.
3. Platform identity mail: logical-event claim and receipt, exact signed callback
   reconciliation, account/invitation status, unchanged token authority.
4. Coordinator: schema exports/review, router/generated contracts, scheduler,
   lifecycle/export/recovery, integrated tests/docs and release evidence.

Do not overlap owned files without agreement. No agent commits shared partial
work. Preserve pnpm-workspace.yaml.bak and all unrelated changes.

## Invariants

- Incoming content, header strings and sender addresses confer no authority.
  Only an authenticated configured mailbox/source plus exact original outbound
  evidence may associate a reply; review never means booking or consent.
- Bind company, mailbox identity/connection revision, recipient, immutable
  parent and exact service occurrence. Historical replies do not hold a new
  occurrence. Existing customers never need a fake acquisition lead.
- Microsoft acceptance without a message ID remains acceptance only. Persist a
  random server-owned correlation header before POST; associate only an exact
  authenticated Sent Items observation. Never use a request ID or send again
  merely to obtain an identity. API IDs and RFC Message-IDs are different fields.
- Read permission is a separate explicit opt-in, not silently added to existing
  send-only consent. No arbitrary delta URL fetching, historical unbounded crawl,
  remote attachments, source alias replay or cross-company mailbox fallback.
- Platform logical send identity is stable token-record/purpose or invitation/
  revision, not a new request UUID. Persist claims before effects; no raw token,
  reset link, body or secret in ledger/logs. Unknown outcomes stay non-retryable.
- Signed delivery callbacks require exact provider context/message/recipient.
  Delivery does not verify an account, consume a token, accept an invitation,
  create a session or reverse revocation. Public endpoints retain enumeration
  resistance. Provider acceptance/delivery/read are distinct.
- Existing selected-sender and post-credential final guards, company holds,
  permanent effect ownership, consent, retention and tenant boundaries remain.

## Evidence required

Focused synthetic tests, real PostgreSQL concurrency gate, full workspace types,
UI/API builds and Docker parity on the exact candidate; desktop/mobile synthetic
browser checks; additive reviewed schema and compatible local recovery fixtures.
Then separately approved hosted/provider/device/customer proof. No mock or local
schema exercise establishes Azure connection, live inbox receipt or launch.

The local PGlite bridge is not independent-session PostgreSQL. Do not relax tests
or change historical pinned attestation blobs to get a green result.
