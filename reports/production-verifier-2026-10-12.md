# Local production verifier

This source candidate extends PR44 (8df64dc72009832f93b2b491031acd1bb2afb903)
with separate observer, recorded privilege model, native oracle and verification
modules. The application, existing production75 mechanism and 19 SQL pins are
unchanged. It provides no hosted entrypoint or deployment authority.

## What the modules prove

The observer accepts only the exact registered catalog/ownership/privilege/extra
metadata queries and canonical original-column aggregate fingerprints. It rejects
arbitrary SQL, function invocation, monitoring-view contents, auth/system contents,
changed parameters and untrusted catalog pairs before dispatch. Each accepted read
checks the same PostgreSQL16 backend identity in a repeatable-read/read-only
transaction. Deadlines, response bounds and unusable-backend state fail closed;
errors expose safe codes. The caller owns and closes the supplied exclusive socket.

The immutable model records 23 global role flag rows, 12 membership edges and 10
target default grants. Native tests vary role INHERIT and membership INHERIT/SET,
deny direct persistent application DML/DDL/admin SET ROLE and derive 75/95/142
policy by executing the pinned SQL as schema_admin. Two synthetic tenants exercise
22 rows in nine original tables. Both physical layouts, the populated other DB
and empty third DB retain fingerprints, catalog, complete policy and five extra
metadata vectors. The maintenance database preserves and demonstrates PUBLIC TEMP.

The verification contract binds the full extra/non-target evidence and measured
scope, checks Reader identity and requires a durable reservation callback before
calling the existing mechanism. A fresh Reader verifies rollback or acknowledged
commit; a lost COMMIT acknowledgment can only reconcile without replay.

## Usage and responsibility

For an owned local PG16 fixture only:

```powershell
node scripts/production75-legacy-local.mjs --run-local
pnpm --filter @workspace/scripts test
pnpm typecheck
```

The native runner uses a cached image, a unique nonce-labelled container, loopback
port, synthetic records and unused dummy credentials. It writes an exclusive run
directory and requires every client/socket and the exact owned container to close.
Native module hashes before/after must match. Unexpected source drift is FAILED.

`runProduction75Verification` accepts a prepared production75 plan, connected
Writer, exact baseline/extra vectors, separately reviewed capability receipt,
`readFresh`, `persist`, `reserve`, outcome and UUID attemptId. The caller must
authenticate the review, target/copy/Reader profile and paid admission. `reserve`
must persist and acknowledge a non-reusable one-attempt record BEFORE returning
true, rejecting reused target/attempt after a process restart. The module's Set
only protects the current process; it is not the durable custody store. A failed
or timed-out reservation/unknown outcome is terminal and never retried here.
The caller also owns bounded transport cancellation and socket cleanup.

## Deliberate boundaries

Direct application privilege denial is narrower than a no-side-effects assertion:
PUBLIC maintenance TEMP and nine callable volatile functions (two SECURITY DEFINER)
remain measured capabilities. The fixed observer does not remove those login
capabilities or establish zero-DDL clusterwide. Hosted capability-scope review
remains required. Native scope review is explicitly synthetic and non-authoritative.

Provider-shaped harmless native view/functions do not prove pgaudit/pg_stat_monitor
binary/definition equivalence. Three known simulated role settings do not reproduce
opaque source settings. Host-trust fixtures do not prove actual Fly-created Reader
login flags, edge grantor/options, role settings, authentication or initial role.
No role creation transport is included; lost role-create acknowledgment, duplicate
name/ownership refusal and actual server delta verification remain future gates.

Fresh source backup/profile/identity, one bounded paid copy and cleanup, complete
provider/global preservation, independent capability acceptance, hosted rehearsal,
private runtime verification, contractor workflow/physical-device acceptance and
owner release approval remain open. PR44 CI is source evidence, not market launch
or permission to replace either contractor's system.

## Evidence

Focused unit/regression suite: 68/68 PASS. Full scripts suite prior to the final
two role regressions: 421/421 PASS. Workspace typecheck PASS. Final source-bound
native proof, current full suite and independent review are recorded below when
complete; earlier drill receipts remain local historical evidence.
