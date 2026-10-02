# Held staging scheduler probe

This is a code-only acceptance harness for the `c050067000f3ea1f2d94aa53b3a9c4f71f0d3b41`
image, not a new application build or approval to enable customer work. Upload
`pilot-scheduler-probe.mjs` and `pilot-scheduler-runtime.ts` together under
`/app/scripts` in that already-approved image. Run with `node`; no arguments,
connection URL, credentials or user data belong on the command line.

Required private environment (the database URL is supplied through the existing
secure mechanism, never pasted into logs):

- `FLY_APP_NAME=mogulforge-growthos-staging`
- `APP_ORIGIN=https://mogulforge-growthos-staging.fly.dev`
- `SCHEDULER_AUTOSTART=false`, `GROWTHOS_OUTBOUND_HOLD=true`
- `STAGING_OUTBOUND_APPROVED=false`, `STAGING_SCHEMA_PUSH_APPROVED=false`
- `PILOT_SCHEDULER_PROBE_APPROVED=true`
- `RESTORE_DRILL_RELEASE_SHA` and `RESTORE_DRILL_IMAGE_REF` equal the harness's
  pinned SHA and image digest. Correlate the digest with the actual Fly Machine
  record; environment assertions alone are not independent image attestation.
- `DATABASE_URL` pins `pgbouncer.zp2wjrejd2zodn4q.flympg.net`,
  `growthos_staging`, and `growthos-staging-live`. Only the ordinary 5432 port
  and optional `sslmode=require` parameter are accepted. Source pool mode must
  remain the separately verified **Session** mode.
- No `RESTORE_DRILL_ONLY`, enabled `AUTO_MIGRATE`, or connection overrides such
  as `PGOPTIONS`. The harness never edits the app configuration or secrets.

The only permitted organizations are the two deterministic, non-contactable
`restore-drill-pilot-a` and `restore-drill-pilot-b` fixtures. All scheduled,
reactivation and webhook queues must be empty; live callbacks, campaigns,
contactable identities, active service obligations and similar possible effects
cause rejection before importing the runtime or writing a row. Resolve unexpected
data under its own approval; never clear a queue simply to make this probe pass.

The harness verifies the LF-normalized source hashes of the real scheduler
runtime and DB entry/schema, and the helper's entire allowlisted content. It
then uses the actual `runSchedulerCycle` with fixed synthetic observer callbacks.
It does not import the real scheduler, automation service, app or providers.

Two pooled observer sessions remain checked out throughout. The checks establish
distinct, stable backend IDs; external-lock and concurrent-cycle exclusion;
release/reacquisition; running, completed, failed and recovered heartbeat states.
Only a random `pilot-scheduler-probe-<UUID>` runtime row may be created and deleted.
An existing row is never replaced, a changed owner is preserved and reported as
incomplete cleanup, and the normal `automation` runtime row must remain unchanged.
Connections are closed, and success evidence is emitted only after own-row cleanup.
The probe never runs `pg_advisory_unlock_all()` or broad table cleanup.

Timeouts use the driver's bounded connection/query waits plus an explicit SQL
`SET statement_timeout = '8s'` after each session connects. Do not move that
setting into the PostgreSQL startup options: PgBouncer may reject the startup
parameter before a session or preflight exists. The runtime pool's verified
checkout hook waits for the SQL setting before releasing each new connection.
The driver query timeout is 10 seconds so the server's 8-second cancellation
can report its SQLSTATE first, instead of losing that evidence in a timeout race.

Output is aggregate booleans, source/image identity and backend process IDs,
never credentials, recipients or message payloads. Raw errors become fixed labels,
a fixed execution stage, an allowlisted error category, and only an explicitly
allowlisted SQLSTATE. Reservation failures also include bounded elapsed time
and the random probe runtime name. SQL text, message/detail/hint, URLs and
credentials from a driver are never echoed. A lost insert acknowledgment is
marked `reservationMayHaveCommitted`; inspect only that exact name/owner before
any recovery cleanup. A failed/uncertain reservation is never a successful probe.
An interrupted process may leave its random runtime row; do not delete anything
outside that exact recorded probe identity without inspection and approval.

This evidence does **not** establish normal scheduled-job processing, process
restart safety, always-on idle cycles, provider delivery or controlled-pilot
readiness. Those remain separate acceptance gates. Local script tests use mocks;
the isolated PGlite runtime tests deliberately skip independent-session exclusion.
