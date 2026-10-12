# Production backup restoration verified

Owner-approved retry packet71fed7d3 at
`C:\Forge\artifacts\growthos-production-restore-retry-20261012` passed.
The separate earlier64ddbaa9 FAIL and consumed grant remain preserved.

Independent review accepted the V1 acknowledgement/tombstone correction while
requiring authoritative empty-attachment evidence from live inventory before
SQL/DELETE.18 regression tests and45 additional offline guards passed;
the unchanged supporting scripts suite passed351 tests/28files. Final receipt
review passed312 independent assertions without provider calls.

One POST201 restored production backupbackup_1791779345_7a867e89d3cf91b9 into
q49ypo494e2017ln. Source-before, restored-copy and source-after all match aggregate
statef3f86450fa0760d7aeefc03c5494a18cd0eb7ba865a26e8d5046f9b63b6d22c8:
fly-db75tables/65records, growthos_staging75tables/119records and the empty
mogulforge-growthos-db database. This covers150application table fingerprints,
full catalogs/privileges/ACLs/global roles/settings and extension definitions.
Administrative repeatable-read READ ONLY observation is not distinct Reader
login proof; volatile extension telemetry/password material is outside the
comparison. All transactions rolled back and all owned transports closed.

One exact-owned DELETE202; terminal deleted/active absence confirmed at
05:39:06.456UTC. Active inventory contains only both originals. Both stopped
app configurations and secret metadata matched. Duration459.529seconds;
paid-resource time378.173seconds; best estimateUSD0.07, billing unverified.
No source/copy writes, migration, cutover, secret/config changes, deployment
or second resource. New grant consumed.

Evidence: retryresult.json, journal.jsonl, three observation receipts/nine
snapshots, independent-review.json, final-receipt.json and rotation-plan.json.
Root report: `C:\Forge\GROWTHOS_PRODUCTION_RESTORE_RETRY_2026-10-12.md`.
Invoice draftPR42 is published at exact6664df1 againstPR35/87adc3e.
Local leaked-password redaction is recorded with external/disk/WAL limitations.

Rotation is approved but unexecuted: production is providerV1; Fly's native
rotation is V2-only and the stopped historical production image supplies no
health proof. Any provider-generation migration and production cutover/private
runtime start require separately reviewed scope and owner admission. Rotation
approval itself need not be repeated. Managed75-to142 upgrade/recovery proof,
production role policy and required client/provider/device/company gates remain.
