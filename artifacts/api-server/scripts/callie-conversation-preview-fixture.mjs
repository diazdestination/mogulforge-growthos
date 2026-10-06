/** Additive fictional v2 visual QA. Parent owns disposable DB/runtime/codec. */
import assert from 'node:assert/strict';
import { seedSyntheticCallieConversation } from '../../../scripts/callie-conversation-recovery-fixture.mjs';

export async function seedCallieConversationPreview(client, organizationId, actorUserId, codec) {
  assert.equal(client?.connectionParameters?.host, '127.0.0.1', 'reception_preview_requires_disposable_loopback');
  assert.equal(client.connectionParameters.database, 'postgres', 'reception_preview_requires_disposable_database');
  assert.ok(codec?.encrypt && codec?.decrypt && codec?.wrongKeyRejects, 'reception_preview_requires_passed_credential_codec');
  const [company] = (await client.query('SELECT slug FROM organizations WHERE id=$1', [organizationId])).rows;
  assert.equal(company?.slug, 'local-runtime-qa', 'reception_preview_requires_fictional_company');
  // Seven days of reviewed retention, not an unbounded future timestamp. The
  // call/capability window is already over and both original effects stay unknown.
  const stamp = new Date(Date.now() - 3_600_000).toISOString();
  const manifest = await seedSyntheticCallieConversation(client, { namespace: `preview-reception-${organizationId}`, organizationId, actorUserId, codec, stamp, trade: 'roofing' });
  return { ...manifest, routes: { office: `/calls?callieId=${manifest.ids.intake}`, task: `/tasks?taskId=${manifest.ids.task}`, setup: '/calls' },
    qaBoundary: 'Fictional loopback-only data. All phone/provider gates remain off, budgets zero, current policy off. Unknown registration and handoff are not retryable. No customer identity, opportunity or booked visit was created.' };
}
