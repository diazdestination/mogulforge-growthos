# Windows pnpm native executable compatibility

The local runner now supports an installed native `pnpm.exe` when no discovered `.cmd` has a real adjacent pnpm Node CLI. A discovered real `node_modules/pnpm/bin/pnpm.mjs` or `.cjs` remains preferred and runs through the current Node executable. Native fallback is spawned directly with the original argument array, existing environment/cwd/stdio/hidden-window settings and no shell.

## Observed problem and bounded change

ROOT supplied actual GEEKOM metadata: `where.exe pnpm` found, in order:

1. `C:/Users/diazd/AppData/Local/Microsoft/WinGet/Packages/pnpm.pnpm_Microsoft.Winget.Source_8wekyb3d8bbwe/pnpm.exe`, actual version11.3.0.
2. `C:/Users/diazd/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm.cmd`, with neither adjacent `pnpm.mjs` nor `pnpm.cjs`.

GEEKOM uses actual Node24.18.0. Its normal UI/typecheck commands failed before discovery because the old resolver selected the incomplete `.cmd` and rejected the otherwise usable native executable. These peer observations were supplied by ROOT; this worktree did not execute the peer native binary or replace the retained original failures.

`scripts/local-dev.mjs` now searches discovered `.cmd` candidates for an existing Node CLI, preserving mjs-before-cjs preference. If none exists, it selects only a discovered, existing basename `pnpm.exe`. Unsupported wrappers and missing executables remain rejected. Windows paths use `node:path.win32` explicitly, so simulated Windows inputs behave consistently on Linux with Node22 and Windows with Node24 rather than depending on the host path parser.

Only the runner, its existing test file and this new report are changed. Non-Windows behavior, environment/credential filtering, outbound holds, workspace-concurrency1, workers2, all existing tests/timers/coverage, internal independent PG clients, container/run-ID ownership, schema/cleanup and literal API-test argument guards remain unchanged. No install/download, shell invocation, shim, global configuration, PATH/profile or provider change.

## Executed focused RED/GREEN

Both phases used the existing focused suite command, without timer/resource overrides:

`pnpm --filter @workspace/scripts exec vitest run local-dev.test.mjs`

- RED before implementation:4 failed/12 passed/16 cases,355ms. Exact peer native-exe-first/incomplete-fallback order, native-exe-only, incomplete-cmd-before-native and later-complete-cmd cases failed with the original `Cannot resolve the installed pnpm Node.js launcher.` error. This was executed behavior failure, not a missing export or suite-load error.
- Final exact-source GREEN:16/16 passed,0 skips,289ms. Negative fixtures mark unsupported files as genuinely existing; both mjs/cjs are provided for preference coverage. The no-shell assertion accepts either false or the existing unspecified default. Intermediate16/16 passing logs at323ms/316ms are also retained.

The eight original guards remain, with eight added launcher contracts. Tests exercise the real `main('ui')`/`main('typecheck')` dispatcher and resolver with controlled OS discovery/filesystem/process boundaries. They assert exact emitted program/argument arrays, direct hidden spawn/no shell, Node CLI preference, both incomplete-cmd/native orders, unsupported/missing launchers with no spawn, and unchanged non-Windows behavior. Platform-property restoration is in `finally`; Windows CLI path expectations are independent literal Windows paths. Actual Linux Node22 CI was not run in this lane.

WILLOWFORGE actual local inventory: Node24.19.0; `where.exe pnpm` lists no native executable, and the exact peer Winget executable path does not exist locally. Therefore these results prove mocked native resolution/spawn contracts, not actual native executable acceptance. GEEKOM must run the reviewed exact-source normal commands against its existing native11.3.0 installation after ROOT review/integration/publish/GO.

## Identities and evidence

- Branch `agent/growthos-pnpm-native-launcher-20261014`.
- Exact clean BASE `76ee0b6b3c33a68ea9129129431f49bb0b176cf7`, tree `b2fff3c63b7d17a31d3df7c89995dd4255c0031a`.
- Runner resulting Git blob `32507a1b21c18d872c6ed4b0ad9e37b0e5ca4979`; tests resulting Git blob `fb3a6d56ec1e2d68e5b084fa346efdd94eed4512`.
- Zero API/lib and product UI differences from BASE; zero API/lib differences from strict source checkpoint `f56e6cef452b5b564838a72202c0d37cd2caf384`. No recovery refresh is implied by this runner-only change.
- Node syntax and scoped diff checks passed. Source/patch redacted Gitleaks8.30.1 receipts and exact final commit/tree are recorded in ignored `work/task12-pnpm-native-launcher/report.md` after commit.

Raw RED/GREEN/inventory/source receipts remain in that new ignored directory. RED log SHA256 `59a6d143506c2e7dcf161c8657b8af420783e66ced5a1c13216919794dd3ade1`; final exact-source GREEN SHA256 `372365c868fe3adb3b35fc73c38fbc22581cf7cbfdec54d58a43964c86d2df84`. The inherited pnpm warning about legacy package fields remains visible and unmodified.

No full normal/native API/UI/browser/recovery/parity run was performed here; ROOT explicitly restricted this lane to focused launcher verification. The prepared full-run observer and all earlier source/runtime proofs remain untouched. This change requires fresh independent scoped review before integration/publication and actual peer verification. No remote, merge, provider, hosted, customer, spend, deployment or public-launch action occurred.
