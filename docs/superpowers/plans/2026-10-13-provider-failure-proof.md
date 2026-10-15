# Provider failure evidence implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline. One fresh-context whole-branch review follows verification.

**Goal:** Preserve trusted, content-free V1 request failure evidence before callback normalization hides it.

**Architecture:** The supplied V1 client owns an error-to-metadata WeakMap and exposes only its fixed diagnostic projection. Request and response-validation failures carry operation, method, HTTP status, elapsed milliseconds and the existing owned safe code. The operator records the first work failure separately from cleanup failure; both retain their existing hold and cleanup behavior.

**Tech Stack:** Node ESM, Vitest, existing supplied-client custody and native PostgreSQL fixture.

**Spec:** The design and acceptance contract below, prompted by `C:/Forge/artifacts/growthos-v1-inventory-version-20261013/replacement/rehearsal-final.json`.

## Global constraints and design contract

- App source PR44/8df64dc and all 19 SQL inputs stay fixed; all 20 contractor gaps remain.
- No new hosted action, paid copy, original SQL, app change, credentials, launch or message is authorized by this correction. The replacement one-copy grant is consumed and its copy is confirmed deleted.
- Keep 15-second request, 30-second deletion callback, 240-second post-delete proof and existing absolute work/cleanup budgets unchanged. Add no retry or mutation.
- Only errors minted by the supplied V1 client expose metadata. Forged errors and arbitrary thrown objects expose none.
- Metadata permits only a fixed operation enum, fixed HTTP method, validated numeric HTTP status or null, bounded nonnegative elapsed milliseconds, and an existing owned safe code. No error message/cause, URL, endpoint, body, header, username, credential, raw record or provider value is retained.
- Cover both request/transport failures and validation of acknowledged HTTP responses. Keep per-request context local; concurrent calls cannot overwrite one another.
- Capture the first work API failure and a distinct cleanup API failure without changing pass/hold, ownership, dispatch or cleanup rules.

## Files and task

- `scripts/production75-fly-v1.mjs`: owned diagnostic getter and local request/validation projection.
- `scripts/production75-fly-v1.test.mjs`: HTTP rejection, deadline, transport, validation, concurrency, immutability and forged-error redaction regressions.
- `scripts/production75-operator.mjs`: preserve owned diagnostic evidence before callback normalization and during cleanup.
- `scripts/production75-operator.test.mjs`: real supplied-client failure composition and cleanup preservation without replay or SQL.
- This plan and new native receipts document final source acceptance separately from hosted acceptance.

- [x] Write and observe failing API and operator composition tests: seven intentional failures before implementation.
- [x] Implement the minimum diagnostic projection and operator preservation.
- [x] Run focused suites, all scripts, types and the current native fixture; scan changed source/reports for secrets.
- [ ] Obtain one independent whole-branch review, correct material findings once, commit and publish a dependent draft PR, then require exact-head CI success.

## Ledger

Pre-flight: API diagnostic getter produces the owned immutable projection consumed by the operator; no identity, admission, custody or SQL contract changes.

Ruling: The real Reader operation was dispatched but unacknowledged. Its root cause is not established from the generic callback error. Fix the observed loss of failure evidence rather than guessing at provider behavior or widening request timeouts.

The failed operator/cleanup receipt remains unchanged. Independent post-delete proof confirms all 184 original records, source metadata and protected apps unchanged, and all owned resources closed.

Verification: 67 focused tests, all 600 scripts tests and type checks pass.
Native e9eb4e01-6138-45c0-8c32-7ef9cc0422fd passed normal, lost-COMMIT and idle Reader cases with 99 clients/sockets and six containers closed. Its 23 runtime dependency hashes are stable.
Fresh-context independent review found no Critical, Important or Minor issues; it independently ran 67 focused tests and additional redaction/provenance/bounds probes. No hosted or financial acceptance is inferred.
