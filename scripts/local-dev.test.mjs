import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { assertOwnedContainer, localEnvironment, parseLoopbackPort } from './local-dev.mjs';

test('local actions discard inherited provider credentials and database targets', () => {
  const env = localEnvironment({ PATH: 'tools', DATABASE_URL: 'postgresql://live.example/production', OPENAI_API_KEY: 'private', GH_TOKEN: 'private', DOCKER_HOST: 'tcp://remote.example', NODE_OPTIONS: '--require untrusted.js', SCHEDULER_AUTOSTART: 'true' });
  assert.equal(env.PATH, 'tools');
  for (const key of ['DATABASE_URL', 'OPENAI_API_KEY', 'GH_TOKEN', 'DOCKER_HOST', 'NODE_OPTIONS']) assert.equal(env[key], undefined);
  assert.equal(env.SCHEDULER_AUTOSTART, 'false');
  assert.equal(env.GROWTHOS_OUTBOUND_HOLD, 'true');
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
