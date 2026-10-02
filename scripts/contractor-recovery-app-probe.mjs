/** Child of the synthetic recovery drill. No arbitrary target or provider configuration. */
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, resolve } from 'node:path';

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
  const headers = { authorization: `Bearer ${'a'.repeat(64)}` };
  const good = ['/api/healthz', '/api/auth/user', `/api/v1/contacts/${id.contact}`, `/api/v1/leads/${id.lead}`, `/api/v1/projects/${id.project}`, '/api/v1/revenue/value', '/api/v1/customer-lifecycle', '/api/v1/email-intelligence/replies'];
  for (const route of good) {
    check = `read_${good.indexOf(route)}`;
    const response = await fetch(`${origin}${route}`, { headers });
    assert.equal(response.status, 200, route); await response.arrayBuffer();
  }
  for (const route of [`/api/v1/contacts/${other.contact}`, `/api/v1/leads/${other.lead}`, `/api/v1/projects/${other.project}`]) {
    check = 'tenant_boundary';
    const response = await fetch(`${origin}${route}`, { headers });
    assert.equal(response.status, 404, route); await response.arrayBuffer();
  }
  check = 'http_write_rejected';
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
