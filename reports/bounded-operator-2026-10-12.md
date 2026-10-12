# Supplied-client production-copy lifecycle

Based on reviewed PR45/283715f, with PR44/8df64dc application candidate unchanged.
New modules implement immutable admission, exclusive durable custody, a pinned
V1 protocol adapter, exact additive Reader proof and composition around the
existing production75 verifier. No application, 19SQL or prior verifier changes.

## Responsibilities

- `production75-custody`: exact plan/owner/capability binding; exclusive directory,
  fsynced hash-chain intents and one-use opaque permits; restart is reconciliation
  only. Protected/existing/foreign/attached resources cannot become owned copies.
  An unexpected version/region/plan holds work while retaining owned cleanup.
- `production75-fly-v1`: fixed HTTPS origin and V1 endpoints from official
  Fly0.4.115 source, explicitly supplied fetch/authentication, bounded streamed
  responses, redirect rejection, absolute deadlines and fresh sanitized errors.
  Metadata strips credential payloads; credentials use opaque single-use tickets.
  Custody is checked again immediately before HTTP dispatch.
- `production75-reader-delta`: full original/catalog/fingerprint/owner/provider/
  global/default/PUBLIC preservation; only the exact reserved login/edge/settings
  may be added. New effective privileges must match the already observed NOLOGIN
  reader group; backend identity is independently checked. Empty DBs stay empty.
- `production75-operator`: verify account/source/backup/module evidence, one copy,
  authoritative live-inventory ownership, exact Reader, rollback/commit using the
  actual previous verifier, then owned DELETE/read-only reconciliation and fresh
  protected-original verification. Lost create/role/commit/delete replies never
  cause a resend. Unknown ownership requires owner action.
- `production75-operator-local`: explicit `--run-local` fake HTTP provider with
  real owned PG16 source/copy, memory-only synthetic pg_dump/restore, actual role
  creation and actual SQL verification. No live networking or credentials loaded.

## Deliberate boundary

This is an import-safe supplied-client lifecycle, not a default hosted command.
Real account/authentication/connection/observation drivers and independently
authenticated owner/capability receipts must be wired and reviewed separately.
Boolean JSON approval is insufficient. Authentication callbacks are trusted
dependencies; structural binding does not establish who authenticated them.

The proposed Reader profile is exact and conservative; actual provider behavior
remains unverified. V1 acknowledgments/detail/tombstones may omit attachment data;
omission remains unknown, and fresh inventory must explicitly establish empty
attachments before work or DELETE. PUBLIC maintenance TEMP and callable functions
remain authority; no zero-DDL/no-side-effects assertion is made for the login.

Provider stubs, simulated settings, host-trust fixtures and synthetic authority
do not establish provider binaries/settings, password authentication, paid
admission or hosted acceptance. No actual source record dump enters receipts.
Real price/lifetime/cleanup reserve and a fresh one-copy owner approval remain
required after a concrete real-driver packet is reviewed. Consumed grants stay spent.
All20 contractor gaps and both business replacement decisions remain open.

## Evidence

Focused73 tests passed; full scripts504 tests and workspace types passed before
the final selected-bridge regression (current full suite will be recorded after
review). Two earlier native holds identified a journal pin mismatch; both
closed38 clients/sockets and two owned containers. Those failures are retained.
The journal now separately pins `production75-selected-0000` and rejects a wrong
hash; it does not broaden accepted SQL. Final native/review/publication evidence
is recorded here when complete.

Public protocol sources:
- [V1 shapes](https://github.com/superfly/flyctl/blob/v0.4.115/internal/uiex/mpg/v1/client.go)
- [V1 operations](https://github.com/superfly/flyctl/blob/v0.4.115/internal/uiex/mpg/v1/managed_postgres.go)
- [Pinned origin](https://github.com/superfly/flyctl/blob/v0.4.115/internal/uiex/client.go)
