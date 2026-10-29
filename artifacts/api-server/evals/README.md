# MogulForge Evidence Intelligence Proof Lab

> **Current context — October 29, 2026:** The evidence trust-gate lab remains one part of the current product. Its synthetic results are not expert accuracy, provider activation or whole-product acceptance. Use an isolated test database for verification.
> See [current build](../../../CURRENT-BUILD.md) and [documentation map](../../../docs/DOCUMENTATION-MAP.md).


This is the release gate for the Evidence Intelligence workflow. The cases are synthetic and contain no customer data.

## Non-negotiable gates

- Citation validity: **100%** of persisted citations resolve to an artifact in the current tenant and run manifest.
- Unsupported citations: **0** are accepted.
- Consent: **0** unapproved artifacts are sent to a model.
- Human control: **0** certificates are issued while any observation remains an AI draft, and at least one observation must be human-verified.
- Immutability: every artifact and certificate carries a SHA-256 content digest.

## Quality targets requiring expert labels

- Observation agreement with contractor reviewers: target at least **95%**.
- Critical omission rate: target at most **5%**.

Those quality targets are provisional until a representative, deidentified beta set has been labeled by qualified contractors. They must not be presented as achieved before an eval run proves them.

The first live synthetic verification is recorded in `results/2026-08-06-local.json`. It proves the technical trust gates and end-to-end workflow only; it is not a contractor accuracy benchmark.

Run the deterministic trust-gate suite with:

`pnpm --filter @workspace/api-server exec vitest run src/services/evidence-redaction.test.ts src/services/evidence-intelligence.test.ts`
