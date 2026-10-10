# Lead alert coverage — GEEKOM UI integration handoff

This backend wave builds on PR #28. No Command Center page, component, styling,
navigation or brand source is changed. The typed generated API client is ready
for the separate UI lane after the candidate is reviewed and integrated.

## Call and access

Use `getStaffLeadAlertCoverage(leadId)` from the generated API client, or
`GET /api/v1/staff-push/leads/:leadId/coverage`. No query parameters. Use the
current staff session and same-origin request; API keys are refused. This read
requires an accepted verified active company owner/admin with `settings.manage`.
It does not enroll devices, change routing, claim a lead, or send an alert.

Key a query by the current company, current member and lead. Clear old evidence
when that scope changes; do not show another company's cached results. Respect
401/403 and no-store. A read error means evidence could not be loaded, not that
an alert failed. Offer a read retry only; no resend or retrospective evaluation.

## Meaning and suggested copy

| Evidence | Suggested display | Meaning |
| --- | --- | --- |
| `coverage_not_recorded` | Alert coverage was not recorded | Historical cohort is unknown. Do not derive it from today's policy. |
| `historical_unknown` | Earlier alerts exist; original coverage is unknown | Preserve original effects; do not offer automatic resend. |
| `policy_unavailable` | Alert routing was not configured | No valid policy at original admission. Current policy may differ. |
| `policy_disabled` | Lead alerts were off | Policy was disabled at original admission. |
| `evaluated` | Alert coverage recorded | Show every returned recipient, including nonqueued recipients. |
| Recipient `queued` | Queued for N devices | Admission only; show current receipt counts beneath it. |
| `recipient_unavailable` | Staff member was unavailable for alerts | Original member was not an eligible accepted responder. |
| `no_eligible_device` | No eligible device at the time | Device/session registration, expiry, logout or revocation prevented queuing. |
| `notification_expired` | Alert window had elapsed | Nothing was queued; this is not a new retry permission. |
| Null `displayName` | Unavailable staff member | Never fetch a name outside the current company. |

Keep original admission and current receipt evidence separate. Pending and
dispatching are not success. Label `accepted` as **Push provider accepted**.
Use **Receipt unavailable** for a missing original receipt, **Outcome unknown**
for indeterminate, and explicit rejected/expired/cancelled labels for those
states. None proves that a phone displayed an alert or a person read it.

Use `recordedAt`/`occurredAt` to explain that coverage is historical. `serverNow`
timestamps the current read. Counts sum to the original queued-device count.
The API intentionally provides no policy fingerprint, device identity, endpoint,
session, secret, raw error, contact content or effect IDs. There is no resend
action in this contract. Lead claim remains the distinct PR #28 workflow.

## Acceptance for the UI lane

Verify partial coverage (two owners, one device), zero-device coverage, disabled
and unconfigured policy, old unknown coverage, deleted receipt, accepted versus
indeterminate states, failed read and expired/revoked member scope. Check native
lead navigation beyond the first 100 alerts and small-screen presentation.
This handoff does not claim that UI integration or real phone testing is complete.

## Release dependency

Additive review-only SQL `0018_lead-alert-coverage.sql` follows 0017 and brings
the source to 142 tables. No backfill is allowed. Existing hosted migration,
backup/restore, image identity, provider and actual installed-device acceptance
remain separate. Do not bypass the retired Fly/schema/startup guards from PR #28.
