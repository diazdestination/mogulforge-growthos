# Saved scheduling release boundaries

**Status: source checkpoint only; release eligibility HELD.** This early Task 13 documentation was prepared October 14, 2026 against accepted source through Task 11 and the accepted native Task 12 subset at `a19f34e1a4f2ee6f8f7b230008f29c3875ef2347`, tree `5f235af7899365a0e98eac408a769d1e0d08baad`. It is not the final integration report, migration/recovery packet, final candidate identity or CI receipt. Task 12 runtime browser/new recovery pin/whole gates and Task 13 whole-branch independent review/private source PR/exact-head CI remain pending at this checkpoint.

The source branch checkpoint was privately published under root's recorded authority; canonical main remained `7091af816` at that readback. Publication is source coordination only. Root must refresh account/private repository/base/PR57 stack state before the final PR operation and bind the final packet to actual final source, SQL, artifact and recovery evidence. This docs-only subset performs no push, PR, merge, auth/provider action, paid operation, hosted migration, deployment, customer contact or public launch.

## Schema and original evidence are additive

The reviewed source adds `0019_saved-scheduling-policy.sql` after `0018` with exactly three nullable JSONB fields:

| Existing table | New field |
|---|---|
| `org_settings` | `scheduling_policy` |
| `appointments` | `scheduling_reservation` |
| `projects` | `scheduling_reservation` |

There is no new table, field default or backfill. Preserve all 142 table identities, prior rows/columns/constraints and the 19 canonical predecessor SQL files' exact bytes. The nullable fields have additive validation constraints; NULL legacy rows remain NULL. The canonical Git-blob/executed-byte pins matter independently of checkout newline representations. Do not rewrite an older admitted packet to make it appear current.

Source anchors: `reports/staging-schema-preview-2026-10-01/0019_saved-scheduling-policy.sql:3`, `:31`, `:54`; `reports/staging-schema-preview-2026-10-01/saved-scheduling-predecessor-pins.json`; `scripts/saved-scheduling-schema-preview.mjs`; `scripts/release-schema.mjs`. The later root-owned packet must reverify predecessor/source/SQL hashes and the exact new schema shape, not inherit acceptance from this prose.

## Preserve private snapshots, history and permanent receipts

Rows carry server-owned current reservation snapshots; transitions retain prior/resulting evidence in private scheduling audit history. Pure resource release preserves surviving protection/provenance; terminal closure retains the snapshot/history. Ordinary cleanup, target deletion and supported imports/exports must not erase original operation custody or reinterpret past approval. Manual receipt UUIDs never expire or rearm; deleted/unavailable targets retain the original committed result. Original source-command identities remain separate from unrelated native manual commands.

Authorized exports retain the existing **28 datasets** and add only closed scheduling policy/reservation/history metadata. They exclude operation capability, private original command bodies and unsafe raw evidence; malformed or foreign links are held/withheld truthfully. Existing privacy boundaries and retention protections remain effective. The source limits raw scheduling evidence to `2000` rows (using a `2000+1` overflow check) and the combined export to `10 MiB`; overflow refuses the whole export without partial output/export audit. Permanent original receipts must remain available internally through retention/recovery even though public business-history projections omit their operation capability.

Source/test anchors: `artifacts/api-server/src/services/scheduling-history.ts:1023` (conservative retention); named tests in `scheduling-history.test.ts`: `projects a closed committed receipt with deleted target and no operation capability`, `exports the retained deleted-target business result in organization metadata and keeps exactly 28 datasets`, `enforces 2000+1 raw history rows before malformed-record filtering with no partial export audit`, and `refuses combined organization scheduling metadata plus business data above 10 MiB, without an export audit`. `manual-scheduling-receipt.test.ts` includes `edited then deleted target preserves original committed identity and metadata forever`.

No down-migration, deletion of original snapshots/audits/receipts, or restoring a pre-upgrade database over later admissions is an acceptable rollback. Recovery must preserve post-upgrade records and enforcement.

## Recovery evidence is pinned historical proof

Keep [the existing Task 8 recovery report](saved-scheduling-recovery-2026-10-13.md) unchanged. Its accepted historical production checkpoint is `5f80131a0d4b91be2e55d4eeb3d9145a99bf822c`, tree `effe897dd5531c21b24360522d8a76520a43a466`. Its actual dirty harness scope, hashes and null measured release SHA remain part of the receipt; do not relabel it a later clean build.

At that source-bound checkpoint, the local PGlite actual-app drill passed 91 original Reader checks and 32 tests across three files. It preserved 142 table identities, 19 predecessor pins, three nullable fields and 28 export datasets. Four restored-enforcement cases covered reduced/disabled policy × saved appointment/released project: a positive 201 control, exact terminal travel-conflict refusal at saved end plus 59 minutes, equality acceptance at plus 60 minutes, expected audit-only changes and no other table changes. Owned children, loopback sockets, in-memory databases and exact build directory cleanup were verified. PGlite is embedded PostgreSQL proof, not PostgreSQL 16 contention or Fly hosted backup/upgrade/rollback proof.

The historical command was `pnpm --filter @workspace/scripts exec vitest run contractor-recovery-drill.test.mjs release-schema.test.mjs saved-scheduling-rollback-boundary.test.mjs` (32/32), followed by `pnpm --filter @workspace/scripts exec node contractor-recovery-drill.mjs` (exit 0). Those commands were **not rerun for this documentation**. A fresh final-source recovery pin/packet and runtime browser evidence remain pending.

## Writable rollback remains held

The historical receipt explicitly reports `releaseEligible:false`, with the second compatible artifact unverified. PR57 is a prefeature binary and cannot enforce saved scheduling protection merely because added columns survive. It is unsafe as a writable rollback target.

Writable rollback needs either an independently reviewed, verified compatible artifact that enforces saved snapshots, or a proven complete scheduling-mutation hold plus forward recovery. A complete hold must cover every relevant native/source booking, settings, inspection and timezone writer and remain in place until compatible enforcement returns. No such complete hold is asserted here. A repeated local candidate is not an independent second compatible artifact. If neither path is proven, writable rollback is unavailable. Activating a hosted hold/recovery path still needs its own applicable authorization.

Source: `docs/superpowers/specs/2026-10-13-saved-scheduling-capacity-design.md:151`, `:156`; `scripts/saved-scheduling-rollback-boundary.test.mjs`; the historical recovery receipt's `rollback` section. Full later release selection must retain this hold until actual compatible recovery evidence is reviewed.

## Accepted checkpoint tests do not select a final release

These are retained source-checkpoint observations supplied/accepted by root, not new tests run for this docs-only change and not additive totals:

| Checkpoint | Observed result | Limit |
|---|---|---|
| Native Task 12 subset | 18/18 tests, zero skips, 20 correlated real-PostgreSQL contention proofs; API types exit 0 | Independently accepted native subset, not all Task 12/browser/recovery. |
| Task 11 root linked card | 59/59 across two files (44 owned + 15 summary) | Its early isolated type run had the expected missing peer callsite prop; integrated types later passed. |
| Task 11 peer / shared integration fixtures | Peer 92/92 owned tests and types accepted; shared 27/27 across three files | Accepted scoped source evidence; not physical device/provider proof. |
| Exact clean `a19f34e` combined UI | 131 files, 1422/1422, zero skips, 46.47 seconds | Normal whole UI suite; runtime browser acceptance still pending. |
| Exact clean `a19f34e` whole workspace types | Exit 0 | No final build/Docker/CI acceptance inferred. |
| Exact clean `a19f34e` core / generated client | Core 117 across four files; generated 13 across one file, normal PASS | Focused source gates. |
| Exact clean `a19f34e` normal API codegen | Strict 18 email objects + 20 existing/12 source scheduling boundaries; library types exit 0; zero tracked drift | Generated-contract compatibility, not live delivery. |

Retained coordinator receipts: `task-12-native-subset-report.md`, `task-12-native-subset-fix1-review.md`, `task-11-linked-card-report.md`, `task-11-shared-regression-report.md`, `task11-integrated-a19-proof.json`, `task11-integrated-ui-a19f34e.log`, `task11-integrated-types-a19f34e.log`, `task12-core-a19f34e.log`, `task12-generated-a19f34e.log`, `task12-codegen-a19f34e.log`, and the accepted peer Task 11 receipt. These live in the wave's ignored coordinator evidence workspace; this document does not turn them into final candidate CI or hosted receipts.

The final root-owned source gate still needs full Task 12 browser/recovery/whole-branch checks, fresh whole-branch independent review, exact candidate source/schema/SQL/artifact/recovery packet, current correct private PR stack, and exact-head CI covering tests, types, both production builds and Docker/Fly parity. Any material later fix needs appropriate fresh review and verification. Task 13 remains open until its final source work is complete; live release/cutover gates remain separate afterward.

## Fly Reader correction is a separate source lane

The separate operational Reader-name source correction is PR58 at `c285c478`, with exact CI `38651143815` recorded green. That is source-only proof, not integration into this scheduling candidate or a supported hosted rehearsal. The underscore username generator remains a plausible explanation for the historical 422 rejection; the correction does not establish the original cause or resolve the independent handshake timeout. Do not present the hypothesis as provider acceptance.

Changing those runtime bytes invalidates old native oracle/module/plan/admission proof. Fresh native oracle and current source hashes are needed before further preparation/rehearsal. Earlier paid grants are consumed; a new paid hosted copy/retry needs new explicit approval. Do not reuse historical admission, credential or paid proof, create another copy/helper, or infer paid/provider authority from green PR58 CI. Full supported Fly Reader upgrade/rollback and credential-retirement evidence remain pending.

Coordinator anchors: `task-12-fly-reader-name-preflight.md`, current wave `progress.md` PR58 source/CI receipt; separate operational source files `scripts/production75-live-manifest.mjs` and `scripts/production75-live-runner.mjs` as identified by that preflight. The scheduling docs worker did not execute that lane or make any Fly call.

## Preserve the complete contractor outcome and release authority

The governing acceptance remains `PAID-BETA-READINESS-P0.md`, `LAUNCH-COMPLETION.md`, `HOUSECALL-PRO-REPLACEMENT-GATE.md` and the actual per-company workday cards. Full G-04 still needs approved company scheduling values and the required workday outcomes; current source does not invent helper pools, service categories, company defaults or install/major-repair behavior. Full G-06 remains open for required SMS/text delivery, document/photos and revision/resend workflows. The existing PR57 email-only approval does not close SMS or actual inbox/provider delivery.

Require actual authorized provider/inbox/SMS/phone and physical-device acceptance, company-specific source/migration/reconciliation/cutover and office/field/owner sign-off for **each** contractor's required Housecall Pro replacement. Keep the full promised capability list; do not substitute a reduced assisted pilot or infer migration mappings, business/entity facts, payment setup, provider accounts or company settings. Source-gap references: `reports/claude-launch-acceptance-2026-10-12/source-gap-map.md:71`, `:73`; current estimate boundary: `reports/estimate-email-integration-2026-10-13.md:41`.

Contractor card/bank collection remains a future add-on, not an initial replacement blocker. Truthful invoices, balances and staff-recorded external receipts remain required; GrowthOS's own subscription billing is separate. Financial actions, real customer contact, paid resources, provider/hosted activation, deployment, destructive production changes and public launch retain their applicable explicit approval boundaries.

Green CI, local backup/restore and private source publication do not establish market replacement, production safety or deployment permission. Root owns final repository/identity/base confirmation, integration, packet, independent review and source PR/CI evidence. This early documentation does not close those gates or authorize any external mutation.
