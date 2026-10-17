# Supplied-client production-copy lifecycle

Based on reviewed PR45/283715f, with PR44/8df64dc application candidate unchanged.
New modules implement immutable admission, exclusive durable custody, a pinned
V1 protocol adapter, exact additive Reader proof and composition around the
existing production75 verifier. No application, 19SQL or prior verifier changes.

## Responsibilities

- `production75-custody`: exact plan/owner/capability binding; exclusive directory
  and cross-process active lock, fsynced reservation files/hash-chain intents and
  one-use opaque permits; restart is reconciliation
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
  The approved complete Reader snapshot binds transaction baselines, original
  policy, capabilities and every non-target database. Resource-owning callbacks
  must use the supplied terminal acquisition registry and signal/deadline;
  SQL dispatch is guarded and late acquisitions are disposed. Pending acquisition
  prevents a successful resource-closure claim. Only required ownership reads
  precede DELETE; lengthy original-preservation checks follow it.
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

Stale active locks are never automatically stolen. Recovery after an unclean
process exit requires review of the owned journal/reservations before releasing
that exact lock. Reservation files survive interruption before journal append;
unacknowledged intents remain spent. Filesystem/ownership/deletion failures can
still require owner intervention; source tooling cannot guarantee provider or
storage availability. Real drivers must implement the terminal resource contract.

## Evidence

Focused86 tests, full scripts519 tests and workspace types passed after review.
One fresh whole-branch review identified five Important findings: recovery
concurrency, late resource acquisition, cleanup starvation, baseline drift and
unhandled idle client errors. Test-first corrections cover all five; no second
review or live provider test was inferred. Two earlier native holds identified
a journal pin mismatch; both
closed38 clients/sockets and two owned containers. Those failures are retained.
The journal now separately pins `production75-selected-0000` and rejects a wrong
hash; it does not broaden accepted SQL.

Native `dff76c58-6b33-4b2a-b575-111ee62a5271` passed at
2026-10-12T22:25:27.172Z. Normal and lost-COMMIT cases execute all19 steps for
rollback/commit, preserve75 original tables/849 columns/13 defaults and require
67 new tables empty. Lost COMMIT is reconciled without replay. The injected idle
client failure holds before upgrade SQL, preserves originals and deletes its
owned copy. Every case creates one copy/Reader and sends one DELETE. All107
clients/sockets and six owned containers closed; five normalized source-module
hashes are stable before/after. All150 original table fingerprints across the
two populated databases, complete non-target vectors and empty third database
are checked. These are synthetic22-row fixtures, not new hosted data proof.

Content-free native receipt and custody audits are in
`reports/bounded-operator-2026-10-12/dff76c58-6b33-4b2a-b575-111ee62a5271/`.
Publication and exact-head CI are recorded in the external Forge source packet.

Public protocol sources:
- [V1 shapes](https://github.com/superfly/flyctl/blob/v0.4.115/internal/uiex/mpg/v1/client.go)
- [V1 operations](https://github.com/superfly/flyctl/blob/v0.4.115/internal/uiex/mpg/v1/managed_postgres.go)
- [Pinned origin](https://github.com/superfly/flyctl/blob/v0.4.115/internal/uiex/client.go)
