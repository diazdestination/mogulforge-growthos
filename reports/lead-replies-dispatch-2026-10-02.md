# Wave one: exact reviewed email and final dispatch controls

Local engineering handoff for `agent/growthos-lead-replies-20261002`, based on
green main `c2d999b0c32e349e3f70cf6c642782d1c603b582`. This report covers the
reviewed-send lane; the original-mailbox kernel, connector/UI and release evidence
have separate owners. It is not a live-provider or production acceptance claim.

## Delivered contract

- `POST /api/v1/bie/actions/:id/prepare-email` accepts only `{ expectedPayload }`.
  It persists the exact displayed recipient, selected provider/mailbox, preparing
  staff member, lead/contact identity and current lead timestamps. It sends
  nothing and leaves the proposal `proposed`. The response is not cached.
- An independently enabled Microsoft lead-monitoring acknowledgement adds a
  strictly typed, immutable `deliverySnapshot` before review. Service-only read
  permission does not silently enable lead monitoring. Prepare/approve never
  changes the mailbox permission. A new grant does not adopt an older email.
- New email approval compares the entire prepared saved payload, and rechecks
  the preparing sender, lead/contact/source and optional original-mailbox grant.
  A strict subject/body edit replaces the payload, removing both review fields.
  A changed email must be prepared and reviewed again.
- Email prepare/approve/reject/execute require a current accepted human staff
  session. Valid API keys, unverified accounts, invite pseudo-users and foreign
  origins cannot substitute for this review. Other proposal action types retain
  their existing behavior. Another staff member cannot consume the prepared
  sender's permanent execution slot.
- Existing already-approved email without the new fields remains **untracked**.
  It gains current dispatch checks, but never acquires an undisplayed parent.

## Actual provider boundary

`bie:<proposalId>` remains the durable logical effect key. The callback checks
current proposal payload, reviewer/sender, receipt actor/fingerprint/state/expiry,
lead/contact and target email, source provenance, current reply/activity and
appointments, suppression/send eligibility, company/outbound holds, current
autopilot policy/entitlement where applicable, and BIE daily cap.

Tracked native BIE email reserves the kernel's exact parent only from its saved
approved snapshot. The existing Microsoft adapter refreshes OAuth and validates
the original account, then runs the complete current guard. It claims the parent
once and runs the guard again before the provider POST. A request ID is not a
message ID; provider acceptance remains distinct from delivery and original Sent
Items observation.

Legacy automated email also passes a final callback through the existing
CustomerEmail/UserEmail transport. It checks current scheduled action and fixed
receipt, cancellation, rule policy, exact current template/recipient, canonical
lead/contact, current source/reply/eligibility and company hold. Appointment email
also checks the same booking, start/end, active status, contact and reminder
settings. A late deferral/hold does not invent another scheduled-action key.

Playbooks freeze the selected mailbox and check the exact claimed enrollment
state/current step (including the already-completed final step), lead/contact,
assignment, source, current definition/stage policy, sender, reply hold and send
eligibility after OAuth. A known final guard refusal retains the consumed step
and pauses remaining work for review; it never rewinds the step to retry it.

Known final guard refusals record a blocked/no-dispatch outcome. Other provider
errors, lost receipt writes or ambiguous effects remain indeterminate. These
changes neither recall already-dispatched messages nor automatically retry them.

A separate `lead-reply-retention` scheduler stage invokes the bounded lead raw
content purge. Service retention remains its own independently isolated stage.

## Local evidence

All database tests used the inspected provider-scrubbed disposable runner with a
fresh loopback PGlite instance. New end-to-end send tests use the actual
Microsoft adapter and stub **only** its network boundary. No live provider call,
customer message, credential operation, schema activation or hosting operation
was performed.

- `bie-reviewed-email.test.ts`: 25 passed. Exact prepare/approve/send and one
  permanent parent; untracked old approvals; role/tenant/import denial; changed
  approval; sender-slot ownership; post-OAuth recipient, opt-out, source, reply,
  company, actor, acknowledgement, expired-claim and payload changes; permanent
  unknown-effect/no-replay behavior.
- `automated-email-final-guard.test.ts`: 23 passed. Real transport positive paths
  and late scheduled/rule/playbook/appointment changes produce zero provider POST;
  fixed claimed work does not get a replacement key or replay.
- `bie-email-review.test.ts`: 6 passed. Actual HTTP prepare/edit/approve/execute,
  exact displayed sender/recipient, edit invalidation, valid API-key refusal,
  cookie plus bogus Authorization/foreign origin refusal, role/tenant/schema
  rejection and once-only execution.
- Existing `bie-email-provider.test.ts`: 3 passed. Historical approved emails
  remain untracked and ambiguous acceptance remains indeterminate.
- Existing `playbook-source-hold.test.ts`: 8 passed; source holds unchanged.
- Existing `scheduler-stage-isolation.test.ts`: 11 passed, including independent
  lead retention. Shared stage definition/tests are coordinator-owned.
- The two changed legacy email cases in `revenue-workspace.test.ts` passed in an
  explicit test-name filtered run. The 9 unrelated cases were not selected in
  that filtered run, not newly disabled in source.
- API `tsc --noEmit` passed. Peer read-only dispatch review found no new blocker;
  this lane independently reviewed the lead kernel/response-correlation and found
  no concrete new blocker in its reviewed scope.

Reproduce the focused group from the repository root:

```text
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/bie-reviewed-email.test.ts src/services/automated-email-final-guard.test.ts src/services/bie-email-provider.test.ts src/routes/v1/bie-email-review.test.ts src/services/playbook-source-hold.test.ts src/services/scheduler-stage-isolation.test.ts
pnpm --filter @workspace/api-server exec tsc -p tsconfig.json --noEmit
```

### Explicit local limitations

The broader existing Revenue Workspace run had 10 passing cases, while its
unchanged five-way concurrent BIE task test hit PGlite socket protocol `08P01`
(`bind supplies 1 parameters, prepared statement requires 2`). The existing BIE
proposal-generation test also blocks on its pre-existing global-db-inside-
transaction path under single-session PGlite; the owned runner and its verified
descendants were stopped. No production logic, timeout or concurrency assertion
was weakened to hide these results. Exact PostgreSQL CI remains required.

The legacy playbook fixture status mocks now include actual provider/mailbox
fields, as the production guard requires. Their broader suites still require
the coordinator's full PostgreSQL run. No claim of full release readiness is
made from this focused evidence.

## Boundaries and next action

This wave does not add a general inbox, Gmail read, shared mailbox support,
direct-compose/campaign/invoice reply tracking, attachments, automatic replies,
customer consent, booking or new nurture behavior. Provider/Azure setup, actual
mailbox consent and contractor/device acceptance remain separate owner gates.

Coordinator: integrate exact-head PostgreSQL CI, compatible synthetic recovery,
UI/build and browser acceptance. Only after green integration may the approved
next invoice wave begin. Its agreed design is an append-only server-owned attempt
chain (maximum 5 total attempts per invoice), separate safe-not-dispatched retry
and intentional additional-copy intents, fresh exact review each time, and no
retry from uncertainty or operator reconciliation. No wave-two code was added
by this lane before wave-one acceptance.

Checkpoint: implementation and evidence are saved in canonical project files;
the coordinator owns shared STATE, Git commits and release documentation. No
memory, permissions, account settings or unrelated backup file was changed.
