# GrowthOS resume guide

Updated October 29, 2026. This is the current entry point, not the old August
recovery-branch bootstrap. Read [CURRENT-BUILD.md](CURRENT-BUILD.md),
[PROJECT_STATE.md](PROJECT_STATE.md), [NEXT_ACTIONS.md](NEXT_ACTIONS.md) and
[AGENTS.md](AGENTS.md). Historical plans/reports are classified in
[the documentation map](docs/DOCUMENTATION-MAP.md).

## Verify before work

Canonical remote: `https://github.com/diazdestination/mogulforge-growthos.git`;
the old `mogulforge-crm` name redirects here. Last verified visibility: public.
Use the current task's isolated worktree, not a hardcoded old Windows directory
or recovery branch. From your checkout:

```powershell
git rev-parse --show-toplevel
git status --short --branch
git remote -v
git fetch origin main
git log -5 --oneline --decorate
```

Preserve local edits; do not switch, reset or pull a dirty shared checkout.
Verify active identity against the intended account before any remote write.
Baseline before this docs refresh: main f0d74ab4, with source integrated through
PR #68/69. Separate draft PR #70 contains the later import-selection fix.

## What to resume

The product includes native contractor work, scheduling, invoicing/external
receipts, BIE, Smart Sites, service follow-up, Twilio/CALLIE and mailbox
foundations. Do not rerun old implementation waves solely because their reports
say pending. Current source details and verification are in CURRENT-BUILD.

Twilio account/sender inventory is waiting for owner sign-in. Production's last
check was an older stopped image. Clock repair and fresh hosted reconciliation/
source-image-operator-recovery review precede another cutover decision. Preserve
retained target data and consumed approvals. Full contractor migration/workday/
provider/device acceptance remains separate. No provider or customer is activated
by this guide.

## Local verification

Use [DEV-LOCAL.md](DEV-LOCAL.md) and the credential-excluding local-dev runner.
Do not revive the old shared database/bootstrap or generic schema push. Tests
and builds never grant hosted deployment, paid resource, real send or launch
authority. Keep exact results/source IDs in durable records; private operator
receipts remain outside public Git. Forge operators also read
`C:/Forge/CONTROL_PLANE.md` for the current private checkpoint and exact authority.
