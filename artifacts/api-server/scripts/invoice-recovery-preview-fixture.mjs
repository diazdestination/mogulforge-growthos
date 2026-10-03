/** Fictional invoice exceptions; outbound remains held and no mailbox is connected. */
import { createHash } from 'node:crypto';
import { seedSyntheticInvoiceChain } from '../../../scripts/invoice-recovery-fixture.mjs';

export async function seedInvoiceRecoveryPreview(client, organizationId, actorUserId) {
  if (client.connectionParameters.host !== '127.0.0.1' || client.connectionParameters.database !== 'postgres')
    throw new Error('invoice_recovery_preview_requires_disposable_loopback');
  const [initial] = (await client.query('SELECT * FROM invoices WHERE organization_id=$1 ORDER BY created_at LIMIT 1', [organizationId])).rows;
  if (!initial || initial.status !== 'issued') throw new Error('invoice_recovery_preview_requires_synthetic_invoice');
  for (const [index, title, stopAfterBlocked] of [[2, 'FICTIONAL: safe retry review', true], [3, 'FICTIONAL: uncertain send - check original mailbox', false]]) {
    const document = { ...initial.issued_document, title, notes: 'LOCAL QA ONLY. Synthetic delivery history; no customer email was sent.' };
    const [invoice] = (await client.query(`INSERT INTO invoices(organization_id,lead_id,status,version,invoice_number,draft_document,issued_document,issued_document_sha256,issued_at,created_by_user_id)
      VALUES($1,$2,'issued',2,$3,$4,$4,$5,now(),$6) RETURNING id,issued_document`,
    [organizationId, initial.lead_id, `INV-00000${index}`, JSON.stringify(document), createHash('sha256').update(JSON.stringify(document)).digest('hex'), actorUserId])).rows;
    await client.query('UPDATE invoices SET issued_document_sha256=$2 WHERE id=$1', [invoice.id, createHash('sha256').update(JSON.stringify(invoice.issued_document)).digest('hex')]);
    await seedSyntheticInvoiceChain(client, { namespace: invoice.id, organizationId, actorUserId, invoiceId: invoice.id, stopAfterBlocked });
    console.log(`Synthetic invoice recovery: /invoices/${invoice.id} (${stopAfterBlocked ? 'typed no-dispatch proof' : 'unknown effect, no retry'}). Outbound held; no provider connection.`);
  }
  await client.query('UPDATE invoice_sequences SET next_number=4 WHERE organization_id=$1', [organizationId]);
}
