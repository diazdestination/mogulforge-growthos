# GrowthOS Release Integration Implementation Plan

> For agentic workers: use superpowers:executing-plans for root integration and
> superpowers:requesting-code-review for independent gates. Root implements the
> merge tasks; reviewers do not modify source. Steps use checkbox tracking.

**Goal:** Produce one verified GrowthOS candidate containing the five prepared
launch changes and the reviewed recovery mechanisms, then prepare the next
production upgrade boundary without executing hosted changes.

**Architecture:** Preserve original commit history in the existing isolated
workspace. Merge shared API specifications semantically and regenerate derived
clients. Exercise existing native PostgreSQL and Docker/browser entry points.

**Tech Stack:** Node22/24, pnpm11.3.0, TypeScript, PostgreSQL16, Vite/React,
OpenAPI/Orval, Docker via the owned WSL session, GitHub CI.

**Spec:** reports/release-integration-contract-2026-10-12.md.

## Global constraints

- GitHub main7091af816715cfd437925eb0af82fb47d3411e34 is canonical.
- Source remains142 tables and every existing reviewed SQL file is unchanged.
- Existing dirty state and historical receipts remain preserved.
- Only synthetic local tests; no paid/hosted/provider/customer operation.
- Source tests, native recovery and production acceptance remain separate proofs.

## Review focus

- Issued invoice equipment must remain frozen after assets or draft selections change.
- Import must preserve tenant/contact restrictions and create no acquisition lead.
- Preview must roll back every write and remain bounded on large/error CSV input.
- Generated clients must retain both invoice and import additions after spec conflicts.
- Combined test setup must exclude provider credentials and close owned Docker/WSL resources.

## Task 1: Review and integrate selected heads

**Files:** Selected source paths from PR39/40/41/42/43; generated files in
lib/api-client-react and lib/api-zod; reports/release-integration-2026-10-12.md.

- [x] Review exact42/43 source boundaries and39/40/41 integration scope independently.
- [x] Merge the five pinned heads into agent/growthos-release-integration-20261012.
- [x] Reconcile OpenAPI fields and regenerate with the repository's pinned command.
- [x] Verify142-table/schema and19 SQL-source hashes unchanged from87adc3e.

## Task 2: Combined acceptance and publication

**Interfaces:** node scripts/local-dev.mjs test|typecheck|parity; package scripts
for API/Command Center builds and generated-client validation.

- [x] Run full native PostgreSQL tests and website adapter; retain exact summaries.
- [x] Run typecheck, both builds and Docker parity with owned cleanup.
- [x] Inspect supported fictional invoice/import/UI journeys without recordings.
- [x] Scan intended changes with C:\Forge\bin\forge-secrets.ps1 and redacted output.
- [x] Obtain combined-source independent review and address material findings.
- [ ] Commit only intended integration evidence/state, push one exact candidate and
      open a draft PR to main; attach it and verify exact-head CI.

## Task 3: Production upgrade preparation

**Files:** C:\Forge\artifacts\growthos-release-integration-20261012\upgrade-next-gate.md.

- [x] Map the accepted75 core and legacyV1 restore transport to a bounded rehearsal
      contract with full source-data/ACL preservation and a distinct Reader.
- [x] Record required native/copy/rotation proof, exact target/source constraints,
      one-attempt/unknown-COMMIT rules and owned cleanup requirements.
- [ ] Prepare the next concrete release packet only after review; keep all paid,
      migration/cutover and provider-generation authority false until admitted.

The implementation method follows the existing coordinated Forge ownership and
Adam's authorization to continue scoped source work. No additional confirmation
is required for these reversible local integration and review tasks.
