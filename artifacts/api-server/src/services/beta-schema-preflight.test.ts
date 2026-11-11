import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('admits the current PostgreSQL fixture using the packaged read-only release command', () => {
  const scripts = new URL('../../../../scripts/', import.meta.url);
  const require = createRequire(new URL('package.json', scripts));
  const result = spawnSync(process.execPath, [
    require.resolve('tsx/cli'),
    fileURLToPath(new URL('beta-schema-preflight.mjs', scripts)),
  ], { encoding: 'utf8', env: process.env, timeout: 25_000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('Beta schema column check passed');
});
