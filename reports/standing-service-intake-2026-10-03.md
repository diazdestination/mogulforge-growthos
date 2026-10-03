# Standing service reminders: intake lane

October 3, 2026. Branch `agent/growthos-standing-service-20261003`.
Scope: `reports/standing-service-contract-2026-10-03.md`. Source implementation
and synthetic local verification only; no provider, production, hosted schema,
real-message, account or customer activation occurred in this lane.

## Implemented

- `service_sms_parents` freezes the original service occurrence, canonical
  approval/action, exact execution receipt, company binding, recipient, sender,
  program, versioned reference and exact generic Twilio dispatch before POST.
  Composite foreign keys prevent cross-company or mixed receipt/parent links.
- New SMS copy has a non-secret `SERVICE <reference>` routing reference. Signed
  account/shop/handset/reference evidence can match only the retained original
  dispatch-started parent. A reference is not identity, consent or booking.
- Natural or invalid-reference replies with retained service context create
  explicitly ambiguous phone-scoped service holds. No latest/only-service
  guessing. Unknown/no-parent handsets stay in existing generic SMS intake.
- STOP/START/HELP preserve priority; START does not grant purpose consent or
  release a service hold. CALLIE one-call grants remain separate.
- Staff session-only read/review routes expose bounded exact or ambiguous
  evidence. `office_follow_up` retains the hold. `not_service_reply` dismisses
  it. Explicit `handled` releases only this reply's hold; other reply/STOP
  holds and permanently owned unknown effects remain. An ambiguous hold's
  release may allow separately approved future reminders, never rearm the
  original occurrence or create consent, a response attestation or a booking.
- Raw SMS reply text uses the existing tenant/message-bound authenticated
  encryption codec, seven-day visibility/retention, and a bounded purge.
  New-message readiness checks encryption before preview/reserve/dispatch;
  previously approved legacy SMS retains its exact old copy and behavior.
- Microsoft service-parent context has a nested authorization origin and
  fingerprint loaded from persisted canonical approval. Reservation and final
  dispatch check current standing authority, including after OAuth. Original
  sent-message observation and replies survive policy disable without granting
  a new send or claiming that each occurrence had individual human approval.
- MAINTAIN uses the existing `reply_received_review` reason. Intake does not
  reopen completed tasks or overwrite assignments, progress or office plans.

## Provider contract decision

Twilio's incoming-message documentation describes associated Messaging Service
metadata; number-level incoming hooks are supported. Missing
`MessagingServiceSid` therefore remains absent in the receipt and is not made a
universal requirement. Exact reference correlation still requires the current
company binding's program to equal the immutable parent program. A supplied
different SID fails existing signature-envelope validation; a changed bound
program prevents exact correlation. This records channel evidence, not invented
signed program proof.

New service SMS explicitly supplies both `From` and `MessagingServiceSid`, which
Twilio documents for selecting one sender from a Messaging Service pool.

Official references checked read-only:

- https://www.twilio.com/docs/messaging/guides/webhook-request
- https://www.twilio.com/docs/messaging/services
- https://www.twilio.com/docs/messaging/api/message-resource

## Verification

`pnpm --filter @workspace/api-server typecheck` passed after lane integration.
Owned-file `git diff --check` passed. These disposable checks do not use a shared
database or read local provider credentials; every provider transport is mocked
and rejects unknown URLs.

Final focused command:

```text
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/service-sms.test.ts src/services/service-standing-mailbox.test.ts src/services/service-care.test.ts src/services/service-standing.test.ts
```

Result: **73 passed / 4 PostgreSQL-only skips**. Intake-owned new coverage is
**20 SMS tests + 3 standing Microsoft integration tests, all passed, no skips**.
The skip count belongs to the existing service-care and independent-session
standing runtime tests; exact-candidate PostgreSQL CI remains a separate gate.

Earlier broader run (before the two final storage/legacy-compatibility cases):

```text
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/service-sms.test.ts src/services/mailbox-communication.test.ts src/services/service-care.test.ts src/services/twilio-dispatch-guard.test.ts src/routes/v1/twilio.test.ts src/services/callie-runtime.test.ts src/services/service-watch.test.ts
```

Result: **143 passed / 7 PostgreSQL-only skips**.

Additional ingress/mailbox regression command:

```text
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/routes/v1/callie-intake.test.ts src/services/missed-call-care.test.ts src/services/mailbox-service-integration.test.ts src/services/mailbox-microsoft-dispatch.test.ts src/services/mailbox-lead-communication.test.ts src/routes/v1/service-mailbox-replies.test.ts src/routes/v1/lead-mailbox-replies.test.ts
```

Result: **105 passed / 5 PostgreSQL-only skips**.

Coverage includes actual reminder -> signed reply -> explicit staff response and
booking -> completion -> exactly one agreed successor; absent/mismatched program
metadata; multiple phone candidates; wrong tenant/handset/shop; signature and
changed replay rejection; encrypted-content purge; exact and ambiguous review;
remaining STOP/reply holds; permanent unknown effect ownership; pre-POST reply
hold; no retrofitting of legacy copy; Microsoft standing acceptance and unknown
outcomes; tracked replies after policy disable; and revocation during OAuth
preparation with zero sendMail POSTs.

## Independent review and authorized follow-up

The independent runtime review found a monitor checkpoint race: a completed
older `future_notice` check could overwrite a concurrent policy approval's
immediate `nextCheckAt` with its former distant notice date. The runtime owner
received the exact source location and a head-version/checkpoint-CAS regression
scenario. Its remediation and independent-session acceptance belong to that
lane; this report does not claim them complete.

The review also found that existing Microsoft service reply intake replaced the
office task's description and deadline and reopened it, even when staff had
already completed it. With coordinator approval, removed that mutation from
`mailbox-communication.ts`. Retained reply evidence and MAINTAIN's review hold
provide the office work without changing any staff-owned task field. Added two
real-code standing Microsoft send-to-reply cases for `in_progress` and `done`,
including duplicate replay, and strengthened the existing individual-service
test to require an unchanged complete task row instead of a replacement note.

Post-review regression command:

```text
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/service-standing-mailbox.test.ts src/services/mailbox-communication.test.ts src/services/mailbox-service-integration.test.ts src/services/mailbox-microsoft-dispatch.test.ts src/services/mailbox-lead-communication.test.ts src/services/service-care.test.ts src/services/service-watch.test.ts src/routes/v1/service-mailbox-replies.test.ts src/routes/v1/lead-mailbox-replies.test.ts
```

Result: **115 passed / 5 PostgreSQL-only skips**, nine suites passed. The standing
Microsoft file now has **5 passing cases, no skips**. API typecheck and owned-file
diff whitespace check also passed after this fix.

Read-only inspection found no pooled-connection reentry in the scoped standing
admission/authority/claim path: transaction readers are propagated, timing is
passed an already-projected settings value, and provider preparation is outside
the transaction. The atomic service claim includes pending/unknown reservations
and excludes its own receipt; an already-owned or uncertain receipt is never
reacquired for another effect. These are source-review findings plus the local
tests above, not independent-session PostgreSQL proof. Runtime was also notified
that generic task edits do not take the schedule lock, so the final transactional
authority read should lock the task row to serialize an assignment/completion
change before its dispatch claim; SELECT-only projections must stay read-only.

## Remaining boundaries

Coordinator owns source release, consolidated state/checkpoint, reviewed schema
delta, browser QA, independent PostgreSQL CI and exact-main CI. Hosted recovery,
live provider acceptance, physical phone notification and real contractor
walkthroughs remain separately authorized gates. No commitments about delivery
or production activation follow from these local results.

Once a provider dispatch has been claimed, a later reply cannot recall an
already-started external request. It creates retained evidence/holds and never
frees the original uncertain execution or dispatch for a retry.
