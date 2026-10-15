# Saved scheduling CI typecheck resource correction

## Observed failure

PR59 head `c6101651831df5938b343f1bfc08d8beba65a020`, tree `049d7dab6bae94eb2524f9092c1d33a83c93f5f3`, failed CI run `38685836096` in the API TypeScript check. The retained log shows V8 allocation failures around 2029 MiB, a roughly 2083–2100 MiB heap, then `Reached heap limit` and exit 134. Library checking had completed; Command Center and scripts reported Done. The API compiler did not complete and emitted no TypeScript diagnostic before aborting. Tests and website checks had already passed in that run; later build/parity steps were not accepted from it.

This is an observed V8 heap-limit failure, not a demonstrated source typing error. ROOT retains the original failed step log and statuses in `C:/Forge/artifacts/growthos-scheduling-plan-20261013/first-ci-c610165-38685836096/`; the original failure is not rewritten.

## Bounded workflow change

Only the existing **Run TypeScript checks** step receives:

```yaml
env:
  NODE_OPTIONS: --max-old-space-size=4096
  pnpm_config_workspace_concurrency: "1"
run: pnpm run typecheck
```

The command and existing typecheck program are unchanged. The step gives each inherited Node compiler a bounded 4096 MiB old-space allowance and runs recursive workspace checks serially, reducing concurrent compiler memory pressure. Old-space is not a total process-RSS or VM memory cap. The environment does not extend to tests, app builds or parity. No files, checks, tests, timers, coverage, dependencies or typechecking rules were excluded or changed.

GitHub's current [standard runner specification](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-private-repositories) lists private-repository `ubuntu-latest` Linux runners as 2 CPUs/8 GB RAM. That is the documented label specification, not a measurement from this failed job. The runner label remains unchanged; no larger/paid runner or subscription action was made. Node documents [the old-space option in MiB](https://nodejs.org/api/cli.html#--max-old-space-sizesize-in-mib); pnpm documents [recursive workspace concurrency](https://pnpm.io/cli/recursive#--workspace-concurrency).

## Exact local validation

- Existing pnpm 11.3.0 returned `workspaceConcurrency=1` with the process-only `pnpm_config_workspace_concurrency=1`. The legacy `npm_config_workspace_concurrency` query returned undefined and was not used in the workflow.
- A real `pnpm --filter @workspace/api-server exec node` child inherited both variables. Node 24.19.0 reported a 4288 MiB total V8 heap limit with the 4096 MiB old-space setting; this is a direct child observation, not an asserted RSS limit.
- Exactly one unchanged `pnpm run typecheck` completed exit 0 in 57.141 seconds using existing PRIMARY dependencies, process-only heap/concurrency settings and no install. Existing library and three workspace compiler steps completed. Before/after HEAD, tree and tracked status stayed exact clean c610/049d.
- Static workflow checks confirm the change is confined to this step's two environment entries, the run command is unchanged, and all other workflow content is preserved. Only this workflow and this new report are owned.

Raw local receipts remain in the authoring worktree's ignored `work/ci-typecheck-resource-20261014/`: `bounded-typecheck-proof.json`, `bounded-typecheck.log` and `environment-child-proof.json`. The typecheck log SHA256 is `72a3c3f45c38702446b3b0541eeb567996b7f8b681329fd91e07c581d65f4a04`. No runtime tests, build, recovery, browser, parity or healthy full suite was repeated.

## Limits and handoff

Local validation used Windows/Node 24.19.0/pnpm 11.3.0. CI declares Node 22/Linux, so this local pass does not establish exact Linux CI effectiveness or replace any prior proof. ROOT owns independent review, integration, publication and one exact-new-head CI. This lane made no push, PR, CI dispatch, merge, deployment, provider, customer or paid action. The original CI remains failed until the new source receives its own result; existing hosted/release/rollback holds remain unchanged.
