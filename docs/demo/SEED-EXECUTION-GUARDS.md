# Demo execution guard contract

This is the bounded correction of the remaining f2fcbe9 I1–I3/M3 findings.
Earlier date/recurrence/grading and instance-owned-manifest fixes remain in
place. Original producer 59-test/runtime evidence keeps its original source and
qualification; it is not retroactively upgraded by this correction. Local source
tests establish guard behavior, not a staging seed, real delivery, settlement,
company confirmation, workday, device or launch acceptance.

## Admission and ROOT proof

The only origins remain HTTP loopback 4192/4193 and the exact HTTPS staging app.
Localhost and 127.0.0.1 canonicalize to one bound runtime identity. Staging has no
environment/host override. Its CLI additionally requires the exact SHA256 of the
raw ROOT-reviewed execution-manifest file before any browser or auth module runs.

An execution/local manifest now contains `executionProof` and
`executionProofSha256 = proofHash(executionProof)`. `proofHash` is SHA256 of
`JSON.stringify(value)`; use the exported helper and the normalized company map
the loader builds. A proof covers the full reviewed fixture map; selecting one
company does not change that binding or authorize mutations in the other one.
Local runtime secrets remain solely in its instance-owned private manifest and
memory. The nonsecret plan/receipt contains only the normalized company IDs,
reviewed public proof and hashes.

Common proof fields are:

```text
kind, origin, fixturesSha256,
observedAt, expiresAt,
configSha256, imageSha256, frontendIndexSha256,
release: { sha, builtAt, environment },
schema: { database, cluster, tables:142, columns:1870, catalogSha256 },
holds: { outbound:true, scheduler:false, communications:false,
         stagingOutboundApproved:false, recipientAllowlistEmpty:true },
runtime
```

Observed time cannot be in the future. Both proof age and lifetime are at most
five minutes; expiry is rechecked after durable intent and immediately before
dispatch. SHA values are exact 64-hex strings, release source is 40-hex, and
release build time must parse. Extra top-level/nested proof fields, including raw
provider/credential bodies, are rejected. No raw environment is persisted.

Staging kind is `ROOT_DEMO_EXECUTION_PROOF_V1`, with `reviewedBy: ROOT`, account
`diazdestination@gmail.com`, CLI org `personal/1854600`, API org `adam-diaz`, app
`mogulforge-growthos-staging`, Machine `8d96936a03d058`, and schema database
`growthos_staging`/cluster `zp2wjrejd2zodn4q`. `immutableImage` must be the exact
staging registry image at the proof's image digest. Staging runtime fields are:

```text
instanceId, state:'started', eventsSha256, configSha256,
stopAt, taskNextUtc, anchorUpperAt, capSeconds,
verifiedReceiptSha256, anchorSha256
```

ROOT supplies actual, independently reviewed provider/catalog observations and
verified receipt/continuity hashes. Config hashes must agree; the fixed anchor
upper time plus actual cap must end by the actual task stop. This revision caps
staging stop and proof expiry at **2026-10-16T22:00:00Z**. It deliberately has no
extension boolean or assumed October 18 deadline. A future extension requires
actual successful execution/continuity proof and a separately reviewed finite
source/contract update. A prepared or `reconciliation_required` window is not a
successful extension and does not release this seeder.

The application has no endpoint for proving provider config, native Task state,
or the hosted catalog. ROOT owns that short-lived external responsibility and
the operator/business-writer fence. The browser does not claim to prove it.
The seeder compares the actual application release and bounded frontend bytes
to the proof on admission and before each mutation, checks the full owner/org
session again, and requires every selected staff member's exact ID/email/role,
active state and `operationallyEligible === true` again. Missing eligibility is
not a pass. There is no `COMMUNICATIONS_ENABLED` staging observable: the semantic
communications hold derives from real outbound hold, stage approval/allowlist
and the reviewed deployed adapter behavior.

Local kind is `LOCAL_DEMO_EXECUTION_PROOF_V1`, schema database `postgres`, cluster
null, release environment `test`, runtime `{instanceId,processId}`. The disposable
runner prepares this from its own real read-only canonical catalog, compiled
artifact, frontend bytes, actual child configuration and generated instance ID.
Only future explicit local-runtime execution can prove that prepared collector.
It has not been run as part of this source correction. The private manifest's
existing exclusive creation and instance-owned cleanup behavior is preserved.

## Permanent mutation custody and resource ownership

`mutation-custody.mjs` uses a fixed namespace under
`C:/Forge/artifacts/growthos-demo-seed-correction-20261016/custody`. The key binds
the fixed fixture plan, organization, company and exact runtime identity. Local
aliases use the same canonical origin/instance; staging binds the fixed
app/cluster/database. Changing `--receipt-dir`, `--lock-dir` or run ID cannot
avoid a previous reservation.

A plan intent is exclusively created and fsynced before any business mutation.
Every operation has its own exclusive pre-dispatch intent containing method,
reviewed request hash, kind/key, scope, timestamp and original plan-intent hash.
Acknowledgments persist the exact resource ID, original creation-request hash
and intent-byte hash. Website intake's derived customer/property IDs are bound
to that acknowledged original lead, with their own reviewed identity hashes.
The plan retains original fixture/company identities and ROOT proof hash.

Buffer writes honor actual byte counts and offsets; zero progress, write,
fsync/close failure or overlap poisons the writer. UNKNOWN, crash, failed
acknowledgment, incomplete readback or any other unfinished attempt leaves the
plan permanently reserved. A fresh writer checks that barrier before any POST.
The process lock is only an additional concurrency aid; releasing it cannot
release durable custody. There is no automatic reset, deletion, retry or replay.

Only exact complete readback writes the plan completion record. Later applies
are verification-only: they reuse the retained resource IDs and cannot dispatch
another mutation. A matching natural key without original custody is unowned
and held for reconciliation. Missing IDs, changed email/title/notes/service or
other creation fields therefore cannot cause a replacement fixture. Each reuse
must match its retained ID and the current reviewed parents, fields and amounts.
Request/body hashes retain original creation identity without storing customer
row or credential values in the journal.

Invoices compare the full reviewed normalized document before issue/payment and
on later readback: issuer/customer names and addresses, due date, notes, title,
currency, every line/extended total, tax, subtotal and total. Extra document
sections are not silently accepted. Source/contact/property/work identities,
version, financial basis and exact required balances are checked too. Missing
balances do not become zero. Issued document lineage is preserved; staff edits
hold instead of being issued, topped up or overwritten.

Reconciliation has no automatic CLI implementation. ROOT must review original
intent/request/ack hashes and actual API identity/state, exclude original
in-flight effects and other writers, and separately approve a bounded read-only
reconciliation procedure. An absence lookup alone cannot settle a lost response
with delayed visibility. Reconciliation is not replay permission. Never remove
or rewrite reservations/credentials/real rows to make another run pass.

## Output and remaining execution gates

HTTP response codes use a finite recognized set; arbitrary code-shaped strings
are reduced to status alone. Unexpected exception messages/class names and debug
error objects are not printed or persisted. Deliberate internal/proof/custody
codes are finite. Auth credentials/site keys remain in memory; there are no
recordings, tracing, storageState, cookie files or response-body evidence.

This correction does not run a browser, runtime, provider, credential helper or
database. Fresh ROOT fixture provisioning/actor/site/key custody, accepted C33,
accepted seeder source, valid runtime/holds/catalog admission, an accepted
memory-only auth module and explicit execution release remain prerequisites to
hosted demo business seeding. Local runtime execution also remains a separate
ROOT authorization/verification step. Forced process termination and actual
cleanup are unproven; preserve all original custody after uncertainty.
