# Held staging synthetic crash drill

Run after the idle/restart scheduler probe, with the public staging application
stopped. This is a code-only helper for the exact c050067 image, not a release
or provider-send authorization. Keep the original loopback crash worker and
its guard unchanged.

Upload these three reviewed helper files under `/app/scripts` in that image:
`hosted-pilot-drill.mjs`, `pilot-crash-drill.mjs`, `pilot-crash-runtime.ts`.
The fixture and application source imports are already inside the pinned image.
Then invoke `node /app/scripts/pilot-crash-drill.mjs` with no arguments.

Required private environment:

- Existing source `DATABASE_URL`, exact source cluster `zp2wjrejd2zodn4q`,
  database `growthos_staging`, writer `growthos-staging-live`; never replace
  it with the restored Reader, another cluster or a loopback address.
- `FLY_APP_NAME=mogulforge-growthos-staging` and
  `APP_ORIGIN=https://mogulforge-growthos-staging.fly.dev`.
- `AUTO_MIGRATE=false`, `SCHEDULER_AUTOSTART=false`,
  `GROWTHOS_OUTBOUND_HOLD=true`, `STAGING_OUTBOUND_APPROVED=false`,
  `STAGING_SCHEMA_PUSH_APPROVED=false`, `OBJECT_STORAGE_PROVIDER=postgres`.
- `PILOT_CRASH_DRILL_APPROVED=true` and a fresh 32-character lowercase hex
  `PILOT_CRASH_RUN_NONCE`. The nonce is a public synthetic evidence label,
  not a credential; record it before execution. Never change it just to retry
  after an uncertain result.
- `PILOT_CRASH_MAIN_APP_STOPPED=true` and
  `PILOT_CRASH_ZERO_PUBLIC_SERVICES=true`, after verifying those conditions.
  These are operator attestations, not independent Fly API proof.
- Pinned `RESTORE_DRILL_RELEASE_SHA` and `RESTORE_DRILL_IMAGE_REF` from the
  helper; use the recorded hosted `RESTORE_DRILL_EXPECTED_BUNDLE_SHA256` too.
  Corroborate the actual image digest from the Fly Machine record.

No credentials belong in command arguments, files or logs. The supervisor does
not import provider/application code. Its child environment is allowlisted and
excludes all provider, OAuth, Reader and hosting credentials. The worker imports
the true durable-action and automation services but runs only a fixed internal
synthetic action and then `processScheduledWork` scoped to fixture tenant A.
It never starts the HTTP app or normal scheduler.

Before runtime import, the child blocks and counts `fetch` and Node HTTP/HTTPS
request/get calls. Both checkpoints must report zero attempts. The already
attested helper source is compiled into an ephemeral CJS helper using the same
esbuild approach as the loopback test, because direct ESM import encounters a
Twilio CommonJS compatibility issue. No application source or bundle is changed.

The supervisor requires exactly the two known non-contactable `.invalid`
restore tenants, no existing scheduled actions, no active provider bindings,
and no actionable queues. Inert boot-seeded abandoned-chat rules are tolerated
only for the known seed/event; no event is emitted, no conversations exist,
and the global abandoned-chat stage is never run. It holds the normal scheduler
advisory lock as a safety interlock for the whole experiment.
It also holds `growthos:pilot:hosted-supervisor`, shared with the idle probe.
Losing that connection immediately requests termination of every owned child
and fails the run. Cleanup attempts every owned child, exact lock and connection
even if an earlier cleanup step fails.

Exactly two nonce-derived scheduled actions are inserted once. The first owns
its real durable receipt, commits a deliberately labelled synthetic task INSERT
and audit, signals the supervisor, then waits. The supervisor independently
checks the committed task and still-processing receipt before killing only its
own child. This first effect models the same boundary as the existing loopback
test; it does not claim the private first-action dispatcher executed.

Only that exact first processing receipt's expiry is moved to epoch, with an
explicit synthetic-clock audit. This avoids waiting 15 minutes; it does not
prove a real 15-minute wait. A fresh child runs the real organization-scoped
scheduled-work processor. Acceptance requires one task per action, first receipt
indeterminate/first action failed, second receipt succeeded/second action done,
four matching receipt events, operator-health visibility, and unchanged normal
scheduler runtime. No blind replay or reconciliation is performed.

All records remain as evidence. No records are deleted. A successful run
intentionally invalidates the earlier empty-queue preflight. Any interrupted or
uncertain attempt is reported with the nonce and exact action IDs; inspect those
identities under separate review instead of rerunning, clearing rows or choosing
a new key. Both same-nonce and new-nonce seeding refuse existing scheduled work.

Driver connections and queries, child phases and child lifetime are bounded.
Child output is drained without echoing it. Failure diagnostics contain only
fixed phase/error labels and allowlisted SQLSTATE; success contains counts,
synthetic IDs and explicit evidence limitations, never task text or credentials.
