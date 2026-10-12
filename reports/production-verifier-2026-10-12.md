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

Focused unit/regression suite: 77/77 PASS; full scripts suite: 432/432 PASS.
Workspace typecheck PASS. Gitleaks found zero leaks in source and review fixes.

Fresh independent review of d799766 found five Important issues and no Critical
or Minor issues. Nine added regressions reproduced async parameter mutation,
foreign-reader review binding, custom SET-only authority, per-call late results
and backend safeCode redaction bypass. All were fixed RED->GREEN in d3a4f36.
Arguments/evidence are snapshotted; review identity binds to the actual Reader;
unassessed SET-only roles are refused and fully measured read-only scopes accepted;
absolute deadlines reject late responses; backend errors are freshly sanitized.

Final native run264da539-582b-46e6-8120-74b8b167e8f2 PASS at20:21:52UTC:
both layouts plus both lost-ack variants, native privilege denials, independent
INHERIT/SET probes, rollback, late failure recovery, one-dispatch commit and
fresh Reader proof; both non-target record/metadata vectors remained unchanged.
All38 clients/sockets closed and the unique owned container was removed.
The four normalized module hashes match implementation commit
d3a4f36626d5312997eaf39e4a24712c829f2eae before/after the run.

[Source acceptance](production-verifier-2026-10-12/source-acceptance.json)
authenticates25 content-free native receipt/reservation/journal files.
[Native result](production-verifier-2026-10-12/264da539-582b-46e6-8120-74b8b167e8f2/native-result.json)
records exact source/cleanup boundaries. Earlier failed and superseded runs remain
local historical evidence and are not included in this source acceptance.

Reviewed scope decisions: direct application privilege checks do not establish
global no-side-effects; native stubs/settings are local-only; future callers own
authenticated review, exact transport/Reader profile, durable custody and paid
admission. Hosted creation/cleanup, real provider binary/settings proof, paid
admission/deployment, company acceptance and unrelated existing application behavior
remain separate gates. Mistaking these boundaries for passes could cause an
incomplete hosted run, unsupported assumptions, caller misuse or premature cutover.
No reviewer findings were deferred.
