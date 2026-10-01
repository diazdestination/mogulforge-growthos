# Customer data lifecycle — controlled-pilot engineering plan

Source review: 2026-10-01. Owner: product owner plus assigned engineering/operator reviewer.

**Status: plan only; P0-7 remains open.** This document implements no export, offboarding, deletion, retention policy, or legal disclosure. It authorizes no purge, provider change, or customer communication. The [P0-7 gate](PAID-BETA-READINESS-P0.md#p0-7--finish-trust-privacy-and-customer-data-lifecycle) requires behavior that is defined, tested, supportable, and accurately disclosed before external paid beta.

## 1. What exists, and what it does not prove

These are source-level capabilities, not fresh live acceptance results.

| Area | Implemented behavior | Whole-account gap |
| --- | --- | --- |
| Export | [`GET /api/v1/reports/roi/export`](artifacts/api-server/src/routes/v1/reports.ts) returns an org-scoped ROI CSV. | Not a customer-data archive: no complete record/media export, schema manifest, protected delivery, or lifecycle request tracking. |
| CRM deletion | [`crm.ts`](artifacts/api-server/src/services/crm.ts) directly deletes an org-scoped contact, task, estimate, or project row. | No dependency-aware account plan; linked records can block deletion. Removing a lead photo changes activity references, not the stored object itself. |
| Deactivation | [`automation.ts`](artifacts/api-server/src/services/automation.ts), [`capture.ts`](artifacts/api-server/src/services/capture.ts), and [`webhooks.ts`](artifacts/api-server/src/services/webhooks.ts) set rules/templates/endpoints inactive. [`forms.ts`](artifacts/api-server/src/services/forms.ts) archives forms with submissions. | Records/history remain. Disabling a rule is not proof that already queued work, other intake, or provider callbacks have stopped. |
| Access and Gmail | [`me.ts`](artifacts/api-server/src/routes/v1/me.ts) changes another member's active status; [`api-keys.ts`](artifacts/api-server/src/services/api-keys.ts) revokes individual keys. [`disconnectGmail`](artifacts/api-server/src/services/gmail-oauth.ts) attempts Google revocation, clears the local refresh token, and retains the connection row. | No unified account offboarding. Google revocation failure does not prevent local removal: local success cannot certify remote revocation. Sessions, identity tokens, and other integrations need separate handling. |
| Email Intelligence | [`email-intelligence.ts`](artifacts/api-server/src/services/email-intelligence.ts) purges encrypted raw text on expiry/manually; message deletion cascades to facts in its [schema](lib/db/src/schema/email-intelligence.ts). | Raw purge leaves message metadata and derived facts. Message deletion does not erase the original mailbox, provider copies, or independent CRM records. Existing raw-retention settings are not a product-wide retention policy. |
| Housekeeping | [`portal.ts`](artifacts/api-server/src/services/portal.ts) removes expired/consumed credentials; [`upload-cleanup.ts`](artifacts/api-server/src/services/upload-cleanup.ts) removes old uploads not referenced by photo activities. | Scheduled housekeeping is not request-driven erasure. Its reference search is not a complete inventory of every possible media link. |
| Organization closure | [`orgs.ts`](artifacts/api-server/src/routes/v1/orgs.ts) supports creation/listing/updates, not whole-org closure. | No reviewed whole-account export/delete workflow, preview approval, completion reconciliation, or backup re-erasure workflow. [`deleteTestOrgs`](artifacts/api-server/src/test-helpers/delete-test-orgs.ts) is test cleanup, **not an operator deletion tool**. |

The existing [messaging privacy surface](artifacts/command-center/public/messaging-privacy.html) explicitly leaves the final retention/deletion process unresolved. Do not treat it as a complete GrowthOS policy or silently change its promises.

## 2. Owner decisions required before execution

Record decisions separately from implementation; none are approved by this plan:

- Request channel, responsible responder, identity-verification method, approver(s), and response/service commitments. Decide who may request individual-person erasure versus full contractor-account closure.
- Data-category retention, export availability/delivery expiry, operational log/audit treatment, legal/accounting holds, and what evidence may remain. No retention periods or legal exemptions are invented here.
- Contractor versus platform responsibilities, selected Google/forwarded-data treatment, provider/subprocessor disclosures, and privacy/security escalation contacts. Have appropriate policy/legal review before publication.
- Subscription cancellation, phone-number ownership/transfer, provider account closure, and backup disposition. Deleting GrowthOS rows must not silently cancel billing, release a number, or close shared provider resources.

Until these decisions and the tested workflow exist, accept and track a request for review; do not promise a completed account purge or certify P0-7 as passed.

## 3. Proposed operator workflow and engineering deliverables

Each stage below is **to be built and accepted**, not an instruction to run SQL now.

1. **Verify and scope.** Create a restricted request record with a random request ID. Verify the requester through an established account channel and current owner/authorized representative relationship; a matching email, API key, forwarded message, or platform-admin session alone is insufficient. Resolve the exact organization and request type. For a person's request, determine their records within that org; never expand by email across tenants. Record verification outcome, not passwords, tokens, or unnecessary identity documents.

2. **Build a read-only inventory.** Reconcile the [schema index](lib/db/src/schema/index.ts) against the deployed schema/version. Classify every table as direct-org, indirectly linked, global/shared, or exception; fail closed on unknown tables. Include CRM/property/equipment/service obligations; activities/messages/media; lead capture/forms/import-derived records; campaigns/automations/queued work; Revenue Desk decisions/receipts; consent/suppression; portal/identity/access; Google/forwarded-email data; analytics/assistant/knowledge records; configuration/audits/billing references. Traverse foreign keys **and** JSON/text links. Record counts, owned object IDs/bytes, dependency order, and explicit exclusions without copying customer content into logs.

3. **Produce the approved export before erasure.** Use allowlisted fields, stable IDs/relationships, machine-readable files, selected owned media, a schema/version manifest, counts and checksums. Bound queries and downloads to the verified org; do not use a raw database dump or ordinary paginated list APIs as a complete export. Exclude passwords/hashes, API-key hashes, OAuth tokens/ciphertexts/state, session/cookie/token digests, webhook/capture/enrollment secrets, secret references, environment values, internal security evidence, and other tenants' data. Treat raw email as restricted content, not something to decrypt automatically. Review its inclusion separately. Deliver only through an approved authenticated, access-controlled channel; log retrieval without logging archive contents.

4. **Prepare a deletion preview, then obtain explicit approval.** Generate a versioned manifest identifying exact targets, dependency order, proposed delete/anonymize/retain/revoke actions, expected counts/bytes, exceptions, and unresolved provider outcomes. Show backup and billing impact separately. Bind approval to the request, org, manifest digest, source/schema version, and current data state. Require a fresh preview/approval if targets change. A separate reviewer is recommended; the owner must select the approval arrangement. Preview execution must be demonstrably read-only.

5. **Quiesce, reconcile, then execute only an approved plan.** Implement an org-scoped lifecycle hold covering public intake, staff/API writes, OAuth reconnect, automated sends, scheduled work, and callbacks; do not stop other tenants. Revalidate the preview after the hold. Resolve in-flight/indeterminate effects without retrying them. Complete approved credential/session revocation and separately track provider confirmation. Only then execute exact approved database/object changes with durable checkpoints and bounded retries. Fail closed on ownership ambiguity, count drift, holds, shared references, or unclassified data. Never erase an execution receipt to make an uncertain action retryable.

6. **Reconcile and close honestly.** Independently compare final counts/object presence/access against the manifest. Preserve minimal approved evidence: request/approval references, manifest hash, version, timestamps, counts, failure categories, provider confirmations, and retained exceptions. Completion states must distinguish exported, locally erased, provider pending, backup retained, blocked, and verified complete. A customer-facing response needs explicit authorization and must name unresolved categories rather than claim universal erasure.

## 4. Exceptions the implementation must resolve

- **Users and sessions:** [users](lib/db/src/schema/auth.ts) currently have one nullable org association and globally unique email; there is no multi-org membership model to assume. Platform identities and unscoped session JSON still require explicit ownership analysis. [Identity tokens](lib/db/src/schema/identity-tokens.ts) link through users; [portal sessions](lib/db/src/schema/portal.ts) cover matching identifiers within an org. Never delete a global identity merely because an email appears in customer records.
- **Media:** [`stored_objects`](lib/db/src/schema/object-storage.ts) allows null org ownership, and the [storage adapter](artifacts/api-server/src/lib/objectStorage.ts) supports database and external objects. Unknown ownership or another retained reference must block deletion. Unlinking, deleting bytes, and external-provider confirmation are distinct outcomes.
- **Audit and replay prevention:** [`audit_events`](lib/db/src/schema/audit.ts) references both org and user; [Revenue Desk receipts/events](lib/db/src/schema/revenue-workspace.ts) carry idempotency state. Retaining evidence while deleting the parent needs an explicit design, not a cascading purge. Consent/suppression exceptions must prevent an import, webhook, or restored backup from resuming unwanted contact; their minimum retained form and period remain owner decisions.
- **Providers and backups:** Local deletion does not erase Gmail, Twilio, email/AI-provider records, Stripe records, logs, exported archives, or backups. Inventory actual configured systems without exporting credentials. Obtain separate authority for remote changes. Document verified backup scope/expiry and how an approved erasure ledger is reapplied in an isolated restore before reconnecting intake or outreach. Do not delete shared backups to satisfy one tenant's request.

## 5. Acceptance and safest build order

Build **inventory/export first**, then lifecycle holds/revocation tracking, then the read-only deletion planner and approval record, and destructive execution **last**. Run synthetic staging acceptance before any approved client operation; review disclosures only after demonstrated behavior is known.

Required evidence:

- Two-org negative tests on inventory, export, media, preview, execution and status; forged org IDs/identifiers must not reveal another org's existence or content.
- Complete schema classification, indirect/global ownership tests, unknown-table rejection, JSON-link coverage, orphan/shared media, and foreign-key-safe ordering.
- Export count reconciliation, pagination completeness, secret-leak canaries, restricted raw-content handling, authenticated delivery, and agreed expiry.
- Read-only preview proof; unauthorized/stale/changed-manifest approval rejection; hold-versus-scheduler/callback race tests; no provider traffic during dry runs.
- Crash/retry/resume and provider-timeout tests with no duplicate effects, no lost completion audit, preserved ambiguity, and independently verified final counts.
- Isolated backup-restore/re-erasure exercise; failed remote revocation shown as pending, retained exceptions disclosed, and operator rehearsal of a full request without customer data.

Passing code tests alone is insufficient: capture the approved operating decisions and supervised end-to-end evidence before claiming a supported lifecycle.
