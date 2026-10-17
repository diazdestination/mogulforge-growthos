import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('./saved-scheduling-schema-preview.mjs', import.meta.url));
const pinPath = 'reports/staging-schema-preview-2026-10-01/saved-scheduling-predecessor-pins.json';
function withCheckout(shallow, run, source = root) {
  const temporary = mkdtempSync(join(tmpdir(), 'scheduling-checkout-'));
  const checkout = join(temporary, 'checkout');
  try {
    execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '--no-local', '--single-branch', ...(shallow ? ['--depth=1'] : []), source, checkout], { windowsHide: true, stdio: 'pipe' });
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8', windowsHide: true }).trim()).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8', windowsHide: true }).trim());
    // Exercise the proposed verifier before commit; only its owned tracked inputs
    // are overlaid. Ignored controller receipts are never copied into a checkout.
    for (const path of ['scripts/saved-scheduling-schema-preview.mjs', pinPath]) {
      if (existsSync(resolve(root, path))) copyFileSync(resolve(root, path), resolve(checkout, path));
    }
    for (const path of ['node_modules', 'scripts/node_modules', 'lib/db/node_modules', 'lib/scheduling-core/node_modules']) {
      mkdirSync(dirname(resolve(checkout, path)), { recursive: true });
      symlinkSync(resolve(root, path), resolve(checkout, path), process.platform === 'win32' ? 'junction' : 'dir');
    }
    return run(checkout);
  } finally {
    expect(dirname(temporary)).toBe(resolve(tmpdir()));
    expect(temporary.startsWith(join(tmpdir(), 'scheduling-checkout-'))).toBe(true);
    rmSync(temporary, { recursive: true, force: true });
  }
}
function runPreview(checkout) {
  return spawnSync(process.execPath, [join(checkout, 'scripts/saved-scheduling-schema-preview.mjs')], { cwd: checkout, encoding: 'utf8', windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
}
async function previewModule() {
  expect(existsSync(script), 'the approved scheduling delta reviewer must exist').toBe(true);
  return import('./saved-scheduling-schema-preview.mjs');
}
function fixture() {
  const tables = Object.fromEntries(Array.from({ length: 139 }, (_, i) => [`public.prior_${i}`, { name: `prior_${i}`, columns: {}, checkConstraints: {} }]));
  for (const name of ['org_settings', 'appointments', 'projects']) tables[`public.${name}`] = { name, columns: { id: { name: 'id', type: 'uuid', primaryKey: true, notNull: true } }, checkConstraints: {}, indexes: {} };
  const before = { tables };
  const after = structuredClone(before);
  for (const [name, column, check] of [
    ['org_settings', 'scheduling_policy', 'org_settings_scheduling_policy_ck'],
    ['appointments', 'scheduling_reservation', 'appointments_scheduling_reservation_ck'],
    ['projects', 'scheduling_reservation', 'projects_scheduling_reservation_ck'],
  ]) {
    after.tables[`public.${name}`].columns[column] = { name: column, type: 'jsonb', primaryKey: false, notNull: false };
    after.tables[`public.${name}`].checkConstraints[check] = { name: check, value: 'guarded fixture check' };
  }
  return { before, after };
}

it('reviews the actual 142-table source delta and every predecessor byte pin without opening a database', () => {
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout.trim());
  expect(report).toMatchObject({ base: '5e4933bb21fd8b14fa37b0d844675975164ef68b', previousTables: 142, expectedTables: 142, priorDefinitionsUnchanged: true, predecessorFiles: 23, canonicalPredecessors: 19, databaseOpened: false, statements: 6 });
  expect(report.addedColumns).toEqual(['appointments.scheduling_reservation', 'org_settings.scheduling_policy', 'projects.scheduling_reservation']);
  expect(report.addedChecks).toEqual(['appointments_scheduling_reservation_ck', 'org_settings_scheduling_policy_ck', 'projects_scheduling_reservation_ck']);
  expect(report.predecessors).toHaveLength(19);
  const pins = JSON.parse(readFileSync(new URL(`../${pinPath}`, import.meta.url))).files;
  for (const predecessor of report.predecessors) expect(predecessor).toEqual(expect.objectContaining(pins.find(pin => pin.path === predecessor.path)));
  expect(report.migrationSha256).toMatch(/^[a-f0-9]{64}$/);
}, 60_000);

it('accepts only the three nullable JSONB additions and three allowlisted checks', async () => {
  const { verifySchedulingDelta } = await previewModule();
  const { before, after } = fixture();
  expect(verifySchedulingDelta(before, after)).toMatchObject({ previousTables: 142, expectedTables: 142, priorDefinitionsUnchanged: true });
});

it.each([
  ['a dropped prior table', after => { delete after.tables['public.prior_0']; }],
  ['a replaced table identity', after => { after.tables['public.replacement'] = after.tables['public.prior_0']; delete after.tables['public.prior_0']; }],
  ['a changed old column', after => { after.tables['public.appointments'].columns.id.notNull = false; }],
  ['a changed old index', after => { after.tables['public.projects'].indexes.extra = { name: 'extra' }; }],
  ['an extra column', after => { after.tables['public.projects'].columns.unapproved = { type: 'text' }; }],
  ['a default on an added column', after => { after.tables['public.org_settings'].columns.scheduling_policy.default = '{}'; }],
  ['a nonnullable added column', after => { after.tables['public.appointments'].columns.scheduling_reservation.notNull = true; }],
  ['an unreviewed check', after => { after.tables['public.projects'].checkConstraints.extra = { name: 'extra', value: 'true' }; }],
  ['a missing approved check', after => { delete after.tables['public.projects'].checkConstraints.projects_scheduling_reservation_ck; }],
])('rejects %s', async (_name, mutate) => {
  const { verifySchedulingDelta } = await previewModule();
  const { before, after } = fixture(); mutate(after);
  expect(() => verifySchedulingDelta(before, after)).toThrow(/scheduling_/);
});

it('rejects appended historical DML or any divergence from the generated SQL', async () => {
  const { verifyMigrationSql } = await previewModule();
  const generated = ['ALTER TABLE "org_settings" ADD COLUMN "scheduling_policy" jsonb;'];
  expect(() => verifyMigrationSql(`${generated[0]}\nUPDATE "appointments" SET notes = NULL;`, generated)).toThrow(/scheduling_/);
  expect(() => verifyMigrationSql('ALTER TABLE "org_settings" ADD COLUMN "scheduling_policy" jsonb DEFAULT NULL;', generated)).toThrow(/scheduling_/);
  expect(() => verifyMigrationSql(`-- review comment\n${generated[0]}\r\n`, generated)).not.toThrow();
});

it('detects changes to either working-copy or original Git bytes independently', async () => {
  const { verifySqlPin } = await previewModule();
  const pin = JSON.parse(readFileSync(new URL(`../${pinPath}`, import.meta.url))).files[3];
  const working = readFileSync(new URL(`../${pin.path}`, import.meta.url));
  const git = execFileSync('git', ['show', `5e4933bb21fd8b14fa37b0d844675975164ef68b:${pin.path}`], { cwd: root, windowsHide: true });
  expect(() => verifySqlPin(pin, working, git)).not.toThrow();
  expect(() => verifySqlPin(pin, Buffer.concat([working, Buffer.from('\n')]), git)).toThrow(/scheduling_/);
  expect(() => verifySqlPin(pin, working, Buffer.concat([git, Buffer.from('\n')]))).toThrow(/scheduling_/);
});

it('accepts LF and CRLF checkouts while rejecting substantive and mixed-EOL drift', async () => {
  const { verifySqlPin } = await previewModule();
  const canonical = Buffer.from('SELECT 1;\nSELECT 2;\n');
  const pin = { path: 'scripts/fixture.sql', gitBlobBytes: canonical.length, gitBlobSha256: createHash('sha256').update(canonical).digest('hex') };
  expect(() => verifySqlPin(pin, canonical, canonical)).not.toThrow();
  expect(() => verifySqlPin(pin, Buffer.from('SELECT 1;\r\nSELECT 2;\r\n'), canonical)).not.toThrow();
  expect(() => verifySqlPin(pin, Buffer.from('SELECT 9;\nSELECT 2;\n'), canonical)).toThrow(/scheduling_working_sql_bytes_changed/);
  expect(() => verifySqlPin(pin, Buffer.from('SELECT 1;\r\nSELECT 2;\n'), canonical)).toThrow(/scheduling_working_sql_bytes_changed/);
});

it('runs from an LF fresh checkout with no ignored controller ledger', () => withCheckout(false, checkout => {
  expect(existsSync(join(checkout, '.superpowers'))).toBe(false);
  const sqlPath = 'reports/staging-schema-preview-2026-09-30/0001_pilot-email-sender.sql';
  const bytes = readFileSync(join(checkout, sqlPath));
  expect(bytes.includes(Buffer.from('\r\n'))).toBe(false);
  const result = runPreview(checkout);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ predecessorFiles: 23, canonicalPredecessors: 19, priorDefinitionsUnchanged: true, statements: 6 });
  writeFileSync(join(checkout, sqlPath), Buffer.concat([bytes, Buffer.from('-- substantive drift\n')]));
  const dirty = runPreview(checkout);
  expect(dirty.status).toBe(1);
  expect(dirty.stderr).toContain('scheduling_working_sql_bytes_changed');
  execFileSync('git', ['add', '--', sqlPath], { cwd: checkout, windowsHide: true, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.name=Adam Mach', '-c', 'user.email=302037174+diazdestination@users.noreply.github.com', 'commit', '-m', 'test fixture committed SQL drift', '--', sqlPath], { cwd: checkout, windowsHide: true, stdio: 'pipe' });
  writeFileSync(join(checkout, sqlPath), bytes);
  const committed = runPreview(checkout);
  expect(committed.status).toBe(1);
  expect(committed.stderr).toContain('scheduling_git_sql_bytes_changed');
}), 120_000);

it('refuses missing shallow baseline objects and succeeds after the CI full-history checkout', () => withCheckout(true, checkout => {
  const missing = runPreview(checkout);
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('scheduling_baseline_git_object_missing');
  execFileSync('git', ['fetch', '--unshallow', 'origin'], { cwd: checkout, windowsHide: true, stdio: 'pipe' });
  const complete = runPreview(checkout);
  expect(complete.status, complete.stderr).toBe(0);
  expect(JSON.parse(complete.stdout)).toMatchObject({ predecessorFiles: 23, canonicalPredecessors: 19, priorDefinitionsUnchanged: true, statements: 6 });
}), 120_000);

it('also verifies a checkout whose source HEAD is detached like GitHub Actions', () => withCheckout(false, source => {
  execFileSync('git', ['checkout', '--detach', 'HEAD'], { cwd: source, windowsHide: true, stdio: 'pipe' });
  return withCheckout(false, checkout => {
    const result = runPreview(checkout);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ predecessorFiles: 23, canonicalPredecessors: 19, priorDefinitionsUnchanged: true });
  }, source);
}), 120_000);
