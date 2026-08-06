# MogulForge GrowthOS Architecture

This document is the implementation contract for the canonical
`diazdestination/mogulforge-crm` product. It separates working local software
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

## Non-negotiable safety rules

- No raw tenant artifact is used by AI without explicit authorization.
- No AI draft is an issued certificate.
- No certificate reaches an execution path without a current integrity hash and
  completed human review.
- No target write is retried when a prior write may have occurred.
- No implementation claim is made without a matching test or live verification.
