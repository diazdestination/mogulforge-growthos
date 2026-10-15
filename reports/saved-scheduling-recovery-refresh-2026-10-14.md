# Saved scheduling recovery refresh — 2026-10-14

Task12 refreshes the strict production pin after the reviewed scheduling checkpoint. The only harness-code changes are the two exact constants in `scripts/saved-scheduling-recovery-fixture.mjs` and an assertion that the real API's returned reduced policy has `minimumTravelGapMinutes === 5`. No API/lib, SQL, schema, build checks, other tests, historical reports or historical receipts changed.

## Exact identities and execution

- Reviewed production source: `2a62bf754204b7a218249acba6abe32e656d2ce1`, tree `dc7a1895f43dc992d24c0908f8d5feae74c74f6f`.
- Committed standalone harness: `6a8ee822c4d407969821e9efa8c0cda26efab34c`, tree `ddb5aa9371adc2816dba3561739c68452cc6dd39`. This is a scripts-only descendant of the production checkpoint.
- Actual standalone checkout was clean, `candidateCommitted=true`, tracked binary diff SHA256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. The build stamp names the actual harness commit, with `builtAt=2026-10-15T01:20:28.027Z` and environment `test`; no clean-source override was supplied.
- API/lib Git diff against the reviewed production commit is zero bytes. The normal test suites ran before the fixture commit, with the fixture edit still dirty; their result is not represented as a clean committed build.
- Node `v24.19.0`, pnpm `11.3.0`. Worktree-only `pnpm install --offline --frozen-lockfile --ignore-scripts` succeeded: 773 cached packages reused, zero downloads. No global runtime/config/dependency change.

## Executed RED and GREEN

The old pin was actually executed on the clean checkpoint before edits. Standalone `node scripts/contractor-recovery-drill.mjs` exited 1 with `CONTRACTOR_RECOVERY_FAILED:assertion`; its owned source database closed. The existing recovery test also exited 1, with 1 failure and no skips, locating the exact `contractor-recovery-drill.mjs:294` assertion: `accepted production source must remain exact`, `82749 !== 0`. This classifies the actual old-pin failure as production-scope incompatibility. Both original failed-run receipts and diagnostics are retained in the new owned directory.

After the narrow fix, `pnpm --filter @workspace/scripts exec vitest run contractor-recovery-drill.test.mjs saved-scheduling-rollback-boundary.test.mjs saved-scheduling-schema-preview.test.mjs` passed all 3 files and 34 tests in 104.68 seconds, with zero failures and zero skips. No skip flags, test/config edits or altered test scope were used. The committed-harness standalone `node scripts/contractor-recovery-drill.mjs` then exited 0 and emitted the fresh real-app recovery receipt.

## Preserved recovery boundaries

The fresh standalone receipt verifies:

- All 19 canonical SQL predecessors plus `0019_saved-scheduling-policy.sql` byte pins; 142 table identities, three nullable JSONB additions with no backfill, unchanged prior rows/catalog.
- Genuine read-only Reader SQL write denial and HTTP 405, 91 read checks, read-only scheduling holds and tenant boundaries.
- Exact source/restored raw-row fingerprints and effects; known originals, uncertain sends/receipts, private work history, original acknowledgements, retained identity/replay behavior and 28 export datasets. Six manual outcomes and three source outcomes remain preserved; invalid policy/export-bound and legacy-compatibility checks remain enforced.
- Four real-app cases: reduced and disabled current policy, each against an existing appointment and project carrying saved 60-minute reservations. Controls return 201; 59-minute gaps refuse with 409 / `manual_scheduling_refused` / `no_commit_refused` / `travel_conflict`, only two allowlisted audit inserts and zero other writes; exact 60-minute equality returns 201. The reduced-mode returned policy is explicitly asserted to be 5 minutes.
- Eleven owned cleanup receipts: five child exits and socket stops, five closed databases, and one removed resolved owned build directory. Cleanup verified true; provider calls zero.

Local candidate compatibility is true, while `releaseEligible=false` and rollback remains **HELD** with `second_compatible_artifact_unverified`. This does not establish a second independently verified compatible artifact, a full hosted write hold, multi-session PostgreSQL/Fly rehearsal, provider/device/client acceptance or deployment authority. Evidence uses PGlite embedded PostgreSQL and a built real application locally. No provider, auth-key, `.env`, hosted, paid, live-customer or publication action occurred.

## Fresh evidence and hashes

New owned directory: `reports/saved-scheduling-recovery-refresh-20261014-task12-181716/`. `manifest.json` records actual production and harness identities; 41 Git blob/byte/SHA256 and working byte/SHA256 records; strict zero production-scope diff; SQL/schema pins; all 10 actual newly built entry/worker/source-map file bytes and hashes; build stamp; snapshot and clone fingerprints; enforcement and cleanup receipts. It uses this run's bytes and does not splice a historical artifact manifest. Bundles were fingerprinted and then removed by the verified owned cleanup.

- Schema SHA256: `81a6615344994e7465657b48311c6d9cbc75ac76ed61a3849a5680af2a3c92e4`.
- SQL identity SHA256: `1fe0abae18e69aa3bd7ccb0d407b960c5b9e328235d6abf6fd1759fef5142d67`.
- Fixture SHA256: `bdbe2b39a9b8b4a2d97c6998cde1b71660a06453cc21d3e734534178f4021829`.
- Artifact manifest SHA256: `bf8a6b3bdd734aa7aab85ea820b07b57d6cfc430a42826cc92424017861af42d`.
- Snapshot SHA256: `96b865f27c1e31a2f880ae0f7b2fe20996e1bc89ff7602afdc71aea3ed36cd80`.
- Exact source/restored fingerprint: `63d252ffd3c5b8e9c71f99540ae65c202e52658e7724c55617281dd26e80dcaa`.

Self-review confirmed the three-line fixture scope, exact pin/tree resolution, the assertion's use of the returned policy, preserved guard/SQL/Reader/replay/cleanup/rollback checks and no API/lib changes. Gitleaks 8.30.1 redacted fixture source scan exited 0 with zero findings. Final scoped evidence scans and the SDD review package are recorded in the ignored `work/task12-refresh-evidence/task-12-recovery-refresh-report.md` for root's independent review. No push was performed.
