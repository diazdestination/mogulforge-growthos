# Public liveness and database readiness

These probes are operational checks, not proof that a contractor is onboarded or
that email, SMS, phone, AI, calendar, payment, or scheduler workflows work.

## Contracts

- `GET /api/healthz` remains HTTP 200 with exactly `{"status":"ok"}`. It checks
  that the process can serve a request; it does not contact the database or a
  provider. The existing liveness contract is unchanged.
- `GET /api/readyz` returns HTTP 200 when a fresh or at-most-one-second-old
  read-only `SELECT 1 AS ready` succeeds. Failure returns HTTP 503. It sends
  `Cache-Control: no-store` and exposes only the fields below.
- `HEAD` has the corresponding status without a body. Express's existing
  case-insensitive and optional trailing-slash aliases work for both probes.
  Only those exact GET/HEAD paths skip cookie/session/OIDC processing. POST,
  nested paths, neighboring paths, and protected APIs retain normal auth.

Example successful response:

```json
{
  "status": "ready",
  "database": "reachable",
  "release": {
    "sha": null,
    "builtAt": "2026-10-01T12:34:56.789Z",
    "environment": "staging"
  }
}
```

On failure, `status` is `not_ready` and `database` is `unavailable`; the release
object remains available. There are no database names, hostnames, credentials,
raw driver errors, tenant details, provider settings, image URLs, or queue data
in this public response.

Readiness uses its own PostgreSQL client instead of waiting indefinitely for the
application's shared pool. Connect timeout is 1,000 ms, query timeout 750 ms,
overall connect/query deadline 1,500 ms, and cleanup deadline 300 ms (plus normal
event-loop scheduling). Concurrent requests share one operation. Results are
internally cached for one second. No startup `statement_timeout` or `options`
parameter is sent to PgBouncer. The client is closed after every attempt; if
closing remains pending or fails, new clients are refused rather than leaked.
A late successful close allows recovery; a failed close requires process
restart. Database reachability does not guarantee migrations, every application
query, shared-pool capacity, scheduler freshness, or provider readiness.

API startup also observes the shared pool's idle-connection error events, after
which `pg` has already removed the failed connection. This prevents an expected
database outage from becoming an unhandled EventEmitter exception. The log uses
only a fixed `database_pool_idle_error` event and message, never the raw driver
error or client. It does not retry queries, intercept query rejections, install
process-wide exception handlers, or turn database failures into successful
readiness responses.

## Honest release identity

`sha` and `builtAt` are embedded in the API bundle at build time, not read from
runtime `FLY_IMAGE_REF`, a branch label, or a mutable runtime SHA variable.

- Local builds use the actual full Git HEAD only when Git reports a clean
  tracked and untracked source tree. Dirty or unverifiable source yields
  `sha: null`. A supplied SHA cannot override a known repository's dirty status,
  failed status check, or conflicting HEAD.
- Docker deliberately excludes `.git`. A build may supply a full 40-character
  source revision through the `GROWTHOS_BUILD_SHA` build argument. Omitted or
  invalid input yields `sha: null`; a standalone Docker build still works.
- A supplied Docker revision is an operator assertion about the build context,
  not independent source attestation. Build only from a clean, reviewed checkout
  and preserve the resulting image digest and CI evidence.
- `builtAt` is the API build's UTC time. Unbuilt/source-loaded code has no
  embedded identity and reports null values.
- `environment` allows only `development`, `test`, `staging`, `production`, or
  `restore` from `GROWTHOS_ENVIRONMENT`. Unknown supplied values report
  `unknown`, never the raw value. When the setting is absent, only the known
  GrowthOS staging/production/restore app names or development/test NODE_ENV
  values supply a label; otherwise it is `unknown`.

Example local PowerShell image build (does not deploy or change providers):

```powershell
$sourceSha = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceSha -notmatch '^[a-f0-9]{40}$') {
  throw 'Cannot verify the source revision.'
}
$sourceChanges = git status --porcelain --untracked-files=normal
if ($LASTEXITCODE -ne 0 -or $sourceChanges) {
  throw 'A clean source checkout is required for an exact-revision image.'
}
docker build --build-arg "GROWTHOS_BUILD_SHA=$sourceSha" -t growthos-readiness:local .
```

Set `GROWTHOS_ENVIRONMENT` separately for the runtime. Do not label a dirty build
as the last commit, assume a GitHub PR's `GITHUB_SHA` is the actual checkout, or
equate a revision returned by an HTTP endpoint with a verified deployed digest.

## Verification and rollout boundary

Focused local tests (synthetic, disposable loopback database only):

```powershell
node artifacts/api-server/scripts/test-scheduler-isolated.mjs src/lib/readiness.test.ts src/lib/release-identity.test.ts src/lib/database-pool-errors.test.ts src/routes/health.test.ts
pnpm --filter @workspace/scripts exec vitest run release-identity-build.test.mjs readiness-parity-contract.test.mjs
pnpm --filter @workspace/api-server run typecheck
```

Production-container acceptance, using only the isolated Compose stack:

```powershell
pwsh -File scripts/verify-docker-staging-parity.ps1
```

That script derives the actual clean checkout identity without inheriting a
caller's build SHA, supplies it to Docker, checks the emitted SHA/environment,
and verifies database failure (readiness 503, liveness 200) and recovery
(readiness 200). CI refuses an unverifiable source identity. A dirty local run
instead verifies honest null identity. The synthetic database is the only
database stopped; all outbound sends and scheduler startup are held. The stack
is removed afterward unless `-Keep` was explicitly selected.

Local tests and CI container checks are not hosted proof. A later authorized
held-staging rollout must record its exact source commit, image digest,
environment, readiness response, and probe time before those claims are made.
Do not stop a hosted database to repeat the local outage test. This addition
does not alter Fly health-check selection or enable traffic, outbound delivery,
scheduler startup, campaigns, or providers. Existing hosted scheduler and
restore evidence pinned to the older `c050067` image remains historical; it is
not silently reassigned to a newer readiness build.
