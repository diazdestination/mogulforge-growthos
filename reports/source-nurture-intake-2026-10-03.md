# L6 bounded source nurture — mailbox and reply lane

Scope: the frozen `source-nurture-contract-2026-10-03.md` on the shared
`agent/growthos-source-nurture-20261003` branch. This is synthetic local engineering
evidence, not hosted or provider acceptance. No credentials, customer imports,
external messages, provider activation, hosted schema changes or commits were
performed by this lane. Unrelated `pnpm-workspace.yaml.bak` remains untouched.

## Implemented boundary

- Added a separate, default-off, versioned Microsoft nurture-monitoring context.
  Its own accepted staff command is distinct from OAuth Mail.Read, existing BIE
  monitoring, source adoption, address-specific marketing permission and Start.
  Reconnect cannot adopt old authority. The existing mailbox HTTP route enforces
  staff session, tenant, strict input/origin/query and no-store boundaries.
- Added `mailbox_sync_cycles`: exact connector generation, nurture grant,
  monotonic cycle sequence, continuity boundary, both folder completion times,
  and complete/failed state. Readiness requires a fresh complete cycle, no active
  lease/later failure, and no unresolved current-generation receipt. A failed
  round's inherited partial cursor cannot become fresh authority. Completion is
  fenced against grant changes and reconnect; OAuth/Graph I/O stays outside DB
  transactions. Page-level `lastSuccessAt` is not used as completion proof.
- New nurture parent context binds the original plan/review/item/step, exact
  scheduled action, execution fingerprint, content, recipient, mailbox identity
  and separate grant. The org/step/lead/contact composite FK prevents mixing
  contexts. Parent authority is derived from the runtime kernel, never arbitrary
  caller JSON or a fabricated BIE proposal. Dispatch claim is permanent.
- A delayed earlier-step reply stops its original recipient item even after a
  newer sibling. Only an exact observed same-plan parent exempts newer sibling
  evidence; unrelated newer conversations retain their historical boundary.
  Current canonical replies also stop admitted nurture items for the same contact
  atomically, including existing BIE/legacy confirmation on another lead.
- Canonical receipt, hold, cancellation and one office task remain in existing
  lead Messages/Today. Existing staff task status, assignment and deadline remain
  intact. Exact retained-parent office handling works after reader revocation,
  without rearming cancelled work, consent, booking or provider replay. Reply
  content remains encrypted, short-lived, escaped/untrusted evidence; purge does
  not erase permanent identity, hold or ownership.
- Mailbox/reply mutation entry points now take the shared ordered prefix before
  sorted customer-reply locks and domain rows. The approved email-intelligence
  change is a transaction-entry prefix only, not new intake/provider authority.

## Actual integration and independent review

`source-nurture-mailbox.test.ts` runs the real plan, scheduler, Microsoft adapter,
typed parent, Sent/Inbox polling, canonical reply and office projection against
intercepted synthetic responses. Every unrecognized provider URL fails closed.
It covers HTTP 202 acceptance and a lost acknowledgment; actual step two after
72 hours and a fresh complete scan; delayed first reply; unrelated historical
evidence; separate grant revocation during OAuth; content purge/replay/conflict;
retained review after disconnect; staff-task preservation; Today's exact Messages
link versus an event-label-only spoof; and current versus historical legacy
same-contact confirmation.

Independent runtime review found a final-claim race when the approving manager
differs from the selected mailbox/lead owner: existing membership edits do not
take nurture's advisory prefix. Runtime added transaction-only shared locks for
the distinct creator, plan approver, source approver and owner plus organization
entitlement, followed by current-authority revalidation. This lane added:

- A real authenticated `PATCH /api/v1/users/:id` during intercepted OAuth that
  revokes a separate approving manager. Zero provider POST, retained blocked
  original execution, unchanged lead owner, and cancelled sibling are asserted.
- A PostgreSQL-only final-parent barrier. The wrapper first executes the actual
  authority guard and then pauses its transaction after OAuth. Using that same
  reader's backend PID and an independent `pg_stat_activity`/
  `pg_blocking_pids` query, the test proves a real membership HTTP writer waits on
  the claim. `dispatchStartedAt` and POST remain absent before release; after
  commit, the still-authorized edit succeeds, one POST occurs, and replay is
  absent. The wrapper does not replace authority or manufacture a lock.

The analogous direct organization sending-hours writer was reported to runtime
for the same transaction-only settings-row lock. Runtime owns that source change
and its final integration evidence.

## Commands and evidence

```text
pnpm --filter @workspace/api-server run typecheck
```

Passed, exit 0 after the new membership tests.

```text
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/source-nurture-mailbox.test.ts
```

Passed: 8 tests; 1 new PostgreSQL-only writer-barrier test skipped by the local
PGlite runner. This skip is an explicit candidate-CI obligation, not proof that
the row-lock test executed locally.

```text
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/source-nurture-mailbox.test.ts src/services/mailbox-connector.test.ts src/routes/v1/mailbox-integrations.test.ts src/services/mailbox-lead-communication.test.ts src/routes/v1/email-response-correlation.test.ts src/services/mailbox-lead-integration.test.ts src/services/mailbox-service-integration.test.ts src/services/service-standing-mailbox.test.ts
```

Final combined run: 101 passed and 7 PostgreSQL-only skips, eight files passed,
exit 0. Six skips are existing tests; the seventh is the new final-claim
membership-writer barrier. The isolated runner explicitly reports that this
does not imply production or provider acceptance.

`git diff --check` passed for the tracked files owned by this lane.

## Remaining gates and limits

The new independent membership-writer barrier and the runtime's source-slot and
last-contact-allowance races must execute on real PostgreSQL in candidate CI.
PGlite sequential integration does not establish concurrent-writer exclusion.
Root owns exact-head CI, reviewed additive SQL, recovery inventory, browser proof
and launch documentation. Readiness is a bounded observed mailbox check, never
certainty that no reply exists anywhere. Unknown original sends remain owned and
cannot progress merely because an operator attested success. Already-dispatched
requests cannot be recalled. Gmail nurture, SMS marketing and arbitrary rolling
campaigns are outside this slice. Azure sign-in, hosted restore/schema acceptance,
approved real send/read identities, devices and contractor replacement-day gates
remain separate.
