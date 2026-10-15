# Saved scheduling UI fixture compatibility — 2026-10-14

This test-only change reconciles three existing UI suites with the independently accepted sparse PATCH and current-conflict explanation behavior. All 40 original cases remain: appointment properties 20, ServiceDesk 14, contractor scheduling 6. The earlier brief's 47 was a ROOT clerical error, corrected before implementation. No product defect or further product change was found or made.

Base: `f193ff7a40e81f97a371aaaa0f512ca7af5dbcc7`, tree `7b1f65558f463c891b08bd376ba18cf0e2373a58`. Branch: `agent/growthos-ui-fixture-compat-20261014`. Isolated worktree: `C:/Forge/worktrees/growthos-scheduling-final-corrections-20261014`. The previous f56 branch and evidence remain intact. Exact final commit/tree and file/log SHA256 manifests are in `work/task12-ui-fixture-compat/final-receipt.json` and `artifact-hashes.json`.

## Actual RED and GREEN

Both runs used the existing normal focused command, with no runner/configuration/environment changes:

```powershell
pnpm --filter @workspace/command-center exec vitest run src/pages/appointments-property.test.tsx src/pages/contractor-scheduling.test.tsx src/pages/service-desk.test.tsx
```

PowerShell resolved pnpm through `C:/Users/diazd/AppData/Roaming/npm/pnpm.ps1`; Vitest 4.1.10 actually executed all three files. Output was redirected to the owned `red.log` / `green.log`; separate exit receipts record actual native exit codes.

| Run | Appointment properties | Contractor scheduling | ServiceDesk | Total | Duration | Exit |
| --- | --- | --- | --- | --- | --- | --- |
| Unchanged RED | 14 fail / 6 pass | 2 fail / 4 pass | 11 fail / 3 pass | 27 fail / 13 pass | 7.36s | 1 |
| Corrected GREEN | 20 pass | 6 pass | 14 pass | 40 pass | 7.86s | 0 |

Zero skipped cases in either run. The exact same 40 test cases and parametrized inputs were retained; no tests added, removed, disabled, or weakened with broad matchers. All 27 failure names and their classification are retained in the ignored detailed report. There was one RED followed by one GREEN, with no retry or hidden intermediate run.

ROOT's original normal full run remains RED: 27 failures / 1443 pass, stopping before API execution. Its log SHA256 remains `1222f7c8dbc9e36ba06dbddab2b0b51ff2ea434e2e8e8effd9de55ad10ce1535`. This focused GREEN does not relabel that proof. A future full run requires ROOT's separate authorization after fresh review/integration.

## Verified causes and exact changes

- Appointment properties: 13 create/save cases selected the first POST and therefore read the explanation request instead of the appointment command. The helper now requires exactly one explanation POST after explicit review, validates its closed request schema and precise interval, then waits for exactly one `POST /api/v1/appointments`. The entire POST route sequence must equal those two exact paths in order, so an unknown/duplicate/effect POST fails. Earlier zero-POST authority/source assertions remain unchanged.
- Appointment historical edit: one case required unchanged source/date fields. It now requires the exact notes/version-only PATCH and explicitly rejects unchanged source, resource, date, type/status, property, and scheduling-review fields. This historical fixture never supplied a persisted target fingerprint; the assertion forbids inventing one. The exact appointment PATCH route and absence of property reads remain checked.
- Contractor scheduling: two pure-release cases required unchanged dates. They now require exactly notes, explicit `assignedUserId: null`, the original optimistic version, and the real fixture's target fingerprint. Explicit negative checks reject unchanged source/date/type/status and review fields. The material-reschedule case still requires its changed absolute times, fresh review, explicit unassignment, optimistic version, and fingerprint.
- ServiceDesk: 11 authority/refresh cases failed in their shared local helper because it required zero POSTs after explicit review. It now requires exactly one POST to the exact explanation route and exact closed query/context/interval/resource body. Thus no booking, conversation, reminder, SMS, other command, or unknown POST is permitted at that point. Earlier all-POST-zero checks, authority revocation, late callbacks, and child-command refresh assertions are unchanged.

No shared or local mock response handler changed. These suites retain their previous fallback behavior, including an unavailable explanation response; they test request accounting and existing UI authority behavior, not successful explanation service execution. The accepted real API bridge proof remains a separate historical receipt and is not rerun or replaced here. The explanation is application-read-only, and normal review locks / restore-read-only 405 classification are unchanged.

## Source and resource boundaries

Only the three named test files and this new report changed from BASE. Product UI, API, libraries, schemas, generated clients, SQL, providers, shared fixtures, scripts, runner configuration, timers and coverage have zero Git blob/source-byte changes from BASE; product UI/API/library blobs also remain identical to strict f56. Existing f193 recovery/launcher changes are preserved. `scope-proof.json` records the exact comparisons.

The three tested file SHA256 maps are identical before and after GREEN. Source stayed frozen until the synchronous test process completed. Native launcher receipts record RED PID 26876 and GREEN PID 21796 with their creation timestamps; both identities are absent afterward. Before/after process inventories contain no remaining Vitest, pnpm or owned-worktree Node process. Unrelated MCP/CUA servers changed during the interval and were preserved. Child PID identities were not sampled while these short synchronous runs were active, so this does not claim a full descendant-identity audit. No termination was attempted, and no database, container, volume or browser was created. ROOT was notified after closure and may run its separate browser proof.

Scoped `git diff --check` and redacted Gitleaks 8.30.1 scans of the four changed source files and full-index patch passed with zero findings. Local evidence includes scan outputs, hashes, exact request-accounting diff, exit receipts and resource receipt. Commit uses the canonical ephemeral author/committer `Adam Mach <302037174+diazdestination@users.noreply.github.com>`; no repository/global identity setting changed.

No full suite, browser run, native API/PG test, recovery/parity/typecheck, install, remote operation, push, merge, deployment, provider action, spend or customer contact was performed for this task. Fresh independent review is still required before integration.
