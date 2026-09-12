# Smart Sites recovery and staff follow-up

September 12, 2026 — local acceptance passed. Not deployed or activated on either public site.

## What changed

Painless now has a separate encrypted delivery journal (`worker/lead-outbox.js`). GrowthOS remains
the only operational customer/lead system; the website journal is not an editable CRM. The journal
uses Sites D1-compatible prepared SQL and a generated, inspected Drizzle migration. Local verification
uses the same SQL through Node SQLite in Painless `.local/smart-sites/outbox.sqlite`.

The journal commits before any upstream request. AES-256-GCM binds the payload to the journal ID,
site ID, destination origin and request UUID. Neither the GrowthOS credential nor plaintext contact
details are stored in a journal row. Delivered rows retain IDs/hash/timestamps but clear ciphertext.
This is logical payload removal, not a claim of physical erasure from database backups.

| Website result | Actual evidence |
| --- | --- |
| `prepared-locally` | No connected delivery; only the open browser form exists. |
| `queued` / HTTP 202 | Separate durable journal committed. GrowthOS has not confirmed a lead. |
| `needs-review` / HTTP 202 | Journal retained; operator attention needed. Phone path remains visible. |
| `saved` | GrowthOS returned actual lead and receipt UUIDs. No booking/dispatch/email claim. |
| Error / HTTP 503 | Journal unavailable, configuration incomplete or capacity reached; no queued acknowledgment. |

Retries use the original normalized body and request UUID. The GrowthOS unique receipt reconciles a
commit whose HTTP response was lost. Atomic 60-second claims and fencing tokens stop concurrent/late
workers from overwriting newer results. Network attempts time out after 8 seconds. Backoff starts at
30 seconds and caps at an hour. Permanent 4xx failures, 20 attempts, or 72 hours enter review; nothing
is silently discarded. At most 1,000 pending/review rows per site/destination are admitted. Old rows
never move to a different tenant or destination just because configuration changes.

The local preview retries every 30 seconds (skipping overlapping drains). Each drain handles up to
five due records. Hosted scheduled execution is **not provisioned or verified**. The server-only
`POST /api/internal/lead-outbox` accepts a separate 64-hex-character operations bearer credential,
rejects browser Origin headers, and exposes counts and up to 25 review references/reason codes—no
contact data. Empty JSON drains due records; `{ "inspectOnly": true }` only reports status;
`{ "retryReference": "<journal UUID>" }` requeues a reviewed record in the configured partition.
Changing malformed contact data or transplanting an old record into another tenant is not supported.

## Staff workflow and measurements

GrowthOS `/capture` now includes **No inquiry left waiting**:

- Organization-scoped pending queue: oldest deadline first, maximum 25, plus all-time counts.
- Explicit claim/reassignment with compare-and-set owner checks; inactive, foreign-organization and
  read-only viewers cannot be selected through the Smart Sites owner endpoint. Lead and open intake
  task assignment commit together. Normal single/bulk CRM assignments also synchronize open Smart
  Site intake tasks; inactive users are rejected by canonical reference validation.
- Owner/admin first-attempt target setting, 5–10,080 minutes, defaults to 60. It applies only to
  future receipts. This is an elapsed 24/7 internal goal, not working hours or a customer promise.
- The queue forwards its server receipt time in the authenticated `x-smart-site-received-at` header.
  GrowthOS validates that timestamp (up to 30 days past / five minutes clock skew), clamps future
  skew, and snapshots `siteReceivedAt` and `responseDueAt`. Time spent in an outage is not hidden.
- Staff explicitly confirms a contact attempt after performing it. Phone outcomes: no answer,
  message left or conversation. Email/SMS: staff says sent. This control sends **nothing**.
- Append-only `smart_site_followups`, activity and audit records identify the actor, channel,
  outcome and server recording time. Stable action UUIDs prevent duplicate retry logs; changed
  payloads with the same UUID conflict. API keys cannot impersonate a confirmed staff-session log.
- Only this explicit evidence stamps `firstAttemptAt` and closes the initial review/respond task.
  Notes, stage changes, capture, assignment and unverified provider acceptance are not counted.
- The reported median is **time to first staff log**, not independently verified response time,
  successful delivery, customer reply, revenue uplift or agent performance. Historical receipts keep
  missing deadline fields null; no invented historical deadlines or outreach are backfilled.

## Local runbook

Preserve Docker `mogulforge-smart-sites-dev` / PostgreSQL `mogulforge_smart_sites_test` on
`127.0.0.1:55432`. The API runner fixes that URL and strips inherited provider credentials.

1. Build GrowthOS API; run `node scripts/smart-sites-local-run.mjs api` in `artifacts/api-server`.
2. Reuse GrowthOS frontend at `http://127.0.0.1:5173/capture` (API port 3001).
3. In Painless run `node scripts/smart-sites-local-preview.mjs`. It reads only the local connection
   fixture, migrates only its local SQLite file and starts `http://127.0.0.1:4173/` with recovery.
4. Painless keeps local encryption/operations keys in ignored `.local/smart-sites/outbox-keys.json`.
   Never print or commit these or the GrowthOS `.local/smart-sites/painless-connection.json` secret.
   If a database exists but its key is missing, restore the original; the launcher refuses to replace it.
5. Use `node scripts/smart-sites-local-recovery-check.mjs` in the API directory for read-only fixture
   inspection. `--seed-overdue` explicitly creates one idempotent synthetic earlier-timestamp test.
6. To repeat outage testing, resolve and verify the exact loopback API process before stopping it.
   Submit labeled synthetic data; restore the guarded API; confirm one lead/task per request and
   empty ciphertext after delivery. Do not stop production processes or use real contact details.

## Verified evidence

- Backend: 85/85 targeted tests; frontend: 208/208 tests; Painless: 41/41 tests. Both TypeScript
  checks, both GrowthOS builds and the Painless package build pass. Existing font-order/chunk-size
  warnings remain; no Lighthouse/performance certification is implied.
- Secret boundary check tested the three actual local fixture secrets against built client/server
  artifacts and Git diffs; none appeared. Journal query-plan test confirms use of its due-work index.
- Controlled browser outage, Painless process restart and automatic recovery:
  - Journal `c1a043a1-3300-458c-b46f-52eb2b16b616` → lead
    `18dbd2e9-658e-4b1a-92d7-a6eabe716269`, receipt `ff802cab-1b95-4793-9e02-2b787dccc2e7`.
  - Received 17:20:30.566 UTC; CRM saved 17:21:40.145 UTC. Two attempts, one lead/task; ciphertext null.
  - Browser claimed the synthetic lead and logged one simulated QA phone attempt at 17:22:35.443 UTC.
    No actual call was made; the record is in the explicitly labeled disposable local test workspace.
- Original damage journey outage: journal `80eb6bf0-5a60-4abc-98b7-58c1859710ce` → lead
  `007d6762-114f-457e-88fd-ec85f31b2312`, receipt `76c73dbd-731c-4cf9-92fe-4dfcde4e5d72`.
  Two attempts, one lead/task, ciphertext null after automatic recovery.
- `Local Overdue SLA QA` lead `8dd58825-40f0-440e-9f2f-471e0a33abe0` is deliberately timestamped
  two hours earlier to prove the overdue surface. It is not a real missed customer deadline.
- Fixture now has six synthetic inquiries, six initial tasks (one completed), one staff QA log,
  five unassigned/awaiting attempts, one simulated overdue, zero wins and zero contract value.
- Desktop 1440 and mobile 390/320 CSS widths inspected; no horizontal document overflow. Queued
  receipts use an amber clock, while completed CRM receipts retain the success mark. Mobile owner
  fields stack to preserve names. Final inspected console warning/error lists were empty.
- Browser evidence: Painless `design/qa-recovery-2026-09-12/` and `design/recovery-qa.md`.

## Not yet live / release gates

No deployment, Git push, hosted D1 creation/migration, DNS change, real message, paid provider call,
production tenant edit, marketing-repository change, or automatic campaign enrollment occurred.

Before a public rollout: approve exact release/tenant and staff access; inspect/back up PostgreSQL
schema changes; provision/apply Sites D1 migration; securely install/back up keys; verify a scheduled
drain and an operator alert/review destination; agree retention and dead-letter resolution;
add appropriate edge rate/bot protection; verify public HTTPS with labeled end-to-end acceptance.
Capacity limits and queue encryption are not a complete public-form abuse/privacy launch review.
Key-ring rotation, aged-data deletion, full event history and provider-verified outreach metrics are
not implemented. Existing untracked `pnpm-workspace.yaml.bak` was not modified.

Next build priority: **repeatable isolated client onboarding and a truthful connection-readiness
checklist**, before activating any production tenant. Then consented acquisition events, indexable
service/project pages, provider communications and verified revenue/cash/job-cost joins.

Implementation references: [Cloudflare D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/),
[D1 database operations](https://developers.cloudflare.com/d1/worker-api/d1-database/).
