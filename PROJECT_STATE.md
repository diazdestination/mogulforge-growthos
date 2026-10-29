# GrowthOS project state

Updated October 29, 2026. [CURRENT-BUILD.md](CURRENT-BUILD.md) holds the detailed
feature/status inventory; [the map](docs/DOCUMENTATION-MAP.md) classifies history.

## Source

Canonical product: `diazdestination/mogulforge-growthos`, formerly
`mogulforge-crm`; last verified visibility public. This refresh starts from
`f0d74ab4ab2db756637cf3b4ad306b33982c9688`. Main includes the source integration
through PR #68 and CI changes PR #69. Recovery/scheduling/workday/BIE/communications
work in that ancestry is implemented, not an outstanding recovery-branch task.

The October 27 import-selection fix is separately open in draft
[PR #70](https://github.com/diazdestination/mogulforge-growthos/pull/70) at
`a1ecbd5e792f5d3f220c224a351fbdada76d1bb2`; it is not part of this baseline.
Inspect ancestry before resuming old dependent PRs that may already be included.

## Verification

Existing fullCI39174960772SUCCESS checked out7b4cbc3; its tree equals baseline
main d2df1e226dc9b496c66909f9c2b2a8464e72eb43. Linux Node 22.23.3 tests/types/builds/
Docker parity passed. October 29 selected314 native PostgreSQL tests and 45 UI tests
passed, zero skips; earlier Twilio/PGlite: 79 passed. These are scoped source proofs,
not hosted/provider/device/customer acceptance or new CI for a documentation SHA.

## Live dependencies

Twilio is selected for current SMS/basic calling setup; sign-in, actual sender/
service approvals and credential installation remain pending. Telnyx work is
parked. The last operator check found production stopped on an older image.
The last cutover rolled back before reopen after rejected log frames; its once
authority is consumed. Retained target data and recovery material must be
reconciled; workstation clock repair is pending and cause is not conclusive.

Full migration, actual staff/device/provider workdays, compatible recovery and
both contractor replacement/cutover cards remain open. Payment collection,
financing, broader required delivery/cadence work, automatic after-hours replies
and live AI phone answering are not declared finished.

## Continue

Read [NEXT_ACTIONS.md](NEXT_ACTIONS.md), [RUNBOOK.md](RUNBOOK.md) and
[GROWTHOS-RESUME.md](GROWTHOS-RESUME.md). Use isolated branches/worktrees and current
identity/source checks. Forge operators retain private receipts and exact
authority in `C:/Forge/CONTROL_PLANE.md`; those are not copied into public Git.
Documentation updates grant no deployment, spending or provider authority.
