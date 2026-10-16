# Reader observation transaction repair — October 15, 2026

The approved hosted rehearsal verified restored-copy Reader creation/profile access, then held before any upgrade reservation or upgrade SQL. The owned copy was deleted. The recorded generic callback failure does not retain the underlying exception, so its hosted cause remains unknown.

## Demonstrated source defect and repair

Both the legacy and scheduling verification callbacks opened a repeatable-read, read-only transaction on the main Reader before capturing two other databases through separate connections. Their connection and observation time consumed the main Reader's existing 20-second idle-in-transaction budget. A delayed other-database capture could terminate the main session; its subsequent rollback could also mask the observation's original error.

The repair completes those other-database captures before opening the main Reader transaction. Main state and extras still share their original read-only transaction. Existing identity, capability, phase, preserved-data and protected-app checks remain intact. There is no increase to timeouts, writer permissions, mutation admission, deadlines or cleanup authority.

## Verification

- Synthetic tests extract both actual private callback bodies and use existing synthetic policy fixtures. No private packet data is embedded. Before the repair, six regressions fail for slow capture/error masking; after it all12 pass. Short observations, delays of20,001/60,000ms, original-error propagation, rollback after main-observation errors and zero writer calls are covered.
- Full scripts suite:54files,1,091passed,0failed.
- Independent source review: approved; no Critical or Important findings. Reviewed runner SHA256 `76393502f82d7c4b3086233d5446900a692835da6280d4bcbda1b370d09c6e2c`.
- Real local PostgreSQL16: both old callbacks fail with server SQLSTATE25P03 during an actual21-second delay on another connection. Both fixed callbacks finish successfully and remain usable, with one begin/rollback each and zero writer calls. All8clients close; the labeled tmpfs container is absent and WSL session closed. Receipt: `native-reader-timing-03.json`.
- Full workspace TypeScript checks passed. A refreshed combined native oracle and CI remain pending; each result must be read from its actual new receipt.

Evidence is retained under `C:/Forge/artifacts/growthos-live-preflight-20261015/`: `reader-transaction-red-02.log`, `reader-transaction-green.log`, `reader-transaction-scripts.log`, `reader-transaction-review.md`, and separately numbered native attempts. The earlier CRLF test-harness failure and native setup failures remain separate historical receipts.

## Release boundaries

Base is the frozen private draft PR60 at `cf3b90c731da1996233f5a3b51038b06d7354b57`. Its source attestation and hosted execution packet remain immutable. This changed runtime requires fresh matching local/native evidence and any future hosted admission; no old attestation is repinned.

The single approved paid-copy grant is consumed. No second copy, original database/app mutation, provider activation, main merge, deployment or public launch follows from this repair. Actual Fly billing remains unverified. A later independent guard found production started through Fly proxy with unchanged configuration/secret metadata; a separate read-only diagnostic matched original data, but neither restores the stopped-runtime premise nor establishes the earlier callback's cause. The operator did not start or stop original apps.

Before another hosted attempt, retain safe bounded phase/error diagnostics and resolve the runtime premise, then prepare a newly bound packet and any required financial authority. Full hosted upgrade/rollback/recovery, compatible writable recovery artifact OR complete mutation hold with forward recovery, full G04/G06 and both contractors' real configuration/import/staff/provider/device/cutover acceptance remain open. Contractor card/bank payment collection stays deferred.
