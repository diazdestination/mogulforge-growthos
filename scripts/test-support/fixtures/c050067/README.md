# Frozen c050067 test inputs

These are exact source snapshots from `git show c050067000f3ea1f2d94aa53b3a9c4f71f0d3b41:<path>`:

- `index.ts.txt`: `artifacts/api-server/src/index.ts`
- `automation.ts.txt`: `artifacts/api-server/src/services/automation.ts`
- `scheduler-runtime.ts.txt`: `artifacts/api-server/src/services/scheduler-runtime.ts`
- `reactivation.ts.txt`: `artifacts/api-server/src/services/reactivation.ts`

The reactivation snapshot's LF-normalized SHA-256 is
`972a2a3ee396aa81811fdad6e2ef664ccede6dad2ddeb448b2ac1c6d0ded9327`,
matching the unchanged `CRASH_SOURCE_HASHES` entry. The test reader freezes it
because current opportunity-history and source-hold changes are not part of the
recorded historical release. Tests explicitly reject those current bytes under
the historical pin and retain the independent helper/source/bundle tamper cases.

Their original SHA-256 pins remain in the unchanged hosted acceptance harnesses.
Tests check those pins against these snapshots and still reject tampered/current
bytes. The current scheduler/new notification stage is tested separately against
the current schema. Historical mocked supervisors and the disposable historical
schema/runtime compatibility tests are not new hosted or production proof.

Only the test-support reader/loopback test bundler uses these files. Hosted
readers continue to read the actual deployed application, require the old image
identity and refuse changed sources. Do not repin the old image, weaken its
guards, import these fixtures into a hosted probe, or replay its completed nonce.

## Reactivation fixture repair verification — October 1, 2026

CI run `36946564027` and a focused local reproduction both failed two crash
attestation tests because they compared current reactivation source against the
old hash. The recovered snapshot above fixes that test-input mismatch without
changing the release SHA, image reference, manifest hashes or hosted readers.
The missing-bundle and mismatched-bundle tests reach their intended guards again.

- Focused hosted crash guards: 8 passed, including historical startup and
  reactivation hash checks and rejection of the actual changed current bytes.
- `pnpm --filter @workspace/scripts exec vitest run pilot-crash-drill.test.mjs pilot-scheduler-idle.test.mjs pilot-scheduler-probe.test.mjs --maxWorkers=1`:
  60 passed in 3 files, exit 0, 65.52 seconds. This includes the existing timed
  idle-runtime check against disposable loopback PGlite.

These are local test results; they add no hosted or provider acceptance evidence.
