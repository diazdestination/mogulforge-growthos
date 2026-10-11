# Contractor eval harness — 2026-10-11

Branch: `agent/growthos-eval-harness-20261011`, based on `87adc3e`. Local only.
Nothing was pushed, deployed or sent, and no model or provider was called.

## Scope

This change makes the provisional Evidence Intelligence targets measurable:

- at least 95% observation agreement with contractor reviewers;
- at most 5% critical omissions.

It also adds an eval for the CRM assistant. It combines expert-labeled cases
with an LLM-as-judge, calibrated against human verdicts, and a deterministic
offline judge.

**Result today: contractor agreement is NOT measured.** All labels are
engineering research drafts, and 0 cases are contractor-verified. The gate
correctly reports `not-measurable`.

## Files

Dataset, in `artifacts/api-server/evals/contractor/`:

- `evidence-cases.jsonl` has 26 cases: 13 roofing and 13 HVAC. These include:
  - adversarial cases: prompt injection in notes and in a homeowner email;
    homeowner-vs-weather date conflict; mechanical damage misread as hail;
    blistering; unsealed vs. creased tabs; insufficient evidence; part-plus-price
    invoice wording;
  - **two cases built from owner-supplied invoices, redacted on 2026-10-11**:
    the HVAC multi-repair invoice and the roofing lump-sum invoice. These use a
    new `document-extraction` kind with line-item, totals, terms, warranty and
    flag labels.
- `assistant-cases.jsonl` has 14 cases over the six existing read-only tools.
  They cover stale-estimate follow-up per the HVAC owner's cadence, a "send it
  now" request (the assistant must not claim it sent anything), workload,
  revenue-not-cash, urgent triage and booking, and two cases built on the real
  invoices.
- `judge-calibration.jsonl` has 16 human-verdict pairs, also research drafts.
- `README.md` covers provenance, the PII policy, the labeling workflow and the
  reporting rules. `RESEARCH-NOTES.md` lists the cited public sources.

Library, in `artifacts/api-server/src/lib/evals/` (pure; runs without a DB):

- `schemas.ts` holds the zod case, candidate-output and calibration contracts.
- `judge.ts` defines the `Judge` interface and two judges:
  - `LexicalJudge`, which uses key terms and token coverage;
  - `OpenAiJudge`, which uses raw fetch, a strict JSON schema, `store: false`
    and `JUDGE_PROMPT_VERSION = contractor-eval-judge-v1`. Its model comes from
    `OPENAI_EVAL_JUDGE_MODEL` and defaults to the evidence model. It does no
    logging, and its errors never include the key or response bodies.
- `scoring.ts` computes:
  - observation agreement and critical omission rate;
  - finding precision and citation allowlist validity;
  - supporting-alias citation rate;
  - conflict and gap recall;
  - forbidden-claim violations;
  - document line items, components, totals, invented values, terms, warranty
    and flags;
  - assistant tool selection, required facts and forbidden behaviors;
  - Cohen's kappa and calibration.

  It reports contractor-verified and research-draft cohorts separately. The
  gate is `{target 0.95, criticalOmissionMax 0.05}`, and its status is
  `passed`, `failed` or `not-measurable`.
- `recording.ts` handles the recorded-run format and replay rescoring, and
  flags dataset hash drift.
- `labeling.ts` handles the contractor CSV and Markdown export and the
  import. Verification is all-or-nothing per case, and reviewers are recorded
  by pseudonymous handle and role.
- `dataset.ts`, `text.ts` and `test-fixtures.ts` are supporting modules.

Runner:

- `src/evals/contractor-eval-runner.ts` is the CLI. Its modes are `--check`,
  `--live`, `--replay <file> [--write]`, `--export-labels <dir>` and
  `--import-labels <csv>`.
- `scripts/eval-contractor.mjs` bundles the CLI with the existing esbuild
  `buildAll` into a disposable `.eval-contractor-*` directory, which is
  gitignored.
- The package script is `eval:contractor`.
- `--live` refuses to run without `OPENAI_API_KEY` and refuses under `CI`
  (both checked). It writes `evals/results/contractor-live-<timestamp>.json`
  with:
  - model ids;
  - the evidence prompt version;
  - the judge kind, version and model;
  - the dataset SHA-256 values;
  - raw outputs, scores and the report.

Production seam:

- `src/services/assistant-chat-loop.ts` is the database-free system prompt,
  tool contracts and OpenAI tool loop, moved out of `assistant.ts` unchanged.
- `assistant.ts` now binds its DB tool implementations to those contracts and
  delegates to the loop. The request body, model, tool order, round cap and
  error handling are the same. The existing `assistant.test.ts` passes
  unchanged (36/36).

Docs: `artifacts/api-server/evals/README.md` and `EVIDENCE-INTELLIGENCE.md`
(the quality-target section) now point to the harness and state that 0 cases
are contractor-verified.

## Commands and results

| Check | Result |
| --- | --- |
| `vitest run --config vitest.unit.config.ts src/lib/evals` | 5 files, 47/47 passed (includes PII scans of all 5 dataset files) |
| `node scripts/local-dev.mjs test src/services/evidence-redaction.test.ts src/services/evidence-intelligence.test.ts src/services/assistant.test.ts` | 3 files, 42/42 passed |
| `pnpm run typecheck` | passed (api-server, command-center, scripts) |
| `pnpm --filter @workspace/api-server run build` | passed |
| `eval:contractor -- --check` | Dataset valid (26/14/16). Lexical judge vs. research-draft verdicts: 87.5% agreement, kappa 0.750, **uncalibrated**. The 2 disagreements are paraphrases ("Eleven" vs "11", "antenna mount" vs "dish"). Gate: not measurable. |
| `eval:contractor -- --live` with no key, and with `CI=true` | both refused, as intended |
| `eval:contractor -- --replay <empty recording>` | rescored offline; every case reported as a model error, extraction not run |

Note: running the whole unit config without a filter has 4 suites that fail
before and independently of this change, because they need `DATABASE_URL`:

- `beta-operations-schema-upgrade.test.ts`
- `rate-limit-fail-open.test.ts`
- `restore-app-readonly.test.ts`
- `swarm-schema-upgrade.test.ts`

## Limitations

- No live baseline run exists. Model accuracy on these cases is unknown.
- There is no production invoice line-item extractor. Document-extraction
  scoring is implemented and unit-tested, but it reports `not-run` until an
  extractor exists. The evidence agent's observations, gaps and forbidden
  claims are still scored on the two invoice cases.
- The lexical judge cannot handle paraphrase or number words, as calibration
  shows. Treat it as an offline smoke judge. The OpenAI judge must itself be
  calibrated against contractor verdicts before any gate is trusted.
- Forbidden-claim regex patterns are best-effort for the lexical judge. The
  LLM judge uses the plain-language description.
- The synthetic cases are composites built from public research and owner
  interviews, not real jobs. Research sources are mostly secondary.

## Open gates (owner input needed)

1. **Contractor labeling sessions.**
   - The HVAC company (CSS) should review the HVAC cases and the HVAC invoice
     case.
   - Painless should review the roofing cases and the roofing invoice case.
   - Both should review the calibration pairs.
   - At least 20 contractor-verified evidence cases are needed before agreement
     is measurable. More real redacted job material, such as diagnostic notes,
     inspection notes and photos, would make the set representative.
2. **Live baseline.** A run needs an approved OpenAI key and spend:
   - the evidence model (`gpt-5.6-sol` by default) on 26 cases;
   - `gpt-4o-mini` on 14 assistant cases;
   - LLM-judge calls.
3. **HVAC invoice requirement.** The owners require warranty-validity dates
   on invoices, and the real invoice has none. Confirm this is a product
   requirement for invoice drafting. The labels treat it as a gap to flag.
