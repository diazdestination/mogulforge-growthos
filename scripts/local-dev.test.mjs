import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { assertOwnedContainer, databaseTestEnvironment, localEnvironment, parseLoopbackPort, withWslDockerSession } from './local-dev.mjs';

test('local actions discard inherited provider credentials and database targets', () => {
  const env = localEnvironment({ PATH: 'tools', DATABASE_URL: 'postgresql://live.example/production', OPENAI_API_KEY: 'private', GH_TOKEN: 'private', DOCKER_HOST: 'tcp://remote.example', NODE_OPTIONS: '--require untrusted.js', SCHEDULER_AUTOSTART: 'true' });
  assert.equal(env.PATH, 'tools');
  for (const key of ['DATABASE_URL', 'OPENAI_API_KEY', 'GH_TOKEN', 'DOCKER_HOST', 'NODE_OPTIONS']) assert.equal(env[key], undefined);
  assert.equal(env.SCHEDULER_AUTOSTART, 'false');
  assert.equal(env.GROWTHOS_OUTBOUND_HOLD, 'true');
});
test('database fixtures match CI without importing credentials or preview-only holds', () => {
  const env = databaseTestEnvironment({ PATH: 'tools', NODE_ENV: 'production', GROWTHOS_OUTBOUND_HOLD: 'true', OPENAI_API_KEY: 'private', DATABASE_URL: 'postgresql://live.example/production', DOCKER_HOST: 'tcp://remote.example' });
  assert.equal(env.NODE_ENV, 'test');
  assert.equal(env.CI, 'true');
  for (const key of ['GROWTHOS_ENVIRONMENT', 'GROWTHOS_OUTBOUND_HOLD', 'SCHEDULER_AUTOSTART', 'AUTO_MIGRATE', 'OPENAI_API_KEY', 'DATABASE_URL', 'DOCKER_HOST']) assert.equal(env[key], undefined);
});
test('cleanup rejects missing or different run ownership', () => {
  for (const inspection of [{}, { Config: { Labels: { 'com.forge.local-test': 'another-run' } } }]) {
    assert.throws(() => assertOwnedContainer(inspection, 'my-run'), /not owned/);
  }
  assert.doesNotThrow(() => assertOwnedContainer({ Config: { Labels: { 'com.forge.local-test': 'my-run' } } }, 'my-run'));
});
test('database targets reject LAN, IPv6 wildcard, multiple mappings and invalid ports', () => {
  assert.equal(parseLoopbackPort('127.0.0.1:54321\n'), 54321);
  for (const mapping of ['0.0.0.0:54321', '[::]:54321', '127.0.0.1:0', '127.0.0.1:99999', '127.0.0.1:54321\n0.0.0.0:54321']) {
    assert.throws(() => parseLoopbackPort(mapping), /only to 127.0.0.1/);
  }
});
function sessionFixture({ acknowledge = true } = {}) {
  const session = new EventEmitter();
  session.stdout = new PassThrough();
  session.stderr = new PassThrough();
  session.ended = false;
  session.stdin = new Writable({
    write(chunk, encoding, done) {
      if (acknowledge) session.stdout.write(chunk);
      done();
    },
    final(done) {
      session.ended = true;
      done();
      queueMicrotask(() => session.emit('close', 0));
    },
  });
  session.kill = () => { session.emit('close', 1); };
  return session;
}
test('WSL stays open through a long operation and closes after successful cleanup', async () => {
  const session = sessionFixture();
  const result = await withWslDockerSession(async () => {
    await new Promise(done => setTimeout(done, 25));
    assert.equal(session.ended, false);
    return 'verified';
  }, { enabled: true, spawnSession: (program, args) => {
    assert.equal(program, 'wsl.exe');
    assert.deepEqual(args, ['--distribution', 'Ubuntu-24.04', '--user', 'root', '--exec', 'cat']);
    return session;
  } });
  assert.equal(result, 'verified');
  assert.equal(session.ended, true);
});
test('failed database operations still close the owned WSL session', async () => {
  const session = sessionFixture();
  await assert.rejects(withWslDockerSession(async () => { throw new Error('database test failed'); }, { enabled: true, spawnSession: () => session }), /database test failed/);
  assert.equal(session.ended, true);
});
test('unacknowledged WSL startup cannot begin database work and closes the session', async () => {
  const session = sessionFixture({ acknowledge: false });
  let began = false;
  await assert.rejects(withWslDockerSession(async () => { began = true; }, { enabled: true, spawnSession: () => session, readyTimeoutMs: 10 }), /did not acknowledge/);
  assert.equal(began, false);
  assert.equal(session.ended, true);
});
