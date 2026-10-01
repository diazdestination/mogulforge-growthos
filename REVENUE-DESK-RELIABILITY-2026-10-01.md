# Revenue Desk review and refresh reliability

Date: October 1, 2026. WILLOWFORGE task branch: `agent/growthos-revenue-queue-hardening`.
Base: `2c12ddc1f5c431fee1f3f99f5290b6566546cd13` on `agent/mogulforge-growthos-recovery`.

Adam authorized this isolated MogulForge work while the GEEKOM agent waits for Azure account setup for Microsoft email testing. This candidate changes the Revenue Desk UI and regression tests. It does not change provider integrations, backend contracts, deployment configuration or database schema.

## Findings and changes

1. **Saved message mismatch:** ProposalCard initialized subject/body only on mount. A refreshed approved proposal could show an older message while Send acted on the newer saved action. Untouched editors now follow the saved payload. Unsaved edits retain their source payload; a conflicting payload or external approval preserves those edits, shows an explicit conflict, and blocks save/approve/send until the operator chooses to discard local edits and load the saved message. A successful save acknowledgement returns the editor to following server content.
2. **Refresh failures lost context:** A background desk error replaced the workspace, unmounting draft editors and hiding completed-action receipts. The desk now keeps its last loaded data, labels it stale, and disables its controls until refresh succeeds. Initial loading failure still shows the unavailable state without invented totals.
3. **False refresh success:** Refetch failures were treated as fulfilled operations, and the default message claimed data was refreshed. Refresh now observes query failures explicitly. Successful action receipts remain separate from subsequent refresh errors. Recovery retries only reads; it does not replay the preceding mutation.
4. **Pending-action edits:** A synchronous operation lock prevents overlapping operations before React rerenders. Controls and email inputs are frozen during pending requests.
5. **Notice contrast:** Real-browser checks found insufficient contrast in the existing muted notice text. Notices and operation errors now use the existing foreground color, preserving the product palette.

## Verification

- Regression tests reproduced the saved-content mismatch and refresh-failure behavior before the fixes.
- Revenue Desk component suite: 17 tests pass, including eight new cases covering current approved content, draft conflicts, approval with/without payload changes, save acknowledgement, pending-save double clicks, refresh failure recovery, and successful action followed by failed refresh.
- Full Command Center suite: 363 tests across 62 files pass.
- Workspace TypeScript checks and Command Center production build pass. Existing large-bundle warning remains.
- Impeccable detector: no findings on the changed component before browser contrast corrections.
- Real Chrome, synthetic component fixture using the actual RevenueWorkspace and application CSS: desktop 1440px, mobile 390px, narrow 320px, and 390px dark mode. Conflict and outage states have no scoped axe WCAG A/AA violations, horizontal overflow, or page errors. Zero write requests occurred. Recordings and traces were disabled.
- Browser evidence: `design/revenue-queue-2026-10-01/`. Local reproduction script and temporary fixture copies: `C:\Forge\workspace\revenue-queue-2026-10-01`.
- Required PostgreSQL/API/Docker parity verification runs in this branch's pull-request CI. Use the exact PR head result before integration; local UI evidence alone does not satisfy that gate.

## Operator behavior

- On a saved-action conflict, copy any local text you want to retain, choose **Discard local edits and load saved message**, and review the loaded message before approval or sending.
- On a workspace refresh failure, the shown data may be stale. Use **Refresh workspace**; completed-action receipts do not imply that the following refresh succeeded.
- Existing backend permissions, exact-payload approval, execution receipts, and uncertain-execution reconciliation remain authoritative. This UI does not grant permission to send or promise provider delivery.

## Boundaries and next step

This is a review candidate for the recovery branch, not a deployment or paid-beta readiness declaration. Browser evidence uses mocked API responses and does not establish authenticated tenancy or live Microsoft/Gmail delivery. Draft preservation applies to an open proposal editor across desk refreshes; navigation away, reload, proposal removal, and other editors' independent lifecycle behavior are outside this change.

Review and integrate the isolated PR after its full CI gate passes. Continue the provider tests with the GEEKOM agent after Adam's Azure setup. No provider account, customer communication, payment or public launch was performed here.
