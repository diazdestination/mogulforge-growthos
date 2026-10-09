# Release safety repair — October 8, 2026

## Scope and starting point

Work branch: `agent/growthos-production-gaps-20261008`, from main
`2162aa296281473dda170291ff95d64e0e6e9b79`. The parent verified starting-main CI
`37500458053`. This note records local source and synthetic test evidence for
the new repair; it does not attest the deployed application or a later CI run.

Owned changes are the generic schema-release script and its tests, API build
identity and its dedicated tests, one Docker dependency-install option, the
startup migration guard and its tests, environment/startup comments, and this
note. No schema, provider configuration, customer data or hosted system was
changed by these release-safety repairs.

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

## 3. Retired startup schema mutation

The follow-up audit found a second path in
`artifacts/api-server/src/lib/auto-migrate.ts`: `AUTO_MIGRATE=true`, `1` or
`yes` acquired a database advisory lock and started `drizzle-kit push --force`
from the serving process. `.env.example` recommended this as a beta fallback.
Retiring the generic Fly release command alone did not close this path.

`runAutoMigrate` now has no database, child-process or logger dependencies. An
enabled flag, including case and surrounding-whitespace variants, rejects
with one fixed operator message before this function performs any I/O. Its
disabled/unset behavior remains a no-op. Approval flags, a connection URL,
`MIGRATE_CWD` or a restore flag cannot authorize startup schema mutation.

**Normal startup with an enabled legacy setting now fails before HTTP listen
and startup seeding.** For an authorized rollout, leave `AUTO_MIGRATE` unset or
`false` and apply only the separately reviewed exact-source/SQL/target/recovery
procedure. A disabled flag does not verify that the database schema is current.
No hosted environment values were inspected or changed by this repair.

The invocation remains in `index.ts`. Its existing staging/restore identity
preflights still run earlier; their order and behavior are unchanged. The
validated restore-only path still bypasses normal startup work and still
requires `AUTO_MIGRATE=false` through the existing restore validator. Only
comments changed in `index.ts`. `.env.example` now explains the retired flag
and no longer advertises `MIGRATE_CWD` as a startup provisioning option.

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

### Startup follow-up

The new `src/lib/auto-migrate.test.ts` has **21 passing tests**. Existing
`src/lib/restore-mode.test.ts` adds **6 passing tests**; total **27 passed**,
no skips. The test run disabled Vitest config discovery to avoid the API's
database-provisioning global setup and retained only operating-system path
variables plus synthetic test settings. It used no database.

`pnpm --filter @workspace/api-server exec tsc -p tsconfig.json --noEmit` passed.
Scoped Prettier and `git diff --check` also passed. An independent source and
operator-note review reported no blocking finding.

Reproduce from the repository root in PowerShell:

```powershell
@'
import { fileURLToPath } from 'node:url';
const allowed = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|TEMP|TMP|PATHEXT|COMSPEC)$/i.test(key)));
process.env = { ...allowed, NODE_ENV: 'test', NO_COLOR: '1' };
const { startVitest } = await import('./artifacts/api-server/node_modules/vitest/dist/node.js');
const ctx = await startVitest('test', ['src/lib/auto-migrate.test.ts', 'src/lib/restore-mode.test.ts'], {
  root: fileURLToPath(new URL('./artifacts/api-server/', import.meta.url)),
  config: false, watch: false, maxWorkers: 1, fileParallelism: false,
});
if (!ctx || ctx.state.getFiles().some(file => file.result?.state === 'fail') || ctx.state.getUnhandledErrors().length) process.exitCode = 1;
await ctx?.close();
'@ | node --input-type=module
```

The startup tests cover all three enabled forms and case/space variants,
disabled/unset behavior, default invocation with an entirely synthetic process
environment, refusal despite approval/restore flags, and access to only the
single migration flag. Database imports, pool calls, child-process launches
and migration logging are guarded and asserted unused. Error text is fixed
and contains neither the connection nor directory canary. Existing restore
checks still reject an enabled migration flag.

There were no provider requests, database connections, installs, deployments,
commits or pushes in the release-safety implementation and unit verification.
The parent owns final integration, exact-head CI and current release records.
Hosted readiness, migration, restore and customer/provider acceptance remain
separate evidence.
