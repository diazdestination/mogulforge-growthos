# Frozen c050067 test inputs

These are exact source snapshots from `git show c050067000f3ea1f2d94aa53b3a9c4f71f0d3b41:<path>`:

- `index.ts.txt`: `artifacts/api-server/src/index.ts`
- `app.ts.txt`: `artifacts/api-server/src/app.ts`
- `automation.ts.txt`: `artifacts/api-server/src/services/automation.ts`
- `scheduler-runtime.ts.txt`: `artifacts/api-server/src/services/scheduler-runtime.ts`
- `reactivation.ts.txt`: `artifacts/api-server/src/services/reactivation.ts`
- `durable-execution.ts.txt`: `artifacts/api-server/src/services/durable-execution.ts`
- `schema-automations.ts.txt`: `lib/db/src/schema/automations.ts`
- `schema-revenue-workspace.ts.txt`: `lib/db/src/schema/revenue-workspace.ts`

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

## Automation schema fixture repair — October 2, 2026

The customer-care wave evolved `AutomationAction` in the current automation
schema source. The historical crash attestation correctly rejected its changed
bytes, causing the source-attestation and missing-bundle guard tests to stop
before their intended assertions. The old source was recovered verbatim from
the same `c050067000f3ea1f2d94aa53b3a9c4f71f0d3b41` Git object above, with
LF-normalized SHA-256
`6987bd462afed4f34cf10d124f41c8b013c3815ec1bf85e18aa448633858facb`.

Only the test reader/bundler maps this newly evolved file to its frozen input.
The added regression verifies that original hash, proves the frozen file was
read, and rejects actual changed current schema bytes under the old pin. The
hosted crash operator, manifest pins, release identity and bundle/helper tamper
checks are unchanged. This does not authorize replaying any hosted drill.

Verification: all frozen manifest hashes passed, and
`pnpm --filter @workspace/scripts exec vitest run pilot-crash-drill.test.mjs pilot-scheduler-idle.test.mjs pilot-scheduler-probe.test.mjs --maxWorkers=1`
passed **62 tests in 3 files**, exit 0, 66.08 seconds. The actual timed idle
runtime ran only against disposable loopback PGlite with provider/network deny.
No hosted drill, migration, provider call or external write occurred.

## App and revenue schema fixture repair — October 2, 2026

The operations wave adds a bounded financial-import parser to current `app.ts`
and a tenant-scoped parent key to the current revenue schema. Neither change
belongs to the historical release. Comparing those current bytes with its pins
correctly failed the source-attestation test and stopped the missing-bundle test
before that test reached its intended assertion.

Both new fixtures above were recovered verbatim with read-only `git show` from
the same historical commit, then verified against the unchanged manifest:

- `app.ts.txt` LF-normalized SHA-256:
  `9ea0d5845888d8e1569b783158bce7e66e97e2a10a0e8ed068046e5fb97b13b8`
- `schema-revenue-workspace.ts.txt` LF-normalized SHA-256:
  `91170ea70914b2303cb901b5461237d35205d2a87a92e37fef83a7f05c744a25`

Only the historical test-support reader/bundler maps these files. New
regressions require those exact hashes, prove the frozen files are read and
reject actual evolved app/schema bytes under the old pins. No hosted harness,
release SHA, image reference, source manifest, helper guard or bundle guard was
changed. The initial focused guard run had 8 passing and 2 failing tests; after
repair and two new regressions it passed all 12 selected guard tests (7 other
tests were unselected by the focused name filter, not newly skipped).

The complete three-file historical regression command shown above then passed
**64 tests in 3 files**, exit 0, 71.35 seconds, with no skips. This includes the
timed idle check and crash recovery on fresh disposable loopback PGlite. No
current-release, real PostgreSQL, hosted or provider acceptance is implied.
