# Private website → GrowthOS adapter

This is a working server-side adapter for a Smart Site or an existing website's backend. It is a **private Node deployment candidate**, not a hosted connector. A complete Next.js integration is in the private Climate Simulation Solutions repository (`src/lib/growthos-server.mjs`, `/api/requests`, `/api/requests/status`, `/api/internal/growthos`).

## Runtime boundary

- Node.js **22.13.0 or later**, with native `node:sqlite`, a persistent **local** volume, and a separately supervised retry worker. Verified here with Node 24.19.0. Native SQLite no longer needs the experimental flag in [Node 22.13 documentation](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html); the module's stability classification depends on the installed Node release. The implementation uses APIs present in that minimum release.
- This adapter is not compatible with an ephemeral serverless filesystem, Cloudflare Workers, or shared network filesystems. Do not describe the candidate as deployed or live.
- Use an absolute journal path outside every web-served directory. The code rejects `public`, `.next`, `out`, and `dist` path segments and checks the real parent directory. Host ACLs must restrict the volume and its backup to the service account.
- Use separate server-only site credentials, a 32-byte encryption key encoded as 64 hex characters, and an operator token for any exposed health/drain endpoint. Never place them in client code, public environment variables, request URLs, logs, or the journal.

## API

```js
import { createWebsiteAdapter } from './adapter.mjs';

const adapter = createWebsiteAdapter({
  apiOrigin: process.env.GROWTHOS_API_ORIGIN,
  siteId: process.env.GROWTHOS_SITE_ID,
  siteSecret: process.env.GROWTHOS_SITE_SECRET,
  encryptionKey: process.env.GROWTHOS_JOURNAL_ENCRYPTION_KEY,
  journalPath: process.env.GROWTHOS_JOURNAL_PATH,
});
```

The default allowed API origin is `https://app.mogulforge.ai`. An approved alternative can be supplied through the **server configuration** `allowedApiOrigins`. Paths, credentials in URLs, redirects, and unapproved origins are refused. `allowLocal: true` enables synthetic HTTP loopback only outside production; it never permits a remote HTTP host.

| Method | Meaning |
|---|---|
| `checkConnection()` | Authenticated credential-only handshake; creates no lead, does not activate the site, and returns `publicWebsiteVerified: false`. |
| `submit(intake)` | Commit encrypted intake before the first network attempt; return `saved`, `queued`, or `needs-review`. |
| `lookup(requestId)` | Read only the current destination/site partition's delivery state. No network request. Internal result includes IDs; public wrappers must strip them. |
| `drain()` | Attempt up to five due requests; return safe journal health. Run through an authenticated operator endpoint or a private supervised worker. |
| `drain({ retryRequestId })` | One explicit review retry for an unexpired held request. The request, destination, and original receive time stay fixed. |
| `inspect()` | Counts plus opaque held-request references/reasons/attempt counts. Never returns contact details, request body, or credentials. |
| `close()` | Release this adapter's SQLite handle. |

`adapter.d.mts` contains the complete types. `WebsiteAdapterError` exposes safe `code`/`status` fields; do not return raw exception messages or stacks from a website handler.

## Connection and acknowledgement contract

The adapter calls these existing server-only routes, with `Authorization: Bearer <site-secret>`, no browser `Origin`, and redirects disabled:

1. `POST /api/v1/public/smart-sites/:siteId/check` with `{ "schemaVersion": 1 }`. Validate site ID, credential version, checked time, profile, capture state, and `createsLead: false`. The operator must still review staffing and activate capture through GrowthOS.
2. `POST /api/v1/public/smart-sites/:siteId/intake` with a normalized v1 intake and the **original** `x-smart-site-received-at` timestamp on every retry.

Only a 200/201 response containing `status: "saved"`, UUID `leadId` and `receiptId`, boolean `duplicate`, and `notification: "staff-inbox"` counts as saved. A generic successful status or `{ "ok": true }` does not. A missing responder, disabled capture, paused company, invalid credentials, or rejected/conflicting request becomes a visible hold. No appointment or outbound customer message is created by this adapter.

## Existing website integration example

Keep the existing website and send its form to its own server route. Mount a Node backend using this adapter, or proxy to a separately approved private Node deployment. The original site host still owns origin checks, input mapping, explicit consent, body/rate limits, and error presentation.

The server should construct the following allowlisted shape after validating the local form. Never trust browser-supplied tenant IDs or a claim that consent was collected by a different policy:

```js
const delivery = await adapter.submit({
  schemaVersion: 1,
  requestId: form.requestId, // browser-generated UUID, unchanged for this request's retries
  contact: { name: form.name, phone: form.phone },
  project: {
    serviceCode: mappedServiceCode,
    city: form.city,
    summary: form.details,
    timing: 'soon',
  },
  consent: {
    contact: true, // only after an unchecked, required request-contact checkbox was accepted
    policyVersion: approvedVersionForTheDisplayedCopy,
    channels: ['phone'],
    analytics: false,
  },
});

// Return only a safe delivery state/reference to the browser.
return Response.json({
  status: delivery.status,
  requestId: delivery.requestId,
  appointmentStatus: 'pending_office_approval',
  ...(delivery.status === 'saved' ? {} : { retained: delivery.retained }),
}, { status: delivery.status === 'saved' ? 201 : delivery.status === 'queued' ? 202 : 503 });
```

The CSS integration implements the complete route and UI, including exact configured `Origin` checks, bounded streaming JSON parsing, a process-wide rate backstop, credential separation, explicit contact consent, request-only session storage, and safe public status responses. Analytics/tracking and marketing consent are deliberately unsupported in this adapter version.

### Request identity and editing

- Create a new unpredictable UUID for an intentional new request. Persist only this opaque reference in browser session storage.
- Keep an immutable in-memory snapshot while a submission is uncertain. A retry sends exactly that original snapshot and ID; a changed payload with the same ID returns 409.
- A reload checks status by reference; it does not silently submit another lead. Public status responses must not expose lead IDs, receipt IDs, customer fields, configuration, or journal paths. Require the exact approved origin and rate limiting.
- If a visitor deliberately starts a separate request while the original is uncertain, explain that the earlier request may still arrive. Do not silently change the UUID during error recovery.
- Keep a requested appointment at `pending_office_approval`, including after a saved inbox receipt.

## Journal and retry rules

SQLite uses WAL, synchronous FULL, a busy timeout, atomic intake insertion, and leased/fenced claims. AES-256-GCM encrypts payloads with destination/site/request identity as authenticated context. The database stores neither the encryption key nor the site credential. A wrong/missing encryption key fails closed.

The journal partition includes API origin and site ID. Reconfiguring either cannot drain a former destination's work. Secret rotation for the same site can recover held work only after the operator reviews the changed credential/capture state.

- Uncertain failures retry after 30 seconds, backing off to one hour.
- Automatic retries stop after 20 attempts or three days and require review.
- Encrypted payloads expire after seven days; inspect/status exposes expiry rather than inventing delivery. Saved payload ciphertext is removed immediately.
- Minimal idempotency/receipt metadata is retained until a reviewed archive/deletion procedure; it is **not** automatically purged to free capacity. The journal has a hard maximum of 10,000 records and a 256 MiB SQLite page cap. Capacity exhaustion refuses new intake visibly. Monitor both available disk and journal health.
- The adapter never starts a background task by itself. Configure a supervised private worker or authenticated drain schedule and an office/operator review process before accepting real requests.
- Restoring an old journal without the matching encryption key and destination configuration is not a valid recovery. Pending journal records also belong in customer export/deletion and incident procedures; the main GrowthOS database export does not include an external website's local volume.

## Local verification

```text
node --test examples/website-connection/adapter.test.mjs
cd artifacts/api-server
node scripts/test-scheduler-isolated.mjs src/services/smart-site-lifecycle-race.test.ts src/routes/v1/beta-company-rehearsal.test.ts
```

Tests use generated synthetic records and loopback only. Independent PostgreSQL session-lock tests run in CI and are explicitly skipped by the single-session PGlite harness. A green local run does not prove live provider, public domain, office response, or production restoration behavior.
