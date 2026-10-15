# GrowthOS combined release and scheduling upgrade design

Status: PROPOSED for independent and owner review. No implementation GO, source merge, hosted action or spending is claimed by this document.

## Outcome and scope

Adam wants GrowthOS to reach market with the contractor capabilities already agreed, including dependable scheduling, estimates, invoices, customer history and recovery. This wave joins the accepted scheduling source and database rehearsal tooling into one verifiable release candidate. It preserves the complete client requirements and every accepted product feature. It does not substitute a reduced pilot or infer real provider/client acceptance from CI.

The user renewed continuation and two-machine coordination. WillowForge owns source integration and release bindings; GEEKOM independently reviews product recovery and compatibility. A scoped local explorer reviews operational admission coupling. No agent may independently change shared source or start hosted work.

This document covers source engineering and local verification. Existing grants for temporary Fly copies/helpers are consumed. A concrete hosted packet, current pricing, private credential handling, preservation checks and fresh applicable approval are required before another paid attempt. Production, provider activation, customer contact, public launch and contractor cutover remain outside this wave.

## Verified starting identities

Canonical private repository: `diazdestination/mogulforge-growthos`. Windows GitHub CLI identity: `diazdestination`, account ID `302037174`.

| Source | Exact head | Current proof |
| --- | --- | --- |
| Product PR #59 | `91b7fd2c1fd98d441848e0357954e35c9f65d688` | CI `38688455560` succeeded; saved-scheduling source tasks 1–13 accepted |
| Operations PR #58 | `c285c4781145fead9fa2baa39360412f2846f66d` | CI `38651143815` succeeded; dashed Reader naming remains a hosted hypothesis |
| Common ancestor | `8df64dc72009832f93b2b491031acd1bb2afb903` | PR #44 |
| Canonical main | `7091af816715cfd437925eb0af82fb47d3411e34` | Unchanged at fresh fetch |

Both local source worktrees are clean. The two arms have 90/21 commits and 542/102 changed paths respectively. Their union is 642 paths; only `NEXT_ACTIONS.md` and `PROJECT_STATE.md` conflict in the actual `git merge-tree` probe. That probe is an unresolved object, not an accepted candidate or branch merge. Evidence: `C:\Forge\artifacts\growthos-release-integration-20261015\source-preflight.json`.

All original 19 SQL pins through `0018` remain byte-for-byte unchanged in the product head. The separate scheduling input is:

- Path: `reports/staging-schema-preview-2026-10-01/0019_saved-scheduling-policy.sql`.
- SHA-256: `76e88d3410235f1b6a8a20e595b126455fd5711b46f87055b586786b28f81ca9`; 8,126 bytes.
- Adds three nullable JSONB columns and three CHECK constraints: `appointments.scheduling_reservation`, `org_settings.scheduling_policy`, `projects.scheduling_reservation`.
- No table, default or backfill. The table count remains 142. Schema identity must distinguish pre-scheduling and post-scheduling 142-table catalogs.

## Options and selected recommendation

1. **Preserve the original upgrade contract; add a separately admitted scheduling stage. Recommended.** This retains the original 75→95→142/0018 evidence and makes the new schema/data/policy proof explicit. It requires additional bounded code and new native evidence.
2. Replace the old 19-step contract/catalog with the scheduling schema. This would blur the historical proof and can miss changes in newer tables. Rejected.
3. Combine source but leave the rehearsal stopping at 0018. This is useful only as an intermediate checkpoint and cannot satisfy release acceptance. Rejected as this wave's completion condition.

## Source convergence

After design and implementation-plan approval, use a new isolated integration worktree based on the exact product head. Integrate the exact operations head without modifying either original branch. Resolve the two status documents substantively: retain both historical blocks and add one current, superseding combined-source status. Preserve the operations `RUNBOOK.md` additions. Do not merge draft PRs into main as a shortcut.

Preserve product runtime/generated API contracts, scheduling history, idempotency, original command outcomes, tenant/actor boundaries and the closed 28-dataset export shape. Preserve Reader diagnostics, bounded provider requests, connection deadlines, one-attempt custody, originals protection and cleanup reserves from operations. Do not regenerate unrelated product output, update dependencies, repair deferred M2 diagnostics, or add customer-facing features.

The combined candidate must retain the reviewed product recovery API/library identity and protected eight-file harness identity wherever its bytes are unchanged. GEEKOM's independent read-only comparison found all 2,115 API/library paths, including tests, equal to accepted product checkpoint `f56e6cef452b5b564838a72202c0d37cd2caf384`. The protected product versions are `scripts/{saved-scheduling-recovery-fixture,contractor-recovery-drill,contractor-recovery-app-probe,release-schema}.mjs`, `artifacts/api-server/{build,build-identity}.mjs`, `artifacts/api-server/scripts/contractor-recovery-entry.ts` and `pnpm-lock.yaml`. Some are absent or older in operations; preserve the product versions when joining source. This inventory is not the full executable dependency set. A new combined source/artifact binding must explicitly state what matches and what is newly verified; historical passing receipts must not be relabeled as new executions.

## Two explicit schema stages

### Stage A: admitted legacy upgrade

Retain `production75-pins.mjs`, its original 19-file source contract, selected SQL statements, 75/95/142 catalogs, phase semantics, privilege expectations, original defaults, and original rollback evidence. The existing source identity remains historical and valid only for its defined stage.

The 142-table result of Stage A is **pre-scheduling**, not the final combined schema. A receipt or operator command ending here must say so and cannot claim release-ready scheduling acceptance.

### Stage B: scheduling 0019

Add a separate, named `scheduling0019` stage with an exact input digest, pre/post catalog identities, full data baseline and expected privilege/ownership state. Prefer a new import-safe delta mechanism and fixed-query observer over enlarging the old core's definition of success.

The input is an admitted pre-scheduling 142-table/1,867-column database, including fixtures with populated tables added after the original 75. Stage B must capture all 142 tables and their complete original columns, not reuse the legacy 75-table/849-column data projection. Every original value and row count must survive; the three newly introduced column values must initially be NULL, producing 1,870 columns. Source files, catalog, constraints, indexes, enums, triggers, policies, ownership, role relationships, grants and default privileges must match the explicit expected pre/post states. No new grants, reader privilege escalation, defaults, backfill or table additions are permitted.

Require exact original-byte SQL and fail closed on changed bytes, missing/extra columns, wrong CHECK definitions, unexpected source/schema, dirty or mismatched runtime binding, wrong target/principal, unreadable tables or incomplete fingerprints. Fixed query registration and result bounds must cover the complete stage; no caller-supplied SQL or arbitrary paths become authority.

Transactional rollback before commit must restore the full Stage B preimage. Commit and lost-acknowledgment cases need distinct receipts and exact-state observation; uncertainty never permits automatic replay. A schema down-migration or dropping saved scheduling data is not an accepted rollback method.

## Orchestration and admission

The proposed minimal boundary is new `production75-scheduling0019.mjs` and `production75-scheduling0019-observer.mjs` modules plus stage-aware changes in `production75-{operator,custody,live-policy,live-local,live-runner,live-manifest}.mjs`. Keep the original pins/source/core/observer/verification behavior intact; reuse existing non-target/provider capability checks. Exact file ownership and commands belong in the subsequent reviewed implementation plan.

Stage A must complete its verified rollback and commit before Stage B's baseline is bound from a fresh Reader observation. Stage B has separate, one-use rollback and commit reservations and its own exact SQL allowlist. A Stage A permit cannot authorize Stage B. Unknown acknowledgment or baseline drift holds the attempt for exact-state reconciliation or cleanup; it never authorizes a duplicate SQL dispatch or a replacement paid resource.

Keep old-stage admission unambiguous. A new combined packet must bind the exact clean candidate/tree, executable dependency manifest, immutable legacy SQL set, 0019 digest, stage-specific catalogs/policies, complete Stage B fingerprints, profile, backup/source target and original-protection state. Version or discriminate it so a legacy packet cannot authorize or falsely certify scheduling, and an old oracle cannot be accepted by changing only its candidate label.

Generate a fresh owned native PostgreSQL oracle and capability proof for the combined runtime and new stage, independently executing the DDL for both retained physical layouts. Preserve the original canonical and derived catalog digests. Product changes to `scripts/local-dev.mjs`, `pnpm-lock.yaml` and `artifacts/api-server/package.json`, plus Reader changes in manifest-covered modules, invalidate reuse of old executable-manifest proof. A fresh hash file alone is insufficient: current native behavior, oracle provenance and stage admission must pass together.

Resolve an existing proof mismatch explicitly: the local rehearsal currently hashes only executable module hashes, while the native runner's aggregate also contains source files, catalogs and oracle. Both paths must use one shared aggregate manifest builder, covered by parity tests, including the distinct 0019 source descriptor and pre/post stage catalogs/oracle. Keep normalized runtime text hashes distinct from exact-byte SQL hashes. The combined oracle validator must require explicit Stage B rollback, commit, fresh-Reader reconciliation and full-142 preservation coverage; a generic legacy `verified-and-cleaned` result is insufficient. Preserve or deliberately revise and verify the exact owned-resource inventory rather than accepting a new container count implicitly.

The native/local path may use only new uniquely named owned resources, synthetic data, loopback interfaces and bounded lifetimes. Preserve original failures. Clean only the exact resources created by that run, verify absence, and record any blocked cleanup without retrying policy-rejected deletions. No new hosted entrypoint may execute the combined stage until its exact source/capability/backup/target/allowance packet is independently reviewed and appropriately authorized.

## Required evidence

| Boundary | Acceptance |
| --- | --- |
| Source integration | Exact heads/common ancestor; only reviewed conflicts resolved; original branches and main preserved; original 19 SQL byte hashes unchanged |
| Delta input | Exact 0019 bytes accepted; changed/missing/reordered/unregistered inputs rejected before dispatch |
| Complete preservation | All 142 tables captured, including nonempty post-75 tables; original columns/rows unchanged; only three initially NULL columns and three reviewed CHECKs added |
| Policy and Reader | Pre/post ownership, effective privileges, role memberships and default privileges matched; positive reads and actual denied writes; no fabricated least-privilege guarantee |
| State transitions | Explicit pre0019/post0019 schemas despite identical table counts; successful commit; transactional rollback; late failure; lost commit/rollback acknowledgment; source/target drift refusals; no duplicate retry |
| Custody | Stage-specific durable reservation and terminal state; target binding; cleanup deadline/reserve and old protected resources retained; unknown effects remain held |
| Product recovery | Closed 28 datasets and saved-history semantics; unchanged protected API/library/harness proof mapped exactly; fresh combined artifact binding and any invalidated enforcement evidence verified |
| Native oracle | Fresh owned PostgreSQL result for current executable hashes and schema stages; old or relabeled proof rejected; exact owned cleanup result recorded |
| Release candidate | Meaningful focused tests, current full suite, normal types, both builds, Docker parity, independent spec/quality review and exact private candidate CI |

The 28 datasets are 27 fixed allowlisted table datasets plus computed `estimate_email_receipts`; scheduling policy/history remain closed fields in `organization`, not a 29th dataset. Preserve distinct data/policy/history digests and capability redaction. The bounded export snapshot is read-only, but the export API records an audit after actor revalidation and needs its ordinary writable clone. Never widen restore Reader privileges to make that audit succeed. Restore-mode conflict-explanation POST remains HTTP405 and is separate from successful-read counts. Preserve all four reduced/disabled policy × appointment/project enforcement cases and the original manual/returning/service-care/CALLIE outcome and authority checks.

No passing count is promised in advance. Keep the existing 15 baseline skips explicit; do not loosen validation, increase unrelated timeouts, skip checks or change fixtures merely to mirror implementation. Reuse unaffected accepted behavior evidence and rerun evidence invalidated by this integration.

## Production and client completion remain separate

A successful local combined candidate does not prove the Fly Reader problem fixed. Before a hosted rehearsal, prepare the exact current source, independently verified backup, private credentials, protected-original inventories, current price/budget, bounded lifetime and cleanup, and required approval. Then prove the actual restore/upgrade/rollback/permissions and original preservation on the authorized temporary copy.

Writable production reversal remains held until either a separately reviewed compatible artifact is proved or a complete scheduling mutation hold with forward recovery is implemented and verified. The old prefeature artifact is not a writable-compatible rollback target. Do not infer this gate from read-only Reader checks or successful workstation recovery.

Full G-04/G-06 and both contractor replacement cards stay required: actual business time zones/hours, duration/travel/capacity/crews, source imports/reconciliation, staff workflow, connected mailbox/SMS/phone/provider/device evidence and explicit cutover. Initial email does not finish documents, revisions, resend or follow-up. Do not silently change the deferred contractor card/bank collection decision or GrowthOS subscription billing scope.

Today's workstation backup independently passed provider-download restore for 45,634 files, 59 source roots, 16 repositories and SQLite. This resolves the previously missing capture of the scheduling wave, not application-secret custody or production recovery. Google Drive capacity and password-manager custody remain unconfirmed; owner-reported phone photo custody and retained private drill limits remain explicit. Backup evidence: `C:\Forge\backups\workstation\receipts\google-drive-d32555fc-6e00-446a-8600-5439c2660b11.json`.

## Review state

Read-only source preflight, operational coupling analysis and GEEKOM product recovery requirements review are complete against the exact source identities above. Neither accepts a combined runtime candidate. GEEKOM's source review, C01–C20 acceptance matrix and exact protected-source inventory are retained in the release-integration artifact directory. Operational review identified the full-142 baseline requirement, legacy-only phase/custody constraints and the local/native aggregate-manifest mismatch; this revision incorporates each. The two status-document resolution proposals preserve both arms' historical blocks without editing either source worktree. Fresh independent design-quality review found no blocking or Important findings at SHA256073c19ec4f152e531eb1d34debb2b417bc789e50baccb83d063876e48a422438. The reviewed snapshot and review receipt are retained in the artifact directory. This sentence is a review-status update only; owner review is the next gate.

No product or operations source file has changed, no dependency was installed and no new test, container, hosted resource, provider action or paid attempt has run during design preparation.

After the written design is reviewed and approved, prepare a detailed implementation plan with explicit file ownership, dependency order, test commands, independent reviews and final integration/publication conditions. That plan and its execution method require their own review before implementation.
