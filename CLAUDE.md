# MogulForge GrowthOS — Claude Code Boot

This file is the mandatory project entrypoint for every Claude Code session in this
repository. Read the imported resume pack before planning or editing.

@GROWTHOS-RESUME.md

## Identity and scope

- Canonical local checkout: `C:\Users\diazd\dev\projects\mogulforge`
- Canonical private repository: `diazdestination/mogulforge-growthos`
- Working branch: `agent/mogulforge-growthos-recovery`
- `main` stays unchanged until Diego explicitly approves a merge.
- This is MogulForge GrowthOS. Do not add Jarvis branding or terminology to product
  source, documentation, or UI.

## Hard safety boundaries

- Never use or push to `diazdestination/MogulForge-crm-template-`. Its stale local clone
  was removed on 2026-08-06; do not recreate it for product work.
- The private `diazdestination/MogulForge` repository is the separate marketing site. Its
  old local clone was removed on 2026-08-06 so this CRM is the sole local MogulForge repo.
- Do not push, merge, deploy, publish, create paid resources, change DNS, enable billing,
  or use production credentials without Diego's explicit approval for that action.
- Preserve unrelated working-tree items. In particular, do not delete or commit
  `pnpm-workspace.yaml.bak` unless Diego explicitly asks.
- Never claim the broad API suite, a public deployment, a payment flow, or a provider
  integration is working without the matching live verification evidence.

## Start-of-session verification

Before editing, verify all of the following and stop if any identity check differs:

```powershell
git rev-parse --show-toplevel
git status --short --branch
git remote -v
git log -5 --oneline --decorate
```

The top level must be the canonical local checkout and `origin` must be the private
`mogulforge-crm` remote. Then follow `GROWTHOS-RESUME.md` for architecture, implemented
seams, tests, deployment gates, and the current next phase.

## Completion discipline

- Keep implementation state in this repository, especially `GROWTHOS-RESUME.md` and
  `GROWTHOS-ARCHITECTURE.md`, not only in chat or global machine notes.
- Run proportionate focused tests and a production build before declaring a change done.
- Commit only intentional files to the recovery branch. Do not push by implication.
