/** Synthetic append-only delivery history. No provider SDK, credentials or sends. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixtureIds } from './restore-drill-fixture.mjs';
import { nativeFixtureIds } from './native-contractor-recovery-fixture.mjs';

const stamp = '2026-10-02T12:00:00.000Z';
const hash = value => createHash('sha256').update(value).digest('hex');
// Same stable review encoding as the invoice kernel, independent of JSONB key order.
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value) ?? 'null';
const digest = value => hash(canonical(value));
export function invoiceRecoveryIds(namespace) {
  return Object.fromEntries(['firstAttempt', 'firstExecution', 'firstPreview', 'firstProof', 'secondAttempt', 'secondExecution', 'secondPreview'].map(name => {
    const value = hash(`invoice-recovery-v1:${namespace}:${name}`);
    return [name, `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`];
  }));
}

/** Only call with an already-created fictional, issued invoice in a disposable DB.
 * stopAfterBlocked supports the provider-disabled visual fixture's safe-review UI. */
export async function seedSyntheticInvoiceChain(database, { namespace, organizationId, actorUserId, invoiceId, stopAfterBlocked = false }) {
  const ids = invoiceRecoveryIds(namespace);
  const [invoice] = (await database.query(`SELECT i.*,l.contact_id,c.email FROM invoices i
    JOIN leads l ON l.id=i.lead_id AND l.organization_id=i.organization_id
    JOIN contacts c ON c.id=l.contact_id AND c.organization_id=i.organization_id
    WHERE i.id=$1 AND i.organization_id=$2`, [invoiceId, organizationId])).rows;
  assert.equal(invoice?.status, 'issued'); assert.ok(invoice.email?.endsWith('@example.invalid'));
  const context = { leadId: invoice.lead_id, contactId: invoice.contact_id, invoiceNumber: invoice.invoice_number,
    recipient: invoice.email.trim().toLowerCase(), sender: { userId: actorUserId, source: 'lead_assignee', provider: 'microsoft', senderEmail: 'synthetic-office@example.invalid' } };
  const initialKey = `invoice-delivery:${invoiceId}`;
  let previousFingerprint = null;
  for (const ordinal of stopAfterBlocked ? [1] : [1, 2]) {
    const first = ordinal === 1, previewId = first ? ids.firstPreview : ids.secondPreview,
      executionId = first ? ids.firstExecution : ids.secondExecution, attemptId = first ? ids.firstAttempt : ids.secondAttempt;
    const intent = first ? 'initial' : 'retry_not_dispatched', actionKey = first ? initialKey : `${initialKey}:attempt:2`;
    const metadata = { reviewVersion: 2, payloadSha256: digest({ syntheticOnly: true, invoiceId, ordinal }),
      expiresAt: '2026-10-02T12:10:00.000Z', invoiceVersion: invoice.version, documentSha256: digest(invoice.issued_document),
      intent, expectedLatestExecutionId: first ? null : ids.firstExecution,
      reason: first ? null : 'Synthetic recovery review only; no customer email or provider call.', duplicateCopyAcknowledged: false, context };
    const executionFingerprint = digest({ invoiceId, previewId, payloadSha256: metadata.payloadSha256 });
    await database.query(`INSERT INTO audit_events(id,organization_id,actor_user_id,action,entity_type,entity_id,metadata,created_at)
      VALUES($1,$2,$3,'invoice_delivery.previewed','invoice',$4,$5,$6)`, [previewId, organizationId, actorUserId, invoiceId, JSON.stringify(metadata), stamp]);
    await database.query(`INSERT INTO revenue_executions(id,organization_id,action_key,fingerprint,kind,state,detail,actor_user_id,expires_at,completed_at,created_at)
      VALUES($1,$2,$3,$4,'invoice_email',$5,$6,$7,$8,$8,$8)`, [executionId, organizationId, actionKey, executionFingerprint,
      first ? 'blocked' : 'indeterminate', first ? 'SYNTHETIC ONLY: refused before dispatch.' : 'SYNTHETIC ONLY: effect uncertain; never replay.', actorUserId, stamp]);
    await database.query(`INSERT INTO invoice_delivery_attempts(id,organization_id,invoice_id,ordinal,intent,duplicate_copy_acknowledged,execution_id,
      action_key,execution_fingerprint,actor_user_id,preview_id,payload_sha256,document_sha256,invoice_version,review_sha256,
      predecessor_execution_id,predecessor_action_key,predecessor_fingerprint,predecessor_proof_id,created_at)
      VALUES($1,$2,$3,$4,$5,false,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [attemptId, organizationId, invoiceId, ordinal, intent, executionId, actionKey, executionFingerprint, actorUserId, previewId,
      metadata.payloadSha256, metadata.documentSha256, invoice.version, digest(metadata), first ? null : ids.firstExecution,
      first ? null : initialKey, first ? null : previousFingerprint, first ? null : ids.firstProof, stamp]);
    for (const state of ['processing', first ? 'blocked' : 'indeterminate']) await database.query(`INSERT INTO revenue_execution_events(organization_id,execution_id,state,detail,actor_user_id)
      VALUES($1,$2,$3,'Synthetic append-only recovery evidence; no external effect.',$4)`, [organizationId, executionId, state, actorUserId]);
    if (first) {
      await database.query(`INSERT INTO audit_events(id,organization_id,actor_user_id,action,entity_type,entity_id,metadata,created_at)
        VALUES($1,$2,$3,'invoice_delivery.not_dispatched','invoice',$4,$5,$6)`, [ids.firstProof, organizationId, actorUserId, invoiceId, JSON.stringify({
        proofVersion: 1, attemptId, executionId, ordinal, actionKey, executionFingerprint, invoiceId, previewId,
        payloadSha256: metadata.payloadSha256, documentSha256: metadata.documentSha256, phase: 'pre_provider', code: 'dispatch_guard_rejected',
      }), stamp]);
      previousFingerprint = executionFingerprint;
    }
  }
  return ids;
}

export async function seedInvoiceRecoveryFixture(database, slug) {
  const old = fixtureIds(slug);
  return seedSyntheticInvoiceChain(database, { namespace: slug, organizationId: old.organization, actorUserId: old.user, invoiceId: nativeFixtureIds(slug).invoice });
}

export async function assertInvoiceRecoveryFixture(database, slug) {
  const id = invoiceRecoveryIds(slug), old = fixtureIds(slug), invoiceId = nativeFixtureIds(slug).invoice;
  const rows = (await database.query(`SELECT a.*,r.state,r.fingerprint,p.metadata FROM invoice_delivery_attempts a
    JOIN revenue_executions r ON r.id=a.execution_id AND r.organization_id=a.organization_id
    JOIN audit_events p ON p.id=a.preview_id AND p.organization_id=a.organization_id
    WHERE a.invoice_id=$1 AND a.organization_id=$2 ORDER BY a.ordinal`, [invoiceId, old.organization])).rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.state), ['blocked', 'indeterminate']);
  assert.deepEqual(rows.map(row => row.intent), ['initial', 'retry_not_dispatched']);
  assert.equal(rows[1].predecessor_execution_id, id.firstExecution);
  assert.equal(rows[1].predecessor_proof_id, id.firstProof);
  assert.equal(rows[1].predecessor_fingerprint, rows[0].fingerprint);
  for (const row of rows) {
    assert.equal(row.review_sha256, digest(row.metadata));
    assert.equal(row.execution_fingerprint, row.fingerprint);
    assert.equal(row.duplicate_copy_acknowledged, false);
  }
  const [proof] = (await database.query('SELECT metadata FROM audit_events WHERE id=$1 AND organization_id=$2', [id.firstProof, old.organization])).rows;
  assert.equal(proof.metadata.phase, 'pre_provider'); assert.equal(proof.metadata.executionId, id.firstExecution);
  assert.equal((await database.query("SELECT count(*)::int AS n FROM audit_events WHERE organization_id=$1 AND entity_id=$2 AND action='invoice_delivery.provider_accepted'", [old.organization, invoiceId])).rows[0].n, 0);
}

/** Each negative mutation rolls back; no constraint bypass or cleanup deletes. */
export async function assertInvoiceRecoveryKeys(database, slug, foreignSlug) {
  const id = invoiceRecoveryIds(slug), other = invoiceRecoveryIds(foreignSlug), foreign = fixtureIds(foreignSlug), foreignInvoice = nativeFixtureIds(foreignSlug).invoice;
  const checks = [
    ["UPDATE invoice_delivery_attempts SET invoice_id=$2::uuid,action_key='invoice-delivery:'||($2::uuid)::text WHERE id=$1", [id.firstAttempt, foreignInvoice], '23503'],
    ['UPDATE invoice_delivery_attempts SET actor_user_id=$2 WHERE id=$1', [id.firstAttempt, foreign.user], '23503'],
    ['UPDATE invoice_delivery_attempts SET preview_id=$2 WHERE id=$1', [id.firstAttempt, other.firstPreview], '23503'],
    ['UPDATE invoice_delivery_attempts SET execution_id=$2 WHERE id=$1', [id.firstAttempt, other.firstExecution], '23503'],
    ['UPDATE invoice_delivery_attempts SET predecessor_execution_id=$2 WHERE id=$1', [id.secondAttempt, other.firstExecution], '23503'],
    ['UPDATE invoice_delivery_attempts SET predecessor_proof_id=$2 WHERE id=$1', [id.secondAttempt, other.firstProof], '23503'],
    ['UPDATE invoice_delivery_attempts SET predecessor_proof_id=NULL WHERE id=$1', [id.secondAttempt], '23514'],
    ['UPDATE invoice_delivery_attempts SET duplicate_copy_acknowledged=true WHERE id=$1', [id.secondAttempt], '23514'],
    ['UPDATE invoice_delivery_attempts SET ordinal=6 WHERE id=$1', [id.secondAttempt], '23514'],
  ];
  for (const [sql, values, code] of checks) {
    await database.exec('BEGIN');
    try { await assert.rejects(database.query(sql, values), error => error.code === code); }
    finally { await database.exec('ROLLBACK'); }
  }
  return checks.length;
}
