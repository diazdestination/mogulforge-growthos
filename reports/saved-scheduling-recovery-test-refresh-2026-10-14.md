# Strict saved scheduling recovery test pin refresh — 2026-10-14

The strict recovery fixture now pins the exact independently reviewed production checkpoint after its three-test repair. The entire harness code diff is exactly two constant values in scripts/saved-scheduling-recovery-fixture.mjs. The existing returned reduced-policy minimumTravelGapMinutes === 5 assertion remains intact. No API/lib, tests, SQL, guards, dependencies or configuration changed. Historical reports, artifacts and receipts remain immutable.

## Exact production and actual build identities

- Accepted production commit: 2901da320e41a47e77cc86e97d2c2f59fffa824d; tree f858832a833233ecf2f3844ad6222f0e6bbdcc8d.
- Actual committed standalone harness: 667f67618df01e3461774d1aed18be0d1e4b327f; tree aa5d79a6f2472afe302125451550312365d1f73b.
- The standalone checkout was clean: candidateCommitted=true, dirtyScope=[], tracked binary diff SHA256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.
- Actual build stamp: sha 667f67618df01e3461774d1aed18be0d1e4b327f; builtAt 2026-10-15T02:40:26.797Z; environment test. No build identity or clean-source override was supplied.
- Strict API/lib Git diff against the new production checkpoint is zero bytes, including all tests. The difference from the historical 2a62bf7 checkpoint is exactly the three reviewed test files; their fresh Git and working byte hashes are in manifest.exactChangedTests.
- Node v24.19.0 and pnpm 11.3.0. Worktree-only pnpm install --offline --frozen-lockfile --ignore-scripts reused 773 packages and downloaded zero; no dependency or global config changes.

## Executed RED and GREEN

Before editing, node scripts/contractor-recovery-drill.mjs actually ran on clean committed production checkpoint 2901da320e41a47e77cc86e97d2c2f59fffa824d. It exited 1 with CONTRACTOR_RECOVERY_FAILED:assertion; the owned source database closed. The existing contractor-recovery-drill.test.mjs then actually ran under the normal scripts Vitest configuration via node node_modules/vitest/vitest.mjs run contractor-recovery-drill.test.mjs from scripts/. It exited 1, 1 failed and 0 skipped, at contractor-recovery-drill.mjs:294: accepted production source must remain exact; 5043 !== 0. This is a meaningful strict production-scope pin mismatch, with exact failure diagnostics and cleanup retained.

After changing the two constants, the exact normal command pnpm --filter @workspace/scripts exec vitest run contractor-recovery-drill.test.mjs saved-scheduling-rollback-boundary.test.mjs saved-scheduling-schema-preview.test.mjs passed 3 files and all 34 tests, zero failed/skipped, in 75.81s. This run had the two-constant edit dirty and is not represented as a clean committed build. No filter, timer, config, skip or assertion weakening occurred.

The two-constant fix was committed first. The separate actual node scripts/contractor-recovery-drill.mjs standalone run then exited 0 from clean committed harness 667f67618df01e3461774d1aed18be0d1e4b327f; its build stamp, production identity and checkout receipts above come from that actual execution. No full application suite was rerun in this lane.

## Preserved recovery checks and release boundary

Fresh standalone receipts verify all 19 canonical SQL predecessors plus 0019 byte pins; 142 table identities; three nullable JSONB columns without defaults/backfill; unchanged prior raw rows and catalog. Source/restored fingerprints are equal and restored clone fingerprints bind the same source snapshot. Original and uncertain effects, private work history, identity/replay behavior and original acknowledgements are preserved. The real app verifies 28 export datasets, six manual outcomes, three source outcomes, invalid-policy withholding, bounded exports and legacy compatibility.

The genuine Reader uses SQL-enforced write denial and HTTP 405 and passes 91 reads, scheduling holds and tenant boundaries. Reduced and disabled current-policy modes each test existing appointment and project saved 60-minute reservations: controls return 201, 59-minute gaps return 409/manual_scheduling_refused/no_commit_refused/travel_conflict with exactly two allowlisted audit inserts and zero other writes, and 60-minute equality returns 201. The unchanged reduced-mode assertion explicitly reads the actual returned current.policy.minimumTravelGapMinutes and requires 5.

All 11 owned cleanup receipts passed: five child exits/socket stops, five closed databases, one removed contained .contractor-recovery-* build directory. The drill validates the resolved owned output before recursive removal. No protected original restore drill or ROOT retained build was touched. providerCalls=0.

candidateCompatible=true; releaseEligible=false; rollback **HELD**, reason second_compatible_artifact_unverified. No second independent compatible artifact or full scheduling-write hold is established. This is a local built-real-app PGlite embedded PostgreSQL rehearsal; it does not prove multi-session PostgreSQL/Fly/provider/staff/device/hosted acceptance. No Git remote, auth/secret, provider, hosted, spending, customer, migration, merge or deployment operation occurred.

## New evidence and provenance

Unique owned directory: reports/saved-scheduling-recovery-test-refresh-20261014-task12-test-pin-20261015024104778/. Its fresh manifest contains 2136 Git blob/byte/SHA256 and working byte/SHA256 entries: complete tracked API/lib inventory plus the local recovery import closure, canonical SQL, lockfile/manifests/configs. This conservative superset includes all three changed tests and does not exclude tests from strict scope. The manifest binds this run's 10 actual newly built entry/worker/source-map files, byte lengths and hashes; actual build stamp; SQL/schema pins; source/restored snapshot/fingerprints; enforcement and cleanup. It reuses no historical artifact objects. Built files were hashed before the verified cleanup removed them.

- Schema SHA256: 81a6615344994e7465657b48311c6d9cbc75ac76ed61a3849a5680af2a3c92e4.
- SQL identity SHA256: 1fe0abae18e69aa3bd7ccb0d407b960c5b9e328235d6abf6fd1759fef5142d67.
- Synthetic runtime fixture SHA256: 1e4f035ccb43db20ccf0e4ddc24535817ca61f0cf735ff23d4e49c349ba54fde.
- Actual artifact manifest SHA256: 1211bede44536b715931db0cf95d6cde614fcd05454190772d5b26f5acdf3056.
- Snapshot SHA256: 14f3ebb33ae3106895107106ced6af2050dc682d43d5137b900c71783a31f0e6.
- Source/restored fingerprint: affbdd4b59ff0fafb0ea5a520ddb5c2535b544d08e9e6ba95f8663ba15869dd3.
- New manifest raw SHA256: 5bed66a382a81f5faadcd26fb4a16cc055456f5e5e9aecac67774f8ff9cab67a.
- Fixture script working bytes SHA256: 7cad20aa75854c9210426c033c7ff6c83acdde2ab85001047d21fdd1a40887be.

Raw command stdout/stderr/exit receipts are copied verbatim from this execution. receipt-storage-provenance.json binds raw original bytes against staged Git blob bytes and keeps base64 raw envelopes where Git text EOL normalization changes bytes; decoding must match original raw SHA256. Raw bytes are not silently represented as normalized Git bytes. The manifest's receipt hashes identify originals.

Self-review confirms the exact two-constant code diff, production/tree resolution, zero API/lib diff and preserved reduced5/SQL/Reader/replay/cleanup/rollback guards. Gitleaks 8.30.1 scans use --redact=100, --ignore-gitleaks-allow and no added allowlist: fixture source and new receipt scans each exited 0 with zero findings. Their raw scan receipts are included. Final storage/delta scans and scoped diff checks are recorded in ignored work/task12-recovery-test-pin/report.md for ROOT's independent review before integration. No push.
