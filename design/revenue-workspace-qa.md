# GrowthOS Revenue Workspace v1 — design and acceptance QA

Date: September 14, 2026

**final result: passed** — local v1 scope only. No open P0/P1/P2 issues found in the exercised flows.
This is not production readiness, a penetration test, live-provider acceptance or proof of business lift.

## Scope and environment

- Canonical GrowthOS checkout; existing product components, colors and navigation preserved.
- `http://127.0.0.1:5173/`, API loopback port 3001, guarded local PostgreSQL port 55432.
- Provider credentials excluded from the API/test runner. All browser records labelled local QA;
  no real customer details, outreach, payment, publishing or production changes.
- Separate owner, platform-operator and customer-portal sessions; no membership impersonation.
- Desktop viewport 1280 wide; mobile 390 x 844. Temporary mobile viewport reset at handoff.

## Automated evidence

| Check | Result |
| --- | --- |
| Guarded API/tenant/action/portal/Smart Site regression | 194 passed, 19 test files |
| Complete command-center Vitest suite | 232 passed, 43 test files |
| Full workspace type checks + API/UI build | Passed |
| Git whitespace/conflict diff check | Passed |
| Reusable skill official quick validator | Passed using existing Python/uv cache |

Critical tests include concurrent execution ownership, no replay after uncertain outcomes, stale
approval rejection, late worker reconciliation, scheduling once, tenant/role boundaries, money-source
idempotency, approved room snapshots and history, customer ownership, atomic OTP consumption/attempt
limits, and existing private-photo authorization/stream-failure behavior. Error/empty/blocked states
and permission-sensitive UI are covered; automated tests do not prove live message delivery.

## Actual browser acceptance

1. Owner claimed a fictional lead. Assignment persisted and did not falsely count as customer contact.
2. Prepared proposals, reviewed and approved a task, then explicitly executed it. One task receipt
   appeared (`a332e111-5a9e-48ea-84bd-1cbdda6450f9`); approval alone did not execute it.
3. Edited an email draft. Approval remained disabled until save; the approved send was visibly blocked
   because this responder has no Gmail connection. No message was sent.
4. Saved eight explicitly approved LOCAL QA knowledge fields as version 1 and verified after reload.
5. Approved a private customer package from the sent $12,800 synthetic estimate with scope, two material
   options and warranty copy. Portal code opened only the permitted customer's package, not the staff CRM.
6. Customer question saved successfully. The Revenue Desk prioritized that question over stale recovery.
   Closing the project room displayed “Your session was revoked” and returned to sign-in.
7. Recorded fictional $18,450 receipts and $10,200 direct costs with source references; $8,250 displayed
   as recorded contribution, not profit. Evidence drill-down and the integrated `/reports` ledger loaded.
   Entry dates displayed September 14 (UTC), not the preceding local calendar date.
8. Prepared, edited, saved and factually approved a completed-project story. Status stayed
   **Approved draft — not published**; nothing was published or sent.
9. Separate operator sign-in showed allowlisted client health, stale credential checks, knowledge
   versions, staffing and unowned/overdue counts. Paused/unconfigured clients were not presented as ready.
10. Owner Revenue Desk and customer room inspected at desktop/mobile sizes. No horizontal overflow
    (375 document pixels within 390 viewport; 1265 within 1280). Final warning/error console: empty.

One earlier operator session rendered an authentication error. Direct local authentication/read-only
health and a fresh UI sign-in succeeded; the working state was rechecked and captured. No authentication
logic was weakened, and the initial error was not silently relabelled a success. Cause not established.
Customer photo fixtures were not populated for visual acceptance; private loading/error UI and existing
server ownership/stream tests are the evidence for that path, not a claimed live customer upload.

## Issues found and fixed

- Header actions squeezed the desktop title: moved row layout to the wider breakpoint and bounded actions.
- Initial missing costs could imply zero/profit: missing categories now say Not recorded, and contribution
  stays unavailable until both receipt and cost evidence exist.
- Date-only financial input could display the preceding US date: made the UTC event-date semantics explicit.
- Approval could race a saved draft: exact-payload compare-and-set plus transactional audit, with regression tests.
- Concurrent OTP use/failed attempts and interrupted/late execution states hardened and regression-tested.
- Mobile evidence was recaptured after viewport layout settled; screenshots below are the final artifacts.

## Visual artifacts

- [Revenue Desk — desktop](revenue-workspace-qa-2026-09-14/revenue-desk-desktop.png)
- [Revenue Desk — mobile](revenue-workspace-qa-2026-09-14/revenue-desk-mobile.png)
- [Value ledger — desktop](revenue-workspace-qa-2026-09-14/value-ledger-desktop.png)
- [Customer room — desktop](revenue-workspace-qa-2026-09-14/customer-room-desktop.png)
- [Customer room — mobile](revenue-workspace-qa-2026-09-14/customer-room-mobile.png)
- [Client operations — desktop](revenue-workspace-qa-2026-09-14/client-operations-desktop.png)

## Nonblocking maintenance and release gates

Existing pnpm configuration, Vite esbuild/oxc deprecation, Google-font import ordering and large-bundle
warnings remain. Builds succeed; these warnings are recorded, not claimed fixed by this release.

External communications/OTP delivery, accounting reconciliation, calendars/signatures/payments,
publishing/SEO, agent knowledge adapters, measured ROI/unit economics and production backup/schema/
rollout checks are not accepted here. Follow `../REVENUE-WORKSPACE.md` and keep Launch Guard and the
Painless production capture pause intact until separately approved owner-visible acceptance/activation.
