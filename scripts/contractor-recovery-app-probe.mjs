/** Child of the synthetic recovery drill. No arbitrary target or provider configuration. */
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, resolve } from 'node:path';
import { nativeFixtureIds } from './native-contractor-recovery-fixture.mjs';
import { careFixtureIds } from './customer-care-recovery-fixture.mjs';
import { operationsFixtureIds } from './operations-wave-recovery-fixture.mjs';
import { leadReplyFixtureIds } from './lead-replies-recovery-fixture.mjs';

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
  for (const route of good) {
    check = `read_${good.indexOf(route)}`;
    const response = await fetch(`${origin}${route}`, { headers });
    assert.equal(response.status, 200, route); await response.arrayBuffer();
    assert.equal(databaseFailed, false);
  }
  const invoice = await (await fetch(`${origin}/api/v1/invoices/${native.invoice}`, { headers })).json();
  assert.equal(invoice.recordedPaidCents,0); assert.equal(invoice.balanceDueCents,10000);
  assert.equal(invoice.allocations.length,1); assert.ok(invoice.allocations[0].reversedAt);
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
  process.stdout.write(`${JSON.stringify({ appBootVerified: true, readOnlyDatabaseVerified: true, tenantBoundariesVerified: true, readChecks: good.length, writeBlocked: true })}\n`);
} catch (error) {
  // No response body, URL with credentials, SQL parameters or record content.
  process.stderr.write(`CONTRACTOR_APP_PROBE_FAILED:${check}:${error.code === 'ERR_ASSERTION' ? 'assertion' : 'unavailable'}${Number.isInteger(error.actual) ? `:status_${error.actual}` : ''}\n`);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((done) => server.close(done));
  await pool.end();
}
