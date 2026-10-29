# GrowthOS controlled beta release

Updated October 29, 2026. The configured application URL is app.mogulforge.ai;
the last operator check found an older stopped production image. This runbook
does not claim that the current source or either contractor is live-ready.

Read [CURRENT-BUILD.md](CURRENT-BUILD.md), [DEPLOY.md](DEPLOY.md),
[STAGING.md](STAGING.md) and the exact current environment's private release
packet. The old generic Fly deploy/schema-push sequence is retired.

## Release gates

- Reviewed exact source/tree/image and relevant test/CI evidence.
- Fresh account/target/schema/configuration/secret-name and backup custody checks.
- Reconciliation of retained target data and previously consumed attempt intents.
- Compatible writable recovery or complete mutation-hold/forward-recovery proof.
- Held/private health, auth, tenant isolation, log and scheduler acceptance.
- Correct real provider identities, sender approvals, callback settings and
  bounded physical-device acceptance for each actual company.
- Full contractor migration/replacement/workday acceptance and applicable owner
  cutover/public-launch authority. Never infer it from local source completion.

Production signup remains gated by the actual accepted registration/invitation
rules. Verify the real allowlist/invite behavior before inviting anyone; do not
invent, publish or copy client addresses into source. Platform subscriptions and
contractor payment collection are separate scopes.

Avoid provider dashboard launchers that create/regenerate apps/configuration.
Do not run bare fly deploy, force schema reconciliation, replace working secret
values or reuse old once approvals to advance an unreviewed release. Prepare
and review the exact finite action and rollback packet first.
