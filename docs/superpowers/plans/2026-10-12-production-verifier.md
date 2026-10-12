# Production Verification Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution;
> use one fresh independent whole-branch review at completion. Track each step.

**Goal:** Implement local proof of the recorded legacy privilege model, a fixed
read observer and an import-safe upgrade/rollback contract for later hosted use.

**Architecture:** Extend the existing production75 mechanism through new modules;
the PR44 mechanism, application source and19SQL pins remain unchanged. Use only
owned disposable PostgreSQL16 and supplied clients. Transport, paid-copy admission
and actual provider profile/extension evidence remain separate.

**Tech Stack:** Node22/24, Vitest4, existing pg/Docker/WSL helpers, PostgreSQL16.

**Spec:** C:\Forge\artifacts\growthos-release-integration-20261012\next-legacy-role-oracle-design.md;
Adam's approved three-step local verifier/observer/runner direction and continuation.

## Global constraints

- Base/candidate8df64dc72009832f93b2b491031acd1bb2afb903 (PR44) stays fixed.
- Preserve source142, all19SQL pins, historical receipts and unrelated edits.
- No real account/provider/credentials/production/copy purchase or app start.
- PUBLIC TEMP and callable functions remain measured capabilities, never masked.
- Local stubs do not prove actual provider extension binaries or role settings.
- Hosted execution is refused without independently reviewed capability scope,
  exact expected vectors, one-attempt custody and later target/admission.

## Review focus

- Reject arbitrary SELECT and function calls before dispatch, not just SQL writes.
- Check exact parameters/identity, size/deadline bounds and late responses.
- Keep role INHERIT distinct from membership INHERIT/SET and Writer identity.
- Preserve full provider/global/default/PUBLIC vectors, including unknown extras.
- Owned native resources must close on every failure; no original fixture rewrite.

## Task1: Fixed query observer

**Files:** scripts/production75-observer.mjs and .test.mjs.
**Interfaces:** createProduction75Observer({client,principals,catalog75,catalog142,
limits,now}) -> {query}; captureProduction75Extras(observer) -> {roles,
roleSettings,extensions,extensionObjects,databases}. Supplied clients own sockets
and transactions. Exact known metadata and trusted canonical projection queries
are accepted; others fail before dispatch. Errors expose safe codes only.

- [x] Write regressions for forbidden SELECT/function/write/multiple statements,
      unexpected parameters, malicious catalog, bounds/deadline/error redaction.
- [x] Observe RED; implement the minimal registry, identity and bounded wrapper.
- [x] Run GREEN and integrate existing catalog/policy captures through it.

## Task2: Actual legacy model and native oracle

**Files:** scripts/production75-legacy-model.mjs, .test.mjs;
scripts/production75-legacy-local.mjs and .test.mjs.
**Interfaces:** legacyModel() returns immutable nonsecret role/edge/default/database
model; assertLegacyReaderCapabilities(policy,{readerLogin,readerRole,writerRole})
returns measured scope and never claims zero-DDL globally. Native runner consumes
existing source/catalogs and creates one exact-owned container, no live URL.

- [x] RED role/edge/default-model and dangerous-membership capability tests.
- [x] Implement recorded23role/12edge basis, proposed copy-reader delta and
      native fixture wiring; report opaque settings and provider stubs separately.
- [x] Run actual75/95/142 oracle and rollback/commit/fresh Reader on both layouts;
      measure denied persistent application writes/DDL and maintenance TEMP truth.
- [x] Record safe hashes/counts and require all owned sockets/container cleanup.

## Task3: Upgrade/rollback contract and source acceptance

**Files:** scripts/production75-verification.mjs and .test.mjs;
reports/production-verifier-2026-10-12.md and scoped receipts.
**Interfaces:** verifyProduction75Evidence({baseline,observed,expectedExtra,
capabilityReview}) verifies full extra vectors; runProduction75Verification with
supplied Writer/Reader, pinned plan and durable reserve/persist callbacks invokes
the existing mechanism and refuses replay or unreviewed capability scope.

- [x] RED missing/unreviewed scope, changed extras/other DBs, wrong Reader,
      duplicate reservation and unknown COMMIT cases; GREEN minimal contract.
- [x] Verify focused and full scripts tests, types, exact unchanged app/SQL source,
      secret scan and independent whole-branch review.
- [ ] Publish separate reviewed source PR and exact CI; retain a concrete list of
      provider/native/cost/admission items still required before hosted execution.

Execution method is inline root implementation. The user authorized continuation
of the presented local steps; routine development requires no repeated question.
