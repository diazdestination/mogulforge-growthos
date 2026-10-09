# Release safety repair — October 8, 2026

## Scope and starting point

Work branch: `agent/growthos-production-gaps-20261008`, from main
`2162aa296281473dda170291ff95d64e0e6e9b79`. The parent verified starting-main CI
`37500458053`. This note records local source and synthetic test evidence for
the new repair; it does not attest the deployed application or a later CI run.

Owned changes are the generic schema-release script and its tests, API build
identity and its dedicated tests, one Docker dependency-install option, and
this note. No schema, provider configuration, customer data or hosted system
was changed.

## 1. Retired generic forced schema mutation

### Reproduced defect

Both Fly configurations invoke `scripts/release-schema.mjs`. Previously its
guard returned immediately for every identity other than the recognized
staging app/origin. The following command then ran `drizzle-kit push --force`.
Pure local calls demonstrated that production, an unknown hosted app and
missing identity all passed. An existing test explicitly expected production
to bypass the staging gate.

### Repair and operator impact

The script has no child-process or database execution path. Its legacy
`assertStagingSchemaPushGate` export always refuses reconciliation; the CLI
prints a fixed operator message and exits with code 1. Staging, production,
unknown, missing, contradictory and local-looking identities are refused.
Approval environment flags cannot override this behavior. The exported
`detectSchemaPushFailure` helper retains its existing behavior for isolated
callers and tests.

**An ordinary Fly deployment using this command will stop at the release
step.** Operators must prepare a separately reviewed rollout procedure tied
to the exact source/image, SQL artifact, database target and backup/restore
evidence before changing that release path. This repair provides no new
migration executor or deployment authorization. Setting an approval variable
does not make the retired command usable.

The independent Docker parity schema service and documented local Compose
bootstrap invoke their own direct provisioning commands. Those files and
paths are unchanged. This change retires the generic deployment command;
operators must still use other database tools only within their authorized
target and scope.

## 2. Honest build identity after Git failures

### Reproduced defect

API build identity previously treated any failing `git rev-parse HEAD` as a
Docker context without Git metadata. A local injection of `ETIMEDOUT` in this
real worktree returned the supplied synthetic SHA even though `.git` existed.
The original tests covered a failed status command but did not distinguish
a failed HEAD lookup in a known checkout from absent metadata.

### Repair

The build now verifies that its source directory exists, then inspects `.git`
metadata. A directory and a worktree file both identify a known checkout.
Metadata inspection failure, Git timeout, missing Git executable, inaccessible
or corrupt repository metadata, invalid HEAD, dirty source, failed status and
conflicting supplied SHA yield `sha: null`.

Only confirmed absence of `.git` in an existing source directory permits the
explicit `GROWTHOS_BUILD_SHA` input used by Docker. The input still requires
40 hexadecimal characters. It remains an operator assertion about the build
context; the resulting image and exact source must be verified for rollout.

Docker dependency installation now uses `--frozen-lockfile --ignore-scripts`.
An inconsistent committed lockfile must fail the image build instead of being
rewritten during installation. No dependency installation was performed in
this lane; full image build/parity remains an integration/CI check.

## Local verification

Command:

```powershell
pnpm --filter @workspace/scripts exec vitest run release-schema.test.mjs release-identity-build.test.mjs
```

Result: **30 tests passed in two files**, no skips (October 8 local run).

- Six CLI scenarios run with a synthetic environment and guarded child/TCP
  entry points. Each exits 1 before either entry point is called; stdout is
  empty, stderr contains only the fixed refusal, and the synthetic connection
  canary is absent from output.
- All six identities are also rejected through the exported guard with and
  without approval flags.
- Existing database-error output detection remains covered.
- Temporary filesystem fixtures cover a normal `.git` directory, a worktree
  `.git` file, a Git-less context and invalid source-directory paths. Git
  failures cannot borrow a supplied SHA; confirmed Git-less input and clean
  checkout identities remain positive controls. Fixtures are cleaned only
  after checking the owned temporary path.
- The four JavaScript files were formatted with repository Prettier.

There were no provider requests, database connections, installs, deployments,
commits or pushes in this lane. The parent owns final integration, exact-head
CI and current release records. Hosted readiness, migration, restore and
customer/provider acceptance remain separate evidence.
