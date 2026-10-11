# Contractor eval dataset

Expert-labeled cases that make the Evidence Intelligence quality targets
measurable (at least 95% observation agreement with contractor reviewers, at
most 5% critical omissions), plus a CRM assistant eval. The scoring library is
`artifacts/api-server/src/lib/evals/` and the runner is
`artifacts/api-server/src/evals/contractor-eval-runner.ts`.

**Status on 2026-10-11: 0 contractor-verified cases.** Every label is a
`research-draft` written by engineering from public research and owner
interviews. Contractor agreement has not been measured, and nothing in this
directory may be presented as a contractor accuracy result.

## Files

| File | Contents |
| --- | --- |
| `evidence-cases.jsonl` | 26 evidence cases: 12 roofing and 12 HVAC synthetic cases, plus 2 cases built from owner-supplied real invoices. |
| `assistant-cases.jsonl` | 14 CRM-assistant cases with canned results for its six existing read-only tools. |
| `judge-calibration.jsonl` | 16 (expected, finding, human verdict) pairs used to measure judge-vs-human agreement and Cohen's kappa. |
| `RESEARCH-NOTES.md` | Public sources behind the inspection and diagnostic indicators. |

## Provenance

Each case names the real workflow it reflects in `workflow`. For example,
`css-intake-2026-10-09#invoicing` points to the HVAC owner interview, and
`painless-service-content-2026-09-12#roofing` points to the roofing company's
product notes. `research-notes#...` points to `RESEARCH-NOTES.md`. No job
records were available, so the synthetic cases are composites, not real jobs.

The two `real-source` cases (`hvac-real-invoice-multi-repair` and
`roof-real-invoice-lump-sum`) are the first real-sourced fixtures. They come
from two invoices the owner supplied, which were redacted on 2026-10-11. Their
`labelProvenance.source` records that. Customer names, service addresses,
invoice and job numbers, and sales-rep details are replaced by placeholders.
Their labels are still research drafts until a contractor verifies them. These
cases use the `document-extraction` kind and add line-item, totals, terms,
warranty and invoice-wording flag labels.

There is no production line-item extractor yet. The live runner records
`documentExtraction: null`, so extraction is reported as `not-run`. The scorer
is ready for a future extractor's recorded outputs. The evidence agent's
observations, gaps and forbidden claims are scored on these cases today.

## PII policy

Committed fixtures must contain no real person names, phone numbers, emails or
street addresses. Use the redaction placeholders `[NAME]`, `[ADDRESS]`,
`[REDACTED_PHONE]`, `[REDACTED_EMAIL]`, `[INVOICE_NUMBER]` and
`[JOB_NUMBER]`. City or state is acceptable. `src/lib/evals/dataset.test.ts`
scans every `.jsonl`, `.md` and `.csv` file here and fails on email, phone or
street-address patterns. Reviewers are recorded by role and a pseudonymous
handle such as `hvac-reviewer-1`, never by name. Do not commit filled label
sheets. Import them, then delete them.

## How contractors label cases

1. Export a sheet:
   `pnpm --filter @workspace/api-server run eval:contractor -- --export-labels <private-dir>`.
   This writes `contractor-label-sheet.csv`, with one row per expected
   observation, conflict, gap, forbidden claim and document-label summary, and
   `contractor-label-packet.md`, which holds the case material.
2. A qualified reviewer sets `decision` on every row of a case:
   - `agree`
   - `edit`: fill `editedStatement`, and for observations also `editedCritical` (yes/no) and `editedAliases`.
   - `reject`
   - `missing`: use the blank rows to add an observation, with critical and aliases.
3. Import the sheet:
   `pnpm --filter @workspace/api-server run eval:contractor -- --import-labels <csv> --reviewer-role "HVAC owner-technician" --labeled-by hvac-reviewer-1 --reviewed-at 2026-10-20`.
   A case becomes `contractor-verified` only when every one of its rows has a
   decision. A partially reviewed case stays an unchanged research draft.
   Rejected document labels keep the case a draft. To change those labels,
   edit the JSONL directly.
4. Have a contractor review `judge-calibration.jsonl` the same way, by editing
   `humanVerdict` and `labelProvenance`. The quality gate requires
   contractor-verified calibration verdicts.

## Reporting rules

- Contractor agreement and critical omission rate are computed **only** over
  `contractor-verified` cases. Research-draft cases are reported in a separate
  cohort as a development signal.
- The gate is `not-measurable` when any of these holds:
  - fewer than 20 contractor-verified cases exist;
  - the judge's agreement with human verdicts is below 0.9;
  - any calibration verdict is still a research draft.
- Otherwise the gate passes only when all of these hold:
  - agreement is at least 0.95;
  - the critical omission rate is at most 0.05;
  - no citation falls outside the run's artifact allowlist.

## Commands

All of these run from the repository root:

```powershell
# Offline: validate the dataset and calibrate the lexical judge (no network, no key)
pnpm --filter @workspace/api-server run eval:contractor -- --check
# Offline: rescore a recorded run (lexical judge by default)
pnpm --filter @workspace/api-server run eval:contractor -- --replay artifacts/api-server/evals/results/<file>.json
# Live and paid: needs an approved OPENAI_API_KEY; refuses under CI
pnpm --filter @workspace/api-server run eval:contractor -- --live --judge openai
```

Optional flags are `--only evidence|assistant`, `--case <id>` and, with
`--replay`, `--write` to save the rescored run.
