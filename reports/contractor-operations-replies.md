# Customer reply handling — private engineering verification

Date: 2026-10-01. Branch: `agent/growthos-contractor-operations`. This report describes local synthetic engineering checks, not a deployed mailbox connection or real customer acceptance.

## Reproduced gap

The first regression used the actual application, isolated database, loopback HTTP, and a synthetic signed intake. A message with exact existing outbound identity returned HTTP 201 but created zero lead-linked `customer_reply` activities. This was reproduced before the repair.

## Implemented boundary

- Incoming email, derived facts, durable reply review, original-time timeline activity, and follow-up changes now commit together. The intake key is source plus external message ID; an immutable fingerprint covers content, forwarding identity, and normalized parent identity. Identical retries return the original result. Changed content/evidence returns 409, including after message deletion.
- Optional `replyTo` identity contains `provider` (`gmail` or `microsoft`), `outboundMessageId`, and the original `senderEmail`. The authenticated normalizer must resolve the parent in that sending mailbox. It must not copy untrusted text, an asserted `verified` flag, an RFC header alone, or a request/client correlation ID. The existing raw-body HMAC boundary and allowed forwarders remain mandatory.
- Automatic linking requires exactly one tenant-owned accepted outbound activity with matching provider, provider message ID, and sending mailbox, plus the expected inbound sender and recipient relationship. A server HMAC proof binds company, opportunity, provider/message ID, sending mailbox, actual outbound recipient, and acceptance time. It uses a domain-separated key derived from the existing email-content key and stores no credential. Generic timeline metadata cannot forge this proof or move it to another job/company. The pure acceptance-evidence helper now retains the actual provider-returned sending mailbox. No Gmail/Microsoft API, scopes, token handling, or provider calls changed. A missing/malformed key does not fail an accepted send; the unsigned evidence requires manual review.
- Missing, ambiguous, legacy, wrong-participant, or unknown/future-time evidence stays visible for staff review. Email address and subject alone never identify a job. Unmatched mail does not change follow-up. Authorized staff can explicitly select one tenant-owned opportunity and provide an audited note; missing original reply time requires an explicit staff-supplied time. A supplied source time cannot be overwritten.
- Original reply time is retained. A reply predating the job, a newer authenticated email send, or a newer active/paused enrollment is historical and does not stop the later workflow. Supersession also checks the server proof; arbitrary timeline notes cannot masquerade as newer sends. BIE uses `occurredAt`, not ingestion-time `createdAt`, for its older-action reply check.
- A current confirmed reply holds that opportunity's outreach, pauses active sequences without consuming a step, cancels older unclaimed scheduled outreach, and blocks older unclaimed proposals. New automated follow-up, sequence enrollment/resume/skip, and BIE effects also honor the hold. Service-request transactional messages keep their existing gates. An opportunity with the same contact remains independent; contact-only outreach requires explicit opportunity context while that contact has a held reply.
- Durable claims, enrollment resume/skip, and reply confirmation share an organization-and-lead transaction lock with fresh state checks. No transaction spans provider I/O. Existing processing or uncertain receipts and their actions stay available for reconciliation; the review reports their count instead of claiming an already dispatched effect was cancelled.
- Resolving a reply records the staff member and note. It does not resurrect cancelled work, resume paused sequences, clear an imported CSV hold, or change company lifecycle state. Raw purge/deletion does not erase durable reply holds or deduplication evidence.

## Staff experience

`Customer replies` is visible in Revenue Desk before advanced BIE controls. It includes attention/history filters, bounded pagination, full selected-opportunity context, links to inspect the job, original timestamp, matching explanation, review note, explicit confirmation, dismissal, and handling of confirmed replies. Read-only members can inspect but cannot mutate. Empty and error states do not imply mailbox connectivity. No raw email body or credentials are returned by the reply listing.

## Contracts and ownership

- New table: `email_response_reviews` / `emailResponseReviewsTable`, in the existing email-intelligence schema export. Parent owns upgrade migration and lifecycle catalog registration.
- `GET /email-intelligence/replies`: `page` integer 0–10000, `scope=attention|all`; result `{items,total,page,pageSize:20}`. The exact safe list projection is `listEmailResponses`.
- `POST /email-intelligence/replies/:id/review`: strict `{decision:'confirm'|'dismiss',leadId?:uuid,note:string(10..1000),replyAt?:ISO datetime with timezone}`.
- `POST /email-intelligence/replies/:id/resolve`: strict `{note:string(10..1000)}`.
- Review/resolve return the durable review row. Permission is `crm.write` plus an active tenant-member check inside the transaction. Mutations require JSON and reject foreign/sibling origins; browser requests use configured `APP_ORIGIN`. Errors: 400 invalid input, 403 unauthorized actor/origin, 404 missing tenant row, 409 conflicting decision, 415 non-JSON. GET is `crm.read`.
- Existing signed public intake accepts optional strict `replyTo`. Response remains `{duplicate,messageId,factCount}`; `messageId` is null when a duplicate references an explicitly deleted message. Parent owns API specification/inventory integration.

## Verification

- Focused actual API tests: `src/routes/v1/email-response-correlation.test.ts` covers signed identity, participant/mailbox/provider mismatch, changed retries, concurrent duplicate intake, staff confirmation, cross-company and viewer denial, old/unknown/future dates, independent opportunities, raw deletion, source/company holds, runtime blocks, and accepted/uncertain receipt preservation.
- Guarded isolated command: `node scripts/test-scheduler-isolated.mjs src/routes/v1/email-response-correlation.test.ts src/services/email-intelligence.test.ts src/services/durable-execution.test.ts src/services/send-source-history.test.ts src/services/playbook-source-hold.test.ts src/services/bie-capabilities.test.ts src/services/scheduled-action-recovery.test.ts src/services/playbooks.test.ts src/services/microsoft-oauth.test.ts src/services/customer-email.test.ts` (from `artifacts/api-server`). Final result: 111 passing, three PostgreSQL concurrency cases skipped only under the PGlite single-session emulator. The normal PostgreSQL CI must execute claim/resume/skip race cases. Added regressions cover generic activity forgery, company/job/time/mailbox/recipient proof tampering, missing-key fallback, unsigned supersession, wrong origin, non-JSON input, and allowed same-origin writes.
- API and command-center type checks passed during implementation. Parent will rerun the integrated gates after all lanes freeze.
- Actual component browser check on loopback port 5192: 10 cases spanning desktop 1440, mobile 390/320, light/dark, review, held, empty, failure, viewer, and missing original time. Seven review/resolve interactions reached only mocked local API responses. Final batch: zero axe violations, horizontal overflow, page errors, or unexpected network calls. One scoped error-text contrast defect was fixed. Mobile light/dark screenshots were visually inspected. Final selected-job full-text and explicit unmatched-follow-up copy were added after that batch and type-checked.
- Impeccable mechanical detector returned `[]`. Artifacts (synthetic only) are in `C:\Forge\artifacts\customer-replies-qa-2026-10-01`. Owned preview stopped; temporary entry files removed. Recordings were disabled.

## Remaining acceptance requirements

No live provider bridge or mailbox subscription was added or tested. GEEKOM retains Microsoft provider work. Until a real trusted normalizer supplies resolved mailbox/message identity, forwarded messages and legacy outbound records without server-authenticated sending evidence require staff review. Key rotation also sends old proof to manual review; this implementation does not retain old signing keys. Provider acknowledgements without an actual stable message ID (including Microsoft accepted-only results) require manual review. No email-only inference fills that gap.

The workflow does not interpret instructions, unsubscribe language, sentiment, calendar changes, or invoice changes from message text. Those require separate deterministic channel/provider handling. A reply that cannot be identified does not safely authorize cancelling any job. A send already dispatched cannot be recalled; its receipt remains authoritative and may require reconciliation.

This wave does not depend on Housecall Pro. Source connections remain optional migration bridges. Hosted deployment, production migration, trusted ingress configuration, real mailbox ownership/delivery evidence, and actual staff acceptance remain separate launch requirements.

## Independent invitation-lane review

Reviewed `staff-invitations.ts`, invitation management in `me.ts`, and password/OIDC adoption in `auth.ts`. Reported and re-reviewed two repaired gaps: same request ID with different email payloads now serializes by company/request before email locking; unverified OIDC claims no longer mark a new or changed mailbox verified, while established same-mailbox verification is preserved. Pending adoption still requires explicit verified email or the matching signed invitation, active invitation/version state, and tenant-bound role/email agreement. No remaining blocking source finding was identified in that scope.

Independent guarded test run: `staff-invitations.test.ts`, `identity-auth.test.ts`, and `invite-token.test.ts` — 16 passing, one real-PostgreSQL request race skipped under PGlite. This is local acceptance of the invitation boundary; it is not an actual provider delivery or OIDC sign-in rehearsal.
