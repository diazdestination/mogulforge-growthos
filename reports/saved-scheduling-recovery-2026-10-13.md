# Saved scheduling recovery and writable rollback boundary

Local verification passed on 2026-10-14: 32 tests across three files, all 91 original Reader checks, and the standalone actual-app recovery drill. This report does not authorize a release, hosted migration, provider activation, or writable rollback to PR57.

The recovery harness uses the actual bundled API on loopback, an in-memory PGlite source, a genuine read-only restored Reader, and three independent writable restored clones. It never makes the Reader writable. Its exact production checkpoint, source tree, dirty scope and diff, harness source hashes, ten bundle/worker/map hashes, build stamp, SQL/catalog identities, synthetic command-sidecar hash, snapshot hash, and clone fingerprints are emitted in the recovery receipt. A dirty build keeps its actual null release SHA.

The additive upgrade preserves 142 table identities, prior rows/columns/constraints, all 19 canonical predecessor SQL pins, and three new nullable JSONB columns. It executes exact 0019 bytes and verifies SQL NULL legacy policy/reservations, the existing two-hour appointment and one-day project fallback, and legacy zero travel gap. Historical packets are unchanged.

The synthetic source creates a larger saved appointment gap and a project whose resource-release revision retains the surviving resource's original protection, alongside a terminal project, a deleted target, a permanent refused operation, an absent-operation fence, disabled/unconfigured policy, and native returning-work/service-care/CALLIE outcomes. Before and after restore, raw rows, policy, snapshots, private audits and source receipts must match. Actual original commands then return the same six manual outcomes and three source outcomes even after the current policy digest becomes invalid. Changed payload, actor and foreign organization fail closed. All business rows remain unchanged on replay; CALLIE's real request middleware increments exactly its one child-specific request counter per replay.

The actual manager export preserves all 28 datasets, their ordering and data-only digest, closed policy/history hashes, deleted-target unavailability, invalid record/link withholding and privacy. Corrupt current policy exports null with invalid state. A 2001-row scheduling-evidence case returns HTTP 413 without partial data or an export audit. Export requests use the writable clone because a successful export deliberately records an audit.

Each reduced/disabled policy clone proves a positive HTTP 201 control, then the old saved appointment and released-project gap reject a new booking at end plus 59 minutes. The exact refusal is HTTP 409 `manual_scheduling_refused`, original outcome `no_commit_refused`, reason `travel_conflict`, exactly two intended audit rows and zero other table changes. End plus 60 minutes succeeds. Generic read-only, auth, stale-context or server errors cannot satisfy the checks.

The historical run at `c54122be5e110b2d33173a9d60f870cd888db89b` passed writable modes but failed the preserved Reader service-care GET with HTTP 500 / PostgreSQL SQLSTATE 25006 at `users FOR SHARE`. Its failed receipts remain retained. Root separately reviewed and integrated the correction before authorizing the final production checkpoint `5f80131a0d4b91be2e55d4eeb3d9145a99bf822c`, tree `effe897dd5531c21b24360522d8a76520a43a466`. At that checkpoint the same Reader role, actual read-only transaction, SQL write denial, HTTP 405 checks and unchanged post-probe fingerprint all pass. Service care returns a closed held `scheduling_reader_required` review for the same actor/company; it never supplies a ready context. Ordinary writable source locks remain production code, unchanged by this harness.

Release eligibility remains **HELD**. A repeated local candidate is only local restored-enforcement evidence. No second independently reviewed compatible artifact or complete scheduling mutation hold has been verified; prefeature PR57 is not a writable-compatible rollback target. PGlite results do not establish real PostgreSQL contention, hosted backup recovery, production RPO/RTO, provider behavior, fresh uppercase source-command writes, or deployment reversal.

Only call-owned child processes, loopback sockets, in-memory databases and the exact validated `.contractor-recovery-*` build directory are cleaned. Failed runs preserve redacted failure and per-resource cleanup receipts. No sweep, old-drill deletion, schema down-migration, customer data, external provider action or hosted resource is part of this proof.

Final required command: `pnpm --filter @workspace/scripts exec vitest run contractor-recovery-drill.test.mjs release-schema.test.mjs saved-scheduling-rollback-boundary.test.mjs` — **32/32 passed**, three files, 2026-10-14 14:16:28 PDT, 32.45 seconds. The standalone `pnpm --filter @workspace/scripts exec node contractor-recovery-drill.mjs` also exited 0; its final receipt below records 31,278 ms elapsed. The existing pnpm configuration warning was observed; no install or toolchain change was made.

The production source/tree pin is independent of this harness commit. The clean Git commit containing this report is the review checkpoint, with parent `5f80131a0d4b91be2e55d4eeb3d9145a99bf822c`. The runtime harness bytes match the receipt's source-file hashes; this report was finalized after capture. The measured build was made before commit from the explicitly listed dirty harness scope, and its actual release SHA is null. No later clean-build claim or second rollback artifact is inferred. Fresh independent recovery review remains the next gate.

The following JSON is the complete redacted final CLI receipt: exact emitted file/worker bytes, canonical/checkout/executed SQL identities, actual schema identity, fixture/snapshot hashes, closed outcome checks, frozen source scope and cleanup. All values are synthetic or source/artifact metadata; private command bodies and credentials are absent.

```json
{
  "check": "contractor_synthetic_upgrade_restore",
  "engine": "PGlite embedded PostgreSQL",
  "commit": "5f80131a0d4b91be2e55d4eeb3d9145a99bf822c",
  "trackedDiffSha256": "8925e5a1fa41fe9f08d40cc24a9e6e367351900afd2299c9e7d8802e795c6b77",
  "candidateCommitted": false,
  "migrations": [
    {
      "file": "0002_mobile-microsoft-pilot.sql",
      "sha256": "eec075e1009718e9307a0e88b905098749b337211abc87f0bfdb49c38c5138d0"
    },
    {
      "file": "0003_swarm-foundation.sql",
      "sha256": "dac2d1782d71d89e7f14ae1dc73d06a9e094b25a77a1c3ea6e5abbd5b1ba44fc"
    },
    {
      "file": "0004_beta-operations.sql",
      "sha256": "2f4a87900b0e2f6b7c85f4ac177d2d64c44ac49c40fbd4f429777ec71b2b6e95"
    },
    {
      "file": "0005_contractor-operations.sql",
      "sha256": "8cd09ae5ce8f6fc19a4a89cd80fa728dc9dc68918f4e87c86a3d2bede3ea10d8"
    },
    {
      "file": "0006_native-contractor-day.sql",
      "sha256": "4406ec9b61bedfdf2fd172272fbb7782f863b023eeb3d0ff28a867f1a6ca9c80"
    },
    {
      "file": "0007_customer-care.sql",
      "sha256": "028297f0c78268dad1c42815513b633f9b1cb742f5a1bf5605dab1006e8dabcb"
    },
    {
      "file": "0008_operations-wave.sql",
      "sha256": "33dcb364229ab9bf8a05270cae9b17e4052fdbd1ed2db0fb83d050cd1acb36f6"
    },
    {
      "file": "0009_launch-communications.sql",
      "sha256": "813d3fca929f462644d7399f5314ff4e358f24ff05817f9f7851f290a8ff89ca"
    },
    {
      "file": "0010_lead-replies.sql",
      "sha256": "f385f2a11f08f709788395a937ced3a3508af9aa1d570064106182f520085717"
    },
    {
      "file": "0011_invoice-recovery.sql",
      "sha256": "c9491ff8eef505d8e784e004cf97af7192cefa9701f5fa2eeb3d599e6a0de063"
    },
    {
      "file": "0012_callie-intake.sql",
      "sha256": "ef48cf4d68d3da7aeb97acf4c5a97c06152c2f7eae2d4319c4aa2153cb7ce480"
    },
    {
      "file": "0013_standing-service.sql",
      "sha256": "010c13b648a442f34801b9c30f5dde6f824cce0f897d7a98866e8f8a4a1beb39"
    },
    {
      "file": "0014_source-nurture.sql",
      "sha256": "958aebae4e5509acd28892b0b30a9413bfe8c9ddebed868a2f7a0defaec3b83e"
    },
    {
      "file": "0015_callie-conversation.sql",
      "sha256": "8b75fecb5250a5e9920fac2e7bcd9b734a3ba8f20c8a78d21f66f4853639dc33"
    },
    {
      "file": "0016_contractor-workday.sql",
      "sha256": "aa15f891c013ce6a5e71107d973f04ee3cc4c46ca6030e54ac4490cf52147b89"
    },
    {
      "file": "0017_returning-customer-work.sql",
      "sha256": "d6d0319830a26ab9387a6ef5952dd5409adb4feeac76a8a2d71d78c7e0e07da8"
    },
    {
      "file": "0018_lead-alert-coverage.sql",
      "sha256": "b5c6425dc7942460e4d734e14f971e8fc062b1bdfe292d69d22a88e34be587a1"
    },
    {
      "file": "0019_saved-scheduling-policy.sql",
      "sha256": "76e88d3410235f1b6a8a20e595b126455fd5711b46f87055b586786b28f81ca9"
    }
  ],
  "tableCount": 142,
  "previousTableCount": 90,
  "sourceFingerprint": "d8bcc9d81e41b8d7745731a5db093477d599f79aacb0e7195fc4800896108dce",
  "restoredFingerprint": "d8bcc9d81e41b8d7745731a5db093477d599f79aacb0e7195fc4800896108dce",
  "snapshotSha256": "1a95c4192e82d9bf0732ab7053dd48c0c80d9532f0558f126784c77c8124b5a6",
  "tableCounts": {
    "activities": 4,
    "appointment_work_completions": 4,
    "appointment_work_entries": 6,
    "appointment_work_photos": 4,
    "appointments": 68,
    "audit_events": 63,
    "bie_action_proposals": 2,
    "billing_checkouts": 2,
    "callie_ack_dispatches": 2,
    "callie_intakes": 5,
    "callie_policy_revisions": 9,
    "callie_reception_bindings": 2,
    "callie_reception_events": 2,
    "callie_reception_sessions": 2,
    "consent_records": 2,
    "contact_touch_reservations": 2,
    "contacts": 15,
    "crm_tasks": 29,
    "customer_lifecycle": 2,
    "customer_work_commands": 9,
    "customer_work_roots": 7,
    "decision_rooms": 2,
    "email_intelligence_sources": 2,
    "email_response_reviews": 6,
    "estimates": 4,
    "financial_migration_items": 4,
    "financial_migration_reviews": 2,
    "gmail_connections": 2,
    "invoice_delivery_attempts": 6,
    "invoice_operations": 2,
    "invoice_receipt_allocations": 10,
    "invoice_sequences": 2,
    "invoices": 8,
    "leads": 7,
    "mailbox_communication_parents": 6,
    "mailbox_connectors": 2,
    "mailbox_receipts": 6,
    "mailbox_service_replies": 2,
    "mailbox_sync_cycles": 2,
    "missed_call_care_cases": 2,
    "missed_call_care_policies": 2,
    "missed_call_handoffs": 7,
    "org_settings": 3,
    "organizations": 9,
    "platform_email_dispatches": 2,
    "platform_email_events": 2,
    "project_stories": 2,
    "projects": 12,
    "properties": 65,
    "property_assets": 4,
    "rate_limit_counters": 2,
    "revenue_execution_events": 26,
    "revenue_executions": 20,
    "scheduled_actions": 9,
    "service_obligations": 15,
    "service_sms_parents": 2,
    "service_sms_replies": 4,
    "service_standing_enrollments": 2,
    "service_standing_policy_revisions": 4,
    "service_watch_cases": 2,
    "sessions": 12,
    "source_adoptions": 4,
    "source_nurture_items": 2,
    "source_nurture_plans": 2,
    "source_nurture_steps": 4,
    "source_outreach_batches": 2,
    "source_outreach_items": 2,
    "staff_invitations": 2,
    "staff_lead_alert_coverage": 2,
    "staff_push_deliveries": 4,
    "staff_push_policies": 2,
    "staff_push_subscriptions": 2,
    "stored_objects": 4,
    "twilio_calls": 7,
    "twilio_client_bindings": 5,
    "twilio_dispatches": 2,
    "twilio_inbound_events": 6,
    "users": 12,
    "value_entries": 10,
    "work_checklist_revisions": 4,
    "work_checklist_templates": 2
  },
  "preservedPriorRecords": true,
  "credentialDecryptVerified": true,
  "wrongKeyAndContextRejected": true,
  "uncertainCheckoutPreserved": true,
  "companyHoldPreserved": true,
  "pendingInvitationPreserved": true,
  "replyHoldSurvivesRawDeletion": true,
  "postSnapshotMarkerAbsent": true,
  "issuedInvoiceSnapshotPreserved": true,
  "invoiceNumberingPreserved": true,
  "receiptReversalPreservesCash": true,
  "recurringServiceSuccessorPreserved": true,
  "pausedServiceExceptionVerified": true,
  "missedCallUncertaintyPreserved": true,
  "careTenantForeignKeysVerified": true,
  "disabledCarePoliciesPreserved": true,
  "operationsTenantChecks": 13,
  "heldServiceWatchPreserved": true,
  "revokedSourceAdoptionPreserved": true,
  "permanentSourceReservationPreserved": true,
  "noncashOpeningReceivablePreserved": true,
  "typedPushUncertaintyPreserved": true,
  "launchCommunicationTenantChecks": 6,
  "serviceReplyHoldAfterPurgePreserved": true,
  "disabledMailboxPreserved": true,
  "platformIdentityUncertaintyPreserved": true,
  "leadReplyTenantChecks": 6,
  "leadReplyHoldAfterPurgePreserved": true,
  "leadReplyOfficeTaskPreserved": true,
  "leadMonitoringRemainsDisabled": true,
  "invoiceRecoveryConstraintChecks": 9,
  "invoiceUnknownChainPreserved": true,
  "typedNoDispatchProofPreserved": true,
  "callieConstraintChecks": 12,
  "callieUnknownGrantPreserved": true,
  "callieDisabledHeadPreserved": true,
  "callieUnverifiedCallerPreserved": true,
  "callieChallengeEncryptionVerified": true,
  "standingServiceConstraintChecks": 14,
  "standingDisabledHeadPreserved": true,
  "standingUnknownSendPreserved": true,
  "serviceSmsHoldAfterPurgePreserved": true,
  "ambiguousServiceSmsPreserved": true,
  "nurtureConstraintChecks": 15,
  "nurtureStoppedOwnershipPreserved": true,
  "nurtureUnknownNeverAdvanced": true,
  "nurtureFailedSyncPreserved": true,
  "nurtureReplyHoldAfterPurgePreserved": true,
  "workdayConstraintChecks": 16,
  "workdayCapturedHistoryPreserved": true,
  "returningPreviousTableCount": 139,
  "returningLegacyRowsUnchanged": true,
  "returningConstraintChecks": 16,
  "alertCoveragePreviousTableCount": 141,
  "alertCoveragePriorRowsUnchanged": true,
  "alertCoverageConstraintChecks": 12,
  "originalAlertCoveragePreserved": true,
  "missingAlertEffectsRemainUnknown": true,
  "legacyAlertCoverageRemainsUnknown": true,
  "returningCustomerLineagePreserved": true,
  "returningCommandResultsPreserved": true,
  "returningWorkScopedReceiptsPreserved": true,
  "returningV3UnknownOwnershipPreserved": true,
  "workdayImmutableRevisionPreserved": true,
  "workdayPrivatePhotosPreserved": true,
  "workdayNoAcquisitionLeadCreated": true,
  "workdayReadVerified": true,
  "callieConversationConstraintChecks": 29,
  "callieConversationUnknownEffectsPreserved": true,
  "callieConversationStaffWorkPreserved": true,
  "callieConversationContentPurgePreserved": true,
  "callieConversationDisabledHeadPreserved": true,
  "callieConversationEncryptionVerified": true,
  "callieConversationLegacySeparated": true,
  "appBootVerified": true,
  "readOnlyDatabaseVerified": true,
  "readOnlySchedulingHeldVerified": true,
  "tenantBoundariesVerified": true,
  "customerWorkspaceVerified": true,
  "callieConversationReadVerified": true,
  "returningCustomerReadVerified": true,
  "returningV3UnknownReadVerified": true,
  "readChecks": 91,
  "writeBlocked": true,
  "restoreVerificationMs": 15243,
  "elapsedMs": 31278,
  "providerCalls": 0,
  "managedBackupRestoreVerified": false,
  "productionRpoRtoEstablished": false,
  "scheduling": {
    "schema": {
      "priorRowsUnchanged": true,
      "priorCatalogUnchanged": true,
      "tableCount": 142,
      "addedColumns": [
        "appointments.scheduling_reservation",
        "org_settings.scheduling_policy",
        "projects.scheduling_reservation"
      ],
      "predecessors": [
        {
          "path": "reports/staging-schema-preview-2026-09-30/0000_isolated-staging-initial.sql",
          "gitBlobBytes": 116856,
          "gitBlobSha256": "b27d33a59a8a0f083fefe3271936d197309db5d683bd4254bbd28d7bc7315a10",
          "gitBlob": "5644d92a83072f587326c72dc28d0609cf36ebf0",
          "checkoutSha256": "52b900fad500e0d9c214fb97f5abb05508224ae2176c248b463ddc5a3a3bf201",
          "executedSha256": "b27d33a59a8a0f083fefe3271936d197309db5d683bd4254bbd28d7bc7315a10"
        },
        {
          "path": "reports/staging-schema-preview-2026-09-30/0001_pilot-email-sender.sql",
          "gitBlobBytes": 318,
          "gitBlobSha256": "8d2d49f344e4900e5304d1f7b23ce23b929121f9af04362d50902a692605883f",
          "gitBlob": "907a565a033fa0813579805103595ddf83acf171",
          "checkoutSha256": "cb9f087d681d68925f2d984cb6a0d4c410b20c67e97682362926dc2a2fbeb841",
          "executedSha256": "8d2d49f344e4900e5304d1f7b23ce23b929121f9af04362d50902a692605883f"
        },
        {
          "path": "reports/staging-schema-preview-2026-10-01/0002_mobile-microsoft-pilot.sql",
          "gitBlobBytes": 5182,
          "gitBlobSha256": "eec075e1009718e9307a0e88b905098749b337211abc87f0bfdb49c38c5138d0",
          "gitBlob": "5b3365348ce948022a084cdb2a4f47d93c544695",
          "checkoutSha256": "b5b6b76151fc246671130974386df9d5e3bdeb5e643f314f65507f0d43d50df5",
          "executedSha256": "eec075e1009718e9307a0e88b905098749b337211abc87f0bfdb49c38c5138d0"
        },
        {
          "path": "reports/staging-schema-preview-2026-10-01/0003_swarm-foundation.sql",
          "gitBlobBytes": 1064,
          "gitBlobSha256": "dac2d1782d71d89e7f14ae1dc73d06a9e094b25a77a1c3ea6e5abbd5b1ba44fc",
          "gitBlob": "041ce1cb26150ddc023bcd67af3722f543f526ac",
          "checkoutSha256": "07a071578dfdb37953eccea493ecf7a61549ff0ba05fbe21cd5d9539315441d7",
          "executedSha256": "dac2d1782d71d89e7f14ae1dc73d06a9e094b25a77a1c3ea6e5abbd5b1ba44fc"
        },
        {
          "path": "reports/staging-schema-preview-2026-10-01/0004_beta-operations.sql",
          "gitBlobBytes": 3713,
          "gitBlobSha256": "2f4a87900b0e2f6b7c85f4ac177d2d64c44ac49c40fbd4f429777ec71b2b6e95",
          "gitBlob": "12ffbc8ca1a9547a8df8c1e6b9c89b12f9ca059a",
          "checkoutSha256": "28147940685931cb62ba3f61eec332503961f469b6240ab8c1e6c4932d979882",
          "executedSha256": "2f4a87900b0e2f6b7c85f4ac177d2d64c44ac49c40fbd4f429777ec71b2b6e95"
        },
        {
          "path": "reports/staging-schema-preview-2026-10-01/0005_contractor-operations.sql",
          "gitBlobBytes": 5224,
          "gitBlobSha256": "8cd09ae5ce8f6fc19a4a89cd80fa728dc9dc68918f4e87c86a3d2bede3ea10d8",
          "gitBlob": "a6b79beab1fbf987727725428b5db57eac714b6c",
          "checkoutSha256": "c7b96ec940cd50b278c31638213ea08b93f749c54a8b7a4651776595effe376b",
          "executedSha256": "8cd09ae5ce8f6fc19a4a89cd80fa728dc9dc68918f4e87c86a3d2bede3ea10d8"
        },
        {
          "path": "reports/staging-schema-preview-2026-10-01/0006_native-contractor-day.sql",
          "gitBlobBytes": 8008,
          "gitBlobSha256": "4406ec9b61bedfdf2fd172272fbb7782f863b023eeb3d0ff28a867f1a6ca9c80",
          "gitBlob": "43b72e0adb1f134823f2c1c5887e2f7067ee7e9e",
          "checkoutSha256": "2ecb746a96679b8c4723f0e7497247e14436b8391a9ea35254ef79038e6c0d39",
          "executedSha256": "4406ec9b61bedfdf2fd172272fbb7782f863b023eeb3d0ff28a867f1a6ca9c80"
        },
        {
          "path": "reports/staging-schema-preview-2026-10-01/0007_customer-care.sql",
          "gitBlobBytes": 3748,
          "gitBlobSha256": "028297f0c78268dad1c42815513b633f9b1cb742f5a1bf5605dab1006e8dabcb",
          "gitBlob": "e4a8639958e02b4016273fe26b21ec31f8fb253f",
          "checkoutSha256": "064480b2240fc0bf5526a43a35d5adaaa3e784353629d7d30ad97a5a02dab34f",
          "executedSha256": "028297f0c78268dad1c42815513b633f9b1cb742f5a1bf5605dab1006e8dabcb"
        },
        {
          "path": "reports/staging-schema-preview-2026-10-01/0008_operations-wave.sql",
          "gitBlobBytes": 16278,
          "gitBlobSha256": "33dcb364229ab9bf8a05270cae9b17e4052fdbd1ed2db0fb83d050cd1acb36f6",
          "gitBlob": "ead39a61e4045cfafa5647a3579d60b8d8bd6887",
          "checkoutSha256": "8352dabe69c8c93721481a5b21df47c037b1ed368357151cd733715522859860",
          "executedSha256": "33dcb364229ab9bf8a05270cae9b17e4052fdbd1ed2db0fb83d050cd1acb36f6"
        },
        {
          "path": "reports/staging-schema-preview-2026-10-01/0009_launch-communications.sql",
          "gitBlobBytes": 15004,
          "gitBlobSha256": "813d3fca929f462644d7399f5314ff4e358f24ff05817f9f7851f290a8ff89ca",
          "gitBlob": "128186e40b1981cc29cb1d131d13df3fc87e069d",
          "checkoutSha256": "7609d74d14ee1629790c140b1a086488ad2c66b19dec1d7ca077f72ac58b6734",
          "executedSha256": "813d3fca929f462644d7399f5314ff4e358f24ff05817f9f7851f290a8ff89ca"
        },
        {
          "path": "reports/staging-schema-preview-2026-10-01/0010_lead-replies.sql",
          "gitBlobBytes": 3976,
          "gitBlobSha256": "f385f2a11f08f709788395a937ced3a3508af9aa1d570064106182f520085717",
          "gitBlob": "51a4d525c07fd1b1fc33a83d22d6ac8b05de51a5",
          "checkoutSha256": "35cd388146e714a307c1913e689417a8631b447ea5951a54e7107410b1df8e48",
          "executedSha256": "f385f2a11f08f709788395a937ced3a3508af9aa1d570064106182f520085717"
        },
        {
          "path": "reports/staging-schema-preview-2026-10-01/0011_invoice-recovery.sql",
          "gitBlobBytes": 5882,
          "gitBlobSha256": "c9491ff8eef505d8e784e004cf97af7192cefa9701f5fa2eeb3d599e6a0de063",
          "gitBlob": "d77c5089c70e095e0330de664f31b029fc973a7c",
          "checkoutSha256": "bab9a5d58e077656cc57c7407dc995c7cfefcbbf6c6994928e2b80808c88fcb4",
          "executedSha256": "c9491ff8eef505d8e784e004cf97af7192cefa9701f5fa2eeb3d599e6a0de063"
        },
        {
          "path": "reports/staging-schema-preview-2026-10-01/0012_callie-intake.sql",
          "gitBlobBytes": 11938,
          "gitBlobSha256": "ef48cf4d68d3da7aeb97acf4c5a97c06152c2f7eae2d4319c4aa2153cb7ce480",
          "gitBlob": "0641160fd787155ece8902dc48b0be3a2855c6ca",
          "checkoutSha256": "d7b3a1e97e739bde9c8ea858419622c2f44d832e88cba02cf99962c00d357206",
          "executedSha256": "ef48cf4d68d3da7aeb97acf4c5a97c06152c2f7eae2d4319c4aa2153cb7ce480"
        },
        {
          "path": "reports/staging-schema-preview-2026-10-01/0013_standing-service.sql",
          "gitBlobBytes": 15206,
          "gitBlobSha256": "010c13b648a442f34801b9c30f5dde6f824cce0f897d7a98866e8f8a4a1beb39",
          "gitBlob": "ea54ae2b5d3382ced10c9c945f962cf493137f12",
          "checkoutSha256": "e5381b286bf2976ba32f2c6fef7f4dc32ec73389223c737a366ef2c8b5a2f9ae",
          "executedSha256": "010c13b648a442f34801b9c30f5dde6f824cce0f897d7a98866e8f8a4a1beb39"
        },
        {
          "path": "reports/staging-schema-preview-2026-10-01/0014_source-nurture.sql",
          "gitBlobBytes": 17176,
          "gitBlobSha256": "958aebae4e5509acd28892b0b30a9413bfe8c9ddebed868a2f7a0defaec3b83e",
          "gitBlob": "bd680d2a60b7d401a2e2b99afae34fa818f64da4",
          "checkoutSha256": "bf28df0c19e1bd0181a69886cfc7176148fda5d3f55b29214d3804a1d50d8fa6",
          "executedSha256": "958aebae4e5509acd28892b0b30a9413bfe8c9ddebed868a2f7a0defaec3b83e"
        },
        {
          "path": "reports/staging-schema-preview-2026-10-01/0015_callie-conversation.sql",
          "gitBlobBytes": 12455,
          "gitBlobSha256": "8b75fecb5250a5e9920fac2e7bcd9b734a3ba8f20c8a78d21f66f4853639dc33",
          "gitBlob": "7968b34f5c038fe5f23c231dcc70124d3256184d",
          "checkoutSha256": "92724e6c4978871f19e974a0b7f2380e3ce7ebfdbbee4f3120c20f3aa278990d",
          "executedSha256": "8b75fecb5250a5e9920fac2e7bcd9b734a3ba8f20c8a78d21f66f4853639dc33"
        },
        {
          "path": "reports/staging-schema-preview-2026-10-01/0016_contractor-workday.sql",
          "gitBlobBytes": 15706,
          "gitBlobSha256": "aa15f891c013ce6a5e71107d973f04ee3cc4c46ca6030e54ac4490cf52147b89",
          "gitBlob": "8ecb20a2afc539e86ccf78dc1b2190deef2cb187",
          "checkoutSha256": "a9fdcafbcfc380f8092869314bc98fd81c9a3d11dccf5ab97e85fcb6566ffd13",
          "executedSha256": "aa15f891c013ce6a5e71107d973f04ee3cc4c46ca6030e54ac4490cf52147b89"
        },
        {
          "path": "reports/staging-schema-preview-2026-10-01/0017_returning-customer-work.sql",
          "gitBlobBytes": 9675,
          "gitBlobSha256": "d6d0319830a26ab9387a6ef5952dd5409adb4feeac76a8a2d71d78c7e0e07da8",
          "gitBlob": "7757de441e89cfb06d67be10c6137590ccb87773",
          "checkoutSha256": "68f1734fa340eb9b094e834625baa8e8f700fdb455741b2cd436c2a4b8ae5c84",
          "executedSha256": "d6d0319830a26ab9387a6ef5952dd5409adb4feeac76a8a2d71d78c7e0e07da8"
        },
        {
          "path": "reports/staging-schema-preview-2026-10-01/0018_lead-alert-coverage.sql",
          "gitBlobBytes": 2335,
          "gitBlobSha256": "b5c6425dc7942460e4d734e14f971e8fc062b1bdfe292d69d22a88e34be587a1",
          "gitBlob": "2eeb0539b6574533b5b3a0c4446b7197afe3d527",
          "checkoutSha256": "84687ab41c885b2cfec16d23e5dc2e1386b0e689edb9f425f972e393f63b721c",
          "executedSha256": "b5c6425dc7942460e4d734e14f971e8fc062b1bdfe292d69d22a88e34be587a1"
        }
      ],
      "baseExecutedSha256": "6eb23608ccdcfb9e297fdd25f76546e7f50d136512a57b8189ad30906a3a4baa",
      "delta": {
        "path": "reports/staging-schema-preview-2026-10-01/0019_saved-scheduling-policy.sql",
        "gitBlob": "f242fadd3659439fa6bd9fae72d8f92cb63cda51",
        "gitBlobBytes": 8126,
        "gitBlobSha256": "76e88d3410235f1b6a8a20e595b126455fd5711b46f87055b586786b28f81ca9",
        "checkoutSha256": "76e88d3410235f1b6a8a20e595b126455fd5711b46f87055b586786b28f81ca9",
        "executedSha256": "76e88d3410235f1b6a8a20e595b126455fd5711b46f87055b586786b28f81ca9"
      },
      "schemaSha256": "81a6615344994e7465657b48311c6d9cbc75ac76ed61a3849a5680af2a3c92e4",
      "sqlSha256": "38d8c9b5bedf30d18dfb7e3b68c61a6a47f918fdd807f5c805c198a210a7404f"
    },
    "originalStatePreserved": true,
    "originalOutcomesPreserved": true,
    "legacyCompatibilityVerified": true,
    "invalidPolicyWithheld": true,
    "exportBoundVerified": true,
    "exportDatasetCount": 28,
    "exportSha256": "ff0a5f764dc2988bb91904eebb291d68af56f9b1212629e6ede04e0483c75d31",
    "manualOutcomes": 6,
    "sourceOutcomes": 3,
    "callieReplayRateCounterIncrements": 2,
    "artifactBuildStamp": {
      "sha": null,
      "builtAt": "2026-10-14T21:17:22.846Z",
      "environment": "test"
    },
    "providerCalls": 0,
    "writerIdentityVerified": true,
    "startingFingerprint": "d8bcc9d81e41b8d7745731a5db093477d599f79aacb0e7195fc4800896108dce",
    "priorFixtureTableCounts": {
      "customer_work_roots": 6,
      "customer_work_commands": 8,
      "callie_policy_revisions": 8,
      "callie_intakes": 4
    },
    "identity": {
      "sourceCommit": "5f80131a0d4b91be2e55d4eeb3d9145a99bf822c",
      "sourceTree": "effe897dd5531c21b24360522d8a76520a43a466",
      "schemaSha256": "81a6615344994e7465657b48311c6d9cbc75ac76ed61a3849a5680af2a3c92e4",
      "sqlSha256": "38d8c9b5bedf30d18dfb7e3b68c61a6a47f918fdd807f5c805c198a210a7404f",
      "fixtureSha256": "fed854b76c97734cd9a76c3f723db2fca24576e0a60a765bfa75433f67f9cb2c"
    },
    "artifact": {
      "sourceCommit": "5f80131a0d4b91be2e55d4eeb3d9145a99bf822c",
      "sourceTree": "effe897dd5531c21b24360522d8a76520a43a466",
      "schemaSha256": "81a6615344994e7465657b48311c6d9cbc75ac76ed61a3849a5680af2a3c92e4",
      "sqlSha256": "38d8c9b5bedf30d18dfb7e3b68c61a6a47f918fdd807f5c805c198a210a7404f",
      "fixtureSha256": "fed854b76c97734cd9a76c3f723db2fca24576e0a60a765bfa75433f67f9cb2c",
      "files": [
        {
          "path": "contractor-recovery-entry.mjs",
          "bytes": 18975606,
          "sha256": "1e6148d70f208a4202f4ccb8bd6b13cc16a19f624ed2510e612d4d629c084774"
        },
        {
          "path": "contractor-recovery-entry.mjs.map",
          "bytes": 32376414,
          "sha256": "e40aa938f82a1a190adb35a89debfcfb8b4d3d326b45012b39831ace62631b21"
        },
        {
          "path": "pino-file.mjs",
          "bytes": 146854,
          "sha256": "39f1d58a66b6ca1be1d17fe5eb57f448ab5dc2a54106361321702cad0848e2fb"
        },
        {
          "path": "pino-file.mjs.map",
          "bytes": 234882,
          "sha256": "7521990805882dedf5fcd6deb6680036198d4fc6268e5d7c4845df39fb6f17eb"
        },
        {
          "path": "pino-pretty.mjs",
          "bytes": 118915,
          "sha256": "7324901dad9e93f326d94768853ae53452694f1af8dfa7e8f21cfd3d3ba52eb6"
        },
        {
          "path": "pino-pretty.mjs.map",
          "bytes": 208770,
          "sha256": "fbfd388c0817c0f07be5c2e72e6bdee0c79a55a46bbefea98854602eefb529d1"
        },
        {
          "path": "pino-worker.mjs",
          "bytes": 158640,
          "sha256": "c32080ce9ef9fd038c46cb205e4bd9eef14b588ac38279ebf9c3e6f61c2e53db"
        },
        {
          "path": "pino-worker.mjs.map",
          "bytes": 263394,
          "sha256": "66dbb721417271cd9300799a1b677e298660119ef4309f245456ba735ea2187f"
        },
        {
          "path": "thread-stream-worker.mjs",
          "bytes": 7911,
          "sha256": "fb1b9249db85d5e75149e41e2a19c708d4d38a32842a970aa35fee71430b74e5"
        },
        {
          "path": "thread-stream-worker.mjs.map",
          "bytes": 12464,
          "sha256": "02098a968a0b4f7b9ba1ee669f491a8131f17fad13ef78a010c3b6db30bc4761"
        }
      ],
      "artifactSha256": "bf0dc011fe85e4f690a707ba27febe98d5dd511497dcf874d31168ee6ea577c5"
    },
    "enforcement": {
      "sourceCommit": "5f80131a0d4b91be2e55d4eeb3d9145a99bf822c",
      "sourceTree": "effe897dd5531c21b24360522d8a76520a43a466",
      "schemaSha256": "81a6615344994e7465657b48311c6d9cbc75ac76ed61a3849a5680af2a3c92e4",
      "sqlSha256": "38d8c9b5bedf30d18dfb7e3b68c61a6a47f918fdd807f5c805c198a210a7404f",
      "fixtureSha256": "fed854b76c97734cd9a76c3f723db2fca24576e0a60a765bfa75433f67f9cb2c",
      "artifactSha256": "bf0dc011fe85e4f690a707ba27febe98d5dd511497dcf874d31168ee6ea577c5",
      "engine": "PGlite embedded PostgreSQL",
      "restoredFingerprint": "d8bcc9d81e41b8d7745731a5db093477d599f79aacb0e7195fc4800896108dce",
      "cases": [
        {
          "policy": "reduced",
          "targetKind": "appointment",
          "controlStatus": 201,
          "refusedStatus": 409,
          "code": "manual_scheduling_refused",
          "outcome": "no_commit_refused",
          "refusalCode": "travel_conflict",
          "auditInserts": 2,
          "otherWrites": 0,
          "equalityStatus": 201
        },
        {
          "policy": "reduced",
          "targetKind": "project",
          "controlStatus": 201,
          "refusedStatus": 409,
          "code": "manual_scheduling_refused",
          "outcome": "no_commit_refused",
          "refusalCode": "travel_conflict",
          "auditInserts": 2,
          "otherWrites": 0,
          "equalityStatus": 201
        },
        {
          "policy": "disabled",
          "targetKind": "appointment",
          "controlStatus": 201,
          "refusedStatus": 409,
          "code": "manual_scheduling_refused",
          "outcome": "no_commit_refused",
          "refusalCode": "travel_conflict",
          "auditInserts": 2,
          "otherWrites": 0,
          "equalityStatus": 201
        },
        {
          "policy": "disabled",
          "targetKind": "project",
          "controlStatus": 201,
          "refusedStatus": 409,
          "code": "manual_scheduling_refused",
          "outcome": "no_commit_refused",
          "refusalCode": "travel_conflict",
          "auditInserts": 2,
          "otherWrites": 0,
          "equalityStatus": 201
        }
      ],
      "providerCalls": 0,
      "cleanupVerified": true
    },
    "sourceFiles": [
      {
        "path": "scripts/saved-scheduling-recovery-fixture.mjs",
        "sha256": "89e960e9db7d40fbc6bfa4891ea85ce5cb4b871c2bfd68afa56d2ebb532c52e1"
      },
      {
        "path": "scripts/contractor-recovery-drill.mjs",
        "sha256": "e5f9f09e9c95faa12e35ce9f48b5a4f868b7c592b5ea4112c60531eddfc5bc38"
      },
      {
        "path": "scripts/contractor-recovery-app-probe.mjs",
        "sha256": "bff23c748f3000e696dc7cfe0421596d4d3ccdd2673ac9f31d51c0b7b2fcdd19"
      },
      {
        "path": "scripts/release-schema.mjs",
        "sha256": "4eebd5977ef899e8d4105f5dccf98338a40bf543ffb025d0346d2b95efeaa73b"
      },
      {
        "path": "artifacts/api-server/build.mjs",
        "sha256": "2639e7104a5005e8abcae9b54b5a198ecc7db72b578f4391a21eb2657e253cf6"
      },
      {
        "path": "artifacts/api-server/build-identity.mjs",
        "sha256": "d904c927a4b7019b34e9af1cf50546f5e1cde6935f57ebccd7789b36686ca50c"
      },
      {
        "path": "artifacts/api-server/scripts/contractor-recovery-entry.ts",
        "sha256": "3fd6c60fac0e140a011aa4b83db3413e5c04ac84f47ec29293efb0321cb54244"
      },
      {
        "path": "pnpm-lock.yaml",
        "sha256": "e2ec957648e72701ca0db297dc2f1b2f250762643dfdddd44ad51db440973b2e"
      }
    ],
    "checkout": {
      "commit": "5f80131a0d4b91be2e55d4eeb3d9145a99bf822c",
      "tree": "effe897dd5531c21b24360522d8a76520a43a466",
      "dirtyScope": [
        "M scripts/contractor-recovery-app-probe.mjs",
        " M scripts/contractor-recovery-drill.mjs",
        " M scripts/contractor-recovery-drill.test.mjs",
        " M scripts/release-schema.mjs",
        "?? reports/saved-scheduling-recovery-2026-10-13.md",
        "?? scripts/saved-scheduling-recovery-fixture.mjs",
        "?? scripts/saved-scheduling-rollback-boundary.test.mjs"
      ],
      "trackedDiffSha256": "8925e5a1fa41fe9f08d40cc24a9e6e367351900afd2299c9e7d8802e795c6b77"
    },
    "runtime": {
      "node": "v24.19.0",
      "platform": "win32",
      "architecture": "x64",
      "postgres": "PostgreSQL 18.3 (PGlite 0.5.8) on wasm32-unknown-emscripten, compiled by emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 3.1.74 (1092ec30a3fb1d46b1782ff1b4db5094d3d06ae5), 32-bit"
    },
    "restoredClones": {
      "reconcile": "d8bcc9d81e41b8d7745731a5db093477d599f79aacb0e7195fc4800896108dce",
      "reduced": "d8bcc9d81e41b8d7745731a5db093477d599f79aacb0e7195fc4800896108dce",
      "disabled": "d8bcc9d81e41b8d7745731a5db093477d599f79aacb0e7195fc4800896108dce"
    },
    "cleanup": [
      {
        "kind": "app_child",
        "mode": "seed",
        "socketStopped": true,
        "childExited": true
      },
      {
        "kind": "app_child",
        "mode": "reconcile",
        "socketStopped": true,
        "childExited": true
      },
      {
        "kind": "app_child",
        "mode": "reduced",
        "socketStopped": true,
        "childExited": true
      },
      {
        "kind": "app_child",
        "mode": "disabled",
        "socketStopped": true,
        "childExited": true
      },
      {
        "kind": "app_child",
        "mode": "reader",
        "socketStopped": true,
        "childExited": true
      },
      {
        "kind": "database",
        "mode": "reconcile",
        "closed": true
      },
      {
        "kind": "database",
        "mode": "reduced",
        "closed": true
      },
      {
        "kind": "database",
        "mode": "disabled",
        "closed": true
      },
      {
        "kind": "database",
        "mode": "reader",
        "closed": true
      },
      {
        "kind": "database",
        "mode": "source",
        "closed": true
      },
      {
        "kind": "build",
        "name": ".contractor-recovery-UUQQBf",
        "removed": true
      }
    ],
    "cleanupVerified": true,
    "rollback": {
      "candidateCompatible": true,
      "releaseEligible": false,
      "reasons": [
        "second_compatible_artifact_unverified"
      ]
    }
  }
}
```
