import { expect, it } from 'vitest';
import { runContractorRecoveryDrill } from './contractor-recovery-drill.mjs';

it('upgrades the full prior schema, restores both synthetic companies, boots a read-only real app and preserves uncertainty/holds', async () => {
  const result = await runContractorRecoveryDrill({ emit: () => {} });
  expect(result.previousTableCount).toBe(90);
  expect(result.tableCount).toBe(99);
  expect(result.sourceFingerprint).toBe(result.restoredFingerprint);
  expect(result.appBootVerified).toBe(true);
  expect(result.readOnlyDatabaseVerified).toBe(true);
  expect(result.tenantBoundariesVerified).toBe(true);
  expect(result.postSnapshotMarkerAbsent).toBe(true);
  expect(result.uncertainCheckoutPreserved).toBe(true);
  expect(result.replyHoldSurvivesRawDeletion).toBe(true);
  expect(result.tableCounts.staff_invitations).toBe(2);
  expect(result.providerCalls).toBe(0);
  expect(result.managedBackupRestoreVerified).toBe(false);
}, 120_000);
