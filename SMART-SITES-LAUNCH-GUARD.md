# GrowthOS Smart Sites — Launch Guard

September 14, 2026. Implemented and verified locally; not deployed in this
milestone.

## Outcome

Smart Site capture can no longer be enabled by a bare switch. GrowthOS now
requires current operational evidence and a deliberate owner/operator
attestation before a client connection accepts new inquiries.

The reusable guard applies per organization and per Smart Site:

1. At least one active owner or administrator exists in the site organization.
2. At least one active CRM responder exists in that organization.
3. The current server credential completed a credential-only handshake within
   the preceding 24 hours.
4. An owner or administrator confirms that a real person owns the response
   inbox, the client-approved contact policy is documented, and a labeled HTTPS
   form acceptance has passed.

These gates protect Painless and the next HVAC, commercial-construction, and
local-retail clients without placing their people or data in one tenant.

## Enforcement contract

`GET /api/v1/smart-sites/launch-readiness` returns the allowlisted
`smart-site-launch-guard-v1` contract for the authenticated organization. It
contains only staff counts, site identifiers/status, credential version and
credential timestamps. It does not expose names, email addresses, contacts,
leads, hashes, keys, or cross-tenant data.

Enabling capture requires:

```json
{
  "isActive": true,
  "confirmedLaunch": true
}
```

The API re-evaluates every gate inside the enable transaction. A client cannot
bypass the guard by altering the browser request. Missing attestation returns
`launch_confirmation_required`; missing evidence returns
`smart_site_launch_blocked` with only allowlisted blocker codes. A successful
enable writes a `smart_site.enabled` audit event containing the guard contract,
staff counts, credential version/check time, and a bounded attestation code.

Disabling capture remains immediately available and does not require launch
confirmation.

## Unattended-lead protection

The public intake transaction now verifies that at least one active responder
still exists before creating a new contact, lead, task, consent receipt, or
activity. If all responders have subsequently been deactivated, the endpoint
returns `site_staffing_unavailable` and stores nothing. Idempotent retries for an
already committed receipt still return their original saved result.

The responder row is share-locked for the duration of a new intake transaction;
the activation flow likewise locks current staff evidence. This narrows the
race between staff deactivation and accepting a new inquiry.

## Operator experience

The `/capture` workspace now provides:

- a per-site Launch Guard checklist for staffing and the server handshake;
- an explicit confirmation checkbox that stays disabled until backend evidence
  is ready;
- a disabled enable button until both evidence and attestation are present;
- human-readable blocker guidance rather than raw API codes;
- a prominent alert when an already active connection's current readiness has
  regressed; and
- a manual refresh control for the latest readiness evidence.

For historical active connections, current readiness is intentionally distinct
from historical activation proof. A current green status means the evidence is
healthy now. It does not claim the site originally passed Launch Guard unless
the corresponding activation audit event contains the v1 contract.

## Evidence boundaries

- A credential-only check proves possession of the current key at a moment in
  time. It does not prove that the public website is deployed or that its form
  works end to end.
- A recent check may be valid even when an older imported site's original key
  issuance timestamp is unknown. Do not rotate a known-working historical key
  merely to populate missing metadata.
- The checkbox is an operator attestation, not independent proof of client
  approval or delivery to the owner's inbox.
- Current staffing counts do not prove response speed, a delivered message, an
  appointment, a sale, collected cash, ROI, or profit.
- Launch Guard does not send email or SMS and does not enable analytics.

## Verification

- Guarded Smart Sites backend runner: 128/128 tests passed across 10 suites.
- GrowthOS command center: 222/222 tests passed across 41 files.
- API and command-center type checks passed.
- Root GrowthOS build passed.
- Desktop and 390-pixel mobile `/capture` rendering passed with no horizontal
  overflow observed.
- The active-connection warning and current-versus-historical wording were
  inspected in the browser; console warnings/errors were empty.
- `git diff --check` passed apart from Git's existing line-ending notices.

The test coverage includes tenant isolation, missing confirmation, missing and
stale handshakes, absent managers/responders, preserved historical credentials,
audit evidence, malformed readiness responses, disabled controls, active-site
readiness regression, and a no-write 503 when all responders disappear.

## Release boundary and next gate

This milestone changes local GrowthOS source only. It did not push, deploy,
migrate production, alter a production tenant, rotate a key, change Painless,
enable public capture, send a message, enable analytics, or touch DNS.

The next controlled Painless action remains: obtain the real owner/manager and
responder email address(es) plus the approved contact policy, establish their
GrowthOS access, complete one owner-visible CRM acceptance, then separately
approve and deploy this GrowthOS release before intentionally enabling both the
GrowthOS Smart Site and the Painless site-side switch.
