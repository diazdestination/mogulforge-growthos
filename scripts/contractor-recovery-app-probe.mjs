/** Child of the synthetic recovery drill. No arbitrary target or provider configuration. */
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, resolve } from 'node:path';
import { nativeFixtureIds } from './native-contractor-recovery-fixture.mjs';
import { careFixtureIds } from './customer-care-recovery-fixture.mjs';
import { operationsFixtureIds } from './operations-wave-recovery-fixture.mjs';
import { leadReplyFixtureIds } from './lead-replies-recovery-fixture.mjs';
import { invoiceRecoveryIds } from './invoice-recovery-fixture.mjs';
import { callieFixtureIds } from './callie-recovery-fixture.mjs';

const target = new URL(process.env.DATABASE_URL ?? '');
if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.hostname !== '127.0.0.1' || target.pathname !== '/postgres' || process.env.CONTRACTOR_SYNTHETIC_RECOVERY !== 'true' || process.env.NODE_ENV !== 'test') throw new Error('contractor_probe_target_invalid');
const fetchLocal = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('contractor_probe_external_request_forbidden');
  return fetchLocal(input, init);
};
const { fixtureIds } = await import('./restore-drill-fixture.mjs');
const compiled = resolve(process.env.CONTRACTOR_RECOVERY_APP ?? '');
const artifactRoot = fileURLToPath(new URL('../artifacts/api-server', import.meta.url));
if (dirname(dirname(compiled)) !== artifactRoot || !basename(dirname(compiled)).startsWith('.contractor-recovery-') || basename(compiled) !== 'contractor-recovery-entry.mjs') throw new Error('contractor_probe_build_invalid');
const { default: app, pool } = await import(pathToFileURL(compiled).href);
let databaseFailed = false;
// Keep connection failures observable without dumping driver objects/secrets.
pool.on('error', () => { databaseFailed = true; });
let server, check = 'database_identity';
try {
  const databaseIdentity = (await pool.query('SELECT session_user AS username')).rows[0];
  assert.equal(databaseIdentity.username, 'contractor_recovery_reader');
  check = 'database_write_rejected';
  await assert.rejects(pool.query("INSERT INTO organizations(name,slug) VALUES('Forbidden','forbidden')"));
  server = app.listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const id = fixtureIds('restore-drill-contractor-a');
  const other = fixtureIds('restore-drill-contractor-b');
  const native = nativeFixtureIds('restore-drill-contractor-a'), otherNative = nativeFixtureIds('restore-drill-contractor-b');
  const headers = { authorization: `Bearer ${'a'.repeat(64)}` };
  const good = ['/api/healthz', '/api/auth/user', `/api/v1/contacts/${id.contact}`, `/api/v1/leads/${id.lead}`, `/api/v1/projects/${id.project}`, '/api/v1/revenue/value', '/api/v1/customer-lifecycle', '/api/v1/email-intelligence/replies', '/api/v1/contractor/today?date=2026-10-01', '/api/v1/invoices', `/api/v1/invoices/${native.invoice}`, '/api/v1/service-obligations'];
  good.push(`/api/v1/invoices/${native.invoice}/delivery`, `/api/v1/service-obligations/${native.nextService}/care`, '/api/v1/communications/missed-call-care');
  const operations = operationsFixtureIds('restore-drill-contractor-a'), foreignOperations = operationsFixtureIds('restore-drill-contractor-b');
  good.push('/api/v1/service-watch', `/api/v1/service-obligations/${native.nextService}/watch`, '/api/v1/source-adoption',
    `/api/v1/source-adoption/outreach/${operations.batch}`, '/api/v1/financial-migrations', `/api/v1/financial-migrations/${operations.review}`, `/api/v1/invoices/${operations.invoice}`);
  good.push(`/api/v1/service-obligations/${native.nextService}/mailbox-replies`, '/api/v1/staff-invitations/email-deliveries');
  good.push(`/api/v1/leads/${id.lead}/mailbox-replies`);
  good.push('/api/v1/invoices/delivery-worklist');
  const callie = callieFixtureIds('restore-drill-contractor-a'), foreignCallie = callieFixtureIds('restore-drill-contractor-b');
  good.push('/api/v1/communications/callie?scope=attention', '/api/v1/communications/callie/policy', `/api/v1/communications/callie/${callie.intake}`);
  for (const route of good) {
    check = `read_${good.indexOf(route)}`;
    const response = await fetch(`${origin}${route}`, { headers });
    assert.equal(response.status, 200, route); await response.arrayBuffer();
    assert.equal(databaseFailed, false);
  }
  const invoice = await (await fetch(`${origin}/api/v1/invoices/${native.invoice}`, { headers })).json();
  assert.equal(invoice.recordedPaidCents,0); assert.equal(invoice.balanceDueCents,10000);
  assert.equal(invoice.allocations.length,1); assert.ok(invoice.allocations[0].reversedAt);
  check = 'invoice_recovery_chain';
  const delivery = await (await fetch(`${origin}/api/v1/invoices/${native.invoice}/delivery`, { headers })).json();
  assert.equal(delivery.integrity, 'valid'); assert.equal(delivery.attemptCount, 2); assert.equal(delivery.state, 'uncertain');
  assert.equal(delivery.canPrepare, false); assert.deepEqual(delivery.nextIntents, []);
  assert.equal(delivery.latestExecutionId, invoiceRecoveryIds('restore-drill-contractor-a').secondExecution);
  assert.deepEqual(delivery.attempts.map(row => row.proof), ['not_dispatched', 'none']);
  assert.deepEqual(delivery.attempts.map(row => row.state), ['blocked', 'indeterminate']);
  check = 'invoice_delivery_worklist';
  const worklist = await (await fetch(`${origin}/api/v1/invoices/delivery-worklist`, { headers })).json();
  assert.equal(worklist.pageSize, 25); assert.equal(worklist.total, 2);
  assert.equal(worklist.items.some(row => row.invoiceId === otherNative.invoice), false);
  const listed = worklist.items.find(row => row.invoiceId === native.invoice);
  assert.equal(listed.delivery.integrity, 'valid'); assert.equal(listed.delivery.attemptCount, 2);
  assert.equal(listed.delivery.latestAttempt.state, 'indeterminate'); assert.deepEqual(listed.delivery.nextIntents, []);
  assert.match(worklist.boundary, /not all delivery exceptions/);
  const foreignPage = await fetch(`${origin}/api/v1/invoices/delivery-worklist?leadId=${other.lead}`, { headers });
  assert.equal(foreignPage.status, 200); assert.deepEqual((await foreignPage.json()).items, []);
  const opening = await (await fetch(`${origin}/api/v1/invoices/${operations.invoice}`, { headers })).json();
  assert.equal(opening.recordedPaidCents,0); assert.equal(opening.balanceDueCents,6000); assert.equal(opening.balanceBasis,'opening_receivable');
  const outreach = await (await fetch(`${origin}/api/v1/source-adoption/outreach/${operations.batch}`, { headers })).json();
  assert.equal(outreach.state,'revoked'); assert.equal(outreach.items[0].delivery.state,'uncertain');
  check = 'service_reply_evidence';
  const serviceReplies = await (await fetch(`${origin}/api/v1/service-obligations/${native.nextService}/mailbox-replies`, { headers })).json();
  assert.equal(serviceReplies.items.length, 1);
  assert.equal(serviceReplies.items[0].holdActive, true);
  assert.equal(serviceReplies.items[0].content, null);
  assert.equal(serviceReplies.items[0].state, 'needs_review');
  check = 'lead_reply_evidence';
  const leadReplies = await (await fetch(`${origin}/api/v1/leads/${id.lead}/mailbox-replies`, { headers })).json();
  assert.equal(leadReplies.items.length, 1);
  assert.equal(leadReplies.items[0].id, leadReplyFixtureIds('restore-drill-contractor-a').reply);
  assert.equal(leadReplies.items[0].holdActive, true);
  assert.equal(leadReplies.items[0].content, null);
  assert.equal(leadReplies.items[0].taskId, leadReplyFixtureIds('restore-drill-contractor-a').task);
  assert.equal(leadReplies.items[0].evidence, 'original_mailbox_observation');
  check = 'callie_restored_request';
  const callieDetail = await (await fetch(`${origin}/api/v1/communications/callie/${callie.intake}`, { headers })).json();
  assert.equal(callieDetail.state, 'indeterminate'); assert.equal(callieDetail.identityReviewed, false);
  assert.equal(callieDetail.appointment, null); assert.equal(callieDetail.task.id, callie.task);
  assert.equal(callieDetail.execution.state, 'indeterminate'); assert.equal(callieDetail.delivery.status, 'uncertain');
  assert.equal(callieDetail.companyHeld, true); assert.equal(callieDetail.actions.canBook, false);
  assert.equal(callieDetail.requestIntent, 'visit');
  for (const key of ['challengeHash', 'challengeEncrypted', 'stepReceipts', 'triggerPayloadHash']) assert.equal(key in callieDetail, false);
  const calliePage = await (await fetch(`${origin}/api/v1/communications/callie?scope=attention`, { headers })).json();
  assert.equal(calliePage.pageSize, 25); assert.equal(calliePage.hasMore, false);
  assert.deepEqual(calliePage.items.map(row => row.id), [callie.intake]);
  const calliePolicy = await (await fetch(`${origin}/api/v1/communications/callie/policy`, { headers })).json();
  assert.equal(calliePolicy.version, 2); assert.equal(calliePolicy.policy.enabled, false); assert.equal(calliePolicy.readiness.ready, false);
  assert.equal((await fetch(`${origin}/api/v1/communications/callie/${foreignCallie.intake}`, { headers })).status, 404);
  for (const route of [`/api/v1/contacts/${other.contact}`, `/api/v1/leads/${other.lead}`, `/api/v1/projects/${other.project}`, `/api/v1/invoices/${otherNative.invoice}`, `/api/v1/service-obligations/${otherNative.nextService}/care`, `/api/v1/communications/voice/${careFixtureIds('restore-drill-contractor-b').call}/care`, `/api/v1/invoices/${otherNative.invoice}/delivery`]) {
    check = 'tenant_boundary';
    const response = await fetch(`${origin}${route}`, { headers });
    assert.equal(response.status, 404, route); await response.arrayBuffer();
  }
  check = 'http_write_rejected';
  for (const route of [`/api/v1/service-obligations/${otherNative.nextService}/watch`, `/api/v1/source-adoption/outreach/${foreignOperations.batch}`, `/api/v1/financial-migrations/${foreignOperations.review}`, `/api/v1/invoices/${foreignOperations.invoice}`]) {
    const response = await fetch(`${origin}${route}`,{headers}); assert.equal(response.status,404,route); await response.arrayBuffer();
  }
  assert.equal((await fetch(`${origin}/api/v1/service-obligations/${otherNative.nextService}/mailbox-replies`, { headers })).status, 404);
  assert.equal((await fetch(`${origin}/api/v1/leads/${other.lead}/mailbox-replies`, { headers })).status, 404);
  const mutation = await fetch(`${origin}/api/v1/contacts/${id.contact}`, { method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ firstName: 'Forbidden' }) });
  assert.equal(mutation.status, 405); await mutation.arrayBuffer();
  const callieMutation = await fetch(`${origin}/api/v1/communications/callie/${callie.intake}/office-action`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(callieMutation.status, 405); await callieMutation.arrayBuffer();
  process.stdout.write(`${JSON.stringify({ appBootVerified: true, readOnlyDatabaseVerified: true, tenantBoundariesVerified: true, readChecks: good.length, writeBlocked: true })}\n`);
} catch (error) {
  // No response body, URL with credentials, SQL parameters or record content.
  process.stderr.write(`CONTRACTOR_APP_PROBE_FAILED:${check}:${error.code === 'ERR_ASSERTION' ? 'assertion' : 'unavailable'}${Number.isInteger(error.actual) ? `:status_${error.actual}` : ''}\n`);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((done) => server.close(done));
  await pool.end();
}
