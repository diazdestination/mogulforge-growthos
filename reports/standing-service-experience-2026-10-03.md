# Standing service reminders — experience lane

Date: 2026-10-03. Branch: `agent/growthos-standing-service-20261003`.
Scope: the frozen `standing-service-contract-2026-10-03.md`, with the coordinator-approved `handled` SMS disposition and reviewed-occurrence snapshot fields. Local implementation and synthetic UI evidence only; not a provider activation or production completion claim.

## Delivered

- Existing `/service` remains the entry point. Customer care now contains a collapsed, on-demand standing-series setup and separately opened SMS/mailbox evidence. There is no new disconnected dashboard.
- Standing reminders default off. Current canonical service, recorded recurrence, accountable owner, actual service-agreement dates, source verification/cutover evidence, channel, recipient, sender, fixed copy, and sending policy are reviewed before an exact actor/company-bound expiring preview can be approved. Native and imported source evidence remain distinct; warranty coverage is not used as service validity.
- The preview echoes the exact snapshot/version/hash, starts unchecked, expires locally, and is invalidated by form edits. The saved intent, future notice window, operational hold/deferral, original occurrence authority, and actual receipt are displayed separately. Standing admission is never called individual staff approval. One-off reminder and booking paths remain intact.
- SMS review copy includes the same canonical business prefix and STOP/HELP footer as the transport, plus the pinned occurrence-reference placeholder. The reference is explicitly routing evidence, not identity, consent, or booking authority. The email path displays the fixed server-provided subject/body and selected company mailbox.
- Disable is a separate request-ID/version/note/confirmation action that remains available for saved-but-held policies without requiring a ready provider. It does not recall accepted work or clear uncertain receipts. Stale/unknown saves require explicit refresh; there is no automatic retry.
- Service SMS evidence is paged at 25 and labels exact, historical, and ambiguous phone-scope evidence without inferring an association. Content is rendered as escaped plain text; content expiry does not imply hold expiry. The bounded candidate count is explicitly not a match or a whole-company count.
- SMS office dispositions are `office_follow_up` (keep the hold), `handled` (actual office handling complete; release only this service-reply hold), and `not_service_reply` (dismiss unrelated service evidence). Each requires an exact current version, note, fresh checkbox, and request ID. A held previously reviewed reply can subsequently be handled. No disposition records consent, ready-to-book response, service completion, or an appointment; handling does not rearm the original send.
- ServiceDesk waits for verified company membership before data reads. Semantic identity/company/role/active scope preserves drafts through unchanged profile polling; errors, revocation, or real authority changes unmount privileged work. Existing AccessGate monitoring was not weakened. Care, watch, editor, mailbox, and SMS late asynchronous outcomes cannot refresh or report success into a closed/changed authority view. Related contact/staff/appointment caches are company/member scoped.
- Coordinator browser QA found that a successful child save triggered a full list-loading state, unmounting the open care/standing/SMS panel and hiding its saved confirmation. Child-command list refreshes now retain the same-scope panel while refreshing evidence in the background. Failed refreshes close controls; explicit list review/navigation and actual authority changes still reset them. Parent-level tests cover real standing and SMS save confirmations, failed refresh/recovery, and changed authority while a refresh is pending.
- Service editor explains that a recurring staff task is not permission for standing customer messages. Unknown/stale editor results require closing and refreshing the saved record. One-off agreement/conversation attestations reset when the underlying entered evidence changes.

## Verification

Final focused run on 2026-10-03:

```text
pnpm --filter @workspace/command-center exec vitest run \
  src/components/service-standing-reminders-panel.test.tsx \
  src/components/service-sms-replies-panel.test.tsx \
  src/components/service-care-panel.test.tsx \
  src/components/service-watch-panel.test.tsx \
  src/components/service-mailbox-replies-panel.test.tsx \
  src/components/service-obligation-editor.test.tsx \
  src/pages/service-desk.test.tsx \
  --maxWorkers=1 --no-file-parallelism
```

Result: **7 files / 71 tests passed** (final focused rerun 15:04 local). Includes actual generated API-schema parsing of the standing preview/view/commands and SMS page/review command, exact preview echo, expired/stale/mismatched and malformed-success responses, uncertain receipts, held-policy disable, SMS handled/ambiguous/historical/expired-content cases, paging, escaped malicious text, unchanged profile refresh, role/company/user/inactive/error reset, late action/selection responses, and retained child-save receipts across the parent background refresh. Synthetic fixtures use `.invalid` addresses and contain no customer/provider secrets.

`pnpm --filter @workspace/command-center run typecheck`: passed.
`git diff --check` for modified tracked experience files: passed.

## Independent backend review

Bounded read-only source review of standing policy/runtime, service SMS evidence/review routes, current service authorization, shared durable claims/contact allowance and the last SMS dispatch guard found no concrete exploitable stale-authority, cross-tenant, hidden business GET mutation, unknown-effect rearm, or office reply-handling dead end. The review followed the security-review skill's evidence-first guidance; speculative races were not promoted to findings. Existing tests were inspected, but this review did not independently run PostgreSQL concurrency tests or exercise live providers. No backend files were changed by this lane.

## Remaining integration boundaries

- Coordinator owns the full repository checks, browser/phone-width walkthrough, final generated schema alignment, normalized schema/recovery verification, release documentation, Git and CI.
- No live email or SMS was sent, no provider configuration or credentials changed, no hosted database schema applied, and no production deployment performed by this lane.
- API/session authorization, exact persisted approval, fresh source facts, provider readiness, reservation/cap locks, finite send expiry and one-effect idempotency remain server-owned controls. Frontend confirmation is not a substitute for those checks.
- This is bounded standing reminder authority and office reply handling, not a general autonomous conversation, automatic booking, verified delivery, or warranty-coverage decision.

Checkpoint: implementation, tests and this lane report are saved in the canonical project. Root owns the shared Jarvis/project checkpoint and commits; the pre-existing `pnpm-workspace.yaml.bak` was untouched. No memory update was made.
