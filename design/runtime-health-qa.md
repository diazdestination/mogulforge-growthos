# GrowthOS reliability and BIE copy QA — September 29, 2026

Scope: the canonical private GrowthOS application; no public marketing repository, live client account, provider, hosting configuration or production database was changed.

Local automated evidence:

- Scheduler runner: 31 passed, 1 intentionally skipped (independent PostgreSQL session-lock exclusion cannot be verified by the PGlite multiplexer). Normal CI must run that check on PostgreSQL.
- Command Center: 240 tests passed across 46 files after the BIE copy and runtime panel changes.
- Workspace TypeScript checks and both production builds passed. Existing Vite font-import and bundle-size warnings remain.
- Real child-process kill/restart: one synthetic committed task remained exactly once, its incomplete receipt became indeterminate, and the replacement completed another due task.
- API authorization: active platform admin allowed; unauthenticated, ordinary org owner, inactive admin, and API-key access rejected. Aggregate response excluded seeded private payload/error markers.

Browser evidence:

- Real API/routes and built UI at `http://127.0.0.1:4192`, disposable local operator and fictional data; no inherited provider/account credentials. The preview excludes concurrent legacy startup seeds because PGlite is a single-backend emulator. Production bootstrap is verified by the separate Docker/CI gate, not this preview.
- Desktop override 1280 × 900 and phone override 390 × 844. Phone document client/scroll widths both 375 pixels (remaining viewport width is the scrollbar): no horizontal page overflow.
- Runtime panel displayed recent worker progress alongside one deliberately uncertain execution and one historical failed scheduled record. The interface warned against resending and identified the owning client below.
- Unit checks separately cover stale/degraded/unavailable states and hiding previously healthy data when refresh fails.
- Landing page now identifies a Business Intelligence Ecosystem, explains lead-to-next-action value, and discloses provider setup/launch verification. Mobile navigation was shortened to prevent wrapping.
- Temporary viewport overrides were reset after verification. The local preview is disposable and is not evidence of live delivery, always-on hosting or paid-beta readiness.

Screenshots: [runtime desktop](runtime-health-desktop.png), [runtime phone](runtime-health-mobile.png), [BIE landing desktop](growthos-bie-landing-desktop.png), [BIE landing phone](growthos-bie-landing-mobile.png).

See [scheduler operations](../SCHEDULER-OPERATIONS.md) for deployment constraints, operating-cost assumptions, safe incident handling and remaining legacy failure windows.
