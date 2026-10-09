# GrowthOS integrated candidate

Completed local integration of Willowforge PR #28 and PR #29 with the owner-approved silver-and-green branding and professional specialist theme. The combined tree also includes the native lead-page alert coverage UI that the backend handoff left for this integration lane. No conflicts occurred.

## Exact source and scope

- Repository: https://github.com/diazdestination/mogulforge-growthos
- Clone: https://github.com/diazdestination/mogulforge-growthos.git
- Local checkout: C:/Users/diazd/dev/projects/mogulforge-integrated-specialists-20261009
- Branch: codex/integrated-specialists-alerts-20261009
- Tested application source: bdcd5f2d56f5c0c08284dda8dd9d3d27cad60848
- Integration merge: bc1d0d482a0a680d26e0d8181d712a3899241581
- PR #28: a0eb25dcc69291130a46a5478acf44f62d303e9f
- PR #29: a52db0893fca14fea2f95df8a6ea1fc3d788a7b6, containing #28
- Approved product theme: 8c84d325de6e183f333d73720956f14b90c52be4

All three source heads were verified ancestors of the candidate. The original product checkout remains on its approved theme head; its existing pnpm-workspace.yaml.bak hash remains 33ff97aba37c64c05c8b643219aa877dc671753f62aca0bf7e862988a080f371. The separately maintained public website stays on the approved theme commit17e6c83ef72fc5c56abfb567683b175446c627a5; its older QA files remain intact. No application changes were made after the tested source commit; subsequent candidate commits contain validation records only.

PR #28 retains exact inquiry ownership and claim protections plus release-safety changes. PR #29 retains every originally selected staff recipient, including zero-device and unavailable outcomes. The new owner/admin panel reads coverage for the exact lead through the session-only endpoint, displays original admission separately from current receipt evidence, and distinguishes provider acceptance from phone display or human reading. It uses no persistent coverage cache and clears evidence on company/member/role/lead changes, account errors, read failures and timeouts. It offers read refresh/retry only.

## Actual validation

| Check | Final result |
| --- | --- |
| Command Center | 115 files, 1,026 tests passed |
| API on owned PostgreSQL16 | 271 files passed; 2,945 tests passed; 15 existing skips in3 files |
| Scripts | 18 files, 247 tests passed |
| API client | 13 tests passed |
| Cloudflare email intake | 3 tests passed |
| Website adapter and operations | 18 +8 tests passed |
| Unique total across full suites | 4,260 passed, 15 existing skips |
| Focused integration subset | 50 passed; included in full suites, not added again |
| Type checking | Root-observed workspace and email-intake checks passed |
| Production builds | UI and API passed locally and inside Node22 Linux Docker build |
| Offline schema comparison | 141 prior definitions unchanged;142 total; additive0018 only; no historical DML |
| Disposable PG16 fixture | Version160015; public catalog142 tables; exact owned synthetic test database |
| Browser | Desktop1280 and phone390x844; no horizontal overflow; cohort/history/read-error/retry and SCOUT guide inspected |
| Docker production parity | Passed; restricted role/provider view, health/readiness/release identity, database failure/recovery and public identity pages |

All43 coverage-service and25 coverage-route tests passed on native PostgreSQL16, including the PostgreSQL concurrency/authority-lock cases. The15 existing skips are OG card parity9, service slugs5 and upload cleanup1. They are recorded explicitly; no new coverage race was skipped. Local test runtime was Node24 on Windows; Docker production build/parity used Node22 on Linux. These are local results, not a new GitHub CI run or actual push delivery to a phone.

The first API attempt failed65 tests because the harness supplied a global outbound hold before mocked dispatch. Its raw failure and metadata are preserved. Omitting that flag to match CI, retaining the clean synthetic environment and propagated HTTP guard, produced the complete passing rerun without application changes. The initial Docker attempt could not find Compose because required OS ProgramFiles variables were stripped; no stack was created. Adding those OS paths enabled the passing run. Neither correction relaxed a production gate.

The child environment excluded real database/provider/connector credentials and loaded no .env file. The guard blocks nonlocal HTTP/HTTPS and global fetch; it is not a universal socket sandbox. Test provider calls were synthetic and intercepted. The recorded suite command arrays list entry-point arguments; the validation wrapper additionally preloaded the guard and supplied the explicitly filtered environment.

Docker image: sha256:ad35da18b877d2b9cbcf2d272d74bc89c20f383f84a49717b2b752c017bd076b, built from clean source bdcd5f2. Owned Compose project growthos-parity-28420 was removed; post-cleanup label inventories were empty. The separate PG fixture and its anonymous volume were removed after positive identity checks. Container absence, volume absence, refused loopback port and empty task inventory are recorded. An initial absence decoder mismatch is preserved and corrected by read-only reconciliation, without repeating removal.

Raw logs/metadata and hashes are preserved in reports/integration-validation-2026-10-09. Independent reviews bind source, focused results and broader completed local receipts. The typecheck and offline schema result also have Root-observed receipts; no reconstructed raw console is presented for those checks.

## Review and release state

Fresh GitHub reads confirm [PR #28](https://github.com/diazdestination/mogulforge-growthos/pull/28) and [PR #29](https://github.com/diazdestination/mogulforge-growthos/pull/29) remain OPEN DRAFT at the exact heads above. This candidate is committed locally and has not been pushed, remotely merged or deployed. No hosted database, customer data, DNS, provider activation or real communication changed.

The old forced release-schema path remains deliberately retired. A release needs a separately reviewed exact source/image/0018 SQL/target/backup/restore procedure and authorization. Existing restore/write/delete once-only histories remain consumed and cannot authorize this migration.

Local synthetic coverage preview: http://127.0.0.1:4793/design/coverage.html. Approved website theme: http://127.0.0.1:4792/growthos#specialists. The coverage preview uses the actual component with illustrative staff and an intercepted read endpoint; it does not prove a signed-in native lead journey. Local dev preview entries are excluded from the production entry and routes.
