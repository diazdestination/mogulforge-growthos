# One paid production restore attempt — FAIL; cleanup PASS

Adam authorized one paid restore rehearsal, excluding migration, cutover,
secret/config changes, deployment and any second resource. Cost/duration was
printed before creation. Exact PR35 source remains `87adc3e`.

Packet: `C:\Forge\artifacts\growthos-production-restore-20261012`.
Final evidence: `final-receipt.json`, `result.json`, `cleanup-verified.json`,
`source-before-result.json`, `source-after-result.json`, and all three paired
database snapshots. Full operation report:
`C:\Forge\GROWTHOS_PRODUCTION_RESTORE_REHEARSAL_2026-10-12.md`.

One POST201 created `nlkxjo5wz64oy93v`; one exact DELETE202 removed it. The
legacy API omitted attachment metadata, triggering strict response-shape guards
before restored-copy SQL verification. Preserve the original FAIL receipt;
no actual production PostgreSQL restore acceptance or75-to142 hosted migration
is established. Positive terminal-deleted/active-absence reconciliation passed.
All paid resources created by this grant are deleted and all owned transports
closed. Both source physical75 layouts,150 table fingerprints and184 records,
the third empty app DB, full catalogs/policies/global roles/extensions and both
stopped app configuration/secret metadata snapshots match before/after.

Duration:3m42s including final verification; paid-copy lifetime at most77.638s.
Cost best estimate:USD0.07; final invoice unverified. Grant consumed; no replacement
resource is authorized. Correct/review V1 response handling and secure a fresh
owner grant before another paid restore attempt. Production migration, role-policy,
cutover and client/provider/device/company acceptance gates remain open.
