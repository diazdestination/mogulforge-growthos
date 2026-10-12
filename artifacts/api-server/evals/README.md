# MogulForge Evidence Intelligence Proof Lab

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

The contractor eval harness that measures them lives in `contractor/`. See [contractor/README.md](contractor/README.md) for details. It contains:

- 26 evidence cases, two of them built from owner-supplied invoices that were redacted on 2026-10-11;
- 14 CRM-assistant cases;
- a judge-calibration set;
- a label export/import workflow;
- an opt-in live runner and offline replay.

As of 2026-10-11 there are **0 contractor-verified cases**, so the quality gate reports `not-measurable` and contractor agreement has not been measured. Agreement is only ever reported over contractor-verified cases (at least 20 are required), with a judge whose agreement with human verdicts is at least 0.9.

`pnpm --filter @workspace/api-server run eval:contractor -- --check` validates the dataset offline.

The first live synthetic verification is recorded in `results/2026-08-06-local.json`. It proves the technical trust gates and end-to-end workflow only; it is not a contractor accuracy benchmark.

Run the deterministic trust-gate suite with:

`pnpm --filter @workspace/api-server exec vitest run src/services/evidence-redaction.test.ts src/services/evidence-intelligence.test.ts`
