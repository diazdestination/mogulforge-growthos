# Corrected scheduling source: exact recovery refresh — 2026-10-14

The strict recovery fixture now pins the independently accepted consolidated source correction. Only two fixture constants, an explicit restored explanation POST405 probe, and two focused assertions changed. Production API/lib/SQL/dependencies, normal configuration, guards and historical packets remain unchanged. This is recovery evidence for an existing held policy, not a new implementation RED/GREEN.

## Source and clean build identity

- Accepted production BASE/pin: f56e6cef452b5b564838a72202c0d37cd2caf384; tree 3e55c4fc984f64ac1fe187f109bf4323d0586a5e.
- Actual standalone harness: c7c76e297545c5b274db94ec002d126f2e5c6476; tree 1ec40aa1968607ab5fae79ea12f2ae47c2472ac4. candidateCommitted=true, dirtyScope=[], tracked diff SHA256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.
- Strict whole API/lib diff against production is zero bytes, including tests; no exclusions.
- Actual build stamp: {"sha":"c7c76e297545c5b274db94ec002d126f2e5c6476","builtAt":"2026-10-15T04:07:41.632Z","environment":"test"}. No identity/clean-source override, preload, NODE_OPTIONS injection or filesystem monkeypatch was used in the runtime. The external observer does not change the normal child command.
- Runtime: {"node":"v24.19.0","platform":"win32","architecture":"x64","postgres":"PostgreSQL 18.3 (PGlite 0.5.8) on wasm32-unknown-emscripten, compiled by emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 3.1.74 (1092ec30a3fb1d46b1782ff1b4db5094d3d06ae5), 32-bit"}. Existing local dependencies reused; no install, download, dependency or global setting change.

## Fresh executed evidence

1. On clean BASE before edits, node scripts/contractor-recovery-drill.mjs exited1: CONTRACTOR_RECOVERY_FAILED:assertion; the owned source database closed. Normal existing focused test also exited1, one failed/zero skips: accepted production source must remain exact, 129349 !== 0 at contractor-recovery-drill.mjs:294. Historical pin2901da3/tree f858832 remains preserved. The production difference has46 API/lib paths including5 test paths; exact fresh source hashes are included without exempting tests.
2. From scripts/, node node_modules/vitest/vitest.mjs run contractor-recovery-drill.test.mjs saved-scheduling-rollback-boundary.test.mjs saved-scheduling-schema-preview.test.mjs passed3 files/34 tests/0 failed/0 skips,73.03s. This had the scoped pins/probe/test changes dirty and is not the clean-build proof.
3. Committed the three scoped script changes, then the exact node scripts/contractor-recovery-drill.mjs command exited0 from the clean harness above. Actual elapsed 33265ms and restore verification 16803ms. No full normal application or browser suite ran in this lane.

The actual restored real app remains a genuinely SQL-denied Reader:91 successful read checks; HTTP write denial; tenant/privacy/history and scheduling-hold checks passed. POST /api/v1/scheduling/conflict-explanation returned405, ok=false and exactly {error:'Restore drill permits read-only inspection only'}. There was no successful availability/explanation response and this denial was not added to the91 successful reads. The middleware's POST policy is unchanged even though the ordinary endpoint is logically application-read-only and uses review transaction locks.

Fresh recovery verifies142 table identities,19 canonical predecessor SQL identities plus0019 (20 total), three nullable JSONB columns without defaults/backfill, unchanged previous raw rows/catalog, and equal source/restored/clone fingerprints. The built app checks28 approved export datasets,6 manual outcomes,3 source outcomes, original outcomes, private history, originals/unknown effects, identity/replay, invalid-policy withholding, bounded exports and legacy compatibility. Raw runtime table counts are retained in the new manifest and standalone transcript, not copied from an older run.

All4 reduced/disabled appointment/project cases preserve saved60-minute reservations: controls201,59-minute gap409/manual_scheduling_refused/no_commit_refused/travel_conflict, exactly2 allowlisted audit inserts and0 other writes per refusal, equality60 returns201. The existing reduced-mode assertion still requires actual returned current.policy.minimumTravelGapMinutes===5.

candidateCompatible=true; releaseEligible=false; writable rollback **HELD**, second_compatible_artifact_unverified. No independent second compatible artifact or complete scheduling-write hold is established.

## Owned resources and cleanup

All11 runtime cleanup receipts passed:5 child exits/socket stops,5 database closes (source, reader, reconcile, reduced, disabled),1 removed contained build directory .contractor-recovery-VtkTyj. No container or volume was created; PGlite databases are embedded in-memory lifecycle objects. The external observer independently recorded PID+creation time for7 processes (runtime24300, esbuild9848, app children31416/9708/11520/24704/30080), and the exact build directory creation/birth/resolved path. Every original observed process and build directory was absent at final check. Observer18468 exited0. Parent/capture process26744 naturally completed; no broad kill/prune or manual runtime deletion was performed. Build output had10 files and was hashed before contained cleanup.

Limits: polling can miss short-lived helpers. The earlier normal-suite build .contractor-recovery-yfxHCq is identified by raw build stderr and was absent afterward; its creation timestamp was missed after suite cleanup. Initial packaging attempt failed ENOENT for that optional empty-observation file; its partial newly created packet and diagnosis are retained in ignored work/task12-corrected-recovery/packaging-attempt1-incomplete and packaging-attempt1.failure.txt. No runtime failed or cleanup remained incomplete. Original protected workstation drill and unrelated retained11-file aborted build were not touched. Historical2a/6a8 and2901/667 source/report/receipt objects remain immutable.

## New evidence and hashes

New unique receipts: reports/saved-scheduling-corrected-recovery-20261014-task12-corrected-20261015040833664/. The manifest inventories2167 committed Git blob/byte/SHA256 and working byte/SHA256 entries: complete API/lib plus recovery import closure, three focused test inputs, SQL, dependency manifests/lock and configs. It binds the46 accepted-source changed paths and5 changed tests, actual10 newly built entry/worker/source-map bytes/hash, source/runtime/build identities, snapshot/fingerprints, enforcement and cleanup. No historical artifact object was reused. Execution helper byte/hash provenance is separate from committed product source. The unused ignored resource-observer.mjs draft was never executed; final runtime observation uses only external observe.ps1.

- Schema SHA256: 81a6615344994e7465657b48311c6d9cbc75ac76ed61a3849a5680af2a3c92e4.
- SQL identity SHA256: 1fe0abae18e69aa3bd7ccb0d407b960c5b9e328235d6abf6fd1759fef5142d67.
- Synthetic runtime fixture SHA256: 30dad70a52cbaafb939dc7b4370afe49f83866c14c7d80d47bf20dd6916c6393.
- Actual10-file artifact aggregate SHA256: e06d75ad78862d094a496add29f55cad5882fdbca80ae2af802e6a0e53a6e3f2.
- Snapshot SHA256: 789d230e58f08db6ae5a866184ea853d76003f932df826d0f43197b7a0efecc1.
- Source/restored fingerprint: f0cc685de31e1bad6ba8e9f48cde7df5aec6a50f738898b430b18e7693dc1f2a.
- Manifest raw SHA256: 8a144f3e7ba42b78428acd6f13ccf8af5650479bd828cbcfcf8d7f7204f3bcb6.

Raw stdout/stderr/exit files preserve actual command bytes. receipt-storage-provenance.json distinguishes original raw bytes from Git EOL-normalized blobs and retains base64 envelopes when required; decode and hash to reproduce the original. Fresh Gitleaks8.30.1 redacted scans of all3 changed source files and initial new receipts each exited0/zero findings, without allowlists. Final evidence/patch/report scans and exact scoped self-review are in ignored work/task12-corrected-recovery/report.md. ROOT independent scoped review is required before integration; no push.

Provider calls0. This is actual embedded PGlite/real-app/SQL-denied Reader recovery; native multi-session PostgreSQL, Fly/hosted/provider/staff/device acceptance, release eligibility and writable rollback are unproven. No remote, provider/auth/secret, spend, hosted migration, customer contact, merge, deployment or launch action occurred.
