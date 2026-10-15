# GrowthOS Combined Release and Scheduling Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Join the accepted product and operational source, then prove the explicit scheduling0019 upgrade preserves every original value across all142 tables before preparing a separately authorized hosted rehearsal.

**Architecture:** Preserve the existing19-input75→95→142/0018 mechanism and its historical evidence. Add a named scheduling0019 stage with a closed observer, full142-table baseline, separate one-use custody, shared local/native aggregate identity and fresh native oracle. Retain the product API/library and protected recovery inputs exactly; source, local recovery, hosted proof and client acceptance stay distinct.

**Tech Stack:** Existing ESM JavaScript, Vitest, PostgreSQL16, pnpm11.3.0, the installed Windows/WSL Docker harness and existing API recovery build. No new dependency or toolchain version.

**Spec:** `C:/Forge/GROWTHOS_RELEASE_INTEGRATION_DESIGN_2026-10-15.md`, owner approved by “I approve”; SHA256 `edadffad4fc17251f1741e48e4505db45767f494f50c4117b65c7de64f1c2204`. Immutable copy: `C:/Forge/artifacts/growthos-release-integration-20261015/design-approved-edadffad4fc1.md`.

**Plan status:** Prepared for owner review; implementation has not started. Preserve the already selected execution method: scoped agents, ROOT integration, fresh independent task reviews and final whole-branch review, with GEEKOM's separate acceptance audit. This plan creates no paid/hosted authorization.

## Global Constraints

- Canonical private repository: `diazdestination/mogulforge-growthos`; account `diazdestination`. Product P=`91b7fd2c1fd98d441848e0357954e35c9f65d688`, operations O=`c285c4781145fead9fa2baa39360412f2846f66d`, common=`8df64dc72009832f93b2b491031acd1bb2afb903`, main=`7091af816715cfd437925eb0af82fb47d3411e34`. Refresh before use; unexpected drift stops integration for assessment.
- Preserve original19 SQL byte pins/source/main7091 lineage, old source/core/observer/verification semantics and all historical receipts, failed attempts and114 ruling/cost records. Do not append0019 to the original constructor or rewrite old canonical142.
- New input `reports/staging-schema-preview-2026-10-01/0019_saved-scheduling-policy.sql` is8126bytes, SHA256 `76e88d3410235f1b6a8a20e595b126455fd5711b46f87055b586786b28f81ca9`: three nullable JSONB columns and three CHECKs, no tables/default/backfill. Full baseline142tables/1867columns→142tables/1870columns.
- Preserve P's whole API/library scope and eight inputs: `scripts/{saved-scheduling-recovery-fixture,contractor-recovery-drill,contractor-recovery-app-probe,release-schema}.mjs`, `artifacts/api-server/{build,build-identity}.mjs`, `artifacts/api-server/scripts/contractor-recovery-entry.ts`, `pnpm-lock.yaml`. Exact protected hashes: `geekom-static-source-facts.json` in the integration artifact directory. No unrelated codegen/dependency/fixture edits or M2 repair.
- Keep closed28 datasets, original outcomes/authority/tenant boundaries, history/privacy, writable export audit, restore-mode POST405, four saved-gap enforcement cases and `releaseEligible:false` unless a separately proved recovery alternative exists. This plan does not implement or claim that alternative.
- Fresh local/native evidence must bind the clean current source/tree, exact SQL, actual catalogs/policies and full data fingerprints. Runtime text normalization and exact-byte SQL hashes are different contracts. An old packet/oracle/attestation cannot authorize the new stage.
- Use synthetic, uniquely owned, loopback-only local resources and bounded work/cleanup. No provider credentials, portable keys, production databases, customer contact, public launch, new paid copy, merge to main or deployment. Consumed grants remain consumed.
- Every implementer has exclusive file ownership in its own worktree, knows it is not alone, preserves other edits and returns exact commits, commands, redacted evidence and cleanup. Only ROOT integrates and authorizes private shared pushes. No force-push, active-directory synchronization or repeated policy-blocked deletion.
- FullG04/G06 and both contractor configuration/import/staff/provider/device/cutover cards remain required. No reduced replacement scope or invented business facts.

## Review Focus

1. Partial/already-applied0019 still has142 tables: reject a partial schema, recognize exact post-state without replaying ALTERs. Tests T2/T3/T5.
2. Duplicate/reordered rows or same-count corruption in a post75 table: compare all142 complete original projections, preserving multiplicity and exact count/byte strings. Tests T2/T6.
3. Lost acknowledgment, wrong fresh Reader target or timeout: hold/reconcile exact state without another DDL attempt, retaining cleanup time. Tests T3/T5/T6.
4. Crash after reservation fsync but before its journal event, stale locks or cross-stage permits: reservations remain consumed and stage prerequisites cannot be bypassed. Tests T4.
5. Swapped runtime/SQL/catalog/oracle or a self-referential manifest: one acyclic shared aggregate must invalidate every stale admission before provider mutation. Tests T4/T5/T6.

## Files, interfaces and ownership

All relative paths below are in the new integration checkout. The exact external evidence root is `C:/Forge/artifacts/growthos-release-integration-20261015`; every execution gets a UUID child directory, never overwriting planning or historical proof. ROOT records `$candidateRoot` from the actual worktree-tool return and creates `$runEvidence` as an absolute new `run-<UUID>` child of that evidence root after containment/nonexistence checks. Commands run in `$candidateRoot`; report-path arguments use that observed `$runEvidence`, never an unresolved angle-bracket placeholder.

| Owner | Files/responsibility | Scheduling |
| --- | --- | --- |
| ROOT | Worktree/merge; `PROJECT_STATE.md`, `NEXT_ACTIONS.md`, `RUNBOOK.md`, reviewed source contract/report; integration/push/CI | T1, T5, T7, T8; shared writes sequential |
| Worker A | New `scripts/production75-scheduling0019.mjs`, `production75-scheduling0019-observer.mjs` and their tests/test support | T2 then T3; reuse implementer after review |
| Worker B | `scripts/production75-custody.mjs`, `production75-live-manifest.mjs` and owned tests | T4, parallel with T3 after accepted T2 interfaces |
| Native worker | `scripts/production75-live-local.mjs` and new native contract test | T6 after accepted T3–T5; ROOT admits/runs resource-heavy command |
| GEEKOM | Exact candidate C01–C20/protected product source and recovery acceptance audit; its own report only | T7, after ROOT supplies frozen source/artifact identities |
| Fresh reviewers | Spec and quality review of each exact owned delta, then whole branch | No implementation ownership; findings resolved before next dependency |

ROOT owns `production75-operator.mjs`, `production75-live-policy.mjs`, `production75-live-runner.mjs` and their test changes in T5. Workers cannot edit these shared orchestration files.

### Frozen inter-task contract

New names below are decisions for this plan, not claims that these exports already exist. They use the existing `SchemaCatalog` shape returned by `collectSchemaCatalog`, existing policy shape returned by `captureProduction75Policy`, and existing `{query(sql,args),connection}` client pattern. Exact closed object keys and validators are implemented/tested before dependent work.

- `CandidateIdentity`: `{repository:'diazdestination/mogulforge-growthos',commit:string40hex,tree:string40hex}`. `SourceBinding`: `{candidate:CandidateIdentity,moduleManifestSha256:string64hex}`. IDs/digests have strict lowercase length/character validation, not a trusted caller label.
- `DeltaSource`: frozen `{stage:'scheduling0019', sourceCommit:P, path, bytes:8126, sha256, sql}`; constructed only by `buildScheduling0019Source({sourceCommit,path,bytes:Buffer})`. The input comes from canonical Git bytes, not a silently normalized checkout. No filesystem, environment, provider or CLI inside this constructor.
- `DeltaDescriptor`: the exact `DeltaSource` metadata keys except `sql`. Use descriptors in manifests/plans/journals; never serialize SQL bodies or business rows as operational custody. The supplied verifier receives the branded source separately.
- `DeltaCatalogs`: frozen `{before:SchemaCatalog, after:SchemaCatalog}` for one admitted physical layout. Before has142/1867 and one old derived physical digest; after differs only by the reviewed three columns/CHECKs. Keep both old derived pre0019 physical digests (`307fee292bc66d8f9fe11858d9cd8fe2c2983a59563ba867d6ebf50504f3ef6e`, `2ed9500b5fb077a19aa16003bd346f8369a1b1cb3da8ea8f9a396265b6410f7b`) unchanged. Fresh post digests are measured, never invented.
- `DeltaTarget`: existing exact database/writer/reader/principals shape; database `fly-db`, writer login `fly-user`, writer role `schema_admin`, generated Reader login/role from `production75ReaderName(runId)`. No connection string in receipts.
- `DeltaState`: `{phase:'pre0019'|'post0019',identity,catalog,fingerprints,policy,nullCounts}`. Fingerprints cover each of142 original table projections with original1867 columns, `{table,rows:string,bytes:string,digest}`; use the existing count/byte plus ordered MD5 row-multiset query semantics over all original columns, retaining duplicates. Count/byte values are bounded decimal strings, not lossy JS numbers. `nullCounts` is the three exact qualified column names mapped to mismatch-count strings in post-state, all `'0'`; before-state requires those columns absent and an empty map. Only aggregate hashes/coverage enter operational receipts.
- `prepareScheduling0019({source,catalogs,target,policyBefore,policyAfter,sourceBinding}) → DeltaPlan`: deep-frozen, internally branded plan; validates exact shape, target/source and expected catalog/policy. `sourceBinding` identifies candidate commit/tree and aggregate manifest digest. Create this metadata-only plan first, then capture the actual pre0019 Reader baseline through its observer; transaction verification freezes/checks that complete baseline before its first await and reobserves it in the writer transaction before DDL. This avoids a circular plan-needs-baseline/baseline-needs-plan contract.
- `createScheduling0019Observer({client,principals,catalogs,identity,limits,now}) → {query(sql,args)}`: fixed registry only. `captureScheduling0019State(observer,plan) → Promise<DeltaState>` and `assertScheduling0019Preserved(before,after,plan,phase) → void` provide the full-stage checks.
- `runScheduling0019Verification({writer,plan,baseline,outcome,attemptId,reserve,persist,readFresh,now}) → Promise<DeltaResult>`. `outcome` is `rollback|commit`; `readFresh()` uses a different authenticated Reader connection on the same target. `DeltaResult` contains `{kind:'SCHEDULING0019_VERIFICATION',status,attemptId,baselineSha256,sourceSha256,proof,errorCode}`; status is `verified-rollback|verified-commit|reconciled-commit-no-replay|verification-held-no-replay|failed-or-held`. Proof contains table/column coverage and actual ACK/Reader/transaction-closure state, never rows or SQL values. Session/socket closure remains the owning operator's responsibility; this verifier does not close a caller-owned writer.
- `combinedManifestDigest({modules,legacySource,schedulingSource,catalogs,oracle,candidate}) → string`: shared deterministic aggregate in `production75-live-manifest.mjs`; `oracle` is the independent measured payload, containing no aggregate/proof hash of itself. `candidate={repository,commit,tree}`; module/source/catalog order is explicit.
- `LayoutDescriptor`: `{beforeCatalogSha256,afterCatalogSha256,beforePolicySha256,afterPolicySha256}`, all64hex. `prepareCombinedOperatorPlan(input) → CombinedPlan`: new closed constructor beside unchanged `prepareOperatorPlan`. Input is the original nine bounded fields plus `{candidate,scheduling}`. `scheduling={source:DeltaDescriptor,layouts:[LayoutDescriptor,LayoutDescriptor],coverage:{tables:142,columnsBefore:1867,columnsAfter:1870,layouts:2}}`; both layouts have unique admitted pre-digests. Coverage is a required contract, not proof that the caller ran it: the native factory must validate completed actual proof before real preparation/execution. It computes the common plan fields plus `kind:'PRODUCTION75_SCHEDULING0019_OPERATOR_V2'`; `operatorPlanDigest` handles both branded plan families, with distinct digests.
- Custody keeps old methods and adds `bindSchedulingBaseline({baselineSha256,catalogSha256,policySha256})`, `recordScheduling(outcome,status)` and `persistSchedulingSQL(outcome,event)`. Reservations `scheduling0019-rollback` / `scheduling0019-commit` work only on v2 plans, with actual successful legacy commit/Reader evidence and then delta rollback prerequisites. Existing `consumeOperatorPermit` / `markOperatorPermitDispatched` remain the sole one-use dispatch boundary.
- T5 adds `deriveLiveScheduling0019Policy({baseline142,oracle,readerName,templateReader}) → {before,after}`; `validateCombinedLiveOracle(oracle,proof,currentHashes,candidate) → frozenOracle`; `prepareCombinedLivePacket(deps,options) → CombinedPacket`. Existing public legacy signatures/semantics remain valid only for legacy execution.
- V2 operator callback `schedulingContext({copy,readerName,outcome,baseline,custody,plan,resources,signal,deadline})` produces exactly `{plan:DeltaPlan,writer,baseline,readFresh}`. It is captured/frozen with existing callbacks before any await. Legacy-only callbacks cannot complete v2.

## Task1: Isolate and join exact source with preservation checks

**Owner/dependencies:** ROOT; after owner plan review. No worker implementation before this checkpoint.

**Files:** Modify `PROJECT_STATE.md`, `NEXT_ACTIONS.md`; preserve O's `RUNBOOK.md` additions. Create `reports/combined-release-contract-2026-10-15.md` and `scripts/production75-combined-source.test.mjs`. Commit the approved spec/plan copies under `docs/superpowers/specs/2026-10-15-combined-release-design.md` and `docs/superpowers/plans/2026-10-15-combined-release.md` without changing their approved body. Keep approval hashes/provenance separately.

**Interfaces:** Consumes exact P/O, approved documents, `source-preflight.json`, proposed status resolutions and GEEKOM raw hashes. Produces a clean combined checkpoint with the Frozen inter-task contract and protected-input manifest; no candidate acceptance yet.

- [ ] Reverify account/private repository, fetch refs, exact heads/main/common and dirty status. Use the native managed worktree tool at P with name `growthos-release-integration-20261015`. If the tool cannot address this repository, record the limitation and use `git worktree add C:/Forge/worktrees/growthos-release-integration-20261015 -b agent/growthos-release-integration-20261015 91b7fd2c1fd98d441848e0357954e35c9f65d688`; preserve existing paths/branches on collision. Resolve actual checkout path from the tool, not an assumed native-tool directory.
- [ ] Install only existing frozen dependencies in that checkout, offline first (`pnpm install --offline --frozen-lockfile --ignore-scripts`). If a locked package is not cached, use the normal frozen/ignore-scripts install and record downloads; never update the lock or versions. No shared worktree/node_modules copying.
- [ ] Run `git merge --no-ff --no-commit c285c4781145fead9fa2baa39360412f2846f66d`. Require exactly the two known document conflicts; resolve using the reviewed proposals with current actual combined preparation status, preserving both histories. Any unexpected source conflict stops for assessment. Keep the approved contract's method/data/source identities in the new report.
- [ ] Add the source regression that asserts the19 original SQL hashes, P's eight protected blobs and unchanged API/library scope against P; a deliberately altered protected buffer must fail the comparison. Do not treat the merge's changed source count as runtime proof.
- [ ] Run `pnpm --filter @workspace/scripts exec vitest run production75-combined-source.test.mjs production75-core.test.mjs production75-observer.test.mjs`. Expect all source and legacy mechanism checks to pass, then independently review the staged source merge and document resolution.
- [ ] Commit the reviewed merge/contract/plan checkpoint with an explicit source-only title. Record HEAD/tree and actual commands/status; only then dispatch owned tasks. Preserve main and both original branch heads.

## Task2: Exact delta source, full142 observer and preservation contract

**Owner/dependencies:** Worker A; accepted T1. ROOT remains the only shared integrator.

**Files:** Create `scripts/production75-scheduling0019.mjs`, `scripts/production75-scheduling0019-observer.mjs`, `scripts/production75-scheduling0019.test.mjs`, `scripts/production75-scheduling0019-observer.test.mjs`, and test-only `scripts/production75-scheduling0019-test-support.mjs`.

**Interfaces:** Produces `DeltaSource`, `DeltaState`, branded `DeltaPlan`, `buildScheduling0019Source`, `prepareScheduling0019`, `createScheduling0019Observer`, `captureScheduling0019State`, `assertScheduling0019Preserved` exactly as above. Test support exports `makeScheduling0019Fixture({layout=0}) → Promise<{sourceInput,catalogs,target,policyBefore,policyAfter,before,after,sourceBinding}>`; it uses the actual old142 fixture data and independently executed reviewed0019 in a synthetic embedded fixture, never functions under test to manufacture expected success. This fixture is not native oracle/admission evidence.

- [ ] Write failing behavioral tests: exact8126bytes accepted; source/path/hash/CRLF or partial schema drift rejected; count142 alone insufficient; constructor refuses unknown keys/forged plans. For each physical layout assert full142/1867 baseline, post1870 and exactly three NULL additions. Example: `expect(() => buildScheduling0019Source({...f.sourceInput,bytes:Buffer.concat([f.sourceInput.bytes,Buffer.from(' ')])})).toThrow()`.
- [ ] Add failure cases for a changed value in `appointment_work_entries` with unchanged row count, duplicate multiplicity, reordered row output, incomplete table coverage, unsafe count conversion and caller-added SQL/args. Observer rejects anything outside the fixed registry, wrong Reader/database/PID/version/isolation, overlapping use and an expired query.
- [ ] Run `pnpm --filter @workspace/scripts exec vitest run production75-scheduling0019.test.mjs production75-scheduling0019-observer.test.mjs`; retain real RED output tied to the new behavior.
- [ ] Implement the exact source constructor/plan/preservation exports and closed observer. Use complete original column projections, deterministic order-insensitive row fingerprints that preserve duplicate multiplicity, and existing metadata/catalog/policy query shapes. Retain PostgreSQL16, query≤15000ms, operation≤240000ms, metadata≤20000rows/8000000bytes; allow lower bounds, never unrelated increases. Do not log row bodies, credentials or raw SQL parameters.
- [ ] Rerun those two tests plus `production75-core.test.mjs production75-observer.test.mjs`; expect new behavior and unchanged legacy contracts to pass. Return a narrow commit/evidence packet for fresh spec/quality review, then ROOT integrates and freezes these interfaces before T3/T4.

## Task3: Delta transaction execution, exact rollback and fresh Reader reconciliation

**Owner/dependencies:** Reuse Worker A; accepted T2. Can run beside T4 in a separate owned worktree.

**Files:** Modify only `scripts/production75-scheduling0019.mjs` and `scripts/production75-scheduling0019.test.mjs`.

**Interfaces:** Produces `runScheduling0019Verification` and `DeltaResult`; consumes branded T2 plans/observer states and supplied writer/Reader/reserve/persist callbacks. No provider or custody factory is introduced in this module.

- [ ] Write failing tests for actual dispatch order: durable reservation before BEGIN; exact source SQL only; catalog/policy/data verification before terminal transaction; rollback ACK plus original142 preimage; commit ACK plus independent Reader post-state. Assert same target identity, different backend PID and read-only transaction for the Reader.
- [ ] Add late sixth-statement failure; missing/contradictory ACK; lost COMMIT; lost ROLLBACK; wrong fresh Reader target; timeout/late resolution; persistence failure before/after dispatch; already-applied exact post-state and partial0019. On uncertainty assert one DDL dispatch at most, held/reconciled status and no automatic rearm. Example: `expect(writerSqlDispatches).toHaveLength(1)` after lost COMMIT and Reader reconciliation.
- [ ] Run `pnpm --filter @workspace/scripts exec vitest run production75-scheduling0019.test.mjs`; preserve RED.
- [ ] Implement transaction/verification inside the existing bounded callback/resource model. Never consume a schema down-migration as rollback, treat no ACK as no-effect, or accept only a table count. Exact already-applied state is observation/reconciliation only; no new ALTER permit. Keep operational events closed and content-free.
- [ ] Rerun delta and original `production75-verification.test.mjs`; expect verified rollback/commit/reconciliation or deliberate held results with no duplicate SQL. Commit, obtain fresh review, resolve findings and hand ROOT the exact accepted delta.

## Task4: Shared acyclic aggregate and stage-specific durable custody

**Owner/dependencies:** Worker B; accepted T2 contract. Runs beside T3; owns no Worker A or ROOT file.

**Files:** Modify `scripts/production75-live-manifest.mjs`, `scripts/production75-custody.mjs`, `scripts/production75-custody.test.mjs`; create `scripts/production75-combined-manifest.test.mjs`. Do not modify original pins/core/source or native authenticator.

**Interfaces:** Produces `combinedManifestDigest`, `prepareCombinedOperatorPlan` and the three custody methods/reservation kinds in the Frozen contract. Extend the ordered executable inventory with the two new runtime modules, not test helpers.

- [ ] Write tests changing each module/SQL/catalog/oracle/candidate input and requiring a changed aggregate/plan digest; runtime CRLF normalization must not make changed SQL bytes valid. Feed identical inputs to both planned local/native paths and require the identical aggregate. Reject a payload containing its own manifest/proof digest.
- [ ] Write custody failures for legacy plan using delta permits; delta before actual verified legacy commit; wrong/changed142 baseline; delta commit before verified rollback; wrong copy/SQL/source binding; repeated reserve/dispatch; fsync/file/journal interruption; stale lock; resume/reconciliation attempting any new upgrade permit. Exact original nine-field constructor and old reservation behavior still pass unchanged tests.
- [ ] Run `pnpm --filter @workspace/scripts exec vitest run production75-custody.test.mjs production75-combined-manifest.test.mjs`; keep RED for new behavior.
- [ ] Implement the common acyclic manifest and v2 plan family. Bind original source/copy/profile/deadlines/budget plus explicit candidate/stages/native coverage. Create separate fsynced `scheduling0019-rollback` and `scheduling0019-commit` reservations, source-specific SQL allowlisting and full142 baseline binding; validate equivalent rules on journal replay. A damaged/used permit remains unusable; no stale-lock stealing.
- [ ] Rerun those tests plus `production75-live-admission.test.mjs` and `production75-fly-v1.test.mjs`. Expect legacy compatibility and v2 refusal boundaries. Commit and fresh-review the owned delta; ROOT integrates T3 then T4, checks interfaces and whole types before T5.

## Task5: Combined operator, policy and native packet admission

**Owner/dependencies:** ROOT; accepted T3/T4. Shared orchestration is sequential.

**Files:** Modify `scripts/production75-operator.mjs`, `scripts/production75-live-policy.mjs`, `scripts/production75-live-runner.mjs`, their existing `.test.mjs` files, and `scripts/production75-operator-test-support.mjs` only for v2 fixtures. Finalize the tracked `PROJECT_STATE.md`, `NEXT_ACTIONS.md`, `RUNBOOK.md` and create `reports/combined-release-recovery-2026-10-15.md` / `reports/combined-release-integration-2026-10-15.md` as truthful source/procedure contracts pointing to external actual execution attestations. They claim no unrun result. Add no real authorization or credential material.

**Interfaces:** Produces `deriveLiveScheduling0019Policy`, `validateCombinedLiveOracle`, `prepareCombinedLivePacket`, frozen v2 `schedulingContext`; reuses T3/T4 and existing resource/evidence/protected-original checks. Native dependencies reconstruct the complete reviewed v2 plan, not a subset with scheduling fields discarded.

- [ ] Write failing tests that a legacy-only successful operator/oracle cannot certify v2; missing delta callback/catalog/native coverage/aggregate/target fails before paid mutation. Assert `restoreCopy` and any unrequested provider operation are not called on preparation/admission failure.
- [ ] Test correct ordered A rollback→A commit→fresh142 Reader baseline→B rollback→B commit→fresh post0019 Reader; B failures retain exact owned cleanup and original protection. Wrong principal/new-column grant/PUBLIC/default/ownership or non-target changes fail. Lost ACK reconciles read-only inside the bounded admitted attempt, never makes another copy.
- [ ] Test old oracle/packet/owner/capability attestations, swapped module/lock/package/catalog and manually relabeled source refused. Preserve legacy `validateLiveOracle` and CLI family as legacy-only; add explicit `prepare-combined` / `execute-combined` modes with the existing absolute-path/argument-count discipline. No implicit combined execution.
- [ ] Run `pnpm --filter @workspace/scripts exec vitest run production75-operator.test.mjs production75-live-policy.test.mjs production75-live-runner.test.mjs`; keep RED, then implement the declared interfaces. Capture callbacks before awaits; pass only registered queries/resource-guarded writer calls; derive expected new-column policy from actual independently measured native oracle with exact reviewed differences. Keep existing provider metadata/extras/non-target verification.
- [ ] Rerun that set plus custody/delta/manifest/admission/Reader/provider-failure/metadata-retry/transport suites. Expect old and new contracts to pass without removing guards. Get fresh spec/quality review and commit the final tracked status/procedure contract along with the accepted code; no hosted CLI preparation/execution is run by this task.

## Task6: Fresh native PostgreSQL oracle for both layouts and full142 data

**Owner/dependencies:** Native worker owns source; ROOT admits and runs resource-heavy verification after accepted T5. GEEKOM does not duplicate containers/tests.

**Files:** Modify `scripts/production75-live-local.mjs`; create `scripts/production75-combined-native.test.mjs`. New outputs go under a UUID evidence directory; retain old native results/oracles as historical.

**Interfaces:** Add explicit `--run-combined-local`; keep `--run-local` legacy. Combined oracle payload contains candidate, exact source descriptors, both pre/post catalog/policy pairs and no self-referential aggregate. Native proof contains current before/after executable hashes, common aggregate digest, measured oracle hash, explicit delta outcomes/full142 coverage, providerCalls=false and exact owned cleanup inventory. T5 validator consumes this shape.

- [ ] Write failing native-proof contract tests for missing layout, old six-container legacy proof, incomplete delta outcome/Reader/data coverage, altered resource inventory and aggregate mismatch. Run `pnpm --filter @workspace/scripts exec vitest run production75-combined-native.test.mjs production75-live-runner.test.mjs`; preserve RED.
- [ ] Implement combined-local without any live provider session: retain the original six owned source/copy containers/scenarios and add exactly two UUID-owned PG16 delta fixtures, one per retained physical layout. Each added fixture has its own loopback port/database/role identities and creation evidence. Exact combined expected inventory is8 containers; legacy remains6. No new volume/service, broad cleanup or mutation of the old fixture's protected non-target databases.
- [ ] Independently execute the exact legacy SQL and0019 DDL to measure both stage catalogs/policies. In added142 baselines seed valid synthetic old/post75 rows, including `service_obligations`, `revenue_execution_events`, `appointment_work_entries`; capture all142 fingerprints even where empty. Verify duplicate multiplicity and same-count post75 drift rejection. Do not derive expected success by calling the new preservation comparator.
- [ ] In each added layout fixture perform verified rollback, then a separate late-sixth-statement failure with actual ROLLBACK and complete preimage preservation. Finish layout0 with ACKed commit/fresh Reader; finish layout1 with server-committed/lost-ACK injection and independent Reader reconciliation, with no later DDL. This supplies both commit outcomes across both retained layouts without down-migrating or rerunning ALTERs on a post0019 database. Give each declared case its own attempt/reservation evidence. Measure actual Reader SQL write denial and retain the original normal/lost-commit/idle-error source/copy scenarios. Demonstrate unexpected provider metadata and non-target changes refuse. Use the shared aggregate builder in both paths. Bound this new combined-local invocation to20min work plus4min exact cleanup within existing per-query/transaction limits; expiration preserves failure evidence and cannot relax limits or start a replacement run automatically.
- [ ] Fresh-review native source and focused contract tests, resolve findings and commit **before** the heavy native command. ROOT freezes the complete clean candidate HEAD/tree with all runtime/tests/tracked documents already included. Combined-local outputs must use ignored `work/production75-combined-<UUID>` (verify ignore before creation), mirrored afterward to the external Forge evidence directory. No tracked source/report is amended in T6–T8 after this freeze. Only a real finding justifies a new source checkpoint and affected revalidation.
- [ ] Measure the independent oracle payload first in the two added layout fixtures. Then run the original three source/copy scenarios through supplied synthetic admission/fake-provider dependencies and the v2 real SQL/operator path. Finalize the combined proof only after those executions and all cleanup, and run `validateCombinedLiveOracle` on that completed result. The actual native dependency factory consumes this finished proof later; an in-progress/self-certified local proof cannot admit real provider access. No aggregate contains its own final proof hash.
- [ ] Run once at that clean frozen source: `pnpm --filter @workspace/scripts exec node production75-live-local.mjs --run-combined-local`. Expect `PASS`, source/module hashes stable, both layouts/full142/1867→1870, all required outcomes and actual clients/sockets/proxies/databases/process/container closure. Reject generic `verified-and-cleaned` without stage coverage. Failures retain exact receipts; rerun only after a justified reviewed correction, never overwrite the original run.
- [ ] ROOT and a fresh reviewer inspect the actual redacted output, exact ownership/absence and oracle/aggregate/candidate identities. Bind the fresh proof to the already committed candidate without writing a new source commit or including a proof hash inside its own aggregate. No new DPAPI owner/capability admission is issued here.

## Task7: Bind the actual combined app artifact and obtain GEEKOM acceptance audit

**Owner/dependencies:** ROOT execution; GEEKOM independent read-only candidate audit after accepted T6. No product implementation or blanket harness refresh.

**Files:** No tracked source changes. The T5 committed recovery procedure remains unchanged. Write the actual current report as `combined-release-recovery.json` / `.md` beneath this run's external Forge evidence directory. Protected API/library/eight harness inputs remain unchanged. Actual outputs/compiled artifact inventory stay in uniquely owned evidence directories.

**Interfaces:** Produces current combined commit/tree→unchanged product source/harness mapping plus actual build stamp/file/worker/fixture/schema/snapshot identity, and a C01–C20 audit disposition. Source provenance is separate from the normal build's actual checkout identity.

- [ ] Use the existing accepted `release-schema.test.mjs` and `saved-scheduling-rollback-boundary.test.mjs` refusal cases when auditing the recorded full suite: actual source/artifact/worker/fixture identity and cleanup are required; a claimed second artifact or old writable fallback cannot clear eligibility. Do not add a duplicate implementation-mirroring test. The source-preservation test was committed/run in T1; its final version is included in T8 full-suite execution.
- [ ] ROOT verifies whole API/library equivalence to acceptedf56 and exact P versions of the eight files. Admit one new UUID/evidence packet for the unchanged recovery harness at this clean combined source. Run `pnpm --filter @workspace/scripts exec node contractor-recovery-drill.mjs` once. Its normal build must report actual new checkout/artifact bytes while keeping accepted production source provenance truthful. If an unchanged source/pin contract refuses this mapping, stop and retain the failure; no blind repin or protected fixture edit.
- [ ] Require actual closed28 datasets, data/policy/history digests, raw snapshot/marker/outcome preservation, four saved-gap controls, Reader write denial/held reads and separate POST405, bounded export limits/actor revalidation/writable audit and exact cleanup. Do not add a29th dataset or widen Reader permissions. Keep `releaseEligible:false`; neither this new artifact nor repeated same-candidate proof is automatically a second compatible artifact.
- [ ] Send GEEKOM the frozen source and actual hashed evidence for C01–C20 audit. GEEKOM owns only its review note, compares all protected inputs and identifies which retained behavior proof is equivalent versus freshly executed. It performs no duplicate install/test/browser/Docker/hosted run. Resolve findings and obtain independent task acceptance. Save the actual report externally; keep the frozen source unchanged.

## Task8: Current full release checks, whole-branch review and private candidate

**Owner/dependencies:** ROOT plus fresh whole-branch reviewer; accepted T1–T7 and GEEKOM handoff. This closes source integration only.

**Files:** No tracked source changes after T6's freeze. The T5 committed state/procedure documents point to actual external evidence and never substitute for it. Write final attestation, actual status/handoff and review receipts under the external Forge evidence root and update Forge controls. A real review/test finding requires a scoped correction/new freeze and affected verification; no doc-only source amendment is made to the tested candidate.

**Interfaces:** Produces one clean current source candidate, exact local/CI evidence and a concrete later hosted-rehearsal preparation action. No merge or deployment approval is inferred.

- [ ] Run `node scripts/local-dev.mjs test` once for the current combined full suite/website checks in its newly owned disposable database. Preserve the existing15 baseline skips explicitly; no new skip or fabricated passing count. The schema command may target only the run-created local resource. Confirm owned cleanup.
- [ ] Run unchanged `pnpm run typecheck` with process-only `NODE_OPTIONS=--max-old-space-size=4096` and `pnpm_config_workspace_concurrency=1`; preserve/remove only this call's environment afterward. Then `pnpm --filter @workspace/command-center run build`, `pnpm --filter @workspace/api-server run build`, and `node scripts/local-dev.mjs parity`. Expect all exit0 with actual owned cleanup. No duplicate UI/full-suite/native drill absent a changed dependency or failure.
- [ ] Scan the exact Git patch/new redacted evidence using installed `C:/Forge/tools/gitleaks/8.30.1/gitleaks.exe`; retain input hashes/raw result. From the candidate checkout run `& 'C:/Forge/tools/gitleaks/8.30.1/gitleaks.exe' git --log-opts='91b7fd2c1fd98d441848e0357954e35c9f65d688..HEAD' --redact --no-banner --report-format=json --report-path (Join-Path $runEvidence 'source-gitleaks.json') .`, then its `dir` mode on only this run's redacted evidence with a distinct report file. Run `git diff --check` on the new delta and full candidate. New delta must be clean; keep known inherited transcript EOF warnings separately attributed. Any scanner finding requires a concrete classification/correction, never silent suppression.
- [ ] Obtain fresh whole-branch spec/quality review against both P and O, including all C01–C20 and both native schema stages. Resolve blocking/Important findings and rerun only affected checks if source changes. Verify exact frozen HEAD/tree and current artifact/oracle/manifest mappings; write truthful actual status and final attestation externally, without a source amendment or relabeling an old proof.
- [ ] Reverify correct GitHub account/private repository/main/base/ref and clean source. ROOT may make one ordinary private fast-forward push and create a dependent DRAFT candidate PR against PR59's branch, documenting inclusion of exact O and preservation of the old stack. Attach the PR to this chat, verify actual remote readback, observe exact-head CI through tests/types/builds/Docker parity and confirm the CI checkout tree equals the reviewed source. Unknown push outcome is read back, never blindly repeated. No public publication or merge to main.
- [ ] Save a final source-only attestation, raw failures/successes/reviews and cleanup dispositions; update Forge/project state and release the coordination lease. Next is preparation of the exact hosted Reader/backup/staged-upgrade/recovery/cleanup packet with current budget/pricing and applicable fresh approval. Compatible rollback/full mutation hold and contractor/provider cutover remain separate open gates; no additional paid resource is created in this plan.

## Dependency and review gates

`T1 → T2 → (T3 || T4) → T5 → T6 → T7 → T8`.

Each task has fresh spec and quality review before its dependent begins. ROOT alone integrates accepted commits and records exact function/fixture interfaces; no worker guesses another lane's API. T3/T4 are the only planned parallel source lanes. Container/native/full-suite/recovery/build runs are sequential under ROOT's resource ownership. GEEKOM reviews frozen evidence without duplicating implementation or runtime work.

| GEEKOM acceptance rows | Owning tasks |
| --- | --- |
| C01–C02 | T1, T2, T8 |
| C03–C04 | T2, T3, T6 |
| C05–C07 | T3, T5, T6 |
| C08 | T4, T5, T6 |
| C09–C17 | T7; unchanged product behavior retained and actual combined artifact bound |
| C18 | T7/T8 retain and verify the release hold; implementing a compatible artifact/full hold is outside this plan |
| C19 | T1–T8 for each task's exact created resources; heavy native closure T6/T7/T8 |
| C20 | T8 source-only attestation and separate next hosted/client gates |

## Self-review and owner handoff

ROOT must check this plan against the approved design without delegating the self-review: complete spec coverage; exact files/exports/keys across tasks; five Review Focus cases assigned; no undefined helper or placeholder; each step independently checkable; no program bodies masquerading as a plan. Record the final plan hash and coverage receipt after corrections.

After owner plan review, execute with the already selected scoped-agent/independent-review method; do not ask Adam to choose the method again. Save the immutable approved plan, task ownership/status, command/cleanup receipts and every accepted checkpoint. Preserve all completed saved-scheduling tasks1–13 and their paused completion automations. The workstation backup heartbeat remains separate and active.
