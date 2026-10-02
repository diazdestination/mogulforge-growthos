# Website connection reliability — 2026-10-01

## Implemented

- Reusable server-only `examples/website-connection/adapter.mjs` with TypeScript declarations, secure connection check, encrypted durable SQLite journal, stable request IDs, original receive time, destination/site partitioning, fenced retries, safe health/status lookup, explicit review, retention and capacity holds.
- Both Smart Sites and an existing website's backend can submit the real GrowthOS intake contract. The README includes the existing-website mapping/response example and operating requirements.
- A successful HTTP status alone cannot acknowledge delivery. Only a validated saved GrowthOS receipt qualifies. Missing staffing, disabled capture, and a paused company cannot produce an office-saved result.
- Fixed a lifecycle race in `services/smart-sites.ts`: intake and acquisition now take the shared `customer-lifecycle:<organization>` transaction lock **before** their existing capture locks, then recheck lifecycle through the same transaction. Lifecycle changes use the matching exclusive lock. Fixed the acquisition entry guard's missing import.
- Real Climate Simulation Solutions integration is on its own local branch `agent/growthos-website-adapter`, at `C:\Forge\repos\climate-simulation-solutions-smart-site`, started from clean/fetched `b5867bb4d437b9f9caab4c09cf8f675d5dc3a8f3`. Main workspace branch is `agent/growthos-beta-operations`, started from `298b23a`. No commits, pushes, deployments or real provider sends performed by this worker.

## Evidence

- Canonical adapter: **18/18 Node tests passed**. Includes real loopback lost acknowledgement + restart + original-ID reconciliation, mismatched payload conflict, malformed-success refusal, actual disabled/paused states, missing responder hold, explicit review retry, two-handle lease/fencing, destination/key isolation, retry/payload expiry/capacity, and redirect refusal. Independent-review regressions also cover journal-wide erasure after destination changes, observers preserving the live twentieth-attempt claim, successful/failed/crashed attempts at the payload-expiry boundary, and expired metadata never hiding fresh actionable holds.
- API service typecheck passed after lifecycle locking changes.
- Guarded isolated API run: `smart-site-lifecycle-race.test.ts` + `beta-company-rehearsal.test.ts`: **7 passed, 2 skipped**. Both deterministic entry-check/transaction pause races are verified locally. The two independent-session advisory lock tests are PostgreSQL CI gates, intentionally skipped on PGlite.
- CSS actual server handlers: **15/15 Node tests passed**, covering fixed consent copy/version, input/service mapping, exact origin, payload size, five-second request-body deadline/cancellation, rate backstop, safe public status, real journal recovery, saved/held/unknown responses, authenticated operator access, packaged-source digests and disabled worker.
- CSS Next.js production build passed; browser checks used the actual Next routes and a synthetic loopback receiver. Eight desktop/mobile states at 1440/390/320 px: **zero axe WCAG A/AA violations, zero horizontal overflow, zero page errors, zero external requests**. Lost acknowledgement queued/reload/drain, missing staffing/review retry, immutable retry after browser response loss, session-storage reference-only recovery, and keyboard consent all passed. Four intentional synthetic requests produced four receiver records over six attempts.
- Browser evidence is local in CSS `.qa/browser-results.json` and PNGs. This is private synthetic evidence, not a public deployment or actual office response.

## Boundaries before real onboarding

This is a private **Node >=22.13 + persistent local volume** candidate. It is not a Cloudflare/serverless adapter. Approved domain, hosting/runtime choice, credentials, consent-copy approval, volume/backup ownership, supervised retry execution, review alerts, cross-instance abuse protection, and actual office staffing remain real setup gates. No business phone or other missing company fact was invented.

Payload ciphertext expires in seven days and is removed on acknowledgement. Minimal deduplication/receipt metadata remains until reviewed disposal; capacity is capped and fails visibly. Main customer exports/deletion do not automatically cover a separately hosted website journal. The runbook explicitly includes this operational boundary.

Credential checks prove the server holds a site credential. They do not prove the public form's deployment, active staffing, provider delivery, or an appointment. Appointment requests remain `pending_office_approval` throughout.
