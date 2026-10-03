# Launch communications: integrated engineering evidence

October 2, 2026. Base: green operations main
`c01bea06d5175b1d450462653aca5ed0c6246c60`. Implementation branch:
`agent/growthos-launch-completion-20261002`. This is the first communications
slice of `LAUNCH-COMPLETION.md`, not a claim that launch is finished.

## Contractor-facing result and actual screens

- A tracked Microsoft service reminder can receive a matched original-mailbox
  reply in its existing service record. MAINTAIN brings it to office attention
  and holds further reminders for that occurrence. Warranties & Service →
  Customer care & booking → Review mailbox reply evidence separates the reply,
  actual staff conversation and customer-confirmed booking. No lead is invented.
- My Profile → email accounts → Optional Microsoft reply monitoring requires
  separate exact-mailbox read and retention acknowledgements. Existing send-only
  access is unchanged. The monitor starts forward-only, reads bounded metadata
  and fetches only eligible reply bodies. No attachments, edits or email commands.
- Verification/reset/invitation mail has permanent logical send claims and
  provider receipts. Signed callbacks may arrive before receipts. Duplicate and
  unknown effects do not authorize another send, and delivery never grants access.
- Platform → Account email delivery shows operator evidence. Settings → Team
  shows company invitation evidence; individual launchpad invitations expose
  exact receipts. Refresh is read-only. Acceptance, delivery, bounce/complaint,
  conflict and uncertain outcome remain distinct. No retry button exists.

This path supports **tracked Microsoft service reminders only**. General
lead/Gmail inbox intake, old-parent continuity after reconnection, invoice replies,
shared mailboxes and a unified inbox are not added. L1 stays partly open and L2
needs actual inbox/access acceptance. L3–L11 retain their real engineering and
acceptance work; contractor payment processing remains deferred.

When monitoring is disabled/revoked or a service occurrence is historical, old
evidence stays readable but cannot silently adopt a new connector/service.
Expired/unsupported content and a gap period require original-mailbox inspection;
reconnecting starts now, not a silent backfill. Legacy invitations without durable
send authority return a review-required409 rather than a blind resend.

## Integration, schema and recovery

Eight HTTP operations, OpenAPI clients/validators and route inventories align.
Mailbox polling runs before scheduled sends. Bounded raw-reply retention is a
separate global stage; failures cannot skip later housekeeping or leak mail.

`node scripts/launch-communications-schema-preview.mjs` opens no database. It
compares the actual pinned base schema and generates reviewed
`0009_launch-communications.sql`: six additive tables,39 statements,
**111 → 117 tables**, with exact company/parent/context foreign keys and permanent
logical-send uniqueness. Apply only after reviewed0008. LF-normalized0009 SHA:
`813d3fca929f462644d7399f5314ff4e358f24ff05817f9f7851f290a8ff89ca`.

Inventory v7 classifies111 direct-company,1 indirect and5 explicitly excluded
shared/pre-organization tables. Platform mail is not falsely treated as wholly
tenant-owned. Core export remains20 allowlisted datasets; credentials/cursors/raw
inbound/security metadata are excluded explicitly, not claimed as full portability.

The synthetic drill upgrades90 prior tables through the full delta chain to117,
snapshots/restores both fictional companies, compares all-table fingerprints and
boots the real app with SELECT-only credentials. It checks24 real app reads,
6 new cross-company FK negatives, logical-send collision and reply holds after
content purge. Prior uncertainty, balances, reservations and company holds stay.
Provider calls:0. This is not managed-hosted restore or production RPO/RTO proof.

## Local verification and repaired findings

- Combined communications API selection:155 passed,3 explicit PostgreSQL-only
  cases for real PostgreSQL CI,12 files.
- Shared inventory/router/scheduler:79 passed,4 files. Lifecycle/export/runtime:
  19 passed,1 existing PostgreSQL-only case. These selections overlap other runs.
- All Command Center tests:535 passed,85 files. All scripts:228 passed,18 files.
- Website adapter:26 passed. Full workspace typecheck, both production builds,
  generated OpenAPI validation and whitespace checks pass.
- Independent review found malformed RFC-header metadata could gap a connector.
  A real-adapter regression failed before the repair and now keeps the connector
  active while accepting a following valid reply. Unrelated bodies are not read.
  Actual scheduler/kernel/transport integration makes one synthetic send, without
  mocked business handlers, and creates no invented booking or conversation.
- Recovery caught a synthetic parent's incorrect occurrence snapshot after the
  historical check was strengthened. The fixture now freezes actual database
  dates/customer. The stronger guard remains and the restore passes.
- Built-app loopback QA uses fresh inert data via
  `node artifacts/api-server/scripts/preview-runtime-isolated.mjs --communications`.
  Reply evidence/hold, review prerequisites, disabled read monitoring and account-
  email uncertainty are inspectable. Service controls fit390/320 phone widths
  without document overflow, and keyboard focus reaches review controls.

Do not add overlapping selections into an invented full API total. PGlite has
one backend session; the historical default-playbook nested connection path is
not full independent PostgreSQL proof. No runtime transaction/timeout/skip was
weakened. Exact PR/main CI must pass all tests, types, builds and Docker parity
before release selection. Run identities belong with the PR/check receipts and
coordinator checkpoint; an older green commit does not accept this source.

## Remaining authority and next engineering

Azure first sign-in/account/app inventory remain owner-return work. Hosted
staging upgrade/admin-credential rotation approval is separately pending. Select
the exact final source/schema and re-prove managed backup/restore; the historical
103-table hosted proof does not accept117. No real mailbox was read, message
sent, hosted schema applied, secret changed or outbound hold removed here.

Platform identity mail requires an approved sender and stable nonsecret
`PLATFORM_EMAIL_DELIVERY_CONTEXT`; missing context means no identity send.
Microsoft reading needs its separate callback and approved mailbox/retention
choice. Prove custom-header/RFC association, actual reply and access-mail/token
flows, failure/revocation cases, installed phones and both contractor workdays.

Next: remaining required lead-reply coverage; invoice exceptions/safe reviewed
resend; bounded missed-call, standing service and ongoing nurture policies; then
actual customer-history/migration gaps. Obtain approved export samples before
guessing source mappings. Neither contractor can cancel Housecall Pro on this
engineering slice alone. See the three lane reports beside this document.

Inbox/email skills shaped explicit read consent, untrusted content, permanent
send ownership and delivery evidence. Official Microsoft sources confirm
[sendMail acceptance is not delivery](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0),
[folder delta query semantics](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0),
and [per-request immutable IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id).
Actual tenant behavior still needs the approved live rehearsal.
