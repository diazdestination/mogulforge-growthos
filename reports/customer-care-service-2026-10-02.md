# Service-due customer care — October 2, 2026

Local implementation on `agent/growthos-customer-care-20261002`, under
`customer-care-contract-2026-10-02.md`. This report is not provider, deployment,
contractor acceptance, or Housecall Pro replacement proof.

## Delivered workflow

The existing Customer service desk now offers **Customer care & booking** on
active and historical service records. It uses the canonical service obligation,
customer, property, staff task and native appointment; no new table or separate
customer database is introduced by this lane.

1. Staff review the exact recipient, selected sender, fixed expected-service
   message, due date and current agreement/customer expectation. One explicit
   approval queues one reminder no earlier than the configured notice date and
   permitted sending window. This is not a bulk campaign or recurring send
   authorization. Each successor service occurrence needs its own review.
2. The scheduler rechecks service version/status, existing booking, approving
   staff, recipient, sender, consent, source/reply holds, suppression, lifecycle,
   quiet hours, frequency caps and outbound activation. Temporarily held work
   defers before acquiring durable execution ownership.
3. The provider receipt remains visible. Acceptance is not delivery, a customer
   reply, a booked appointment, service completion or warranty proof. After
   acceptance the existing office task becomes due in three days for manual
   response review/follow-up. No-response does not trigger another send.
4. Staff record the actual phone/email/text/in-person conversation, its time,
   outcome and note. This is explicitly **staff-attested**, not independently
   verified inbox evidence. It cancels only an unclaimed reminder, preserves
   uncertain execution history, and never clears unrelated outreach holds.
5. A fresh ready-to-book response plus an explicit confirmation of the exact
   window and staff assignment creates one linked confirmed native appointment.
   Shared staff/job overlap checks apply; inspection visits also check inspection
   capacity. The existing appointment-reminder policy is used. Booking does not
   complete the service or advance its recurrence.
6. Existing cancellation/no-show reconciliation reopens the office task. A fresh
   customer response is required before another booking. Existing explicit
   service completion retains its reviewed calendar recurrence behavior.

## Integrity and boundaries

- GET is tenant-scoped `crm.read`, no-store. Changes require `crm.write`, active
  accepted/verified operational staff, JSON and same-origin mutation checks.
  API keys cannot supply these human approvals or attestations.
- Strict schemas reject arbitrary recipients, company IDs, sender changes and
  unknown fields. The approved exact snapshot is stored in a server-owned audit
  event, not a generic editable activity. The service version is checked again.
- One logical reminder per obligation is serialized under the shared contractor
  lock. A new request key, another channel, a cloned scheduled row or a reconciled
  old receipt cannot create a second send. Lost acknowledgments return the
  original preparation/response/booking result for the same exact request.
- The scheduler passes its actual row ID as a server-only fourth argument.
  Execution verifies that original row, approval, saved context and canonical
  durable payload fingerprint, plus unexpired processing ownership.
- Email pins the selected Gmail/Microsoft sender and uses the final dispatch
  callback. SMS uses the real tenant adapter, purpose-specific customer-care
  proof and stable `service-care:<obligation>` ownership, with a final callback.
  There is no mock-provider success fallback in this workflow.
- The stricter existing outreach eligibility check supplies source/reply holds,
  windows and caps even though the fixed message is about expected service.
  Imported lead history is never upgraded into current outreach permission.
  Service approval does not grant marketing or SMS consent or infer agreement
  terms, coverage dates, equipment condition or warranty eligibility.
- Timeouts, interrupted dispatch and post-effect persistence failures retain
  uncertain ownership. Expired processing is displayed as unknown. There is no
  automatic resend control. Known-blocked/changed approvals also require manual
  review; this slice intentionally does not introduce replacement-send authority.
- UI write failures disable further writes until **Refresh and review**. That
  refresh resets all approval/attestation checkboxes; it does not silently approve
  a new version, sender or booked window. Times explicitly identify the browser
  timezone; service due dates remain calendar dates.

## Files and integration

Owned backend: `artifacts/api-server/src/services/service-care.ts`,
`service-care-policy.ts`, `service-care.test.ts`, and
`artifacts/api-server/src/routes/v1/service-care.ts` / `service-care.test.ts`.
Owned UI: `artifacts/command-center/src/components/service-care-panel.tsx` /
`service-care-panel.test.tsx`, with entry points in `pages/service-desk.tsx`.

Routes: GET `/api/v1/service-obligations/{id}/care?channel=email|sms`; POST
`/care/reminder`, `/care/response`, `/care/book`. Strict request contracts are
exported from `service-care-policy.ts`; coordinator owns OpenAPI/code generation.
Coordinator integration adds the `service_care_reminder` action type, mounts the
router, invokes preflight before durable claim and execution with the real row ID,
and preserves safe service-care result detail in the receipt. This lane did not
edit shared schema/router/generated files, invoice/call implementation or state.

## Focused synthetic evidence

Command:
`node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/service-care.test.ts src/routes/v1/service-care.test.ts`

Result: **33 passed, 1 skipped**. Every invocation uses fresh in-memory PGlite,
an ephemeral loopback socket and stripped provider/hosted environment. The single
skip is the explicit independent-PostgreSQL concurrent approval test; CI must run
it on real PostgreSQL sessions. Included: same-key replay/different-key blocking,
provider acceptance versus delivery, an actual SMS adapter with mocked network,
quiet/global/frequency deferral before claim, future notice date, reply/import/
consent/lifecycle holds, late service/customer/sender/staff/DNC changes, cloned
claims and wrong payloads, uncertain/expired ownership, staff response handling,
one-time office booking, resource/capacity conflicts and cancellation rebooking.
Five real-app HTTP tests cover authentication/roles, cross-tenant reads, CSRF,
strict input, API-key attestation rejection and the queue-response-booking chain.

Command:
`pnpm --filter @workspace/command-center exec vitest run src/components/service-care-panel.test.tsx src/pages/service-desk.test.tsx`

Result: **10 passed**. DOM tests cover exact review, selected Microsoft identity,
lost acknowledgment/stale-version refresh, read-only controls, unknown receipts
and explicit booking confirmation. These are not a mobile-device/browser visual
acceptance test. Command Center no-emit TypeScript passed after correcting the
generated query hook's required key. API no-emit showed no remaining owned-file
errors; other agents' concurrent test edits were referred to the coordinator.
Full suites/builds/exact-head CI are coordinator gates, not claimed here.

## Shared guard review and remaining proof

Read-only review confirmed selected sender pins and final provider callbacks,
actual scheduler row identity and immutable durable payload checks, deferral
without a new key, and receipt retention. The separate financial reviewer owns
Gmail library auth/retry replay analysis and any adapter repair; it is not
substituted by this lane's mocked provider tests.

No provider, account, hosted database, customer recipient, credential, spend or
production setting was changed. Azure first sign-in, connected-mailbox refresh/
revocation, actual Twilio program/consent/delivery callbacks, idle scheduler,
device push acceptance and contractor demonstrations remain separate gates.
There is no automatic mailbox ingestion/correlation for this contact-only service
flow, customer self-booking, external calendar sync or warranty interpretation.
Both contractors' actual workflow acceptance cards remain unaccepted. The
existing unrelated `pnpm-workspace.yaml.bak` remains untouched; coordinator owns
Git operations and the durable global-state checkpoint.
