# Bounded production-copy operator implementation plan

> Execute inline with superpowers:executing-plans; one fresh whole-branch
> reviewer at completion. No implementation subagents.

**Goal:** Complete the supplied-client copy lifecycle around the reviewed PR45
verifier, proving admission, durable attempt custody, V1 protocol, exact Reader
delta and cleanup through local provider faults and owned PostgreSQL16.

**Architecture:** New modules compose the existing verifier without altering
application/19SQL/PR44 or PR45 modules. Explicit supplied provider/authentication/
observation/connection dependencies own real transport; no network or credentials
are loaded at import. Local CLI uses only a fake provider and owned loopback PG16.

**Tech:** Node22/24, Vitest4, existing pg/Docker/WSL helpers; pinned Fly0.4.115
official V1 request definitions and HTTPS origin.

**Spec:** C:\Forge\artifacts\growthos-production-verifier-20261012\next-operator-engineering-plan.md.
Adam's continuation approves the presented local operator work. Run it inline;
fresh paid-copy, scope/profile/provider and production admission remain separate.

## Global constraints

- Base PR45/283715fdf3cc132680d4e900e70e4d48ab8f474b; PR44/8df64dc fixed.
- Sourcekzpwm0j18eg04nv3 and stagingzp2wjrejd2zodn4q are protected.
- No live calls, source writes, actual credential loading, paid resources or app start.
- One create/Reader-create/DELETE per exact durable reservation; unknown acknowledgment
  never resends. A restart requires read-only reconciliation and cannot re-admit work.
- Complete source/global/provider/default/PUBLIC vectors remain; actual server
  Reader delta must equal the independently expected profile, never widened dynamically.
- PUBLIC TEMP/callable functions stay explicit; no global no-side-effects claim.
- Credentials stay inside supplied-client closures and connection setup; receipts
  are exact-schema metadata/hashes. Raw error messages/causes/bodies never escape.
- Authenticated owner/capability evidence is supplied explicitly; a boolean in JSON
  is insufficient. No default admission or implicit networking.

## Review focus

Async mutation/late responses; permit provenance and one-use across process crash;
same-name/foreign/protected-copy cleanup; credential-bearing provider payloads;
full Reader/global/vector binding; unexpected API metadata; journal failure after
side effects; shutdown despite source drift; cleanup reserve and resource ownership.

## Task1: Admission and durable custody

Files: scripts/production75-custody.mjs, .test.mjs.
Interface: prepareOperatorPlan(input), openOperatorCustody({root,plan,
verifyOwnerApproval,verifyCapabilityReview,now}); object exposes reserve(kind),
record(kind,fields), bindOwned(metadata,beforeInventory), close/status.
Opaque branded permits bind exact operation, plan/target/deadline and one dispatch.
Real exclusive directory/files/fsync enforce cross-process reuse refusal.

- [x] RED absent/foreign/expired approval, forged/reused permit, async mutation,
      protected ID, durable restart/collision/torn journal and unknown outcome.
- [x] GREEN minimal immutable validation and exclusive append-only custody.
- [x] Record test command/result and commit exact files.

## Task2: Fixed V1 transport

Files: scripts/production75-fly-v1.mjs, .test.mjs.
Interface: createProduction75V1Client({fetchFn,getAuthorization,organization,now,
limits}) with fixed list/detail/backup/users/credential reads and permit-bound
restore/Reader-create/owned-delete methods. Origin https://api.fly.io; no override.
Bound streaming, redirect rejection, abort, post-resolution deadlines and safe errors.

- [x] RED fixed request shapes, credential-free metadata, raw-error spoof, redirects,
      oversized/late/never-ending body, parameter mutation and one mutation dispatch.
- [x] GREEN pinned protocol and secret-in-memory handling; no raw response logging.
- [x] Record test command/result and commit.

## Task3: Exact role delta and operator composition

Files: scripts/production75-reader-delta.mjs, .test.mjs;
scripts/production75-operator.mjs, .test.mjs.
Role proof compares all existing flags/edges/settings, owners/ACLs/provider/data,
allowing only exact reserved login/edge/approved new-only settings. Operator validates
fresh source/copy observations, creates Reader once, binds review/target evidence,
runs supplied real verifier, then confirms owned deletion and protected originals.

- [x] RED extra/missing/changed delta, name collision, wrong copy/Reader, lost create/
      role/commit/delete ack, read-only reconciliation, source drift and cleanup errors.
- [x] GREEN full lifecycle and terminal holds; require durable intent before dispatch.
- [x] Record tests/result and commit.

## Task4: Owned native lifecycle and packet

Files: scripts/production75-operator-local.mjs and .test.mjs;
reports/bounded-operator-2026-10-12.md and selected content-free receipts.
Explicit --run-local creates owned synthetic PG16 source/copy fixtures, drives the
actual V1 adapter/custody/delta/operator with fake HTTP and real SQL verification,
then requires all client/socket/container closure. Source hashes bind the proof.

- [x] Run happy/uncertain/failure scenarios against source/copy with synthetic records.
- [x] Require complete original/non-target preservation and native Reader profiling.
- [x] Preserve no raw customer/provider credentials or restored row dumps in receipts.

## Task5: Source acceptance

- [x] Full scripts/types, unchanged app/core/SQL, exact selected-file secret scan.
- [x] One fresh independent whole-branch review; Important fixes RED->GREEN plus suite.
- [ ] Publish dependent source PR with exact-head CI and durable Forge state.
- [x] Keep real account/authentication/connection drivers, actual profile/scope/cost
      admission and hosted proof explicit until their own evidence is complete.

The supplied-client lifecycle is working software on its own; it is not a claim that
a real hosted driver or paid execution packet is admitted. That distinction is part
of the exit report, not a reason to weaken any required release/company gate.
