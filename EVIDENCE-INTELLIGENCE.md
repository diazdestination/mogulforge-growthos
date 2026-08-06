# MogulForge Evidence Intelligence

Evidence Intelligence is a standalone GrowthOS capability in the canonical
`diazdestination/mogulforge-crm` product. It has no Jarvis dependency and no
shared runtime, storage, or naming relationship with Jarvis.

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
8. Every issue, review, upload, run, and failure transition is audit logged.

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

- Production UI and API bundles: passed
- Docker image build and health endpoint: passed
- Command Center suite: 190/190 passed
- Evidence and route-permission suite: 12/12 passed
- Desktop contractor flow: passed
- 390x844 mobile rendering: passed
- Live GPT-5.6 Sol structured run: passed
- Local redaction of synthetic email and phone: passed
- Embedded prompt-injection instruction ignored: passed
- Three observations human-verified before issuance: passed
- Issued certificate content hash length: 64 characters
- Audit events recorded for the live synthetic flow: 7

The full API suite is now portable and green in the configured self-hosted test
environment: 936 passed and 15 intentionally skipped. Replit-only Object
Storage was replaced by signed Postgres-backed uploads by default, test runtime
defaults are explicit, and the legacy email-provider expectation was corrected.

## Not deployed

This checkpoint verifies the local Docker product. It does not claim that the
feature has been deployed to Fly.io, enabled on `mogulforge.ai`, or evaluated
on beta customer data.
