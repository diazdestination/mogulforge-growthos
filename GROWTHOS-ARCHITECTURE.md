# MogulForge GrowthOS Architecture

This document is the implementation contract for the canonical
`diazdestination/mogulforge-growthos` product. It separates working local software
from planned infrastructure so product messaging, demos, and patent materials
never describe a roadmap component as shipped.

## Product boundary

MogulForge GrowthOS is an evidence-first operating layer for contractor
revenue, claims, and customer workflows. The system of record is the
tenant-scoped MogulForge API and PostgreSQL database. AI assists only inside
explicitly bounded workflows; authorized humans retain issuance and write
approval authority.

## Current Claim Kernel foundation

The local recovery branch implements these deterministic controls:

1. Evidence artifacts have SHA-256 digests and explicit AI-use approval.
2. An analysis run freezes an ordered, alias-scoped Evidence Manifest.
3. Citations are validated only against the frozen, tenant-owned alias set.
4. A Loss Evidence Certificate binds its content, source manifest, prompt/model
   version, and human-review ledger into a canonical integrity package.
5. An issued certificate may compile into a constraint-carrying Route Packet.
6. A route packet includes an idempotency key, one-attempt write budget,
   target adapter fingerprint, preconditions, postconditions, and capability
   requirements.
7. An indeterminate external-write state cannot retry until reconciliation.
8. Native MogulForge estimates compile into canonical claim graphs with
   node-level source paths, transformation rules, financial-conservation
   invariants, and deterministic graph digests.
9. Source-linked loss observations compile into a hash-bound corroboration
   assessment that exposes spatial, temporal, directional, source-quality,
   coverage, missingness, and contradiction components for human review.

The route compiler does **not** execute a browser action, contact a carrier,
or hold credentials. That separation is intentional.

## Authoritative boundaries

```text
Contractor UI
    -> MogulForge API / PostgreSQL (authoritative cases, certificates, route packets)
    -> Object storage (large artifacts, immutable receipt evidence; planned)
    -> Private claim kernel (local normalization and deterministic validation)
    -> Isolated executor (target interaction only after preflight; planned)
```

The API/database owns business state. Queue transport, edge services, and
browser workers may not become a competing source of truth.

## User-owned communication identity

GrowthOS does not use a platform owner's personal mailbox as a shared sending
provider. Each member may authorize their own Gmail account with MogulForge's
central Google OAuth application and the narrow `gmail.send` scope. Refresh
tokens are encrypted with AES-256-GCM and bound to the exact organization and
user; OAuth state is short-lived, single-use, and paired with PKCE. Disconnect
revokes Google access where available and always removes the local credential.

For approval-first BIE email, the executing user is the sender. A missing,
revoked, or failing connection blocks visibly and never falls back to another
person's mailbox. Unattended organization-level campaigns require a separately
selected organization sender and policy; that behavior is not yet implemented.

## Permissioned Google Business Graph

The Google connection is a modular business-data surface, not a Gmail-only
special case or blanket “super connector.” Users authorize capabilities
incrementally and may keep any module off. Source content is normalized into
provenance-carrying Business Graph facts before BIE uses it; connected content
is untrusted data and can never grant an agent instructions or tool authority.
The module/scoping and continuous-scouting contract is maintained in
[GOOGLE-BUSINESS-GRAPH.md](GOOGLE-BUSINESS-GRAPH.md).

## Delivery sequence

### Stage 1 — evidence integrity and controlled handoff

Implemented locally: manifest freezing, canonical hashing, certificate binding,
route compilation, review/issuance gates, deterministic tests, and audit events.

### Stage 2 — provenance-preserving estimate compilation

The native-estimate adapter, typed canonical claim graph, node-to-source mapping
ledger, financial-conservation checks, versioned rule pack, and two
vendor-neutral target profiles are implemented locally. Every target profile is
replayable from a stored graph digest. Next: add unit dimensions, import
adapters for external estimate artifacts, and real target adapters only after
their respective platform agreements and test fixtures are available.

### Stage 3 — deterministic loss corroboration

Implemented locally: versioned, source-artifact-linked observations; explicit
quality, coverage, and missing-field declarations; time-window relevance;
great-circle distance; roof-facet directional alignment; cross-source
contradiction detection; decomposable confidence; source-manifest and result
hashes; and immutable contractor verification/rejection. A verified assessment
may be bound as an optional precondition on a route packet. It does not call a
weather service, infer missing evidence, or determine coverage, causation,
safety, or damages. Provider adapters remain a separate future integration.

### Stage 4 — proof-obligated target execution

Add a tenant-scoped credential vault, registered and fingerprinted target
adapters, executor-only short-lived capabilities, target-side postcondition
evidence, immutable receipts, and reconciliation for unknown-write outcomes.

### Stage 5 — production deployment

Deploy only after approval: public edge/DNS, artifact object storage, queue
transport, private compute, managed PostgreSQL, key management, monitoring,
backups, incident response, and beta acceptance tests. No provider account,
credential, spend, or live target action is implied by this repository.
The exact no-memory implementation and verification handoff is maintained in
[GROWTHOS-RESUME.md](GROWTHOS-RESUME.md).

## Retrieval layer and customer memory (pgvector)

Implemented on `agent/growthos-pgvector-memory-20261011` (local only):

- **Tables:** `retrieval_chunks` (derived, rebuildable: redacted text, SHA-256,
  embedding model, `vector(1536)`, HNSW cosine index; tenant-composite contact FK;
  CHECKs tie `scope=knowledge` to no contact and `scope=customer` to one) and
  `customer_memories` (staff-authored facts/preferences/equipment/access notes
  with verified same-customer provenance; retiring keeps the row).
- **Providers** (`services/embeddings.ts`): explicit `EMBEDDINGS_PROVIDER`
  opt-in. `openai` = `text-embedding-3-small` (or `OPENAI_EMBEDDING_MODEL`) at
  1536 dims via raw fetch, batched, 15 s timeout, no text in errors. `hash` =
  deterministic lexical hashing, labelled `lexical_hash`, never "semantic".
  Unset = keyword matching only.
- **Index** (`services/retrieval-index.ts`): text is redacted with the Evidence
  Intelligence redaction helper (email/phone/SSN/policy ids) and built without
  contact name/email/phone/address before storage or embedding. Only changed
  content hashes are re-embedded. Knowledge create/update re-index best-effort;
  deactivate/delete and memory retirement delete chunks in the same transaction.
- **Coherence and concurrency:** customer history uses the customer-workspace
  canonical graph (`customerRecordGraph`, `coherentCustomerActivity`), so a
  record whose parents disagree about the customer is in nobody's history and
  cannot be cited as memory provenance. Embedding runs outside transactions;
  writes then take the source lock (knowledge row `FOR UPDATE`, or the
  per-customer advisory lock that memory retirement also takes), re-read the
  authoritative source and only store vectors whose content hash is current.
- **Reads** (`services/retrieval.ts`): exact cosine scan over the tenant's (and,
  for customers, the contact's) own rows, merged with the deterministic keyword
  rule; falls back to keyword-only without a provider or when the query embed
  fails. Every candidate is re-validated against the current source and the
  caller's visibility (`resolveCustomerReadAccess`: stored AND effective role,
  so API-key caps apply; invoices and `invoice_event` activity need
  `invoices.read`), and returned text comes from the current source. The shared
  index is maintained independently of the caller. The concierge still answers
  only by quoting a stored entry.
- **Surfaces:** `GET/POST /contacts/:id/memories`, `POST .../:memoryId/retire`,
  `GET /contacts/:id/context-search`, owner/admin `POST /retrieval/reindex`, the
  read-only assistant tool `search_customer_history`, and a Customer memory panel
  in the customer workspace.
- **Open gates:** pgvector availability/enablement on hosted Postgres, embedding
  spend approval, and backfill on real data. Review-only SQL:
  `reports/staging-schema-preview-2026-10-01/0019_pgvector-retrieval.sql`.

## Non-negotiable safety rules

- No raw tenant artifact is used by AI without explicit authorization.
- No AI draft is an issued certificate.
- No certificate reaches an execution path without a current integrity hash and
  completed human review.
- No target write is retried when a prior write may have occurred.
- No implementation claim is made without a matching test or live verification.
