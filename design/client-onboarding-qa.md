# Client Launchpad QA

Date: September 12, 2026. Scope: new GrowthOS local client onboarding and readiness controls.
Existing platform/Smart Sites styling extended; no website redesign or new visual mockup workflow.

## Acceptance

- Fresh local API + isolated PostgreSQL, real browser and synthetic operator account.
- Organization-owner access denied; separate platform operator has navigation and setup controls.
- Browser-created HVAC, commercial construction and tea-shop drafts persist with correct profiles,
  separate organization IDs and disabled intake. No owner account membership changes or copied leads.
- Explicit creation confirmation; mobile fields, profile preview and non-default 120-minute target work.
- Successful save feedback receives focus; adjusted scrolling to keep it clear of mobile navigation.
- One-time QA credential requires confirmation, is issued for the selected site only and hides correctly.
  No screenshot or tool output includes its plaintext. Painless's installed credential was not rotated.
- Secret-free server handoff expands and fits at 320px. Copy/hide controls covered by interaction tests;
  copied key contents were not inspected through the browser or clipboard.
- Painless credential-only handshake was verified against the local API; UI shows Verified with the
  explicit credential-only limitation. Existing six synthetic receipts remain unchanged.
- Historical issuance timestamp stays unknown; UI advises preserving a functioning historical key.
- Client selection does not change the operator sidebar identity or expose another client's CRM link.
- Readiness distinguishes configured, issued, verified, observed, disabled and not assessed states.
  Error/malformed-response, stale check, version conflict and retry UUID behavior have regression tests.
- Layouts inspected at 1440, 390 and 320 CSS pixels. Document scroll widths were respectively
  1425, 375 and 305 (browser scrollbar excluded); no horizontal document overflow.
- Final inspected warning/error console list was empty. Existing build-time font/chunk warnings
  are separately documented; no performance certificate or full legacy-app accessibility audit implied.

## Issues corrected

- P1: Added missing earlier Smart Sites endpoints to the route-permission inventory and asserted
  fresh platform-admin middleware on every platform route. Endpoint gates already existed.
- P2: Added discoverable platform-only Client Launchpad navigation.
- P2: Removed a nested main landmark introduced by the page wrapper.
- P2: Added explicit save status/focus/scroll feedback; clear it when selecting another client.
- P2: Guard malformed readiness counts; don't recommend rotating a working historical key just to
  populate its missing issuance date. No historical timestamps were invented.

Unresolved P0/P1/P2 in the scoped new local flow: none. Staff invitations, cross-org CRM memberships,
production connectivity and release operations are explicit unimplemented boundaries, not QA passes.

Evidence screenshots are in `qa-client-onboarding-2026-09-12/`. No generated screen or synthetic data
is presented as customer outcomes. See SMART-SITES-ONBOARDING.md for tests and fixture IDs.

final result: passed
