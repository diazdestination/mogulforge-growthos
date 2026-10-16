# Bounded callback diagnostics

The hosted rehearsal held with only `production75_operator_callback`, which hid
the underlying observation boundary. This source change keeps that classification
and existing unknown-effect rules while adding a small content-free diagnostic
snapshot. It does not establish the cause of the earlier hosted failure.

`production75-safe-diagnostics.mjs` owns the metadata privately. It admits only
fixed safe codes, fixed stages, and five-character uppercase SQLSTATE data from
own driver data descriptors. It rejects proxies, getters and coercion. Results
contain one primary diagnostic and at most the first secondary; serialization
seals the source record against late changes. Unknown errors use a fixed fallback.
Primitive thrown values retain their exact identity; their diagnostic uses the
callback fallback because they cannot carry private per-error metadata.

Both native Reader callbacks name the observation stages. Both supplied-client
observers retain privately owned metadata when replacing a transport error with
their existing sanitized error. Connect, Reader rollback, and cross-database
snapshot closure preserve the primary failure if later cleanup also fails.
Closure-only failure still rejects, and failed disposal remains unconfirmed.

Idle-event and query SQLSTATE diagnostics never set `.code` or `.severity` and do
not satisfy settled SQL rejection, commit, retry, admission or release predicates.
The pre-existing scheduling writer opt-in for settled server errors is unchanged.
No raw message, cause, stack, SQL, parameter, credential, row or customer detail is
added to the result.

Behavioral tests cover actual transport through both real observers and operator
serialization; successful rollback after a query rejection; idle events; fatal
query errors; falsy primary values; primary/secondary cleanup; sealing; per-client
association; and malicious properties. The runtime manifest now contains 26
modules, including the new helper. Old 25-module native receipts remain historical.
Fresh local scripts/type/native receipts and independent reviews are kept in
`C:/Forge/artifacts/growthos-safe-diagnostics-20261016/` and bind the local commit
and runtime hashes separately. No new CI or remote acceptance is claimed.

This is local source work. Original application containment, fresh hosted Reader,
upgrade/rollback/recovery, current pricing/new spending approval, provider/device
acceptance and both complete contractor workdays remain separate HOLD inputs.
The prior one-copy USD0.15 grant is consumed; release eligibility remains false.
