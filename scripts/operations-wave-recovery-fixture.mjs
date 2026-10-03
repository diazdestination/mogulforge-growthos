/** Synthetic retained operations evidence. No live approval, consent or recipient. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixtureIds } from './restore-drill-fixture.mjs';
import { nativeFixtureIds, nativeFixtureRows } from './native-contractor-recovery-fixture.mjs';
const stamp = '2026-10-02T12:00:00.000Z';
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function operationsFixtureIds(slug) {
  return Object.fromEntries(['watch', 'adoption', 'batch', 'item', 'review', 'invoice', 'invoiceItem', 'receiptItem', 'subscription', 'push'].map(name => {
    const value = sha(`operations-wave-recovery-v1:${slug}:${name}`);
    return [name, `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`];
  }));
}
export function operationsFixtureRows(slug) {
  const id = fixtureIds(slug), native = nativeFixtureIds(slug), next = operationsFixtureIds(slug), shared = { organization_id: id.organization };
  const document = { ...nativeFixtureRows(slug).find(([table]) => table === 'invoices')[1].issued_document, title: 'Synthetic historical opening balance', notes: 'No historical cash is inferred.' };
  const source = { sourceSystem: 'synthetic-source', sourceAccount: 'synthetic-account', externalId: 'historical-invoice-1', cutoffAt: stamp, recordSha256: sha('synthetic-original-source-record') };
  const snapshot = { leadId: id.lead, contactId: id.contact, importSourceKey: 'synthetic-account', externalOpportunityId: 'synthetic-opportunity', sourceSha256: sha('synthetic-source'), operationalSha256: sha('synthetic-operations'), recipient: `${slug}.customer@example.invalid` };
  const settings = { businessName: 'SYNTHETIC RESTORE ONLY', mailingAddress: 'Synthetic non-deliverable address', subject: 'Synthetic only', body: 'No email authorized.', timezone: 'UTC', days: ['Mon'], startHour: 9, endHour: 10, dailyLimit: 1 };
  const financialSource = { format: 'growthos-financial-migration', version: 1, sourceSystem: source.sourceSystem, sourceAccount: source.sourceAccount, cutoffAt: stamp,
    invoices: [{ externalId: source.externalId, invoiceNumber: 'HIST-SYNTHETIC-1', leadId: id.lead, issuedAt: '2025-01-02T12:00:00.000Z', basis: 'opening_receivable', balanceAtCutoffCents: 6000, document }], receipts: [],
    controlTotals: { invoiceCount: 1, documentTotalCents: 10000, openingReceivableCents: 6000, balanceDueCents: 6000, paymentCents: 0, refundCents: 0 } };
  return [
    ['service_watch_cases', { ...shared, id: next.watch, service_obligation_id: native.nextService, version: 3, state: 'held', reasons: ['service_overdue'], observed_fingerprint: sha('synthetic-held-source'), episode: 1, assigned_user_id: id.user, acknowledged_by_user_id: id.user, acknowledged_at: stamp, next_action: 'Synthetic office review; not customer contact.', next_action_at: stamp, notice_revision: 1, last_evaluated_at: stamp }],
    ['source_adoptions', { ...shared, id: next.adoption, lead_id: id.lead, contact_id: id.contact, version: 2, state: 'revoked', snapshot, source_as_of: stamp, cutover_at: stamp, expires_at: stamp, evidence: 'Synthetic migration review only; never live source approval.', approved_by_user_id: id.user, approved_at: stamp, revoked_at: stamp }],
    ['source_outreach_batches', { ...shared, id: next.batch, version: 3, state: 'revoked', settings, payload_sha256: sha('synthetic-frozen-batch'), created_by_user_id: id.user, approved_by_user_id: id.user, approved_at: stamp, preview_expires_at: stamp, expires_at: stamp, revoked_at: stamp }],
    ['source_outreach_items', { ...shared, id: next.item, batch_id: next.batch, lead_id: id.lead, contact_id: id.contact, adoption_id: next.adoption, recipient: snapshot.recipient,
      snapshot: { version: 1, adoptionId: next.adoption, adoptionVersion: 1, adoptionSha256: sha('synthetic-approval'), adoption: snapshot, permissionRecordId: id.consent,
        sender: { userId: id.user, source: 'company_default', provider: 'gmail', senderEmail: `${slug}.mailbox@example.invalid` }, subject: settings.subject, body: settings.body }, claimed_at: stamp }],
    ['financial_migration_reviews', { ...shared, id: next.review, actor_user_id: id.user, raw_sha256: sha('synthetic-financial-file'), digest: sha('synthetic-exact-review'), context_digest: sha('synthetic-mapping'),
      payload: { source: financialSource, mappings: [], duplicateInvoices: [], duplicateReceipts: [] }, state: 'committed', result: { invoiceIds: [next.invoice], importedInvoices: 1, importedReceipts: 0, duplicateInvoices: 0, duplicateReceipts: 0 }, expires_at: stamp, committed_at: stamp }],
    ['invoices', { ...shared, id: next.invoice, lead_id: id.lead, status: 'issued', version: 1, invoice_number: 'HIST-SYNTHETIC-1', draft_document: document, issued_document: document, issued_document_sha256: sha(document), issued_at: '2025-01-02T12:00:00.000Z', balance_basis: 'opening_receivable', opening_receivable_cents: 6000, opening_as_of: stamp, historical_source: source, created_by_user_id: id.user }],
    ['financial_migration_items', { ...shared, id: next.invoiceItem, review_id: next.review, source_system: source.sourceSystem, source_account: source.sourceAccount, entity_type: 'invoice', external_id: source.externalId, digest: sha('synthetic-fixed-invoice'), invoice_id: next.invoice }],
    ['financial_migration_items', { ...shared, id: next.receiptItem, review_id: next.review, source_system: source.sourceSystem, source_account: source.sourceAccount, entity_type: 'receipt', external_id: 'separate-synthetic-evidenced-receipt', digest: sha('synthetic-fixed-receipt'), value_entry_id: native.payment }],
    ['staff_push_policies', { ...shared, policy: { enabled: false, serviceAlertsEnabled: false, timezone: 'UTC', days: [1], opensAt: '09:00', closesAt: '10:00', businessHoursUserIds: [id.user], afterHoursUserIds: [id.user] } }],
    ['staff_push_subscriptions', { ...shared, id: next.subscription, user_id: id.user, session_id: null, endpoint_hash: sha(`synthetic-retired-device:${slug}`), encrypted_subscription: null, expires_at: stamp, revoked_at: stamp }],
    ['staff_push_deliveries', { ...shared, id: next.push, service_obligation_id: native.nextService, service_watch_case_id: next.watch, service_notice_revision: 1, service_owner_id: id.user, event_key: `service-watch:${next.watch}:1`, subscription_id: next.subscription, state: 'indeterminate', expires_at: stamp, claimed_at: stamp, completed_at: stamp, reason: 'synthetic_acknowledgement_unknown' }],
  ];
}
export async function sealOperationsFixture(database, slug) {
  const id = operationsFixtureIds(slug);
  const [row] = (await database.query('SELECT issued_document FROM invoices WHERE id=$1', [id.invoice])).rows;
  await database.query('UPDATE invoices SET issued_document_sha256=$2 WHERE id=$1', [id.invoice, sha(row.issued_document)]);
}
export async function assertOperationsFixture(database, slug) {
  const id = fixtureIds(slug), next = operationsFixtureIds(slug);
  const [watch] = (await database.query('SELECT state,next_action,notice_revision FROM service_watch_cases WHERE id=$1 AND organization_id=$2', [next.watch,id.organization])).rows;
  assert.equal(watch.state, 'held'); assert.equal(watch.notice_revision, 1); assert.match(watch.next_action, /not customer contact/);
  const [item] = (await database.query('SELECT i.claimed_at,b.state,a.state AS adoption_state FROM source_outreach_items i JOIN source_outreach_batches b ON b.id=i.batch_id JOIN source_adoptions a ON a.id=i.adoption_id WHERE i.id=$1 AND i.organization_id=$2', [next.item,id.organization])).rows;
  assert.equal(new Date(item.claimed_at).toISOString(), stamp); assert.equal(item.state, 'revoked'); assert.equal(item.adoption_state, 'revoked');
  assert.equal((await database.query("SELECT count(*)::int AS n FROM revenue_executions WHERE organization_id=$1 AND kind='source_outreach_email'", [id.organization])).rows[0].n,0);
  const [invoice] = (await database.query('SELECT * FROM invoices WHERE id=$1 AND organization_id=$2', [next.invoice,id.organization])).rows;
  assert.equal(invoice.invoice_number, 'HIST-SYNTHETIC-1'); assert.equal(new Date(invoice.issued_at).toISOString(), '2025-01-02T12:00:00.000Z');
  assert.equal(invoice.balance_basis, 'opening_receivable'); assert.equal(invoice.opening_receivable_cents, 6000); assert.equal(invoice.issued_document.totalCents,10000);
  assert.equal(invoice.issued_document_sha256,sha(invoice.issued_document));
  assert.equal((await database.query('SELECT count(*)::int AS n FROM invoice_receipt_allocations WHERE invoice_id=$1',[next.invoice])).rows[0].n,0);
  const [push] = (await database.query('SELECT lead_id,state,service_obligation_id FROM staff_push_deliveries WHERE id=$1',[next.push])).rows;
  assert.equal(push.lead_id,null); assert.equal(push.state,'indeterminate'); assert.equal(push.service_obligation_id,nativeFixtureIds(slug).nextService);
  assert.equal((await database.query('SELECT count(*)::int AS n FROM financial_migration_items WHERE organization_id=$1',[id.organization])).rows[0].n,2);
}
export async function assertOperationsTenantKeys(database, slug, otherSlug) {
  const id = fixtureIds(slug), foreign = fixtureIds(otherSlug), next = operationsFixtureIds(slug), other = operationsFixtureIds(otherSlug);
  const checks = [
    ['UPDATE service_watch_cases SET service_obligation_id=$2 WHERE id=$1',[next.watch,nativeFixtureIds(otherSlug).nextService]],
    ['UPDATE service_watch_cases SET assigned_user_id=$2 WHERE id=$1',[next.watch,foreign.user]],
    ['UPDATE source_adoptions SET contact_id=$2 WHERE id=$1',[next.adoption,foreign.contact]],
    ['UPDATE source_adoptions SET lead_id=$2 WHERE id=$1',[next.adoption,foreign.lead]],
    ['UPDATE source_outreach_batches SET approved_by_user_id=$2 WHERE id=$1',[next.batch,foreign.user]],
    ['UPDATE source_outreach_items SET batch_id=$2 WHERE id=$1',[next.item,other.batch]],
    ['UPDATE source_outreach_items SET adoption_id=$2 WHERE id=$1',[next.item,other.adoption]],
    ['UPDATE financial_migration_reviews SET actor_user_id=$2 WHERE id=$1',[next.review,foreign.user]],
    ['UPDATE financial_migration_items SET review_id=$2 WHERE id=$1',[next.invoiceItem,other.review]],
    ['UPDATE financial_migration_items SET invoice_id=$2 WHERE id=$1',[next.invoiceItem,other.invoice]],
    ['UPDATE financial_migration_items SET value_entry_id=$2 WHERE id=$1',[next.receiptItem,nativeFixtureIds(otherSlug).payment]],
    ['UPDATE staff_push_deliveries SET subscription_id=$2 WHERE id=$1',[next.push,other.subscription]],
    ['UPDATE staff_push_deliveries SET service_owner_id=$2 WHERE id=$1',[next.push,foreign.user]],
  ];
  for (const [query,values] of checks) {
    await database.exec('BEGIN');
    try { await assert.rejects(database.query(query,values), error => error.code === '23503'); }
    finally { await database.exec('ROLLBACK'); }
  }
  // A second campaign cannot make a claimed lead/address sendable again.
  await database.exec('BEGIN');
  try {
    const [clone] = (await database.query('INSERT INTO source_outreach_batches (organization_id,settings,payload_sha256,created_by_user_id,preview_expires_at,expires_at) SELECT organization_id,settings,payload_sha256,created_by_user_id,preview_expires_at,expires_at FROM source_outreach_batches WHERE id=$1 RETURNING id', [next.batch])).rows;
    assert.notEqual(clone.id, next.batch);
    await assert.rejects(database.query('INSERT INTO source_outreach_items (organization_id,batch_id,lead_id,contact_id,adoption_id,recipient,snapshot,claimed_at) SELECT organization_id,$2,lead_id,contact_id,adoption_id,recipient,snapshot,claimed_at FROM source_outreach_items WHERE id=$1',[next.item,clone.id]), error => error.code === '23505' && ['source_outreach_owned_lead_uq', 'source_outreach_owned_recipient_uq'].includes(error.constraint));
  } finally { await database.exec('ROLLBACK'); }
  assert.ok(id.organization);
  return checks.length;
}
