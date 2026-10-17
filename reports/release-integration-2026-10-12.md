# GrowthOS combined release candidate

Adam requested continued GrowthOS progress on October12. This source milestone
combines PR35 and the five prepared launch changes39–43, preserving their original
history on `agent/growthos-release-integration-20261012`. Canonical main was
`7091af816715cfd437925eb0af82fb47d3411e34`. Post-launch36–38 remain separate.

## Resulting behavior

Invoice documents freeze staff-recorded equipment and warranty terms. Warranty
references appear even when dates were not recorded; legacy document fingerprints
and dated output remain unchanged. Display does not assert warranty eligibility.
Housecall customer onboarding previews explicit mappings and imports contacts,
without acquisition leads or automatic nurture/contact. Malformed CSV is rejected;
invalid/unbounded addresses are skipped safely, and valid international phone
formatting and phone-only customers are retained.

Accessibility corrections, the source-backed client acceptance map and isolated
provider-test fixtures are included. Independent review found and corrected the
CSV parsing/address handling, source-only warranty rendering and recovery metadata
retention defects before acceptance. Recovery now preserves every pre-existing
ownership identity and rejects changed, missing or unexpected objects.

## Current local acceptance

- Full disposable PostgreSQL16 gate: **4457 passed**, with15 API tests skipped.
  API2999; Command Center1061; scripts355; React client13; email intake3;
  website adapter26. Completed2026-10-12T15:18:46UTC, exit0.
- TypeScript checks and both production builds passed. Generated clients were
  regenerated with Orval8.23.0 and checked semantically; both feature contracts
  remain present. Formatting-only output was normalized without source changes.
- Docker staging parity passed: restricted schema role, preserved provider-owned
  monitoring view, production routes, readiness identity, database failure/recovery
  and owned stack cleanup. Historical untracked receipts make the local build SHA
  unknown; clean exact-checkout identity must pass in GitHub CI before acceptance.
- Native75 recovery run05010f4b passed both physical layouts, rollback/commit,
  a fresh distinct Reader, provider-style ownership negatives and lost-response
  refusal. All89 clients/sockets and two owned containers closed. This synthetic
  view proves the mechanism; actual provider extension binary compatibility remains
  a hosted gate. All19 reviewed SQL pins and the142-table physical schema remain
  unchanged. The invoice schema file adds TypeScript types to existing JSONB only.
- Browser Harness, fictional loopback4192: malformed file rejected visibly;
  three-row preview reports2new/1skipped and saves nothing; import requires review.
  Save creates2contacts, skips the invalid email and preserves the valid phone-only
  contact. Contacts5→7; leads remain1. Recordings and provider activity disabled.
- Independent final reviews report zero Critical/Important findings. Reviewed
  hashes match current source. Redacted Gitleaks scan passed for the intended
  candidate changes. Earlier FAIL/NO_GO evidence and owned historical files remain.

Local receipts/logs and original normalization copies are under
`C:\Forge\artifacts\growthos-release-integration-20261012`. Additive review receipts
and current summary are published in the companion release-integration directory.
The native immutable receipt and40 journals remain in the production75 report.

## Remaining boundaries

This is source/local acceptance. Exact publication-head GitHub CI is required.
No hosted schema, app, secrets, credentials, provider generation or billing changed.
The production backup restore retry71fed7d3 already passed; its copy was deleted.
The separate hosted75→142 rehearsal/rollback, supported credential retirement,
private runtime/cutover and real client/provider/device/payment gates remain open.

The next-gate design requires a new bounded, independently reviewed one-copy
packet, a supported separate Reader and complete extension/global-role/default-ACL
preservation. Consumed paid grants cannot be reused. Rotation is already approved
but deferred pending a supported legacyV1 procedure or admitted provider migration.
No new financial or public-launch authority is requested by this source milestone.

Real Housecall exports, full jobs/estimates/invoice history, equipment/media migration,
batch correction and contractor workday acceptance remain explicit requirements.
An unused generated Zod saved-import response alias is still preview-only; the
active React client uses the correct union. Preview row/SQL bounds do not constitute
a strict whole-request45second deadline. Phone formatting proves neither routing
nor consent. These limits do not reduce the client requirements.
