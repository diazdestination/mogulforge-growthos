# L6 bounded source nurture — runtime lane

Date: 2026-10-03. Branch: `agent/growthos-source-nurture-20261003`.
Scope: the frozen `source-nurture-contract-2026-10-03.md`, not live activation or
complete contractor replacement acceptance. This lane made no provider, hosted,
customer-data, spending or deployment changes. The unrelated workspace `.bak`
was preserved. Release operations remain with the coordinator.

## Implemented authority and execution

- Immutable actor/company-bound ten-minute review, explicit approval and a
  separate replay-safe start. At most ten distinct normalized addresses, exactly
  two fixed Microsoft messages, maximum fourteen-day lifetime, and no extension
  beyond source adoption expiry. Approval alone creates no scheduled send.
- Permanent per-opportunity and normalized-address ownership at admission. The
  original legacy one-touch and new sequence share the same source reservation
  checks. Stop, expiry, provider uncertainty and operator reconciliation do not
  release that source slot or replace an action key.
- Original scheduled action IDs and `scheduled:<id>` receipts. Follow-up needs
  actual retained Microsoft HTTP acceptance, authenticated immutable acceptance
  evidence, exact Sent Items observation, at least 72 hours, and the separate
  current fresh complete mailbox scan. Microsoft 202 is not invented message ID,
  delivery evidence, or proof of a reply-free real mailbox.
- Current actor/owner, entitlement/lifecycle, selected Microsoft preference,
  sender/read grant, adopted source, address-specific permission, contact,
  suppression/reply holds, finite window and company/contact caps are reread.
  The established five outreach-active lead stages are used; inspection,
  terminal and post-sale stages cannot quietly retain recovery authority.
- Final transactional parent claims share-lock the organization, existing
  sending-settings row, sorted distinct creator/approver/source-approver/owner
  user rows, and current lead/contact authority. Revalidation follows locking.
  An absent settings row fails closed at final claim. Network operations stay
  outside transactions. Plain projections acquire no row locks and write nothing.
- Current canonical contact replies and opt-outs cancel future unclaimed work.
  Exact original typed replies also stop their own item when otherwise historical.
  Claimed/unknown receipts and accountable office work remain intact.

Main modules: `source-nurture.ts`, `source-nurture-authority.ts`,
`source-nurture-runtime.ts`, `source-nurture-contract.ts`,
`source-nurture-fingerprint.ts`, `source-nurture-acceptance.ts`, and
`source-outreach-ownership.ts`. Schemas are `source-nurture.ts` and
`contact-touch-reservations.ts`; connector cycles and typed parents belong to the
intake lane. No final review fix changed a schema or HTTP DTO.

## Shared allowance and legacy preservation

`contact-touch-claim.ts` reserves a logical contact touch under the shared ordered
prefix: lifecycle, contractor schedule, lead import, source outreach, company
contact allowance, sorted reply leads, domain rows. A reservation is allowance
evidence, not independent effect authority. Existing receipt/step ownership still
controls whether a caller may reach a provider. Finding an existing reservation
without its expected original effect receipt fails closed.

Current BIE, playbook, source, service and automatic-send lanes share this ledger.
Aliases sharing normalized email or phone cannot get a separate allowance. The
rolling clock is the greatest retained reservation, dispatch-start and acceptance
time; an accepted activity surviving a later persistence failure advances the
same logical key rather than adding a new touch. Company recovery counting uses
the same effective ledger time plus exact legacy source acceptance activity.
Dispatch-boundary timestamps never authorize a retry or assert acceptance.

Read-only legacy fallback preserves pre-ledger scheduled claims and unexplained
one-way playbook counters. Scheduled playbook receipts map to the same original
`playbook:<enrollment>:<index>` identity as their activity/counter. Explicit
skipped steps do not invent effects; retained original receipt times outrank
later enrollment edits. Ambiguous oversized historic counters fail closed.
Unkeyed BIE acceptance may explain at most one compatible succeeded receipt;
similar lead/time evidence never erases a separate processing, uncertain or
operator-reconciled effect. Ambiguous old evidence may conservatively overhold;
none is backfilled into new send authority.

Immediate automation now persists its original run before executing any action
and uses `automation-run:<originalRunId>:<ordinal>` for that retained run. This is
not event-level exactly-once processing: separately emitted domain events remain
separate admissions under the existing event model. Existing SMS idempotency
strings are preserved and merely carry the separate internal allowance digest.

## Verified commands and results

Final clean consolidated command:

```text
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/contact-touch-legacy.test.ts src/services/source-nurture.test.ts src/services/automated-email-final-guard.test.ts src/services/source-adoption.test.ts src/services/service-care.test.ts
```

Exit 0: **108 passed, 4 PostgreSQL-only skips**, five files:

- Contact-touch legacy: 8 passed.
- Source nurture: 19 passed, 2 new PostgreSQL-only races.
- Real automatic email final guard: 26 passed, including persisted immediate run
  before Microsoft transport, accepted/unknown retained-run replay refusal, and
  the preserved SMS adapter key with explicit synthetic consent.
- Existing source adoption: 26 passed, 1 existing PostgreSQL-only race.
- Existing service care: 29 passed, 1 existing PostgreSQL-only race.

`pnpm exec tsc -p artifacts/api-server/tsconfig.json --noEmit` also exited 0 after
the final changes. Earlier overlapping selection ran 88 passed/4 skips including
durable execution and send-gate regressions; do not sum it with this result.
Peer reports separately record mailbox and shared BIE/playbook integration tests.
One temporary synthetic SMS fixture omission (`disclosureVersion`) was corrected
before the final clean run; no runtime guard was weakened to make it pass.

New real PostgreSQL obligations across the coordinated slice:

1. `source-nurture.test.ts`: independent legacy send versus nurture admission
   converges on one permanent source owner.
2. `source-nurture.test.ts`: independent nurture and generic workers cannot both
   own the last allowance for alias contacts.
3. `source-nurture-mailbox.test.ts` (intake): an actual membership writer waits
   behind the final Microsoft parent transaction's real authority share lock.
4. `shared-contact-lanes.test.ts` (experience): independent BIE and playbook
   workers serialize the last alias allowance.

PGlite is not a substitute for these independent sessions. An earlier attempt
at the inherited automation-DNC/default-playbook suite encountered the known
PGlite pooled settings-read limitation; it was reported, not papered over by
skipping or weakening production logic. Exact candidate PostgreSQL CI remains
the release gate, alongside the coordinator's complete regression/build checks.

## Remaining gates

Source/test readiness is not hosted or client readiness. Keep default-off and
existing outbound holds. Before production/client activation, require the
reviewed hosted schema and restore acceptance, separately authorized mailbox
read/send identities and fresh complete-scan evidence, current source and
marketing-permission review, explicit finite campaign review/start, and the
contractor's real workday walkthrough. No live list was enrolled, no real email
or SMS was sent, and no paid or hosted setting was changed by this lane.

## First candidate CI repair

Candidate `7c6d8f5c195b3903834646cf373eb72156cd0d70`, run `37152487067`,
failed existing integration assertions and was not merge-ready. The runtime lane
inspected filtered failed-job logs using the CI-repair skill and addressed three
assigned causes without loosening provider or allowance guards:

- The concierge fire-and-forget test stopped polling when the newly persisted
  original run first appeared. Both poll sites now wait for completed action
  results. Its original success, consent and callback-task assertions remain.
- Legacy service activity had an exact approval reference but predated the
  shared touch key, so the same reminder was counted twice. Historical mapping
  now binds the tenant, exact contact, service-obligation audit, original
  scheduled ID and canonical action/context. A different scheduled receipt or
  conflicting explicit activity key remains separate uncertainty. No receipt is
  reclassified and no authority is created by this read-only mapping.
- The durable wrapper obscured a known local SMS-purpose refusal. The unchanged
  pre-provider purpose gate now throws a narrow typed refusal, allowing a safe
  fixed explanation and permanently blocked receipt. Plain/provider exceptions,
  including an identical error message after an attempted effect, remain
  indeterminate and cannot replay. No generic error-text classifier was retained.

Final repair command:

```text
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/concierge-abandon.test.ts src/services/service-standing.test.ts src/services/sms-delivery.test.ts src/services/automated-email-final-guard.test.ts src/services/shared-contact-lanes.test.ts src/services/twilio-dispatch-guard.test.ts
```

Exit 0: **93 passed, 4 PostgreSQL-only skips** across six files. This overlaps
earlier results and must not be added to them. API TypeScript and `git diff
--check` also passed. A related three-file standing/service/nurture selection
passed 76 with six PostgreSQL-only skips before the final extra negative case.
The coordinator owns the other two CI repairs, full workspace checks and the
new exact-candidate PostgreSQL run. Local success does not change the failed
first candidate's release status.
