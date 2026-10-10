# Integrated GrowthOS held-staging release procedure

Status: preparation and review only. Local native rehearsal and final independent
review are recorded separately. This document is not a hosted execution grant or
an executable deployment script. Every prerequisite below must be positively
verified before a hosted write, image publication or Machine update.

## Source and destination

The tested application is `bdcd5f2d56f5c0c08284dda8dd9d3d27cad60848`, tree
`b5993f27b0c231a87be48fc223138421ca5e98b8`, in repository
https://github.com/diazdestination/mogulforge-growthos.git. The local branch is
`codex/integrated-specialists-alerts-20261009`. The observed evidence-only candidate
head was `d7e38305e4a51a125be2c6dbc378dc310e247aae`; later release-preparation
records must not change application inputs. `source-manifest.json` binds all
19 SQL files and 69 pure schema files to actual Git bytes and canonical-LF hashes.

The completed local application validation has 4,260 passing tests and 15 existing
skips, plus type checks, builds, browser checks and Node22 Linux Docker parity.
The original 141 schema definitions are unchanged by the coverage addition. This
evidence is independent of hosted schema/backup/role acceptance. Do not rerun the
completed suites solely to obtain another receipt when their inputs have not changed.

The tested local Docker image digest is
`sha256:ad35da18b877d2b9cbcf2d272d74bc89c20f383f84a49717b2b752c017bd076b`.
Local image inspection also reports that digest under the local parity repository.
It has not been published to Fly. A future registry image must have its actual
immutable Fly registry digest and source identity captured after publication;
do not invent a Fly image URL from a local digest or a mutable tag.

| Resource | Exact proposed scope |
| --- | --- |
| Existing staging app | `mogulforge-growthos-staging` |
| Existing staging Machine | `8d96936a03d058`, iad, shared1CPU/1024MB |
| Existing staging MPG | `zp2wjrejd2zodn4q` |
| Database/runtime login | `growthos_staging` / `growthos-staging-live` |
| Production app/MPG | Excluded: `mogulforge-growthos` / `kzpwm0j18eg04nv3` |
| Public marketing website | Separate checkout and release; excluded from staging API rollout |
| New managed recovery copy | None admitted; new bounded authority and reviewed operator required |

The October9 13:43UTC Machine observation shows staging STOPPED, autostartfalse,
autostoptrue, minrunning0, and the prior image
`registry.fly.io/mogulforge-growthos-staging@sha256:bcde7c17a03643b711262ad9aeb073bec840a1f9f9654c8e6325cc8a5e78d0a3`.
Outbound holdtrue; staging outbound approvalfalse; schedulerfalse; AUTO_MIGRATEfalse;
schema-push approvalfalse; web-pushfalse; staging email allowlist explicitly empty.
None of those flag names appears in the captured secret-name list. Secret values
and the effective application database connection were not inspected here.

The fresh organization-scoped MPG inventory has the two original clusters ready.
The staging cluster's attachment array is empty; production's array names both
apps. These are provider metadata labels, not proof of the application connection.
Verify the effective staging URL privately and return match booleans only: exact
host `pgbouncer.zp2wjrejd2zodn4q.flympg.net`, database `growthos_staging`, login
`growthos-staging-live`. Then verify actual SQL session/database/PG16 identity.
Any mismatch or unavailable result is a stop, never permission to modify production
or recreate bindings. The current source performs this identity check before startup
seeding. It does not replace the independent preflight.

Provider-reported disk0/replicas0/version-unrecognized fields do not establish
actual capacity or price. The initial unscoped MPG list failure does not establish
resource absence. See the original receipts and independent metadata review.

## 1. Freeze a new target-bound preflight

Use a new separately reviewed read-only observer for this exact current source and
target. Do not import, retarget, rekey or replay any consumed restore/Reader/Writer/
cleanup operator. Pin source/tool/runtime hashes before opening a connection; no
application DB import, dotenv, generic Drizzle push or startup process is permitted
in the observer. Keep credentials in memory and return only safe identity/count/
metadata/fingerprint evidence. A permission or connection failure remains unknown.

Capture a consistent READ ONLY transaction: cluster/database/session principal,
effective role, PGversion, TLS/session/PID; full logical and physical catalog;
original-data fingerprints and row counts; role membership/owner/default/table/
column/PUBLIC privilege matrices; protected effect/history cohorts and defaults.
Do not read customer payloads into a report. Verify reader-only privileges and
writer least privilege independently. Pin the new snapshot and clock freshness,
rather than forcing current rows to equal an October6 or October8 fixture.

Historical staging evidence has95 tables with catalog digest
`a717ae6d79fe57095a4354b55bf1098b17085c00bd82b17a6076765434113516`.
No hosted SQL was run for this preparation; this is not a refreshed catalog.
Select the lineage only after the entire current catalog is proven:

| Exact fresh baseline | Reviewed SQL selection |
| --- | --- |
| Accepted95, full metadata matches | `0003` through `0018`, numeric order, 16 files |
| Accepted141, exact prior definitions match | Only `0018` |
| Intermediate, drifted, unavailable or count-only | Stop and prepare a distinct plan |

Never apply initial provisioning0000–0002 to an existing95 database. All fifteen
0003–0017 canonical-LF Git hashes still match the dated accepted lineage. The new
0018 Git bytes are2335 bytes, SHA256
`b5c6425dc7942460e4d734e14f971e8fc062b1bdfe292d69d22a88e34be587a1`.
Execution bytes must be frozen and separately hashed: the working checkout uses
CRLF for some older files, while the Git object/canonical-LF manifest uses LF.
Do not silently normalize or repin after review.

## 2. Admit current backup and recovery evidence

The October9 13:51UTC provider inventory lists completed FULL
`20261009-000216F`, start00:02:16UTC, stop00:02:25UTC, and later incremental/differential
backups. That proves metadata availability only. Select and pin a current recovery
point immediately before the authorized work, together with the frozen current
source/database snapshot, explicit retention/window and recoverability evidence.

The previous one-copy grant is consumed. Its managed95 restore/preservation passed
and copy `82ylg01xp5lrzx19` was positively deleted. Its141 writer outcome is UNCONFIRMED
before migration/COMMIT prerequisites; it cannot prove the integrated142 upgrade.
Deletion completion is not proof of the final bill or billing stop. The consumed
reasonable-short-rehearsal authority/24h maximum and the previous support-send
approval do not authorize another resource. The owner removed the earlier hardUSD5
cap before that sole restore; it must not be reinstated as a historical condition.

A new managed-copy rehearsal needs an explicit current cost/resource/deletion
scope, independently reviewed fixed operator, positively owned copy, secure role
profile and complete backup95→142 upgrade/recovery evidence. Prove actual restoration
of original data/ACLs and relevant encrypted-object dependencies, then the exact
selected migration and independent142 capture. Record sizing and billing limits;
do not infer them from Basic labels, old cents or zero-valued inventory fields.
Any new copy must be detached from customer routing/providers and have a bounded
work deadline, cleanup reserve and positive deletion reconciliation.

The new local PostgreSQL16 rehearsal can substantiate exact SQL lineage, synthetic
data preservation, native catalog comparison and transactional rollback. It cannot
substitute for this current managed-backup/actual-role recovery proof.

## 3. Apply the approved migration once

Only after fresh source/target/recovery/operator review and owner authority: drain
all writers and preserve staging holds. Reconfirm the exact snapshot before DDL;
lock the original application tables in reviewed order within one bounded transaction
and an agreed downtime window. Use the exact approved command vector, qualified
search path, finite lock/statement/work timeouts and effective schema-owner role.
No role/password rotation from the consumed October6 work is included.

Before COMMIT, compare every retained original row/fingerprint/physical ordinal,
full142 catalog, indexes/FKs/CHECKs/enums/RLS/policies, exact default vectors and
permissions. For95→142, all47 newly introduced tables must be empty; for141→142,
coverage must be empty. Never backfill historical alerts or rearm unknown effects.
Only six previously reviewed NOTNULL relaxations and the exact0015 CALLIE CHECK
replacement are admitted. Original95 data can have grown since older evidence;
preserve the current frozen baseline, not a historical65-row count.

0018 creates `staff_lead_alert_coverage` and two validated tenant-aware FKs, with
no historical DML/backfill/grant. It requires the valid composite leads key.
Its SQL bounds version/status/fingerprint/JSON envelope/cohort size; application
validation separately checks recipient object details. It grants no permissions.
Verify actual owner/default ACL inheritance and the complete142 Reader/Writer matrix
(284 table privilege entries), column/PUBLIC permissions and role closure. If an
explicit grant is needed, stop for review of that exact least-privilege addition.

Record acknowledgements for BEGIN, each reviewed step, precommit proof, COMMIT or
ROLLBACK, connection disposal and phase-specific safe errors. A lost/unknown COMMIT
must be reconciled by a new independent READ ONLY observation; never retry DDL.
Then use a different fresh Reader session to verify the complete committed142
catalog/data/ACL/default/empty-table result. No image start until this is accepted.

## 4. Publish and update the existing Machine

Remote source push/PR integration/CI and registry publication are separate externally
visible actions. Pin the final selected application source, clean archive, source
identity and actual registry digest. Keep PR28 before dependentPR29; do not discard
the combined theme/coverage UI by blindly merging their older individual heads.
Exact-head CI for the combined remote candidate remains to be obtained after an
authorized push. A marketing website release uses its separate approved repository,
hosting target, validation and publication scope.

The generic `release-schema.mjs` deliberately refuses; AUTO_MIGRATEtrue/1/yes also
refuses startup. Do not replace either with forced schema push, revive old behavior
or deploy against the wrong schema. The checked-in Fly TOMLs have minrunning1 and
autostarttrue; applying them unchanged would alter the current held topology.

Proposed distinct image-update path after migration acceptance: update only Machine
`8d96936a03d058`, using the admitted immutable Fly registry image, preserve existing
full Machine config/secrets/VM/ports/network/restart/cordon state, explicitly maintain
autostartfalse/autostopstop and use `--skip-start`. No `fly deploy` invocation,
release-command helper Machine, spare VM, new IP, builder, database, role or production
resource is part of this path. This is a reviewed proposal; no command was run.

The inert proposal in `proposed-machine-update.json` has an unresolved image slot
and `authorized:false`. Prefer a newly reviewed target-bound Machines API operator:
read and copy the entire current config in memory, modify only the admitted image/
hold fields, compare the exact proposed delta BEFORE the POST, bind `current_version`
to the fresh instance ID and a current Machine lease, and set `skip_launch:true`.
Do not persist credentials or arbitrary environment fields. Refuse unrelated config
changes and unknown update outcomes; reconcile by read before any further action.
The [official Machines API documentation](https://fly.io/docs/machines/api/machines-resource/)
requires a full config for updates and describes `skip_launch` for a stopped Machine.
Re-read state/config afterward before any separately admitted start.

The CLI vector is a reference alternative, never a dispatcher. Its current CLI
semantics and complete request delta require independent review before selection;
use a neutral working directory without any Fly TOML and refuse automatic config
discovery. Installed help and [official Machine update documentation](https://fly.io/docs/flyctl/machine-update/)
describe `--skip-start` as updating without starting. This alone does not prove that
unrelated configuration will be preserved, so the CLI vector is not execution-ready.

A bounded held staging start is an additional admitted step. The normal app performs
startup data seeding (platform admin grants/default automations/service areas/
installation keys) after its identity fence. Schedulerfalse and outboundholdtrue
do not suppress all startup DML. Review and authorize those exact effects or use
a separately reviewed inspection path; never label a normal startup read-only.
Keep inbound voice bindings/forwarding disabled: an outbound hold alone does not
prevent staff Dial from an enabled inbound voice path.

Check immutable build identity, health/readiness, schema identity, holds and a signed-in
synthetic owner/admin coverage journey. Test missing/zero-device/history/error states
without external phone/email/provider calls. Record actual origin/device results;
local component preview and provider acceptance are not human reading or contractor
workday acceptance. At the end, restore the agreed stopped/manual-start state unless
the owner specifically admits ongoing runtime.

## 5. Recovery and completion

Before migration COMMIT, a positively acknowledged transaction rollback and independent
95 preservation check are the failure path. After COMMIT, a schema/image compatibility
decision is required. An old image is not automatically safe once new work/billing/
lineage data exists. No destructive down migration, replay, uncertain-send reset,
data-loss restore or cutover is authorized by this procedure.

On any failed acceptance, keep writers/providers held and the application stopped;
preserve receipts and reconcile actual state. Use only the specifically admitted
recovery procedure. If recovery would overwrite original data, obtain explicit
scope for that decision. Positively close every owned session/tunnel and remove only
the newly admitted disposable resources, with provider completion and billing evidence
reported separately. Never replay completed resource deletions.

Completion requires independent accepted source/SQL/operator/recovery reviews, actual
fresh hosted142 evidence, exact combined CI and immutable registry identity, held
Machine acceptance and bounded owned cleanup. This preparation does not close those
hosted gates or authorize production/provider/customer activation.
