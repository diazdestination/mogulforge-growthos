# Staff lead alerts — controlled pilot contract

This is the bounded staff-notification path for the existing lead workspace, not
customer SMS, an emergency dispatch guarantee, or proof of iPhone delivery.
Code/tests do not activate providers, create a real customer tenant, choose real
staff IDs, grant device permission, apply a hosted schema, or deploy anything.

## Outcome and boundaries

An actual new lead created through the canonical CRM create path, external
Capture, or Smart Site intake can enqueue one alert per opted-in staff device.
The lead and queue rows commit together. Smart Site retry and Capture merge
paths do not enqueue again. CSV/historical import deliberately does not alert
every imported record. Other legacy direct lead insert paths are not implicitly
covered; confirm the pilot's actual acquisition path in acceptance.

The alert contains only generic text and opaque organization/lead IDs. It does
not contain a customer name, address, phone, email, service need, message body,
session, or provider key. The same-origin link is `/leads/<uuid>?organizationId=<uuid>`.
Authentication, active membership, server tenant scoping, and a client organization
check remain required on click. A link is not an access grant. No CRM data should
be cached by the service worker or in its notification payload.

Apple supports Web Push for installed Home Screen web apps. Notification permission
must follow an explicit user interaction; installation does not grant it. The
implementation must be tested on each owner's actual supported device, with its
Focus/notification settings. Background delivery can be delayed or unavailable;
keep a staffed lead queue and a separate agreed urgent-call workflow. See
[WebKit's Home Screen Web Push guidance](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

## Configuration, disabled by default

Review/apply the additive schema for `staff_push_policies`,
`staff_push_subscriptions`, and `staff_push_deliveries` only to an approved
environment. No new database cluster is required.

Server-only configuration:

- `WEB_PUSH_ENABLED=true` is required for dispatch. Every other value disables it.
- `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, and
  `WEB_PUSH_VAPID_SUBJECT` must form a valid P-256 VAPID pair and contact URI.
  Only the public key may be exposed to the signed-in browser.
- `OAUTH_TOKEN_ENCRYPTION_KEY` protects each endpoint and device keys at rest,
  bound to the organization/user context. A valid key is mandatory for enrollment.
- `GROWTHOS_OUTBOUND_HOLD=true` blocks dispatch. Invalid hold values also block it.
- Staging additionally requires `GROWTHOS_OUTBOUND_HOLD=false`,
  `STAGING_OUTBOUND_APPROVED=true`, and `STAGING_PUSH_USER_ALLOWLIST` containing
  exact approved GrowthOS **user IDs**, not emails, wildcards, or whole tenants.
- Normal scheduler execution must be available to drain the queue; an explicitly
  held `SCHEDULER_AUTOSTART=false` does not provide live staff notification delivery.

Do not turn these on merely because code tests pass. Keep existing holds until the
release/recipient/device acceptance is explicitly approved. No endpoint enables
an operator to bypass a hold or broadcast an arbitrary test notification.

## Tenant policy and device lifecycle

An owner/admin saves a complete policy at `PUT /api/v1/staff-push/policy`:

```json
{
  "enabled": false,
  "timezone": "America/New_York",
  "days": [1, 2, 3, 4, 5, 6],
  "opensAt": "09:00",
  "closesAt": "18:00",
  "businessHoursUserIds": ["approved-active-user-id"],
  "afterHoursUserIds": ["approved-active-user-id"]
}
```

This is a schema example, not deployed policy. Days are ISO weekdays (Monday=1).
The time zone uses IANA daylight-saving rules. The lead's creation instant chooses
the local day/time and recipient set. Opening is inclusive; closing is exclusive.
Missing/invalid days, incomplete recipients, inactive/non-member recipients, and
overnight opening/closing windows fail closed. No company name or personal contact
information is hardcoded. Sunday can use the separate after-hours set.

All notification APIs require a current human session; API keys cannot enroll or
manage a person's device. `crm.read` gates status/device endpoints, and active
`crm.write` capability is rechecked for enrollment and actual notification delivery.
Only owner/admin `settings.manage` can read/change policy and view delivery receipts.
Origin-bearing requests must match configured `APP_ORIGIN`; responses are no-store.

- `GET /staff-push/status`: safe current-user/current-session status, eligible,
  configured/held state, public VAPID key, own device receipt IDs and expiries.
- `POST /staff-push/subscriptions`: browser-standard endpoint/keys, encrypted at
  rest; at most five active devices per user. No caller user/tenant selector.
- `POST /staff-push/subscriptions/revoke`: an optional current endpoint, otherwise
  all devices for this session; cancels pending rows and erases device credentials.
- `GET /staff-push/policy`, `PUT /staff-push/policy`: tenant owner/admin policy.
- `GET /staff-push/deliveries`: at most 100 tenant-only allowlisted receipts.

Device leases expire at the earliest of seven days, session expiry, and browser
subscription expiry. Renew only an already opted-in same-account browser device
on authenticated app visits. Logout deletes the session and invalidates device
enrollment server-side; the browser must also unsubscribe, erase its opt-in marker
and close visible notifications. Account switches must not retain the former
identity's opt-in or lead data. An endpoint cannot silently transfer across users
or organizations; unsubscribe and opt in afresh. Old/expired sessions cannot be
refreshed by this background worker. Membership/role changes and deactivation are
rechecked immediately before dispatch. Already in-flight generic notifications
cannot be recalled, and clicking them still requires current authorization.

## Durable execution and honest receipt semantics

The unique `(organization_id, lead_id, subscription_id)` owns a notification.
Pending work survives process restart and is claimed atomically before any
external call. Each worker cycle handles at most ten queued device alerts, with
at most five seconds for each provider request including DNS and response.
Normal scheduler exclusion reduces overlap; the database claim is the per-effect
duplicate guard. A claimed row abandoned for two minutes becomes `indeterminate`,
never automatically replayed. A timeout/ambiguous provider response is also
indeterminate. Do not delete/recreate receipts to force a retry.

Held/disabled fresh work remains pending. Queue age is limited to 15 minutes;
stale alerts expire instead of flooding phones when a hold/outage ends. Provider
TTL is only 60 seconds. Policy changes, logout, revoked devices, changed membership
or an unapproved recipient cancel the pending recipient effect at dispatch.
Definitive 404/410 responses revoke only that matching device. HTTP 2xx is
`accepted`: **provider acceptance, not received/read, a response, or a new-lead
follow-up**. There is no automatic escalation based on an unproven phone receipt.

Audit records cover policy/device changes without endpoint, keys, session IDs or
customer content. Delivery rows retain the state and allowlisted reason/status
only. This feature's receipt/deletion behavior does not implement whole-account
privacy lifecycle, legal retention, monitoring coverage or client launch gates.

## Network and acceptance controls

The initial supported endpoint allowlist is deliberately narrow: Apple
`web.push.apple.com/<token>`, Chrome/FCM `fcm.googleapis.com/fcm/send/<token>`, and
Mozilla `updates.push.services.mozilla.com/wpush/v2/<token>`. Unknown provider
shapes (including Windows-specific push URLs) need a reviewed/tested addition;
they are not accepted as generic URLs. HTTPS only, canonical host/path, no query,
credentials, fragment, alternate port, IP literal or redirect. Every DNS result
must be a public address; transport pins a checked result and verifies TLS for
the original provider hostname. Response bodies and errors are never logged.
[web-push's request-generation interface](https://github.com/web-push-libs/web-push#generaterequestdetailspushsubscription-payload-options)
is used for standard VAPID/encryption; the app owns the bounded HTTPS transport.

Provider-free local verification uses the existing disposable PGlite runner and
mocked DNS/HTTPS/provider transport. Do not point test fixtures at a live DB:

```text
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/services/staff-push-policy.test.ts src/services/staff-push-transport.test.ts src/services/staff-push.test.ts
```

Before calling this pilot-ready, verify reviewed schema and exact build on held
staging; actual approved tenant/member policy; installed iPhone opt-in and renewal;
foreground/background/locked-screen receipt; click/login/org mismatch; another
tenant cannot enroll/read/send; both daytime recipients and after-hours routing;
logout/revocation/STOP-relevant manual SMS eligibility; stale/offline queue and
provider 404/410; and staff review of expired/indeterminate work. Record actual
staff-confirmed device evidence separately from accepted provider receipts.
