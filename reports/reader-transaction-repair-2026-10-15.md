# Reader observation transaction repair — October 15, 2026

The approved hosted rehearsal verified restored-copy Reader creation/profile access, then held before any upgrade reservation or upgrade SQL. The owned copy was deleted. The recorded generic callback failure does not retain the underlying exception, so its hosted cause remains unknown.

## Demonstrated source defect and repair

Both the legacy and scheduling verification callbacks opened a repeatable-read, read-only transaction on the main Reader before capturing two other databases through separate connections. Their connection and observation time consumed the main Reader's existing 20-second idle-in-transaction budget. A delayed other-database capture could terminate the main session; its subsequent rollback could also mask the observation's original error.

The repair completes those other-database captures before opening the main Reader transaction. Main state and extras still share their original read-only transaction. Existing identity, capability, phase, preserved-data and protected-app checks remain intact. Production timeouts, writer permissions, mutation admission, deadlines and cleanup authority are unchanged.

## Verification

- Synthetic tests extract both actual private callback bodies and use existing synthetic policy fixtures. No private packet data is embedded. Before the repair, six regressions fail for slow capture/error masking; after it all12 pass. Short observations, delays of20,001/60,000ms, original-error propagation, rollback after main-observation errors and zero writer calls are covered.
- Full scripts suite:54files,1,091passed,0failed.
- Independent source review: approved; no Critical or Important findings. Reviewed runner SHA256 `76393502f82d7c4b3086233d5446900a692835da6280d4bcbda1b370d09c6e2c`.
- Real local PostgreSQL16: both old callbacks fail with server SQLSTATE25P03 during an actual21-second delay on another connection. Both fixed callbacks finish successfully and remain usable, with one begin/rollback each and zero writer calls. All8clients close; the labeled tmpfs container is absent and WSL session closed. Receipt: `native-reader-timing-03.json`.
- Full workspace TypeScript checks passed. Combined native proof at `119470b` passed and was independently accepted, with its console-wrapper exit-code limitation retained. This later CI-only change needs a newly matching native result and CI; earlier results are not repinned.

## Bounded CI timing correction

Two unchanged-source CI attempts at `119470b` reached the existing 30-minute job limit. The second log retained all five failed preparation/approval tests' actual exceptions: each exceeded the scripts suite's 10-second test timeout. These paths do not invoke the changed Reader callbacks. Unchanged suites also ran substantially slower than the earlier candidate's green CI; an infrastructure cause remains unproven.

The scripts suite now allows 20 seconds per test, matching the existing API/UI default. The CI job allows 45 minutes for all test, build and parity checks. A bounded pre-test diagnostic records Node, platform, architecture, CPU availability, memory and load averages without environment values. Assertions, skips, test fixtures and production deadlines are unchanged.

At `82ef7f7`, CI38838425216 completed with all6,719 Vitest assertions passing and15 existing skips, but two API `afterAll` hooks exceeded their separate10-second limit. Later website, type, build and parity checks did not run. The complete native proof at that head passed with actual CLI exit0 and independently verified cleanup. These results do not constitute source acceptance.

Both failed hooks await `deleteTestOrgs`. Their unchanged helper has finite FK-safe retries and a final absence check, but no per-query or pool-acquisition timeout. The available logs do not establish whether cleanup was slow, blocked, waiting for a connection or continuing after Vitest timed out. No cleanup completion or hosted-failure cause is inferred from passed assertions.

That CI runner reported two available CPUs. API overlapped UI, then scripts; Vitest's default on that host was one worker per project. CI now serializes non-API workspaces and runs API separately, explicitly preserving that one-worker limit. The established local runner already uses this workspace ordering, with two workers on its different host. This change tests the resource-contention hypothesis without raising API hook limits, skipping suites or weakening cleanup checks. Fresh matching native evidence and all CI gates are required; if isolated cleanup still fails, investigate and bound the helper separately rather than treating teardown failures as harmless.

Local validation preserves a fixture-setup qualification. The proposed commands passed all2,695 non-API assertions and3,740 API assertions, including both previously affected cleanup hooks. The custom local harness supplied an inadmissible fixture marker/name, so scheduling-schema setup correctly refused its target and skipped284 cases; the full API command exited1. All284 cases then passed through the existing admitted local runner. Aggregate local coverage is6,719 passed with15 baseline skips across those runs, not a successful full API command. The focused runner's new anonymous volume was privately archived, positively bound through its exact run-specific catalog identifier, independently reviewed and removed; all392 pre-existing volume names were restored. The failed API receipt and its absent WSL success flag remain unchanged. New exact-source native proof and successful full CI are still required.

Evidence is retained under `C:/Forge/artifacts/growthos-live-preflight-20261015/`: `reader-transaction-red-02.log`, `reader-transaction-green.log`, `reader-transaction-scripts.log`, `reader-transaction-review.md`, and separately numbered native attempts. The earlier CRLF test-harness failure and native setup failures remain separate historical receipts.

## Release boundaries

Base is the frozen private draft PR60 at `cf3b90c731da1996233f5a3b51038b06d7354b57`. Its source attestation and hosted execution packet remain immutable. This changed runtime requires fresh matching local/native evidence and any future hosted admission; no old attestation is repinned.

The single approved paid-copy grant is consumed. No second copy, original database/app mutation, provider activation, main merge, deployment or public launch follows from this repair. Actual Fly billing remains unverified. A later independent guard found production started through Fly proxy with unchanged configuration/secret metadata; a separate read-only diagnostic matched original data, but neither restores the stopped-runtime premise nor establishes the earlier callback's cause. The operator did not start or stop original apps.

Before another hosted attempt, retain safe bounded phase/error diagnostics and resolve the runtime premise, then prepare a newly bound packet and any required financial authority. Full hosted upgrade/rollback/recovery, compatible writable recovery artifact OR complete mutation hold with forward recovery, full G04/G06 and both contractors' real configuration/import/staff/provider/device/cutover acceptance remain open. Contractor card/bank payment collection stays deferred.
