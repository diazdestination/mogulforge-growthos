# MogulForge GrowthOS — Resume Pack

Read this file before resuming GrowthOS work. It is the product-owned handoff
for future sessions and agents: no implementation decision below depends on
remembering a chat, a different repository, or a global machine-state file.

## Canonical identity

- **Product repository:** `diazdestination/mogulforge-growthos` (private)
- **Local checkout:** `C:\Users\diazd\dev\projects\mogulforge`
- **Working branch:** `agent/mogulforge-growthos-recovery`
- **Never use for product work:** `MogulForge-crm-template-` or the separate
  MogulForge marketing-site repository.
- **Product architecture:** [GROWTHOS-ARCHITECTURE.md](GROWTHOS-ARCHITECTURE.md)
- **Evidence workflow contract:** [EVIDENCE-INTELLIGENCE.md](EVIDENCE-INTELLIGENCE.md)

This document uses **MogulForge GrowthOS** terminology only. The product has no
dependency on or branding relationship with any separate local operations
project.

## Verified baseline — 2026-08-06

The following local commits are the implementation baseline:

| Commit | Capability |
| --- | --- |
| `e7c5e87` | Evidence manifests, certificate integrity packages, canonical native-estimate claim graphs, guarded route packets, and execution-receipt foundations. |
| `82270ef` | Deterministic loss corroboration, source-manifest/result hashes, contractor review, and optional corroboration route preconditions. |

At this checkpoint, `main` is unchanged. These commits are intentionally local
on the recovery branch until a deliberate push or merge decision is made.

## Zero-memory local re-entry

Run these commands from PowerShell. They are read/verify/build operations and
do not deploy, push, merge, or contact a third-party target.

```powershell
Set-Location C:\Users\diazd\dev\projects\mogulforge
git switch agent/mogulforge-growthos-recovery
git status --short --branch

docker compose --env-file .env --env-file .env.local up -d --build

$env:DATABASE_URL = 'postgresql://postgres:mogulforge@localhost:5433/mogulforge'
pnpm --filter @workspace/db run push
pnpm --filter @workspace/api-server exec vitest run src/services/claim-kernel.test.ts src/services/loss-corroboration.test.ts src/services/loss-corroborations.test.ts src/services/claim-compilation.test.ts src/services/claim-execution.test.ts src/services/claim-graphs.test.ts src/services/evidence-intelligence.test.ts src/services/evidence-redaction.test.ts src/routes/v1/route-inventory.test.ts
pnpm --filter @workspace/command-center test
pnpm build
```

Expected local probes after the app starts:

```powershell
Invoke-WebRequest http://localhost:8080/evidence -SkipHttpErrorCheck
Invoke-WebRequest http://localhost:8080/api/v1/bie/claims -SkipHttpErrorCheck
```

The Evidence page should return `200`; the unauthenticated API request should
return `401`. That is the correct protected-route behavior, not an error.

## Implemented seams — do not redesign these

| Need | Existing seam | Required invariant |
| --- | --- | --- |
| Stable claim/evidence bytes | `artifacts/api-server/src/services/claim-kernel.ts` | Canonical JSON and SHA-256 bind all material inputs. |
| Native-estimate compilation | `claim-compilation.ts` and `claim-graphs.ts` | Failed financial invariants are stored for diagnosis but blocked from target compilation. |
| Loss corroboration math | `loss-corroboration.ts` | No model call; every time, distance, direction, coverage, quality, and missing-data factor is exposed. |
| Persisted corroboration | `loss-corroborations.ts` | Source artifact digests are read from the case-owned database record, never supplied as trusted client data. |
| Issued evidence route handoff | `claim-execution.ts` | One write maximum, one attempt maximum, immutable packet, and no retry from an indeterminate write. |
| Human controls/UI | `artifacts/command-center/src/pages/evidence-intelligence.tsx` | AI drafts and calculated assessments remain reviewable; human decisions are audited. |

## Drop-in plan: live evidence-source adapters

This is the next code-only implementation phase once a source provider is
selected. Do not call an external provider directly from the UI and do not let
an AI summarize an unpreserved source response.

1. Add one provider-specific adapter under
   `artifacts/api-server/src/services/loss-source-adapters/`.
2. Capture the provider response as a case-owned evidence artifact first,
   including provider name, version, retrieval timestamp, raw payload digest,
   and any applicable license/coverage metadata.
3. Normalize that captured artifact into the existing
   `CompileLossCorroborationInput.sources` structure. The server will attach
   the authoritative artifact SHA-256 itself.
4. Add deterministic fixtures for: an event near the property, an
   out-of-radius event, no event, incomplete coverage, a provider outage, and
   contradictory observations from independent sources.
5. Add adapter tests plus a service test proving that source ordering and a
   provider response reformat do not change a properly normalized result.
6. Show provider/source version, coverage window, raw-artifact link, and all
   missing fields in the contractor UI before allowing verification.

### Adapter acceptance contract

An adapter is ready only when it can populate these already-supported facts:

```ts
{
  sourceArtifactId: 'case-owned-artifact-id',
  sourceKind: 'weather' | 'property' | 'inspection' | 'photo' | 'document' | 'other',
  provider: 'provider name',
  providerVersion: 'provider dataset or adapter version',
  retrievedAt: 'ISO-8601 timestamp',
  qualityScore: 0,       // documented provider/source quality, 0–100
  coverageScore: 0,      // documented temporal/spatial coverage, 0–100
  missingFields: [],     // never silently omit unavailable data
  temporalCoverage: { startsAt: 'ISO', endsAt: 'ISO' },
  observations: [{
    id: 'provider-stable-observation-id',
    signal: 'supporting' | 'contradicting' | 'neutral',
    phenomenon: 'hail/wind/etc.',
    observedAt: 'ISO-8601 timestamp',
    magnitudeScore: 0,   // normalized with a versioned, tested rule
    coordinates: { latitude: 0, longitude: 0 } | null,
    directionDegrees: 0 | null,
  }],
}
```

Provider credentials, raw responses, and usage spend must remain outside git,
logs, frontend bundles, and ordinary database JSON fields.

## Drop-in plan: authorized target executors

The current product compiles and preflights a route packet but does not touch a
carrier, browser, or external target. When a specific target is authorized:

1. Build a target-specific adapter in an isolated executor process—not in the
   web request handler.
2. Store credentials in an approved tenant-scoped secret manager or short-lived
   provider token flow; never place them in a route packet, audit record, or
   browser log.
3. Call `preflightClaimRoutePacket` immediately before any target interaction.
4. Call `prepareClaimRouteExecution` exactly once after a successful preflight.
5. Capture target-side confirmation evidence, hash it, and transition the
   receipt only through the guarded execution-state path.
6. Treat timeouts or unknown outcomes as `indeterminate`; reconcile from target
   evidence before any later action. Never add a blind retry button.

A target adapter is not ready for a live write until it has sandbox fixtures,
an adapter fingerprint, postcondition assertions, a failure/reconciliation
test, rate limits, an explicit side-effect budget, and a human approval gate.

## Accounts and approvals that cannot be pre-created in code

These items are deliberately left as explicit gates, so no future agent should
guess or simulate them:

- A licensed weather/property/imagery provider choice and its credentials.
- Permission and test fixtures for each external claim/target platform.
- A production secret store and tenant-scoped credential policy.
- Approval to create/charge a hosting database, deploy publicly, add DNS,
  enable billing, push the branch, or merge it into `main`.
- Production acceptance data that contractors are authorized to use.

## Deployment handoff

Deployment mechanics already live in these product-owned documents:

- [BETA-LAUNCH.md](BETA-LAUNCH.md) — Fly.io and PowerShell launch steps.
- [DEPLOY.md](DEPLOY.md) — container/self-hosting model and security notes.
- [.env.example](.env.example) — safe variable names only; never put values in
  source control.

Before any public launch, re-check account state live, use a stable
`SESSION_SECRET`, enable managed database backups, verify HTTPS and signup,
and test the production API with a real authorized account. A local Docker
success is necessary evidence, not proof of a public deployment.

## Beta success and per-user Gmail handoff — 2026-08-13

- [BETA-SUCCESS-PLAN.md](BETA-SUCCESS-PLAN.md) is the current product,
  founding-cohort, metrics, reliability, and launch-gate plan.
- [GOOGLE-OAUTH-SETUP.md](GOOGLE-OAUTH-SETUP.md) is the operator runbook for
  the user-owned Gmail sending model.
- The recovery branch now contains a per-user, tenant-scoped Gmail OAuth seam:
  state + PKCE, encrypted refresh tokens, status/connect/callback/disconnect
  endpoints, a Settings connection surface, revocation, and BIE sending as the
  executing user. It does not contain Google credentials.
- API and command-center typechecks pass; the pure credential-boundary tests
  pass; the command-center suite passes 190/190. A real OAuth round trip and
  DB-backed two-tenant/two-sender suite remain required before this is called
  beta-ready. Docker/Postgres was stopped during this checkpoint.

## Zapier Connected Apps — 2026-10-29

- [ZAPIER-CONNECTED-APPS.md](ZAPIER-CONNECTED-APPS.md) is the contract for the
  specialist capability layer that runs through each contractor's own Zapier
  MCP server (SCOUT reviews/leads, APPT calendar, INVO accounting, CALLIE
  calls/text-back, SCHED day sheets).
- Branch `feat/zapier-connected-apps` adds four tables (reviewed preview
  `0020_zapier-connected-apps.sql`, source totals 146), the capability
  registry, the execution ledger on top of `runDurableAction`, policy/budget
  gates, the `zapier-connected-apps` scheduler stage, routes with inventory
  entries, and the Settings → Connections card with the Zapier embed.
- Deterministic tests pass on PGlite (14 ledger tests, 10 contract tests) and
  both typechecks pass. No live Zapier round trip has been run; it requires
  `ZAPIER_MCP_EMBED_ID`/`ZAPIER_MCP_EMBED_SECRET` and a contractor account.

## Completion discipline

When any future phase finishes:

1. Update this resume pack and `GROWTHOS-ARCHITECTURE.md` with what is truly
   implemented versus planned.
2. Add deterministic tests and a verification command before claiming success.
3. Commit to the recovery branch first; do not merge or deploy by implication.
4. Keep product state in this repository and its documentation.
