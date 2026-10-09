/** Entirely synthetic local upgrade + snapshot/restore. Never accepts a DB URL. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { reviewedSchema } from './pilot-staging-bootstrap.mjs';
import { buildAll } from '../artifacts/api-server/build.mjs';
import { fixtureRows, fixtureIds, credentialCodec, FAKE_REFRESH_TOKEN, assertFixtureRecords } from './restore-drill-fixture.mjs';
import { nativeFixtureRows, nativeFixtureIds, sealNativeFixture, assertNativeFixture } from './native-contractor-recovery-fixture.mjs';
import { careFixtureRows, careFixtureIds, assertCareFixture, assertCareTenantKeys } from './customer-care-recovery-fixture.mjs';
import { operationsFixtureRows, sealOperationsFixture, assertOperationsFixture, assertOperationsTenantKeys } from './operations-wave-recovery-fixture.mjs';
import { launchCommunicationRows, sealLaunchCommunicationFixture, assertLaunchCommunications, assertLaunchCommunicationKeys } from './launch-communications-recovery-fixture.mjs';
import { seedLeadReplyFixture, assertLeadReplyFixture, assertLeadReplyTenantKeys } from './lead-replies-recovery-fixture.mjs';
import { invoiceRecoveryIds, seedInvoiceRecoveryFixture, assertInvoiceRecoveryFixture, assertInvoiceRecoveryKeys } from './invoice-recovery-fixture.mjs';
import { callieFixtureIds, seedCallieRecoveryFixture, assertCallieRecoveryFixture, assertCallieRecoveryKeys } from './callie-recovery-fixture.mjs';
import { standingServiceIds, seedStandingServiceRecovery, assertStandingServiceRecovery, assertStandingServiceKeys } from './standing-service-recovery-fixture.mjs';
import { sourceNurtureIds, seedSourceNurtureRecovery, assertSourceNurtureRecovery, assertSourceNurtureKeys } from './source-nurture-recovery-fixture.mjs';
import { seedCustomerWorkspaceFixture } from './customer-workspace-fixture.mjs';
import { CALLIE_CONVERSATION_RECOVERY_SLUGS, seedCallieConversationRecovery, assertCallieConversationRecovery, assertCallieConversationKeys } from './callie-conversation-recovery-fixture.mjs';
import { WORKDAY_RECOVERY_SLUGS, seedWorkdayRecovery, assertWorkdayRecovery, assertWorkdayKeys } from './contractor-workday-recovery-fixture.mjs';
import { returningCustomerIds, seedReturningCustomerRecovery, assertReturningCustomerRecovery, assertReturningCustomerKeys } from './returning-customer-recovery-fixture.mjs';
import { seedLeadAlertCoverage, assertLeadAlertCoverage, assertLeadAlertCoverageConstraints } from './lead-alert-coverage-recovery-fixture.mjs';

const requireApi = createRequire(new URL('../artifacts/api-server/package.json', import.meta.url));
const requireDb = createRequire(new URL('../lib/db/package.json', import.meta.url));
const { PGlite } = requireApi('@electric-sql/pglite');
const { PGLiteSocketServer } = requireApi('@electric-sql/pglite-socket');
const { generateDrizzleJson } = requireDb('drizzle-kit/api');
const root = fileURLToPath(new URL('../', import.meta.url));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const identifier = (name) => { if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('contractor_identifier_invalid'); return `"${name}"`; };
const jsonFields = new Set(['metadata', 'payload', 'evidence', 'options', 'line_items', 'draft_document', 'issued_document', 'recurrence', 'days', 'approved_snapshot', 'reasons', 'snapshot', 'settings', 'result', 'historical_source', 'policy', 'context_snapshot', 'recipients']);
const deltas = ['0002_mobile-microsoft-pilot.sql', '0003_swarm-foundation.sql', '0004_beta-operations.sql', '0005_contractor-operations.sql', '0006_native-contractor-day.sql', '0007_customer-care.sql', '0008_operations-wave.sql', '0009_launch-communications.sql', '0010_lead-replies.sql', '0011_invoice-recovery.sql', '0012_callie-intake.sql', '0013_standing-service.sql', '0014_source-nurture.sql', '0015_callie-conversation.sql', '0016_contractor-workday.sql', '0017_returning-customer-work.sql', '0018_lead-alert-coverage.sql'];

async function insert(database, table, row) {
  const fields = Object.keys(row);
  await database.query(`INSERT INTO ${identifier(table)} (${fields.map(identifier).join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')})`, fields.map((field) => jsonFields.has(field) && (field !== 'evidence' || typeof row[field] !== 'string') ? JSON.stringify(row[field]) : row[field]));
}

async function fingerprints(database) {
  const tables = (await database.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows.map((row) => row.table_name);
  const values = {};
  for (const table of tables) {
    values[table] = (await database.query(`SELECT count(*)::int AS count, md5(coalesce(string_agg(md5(to_jsonb(t)::text), ',' ORDER BY md5(to_jsonb(t)::text)), '')) AS digest FROM ${identifier(table)} t`)).rows[0];
  }
  return { tables: values, sha256: sha(JSON.stringify(values)) };
}

async function probeApp(database) {
  const artifactRoot = resolve(root, 'artifacts/api-server');
  const output = await mkdtemp(join(artifactRoot, '.contractor-recovery-'));
  if (dirname(output) !== artifactRoot || !basename(output).startsWith('.contractor-recovery-')) throw new Error('contractor_build_path_invalid');
  let socket;
  try {
  await buildAll({ entryPoint: join(artifactRoot, 'scripts/contractor-recovery-entry.ts'), outDir: output });
  await database.exec('SET SESSION AUTHORIZATION contractor_recovery_reader; SET default_transaction_read_only=on');
  socket = new PGLiteSocketServer({ db: database, host: '127.0.0.1', port: 0, maxConnections: 20 });
  await socket.start();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|TEMP|TMP|PATHEXT|COMSPEC)$/i.test(key)));
  Object.assign(env, {
    NODE_ENV: 'test', DATABASE_URL: `postgresql://contractor_recovery_reader:synthetic@${socket.getServerConn()}/postgres`,
    SESSION_SECRET: 'synthetic-contractor-recovery-not-for-deployment', APP_ORIGIN: 'https://growth.example',
    OAUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 63).toString('base64'),
    OBJECT_STORAGE_PROVIDER: 'postgres', LOG_LEVEL: 'silent', RESTORE_DRILL_ONLY: 'true',
    CONTRACTOR_SYNTHETIC_RECOVERY: 'true', GROWTHOS_OUTBOUND_HOLD: 'true', SCHEDULER_AUTOSTART: 'false',
    CONTRACTOR_RECOVERY_APP: join(output, 'contractor-recovery-entry.mjs'),
  });
    return await new Promise((done, reject) => {
      let output = '', diagnostic = '', failureCode = '';
      const child = spawn(process.execPath, [fileURLToPath(new URL('./contractor-recovery-app-probe.mjs', import.meta.url))], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { child.kill(); reject(new Error('contractor_app_probe_timeout')); }, 45_000);
      child.stdout.on('data', (chunk) => { output += chunk; if (output.length > 16_000) child.kill(); });
      child.stderr.on('data', (chunk) => {
        diagnostic = (diagnostic + chunk).slice(-4000);
        const code = diagnostic.match(/CONTRACTOR_APP_PROBE_FAILED:[a-z_0-9]+:(?:assertion|unavailable)(?::status_\d+)?/);
        if (code) failureCode = code[0];
      });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`contractor_app_probe_failed${failureCode.includes('assertion') ? '_assertion' : ''}`, { cause: failureCode || 'contractor_probe_child_unavailable' }));
        try { const lines = output.trim().split('\n'); done(JSON.parse(lines.at(-1))); } catch { reject(new Error('contractor_app_probe_result_invalid')); }
      });
    });
  } finally {
    try { await socket?.stop(); }
    finally { await rm(output, { recursive: true, force: true }); }
  }
}

export async function runContractorRecoveryDrill({ emit = console.log } = {}) {
  const startedAt = Date.now();
  const source = await PGlite.create(); let restored;
  try {
    const base = await reviewedSchema();
    await source.exec(base);
    const codec = await credentialCodec(Buffer.alloc(32, 63).toString('base64'));
    const slugs = ['restore-drill-contractor-a', 'restore-drill-contractor-b'];
    for (const slug of slugs) {
      const id = fixtureIds(slug);
      const encrypted = codec.encrypt(FAKE_REFRESH_TOKEN, `${id.organization}:${id.user}:gmail`);
      for (const [table, row] of fixtureRows(slug, encrypted)) await insert(source, table, row);
    }
    const beforeUpgrade = await fingerprints(source);
    const migrations = [];
    let returningPreviousTableCount = 0, returningLegacyFingerprint;
    let alertCoveragePreviousTableCount = 0, alertCoverageBefore;
    const legacyFingerprint = async () => {
      const rows = {};
      for (const table of ['estimates','projects','invoices','value_entries']) rows[table]=(await source.query(`SELECT count(*)::int AS count,
        md5(coalesce(string_agg(md5((to_jsonb(t)-'customer_work_id'-'work_version'-'refund_of_value_entry_id')::text),','
          ORDER BY md5((to_jsonb(t)-'customer_work_id'-'work_version'-'refund_of_value_entry_id')::text)),'')) AS digest FROM ${identifier(table)} t`)).rows[0];
      return rows;
    };
    for (const file of deltas) {
      if (file === '0018_lead-alert-coverage.sql') {
        alertCoverageBefore = await fingerprints(source);
        alertCoveragePreviousTableCount = Object.keys(alertCoverageBefore.tables).length;
        assert.equal(alertCoveragePreviousTableCount,141);
      }
      if (file === '0017_returning-customer-work.sql') {
        returningPreviousTableCount = Object.keys((await fingerprints(source)).tables).length;
        assert.equal(returningPreviousTableCount,139);
        returningLegacyFingerprint=await legacyFingerprint();
      }
      const sql = (await readFile(new URL(`../reports/staging-schema-preview-2026-10-01/${file}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
      await source.exec(sql);
      if (file === '0018_lead-alert-coverage.sql') {
        const upgraded = await fingerprints(source);
        assert.equal(Object.keys(upgraded.tables).length,142);
        for (const [table,value] of Object.entries(alertCoverageBefore.tables)) assert.deepEqual(upgraded.tables[table],value);
        assert.equal(upgraded.tables.staff_lead_alert_coverage.count,0);
      }
      migrations.push({ file, sha256: sha(sql) });
    }
    assert.deepEqual(await legacyFingerprint(),returningLegacyFingerprint);
    const currentSchema = await tsImport('../lib/db/src/schema/index.ts', import.meta.url);
    const expected = generateDrizzleJson(currentSchema).tables;
    const actual = (await source.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,column_name")).rows;
    for (const table of Object.values(expected)) {
      assert.deepEqual(actual.filter((row) => row.table_name === table.name).map((row) => row.column_name).sort(), Object.keys(table.columns).sort(), `schema columns ${table.name}`);
    }
    assert.equal(new Set(actual.map((row) => row.table_name)).size, Object.keys(expected).length);
    for (const slug of slugs) await assertFixtureRecords({ query: (sql, values) => source.query(sql, values) }, { syntheticSlug: slug }, codec);
    for (const [index, slug] of slugs.entries()) {
      for (const [table,row] of nativeFixtureRows(slug)) await insert(source,table,row);
      await sealNativeFixture(source,slug);
      await assertNativeFixture(source,slug);
      for (const [table, row] of careFixtureRows(slug)) await insert(source, table, row);
      await assertCareFixture(source, slug);
      for (const [table,row] of operationsFixtureRows(slug)) await insert(source,table,row);
      await sealOperationsFixture(source,slug);
      await assertOperationsFixture(source,slug);
      for (const [table, row] of launchCommunicationRows(slug)) await insert(source, table, row);
      await sealLaunchCommunicationFixture(source, slug);
      await assertLaunchCommunications(source, slug);
      await seedLeadReplyFixture(source, slug);
      await assertLeadReplyFixture(source, slug);
      await seedInvoiceRecoveryFixture(source, slug);
      await assertInvoiceRecoveryFixture(source, slug);
      await seedCallieRecoveryFixture(source, slug, codec);
      await assertCallieRecoveryFixture(source, slug, codec);
      await seedStandingServiceRecovery(source, slug);
      await assertStandingServiceRecovery(source, slug);
      await seedSourceNurtureRecovery(source, slug);
      await assertSourceNurtureRecovery(source, slug);
      const id = fixtureIds(slug), emailSource = randomUUID();
      await seedCustomerWorkspaceFixture(source, slug, { organization: id.organization, user: id.user, completed: true });
      await insert(source, 'billing_checkouts', { organization_id: id.organization, intent: 'initial', state: 'reconcile', price_id: 'price_synthetic', plan_id: 'beta', success_url: 'https://example.invalid/success', cancel_url: 'https://example.invalid/cancel', provider_configuration_hash: sha('synthetic-provider'), recovery_reason: 'synthetic_acknowledgement_unknown' });
      await insert(source, 'customer_lifecycle', { organization_id: id.organization, state: 'paused', version: 2, reason: 'Synthetic recovery hold', updated_by_user_id: id.user });
      await insert(source, 'staff_invitations', { organization_id: id.organization, request_id: randomUUID(), payload_hash: sha('synthetic-invitation'), pending_user_id: `invite:${randomUUID()}`, email: `${slug}.pending@example.invalid`, role: 'admin', delivery_state: 'unconfirmed', created_by_user_id: id.user, expires_at: new Date(Date.now() + 86_400_000) });
      await insert(source, 'email_intelligence_sources', { id: emailSource, organization_id: id.organization, intake_alias: `${slug}@example.invalid`, status: 'paused' });
      await insert(source, 'email_response_reviews', { organization_id: id.organization, source_id: emailSource, external_message_id: `synthetic-reply-${index}`, payload_sha256: sha('synthetic-reply'), state: 'confirmed', reason: 'synthetic_confirmed_reply', lead_id: id.lead, contact_id: id.contact, reply_at: new Date(), hold_active: true, reviewed_by_user_id: id.user });
      await insert(source, 'sessions', { sid: (index ? 'b' : 'a').repeat(64), sess: JSON.stringify({ user: { id: id.user, email: `${slug}.operator@example.invalid`, firstName: 'Synthetic', lastName: 'Recovery', profileImageUrl: null }, access_token: 'synthetic-no-provider' }), expire: new Date(Date.now() + 86_400_000) });
    }
    for (const slug of CALLIE_CONVERSATION_RECOVERY_SLUGS) {
      await seedCallieConversationRecovery(source, slug, codec);
      await assertCallieConversationRecovery(source, slug, codec);
    }
    for (const slug of WORKDAY_RECOVERY_SLUGS) {
      await seedWorkdayRecovery(source, slug);
      await assertWorkdayRecovery(source, slug);
    }
    for (const slug of slugs) {
      await seedReturningCustomerRecovery(source,slug);
      await assertReturningCustomerRecovery(source,slug);
    }
    for (const slug of slugs) {
      await seedLeadAlertCoverage(source,slug);
      await assertLeadAlertCoverage(source,slug);
    }
    await source.exec('CREATE ROLE contractor_recovery_reader; GRANT USAGE ON SCHEMA public TO contractor_recovery_reader; GRANT SELECT ON ALL TABLES IN SCHEMA public TO contractor_recovery_reader;');
    const careBaseline = await fingerprints(source);
    await assertCareTenantKeys(source, slugs[0], slugs[1]);
    const operationsTenantChecks = await assertOperationsTenantKeys(source, slugs[0], slugs[1]);
    const launchCommunicationTenantChecks = await assertLaunchCommunicationKeys(source, slugs[0], slugs[1]);
    const leadReplyTenantChecks = await assertLeadReplyTenantKeys(source, slugs[0], slugs[1]);
    const invoiceRecoveryConstraintChecks = await assertInvoiceRecoveryKeys(source, slugs[0], slugs[1]);
    const callieConstraintChecks = await assertCallieRecoveryKeys(source, slugs[0], slugs[1]);
    const standingServiceConstraintChecks = await assertStandingServiceKeys(source, slugs[0], slugs[1]);
    const nurtureConstraintChecks = await assertSourceNurtureKeys(source, slugs[0], slugs[1]);
    const conversationConstraints = await assertCallieConversationKeys(source);
    const workdayConstraints = await assertWorkdayKeys(source);
    const returningConstraints = await assertReturningCustomerKeys(source,slugs[0],slugs[1]);
    const alertCoverageConstraintChecks = await assertLeadAlertCoverageConstraints(source,slugs[0],slugs[1]);
    assert.deepEqual(await fingerprints(source), careBaseline);
    // Prove the reviewed active-service exception cannot mask an unpaused
    // company or another active obligation. These transactions always roll back.
    const guardBaseline = await fingerprints(source);
    for (const slug of slugs) {
      const id=fixtureIds(slug), reviewedPausedServiceId=nativeFixtureIds(slug).nextService;
      const careOptions={reviewedPausedServiceId,reviewedPausedCareExecutionId:careFixtureIds(slug).execution,reviewedPausedInvoiceExecutionId:invoiceRecoveryIds(slug).secondExecution,reviewedPausedCallieExecutionId:callieFixtureIds(slug).execution,reviewedPausedStandingExecutionId:standingServiceIds(slug).execution,reviewedPausedNurtureExecutionId:sourceNurtureIds(slug).execution,reviewedPausedReturningInvoiceExecutionId:returningCustomerIds(slug).execution};
      const check=(options)=>assertFixtureRecords({query:(sql,values)=>source.query(sql,values)},{syntheticSlug:slug},codec,options);
      await assert.rejects(check(), /restore_fixture_outbound_or_identity_unsafe/);
      await source.exec('BEGIN');
      try {
        await source.query("UPDATE customer_lifecycle SET state='active' WHERE organization_id=$1",[id.organization]);
        await assert.rejects(check(careOptions),/restore_fixture_outbound_or_identity_unsafe/);
      } finally { await source.exec('ROLLBACK'); }
      await source.exec('BEGIN');
      try {
        await source.query("UPDATE service_obligations SET status='active' WHERE id=$1",[nativeFixtureIds(slug).priorService]);
        await assert.rejects(check(careOptions),/restore_fixture_outbound_or_identity_unsafe/);
      } finally { await source.exec('ROLLBACK'); }
      await assert.rejects(check({reviewedPausedServiceId}),/restore_fixture_outbound_or_identity_unsafe/);
      await assert.rejects(check({reviewedPausedServiceId,reviewedPausedCareExecutionId:careFixtureIds(slug).execution}),/restore_fixture_outbound_or_identity_unsafe/);
      const {reviewedPausedReturningInvoiceExecutionId,...withoutReturning}=careOptions;
      await assert.rejects(check(withoutReturning),/restore_fixture_outbound_or_identity_unsafe/);
      await assert.rejects(check({...careOptions,reviewedPausedReturningInvoiceExecutionId:invoiceRecoveryIds(slug).secondExecution}),/restore_fixture_returning_exception_invalid/);
      for (const query of [
        "UPDATE missed_call_care_policies SET enabled=true WHERE organization_id=$1",
        "UPDATE revenue_executions SET state='processing' WHERE organization_id=$1 AND kind='missed_call_care'",
        "UPDATE revenue_executions SET state='processing' WHERE organization_id=$1 AND kind='invoice_email' AND state='indeterminate'",
        "UPDATE audit_events SET metadata=jsonb_set(metadata,'{context,leadId}','\"unrelated-acquisition\"'::jsonb) WHERE organization_id=$1 AND action='invoice_delivery.previewed' AND metadata->>'reviewVersion'='3'",
        "UPDATE audit_events SET metadata=metadata || '{\"phase\":\"unknown\"}'::jsonb WHERE organization_id=$1 AND action='invoice_delivery.not_dispatched'",
        "UPDATE callie_policy_revisions SET enabled=true,snapshot=jsonb_set(snapshot,'{enabled}','true'::jsonb) WHERE organization_id=$1 AND version=2",
        "UPDATE revenue_executions SET state='processing' WHERE organization_id=$1 AND kind='callie_one_call_acknowledgment'",
        "UPDATE callie_ack_dispatches SET status='dispatching' WHERE organization_id=$1",
        "UPDATE service_standing_policy_revisions SET enabled=true,snapshot=jsonb_set(snapshot,'{settings,enabled}','true'::jsonb) WHERE organization_id=$1 AND version=2",
        "UPDATE revenue_executions SET state='processing' WHERE organization_id=$1 AND kind='service_care_reminder'",
        "UPDATE twilio_dispatches SET status='dispatching' WHERE organization_id=$1 AND purpose='customer_care'",
        "UPDATE source_nurture_plans SET state='running' WHERE organization_id=$1",
        "UPDATE source_nurture_items SET stopped_at=NULL WHERE organization_id=$1",
        "UPDATE revenue_executions SET state='processing' WHERE organization_id=$1 AND kind='source_nurture_email'",
        "UPDATE mailbox_connectors SET nurture_monitoring_enabled=true,nurture_monitoring_version=1,nurture_monitoring_approved_at=now(),nurture_monitoring_changed_at=now() WHERE organization_id=$1",
        "UPDATE mailbox_sync_cycles SET state='scanning',failed_at=NULL,error_code=NULL WHERE organization_id=$1",
      ]) {
        await source.exec('BEGIN');
        try { await source.query(query,[id.organization]); await assert.rejects(check(careOptions),/restore_fixture_outbound_or_identity_unsafe/); }
        finally { await source.exec('ROLLBACK'); }
      }
      await check(careOptions);
    }
    assert.deepEqual(await fingerprints(source),guardBaseline);
    const baseline = await fingerprints(source);
    const snapshot = await source.dumpDataDir();
    // This marker is deliberately after the snapshot; it must not appear in restoration.
    await insert(source, 'organizations', { name: 'SYNTHETIC after snapshot', slug: 'restore-drill-after-snapshot' });
    const restoreStartedAt = Date.now();
    restored = await PGlite.create({ loadDataDir: snapshot });
    assert.deepEqual(await fingerprints(restored), baseline);
    assert.equal((await restored.query("SELECT count(*)::int AS n FROM organizations WHERE slug='restore-drill-after-snapshot'")).rows[0].n, 0);
    for (const slug of slugs) await assertFixtureRecords({ query: (sql, values) => restored.query(sql, values) }, { syntheticSlug: slug }, codec, { reviewedPausedServiceId: nativeFixtureIds(slug).nextService, reviewedPausedCareExecutionId: careFixtureIds(slug).execution, reviewedPausedInvoiceExecutionId: invoiceRecoveryIds(slug).secondExecution, reviewedPausedCallieExecutionId: callieFixtureIds(slug).execution, reviewedPausedStandingExecutionId: standingServiceIds(slug).execution, reviewedPausedNurtureExecutionId: sourceNurtureIds(slug).execution, reviewedPausedReturningInvoiceExecutionId:returningCustomerIds(slug).execution });
    for (const slug of slugs) await assertNativeFixture(restored,slug);
    for (const slug of slugs) await assertCareFixture(restored,slug);
    for (const slug of slugs) await assertOperationsFixture(restored,slug);
    for (const slug of slugs) await assertLaunchCommunications(restored,slug);
    for (const slug of slugs) await assertLeadReplyFixture(restored,slug);
    for (const slug of slugs) await assertInvoiceRecoveryFixture(restored,slug);
    for (const slug of slugs) await assertCallieRecoveryFixture(restored,slug,codec);
    for (const slug of slugs) await assertStandingServiceRecovery(restored,slug);
    for (const slug of slugs) await assertSourceNurtureRecovery(restored,slug);
    for (const slug of CALLIE_CONVERSATION_RECOVERY_SLUGS) await assertCallieConversationRecovery(restored, slug, codec);
    for (const slug of WORKDAY_RECOVERY_SLUGS) await assertWorkdayRecovery(restored, slug);
    for (const slug of slugs) await assertReturningCustomerRecovery(restored,slug);
    for (const slug of slugs) await assertLeadAlertCoverage(restored,slug);
    assert.equal((await restored.query("SELECT count(*)::int AS n FROM billing_checkouts WHERE state='reconcile'")).rows[0].n, 2);
    assert.equal((await restored.query("SELECT count(*)::int AS n FROM customer_lifecycle WHERE state='paused'")).rows[0].n, 2);
    assert.equal((await restored.query("SELECT count(*)::int AS n FROM staff_invitations WHERE state='pending' AND delivery_state='unconfirmed'")).rows[0].n, 2);
    assert.equal((await restored.query('SELECT count(*)::int AS n FROM email_response_reviews WHERE hold_active=true AND message_id IS NULL')).rows[0].n, 6);
    const app = await probeApp(restored);
    assert.deepEqual(await fingerprints(restored), baseline);
    const evidence = {
      check: 'contractor_synthetic_upgrade_restore', engine: 'PGlite embedded PostgreSQL',
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
      trackedDiffSha256: sha(execFileSync('git', ['diff', '--', '.'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 20 * 1024 * 1024 })),
      candidateCommitted: execFileSync('git', ['status', '--porcelain'], { cwd: root, windowsHide: true, encoding: 'utf8' }).trim().length === 0,
      migrations, tableCount: Object.keys(expected).length, previousTableCount: Object.keys(beforeUpgrade.tables).length,
      sourceFingerprint: baseline.sha256, restoredFingerprint: baseline.sha256,
      snapshotSha256: sha(Buffer.from(await snapshot.arrayBuffer())),
      tableCounts: Object.fromEntries(Object.entries(baseline.tables).filter(([, value]) => value.count).map(([table, value]) => [table, value.count])),
      preservedPriorRecords: true, credentialDecryptVerified: true, wrongKeyAndContextRejected: true,
      uncertainCheckoutPreserved: true, companyHoldPreserved: true, pendingInvitationPreserved: true,
      replyHoldSurvivesRawDeletion: true, postSnapshotMarkerAbsent: true,
      issuedInvoiceSnapshotPreserved: true, invoiceNumberingPreserved: true, receiptReversalPreservesCash: true, recurringServiceSuccessorPreserved: true,
      pausedServiceExceptionVerified: true,
      missedCallUncertaintyPreserved: true, careTenantForeignKeysVerified: true, disabledCarePoliciesPreserved: true,
      operationsTenantChecks, heldServiceWatchPreserved: true, revokedSourceAdoptionPreserved: true, permanentSourceReservationPreserved: true,
      noncashOpeningReceivablePreserved: true, typedPushUncertaintyPreserved: true,
      launchCommunicationTenantChecks, serviceReplyHoldAfterPurgePreserved: true,
      disabledMailboxPreserved: true, platformIdentityUncertaintyPreserved: true,
      leadReplyTenantChecks, leadReplyHoldAfterPurgePreserved: true, leadReplyOfficeTaskPreserved: true,
      leadMonitoringRemainsDisabled: true,
      invoiceRecoveryConstraintChecks, invoiceUnknownChainPreserved: true, typedNoDispatchProofPreserved: true,
      callieConstraintChecks, callieUnknownGrantPreserved: true, callieDisabledHeadPreserved: true, callieUnverifiedCallerPreserved: true, callieChallengeEncryptionVerified: true,
      standingServiceConstraintChecks, standingDisabledHeadPreserved: true, standingUnknownSendPreserved: true, serviceSmsHoldAfterPurgePreserved: true, ambiguousServiceSmsPreserved: true,
      nurtureConstraintChecks, nurtureStoppedOwnershipPreserved: true, nurtureUnknownNeverAdvanced: true, nurtureFailedSyncPreserved: true, nurtureReplyHoldAfterPurgePreserved: true,
      workdayConstraintChecks: workdayConstraints, workdayCapturedHistoryPreserved: true,
      returningPreviousTableCount, returningLegacyRowsUnchanged: true, returningConstraintChecks: returningConstraints,
      alertCoveragePreviousTableCount, alertCoveragePriorRowsUnchanged: true, alertCoverageConstraintChecks,
      originalAlertCoveragePreserved: true, missingAlertEffectsRemainUnknown: true, legacyAlertCoverageRemainsUnknown: true,
      returningCustomerLineagePreserved: true, returningCommandResultsPreserved: true,
      returningWorkScopedReceiptsPreserved: true, returningV3UnknownOwnershipPreserved: true,
      workdayImmutableRevisionPreserved: true, workdayPrivatePhotosPreserved: true,
      workdayNoAcquisitionLeadCreated: true, workdayReadVerified: app.workdayReadVerified,
      callieConversationConstraintChecks: conversationConstraints.count,
      callieConversationUnknownEffectsPreserved: true, callieConversationStaffWorkPreserved: true,
      callieConversationContentPurgePreserved: true, callieConversationDisabledHeadPreserved: true,
      callieConversationEncryptionVerified: true, callieConversationLegacySeparated: true,
      ...app, restoreVerificationMs: Date.now() - restoreStartedAt, elapsedMs: Date.now() - startedAt,
      providerCalls: 0, managedBackupRestoreVerified: false, productionRpoRtoEstablished: false,
    };
    emit(JSON.stringify(evidence)); return evidence;
  } finally { await restored?.close(); await source.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runContractorRecoveryDrill().catch((error) => {
    process.stderr.write(`CONTRACTOR_RECOVERY_FAILED:${/^contractor_[a-z_]+$/.test(error.message ?? '') ? error.message : error.code === 'ERR_ASSERTION' ? 'assertion' : error.code?.match(/^[A-Z0-9]{5}$/) ? error.code : 'unavailable'}\n`);
    process.exitCode = 1;
  });
}
