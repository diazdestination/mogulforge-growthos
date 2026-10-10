# Lead alert coverage — frozen backend contract

October 9 UTC / October 8 Pacific, 2026. Adam authorized continued engineering
while GEEKOM works on UI design. This wave is backend evidence and an integration
contract, with no edits to Command Center pages, components, styling or navigation.

## Baseline and ownership

- Canonical main `2162aa296281473dda170291ff95d64e0e6e9b79` remains unchanged.
- Base is private draft PR #28, exact head `a0eb25dcc69291130a46a5478acf44f62d303e9f`;
  CI 37885607739 passed all stages (4,137 tests, 15 existing skips).
- Branch `agent/growthos-alert-coverage-20261009` is a dependent candidate; integrate
  PR #28 first, then this wave through review. No merge/deployment is implied.
- Runtime lane: `services/staff-push.ts` and focused coverage tests.
- Route lane: exact staff-push read, its tests and permission inventory entry.
- Root: schema, offline SQL/recovery, API contract, lifecycle classification,
  integration, records and Git/CI. Independent lane reviews invariants and changes.

## Customer outcome and scope

Both configured owners must remain visible in evidence even if only one can
receive a queued alert. One recipient with no usable device must not disappear.
Coverage records admission; provider acceptance never proves phone display or
human reading. Actual installed-device and contractor acceptance remain open.

Add one `staff_lead_alert_coverage` row per company/lead (141 to 142 tables),
exported as `staffLeadAlertCoverageTable`. Composite tenant FK to the canonical
lead; organization/lead primary key. Fields: `occurredAt` (stored lead timestamp),
`recordedAt`, version 1, `status`, nullable hex SHA-256 `policyFingerprint`, and
bounded JSON `recipients`. Status is `evaluated`, `policy_unavailable`,
`policy_disabled`, or `historical_unknown`. Non-evaluated statuses have no recipient
entries. A valid evaluated policy has 1–20 recipients; each has only:

```
{ userId, outcome, deliveryIds }
outcome = queued | recipient_unavailable | no_eligible_device | notification_expired
```

`deliveryIds` contains 1–5 original receipt UUIDs only for `queued`, otherwise
empty. Recipient IDs are distinct. No name/email, endpoint, key, session,
subscription content, customer content, raw provider error or raw policy is saved.
No user/device FK rewrites or deletes historical recipient evidence on logout.
The snapshot has no update/re-evaluate/resend operation. Tenant/lead deletion
retains existing cascade semantics; this is not a new retention policy.

## Admission and replay

Use the existing four fresh canonical lead-insert transactions (CRM, capture,
Smart Site, missed-call handoff). Imports and merge/replay paths do not call the
helper. No new route or scheduler backfills historical leads.

1. Lock the exact same-company canonical lead before checking coverage. Use the
   stored creation time, never a caller-supplied replacement timestamp.
2. Existing snapshot returns immediately, before policy/device work or effects.
3. If legacy device receipts exist without coverage, save `historical_unknown`
   with no recipients and queue no new effects. The old cohort cannot be inferred.
4. Otherwise record even disabled/unconfigured admission. A later policy or
   device change cannot add old alerts. Hash the validated policy only.
5. Select recipients with existing business/after-hours logic. Evaluate accepted,
   verified active same-company CRM responders and session-bound devices. Queue
   deterministic eligible devices (at most five per recipient); no global slice
   can silently erase a later recipient. Expired notification windows record
   `notification_expired` without an outbound effect.
6. Canonical lead, original effects and snapshot commit or roll back together.
   Existing worker holds, final authorization, expiry and indeterminate no-replay
   behavior remain unchanged. Separate service notifications remain unchanged.

## Exact read contract

`GET /api/v1/staff-push/leads/:leadId/coverage`: real staff session, verified current
accepted active same-company owner/admin with current and effective
`settings.manage`; API-key header presence (including empty) is refused. Strict
UUID and empty query, `Cache-Control: no-store`, existing same-origin safeguards,
closed response projection and redacted errors. Missing/foreign lead returns 404.

The service rechecks actor authority and same-company lead in one bounded read
transaction. Missing snapshot is `coverage_not_recorded`, never inferred from
today's policy/devices or the latest-100 deliveries list. Snapshot status and
original recipient/outcome IDs are immutable; names may be resolved only from
current same-company accepted membership, otherwise an unavailable-member label.
Receipt states are read by exact original IDs AND company AND lead, with no
subscription/secret join in the public projection. Missing/deleted effect evidence
is explicit `receipt_unavailable`; it is not successful delivery. Cap output at
20 recipients and five receipts each. Reject corrupt stored JSON with a fixed
unavailable error instead of returning raw evidence or silently dropping entries.

Response shape (all fields required): `organizationId`, `leadId`, `status`
(snapshot statuses or `coverage_not_recorded`), `version` (1 or null), `occurredAt`,
`recordedAt` (timestamp or null), `serverNow`, `receiptMeaning`
(`provider_accepted_not_received_or_read`), and `recipients`. Each recipient has
`userId`, nullable `displayName`, `outcome`, `queuedDeviceCount`, and
`deliveryStateCounts` with integer 0–5 keys `pending`, `dispatching`, `accepted`,
`rejected`, `expired`, `cancelled`, `indeterminate`, `unavailable`. Original effect
IDs and policy fingerprints stay server-only. Counts sum to the original queued
device count; nonqueued outcomes have zero counts. Current actor session identity
and expiry are revalidated using the route's session ID as well as member scope.

OpenAPI/generated types document this exact returned shape. The UI handoff
supplies display meanings and missing/partial/error
states; integration into GEEKOM's design is a separate change. This backend wave
does not claim visible UI completion or actual notifications.

## Lifecycle, recovery and acceptance

Classify the new table as direct-company communications in the closed full
inventory. Retain snapshot evidence in full backup/restore. Staff/device effect
evidence stays out of the core customer-business export, documented explicitly.
Review-only additive `0018_lead-alert-coverage.sql` follows 0017; no backfill/DML,
old-column changes, hosted SQL executor, provider changes or activation.

Required evidence: two selected recipients/one device; none/expired/revoked or
invalid session/member cases; disabled/missing policy; elapsed window; repeated
and concurrent admission; registration/policy changes; legacy unknown; atomic
rollback; tenant/authorization/no-secret reads; exact lookup beyond 100 effects;
all worker/service tests unchanged; schema constraints and synthetic backup
restore preserving original coverage/effects; full PostgreSQL 16 CI/type/build/
Docker gate on final source and independent review. Local PGlite skips may only
cover true concurrent/abort protocol limits and must run in real PostgreSQL CI.

No merge, hosted/provider/account mutation, real messages, customer activation,
payment or public launch is authorized by this source contract.
