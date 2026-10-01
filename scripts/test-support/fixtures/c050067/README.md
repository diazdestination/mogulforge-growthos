# Frozen c050067 test inputs

These are exact source snapshots from `git show c050067000f3ea1f2d94aa53b3a9c4f71f0d3b41:<path>`:

- `index.ts.txt`: `artifacts/api-server/src/index.ts`
- `automation.ts.txt`: `artifacts/api-server/src/services/automation.ts`
- `scheduler-runtime.ts.txt`: `artifacts/api-server/src/services/scheduler-runtime.ts`

Their original SHA-256 pins remain in the unchanged hosted acceptance harnesses.
Tests check those pins against these snapshots and still reject tampered/current
bytes. The current scheduler/new notification stage is tested separately against
the current schema. Historical mocked supervisors and the disposable historical
schema/runtime compatibility tests are not new hosted or production proof.

Only the test-support reader/loopback test bundler uses these files. Hosted
readers continue to read the actual deployed application, require the old image
identity and refuse changed sources. Do not repin the old image, weaken its
guards, import these fixtures into a hosted probe, or replay its completed nonce.
