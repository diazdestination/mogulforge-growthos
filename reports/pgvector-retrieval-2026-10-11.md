# pgvector retrieval and per-customer memory (2026-10-11)

Branch `agent/growthos-pgvector-memory-20261011` (worktree
`C:\Forge\worktrees\growthos-pgvector-memory`), based on `87adc3e`. Local commits
only. Nothing was pushed, deployed, or applied to staging, production or Fly.

## Scope

Upgrade #3: pgvector retrieval over customer history plus per-customer memory,
replacing keyword-only matching in the knowledge base.

- One pinned pgvector-enabled PostgreSQL 16 image everywhere:
  `pgvector/pgvector:0.8.0-pg16` (pulled through the WSL Docker bridge; digest
  `sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9`).
- Two additive tables (142 → 144): `retrieval_chunks` and `customer_memories`.
- Embedding providers: OpenAI (`text-embedding-3-small`, 1536 dims) and a
  deterministic local hash embedder. Both are explicit opt-in. Without a
  provider, search uses the existing keyword logic.
- Knowledge search (`searchKnowledge`) and the concierge, customer context
  retrieval, customer memory CRUD routes, one read-only assistant tool, and a
  small Customer memory UI panel.

## Design decisions

- **Explicit provider opt-in.** `EMBEDDINGS_PROVIDER=openai|hash|none`. An
  existing `OPENAI_API_KEY` (already used by Evidence Intelligence) does not by
  itself start embedding spend or send customer text out. A broken explicit
  setting is logged and falls back to keyword mode, and the response says
  `mode: "keyword"`. The hash embedder reports `lexical_hash`, never `semantic`.
- **Redaction.** All indexed text and every query pass through
  `redactEvidenceText` (email, phone, SSN, policy/claim/account ids) before they
  are stored in `retrieval_chunks.content` or sent to a provider. History
  documents are built without the contact's name, email, phone or address
  fields, because names and street addresses cannot be detected reliably by
  pattern. Free-text notes can still contain names. This is a documented
  limitation.
- **Tenant isolation.** Every statement filters on `organization_id`, and
  customer reads also filter on `contact_id`. Chunks carry a tenant-composite
  FK to `contacts(organization_id, id)`. CHECKs require `scope=knowledge` to have
  no contact and `scope=customer` to have one. Vector queries use an exact scan
  of a `MATERIALIZED` CTE over the tenant-filtered rows, so an approximate HNSW
  scan can never drop rows after filtering. The HNSW cosine index exists for
  future scale; iterative-scan tuning is a follow-up.
- **Derived data.** Chunks are rebuildable and keyed by
  `(org, source_type, source_id, embedding_model)`. Only changed `content_sha256`
  values are re-embedded, so reindexing is idempotent. Deactivating or deleting a
  knowledge entry, or retiring a memory, deletes its chunks in the same
  transaction. Create and update re-index best-effort: CRUD never fails because
  embedding failed. The status (`indexed|unchanged|removed|skipped_no_provider|failed`)
  goes into the knowledge audit metadata, and failures are logged without text.
- **Customer history sources** (bounded to 100 per type): active memories,
  leads (status/service/source/summary/lost reason), activities (title/body),
  appointments (type/date/status/notes), estimates (title/status/total/line
  descriptions/notes), and invoices (number/status/total/title/line
  descriptions/notes from the issued snapshot, never `customerName` or
  `customerAddress`). History is linked directly or through the contact's own
  leads and customer-work roots. Reading a customer re-syncs that customer's
  chunks first, so only changed records are embedded.
- **Memories.** Kinds: `fact|preference|equipment|access_note|other`, up to 1000
  characters. Provenance (`lead|activity|appointment|estimate|invoice`) is
  verified to belong to the same organization and customer. Retiring is a
  recorded human decision (`retired_at`, `retired_by_user_id`) and the row is
  kept. Audit events `customer_memory.created` and `customer_memory.retired`
  never include the memory text.
- **Permissions** (route-inventory contract updated): memories and context
  search use `crm.read` and `crm.write`; the company backfill
  `POST /retrieval/reindex` uses `settings.manage` (owner/admin, API keys
  rejected by the existing guard). Reindex returns 409 when no provider is
  enabled.
- **Assistant.** One new read-only tool, `search_customer_history`. The
  organization comes from the chat session. A model-supplied `contactId` from
  another company comes back as "not found". Name, email or phone lookup only
  searches the chat's own company, and returns candidates when the match is
  ambiguous.
- **Push paths.** `lib/db` `push` and `push-force` now run
  `ensure-extensions.mjs` first. This covers CI, `local-dev.mjs`, the
  `vitest.globalSetup.ts` auto-push, the parity schema service (whose init SQL
  enables `vector` as the owner, so the restricted role only verifies it) and
  the compose quick start. PGlite runners use
  `artifacts/api-server/scripts/pglite-vector.mjs`, which adds the new dev
  dependency `@electric-sql/pglite-pgvector@0.0.9`. `smart-sites-local-run.mjs`
  schema mode runs the extension step before `drizzle-kit`.
- **OpenAPI.** Codegen (orval) is not reproducible on this machine. It rewrote
  all generated files, so those changes were reverted. The new endpoints follow
  the established pattern instead: zod contract
  (`services/customer-memory-contract.ts`) projected into `openapi.yaml` by
  `scripts/customer-memory-api-spec.mjs`.

## Files

- Schema: `lib/db/src/schema/retrieval.ts`, `lib/db/src/schema/index.ts`,
  `lib/db/ensure-extensions.mjs`, `lib/db/package.json`
- Services: `embeddings.ts`, `retrieval-index.ts`, `retrieval.ts`,
  `customer-memory.ts`, `customer-memory-contract.ts`, `customer-history-tool.ts`;
  updated `knowledge.ts`, `concierge.ts`, `assistant.ts`,
  `data-lifecycle-inventory-catalog.ts` (v17, 144 tables)
- Routes: `routes/v1/customer-memory.ts` and its registration in
  `routes/v1/index.ts`; `routes/v1/knowledge.ts` now records index status in audit
- UI: `components/customer-memory-panel.tsx`, mounted closed-by-default in
  `pages/customer-workspace.tsx`
- Infra: `docker-compose.yml` (new `pgdata16` volume), `docker-compose.parity.yml`,
  `.github/workflows/ci.yml`, `scripts/local-dev.mjs`, `scripts/docker-parity-init.sql`,
  the PGlite runners in `artifacts/api-server/scripts/`
- Review SQL: `reports/staging-schema-preview-2026-10-01/0019_pgvector-retrieval.sql`,
  generated by `scripts/pgvector-retrieval-schema-preview.mjs`. It starts with
  `CREATE EXTENSION IF NOT EXISTS vector` and verifies that all 142 prior table
  definitions are unchanged.
- Drills: `scripts/contractor-recovery-drill.mjs` (applies 0019 and asserts
  142 → 144, prior rows unchanged, new tables empty),
  `scripts/restore-drill-fixture.test.mjs`
- Tests: `services/retrieval.test.ts`, `services/embeddings.test.ts`,
  `routes/v1/customer-memory.test.ts`, `components/customer-memory-panel.test.tsx`
- Docs: `DEV-LOCAL.md` (image change plus PG15 → 16 dump/restore), `DEPLOY.md`,
  `RUNBOOK.md`, `GROWTHOS-ARCHITECTURE.md`, `.env.example`

## Commands and results

All commands ran on WILLOWFORGE with the disposable `pgvector/pgvector:0.8.0-pg16`
container started by `scripts/local-dev.mjs`, and PGlite for the isolated runners.

| Command | Result |
| --- | --- |
| `node scripts/local-dev.mjs test src/services/retrieval.test.ts src/services/embeddings.test.ts src/routes/v1/customer-memory.test.ts src/services/knowledge.test.ts src/routes/v1/route-inventory.test.ts src/services/data-lifecycle-inventory.test.ts src/routes/v1/data-lifecycle-inventory.test.ts src/services/assistant.test.ts src/routes/v1/assistant-chat.test.ts` | 9 files, 138/138 passed |
| `node scripts/local-dev.mjs test` (full: libs, scripts, command-center, api-server) | scripts 28/28 files; command-center 117 files / 1037 tests; api-server 276 passed, 1 failed, 3 skipped files; 2994 passed, 1 failed, 15 skipped tests |
| the 1 failure: `src/services/service-care.test.ts` | Existing parallel-run collision: the fixed number `+15005550009` is shared by 5 existing test files and hit `twilio_client_binding_phone_uq`. Re-run alone: passed. Not caused by this change. |
| `scripts` vitest (includes `contractor-recovery-drill.test.mjs` with 0019 and `restore-drill-fixture.test.mjs`) | 28 files passed (341 + 10 tests) |
| `pnpm --filter @workspace/api-server run test:scheduler` | 9 files, 44 passed, 1 skipped |
| `pnpm --filter @workspace/api-server run test:twilio` | 8 files, 79 passed |
| `node artifacts/api-server/scripts/test-tenant-acceptance-isolated.mjs` | 15 passed |
| `pnpm --filter @workspace/command-center test` | 117 files, 1037 passed (includes new panel test) |
| `pnpm run typecheck` | pass |
| `pnpm --filter @workspace/api-server run build` | pass |
| `node --import tsx scripts/pgvector-retrieval-schema-preview.mjs` | 0019 generated; 142 → 144; prior definitions unchanged |
| `node --import tsx scripts/customer-memory-api-spec.mjs` | 4 paths, 5 schemas; `openapi.yaml` parses |

Not run: the Docker staging-parity gate (`scripts/verify-docker-staging-parity.ps1`),
`preview-runtime-isolated.mjs` (an interactive server) and the manual
detail-corrections runner (see open gate 5).

## Open gates (owner input)

1. **Hosted pgvector.** Confirm that the Fly/managed Postgres cluster offers
   pgvector, and approve enabling it (`CREATE EXTENSION vector` by the database
   owner) before `0019` is applied. Availability has not been verified.
2. **Embedding spend.** Approve `EMBEDDINGS_PROVIDER=openai`, which sends
   redacted customer and knowledge text to OpenAI and incurs per-token cost.
   Until then production stays keyword-only.
3. **Backfill on real data.** After 1 and 2, an owner/admin pages
   `POST /api/v1/retrieval/reindex`. Review the redaction limits (names in
   free-text notes) with real records first.
4. **Similarity thresholds.** The values (semantic 0.40 knowledge / 0.20
   customer) are conservative defaults and have not been tuned on real
   questions.
5. **Detail-correction runner.** `test-customer-detail-corrections-isolated.mjs`
   pins a plain PostgreSQL 16 image digest and cannot apply the new schema until
   that reviewed pin moves to the pgvector image.
6. **Existing local volumes.** Local developers with PG15 data must migrate with
   dump/restore (see `DEV-LOCAL.md`). The old volume is untouched.
