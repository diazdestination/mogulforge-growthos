# MogulForge GrowthOS — Claude Code Boot

This file is the mandatory project entrypoint for every Claude Code session in this
repository. Read both imported handoff files before planning or acting.

@GROWTHOS-RESUME.md
@CLAUDE-BETA-AUDIT.md

## Identity and scope

- Claude audit worktree: `C:\Users\diazd\dev\projects\mogulforge-claude-audit`
- Protected canonical Codex checkout: `C:\Users\diazd\dev\projects\mogulforge`
- Canonical private repository: `diazdestination/mogulforge-crm`
- Claude working branch: `agent/claude-beta-audit`
- Verified parent baseline: `e5f3b897fe40bf8275580b4aaf5704dcf1619661`
- `main` and `agent/mogulforge-growthos-recovery` stay unchanged.
- This is MogulForge GrowthOS. Do not add Jarvis branding or terminology to product
  source, documentation, or UI.

## First-session mode

The first session is audit-only. Read `CLAUDE-BETA-AUDIT.md`, inspect the repository,
and return the requested evidence-backed readiness report. Do not edit, commit, push,
merge, deploy, create resources, or change external configuration.

## Hard safety boundaries

- Never work directly in the protected canonical Codex checkout.
- Never use or push to `diazdestination/MogulForge-crm-template-`.
- The private `diazdestination/MogulForge` repository is the separate marketing site.
- Do not push, merge, deploy, publish, create paid resources, change DNS, enable billing,
  or use production credentials without Diego's explicit approval for that action.
- Preserve unrelated working-tree items.
- Never claim a public deployment, payment flow, provider integration, or acceptance
  test is working without matching live verification evidence.

## Start-of-session verification

Before inspecting source, verify all of the following and stop if any identity check
differs:

```powershell
git rev-parse --show-toplevel
git status --short --branch
git remote -v
git log -5 --oneline --decorate
```

The top level must be the Claude audit worktree, the branch must be
`agent/claude-beta-audit`, and `origin` must be the private
`diazdestination/mogulforge-crm` remote.

## Completion discipline

- Follow the exact scope and boundaries in `CLAUDE-BETA-AUDIT.md`.
- Keep findings evidence-backed and distinguish implemented, tested, externally gated,
  and unverified behavior.
- After the initial audit, wait for a bounded assignment before editing.
