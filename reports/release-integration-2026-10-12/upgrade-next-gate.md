# Production75 upgrade: next gate (offline design only)

Prepared 2026-10-12 from the accepted source and nonsecret restore evidence. This
note authorizes nothing. Root owns integration, provider
operations, credentials, admission and release. The five-PR integration contract
adds no schema migration; freeze its final commit/CI and recheck all19 SQL hashes
before preparing this separate rehearsal packet.

## Evidence and limits

- Retry `71fed7d3` is RESTORE PASS for V1 source `kzpwm0j18eg04nv3`: three databases,
  150 original table fingerprints,184 records; source/copy/source match. Copy
  `q49ypo494e2017ln` is terminal deleted and absent. The one-copy grant is consumed.
  Recorded459.529 seconds/~USD0.07 is historical estimation; billing is unverified.
- The bound application database is `fly-db`:75 tables/849 columns/65 records,
  physical hash `2ca3d8dbc10313fb7f23bab2e87f61ad13a21e925664e190c087683aad1daf55`.
  Preserve the separate `growthos_staging`75/119 and `mogulforge-growthos-db`0/0.
- Existing `fly-user` and `growthos-staging-live` both inherit `schema_admin`,
  `pg_read_all_data`, `pg_write_all_data` and `pg_signal_backend`; both have full
  application-table privileges. Neither is an independent read-only Reader.
  NOLOGIN `reader` inherits `pg_read_all_data`; its existing CONNECT grants cover
  all three databases. No separate Reader login is evidenced.
- Recorded extensions: `pgaudit`16.1, `pg_stat_monitor`2.3 (public, postgres-owned),
  `plpgsql`1.0. Preserve their20 extension-object definition/ACL records, global
  role flags/memberships, role-setting digests, database/schema ownership and ACLs,
  existing PUBLIC/function capabilities and all10 default-grant entries.

Sources: [restore receipt](C:/Forge/artifacts/growthos-production-restore-retry-20261012/final-receipt.json),
[accepted review](C:/Forge/artifacts/growthos-production-restore-retry-20261012/independent-final-acceptance.json),
[fly-db metadata](C:/Forge/artifacts/growthos-production-restore-retry-20261012/source-before-fly-db.json),
[integration contract](C:/Forge/worktrees/growthos-db-recovery-20261010/reports/release-integration-contract-2026-10-12.md).
These recorded snapshots must be refreshed at a later admitted execution.

## Concrete compatibility blockers

The earlier accepted pure core filtered retained ownership to application names,
dropping actual `pg_stat_monitor` and65 view-column owner/ACL records before
comparison:66 unchanged rows would cause refusal. Root's frozen integration
contract now includes the bounded fix: preserve every full baseline object key,
excluding only exact known SQL-added table/column identities, and reject missing,
changed or unexpected objects. Focused RED/GREEN and native proof are recorded
separately in `production75-retention-fix.json`; source/pins remain unchanged.
Synthetic provider-style view metadata is mechanism evidence, not proof of actual
extension binaries. The future operator must still bind the restore observer's
`extra` extension/global-role/settings/database vectors, which the migration
result currently does not carry.

An admin login with a READ ONLY transaction is insufficient. Reader login AND
effective role must differ from Writer, use a different backend, and match a
reviewed privilege vector with no admin/Writer membership or DML/DDL authority.
Copy-only provisioning through a verified supported provider procedure is an
option, not an established capability or approved mutation. Reusing NOLOGIN
`reader` would preserve table/default ACLs but grants cluster-wide copy read/CONNECT
access; that explicit scope needs review. If a narrower reader needs new ACLs,
record the exact copy-only delta and do not relabel it as unchanged restore policy;
that would require a different reviewed contract from the unchanged-ACL gate.
Do not add blanket default grants to make new-table reads pass. If a suitable
distinct Reader cannot be provisioned under the packet, the gate remains closed.

## Reusable boundaries and proposed ownership

All paths below are future work, not implemented or admitted by this note.
Repository paths are under `C:\Forge\worktrees\growthos-db-recovery-20261010`.

| Owner | Exact future files/responsibility |
| --- | --- |
| Mechanism lane, after a new root assignment | `scripts/production75-core.mjs` and `.test.mjs`: baseline-object retention and explicit extra-metadata preservation; keep source/pins and both staging95 helpers untouched. |
| Pure contract/QA lane | New `scripts/production75-hosted-contract.mjs` and `.test.mjs`: validate source hashes, explicit target/Reader, full expected75/95/142 vectors, named copy-only Reader delta, deadlines, terminal attempt state and redacted receipt shapes; no I/O or credentials. |
| Observer lane | New `scripts/production75-hosted-observer.mjs` and `.test.mjs`: supplied-client SELECT-only capture of all three DBs, original projections and provider extras, with a fixed query surface and bounds. Never read monitoring-view contents, raw customer rows or credentials. |
| Native QA lane | New `scripts/production75-managed-local.mjs` and `.test.mjs`: uniquely owned disposable PG16, actual legacy role/default-ACL model and provider-shaped view/function ownership; synthetic data only. Exact extension binaries, if unavailable locally, remain a hosted proof requirement. |
| Root/operator lane | Fresh `C:\Forge\artifacts\growthos-production75-upgrade-<packet-id>\{common,prepare,observe,execute}.mjs`, manifest/plan, review, admission, reservation, journals and receipts. Root alone owns provider/auth/proxy/Reader provisioning, one restore POST and exact-owned DELETE. |
| Independent reviewer | Additive review receipt against all exact hashes, permission expectations, native results and eventual packet; no execution ownership. |

Factor/review the accepted retry's bounded HTTP, redacted summaries, exclusive
fsync reservations, V1 response handling, uncertain-create reconciliation and
terminal-delete proof into the new operator. Do not import its hardcoded DIR,
restore-only authority or PR35 branch checks as a new admission. Preserve that
historical operator and the generic old staging95 operator; NEVER retarget either.

## Proposed one-copy execution contract

1. Complete integration acceptance first. Prepare a new hash-pinned, expiring
   packet for exactly one paid V1 copy, named backup, source/SQL target, account/org,
   capacity, bounded work plus cleanup reserve, two specified migration transactions
   (one full rollback rehearsal, one commit), and explicit copy-only Reader setup.
   Include fresh recovery/binding, expected permission vectors, cost/duration and
   exclusions. Obtain its independent review and concrete owner admission later;
   the consumed restore grants do not admit this packet.
2. Before POST, refresh all three original snapshots and protected original/stopped
   Machine/secret metadata. Reserve creation durably before dispatch. Unknown POST
   gets bounded read reconciliation, never a second POST. V1 acknowledgment or
   tombstone attachment omission cannot replace authoritative live inventory proof
   that the unique copy is unattached, absent before, and not either original.
3. Prove raw restored fidelity first. Provision only the separately reviewed copy
   Reader delta; capture its post-setup baseline independently. Preserve existing
   principals, original/default ACLs and extension vectors exactly. Derive95/142
   permissions by an independently checked native source-lineage oracle using the
   actual role model, not the fictional local-policy files or Writer's own result.
4. Run exact selected0000 + unchanged0001–0018, with the uncommitted95 checkpoint.
   No whole0000, enums, seed, backfill, grants or credentials inside core migration.
   After rollback, fresh Reader must prove exact75/849/65 original projections,
   all non-target DB fingerprints and the reviewed policy/extra vectors. Commit
   uses a fresh client/plan and separately reserved terminal transaction on the
   same copy; no app starts. Full142 proof requires67 empty new tables,13 original
   defaults, retained ordinals and only the two original lead_id relaxations.
5. After acknowledged COMMIT, a distinct Reader must repeat complete acceptance.
   Unknown COMMIT is terminal/non-replayable: read reconciliation may establish
   exact142; observed75 or another state is a hold, not permission to retry. Never
   issue compensating ROLLBACK after COMMIT dispatch or turn a missing journal
   acknowledgment into success. Durable custody must survive process restart.
6. Close every owned SQL socket/proxy/agent, perform one reserved exact-owned
   DELETE, and prove terminal status plus active-list absence and both originals
   present. Re-read originals and protected metadata. Unknown DELETE gets reads,
   never replay. Cleanup-only mode uses the durable ownership record and its own
   deadline; no broad process/resource deletion. Output only approved codes,
   counts/hashes/identities; no raw CLI status, API credential bodies, stderr,
   connection URLs or password-bearing arguments/files. PASS requires cleanup.

## Required native and fault tests before a paid packet

- Reproduce the66 provider-ownership rows: unchanged extras pass; changed/removed/
  substituted view/function owner, ACL, definition or extension version fails.
  Test complete global-role/settings/default/PUBLIC vectors, not filtered equality.
- Actual admin memberships/default ACLs plus distinct Reader: prove original
  admin vectors unchanged, Reader can fingerprint old/new tables, and Reader
  cannot INSERT/UPDATE/DELETE/TRUNCATE, create objects or SET an admin/Writer role.
  Reject Writer-as-Reader even at another PID with READ ONLY enabled.
- Real PG16 two-tenant JSON/NULL/history preservation, full physical142/67/13
  checks, late bridge/0018 failures and rollback, both normal terminal transactions,
  fresh Reader, same-count data/schema/permission drift and ordinal/collision negatives.
- Durable intent refusal, lost BEGIN/step/COMMIT acknowledgment, fresh142/75
  reconciliation, timeout/transport loss, journal failure and restart/stale-plan
  refusal; zero mutation replay. Local fault tests never mutate real restored rows.
- V1 missing attachment field in acknowledgment/tombstone versus mandatory live
  inventory proof; source/staging/name collision, uncertain creation, lost DELETE,
  exact ownership cleanup, occupied/unowned proxy and log/output redaction failures.

## Separate rotation/runtime boundary

Rotation remains approved and unperformed; no new rotation approval is implied
necessary. Recorded Fly0.4.115 rejects V1 native rotation. A verified supported V1
procedure, or separately scoped provider V1-to-V2 migration and legacy-login
revocation, remains required; raw SQL rotation is not admitted. Schema75→142 does
not change provider generation or revoke the leaked login. Production migration,
private controlled app start/health, secret installation/recovery custody, actual
client/provider/payment/device acceptance and public cutover remain separate.
See [recorded rotation plan](C:/Forge/artifacts/growthos-production-restore-retry-20261012/rotation-plan.json).

The initial note was offline. Root later explicitly assigned the bounded metadata
retention fix and disposable local PG16 proof. No hosted operator, provider call,
credential access, original mutation, commit/push or owner admission was performed.
