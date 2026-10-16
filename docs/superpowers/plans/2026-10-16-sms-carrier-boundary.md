# Shared SMS Carrier Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route both existing SMS owners through one typed, one-attempt carrier
boundary without changing their grants, wire requests, receipts or retry policy.

**Architecture:** ROOT implements the shared transport, then integrates the normal
sender and CALLIE compatibility wrapper sequentially. Each owner retains its
durable claim, final business checks, response parsing and settlement. GEEKOM
checks compatibility; an independent reviewer checks the actual changed source.

**Tech Stack:** Existing TypeScript, Node22/24, pnpm11.3.0, Vitest4, native fetch,
Drizzle/PostgreSQL16 and the existing local test/parity runners. No new dependency.

**Spec:** [Approved C1 design](../specs/2026-10-16-communications-compatibility-design.md),
core SHA256 `35990ac4b0fe4090bb5588da5b3926589a1f850a74272e7999c24aea80eb5cb1`,
at docs commit `0890fc763410144634b88f926d57c87598a19abf`.
The sibling voice annex is conditional future C3 input, not implemented here.
Adam's direct `I approve` authorizes this written-plan stage; execution of this
plan waits for his plan review and execution-method approval.

## Global Constraints

- "C1 makes no schema or SQL change."
- Retain "POST, form encoding, Basic authorization, `redirect: "error"` and the ten-second abort."
- "The extraction preserves existing owner guard ordering and invocation counts, including the second normal service-parent `beforeDispatch` check."
- "The shared adapter returns the provider response to the same business owner."
- "The supported carrier adapter receives a current-identity resolver and a handoff callback."
- "The normal owner's `dispatched` point remains after its final grant checks and before fetch."
- "Every owned failed or unknown operation still counts against the existing allowance."
- "No caller can choose a second provider after failure or uncertainty."
- "No production selector or readiness response advertises Telnyx in C1."
- Preserve exact payload/operation hashes, public owner signatures, callbacks,
  SID validation, suppression/consent rules, advisory-lock namespace and both ledgers.
- Do not edit DB/SQL, dependencies, generated API, UI, provider status, scheduler,
  voice/runtime tooling, CI, test timeout/worker limits or existing accepted receipts.
- Preserve all20 numbered staging SQL inputs0000-0019: the original19 through0018
  plus the separately added0019 scheduling input. This clarifies the spec's legacy
  nineteen-file wording; every existing SQL blob remains protected.
- Use only synthetic fixtures and intercepted provider fetches. Copy no `.env`
  or credentials. Test database schema commands target only a fresh owned fixture.
- Source publication/PR/CI dispatch remains a separate decision after concrete
  source/review evidence. No provider/runtime/hosted/financial/customer/launch action.

## Review Focus

1. Encoding-sensitive text and optional sender: preserve literal wire bytes and
   omit From for CALLIE even if an internal caller supplies extra properties (Tasks1/2).
2. Response with unread success/error bodies: return the exact Response without
   consuming, cloning or translating its HTTP status (Task1).
3. Falsy and Error rejection values: preserve exact rejection identity, avoid a
   marker/fetch after resolver failure, and never retry a rejected fetch (Task1).
4. Hold changes while resolving authority: final hold precedes the synchronous
   marker/fetch; no asynchronous marker gap or production mock fallback (Task1).
5. Service-parent/contact-touch and storage failures: keep both final approval
   checks, original claims and different normal/CALLIE settlements (Task2).

## File structure, ownership and execution recommendation

| File | Responsibility | Owner |
| --- | --- | --- |
| `artifacts/api-server/src/services/sms-carrier-transport.ts` | New closed carrier input, fixed unsupported error, exact physical Twilio POST. | ROOT |
| `artifacts/api-server/src/services/sms-carrier-transport.test.ts` | New observable transport/wrapper tests; real fetch always intercepted. | ROOT |
| `artifacts/api-server/src/services/twilio-delivery.ts` | Delegate only the physical seam; retain normal owner checks and settlement. | ROOT |
| `artifacts/api-server/src/services/callie-ack-transport.ts` | Preserve public wrapper/signature and CALLIE wire shape. | ROOT |
| `artifacts/api-server/src/services/twilio-dispatch-guard.test.ts` | Normal-owner boundary use, exact failures, permanent claim regressions. | ROOT |
| `artifacts/api-server/src/services/callie-runtime.test.ts` | CALLIE boundary use and distinct failure/unknown evidence; reuse real PG races. | ROOT |
| `artifacts/api-server/src/services/service-sms.test.ts` | Exact service From and second approval check; reuse parent/reply guards. | ROOT |

`callie-runtime.ts`, `twilio-sms-budget.ts` and all schema files remain unchanged.
Run existing SMS/missed-call/provider suites; do not edit them unless a demonstrated
test-only interception seam requires a separately reviewed minimal adjustment.

Recommend **Native execution with coordinated review**: ROOT implements these
dependent tasks in one isolated source branch; GEEKOM supplies a focused independent
compatibility check and the local reviewer audits the changed source. No parallel
writers edit the shared seam. This is a recommendation awaiting Adam's confirmation.
Contributors are not alone in the repository and must preserve other agents' edits.

## Execution setup and evidence rules

After plan approval, preserve the design branch and create
`agent/growthos-sms-carrier-boundary-20261016` at the exact approved plan commit
in the existing clean isolated worktree. If that branch already exists, inspect
and reuse only an exact matching owned branch; otherwise hold, never reset it.
Original b95 worktree, a237 branch and main7091 remain protected.

Verify the approved plan/spec hashes, Node22/24 and pnpm11.3.0. If dependencies
are missing, use the existing cache with
`pnpm install --offline --frozen-lockfile --ignore-scripts`; missing cache is a
specific setup hold, not permission to upgrade, change the lockfile or install
tools. Do not copy another active worktree or credentials. No setup runs now.

Commands below run from the source worktree root. The existing API Vitest config
requires PG even for the pure carrier test, so use the established owned runner
rather than add a product test config. `node scripts/local-dev.mjs test <files>`
creates a random loopback-only PostgreSQL16 fixture, sanitizes the child environment
and holds an owned WSL session through cleanup. All test fetches use synthetic
responses; an unexpected provider URL fails before any real external request.

Record actual commands, exits, counts, RED/GREEN failures and source hashes in
`C:/Forge/artifacts/growthos-sms-carrier-implementation-20261016/`. Preserve failures.
Capture run-owned container identity and before/after volume names; verify owned
fixture clients/containers/session closed and no new unowned volume left. A cleanup
failure holds acceptance; inspect and clean only the exact proven owned fixture,
never prune existing Docker resources or reuse private production data.

### Task 1: Implement the shared one-attempt carrier boundary

**Files:** Create `sms-carrier-transport.ts` and its sibling test as listed above.

**Interfaces:**

```ts
export interface TwilioSmsCarrierIdentity {
  accountSid: string; apiKeySid: string; apiKeySecret: string;
  messagingServiceSid: string; to: string; message: string;
  callbackUrl: string; from?: string;
}
export type SmsCarrierAttempt =
  | { provider: "twilio"; current: () => Promise<TwilioSmsCarrierIdentity>;
      onDispatch: () => void }
  | { provider: "telnyx" };
export class SmsCarrierUnsupportedError extends Error {
  readonly code: "sms_carrier_unsupported";
}
export function postSmsOnce(attempt: SmsCarrierAttempt): Promise<Response>;
```

The unsupported error message is fixed: `SMS carrier is unsupported`. It contains
no input value/cause. Unknown runtime discriminators produce the same refusal.
No provider SDK, database import, parsing, logger, retry, queue or fallback.

- [ ] **Step1: Write behavioral tests for the interface.** Use a local
  `twilioIdentity(overrides: Partial<TwilioSmsCarrierIdentity> = {})` fixture with
  synthetic repeated-character SIDs, API secret `test`, E.164 test numbers,
  text `A + & % ✓`, and an `example.invalid` callback. Stub/restore fetch and
  environment per test. Default fetch refuses any unconfigured call.
  Add the following named assertions, not a snapshot of implementation code:

  ```ts
  // returns the exact unconsumed Response for 201, 429 and 503
  expect(await postSmsOnce(attempt)).toBe(response);
  expect(response.bodyUsed).toBe(false);
  // rejects unsupported carriers before any resolver, marker or fetch
  const unsupported = { provider: "telnyx", current, onDispatch }
    as unknown as SmsCarrierAttempt; // deliberate extra runtime fields
  await expect(postSmsOnce(unsupported))
    .rejects.toMatchObject({ code: "sms_carrier_unsupported" });
  expect(current).not.toHaveBeenCalled();
  expect(onDispatch).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  ```

  Separate tests assert exact URL/method/form Content-Type, decoded synthetic
  Basic identity, literal encoded body and parameter order, optional From omission,
  `redirect: "error"`, and exactly `AbortSignal.timeout(10_000)`. Use a spy on
  `AbortSignal.timeout`, returning a test AbortSignal, then restore it.

  Add `resolver_then_final_hold_then_sync_marker_then_fetch` with an explicit
  trace. A resolver sets the hold true: marker/fetch must both stay absent.
  With the hold false, schedule a microtask inside the synchronous marker and
  assert fetch is invoked before that microtask; never await the marker.
  Missing/overridden staging holds still refuse through the existing guard.

  For each of resolver, marker and fetch, test `Error`, `0`, `null` and `undefined`
  rejection/throw values using `rejects.toBe(value)`. Resolver/marker failures
  make zero fetches; a fetch failure makes one and never retries. Returning a
  Response does not call `.json()`, `.text()` or `.clone()`. Capture log spies to
  prove the module emits no credential/header/body diagnostics.

- [ ] **Step2: Run RED.**
  `node scripts/local-dev.mjs test src/services/sms-carrier-transport.test.ts`
  must fail because the new module/interface is absent. If setup fails, record
  that separately; infrastructure failure is not a valid behavioral RED.
- [ ] **Step3: Implement `postSmsOnce` and its exact exported types/error.** Check
  provider first; await `current()` once; call the existing outbound hold; call
  `onDispatch()` synchronously; perform exactly one native fetch. Serialize form
  parameters in existing order: To, MessagingServiceSid, optional From, Body,
  StatusCallback. Pass through the original Response/rejection untouched.
- [ ] **Step4: Run GREEN with the same command.** Require all new cases pass,
  no skips and successful owned-fixture cleanup. Recheck the unsupported/hold
  branches did not resolve secrets or invoke fetch. Task1 alone is not C1 complete.
- [ ] **Step5: Review and commit only these two files.** Use the existing
  independent reviewer for a focused contract/source check, then commit
  `refactor: add one-attempt SMS carrier boundary`. No source publication.

### Task 2: Route both existing owners through the shared boundary

**Files:** Modify the two existing transport/owner files and the three existing
test files in the ownership table. Extend the new unit test for wrapper behavior.

**Consumes:** Task1's exact exports. **Produces:** existing
`sendTwilioSms(to, body, context?, beforeDispatch?)` and
`postCallieAcknowledgment(current, onDispatch): Promise<Response>` signatures
remain compatible; no business-state or public API changes.

- [ ] **Step1: Add characterization and delegation tests.** In the existing
  normal/CALLIE fixture files, wrap the real imported `postSmsOnce` using Vitest's
  hoisted-module wrapper pattern already used by CALLIE. Count invocation while
  forwarding to the real function; never replace it with a fabricated success.
  Require the new boundary is reached once by each actual owner. These assertions
  are RED on Task1 because the owners still use their old physical requests.

  Assert ordinary normal and CALLIE form data omit From, service-parent messages
  carry the exact reviewed From, and normal/CALLIE callback query keys remain
  `operation` versus `callieOperation`. Preserve full prefix/disclosure/message
  text and original provider/payload/operation identities.

  In the unit test, pass an extra runtime From through the CALLIE identity using
  a deliberate synthetic cast. The compatibility wrapper must still omit it,
  matching the old wrapper's closed wire shape. It resolves the original callback
  once and preserves response/rejection identity.

  Add/retain these concrete owner assertions:

  | Input | Normal sender | CALLIE worker |
  | --- | --- | --- |
  | Final authority/hold refusal | No fetch; cancelled/blocked original ownership retained. | No fetch; original intake blocked and claim retained. |
  | HTTP429 | Rejects; rate_limited dispatch; no second attempt. | Worker resolves through settlement; rate_limited acknowledgment and indeterminate original execution/intake. |
  | HTTP503 | Rejects; uncertain dispatch. | Worker resolves through unknown settlement; uncertain acknowledgment and indeterminate intake. |
  | Malformed201/missing SID/timeout | Rejects with existing owner error; uncertain original dispatch. | Existing catch/settle behavior, uncertain acknowledgment and indeterminate intake; no public thrown-error imitation. |
  | Accepted result then final-storage failure | Existing rejection/uncertain ownership; no second fetch. | Existing PG trigger case retains uncertain acknowledgment, indeterminate execution/intake and no replay. |

  Use actual PostgreSQL for storage failure. Reuse the CALLIE trigger/finally
  fixture pattern; any new normal trigger is UUID-named, organization-scoped,
  isolated to the owned test database and always removed in finally.
  Preserve service-parent second `beforeDispatch` and contact-touch checks:
  withdraw approval at the second check, require zero provider POST and permanent
  original ownership. A held/cancelled attempt never clears a touch/claim.

- [ ] **Step2: Run focused RED.**
  `node scripts/local-dev.mjs test src/services/sms-carrier-transport.test.ts src/services/twilio-dispatch-guard.test.ts src/services/callie-runtime.test.ts src/services/service-sms.test.ts`
  Require the new delegation assertions fail for the missing integration while
  legacy wire/settlement characterization passes. Preserve the actual failure.
- [ ] **Step3: Integrate without changing either business owner.**
  In `twilio-delivery.ts`, replace the physical request with `postSmsOnce`.
  Put its existing final-check block from the first `beforeDispatch` through
  service-parent/contact-touch checks inside the `current` resolver, in the
  same order and with the same conditions. Keep the entry hold, durable claim,
  both service checks, contact-touch dispatch-start and original parsing/catch
  logic. The resolver returns the current wire identity and optional From;
  the shared synchronous marker sets only `dispatched = true`.

  In `callie-ack-transport.ts`, preserve `CallieDispatchIdentity`'s export shape
  and `postCallieAcknowledgment` signature. Delegate to `postSmsOnce` with a
  resolver that awaits the existing callback once and explicitly projects its
  original seven fields, excluding From/unknown properties. Do not change
  `callie-runtime.ts`, grant claims, settlement, callback intake or status ranks.
- [ ] **Step4: Run focused GREEN and existing affected suites.**
  `node scripts/local-dev.mjs test src/services/sms-carrier-transport.test.ts src/services/twilio-dispatch-guard.test.ts src/services/callie-runtime.test.ts src/services/service-sms.test.ts src/services/sms-delivery.test.ts src/services/missed-call-care.test.ts src/services/missed-call-care-policy.test.ts src/services/providers.test.ts`
  Require zero new failures/skips. Existing CALLIE actual-PG concurrent workers,
  two-call allowance, cross-owner shared-cap and final-storage tests must run
  rather than skip as PGlite. Preserve late guard, recipient/purpose suppression,
  one-call grant and original-status evidence. Verify fixture/resource cleanup.
- [ ] **Step5: Review and commit the integrated change.** The reviewer checks
  both owner paths, exact wire fields, guard ordering and state differences.
  Fix required findings and rerun only affected tests. Commit
  `refactor: share the normal and CALLIE SMS handoff`. No private push/CI yet.

### Task 3: Verify the complete local candidate and prepare publication evidence

**Files:** No product change expected. Own external evidence under the implementation
artifact root, including final report, protected-input comparison and candidate pins.
**Consumes:** Task2's clean reviewed commit. **Produces:** exact local acceptance
or a specific HOLD, plus a concrete future private publication/CI packet.

- [ ] **Step1: Verify preservation against the approved plan commit.** Require
  only the planned source/test files changed. Compare all DB/schema/SQL, generated
  API, dependencies, scheduler, voice, UI/settings/provider-status, CI and runtime
  harness blobs to baseline. Keep all20 numbered SQL inputs and accepted runtime receipts
  unchanged. No new provider enum, setup badge, migration or retry/recovery path.
- [ ] **Step2: Run the current complete local release checks once.**
  `node scripts/local-dev.mjs test`
  `node scripts/local-dev.mjs typecheck`
  `node C:/Forge/artifacts/growthos-sms-carrier-implementation-20261016/run-builds.mjs`
  `node scripts/local-dev.mjs parity`
  Create that evidence-only build driver during execution, with this fixed
  algorithm (no new tracked runner/config):

  ```js
  import { spawnSync } from "node:child_process";
  import { pathToFileURL } from "node:url";
  const cwd = "C:/Forge/worktrees/growthos-comms-design-20261016";
  const { localEnvironment } = await import(pathToFileURL(`${cwd}/scripts/local-dev.mjs`).href);
  const cli = "C:/Users/diazd/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs";
  // Verify this existing launcher still reports11.3.0 before these builds.
  for (const target of ["@workspace/command-center", "@workspace/api-server"]) {
    const result = spawnSync(process.execPath, [cli, "--filter", target, "run", "build"],
      { cwd, env: localEnvironment(), windowsHide: true, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  ```

  The launcher path was verified at planning time; if absent/version-drifted,
  resolve the installed Node launcher using the existing local-dev command logic,
  not a shell fallback, package download or dependency/config change.
  Require actual exit0, actual suite/build results, no new baseline skips,
  exact candidate hashes and owned Docker/socket/session cleanup. Record actual
  counts; never repin b95's historical1140 or a237's historical CI totals as new.
  Existing unchanged 26-module native evidence remains historical and unchanged;
  do not rerun accepted runtime tasks or claim it certifies SMS functionality.
- [ ] **Step3: Complete secret/diff and independent whole-candidate review.**
  Run `git diff --check` and installed gitleaks over the actual candidate delta
  and external evidence, with redacted output. Resolve real findings; retain
  verified nonsecret fixture/hash classifications without suppressions. The local
  reviewer audits actual source/tests/results; GEEKOM cross-checks both send paths
  against the approved contract. Preserve their actual custody/scope limitations.
- [ ] **Step4: Freeze local acceptance and prepare the exact next source action.**
  Record branch/commit/tree, per-file hashes, real test/build/parity counts,
  original failures, cleanup and independent reviews externally. Do not amend
  application source merely to write pass labels. Prepare a private dependent
  draft-PR/CI proposal with exact current identity/repo/head/base, affected prior
  diagnostics and unknown-response reconciliation; do not publish an unreviewed
  commit, invent a PR number or silently substitute the old b95-only proposal.
  Source push/PR/CI need the applicable separate decision on the concrete result.

The resulting status before remote CI is `LOCAL_C1_IMPLEMENTED_REVIEWED_CI_HOLD`.
Full source acceptance still needs actual matching CI at the eventual published
candidate. Provider/account/handset and contractor acceptance remain separate.
Local success never marks Telnyx or voice implemented or any company case passed.

## Plan self-review and handoff

Before presenting this plan, ROOT checks spec coverage, signatures across tasks,
every Review Focus case, task scope and proportion. Independent/peer feedback
may identify a concrete gap; fix it without broadening C1 or changing the approved
spec. Retain exact final plan hashes and the actual review scope.

Human review now concerns this written plan and the recommended Native method.
No implementation begins merely because the earlier design was approved. After
plan/method approval, invoke `superpowers:executing-plans`, execute these tasks
sequentially and keep the disjoint peer/reviewer coordination active. C2/C3,
runtime D02/D03, compatible recovery, full G04/G06 and both company/provider/device/
workday/cutover gates remain open; all33 actual cases remain NOT_RUN.
