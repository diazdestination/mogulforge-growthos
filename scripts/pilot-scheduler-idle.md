# Bounded real-scheduler idle and ordinary restart acceptance

This operator-run helper exercises the **actual** `startAutomationScheduler()` and all nine `processScheduledWork` stages from the pinned release. It does not bootstrap the HTTP application, accelerate the scheduler, call a synthetic stage callback, import customers, connect providers, or activate the main machine's scheduler.

## Exact target and operator boundary

- Release: `c050067000f3ea1f2d94aa53b3a9c4f71f0d3b41`.
- Image: `registry.fly.io/mogulforge-growthos-staging@sha256:0111edc86aaf844e83b0250be7a9deb7accf604d983a66dfbe876f7cd03a42ce`.
- Fly app: `mogulforge-growthos-staging` only.
- Database: `growthos_staging` on `pgbouncer.zp2wjrejd2zodn4q.flympg.net`, login/current role `growthos-staging-live`; Session pooling must already be independently verified.
- Main app must be stopped, with its persistent `SCHEDULER_AUTOSTART=false` unchanged. The temporary console must have **zero public services**, no restart policy and independently verified auto-destruction. The helper does not call Fly APIs: stopped-main/zero-service fields are explicit **operator attestations**, not self-verified platform facts. Verify exact image/machine metadata independently too.

Only the two deterministic `restore-drill-pilot-a`/`restore-drill-pilot-b` synthetic tenant graphs are permitted. Contacts must be `.invalid`, phone-free and opted out of all channels; users must be `.invalid`, passwordless and non-platform-admin. The read-only preflight refuses action/campaign/webhook/playbook/appointment/conversation queues, active provider connections/bindings or sender configuration, active service obligations, actionable intelligence, portal credential rows and email-retention candidates. The normal `automation` runtime row must be **absent** initially. Never clear a real queue or an unknown runtime row to make this pass.

Held main startup may have seeded two enabled abandoned-chat rules and four templates. The helper allows only complete exact default triplets parsed from the hash-pinned source, with template IDs belonging to their own organization. Customized, partial, foreign or additional rules/templates fail closed. With conversations and all execution queues empty, those defaults cannot generate work. They are not edited or deleted. All organization-owned rows, including templates, are digested before/after; organization records are also included in that mutation check.

## Uploaded files and invocation

Upload only these code files into their corresponding `/app/scripts/` locations in the exact image:

1. `pilot-scheduler-probe.mjs` — common pinned target, source hashes, pg-pool configuration and sanitized diagnostics.
2. `pilot-scheduler-idle.mjs` — this supervisor/private worker.
3. `pilot-scheduler-idle-runtime.ts` — one namespace exporting the actual scheduler functions and shared pool.

No application source or database schema is changed. The helper uses the image's existing `esbuild` to compile its single import helper to a temporary CJS bundle for compatibility with the existing Twilio CommonJS dependency. The build uses source already present in the pinned image, not a downloaded package. Each child removes only its exact generated file and then its empty `mkdtemp` directory on ordinary completion; an ephemeral machine's destruction removes any leftover interrupted temporary file. Do not substitute `tsImport` here: the existing Twilio named-export incompatibility is not addressed by this drill.

Required supervisor environment (in addition to the existing exact staging `DATABASE_URL`, which must never be printed or passed on the command line):

```text
FLY_APP_NAME=mogulforge-growthos-staging
APP_ORIGIN=https://mogulforge-growthos-staging.fly.dev
SCHEDULER_AUTOSTART=false
GROWTHOS_OUTBOUND_HOLD=true
STAGING_OUTBOUND_APPROVED=false
STAGING_SCHEMA_PUSH_APPROVED=false
AUTO_MIGRATE=false
PILOT_SCHEDULER_PROBE_APPROVED=true
PILOT_SCHEDULER_IDLE_APPROVED=true
PILOT_SCHEDULER_MAIN_APP_STOPPED=true
PILOT_SCHEDULER_ZERO_SERVICES=true
RESTORE_DRILL_RELEASE_SHA=c050067000f3ea1f2d94aa53b3a9c4f71f0d3b41
RESTORE_DRILL_IMAGE_REF=registry.fly.io/mogulforge-growthos-staging@sha256:0111edc86aaf844e83b0250be7a9deb7accf604d983a66dfbe876f7cd03a42ce
```

`RESTORE_DRILL_ONLY` and all PostgreSQL override variables must be absent. The helper forbids arguments and arbitrary URLs/SQL paths. Invoke:

```sh
node /app/scripts/pilot-scheduler-idle.mjs
```

Expected healthy duration: roughly 65–85 seconds. The first child must complete two cycles using the source default **60,000 ms** interval; the replacement child must complete one cycle with a fresh source-generated owner UUID. There are bounded cycle, graceful stop, pool-close and force-stop deadlines. This is not a long-running monitor.

## Execution and cleanup

The supervisor holds `growthos:pilot:hosted-supervisor` on a dedicated Session-pooled connection across preflight, both child lifetimes and cleanup. The crash-after-effect helper uses the same lock: they cannot overlap. This is separate from the real scheduler's `growthos:scheduler:automation` lock, which remains implemented by the source scheduler. Losing the supervisor connection initiates child shutdown and prevents success evidence.

Each child receives a positive allowlist of only the database, minimum OS paths, exact identity/holds and a random throwaway session secret. It inherits no Gmail/Resend/Twilio/OpenAI or other provider credentials, no `PRIVATE_OBJECT_DIR`, no `NODE_OPTIONS`, and no billing keys. `SCHEDULER_AUTOSTART=true` exists only in those private children; the main app and console-supervisor hold remain false. `fetch` and HTTP(S) request functions are denied and counted before imports. Any attempted provider HTTP request fails the acceptance even if a stage catches its exception. Upload cleanup is source-defined no-op without `PRIVATE_OBJECT_DIR`.

Successful evidence requires healthy completed cycles, source interval 60 seconds, advancing timestamps/heartbeats, zero network attempts, graceful stopped-state evidence and process exits, a different replacement owner, unchanged tenant digests, and exact owned-row cleanup. Cleanup acquires the real scheduler lock and deletes only the final child-owned, `stopped` `automation` row. A foreign/running owner or unavailable lock is a failure; it is never deleted. If a worker dies without confirming stopped state, no speculative cleanup is attempted. Preserve diagnostics and inspect read-only rather than retrying over an unknown row.

Raw child logs/SDK errors are consumed, never forwarded. Failure output includes only fixed labels/phases, safe error categories and allowlisted SQLSTATE values. Both advisory unlock acknowledgments must return true. Success JSON is emitted only after child, database connection and pool cleanup completes; even a late observer-connection loss during teardown suppresses success. Independently verify the temporary machine is gone and the main machine remains stopped after the console exits.

Run this **before** the crash-after-effect helper, which intentionally retains its synthetic action/receipt/task evidence and therefore makes this helper's empty-queue preflight refuse later runs. A successful result proves bounded real idle cycles and an **ordinary graceful process restart**, not provider delivery, a killed worker's external-side-effect recovery, ongoing production uptime or client onboarding readiness.

## Local verification

```sh
pnpm --filter @workspace/scripts exec vitest run pilot-scheduler-idle.test.mjs
```

The suite covers exact source/configuration guards, tenant/template isolation, shared-supervisor exclusion, credential filtering, redacted diagnostics, lifecycle failure/foreign-owner handling and real SQL over the complete 90-table schema. Its local-only PGlite socket test calls the actual source scheduler, waits through the real minute interval for two completed cycles, and verifies zero provider attempts, graceful stop and unchanged synthetic tenant data. That local test is not Fly/managed-PostgreSQL acceptance; hosted evidence is separate.
