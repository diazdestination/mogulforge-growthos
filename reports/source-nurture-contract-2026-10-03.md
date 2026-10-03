# L6 bounded source nurture — implementation contract

Owner requested the next wave after L5 PR20/main
`110f14563dc5d581fd4550e8410d947b39141c36`, exact-main CI37148428665 passed.
Branch: `agent/growthos-source-nurture-20261003`. This contract authorizes the
engineering slice below, not a real campaign, hosted change or complete L6/client
replacement acceptance. `LAUNCH-COMPLETION.md` remains the fixed launch checklist.

## Outcome and finite authority

Turn a separately adopted, permissioned imported opportunity into a short, exact
owner-reviewed recovery sequence, with original send evidence and accountable
reply work in the existing lead and workday surfaces. No parallel CRM or inbox.

- At most ten unique addresses; exactly two fixed Microsoft emails. Step indexes
  are 1 and 2. The second is no sooner than 72 hours after actual retained provider
  acceptance of the first. Plan expiry is at most fourteen days from preview and
  cannot outlive any source adoption. These are conservative software bounds, not
  owner-approved live contact policy or a guarantee that every contractor's L6
  requirements are covered. No rolling enrollment, renewal, arbitrary drip, AI
  copy changes, SMS marketing, fallback sender or inferred consent.
- Accepted active verified owner/admin plus `revenue.autopilot` may review and
  start. Source adoption, address-specific marketing permission, selected sending
  identity, mailbox read/context grant, approval and explicit start are separate.
  Saving or approving never sends. Stop and evidence reads remain available while
  delivery/company/entitlement is held; no resume or replacement-key endpoint.
- Preview is actor/company-bound and expires after ten minutes. Store immutable
  settings, complete recipient-specific subjects/bodies including identification,
  mailing address and unsubscribe footer, source and permission references,
  canonical contact/lead/property/office owner, mailbox identity and grants,
  timing/expiry and all hashes. Approval requires the exact current version/hash
  plus a fresh confirmation; changed inputs require a new preview, not mutation
  of an approved payload. A named current office owner is required. CRM ownership
  is not reassigned by reply processing.

## Storage, reservations and dispatch

- Add `source_nurture_plans`, `source_nurture_items`, `source_nurture_steps` with
  composite tenant relationships. Plans: draft/approved/running/stopped/finished/
  expired, immutable review, approval/start/stop receipts. Items permanently own
  opportunity and normalized address once admitted at explicit start. Steps keep
  exact copy/hash, original scheduled action, predecessor, due/check times,
  reservation and actual acceptance evidence. Fixed `scheduled:<actionId>` keys
  are never replaced, including blocked or unknown effects.
- Preserve all legacy `source-outreach:<leadId>:email` keys and partial unique
  reservations. Both legacy claims and nurture admission check one shared source
  slot under the same ordered locks. Legacy accepted/blocked/unknown claims never
  become a new plan's step one. A new batch, reimport, clone or reconciliation
  cannot release ownership. No migration backfill grants authority.
- Use transaction-reader-aware authority and allowance helpers; no pooled reads
  inside locked transactions. Coordinate lifecycle/schedule/source/contact/reply
  locks in a single documented order. Shared contact accounting includes accepted
  activities and pending/unknown logical effects without double counting.
  A narrow shared touch-reservation ledger may be added if needed for existing
  generic automation/playbook lanes; stable existing logical keys are mandatory.
  Do not claim atomic cross-lane exclusion from query counts alone. Any unsupported
  competing lane must fail closed explicitly rather than get an extra allowance.
- Shared allowance ledger is approved as `contact_touch_reservations`, keyed by
  the immutable original logical effect, not a new retry key. Lock order is
  lifecycle -> contractor schedule -> lead import -> source outreach -> company
  contact allowance -> sorted customer reply leads -> domain rows. Do not hold
  network calls inside these transactions or reverse the order in intake.
- Before admission, claim, and the final post-OAuth provider boundary, recheck
  current actor/owner, lifecycle/entitlement, exact source/adoption/permission,
  recipient/sender/read grant, suppression/DNC/contact reply hold, terminal lead
  stage or booked appointment, immutable review and original execution ownership,
  quiet hours/company-contact caps and finite expiry. Defer only an unclaimed
  step in the original window. Unknown predecessors stop automatic progression;
  operator attestation is not fresh actual provider acceptance.
- Any current reply, opt-out, booking/terminal outcome or explicit stop prevents
  future unclaimed sends, while preserving claimed/uncertain receipts. Never
  promise to recall a provider request already dispatched. Admission and claim
  races require real independent PostgreSQL workers, not PGlite substitutes.

## Tracked reply and complete-sync boundary

- Add strict `source_nurture_email` context to the existing typed mailbox parent,
  identified by exact plan/item/step/revision and immutable authority. Never fake
  a BIE proposal or accept arbitrary JSON as send authority. Microsoft sending
  and an independently approved nurture read context are required. Existing
  service-only and BIE-only grants stay unchanged/default-off for this context.
- Step two additionally requires original first-step provider acceptance, exact
  Sent Items observation, the unchanged reader identity/context grant, and fresh
  completion of both Sent Items and Inbox synchronization after that acceptance
  and observation. Page-level `lastSuccessAt` is not completion. Record explicit
  continuity/completion evidence; incomplete, failing or ambiguous scans and
  unresolved candidate receipts hold progression. Evidence freshness is at most
  five minutes. Label this observed bounded check, never certainty that no reply
  exists anywhere in the real mailbox.
- Persist `mailbox_sync_cycles` with exact connector generation, cycle start,
  Sent and Inbox completion, final completion or failure. A cycle begins after
  the current nurture grant and, for step two, strictly after both predecessor
  acceptance and observation. No active lease/later error/incomplete round or
  unresolved current-generation pending/review receipt may imply readiness.
  Step one also requires a current fresh complete cycle. Opaque provider cursors
  remain encrypted; no credentials or raw content enter cycle evidence.
- Connector nurtureMonitoringEnabled/version/approvedAt/changedAt are independent
  of existing lead permission. The dedicated command is
  `{expectedConnectorVersion,expectedNurtureMonitoringVersion,enabled,
  nurtureContextAcknowledged:true}`. Reconnect resets this authority. Parent
  `sourceNurtureStepId` has an exact org/step/lead/contact foreign key, and context
  contains only strict plan/item/step/revision authority loaded from the kernel.
- A delayed reply to an earlier sibling in the same plan still stops that plan;
  it is not historical merely because a newer sibling was sent. Retain unrelated
  historical conversation boundaries. Save receipt, canonical contact/lead hold,
  future-step cancellation and deduplicated office task atomically. Preserve
  legitimate assigned tasks. Retained exact-parent office review remains possible
  after reader revocation; reviewing never resumes cancelled work.
- Treat all reply text as escaped, encrypted, short-lived untrusted evidence,
  never tool/agent authority. Raw purge retains permanent identity and holds.

## Frozen HTTP and UX seams

Session-only, no-store, tenant-scoped, API keys denied; strict JSON/trusted origin
for mutations and strict query validation. All reads SELECT-only, including holds.

- `GET /api/v1/source-nurture?bucket=attention|waiting|history&offset=0` returns
  `{organizationId,bucket,offset,limit:25,hasMore,items}`. Oldest actionable work
  remains discoverable; don't calculate company totals from a partial page.
- `GET /api/v1/source-nurture/:id` returns the complete immutable review plus
  current readiness, original step receipts/parent observation/scan status and
  real lead/reply/task/appointment links. Saved intent is not current readiness.
- `POST /api/v1/source-nurture/preview`: strict leadIds, businessName,
  mailingAddress, steps (two subject/body objects), startNotBefore, expiresAt,
  timezone, days, startHour, endHour and dailyLimit. No undisplayed metadata added
  at approval. Follow-up delay is fixed at 72 hours in this slice.
- `POST /api/v1/source-nurture/:id/approve`:
  `{expectedVersion,payloadSha256,confirmed:true}`.
- `POST /api/v1/source-nurture/:id/start` and `/:id/stop`:
  `{requestId,expectedVersion,payloadSha256,confirmed:true}`; stop also requires a
  bounded reason. Replay the same exact command safely; changed UUID payload or
  stale version fails. Return fresh detail and explicit command receipt.
- `POST /api/v1/mailbox/microsoft/nurture-monitoring`: separate versioned local
  context acknowledgement, not a new OAuth grant. Own accepted mailbox only.
- Reuse `/reactivation` SourceNurturePanel, Account MailboxConnectionCard and
  existing lead Messages/Today reply tasks. Exact full-content review, separate
  Approve/Start/Stop, Ready/Waiting/Held/Office response/Finished evidence. No new
  dashboard, inferred delivery, summed estimated-value revenue or automatic
  confirmed booking. Preserve semantic member scope and late-response fences,
  unchanged-poll drafts and saved-success background refresh.

## Coordinated ownership

1. Runtime: new nurture schema/contracts/authority/runtime, legacy coexistence,
   shared allowance/claim hooks and send-gate; BIE/playbook/automation execution
   hooks only where necessary for honest shared allowances; focused kernel/race
   tests. Publish function/DTO seams to the other lanes before dependent edits.
2. Intake: mailbox context/read consent/complete synchronization fields and helper,
   typed parent reserve/bind/ingest; canonical same-plan stop/office task handling;
   mailbox/lead reply routes and tests. No provider or scope activation.
3. Experience: source nurture React panel/types/tests and reactivation mount;
   mailbox context/readiness and lead reply context surfaces/tests. Coordinate
   response types with runtime/intake; no provider assumptions or optimistic send.
4. Root: router/new nurture HTTP route+tests, OpenAPI/generated clients, schema
   exports/catalog/export-offboarding inventories, scheduler stage mount after
   runtime edits, reviewed additive SQL and synthetic restore/application probes,
   isolated provider-free browser preview, docs, release CI and durable checkpoint.

Agents do not commit shared partial work. Preserve unrelated
`pnpm-workspace.yaml.bak`. No package installs, broad formatter or live schema push.

## Acceptance and unchanged external gates

Require exact tenant/actor/hash/version/expiry boundaries; imported source versus
marketing permission separation; changed source/recipient/owner/consent or reply
during OAuth prevents POST; legacy-versus-nurture reservation and last allowance
races; crash/unknown/reconcile no replay or next-step advancement; real typed
send-to-Sent-to-Inbox hold/task path; incomplete/failing pagination and same-plan
late reply cases; quiet hours/DST/expiry/fairness; stable paged mobile UX; additive
schema constraints and compatible synthetic recovery preserving holds/reservations;
full types/builds and exact PR/main CI. Report any limitations rather than silently
loosening these checks.

No real messages/calls, customer imports, provider setup, secrets/DNS, hosted
schema/staging/production deployment, spending/new cluster or Housecall Pro
cancellation. Azure first sign-in, approved test identities, hosted backup/restore,
real provider/device acceptance and both contractors' complete replacement-day
cards remain separate owner/live gates. Payment collection remains deferred.
