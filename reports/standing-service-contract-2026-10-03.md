# Standing service reminders — L5 engineering contract

October 3, 2026. Owner-requested next wave from PR19/main
f91e1c31413a4b5307ca334c04773e3c0e5bef84; exact-main CI37134529680 passed.
Branch: agent/growthos-standing-service-20261003. This is implementation authority,
not live sending, provider configuration, hosted schema or customer cutover approval.

## Customer outcome and limits

The office can review one exact existing agreed service series and authorize
one fixed expected-service reminder per future eligible occurrence. Default is
off. Agreement validity is explicit and distinct from manufacturer warranty
coverage; no inferred warranty terms or service purchases. Completion still
creates exactly one agreed successor; customer response and confirmed booking
remain separate human actions. No catch-up sweep: occurrence notice time must
be on or after policy approval. Older work keeps individual office review.

## Canonical authority

Two normalized tables: service_standing_enrollments identifies the immutable
series root and reviewed anchor with same-company references and bounded monitor
state; service_standing_policy_revisions retains immutable reviewed decisions.
Latest revision under the shared lock is authority; no mutable enabled pointer.
Unique organization/series root prevents competing enrollment. Prove exact
predecessor lineage and recurrence fingerprint; labels or matching phones are
not series identity. Changed recurrence, source, customer/property/equipment,
notice, owner, recipient, business/copy, sender connection or sending policy
requires fresh review. Source review is typed native or reconciled import with
original source/cutover evidence; unrelated imported-opportunity and reply holds
remain enforced. This is not marketing adoption or SMS consent.

The enrollment's original anchor never moves. Each immutable revision also pins
its exact reviewed occurrence, version and index as a forward cutoff. Reviewing
a later successor cannot enroll an older occurrence. Completing an ancestor
does not invalidate its unchanged descendants merely by changing the ancestor's
status/timestamp; canonical descendant scope and recurrence are still rechecked.

Accepted active owner/admin sessions review and approve; API keys cannot attest.
Strict JSON/origin guards, exact versions and persisted ten-minute actor/company
preview evidence are required. The server supplies canonical identities, fixed
template and sender binding; clients cannot substitute them. Disable is explicit,
versioned and audited, works without provider readiness, retains all history and
cannot recall accepted work or free an uncertain-send reservation.

## Runtime and ownership

Both individual and standing reminders converge on the existing canonical
service.care_reminder_approved audit and its original service_care_reminder
scheduled action. Typed origin is individual or standing; absent legacy origin
means individual, never standing. Standing proof binds revision, anchor, policy
and series/source fingerprints, admission and finite expiry. Separate automatic
admission evidence never claims a human approved each occurrence individually.
One occurrence owns one reminder across policies and channels forever.

Recheck persisted authority before admission, claim and actual provider POST,
including after OAuth preparation. Stop for changed/revoked authority, expiry,
inactive or booked/completed service, replies, recipient/sender/consent changes,
missing/inactive responsible staff, company/provider holds and timing limits.
Standing send expiry is no later than occurrence due time/agreement end.
Pending and unknown claims count in per-contact caps under the same durable
claim transaction; queued future work is not a completed touch. Existing shared
Twilio budget remains authoritative. Never retry ambiguous external effects by
creating another key, policy, channel, occurrence clone or process restart.

Lock order: lifecycle then contractor scheduling then policy/row locks. Never
await another pooled connection from a locked transaction. Reader-aware
SELECT-only authority and sender projections; no lazy settings initialization
in reads. Provider network/OAuth outside transactions. Bounded independently
rotating due selection prevents one blocked company/series starving others.

## Inbound replies and office experience

Signed Twilio source does not establish customer identity, consent or booking.
Preserve STOP/START/HELP priority and existing suppression. Reserve immutable
service SMS parent evidence before POST, with original approval/action/sender/
recipient identities. Correlation must use exact retained service evidence;
ambiguous or historical replies cannot guess a current service or booking.
Retain office evidence and conservative holds, not an AI/tool-executable command.
An explicit versioned office disposition can retain the reply hold, dismiss
unrelated evidence, or mark actual office handling complete and release only
that service reply hold. Handled phone-scope evidence can unblock separately
authorized future work; it never grants consent or frees an original send claim.
Microsoft parent reservation accepts the typed persisted authorization without
pretending a standing admission is a new individual staff approval.

Use existing /service → Customer care & booking and MAINTAIN watch. Separate
policy approval, occurrence eligibility, queued/accepted/unknown effect and
reply review. Show source/agreement, owner, channel/recipient/sender, fixed copy,
forward-only boundary, expiry and actionable holds. Review of a reply does not
automatically mark ready-to-book, grant consent or rearm a reminder. Preserve
drafts on unchanged profile refresh; fail closed on profile errors and reset on
actual member/company/role/access changes. Paginated evidence is not a global count.

## Team ownership

- Runtime: new standing schema/service/contracts/routes/tests, service-care and
  its policy, automation admission stage and atomic service pending-cap hook.
- Intake: service SMS parent/reply schema/service/routes/tests, signed Twilio
  hook, Microsoft typed-parent compatibility and service-watch reply integration.
- Experience: Service Desk and care/watch/editor components, new standing/SMS
  evidence subpanels and their tests; coordinate exact DTOs with service owners.
- Coordinator: shared schema/router exports and route authorization inventory,
  OpenAPI/generated clients, lifecycle/export classification, reviewed additive
  0013 delta, synthetic upgrade/restore and read-only probes, built-browser QA,
  integration review, source release/CI and durable operator documentation.

Do not edit another lane's files without coordination. No test weakening,
provider credentials/customer data, or shared local database use for fixtures.

## Acceptance

Cover actor/tenant/API-key/version/expiry, unchanged refresh and stale UI races;
future exact lineage only, agreement/source/owner/sender edits, DST/month-end,
quiet hours and finite expiry; individual-v-standing/two-worker races and
pending budgets; reply/booking/revocation between claim and POST; permanent
unknown ownership after timeouts/crashes/storage faults; signed ambiguous/old
SMS and tracked Microsoft replies; real-code reminder→reply/hold→confirmed
visit→completion→one successor; monitor fairness and retained staff plans.
Run focused isolated tests, full UI/scripts/types/builds, reviewed synthetic
schema/restore with tenant-negative and SELECT-only app probes, built desktop/
phone-width QA, exact candidate PostgreSQL CI then separately dispatched main
CI. Local PGlite does not replace independent-session PostgreSQL checks.

Hosted recovery/staging, actual Gmail/Microsoft/Twilio acceptance, physical phone
notifications, approved source migration and each contractor's complete workday
and replacement card remain separate gates. Azure first sign-in remains owner-
deferred. Contractor payment collection remains deferred. No third cluster,
real messages, deployment or cancellation of the prior system is included.
