# Reviewed initial estimate email candidate

Staff can prepare and deliberately approve one complete plain-text email from a saved, previously unsent estimate, for either a lead or returning customer. The review shows the exact selected Gmail/Microsoft sender, recipient, subject, body, line items, customer-facing notes and saved amounts. Integer cent formatting preserves the saved quote throughout approval and retained evidence.

Source implementation: ac13692ae22d41aca402331013c6a277eef17bf3 on agent/growthos-estimate-email-20261013. Base is reviewed crew PR56 / 3f3c5247a08360ca561d0cda32cca145237ce50f, which depends on application PR44 / 8df64dc72009832f93b2b491031acd1bb2afb903. This is a dependent source candidate; canonical main remains unchanged.

## Delivery and history behavior

Both roots retain transactional saved-state provenance. An accepted, verified, active office/admin/owner session reviews the current quote; preview lasts ten minutes. Send accepts only the original preview ID, hash and explicit confirmation. The source, both current/effective roles, selected sender, contact policies and outbound controls are checked again after OAuth and as the final awaited step before the provider POST.

A permanent estimate-owned email key admits one initial attempt. Expiry, edits, uncertain acknowledgments, operator reconciliation and a different request ID cannot rearm it. Provider proof and original business history are retained atomically; late proof does not authorize another send or overwrite later quote changes. Provider acceptance is separate from inbox delivery and customer approval. The manual action is named Record external send and retains its existing status behavior.

Deleting, merging, reparenting or demo/test cleanup cannot discard admitted or orphan delivery history. Broad audit/Revenue Desk reads expose closed business projections; previews and private capabilities are omitted. The customer export validates original receipts within its existing read-only repeatable-read transaction. It now has 28 datasets, including estimate_email_receipts; the database still has 142 tables.

## Direct verification

| Check | Result |
| --- | --- |
| Full disposable PostgreSQL16/API/UI/scripts gate | 4,760 passed; 15 existing API skips; exit0 |
| API | 3,289 passed; 284 files passed; 3 existing skipped files |
| Command Center | 1,074 passed in 119 files |
| Scripts / React client / email intake / website adapter | 355 / 13 / 3 / 26 passed |
| Workspace TypeScript and both production builds | Passed |
| Production Docker staging parity | Passed at ac13692; restricted schema role, provider-owned monitoring view, release identity, database failure/recovery and owned cleanup |
| Source preservation | 142-table offline catalog unchanged; all 19 canonical SQL inputs byte-identical to PR44; all 23 checked-out SQL byte hashes unchanged from initial pins |
| Independent review |All tasks and whole-branch review accepted; no open Critical/Important findings |
| Fictional desktop/mobile/keyboard browser flows |Both roots, complete content/approval, one request per claim, GET-only refresh after acceptance/lost acknowledgment; real local API remained held |
| Provider wire content |Both providers/roots compare complete original wire payload; truncation mutation failed all 4 regressions, restored 86/86 passed |
| Secret scanning |Redacted candidate scan passed; final publication identity is recorded in Forge receipts |

Existing skips are og-card-brand-parity9, settings-service-slugs5 and upload-cleanup.integration1. No new test was skipped. The first full candidate run failed two legacy export-count expectations (27 instead of 28); that failure remains preserved. Both tenant checks now explicitly verify the empty receipt dataset and existing privacy canaries. The corrected full run passed. Final review also caught and corrected floating-point display of valid large cent values; both approval and retained precision regressions passed.

Raw logs, exit receipts, review packages, source/hash receipts and browser screenshots are retained in C:\Forge\artifacts\growthos-estimate-email-20261013. Browser acceptance used UI846e9b6 with controlled synthetic delivery responses and a real held API; the subsequent amount-only correction passed its focused tests and the full current UI gate. Recordings, traces and real provider transports were absent. Owned loopback 4192, disposable test containers and parity stack were removed; the pre-existing 4193 preview was preserved.

## Regeneration and release boundaries

Run pnpm --filter @workspace/api-spec run codegen normally. Its tracked tail invokes scripts/estimate-delivery-codegen-strict.mjs, which validates the unique estimate-operation region and exactly 18 object schemas before adding strict closure. It is portable, idempotent and fails before writing when generation drifts; earlier operations remain unchanged. No schema, SQL, dependencies or invoice execution kernel changed.

Exact publication-head GitHub CI, including Docker parity, must pass before source completion is recorded. The final PR/head/CI proof is maintained in Forge's implementation state and artifacts, avoiding a self-referential source commit. This source wave does not activate providers, send customer emails, migrate hosted data or deploy GrowthOS.

G-06 full estimate delivery remains open: SMS, PDF/photos and revised/resend workflows require their own scope and acceptance. Actual mailbox/inbox, physical device and contractor samples remain separate proof. G-04 configurable capacity/travel rules, both contractor replacement cards, the Fly75→95→142 upgrade/rollback rehearsal and supported credential retirement remain open. Fly support T-20107 still showed Received with no reply at 18:12 UTC. Historical recovery packets and consumed paid grants do not authorize another hosted operation; a current release packet must bind its exact source/image/SQL/target/recovery evidence.
