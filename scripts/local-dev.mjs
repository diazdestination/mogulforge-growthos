import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// One pinned pgvector-enabled PostgreSQL 16 image for local, CI and parity runs.
export const POSTGRES_IMAGE = 'pgvector/pgvector:0.8.0-pg16';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function localEnvironment(source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([key]) =>
    /^(PATH|SystemRoot|WINDIR|TEMP|TMP|PATHEXT|COMSPEC|USERPROFILE|APPDATA|LOCALAPPDATA|HOME|LANG|TERM)$/i.test(key)));
  return Object.assign(env, { CI: 'true', NODE_ENV: 'test', GROWTHOS_ENVIRONMENT: 'test', GROWTHOS_OUTBOUND_HOLD: 'true', SCHEDULER_AUTOSTART: 'false', AUTO_MIGRATE: 'false', DO_NOT_TRACK: '1' });
}
export function databaseTestEnvironment(source = process.env) {
  const env = localEnvironment(source);
  // Match CI's isolated test fixtures. Preview/parity holds must not suppress
  // the mocked dispatches that the regression tests intentionally exercise.
  for (const key of ['GROWTHOS_ENVIRONMENT', 'GROWTHOS_OUTBOUND_HOLD', 'SCHEDULER_AUTOSTART', 'AUTO_MIGRATE']) delete env[key];
  env.TZ = 'UTC';
  return env;
}
export function apiTestFiles(args) {
  if (args.some(file => !/^src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.test\.(?:ts|tsx|js|mjs)$/.test(file))) {
    throw new Error('API test files must be literal relative src/... .test.ts/.test.js paths.');
  }
  return args;
}
export function assertOwnedContainer(inspection, runId) {
  if (inspection?.Config?.Labels?.['com.forge.local-test'] !== runId) {
    throw new Error('Refusing to modify a container not owned by this test run.');
  }
}
export function parseLoopbackPort(output) {
  const match = /^127\.0\.0\.1:(\d+)\s*$/.exec(output.trim());
  const port = Number(match?.[1]);
  if (!match || port < 1 || port > 65535) throw new Error('Expected one PostgreSQL port bound only to 127.0.0.1.');
  return port;
}
export async function withWslDockerSession(operation, {
  enabled = process.platform === 'win32' && existsSync('C:/Forge/tools/local-dev/docker-wsl.mjs'),
  spawnSession = spawn,
  readyTimeoutMs = 30000,
} = {}) {
  if (!enabled) return operation();
  // systemd services do not keep a WSL distribution alive. An owned stdin
  // session keeps Docker available until the operation AND cleanup finish.
  // EOF closes cat normally, leaving no permanent background/startup helper.
  const marker = `FORGE_DOCKER_SESSION_${randomUUID()}`;
  const session = spawnSession('wsl.exe', ['--distribution', 'Ubuntu-24.04', '--user', 'root', '--exec', 'cat'], {
    env: localEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let closed = false;
  const exited = new Promise(done => session.once('close', () => { closed = true; done(); }));
  session.stdin.on('error', () => {});
  try {
    await new Promise((done, fail) => {
      let output = '';
      const timer = setTimeout(() => fail(new Error('WSL did not acknowledge the Docker session within 30 seconds.')), readyTimeoutMs);
      const cleanup = () => clearTimeout(timer);
      session.once('error', error => { cleanup(); fail(error); });
      session.once('close', () => { cleanup(); fail(new Error('WSL closed before the Docker session was ready.')); });
      session.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes(marker)) { cleanup(); done(); }
      });
      session.stdin.write(marker + '\n');
    });
    return await operation();
  } finally {
    session.stdin.end();
    if (!closed) {
      const deadline = setTimeout(() => session.kill('SIGTERM'), 5000);
      await exited;
      clearTimeout(deadline);
    }
  }
}
async function command(program, args, { env = localEnvironment(), capture = false, cwd = root } = {}) {
  if (process.platform === 'win32' && program === 'pnpm') {
    const paths = execFileSync('where.exe', ['pnpm'], { env, encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
    const launcher = paths.find(path => path.endsWith('.cmd'));
    const cli = launcher && ['pnpm.mjs', 'pnpm.cjs'].map(name => resolve(dirname(launcher), 'node_modules/pnpm/bin', name)).find(existsSync);
    if (!cli) throw new Error('Cannot resolve the installed pnpm Node.js launcher.');
    program = process.execPath; args = [cli, ...args];
  }
  if (process.platform === 'win32' && program === 'docker' && existsSync('C:/Forge/tools/local-dev/docker-wsl.mjs')) {
    program = process.execPath; args = ['C:/Forge/tools/local-dev/docker-wsl.mjs', ...args];
  }
  return new Promise((done, fail) => {
    const child = spawn(program, args, { cwd, env, windowsHide: true, stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
    let output = '';
    if (capture) child.stdout.on('data', chunk => { output += chunk; });
    child.once('error', fail);
    child.once('exit', code => code === 0 ? done(output.trim()) : fail(new Error(`${program} failed with exit code ${code}.`)));
    const stop = () => child.kill('SIGTERM');
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    child.once('exit', () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); });
  });
}
async function databaseTests(files = []) {
  await command('docker', ['version', '--format', '{{.Server.Version}}'], { capture: true });
  const runId = randomUUID();
  const name = `forge-growthos-test-${process.pid}-${runId.slice(0, 8)}`;
  let created = false;
  try {
    await command('docker', ['run', '--detach', '--rm', '--name', name, '--label', `com.forge.local-test=${runId}`, '--memory', '2g', '--cpus', '2', '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_USER=postgres', '--env', 'POSTGRES_PASSWORD=forge-local-test-only', '--env', 'POSTGRES_DB=mogulforge_test', POSTGRES_IMAGE], { capture: true });
    created = true;
    const inspect = async () => JSON.parse(await command('docker', ['inspect', name], { capture: true }))[0];
    assertOwnedContainer(await inspect(), runId);
    let ready = false;
    for (let attempt = 0; attempt < 45; attempt++) {
      try {
        await command('docker', ['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'mogulforge_test'], { capture: true });
        ready = true; break;
      } catch { await new Promise(done => setTimeout(done, 1000)); }
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready. No schema command ran.');
    const port = parseLoopbackPort(await command('docker', ['port', name, '5432/tcp'], { capture: true }));
    const env = Object.assign(databaseTestEnvironment(), {
      DATABASE_URL: `postgresql://postgres:forge-local-test-only@127.0.0.1:${port}/mogulforge_test`,
      SESSION_SECRET: 'ci-only-session-secret-that-is-long-enough-for-validation',
      EMAIL_INGESTION_WEBHOOK_SECRET: 'ci-only-email-intake-signing-secret',
      EMAIL_INTELLIGENCE_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      OAUTH_TOKEN_ENCRYPTION_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
    });
    // The schema target is constructed only from this run's owned container.
    await command('pnpm', ['--filter', '@workspace/db', 'run', 'push-force'], { env });
    if (!files.length) await command('pnpm', ['-r', '--filter', '!@workspace/api-server', '--if-present', 'run', 'test'], { env });
    // Match the disposable database's two CPUs and avoid unrelated fixture
    // files competing for its resources. Race tests still open their own
    // independent PostgreSQL clients inside each file.
    await command('pnpm', ['--filter', '@workspace/api-server', 'run', 'test', '--maxWorkers=2', ...files], { env });
    if (!files.length) await command(process.execPath, ['--test', 'examples/website-connection/adapter.test.mjs', 'examples/website-connection/operations.test.mjs'], { env });
  } finally {
    if (created) {
      const inspection = JSON.parse(await command('docker', ['inspect', name], { capture: true }))[0];
      assertOwnedContainer(inspection, runId);
      await command('docker', ['rm', '--force', name], { capture: true });
    }
  }
}
export async function main(action = process.argv[2]) {
  switch (action) {
    case 'setup': {
      const version = await command('pnpm', ['--version'], { capture: true });
      if (version !== '11.3.0') throw new Error('Use pnpm 11.3.0, matching the repository CI.');
      await command('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']);
      break;
    }
    case 'run':
      await command('pnpm', ['--filter', '@workspace/command-center', 'run', 'build']);
      await command(process.execPath, ['artifacts/api-server/scripts/preview-runtime-isolated.mjs', '--returning-customer'], { env: localEnvironment() });
      break;
    case 'test': {
      const files = apiTestFiles(process.argv.slice(3));
      await withWslDockerSession(() => databaseTests(files));
      break;
    }
    case 'ui': await command('pnpm', ['--filter', '@workspace/command-center', 'run', 'test']); break;
    case 'typecheck': await command('pnpm', ['run', 'typecheck']); break;
    case 'parity': await withWslDockerSession(() => command('pwsh', ['-NoProfile', '-File', 'scripts/verify-docker-staging-parity.ps1'], { env: { ...localEnvironment(), CI: 'false' } })); break;
    case 'browser':
      if (process.platform !== 'win32') throw new Error('Browser QA requires the installed Windows Forge shipping kit.');
      await command(process.execPath, ['C:/Forge/tools/shipping-kit/scripts/audit.mjs', 'http://127.0.0.1:4193']);
      break;
    default: throw new Error('Choose setup, run, test, ui, typecheck, browser, or parity.');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
