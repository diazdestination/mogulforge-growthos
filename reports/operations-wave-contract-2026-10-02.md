# Contractor operations wave - implementation contract

Owner request: "Go ahead with the next big wave so we can have a fully functioning
system." Base is merged main602131d1b0311ea5933633fedc2c25b5af218238, with green
exact-main CI37074053979. Branch: agent/growthos-operations-wave-20261002.

This is engineering authorization for the next necessary contractor workflows,
not hosted rollout, customer activation, spending or permission to send messages.
Contractor payment processing remains deferred. Both replacement acceptance cards
remain open. Prior PR14 evidence is in its merged PR and private checkpoint; older
documents describing that candidate as awaiting integration are historical.

## Outcomes and ownership

1. Service worker: bounded service-watch exceptions, responsible staff, review/
   acknowledgement/next action, service-panel deep links and service desk UI.
   Own new service-watch schema/service/routes/tests/UI and its lane report.
   Reuse existing obligations/tasks/receipts; do not invent appointments or
   customer replies. Initial triggers: reminder needs review, no response
   recorded, blocked/unknown reminder, cancelled/no-show visit, overdue service.
2. Source worker: versioned reviewed native-source adoption plus a frozen bounded
   email-only outreach path for eligible explicitly approved imported opportunities.
   Own source-adoption schema/service/routes/tests/UI and its lane report. Preserve
   provenance and independent contact permission; approval itself sends nothing.
   Do not unblock generic playbooks, SMS marketing or all imported contacts.
3. Financial worker: strict normalized review-first historical invoice/opening-
   receivable migration and reconciliation through native financial records.
   Own financial-migration schema/service/routes/tests/UI and necessary invoice
   internals; no tax determination, bank/processor action or fabricated receipts.
   Unsupported exports/credits/relationships become exceptions, not guessed data.
4. Coordinator: typed service staff-push integration, common schema/router/API
   catalog, scheduler, export/lifecycle/recovery, cross-review, complete release
   verification, Git operations and durable checkpoint.

Only coordinator commits/pushes/merges or changes shared router/index/OpenAPI/
generated files. Workers report proposed interfaces and schema additions early.
They may add their own schema files and import those directly while shared exports
are integrated. Preserve unrelated pnpm-workspace.yaml.bak. No client-site changes.

## Shared contracts

- Company identity is server-derived. Reads and mutations require active accepted
  staff and existing permissions. Financial fields retain financial-role visibility.
- Human consequential approvals require trusted-origin, JSON-only session requests,
  actor recheck, expected version and exact server-computed digest. Unknown fields,
  stale/foreign references and ambiguous source identity fail closed.
- Existing scheduling locks, transaction audit, receipt ownership and definitive
  provider boundary guards stay authoritative. No second workflow orchestrator.
- Service events are not acquisition leads. Typed notifications target the actual
  service and current accountable staff; no synthetic lead just to obtain push.
- Adoption is not consent or a new inquiry. Freeze original identity/history and
  operational-state digests. Revocation, changed sources, opt-out, reply, company
  pause and sender changes stop unclaimed/enrolled-unsent effects. Accepted or
  uncertain effects cannot be bypassed with another key, revision or cloned batch.
- New email outreach is exact reviewed copy, one bounded touch per opportunity,
  explicit marketing permission and suppression checks, selected existing mailbox,
  approved identity/unsubscribe material, immutable logical slot and final late
  recheck after credential preparation. No post-approval AI rewriting or fallback.
- Historical finance preserves original documents/dates/IDs and exact cents.
  Same external identity plus digest dedupes regardless of filename/request ID;
  changed content requires reconciliation. An opening receivable is not cash.
  Do not infer paid amount from original minus outstanding or duplicate shared
  receipts. Unsupported data must be visible and uncommittable.

## Acceptance

Per lane: positive end-to-end synthetic workflow, wrong-role/company/API-key
denial, concurrency/idempotency, stale review/revocation, meaningful error/empty
states and no unintended provider effects. Isolated PGlite cannot replace full
PostgreSQL CI concurrency evidence. Verify mobile 390/320px, integrated types,
builds, inventory/export/recovery, all tests and Docker on the actual candidate.
Cross-review before Git integration; explicit exact-main CI after merge.

No hosted schema/credential/provider change, real import/send, new cluster, secret
extraction or old-subscription cancellation is included. Keep the pending staging
upgrade/rotation authorization and Azure first sign-in owner-return gate intact.
Actual exports/agreements, sender/contact eligibility, devices and uncoached staff
acceptance are needed before either company can retire Housecall Pro. Do not call
this wave full system completion solely because code or CI succeeds.
