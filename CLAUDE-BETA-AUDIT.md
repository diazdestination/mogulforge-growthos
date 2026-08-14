# Claude Code Founding-Beta Audit Brief

Status date: 2026-08-13  
Repository: `diazdestination/mogulforge-crm` (private)  
Audit branch: `agent/claude-beta-audit`  
Verified baseline: `e5f3b897fe40bf8275580b4aaf5704dcf1619661`

## Purpose

Claude Code is joining as a bounded product-review and implementation partner. Codex
remains the release owner for pull-request integration, CI, security-sensitive
configuration, Cloudflare, Fly, database migrations, secrets, and deployment gates.

The first Claude session is audit-only. Do not edit files, commit, push, merge, deploy,
create resources, change configuration, or contact external services.

## Mandatory reading order

1. `C:\Users\diazd\dev\jarvis\STATE.md`
2. Repository `CLAUDE.md`
3. `GROWTHOS-RESUME.md`
4. `BETA-SUCCESS-PLAN.md`
5. `EMAIL-INTELLIGENCE-ARCHITECTURE.md`
6. `EMAIL-INTELLIGENCE-SETUP.md`
7. `GOOGLE-BUSINESS-GRAPH.md`
8. `GOOGLE-OAUTH-SETUP.md`
9. Draft PR #1 and its current verification evidence

Treat older statements in `GROWTHOS-RESUME.md` as historical where they conflict with
the newer 2026-08-13 checkpoint, GitHub PR, or current source.

## Verified current baseline

- The repository is private.
- Draft PR #1 targets `main`, remains open, draft, and unmerged.
- The reviewed recovery branch head is `e5f3b89`.
- GitHub Actions passed at that commit:
  - 154 test files and 1,187 tests passed.
  - API server: 972 tests.
  - Command Center: 190 tests.
  - API client: 13 tests.
  - Cloudflare Email Worker: 3 tests.
  - Workspace scripts: 9 tests.
  - 3 files / 15 tests intentionally skipped.
  - PostgreSQL schema application, typechecks, and both production builds passed.
- Production quiet-hours enforcement remains enabled; only deterministic test fixtures
  bypass it where sending is explicitly the subject under test.
- No merge or deployment of this branch has occurred.
- The current live Fly app is an older, separately authorized baseline.
- Real Google OAuth consent/send/refresh/revoke, two-user/two-tenant acceptance,
  Cloudflare Email Routing, Worker secrets, intake DNS, privacy/legal readiness,
  production secrets, database migration, and external beta acceptance remain gates.

## Initial assignment: read-only readiness audit

Inspect the code and documentation and return a concise, evidence-backed report with:

1. The ten highest-risk gaps between the current branch and a trustworthy invite-only beta.
2. For each gap: severity, exact files/components, current evidence, missing acceptance
   evidence, and the smallest bounded implementation task.
3. Any mismatch between product claims, documentation, UI, API behavior, and tests.
4. Any tenant-isolation, authorization, retention/deletion, OAuth, email-delivery,
   background-job, observability, backup/restore, or incident-response concern.
5. A recommended division of the next five tasks between Codex and Claude.

Do not duplicate work already proven by CI unless you identify a specific evidence gap.
Do not redesign implemented seams without demonstrating a concrete defect or beta blocker.

## Non-negotiable boundaries

Claude must not:

- work from `C:\` or another guessed checkout;
- touch `main`, PR #1, or `agent/mogulforge-growthos-recovery`;
- push, merge, force-push, rewrite history, or mark a PR ready;
- deploy or change Fly, Cloudflare, DNS, Google, Stripe, secrets, OAuth clients,
  permissions, billing, or production databases;
- delete files or weaken authentication, authorization, tenant isolation, audit logs,
  consent, suppression, retention, quiet hours, provider checks, or approval gates;
- introduce unsupported capability or revenue claims;
- use the public template repository or the separate MogulForge marketing repository.

If repository identity, branch, remote, or expected baseline differs, stop and report the
difference before doing anything else.
