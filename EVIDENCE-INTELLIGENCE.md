# MogulForge Evidence Intelligence

Evidence Intelligence is a standalone GrowthOS capability in the canonical
`diazdestination/mogulforge-growthos` product.

## Product promise

A contractor can create an evidence case, add explicitly authorized field
material, generate a conservative citation-locked AI draft, verify or reject
every observation, and issue a versioned Loss Evidence Certificate. AI never
issues the certificate.

## Trust architecture

1. Every case, artifact, run, observation, and certificate is scoped by
   `organizationId`.
2. Raw evidence is stored in Postgres for the private beta and carries a
   SHA-256 digest. Duplicate bytes in the same case are rejected.
3. An artifact is ineligible for model input until an authenticated operator
   explicitly approves it for AI use.
4. Plain-text evidence is redacted locally for common email, phone, SSN, and
   policy-like identifiers before model input.
5. The model sees run-local aliases (`E1`, `E2`, and so on), not database IDs.
   The application rejects the entire draft if any citation does not resolve
   through that run's tenant-owned allowlist.
6. OpenAI traces exclude sensitive payload data, response storage is disabled,
   and each organization receives a stable privacy-preserving safety identifier.
7. Every model finding begins as `ai_draft`. All observations must be reviewed
   and at least one must be human-verified before issuance is possible.
8. Each analysis run freezes an ordered evidence manifest with run-local
   aliases, source metadata, approval times, and a deterministic SHA-256
   manifest digest.
9. Each certificate receives a deterministic integrity package that binds the
   content hash, frozen manifest digest, prompt/model version, and human review
   ledger. Issuance recomputes that package after the final review decisions.
10. Every issue, review, upload, run, and failure transition is audit logged.
11. An issued, integrity-bound certificate may be compiled into a
    constraint-carrying route packet. The packet carries immutable target
    preconditions, postconditions, adapter fingerprint, capability requirements,
    side-effect budget, and a deterministic idempotency key. Compilation does
    not contact any target system.
12. A native MogulForge estimate can be compiled into a canonical claim graph
    with node-level source paths, transformation rules, financial-conservation
    checks, and a graph digest. A graph with failed invariants is retained for
    diagnosis but blocked from target compilation.
13. Source-linked weather, property, inspection, photo, or document readings
    may compile into a deterministic loss-corroboration assessment. Its
    versioned source manifest and result are hashed, and its spatial,
    temporal, directional, quality, coverage, missingness, and contradiction
    components remain visible for contractor review. It never invents a source
    or decides coverage, causation, safety, damages, or eligibility.

## OpenAI implementation

- SDK: `@openai/agents`
- Default model: `gpt-5.6-sol`
- Override: `OPENAI_EVIDENCE_MODEL`
- Structured output: Zod-validated findings, citations, conflicts, gaps,
  limitations, and next steps
- Reasoning effort: `high`
- Response storage: disabled
- Sensitive trace data: disabled
- Prompt version: `evidence-intelligence-v1`

The Evidence Analyst treats artifact contents as untrusted. Instructions found
inside evidence are explicitly ignored. It is required to state uncertainty,
preserve conflicts, surface missing evidence, and avoid coverage, engineering,
legal, code, scope, or causation claims that are not supported by the supplied
source material.

## API surface

- `GET|POST /api/v1/bie/claims`
- `GET /api/v1/bie/claims/:id`
- `POST /api/v1/bie/claims/:id/artifacts`
- `GET /api/v1/bie/claims/:id/artifacts/:artifactId/content`
- `POST /api/v1/bie/claims/:id/analyze`
- `POST /api/v1/bie/claims/:id/observations/:observationId/review`
- `POST /api/v1/bie/claims/:id/certificates/:certificateId/issue`
- `GET /api/v1/bie/claims/:id/graphs`
- `POST /api/v1/bie/claims/:id/graphs/native-estimate`
- `GET /api/v1/bie/claims/:id/graphs/:graphId/targets/:target`
- `GET|POST /api/v1/bie/claims/:id/corroborations`
- `POST /api/v1/bie/claims/:id/corroborations/:corroborationId/review`
- `GET|POST /api/v1/bie/claims/:id/routes`

Read operations require `crm.read`. Case creation, evidence intake, analysis,
review, and issuance require `crm.write`. The route-inventory test enforces the
contract.

## Proof Lab

Synthetic adversarial cases live in `artifacts/api-server/evals/cases.jsonl`.
The deterministic release gates require:

- 100% of accepted citations resolve to the current run's artifact allowlist
- 0 unsupported or cross-tenant citations accepted
- 0 unapproved artifacts sent to the model
- 0 AI-draft observations allowed through the issuance gate
- at least 1 human-verified observation before issuance
- identical canonical inputs always produce identical manifest, certificate,
  and route-packet hashes
- no route packet compiles from a non-issued or integrity-mismatched certificate
- an indeterminate external write may only be reconciled, never blindly retried
- a declared estimate line total, subtotal, or grand total that disagrees with
  the canonical computation blocks target compilation
- loss corroboration is replayable from a valid canonical graph and source
  artifact digests; source ordering cannot change its result
- spatial, directional, temporal, and source-data gaps remain explicit in the
  result and lower the corresponding confidence rather than being silently
  filled by an AI
- a route that opts into loss corroboration requires a human-verified assessment
  whose assessment hash still matches the compiled packet

The first live synthetic verification record is committed at
`artifacts/api-server/evals/results/2026-08-06-local.json`.

Quality targets such as 95% contractor agreement and at most 5% critical
omissions remain provisional. They are not achieved claims until qualified
contractors label a representative, deidentified beta set and the Proof Lab
measures it.

## Local operation

Keep the OpenAI key only in an ignored `.env.local` or an environment secret.
Never commit it.

```powershell
docker compose --env-file .env --env-file .env.local up -d --build app
```

Then open `http://localhost:8080/evidence` while signed in.

## Verification snapshot — 2026-08-06

- Current workspace typecheck and production UI/API bundles: passed
- Current Docker image rebuild and local service restart: passed
- Current local app: serves the MogulForge GrowthOS bundle at `:8080`; the
  protected Evidence API returns the expected unauthenticated `401`
- Current Command Center suite: 190/190 passed
- Current Claim Kernel, canonical graph, loss corroboration, Evidence
  Intelligence, redaction, and route-inventory suites: 35/35 passed
- Current local database schema: frozen manifest/integrity columns, canonical
  graph, loss-corroboration, route-packet/corroboration binding, and
  execution-receipt tables confirmed

Older evidence-flow test records remain useful historical evidence, but they
are not a substitute for rerunning the relevant check after a later change.

## Not deployed

This checkpoint verifies the local Docker product. It does not claim that the
feature has been deployed to Fly.io, enabled on `mogulforge.ai`, or evaluated
on beta customer data. It also does not yet include a live carrier adapter,
credential vault, Cloudflare queue, Fly executor, Wolfram kernel, or target-side
browser submission. Those are separate, explicitly gated next stages.
