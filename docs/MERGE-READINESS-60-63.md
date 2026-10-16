# Merge readiness: stack #60 → #63 plus repo hygiene

Prepared 2026-10-16 for the Codex (WILLOWFORGE ROOT) review and merge step that Adam
approved on 2026-10-16 (see `C:\Forge\CONTROL_PLANE.md`, top section). Approving this
document does not merge anything. Merging to `main` is Codex's job, and the merge
still needs its own review and green CI.

## What the stack contains

Base: `main` = `7091af8`. Stack tip before hygiene: `02306ef` (PR #63). That range has
158 commits; versus `main` they change 892 files, adding 2,280,846 lines and
deleting 4,043.

| PR | Head | Content |
|---|---|---|
| #44 | (in #60) | Integrates #39–#43: landing accessibility fixes, client/provider launch acceptance docs, isolated provider test fixtures, invoice equipment and recorded warranty snapshots, customer onboarding imports (merge commits `80274b0`, `eafb884`, `b357d44`, `29311fd`, `3bcdaee`) |
| #45–#55, #58 | (in #60) | Operator tooling: production75 recovery/verifier/observer, authenticated driver, bounded operator, custody, scheduling0019 observer, combined manifest |
| #56 | (in #60) | Crew end-of-day guard |
| #57 | (in #60) | Estimate email |
| #59 | (in #60) | Saved scheduling (capacity, project start, 0019 policy SQL) |
| #60 | `cf3b90c` | Combined source candidate: joins the #59 product and #58 operations (`98a90d6`) with preservation checks |
| #61 | `a237e83` | Reader transaction repair; CI isolates workspace suites without weakening cleanup limits |
| #62 | `b95cb5f` | Keeps bounded diagnostics across live-verification callbacks |
| #63 | `02306ef` | SMS carrier boundary (one-attempt carrier boundary, shared normal/CALLIE SMS handoff) and the legacy recovery proof with the exact C1 overlay |
| hygiene | this branch | Evidence relocation (`992f545`) and the VAPID test fixture fix (`2f79a31`) |

## CI evidence recorded so far

From `C:\Forge\LAUNCH_CONTROL.md` and `C:\Forge\GROWTHOS_LIVE_READINESS_STATUS_2026-10-16.md`:

| PR / head | Run | Result |
|---|---|---|
| #60 `cf3b90c` | 38811742821 | 6,733 passed / 0 failed / 15 existing skips |
| #61 `a237e83` | 38845373048 | all 20 steps passed; 6,745 tests passed, 0 failed |
| #62 `b95cb5f` | 38917705085 attempt 1 | **FAILED**: 1 API failure at `missed-call-care.test.ts:222` (`push_not_configured` 503); later steps skipped |
| #62 `b95cb5f` | 38917705085 attempt 2 (controlled rerun, unchanged source) | 6,794 passed / 0 failed / 15 existing skips |
| #63 `02306ef` | 38917758373 attempt 1 | 6,859 passed / 0 failed / 15 existing skips; types, both builds, Docker parity, cleanup all succeeded |

The #62 attempt 1 failure was the random VAPID fixture issue (ruling CI-R1, deferred
Minor). This branch fixes it in test code only (see below).

## Open items (not closed by this branch)

- `NEXT_ACTIONS.md` (from #60) says historical CI does not certify this candidate
  as a release. Green CI on the merge head proves source quality only. It does not
  prove release eligibility (`releaseEligible=false` stays).
- Still open: hosted Reader rehearsal, recovery or full mutation hold, G04/G06,
  both contractors' configuration/import/staff/provider/device/cutover, all 33
  live acceptance cases, and the V2 production cutover (package A, Codex-owned).
- No CI has run yet on the hygiene head. Codex runs it after pushing a private
  draft PR.

## What this hygiene branch changes

1. **Evidence relocation** (`992f545`). It removes 67 large raw evidence files
   (≈59.1 MB, 1,880,420 lines) from the tree. Each one is archived byte-identical
   (committed blob bytes, SHA-256 verified) under
   `C:\Forge\artifacts\growthos-evidence-archive\<original path>`. The pointers are
   `reports/EVIDENCE-INDEX.md` and `reports/evidence-index.json`. Files that code,
   tests or package A's V2 migration tooling read stay in the tree and are listed
   as "kept". History is not rewritten.
2. **VAPID fixture** (`2f79a31`). This is a test-only fix. The new
   `createVapidTestKeyPair()` retries until the private scalar is 32 bytes. Five
   suites use it, and a new unit test runs 4,096 draws. `staff-push-policy.ts`
   (production validation) is unchanged and stays fail-closed.
3. **C1 test-only amendment** (`adbf04a`, `2fbbeff`). The exact C1 preservation proof
   scopes `artifacts/api-server` and `lib`, test files included, so the VAPID
   change has to be pinned. It is pinned in a new
   `reports/c1-test-fixture-amendment-2026-10-16.json`, whose SHA-256 is pinned in
   `scripts/c1-source-preservation.mjs`. The amendment covers 7 paths, scope 2,119,
   and the amendment commit `2f79a31`.
   - The C1 descriptor and all its pins are unchanged.
   - The proof still checks the historical overlay commit `54cffe4` exactly.
   - It now also requires the amendment commit's lineage, tree and scope.
   - It allows only `*.test.ts(x)` and `src/test-helpers/*.ts` paths in the amendment.
   - B's historical product map must equal the overlay plus that amendment.

The proposed root integration also includes the separately reviewed Smart Site
source from D (`b7f34c70638f9f664a23817021324d26b7ed8ca6`, tree
`8aa71a245a97ef0c9f01c71afd8e1d29156e289f`). Its production change is governed
by the separate hash-pinned
`reports/c1-smart-site-integration-amendment-2026-10-16.json`; the seven-path B
amendment and its test-only rule are unchanged. The successor first proves D's
historical 2,118-entry map against the original 2,117-entry C1 overlay, then
applies the same three exact, disjoint changes to B's independently proved
2,119-entry map. The complete current API/library scope must have 2,120 entries,
SHA-256 `99a7972dbcb95bf3bc32190bcb0deac1a18c6b59907f8e0184d8e0983fd5b254`.
It also pins the complete three-file `scripts/smart-sites` map and exact CLI
bytes/modes; extra tracked or untracked CLI source and unstaged changes fail.

The descriptor binds B `308952e2abd0c97d4edc4274538af12a7134677a` / tree
`4962089d4b2859ef9dfb4f2b2c02885b5303c235`, D above, and the proposed ancestry
preserving source merge M `08c97d7b76ce8e4668c04dc1fcbde9089a709bbe` / tree
`bd3acb8c9912c4aebd81bfe2c1ac240fc158ed70`. All three must remain ancestors of
HEAD. M predates this proof extension, avoiding a self-referential commit pin.
The one-time generator and immutable source maps are external review evidence at
`C:\Forge\artifacts\growthos-launch-codex-20261016\integration-proof`. This local
proposed integration still needs fresh independent review and full exact-head CI;
the successor grants no release eligibility or hosted/provider authority.

Net effect against `main` once hygiene is on top: 879 files changed, adding 433,792
lines and deleting 36,096 (it was 2,280,846 added without hygiene). Of the 67
archived files, 23 (≈2.07 MB) were already on `main`. The merge removes them from
`main`'s tree, and `main`'s history keeps them.

## Recommended merge method

**Use a non-squash merge commit of the hygiene head (stack #60→#63 plus this branch)
into `main`.** Do not squash or rebase.

The repo's proofs need the reviewed SHAs to stay reachable from the merged head:
- `scripts/c1-source-preservation.mjs` requires the C1 overlay commit `54cffe4` and
  the amendment commit `2f79a31` to be ancestors of HEAD. The separate Smart Site
  successor also requires the exact reviewed B, D and proposed M identities above.
- Receipts and CI evidence cite exact stack SHAs.

`54cffe4` is not an ancestor of `main` (`7091af8`). A single-parent squash would
drop it from the lineage and fail the proof even with the right tree.

Consequence: the moved evidence files leave `main`'s **tree** but stay in `main`'s
**git history**. That covers the ≈57 MB the stack introduced and the ≈2.07 MB
already on `main`. Clones still download those blobs. Removing them from history
would need a rewrite, which is a separate owner decision and is not proposed here.

Do **not** merge #60–#63 without the hygiene commits on top.

## Checklist for Codex

- [ ] CI is green on the exact final head (stack + hygiene), including types, both builds, Docker parity and cleanup; record the run ID and pass count
- [ ] The tested tree equals the reviewed head tree
- [ ] Schema is still 142 tables; no new tables or migrations (scope freeze)
- [ ] The 19 original SQL pins (0000–0018, `scripts/production75-pins.mjs`) and the 0019 scheduling SQL (20 total) are byte-unchanged; the hygiene diff touches nothing under `lib/db`, `reports/staging-schema-preview-*/*.sql` or `.github/`
  - In `scripts/` it changes only the C1 proof (`c1-source-preservation.mjs` and its test) and `production75-combined-source.test.mjs`
- [ ] C1 descriptor `reports/c1-source-preservation-2026-10-16.json` and `reports/combined-release-preservation-2026-10-15.json` are byte-unchanged
  - The product scope (`artifacts/api-server`, `lib`) equals the unchanged C1 overlay plus the 7-path test-only B amendment and the exact 3-path D successor; all three historical maps remain independently checked
  - The complete `scripts/smart-sites` scope contains exactly the three reviewed CLI files with pinned bytes, blobs and modes; no extra tracked/untracked source or unstaged changes
  - `verifyC1SourceSnapshot(loadC1SourceSnapshot())` passes at the exact final head, as do the C1, contractor-recovery-drill and combined-source tests
- [ ] Secret scan is clean on the final head (Gitleaks 8.30.1 on the hygiene commits found no leaks locally; rerun on the merge head)
- [ ] `reports/EVIDENCE-INDEX.md` and `reports/evidence-index.json` exist; spot-check SHA-256 for a few archived files under `C:\Forge\artifacts\growthos-evidence-archive`
- [ ] Package A inputs are present in the tree: `schema-catalog.mjs`, 0019 SQL, `catalog-95/142.json`, `fixture75-*.sql`, `catalog75-*.json`
- [ ] Merge method is a non-squash merge commit that keeps `54cffe4`, `2f79a31`, reviewed B/D, proposed M and every reviewed stack SHA reachable, and Adam approved the merge to `main`
- [ ] Nothing hosted is implied: no deploy, provider activation, real send, production change or public launch comes with this merge
