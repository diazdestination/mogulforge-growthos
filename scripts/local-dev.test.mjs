import { it as test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { apiTestFiles, assertOwnedContainer, databaseTestEnvironment, localEnvironment, main, parseLoopbackPort, withWslDockerSession } from './local-dev.mjs';

const launcher = vi.hoisted(() => ({ paths: [], existing: new Set(), spawns: [], discoveries: [] }));
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal(), existsSync: path => launcher.existing.has(path) }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal(),
  execFileSync(program, args, options) {
    assert.equal(program, 'where.exe');
    assert.deepEqual(args, ['pnpm']);
    launcher.discoveries.push({ program, args, options });
    return launcher.paths.join('\r\n') + '\r\n';
  },
  spawn(program, args, options) {
    launcher.spawns.push({ program, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = () => { child.emit('exit', 1); };
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  },
}));
async function installedPnpm(paths, existing, operation, platform = 'win32') {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  launcher.paths = paths;
  launcher.existing = new Set(existing);
  launcher.spawns = [];
  launcher.discoveries = [];
  Object.defineProperty(process, 'platform', { value: platform });
  try { await operation(); } finally { Object.defineProperty(process, 'platform', descriptor); }
}
const uiArgs = ['--filter', '@workspace/command-center', 'run', 'test'];
function directSpawn(program, args) {
  assert.equal(launcher.spawns.length, 1);
  assert.equal(launcher.spawns[0].program, program);
  assert.deepEqual(launcher.spawns[0].args, args);
  assert.equal(launcher.spawns[0].options.shell ?? false, false);
  assert.equal(launcher.spawns[0].options.windowsHide, true);
  assert.deepEqual(launcher.spawns[0].options.stdio, ['ignore', 'inherit', 'inherit']);
}
test('discovered Winget native pnpm survives an incomplete later Codex fallback cmd', async () => {
  const executable = 'C:/Users/diazd/AppData/Local/Microsoft/WinGet/Packages/pnpm.pnpm_Microsoft.Winget.Source_8wekyb3d8bbwe/pnpm.exe';
  const fallback = 'C:/Users/diazd/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm.cmd';
  await installedPnpm([executable, fallback], [executable], async () => {
    await main('ui');
    directSpawn(executable, uiArgs);
    assert.equal(launcher.discoveries.length, 1);
  });
});
test('native-executable-only pnpm receives the unchanged typecheck arguments directly', async () => {
  const executable = 'C:/Program Files/pnpm/pnpm.exe';
  await installedPnpm([executable], [executable], async () => {
    await main('typecheck');
    directSpawn(executable, ['run', 'typecheck']);
  });
});
test('a real Node mjs launcher remains preferred over a discovered native executable', async () => {
  const executable = 'C:/Tools/pnpm/pnpm.exe';
  const cmd = 'C:/Program Files/Node Tools/pnpm.cmd';
  const cli = 'C:\\Program Files\\Node Tools\\node_modules\\pnpm\\bin\\pnpm.mjs';
  await installedPnpm([executable, cmd], [executable, cli, 'C:\\Program Files\\Node Tools\\node_modules\\pnpm\\bin\\pnpm.cjs'], async () => {
    await main('ui');
    directSpawn(process.execPath, [cli, ...uiArgs]);
  });
});
test('an installed Node cjs launcher remains supported when the mjs file is absent', async () => {
  const cmd = 'C:/Tools/pnpm/pnpm.cmd';
  const cli = 'C:\\Tools\\pnpm\\node_modules\\pnpm\\bin\\pnpm.cjs';
  await installedPnpm([cmd], [cli], async () => {
    await main('ui');
    directSpawn(process.execPath, [cli, ...uiArgs]);
  });
});
test('an incomplete cmd before a native executable does not block direct fallback', async () => {
  const executable = 'C:/Tools/pnpm/pnpm.exe';
  await installedPnpm(['C:/Broken/pnpm.cmd', executable], [executable], async () => {
    await main('ui');
    directSpawn(executable, uiArgs);
  });
});
test('a later complete cmd remains preferred after an earlier incomplete cmd', async () => {
  const cmd = 'C:/Tools/pnpm/pnpm.cmd';
  const cli = 'C:\\Tools\\pnpm\\node_modules\\pnpm\\bin\\pnpm.mjs';
  await installedPnpm(['C:/Broken/pnpm.cmd', 'C:/Tools/pnpm/pnpm.exe', cmd], ['C:/Tools/pnpm/pnpm.exe', cli], async () => {
    await main('ui');
    directSpawn(process.execPath, [cli, ...uiArgs]);
  });
});
test('unsupported or missing discovered launchers never spawn a shell or command', async () => {
  for (const { paths, existing } of [
    { paths: [], existing: [] },
    { paths: ['C:/Tools/pnpm.ps1'], existing: ['C:/Tools/pnpm.ps1'] },
    { paths: ['C:/Tools/pnpm'], existing: ['C:/Tools/pnpm'] },
    { paths: ['C:/Broken/pnpm.cmd'], existing: ['C:/Broken/pnpm.cmd'] },
    { paths: ['C:/Missing/pnpm.exe'], existing: [] },
    { paths: ['C:/Tools/other.exe'], existing: ['C:/Tools/other.exe'] },
  ]) {
    await installedPnpm(paths, existing, async () => {
      await assert.rejects(main('ui'), /Cannot resolve the installed pnpm/);
      assert.equal(launcher.spawns.length, 0);
    });
  }
});
test('non-Windows pnpm invocation keeps its existing program and arguments without discovery', async () => {
  await installedPnpm([], [], async () => {
    await main('ui');
    directSpawn('pnpm', uiArgs);
    assert.equal(launcher.discoveries.length, 0);
  }, 'linux');
});

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
  assert.equal(env.TZ, 'UTC');
  for (const key of ['GROWTHOS_ENVIRONMENT', 'GROWTHOS_OUTBOUND_HOLD', 'SCHEDULER_AUTOSTART', 'AUTO_MIGRATE', 'OPENAI_API_KEY', 'DATABASE_URL', 'DOCKER_HOST']) assert.equal(env[key], undefined);
});
test('focused database tests cannot introduce options, absolute paths or traversal', () => {
  assert.deepEqual(apiTestFiles(['src/services/mailbox-lead-integration.test.ts']), ['src/services/mailbox-lead-integration.test.ts']);
  for (const file of ['--config=outside.js', '../outside.test.ts', 'src/../../outside.test.ts', 'C:/outside.test.ts', 'src/services/*.test.ts']) assert.throws(() => apiTestFiles([file]));
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
