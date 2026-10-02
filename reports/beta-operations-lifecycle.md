# Customer lifecycle and core export — beta operations wave

Date: 2026-10-01. Worktree: `growthos-revenue-queue-hardening`; branch: `agent/growthos-beta-operations`.

## Delivered source scope

- `lib/db/src/schema/customer-lifecycle.ts`: one tenant-owned operating-state row, constrained states and positive version. No billing, credential or deletion fields are repurposed.
- `artifacts/api-server/src/services/customer-lifecycle.ts`: fail-closed status/guard; current active owner/admin check; tenant lock, expected-version comparison and transition/audit commit together. A missing lifecycle row means active only for an existing company. Database errors never authorize work.
- `artifacts/api-server/src/routes/v1/customer-lifecycle.ts`: ordinary authenticated manager routes for status, transition and JSON export; no-store responses; rejects API-key access and supplied tenant selectors. Mutations require JSON and reject foreign Origin / cross-site requests.
- `artifacts/api-server/src/services/customer-lifecycle-export.ts`: bounded, consistent core CRM export with explicit columns, tenant filters, independently checked direct and indirect relationships, counts, exclusions, and SHA-256 over the data object. A second current-actor check precedes audit/delivery. The billing worker independently reviewed and tightened the whole-operation timeout, including final authorization/audit on the bounded connection.
- `artifacts/command-center/src/components/customer-lifecycle.tsx`: Settings > Data & privacy now supports manual core export/status review and reasoned operating changes. Unknown mutation results retain the reason and previous version, label the prior status, and disable further changes until a fresh review. Account changes abort/discard stale requests and downloads.
- `artifacts/api-server/src/routes/v1/twilio-voice.ts`: hold at fresh call dispatch and bridge boundaries. An initially held company gets 423 before a new call operation. If the hold arrives after claim but before network handoff, the unsent operation is retained as cancelled. Signed inbound calls retain evidence but cannot dial a new staff leg. Answer/connect cannot start a new customer leg while held. Signed complete/status callbacks continue recording results.

The parent integrates the schema/router/catalog and shared scheduler, playbook, BIE, reactivation, website, email, SMS, staff push and webhook guards. This report does not assert that every possible account action is disabled.

## Operating policy

| Action | Required prior state | Result | Safety behavior |
|---|---|---|---|
| Pause | Active | Paused | Covered new capture/automation/outbound effects held; stored customer/history and queued work retained |
| Request offboarding review | Active or paused | Offboarding requested | Work held, reason/reference/audit saved; owner shares reference with GrowthOS operator |
| Cancel offboarding request | Offboarding requested | Paused | Cancellation never resumes work automatically |
| Resume | Paused | Active | Fresh expected version, reason and explicit queued-work acknowledgment required |

Offboarding is a review request, not account deletion, billing cancellation or provider revocation. The operator review must separately establish remaining export requirements, contractual/retention decisions, billing and access changes. No automatic operator notification is claimed. A request already handed off may finish or require reconciliation; the pause cannot retract a provider-accepted send or active call. Independently paused/uncertain work still follows its existing review requirements.

## Export coverage and limits

Fourteen datasets: contacts, properties, leads, estimates, projects, CRM tasks, appointments, activity text, consent records, suppressions, value entries, execution receipts, execution events, and tenant-owned Postgres media metadata. Each dataset has its exported field list and row count in the manifest.

- Limit: 2,000 rows per dataset and 10 MiB compact JSON. Exceeding either fails the complete request with 413; no silently truncated file.
- Credentials, identity/session stores, API keys, provider/billing configuration, opaque metadata/attribution/import blobs and raw provider error details are excluded by column selection. Estimate line-item JSON is separately reduced to four supported fields.
- Each exported child reference must point to an included same-company parent. Invalid or cross-company links are withheld; indirect children are withheld too. Their counts are visible in the manifest and download notice.
- The export includes intentional customer-authored text such as notes and activity bodies. It is not a universal secret scanner for arbitrary text a user has entered into CRM fields.
- Photo bytes, external object/provider copies, full mailbox conversations, website submissions, analytics, automation definitions/queues, backups and other account tables are not part of this core archive. The UI/file explicitly ask the operator to review excluded categories or a larger export.
- `completeAccountExport:false`, `deletionPerformed:false` and an audit delivery flag of `deliveryConfirmed:false` prevent a generated-file event from claiming a complete archive, deletion or confirmed receipt by the user.

## Evidence obtained in this wave

All database checks below ran only through `test-scheduler-isolated.mjs`, which creates disposable loopback PGlite and strips provider credentials. None is a hosted/production acceptance result.

| Check | Evidence |
|---|---|
| Normal-session lifecycle HTTP acceptance | `src/routes/v1/customer-lifecycle.test.ts`: **9 passed**. Real sessions, both directions across two companies, ordinary owner/admin positives; anonymous/viewer/inactive/API-key denials; forged selectors; CSRF/content type; fixed-field secret canaries and corrupt direct/indirect foreign relationships; cap failures; versioned/audited pause/offboard/cancel/resume; unchanged pending/indeterminate receipts and billing binding |
| Settings controls | `src/components/customer-lifecycle.test.tsx`: **14 passed**. Manual requests, no tenant override, invalid export rejection, error redaction, cancel-to-paused, required resume acknowledgment, pending-action disable, retained uncertain reason/version, account-switch abort and no stale download, stalled-body deadline |
| Voice lifecycle and existing Twilio regression | `src/routes/v1/customer-lifecycle-voice.test.ts` **6 passed** plus existing `twilio.test.ts` **15 passed**; **21 total**, 13.63 s. Real sessions and SDK-signed callbacks; provider transport replaced with synthetic responses. Positive active-company controls, held dispatch/no new claim, hold during preparation/no provider attempt, no replay of cancelled identity, inbound history without Dial, signed receipts and one missed-call record, fail-closed unavailable lifecycle |
| API and command-center TypeScript | Both passed before final shared runtime additions; parent owns final integrated rerun |
| Impeccable detector | Targeted new component returned `[]`; existing Settings visual system retained. Parent owns browser integration/accessibility/reflow verification |

The first voice fixture run reached the unchanged five-per-minute loopback voice rate limit in its sixth case. The fixture now resets only its exact test-process loopback counter between cases; production limits were not weakened. All six then passed together with the existing 15-test Twilio suite.

## Independent review findings and repairs

| Severity | Finding from source review | Resolution / evidence |
|---|---|---|
| P1 | Scheduler lifecycle predicate initially landed in follow-up cancellation instead of before the due-batch LIMIT, risking active-tenant starvation and preserved stale cancelled work | Parent moved filter to due selection, preserved explicit cancellation, and added tests executing the actual scheduler with 25 held rows plus active work and cancel/resume |
| P1 | A lifecycle hold returned by the send gate during playbook preparation could be treated as a nonfatal channel skip and consume the final step | Parent added a version/step-scoped paused enrollment before claim, with final-step regression |
| P1 | An early `runEvent` hold discarded stop, booking outcome and won-attribution hooks | Parent preserved stop/outcome/classification, gated new enrollments/handoffs/rules and added a booked-during-pause test |
| P1 | Smart Site acquisition events and token-based referral intake bypassed the public-org middleware guard | Parent added service-level hold checks; Smart Site intake/events also recheck under the shared lifecycle lock. Privacy opt-out remains separate |
| P1 | Voice dispatch and TwiML bridges bypassed the email/SMS provider guard | Fixed in this workstream; six new lifecycle voice cases and all existing Twilio checks pass |
| P1 | Export's original total timeout did not bound post-snapshot actor revalidation and audit | Independently identified and repaired by billing worker in the export module; their bounded-phase tests and final integration remain part of parent verification |

Reviewed unchanged callback boundaries: email unsubscribe, signed SMS STOP/status, Smart Site analytics opt-out and voice completion/status remain reachable. Platform identity/security email (including API-key expiry reminders) uses a separate platform sender; the company operating hold is not a platform-account email shutdown.

Independent billing source review found no additional blocking regression in persisted checkout identities/terms, lease/configuration fences, uncertain-effect cutoff, platform-only replacement/reconciliation, canceled-subscription verification, matching customer/attempt/price binding, retired-event handling, or signature-versus-processing response status. Real Stripe acceptance and independent PostgreSQL simultaneous claims remain separate release gates.

## Remaining release gates

1. Final integrated API/UI checks and independent PostgreSQL CI, including concurrency tests PGlite cannot establish.
2. Reviewed additive schema migration and guarded rollback/recovery rehearsal. Presence of source schema is not proof it exists on a hosted database.
3. Parent browser review of Settings across real states, narrow screens and keyboard interaction; local unit tests do not prove browser download behavior.
4. Approved hosted two-company acceptance with synthetic records: export isolation, operational holds/queues, privacy/receipt access, explicit resume and operator review references.
5. Provider-specific acceptance remains separate. No Stripe charge/cancellation, email/SMS/voice send, live onboarding, provider revocation or real deletion was performed by this workstream.
