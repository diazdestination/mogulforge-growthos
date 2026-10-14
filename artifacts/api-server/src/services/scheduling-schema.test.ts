import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertAppointmentSchema, insertOrgSettingsSchema, insertProjectSchema } from '@workspace/db/schema';
import type { ReservationSnapshot, SchedulingPolicy } from '@workspace/scheduling-core';

const root = new URL('../../../../', import.meta.url);
const migration = new URL('reports/staging-schema-preview-2026-10-01/0019_saved-scheduling-policy.sql', root);
const pinsUrl = new URL('.superpowers/sdd/2026-10-13-saved-scheduling-capacity/baseline-sql-pins.json', root);
const organizationId = randomUUID(), contactId = randomUUID(), leadId = randomUUID();
const rowIds = { org_settings: randomUUID(), appointments: randomUUID(), projects: randomUUID() };
const surfaces = [
  { table: 'org_settings', column: 'scheduling_policy', constraint: 'org_settings_scheduling_policy_ck' },
  { table: 'appointments', column: 'scheduling_reservation', constraint: 'appointments_scheduling_reservation_ck' },
  { table: 'projects', column: 'scheduling_reservation', constraint: 'projects_scheduling_reservation_ck' },
] as const;
const policy: SchedulingPolicy = { formatVersion: 1, revision: 1, enabled: true, timeZone: 'America/Los_Angeles', minimumTravelGapMinutes: 30, maxConcurrentReservations: 3, durationPresets: [{ id: '00000000-0000-4000-8000-000000000001', label: 'Reviewed duration', elapsedMinutes: 90 }], digest: 'a'.repeat(64), updatedAt: '2026-10-13T12:00:00Z', updatedByUserId: 'synthetic-staff' };
function reservation(kind: 'appointment' | 'project'): ReservationSnapshot {
  return { formatVersion: 1, reservationRevision: 1, sourcePolicyRevision: 1, sourcePolicyDigest: 'a'.repeat(64), approvedTimeZone: 'America/Los_Angeles', inspection: null, startAt: '2026-10-13T15:00:00Z', endAt: '2026-10-13T16:30:00Z', resourceUserIds: ['synthetic-staff'], minimumTravelGapMinutes: 30, duration: { kind: 'preset', preset: policy.durationPresets[0]! }, admittedAt: '2026-10-13T12:00:00Z', admittedByUserId: 'synthetic-staff', target: { kind, id: rowIds[kind === 'appointment' ? 'appointments' : 'projects'] }, lastTransition: { kind: 'admission', actorUserId: 'synthetic-staff', at: '2026-10-13T12:00:00Z' } };
}
let current: pg.Client, upgraded: pg.Client;
const ownedDatabase = `scheduling_schema_${randomUUID().replaceAll('-', '')}`;
let databaseCreated = false;
let beforeCatalog: Awaited<ReturnType<typeof catalog>>;
let beforeRows: Record<string, unknown>;
async function catalog(client: pg.Client) {
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const columns = (await client.query("SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows;
  const constraints = (await client.query("SELECT c.relname AS table_name,p.conname,p.contype,pg_get_constraintdef(p.oid) AS definition,p.convalidated FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,p.conname")).rows;
  const indexes = (await client.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname")).rows;
  return { tables, columns, constraints, indexes };
}
async function fingerprints(client: pg.Client, removeNew = false) {
  const result: Record<string, unknown> = {};
  const { tables } = await catalog(client);
  for (const { tablename } of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw new Error('invalid_test_table');
    const projection = removeNew ? "to_jsonb(t)-'scheduling_policy'-'scheduling_reservation'" : 'to_jsonb(t)';
    result[tablename] = (await client.query(`SELECT count(*)::int AS count,md5(coalesce(string_agg(md5((${projection})::text),',' ORDER BY md5((${projection})::text)),'')) AS digest FROM "${tablename}" t`)).rows[0];
  }
  return result;
}
async function seed(client: pg.Client) {
  await client.query('INSERT INTO organizations(id,name,slug) VALUES($1,$2,$3)', [organizationId, 'Synthetic schema company', `scheduling-schema-${organizationId}`]);
  await client.query('INSERT INTO contacts(id,organization_id,first_name) VALUES($1,$2,$3)', [contactId, organizationId, 'Synthetic']);
  await client.query('INSERT INTO leads(id,organization_id,contact_id) VALUES($1,$2,$3)', [leadId, organizationId, contactId]);
  await client.query('INSERT INTO org_settings(id,organization_id) VALUES($1,$2)', [rowIds.org_settings, organizationId]);
  await client.query('INSERT INTO appointments(id,organization_id,scheduled_start,notes) VALUES($1,$2,$3,$4)', [rowIds.appointments, organizationId, '2026-10-13T15:00:00Z', 'Retained legacy visit']);
  await client.query('INSERT INTO projects(id,organization_id,lead_id,name,scheduled_start,crew_notes) VALUES($1,$2,$3,$4,$5,$6)', [rowIds.projects, organizationId, leadId, 'Retained legacy project', '2026-10-13T15:00:00Z', 'Retained crew notes']);
}
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hostname !== '127.0.0.1' || url.username !== 'postgres' || url.password !== 'forge-local-test-only' || url.pathname !== '/mogulforge_test') throw new Error('Only the local-dev runner owned fixture is authorized');
  current = new pg.Client({ connectionString: url.toString() }); await current.connect();
  expect((await current.query("SELECT current_database() AS database,current_schema() AS schema,current_setting('server_version_num')::int AS version")).rows[0]).toMatchObject({ database: 'mogulforge_test', schema: 'public' });
  expect(Number((await current.query("SELECT current_setting('server_version_num') AS version")).rows[0].version)).toBeGreaterThanOrEqual(160000);
  expect(Number((await current.query("SELECT current_setting('server_version_num') AS version")).rows[0].version)).toBeLessThan(170000);
  await seed(current);
  await current.query(`CREATE DATABASE "${ownedDatabase}"`); databaseCreated = true;
  url.pathname = `/${ownedDatabase}`;
  upgraded = new pg.Client({ connectionString: url.toString() }); await upgraded.connect();
  expect((await upgraded.query('SELECT current_database() AS database,current_schema() AS schema')).rows[0]).toEqual({ database: ownedDatabase, schema: 'public' });
  const pins = JSON.parse(await readFile(pinsUrl, 'utf8'));
  const predecessors = pins.files.filter((pin: { path: string }) => /^reports\/staging-schema-preview-2026-(?:09-30|10-01)\/\d{4}_/.test(pin.path));
  expect(predecessors).toHaveLength(19);
  for (const pin of predecessors) {
    const bytes = await readFile(new URL(pin.path, root));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.workingCopySha256);
    await upgraded.query(bytes.toString('utf8'));
  }
  await seed(upgraded);
  beforeCatalog = await catalog(upgraded);
  beforeRows = await fingerprints(upgraded);
}, 60_000);
afterAll(async () => {
  if (upgraded) expect((await upgraded.query('SELECT current_database() AS database,current_schema() AS schema')).rows[0]).toEqual({ database: ownedDatabase, schema: 'public' });
  await upgraded?.end();
  if (databaseCreated) {
    expect((await current.query('SELECT current_database() AS database,current_schema() AS schema')).rows[0]).toEqual({ database: 'mogulforge_test', schema: 'public' });
    await current.query(`DROP DATABASE "${ownedDatabase}"`);
    expect((await current.query('SELECT 1 FROM pg_database WHERE datname=$1', [ownedDatabase])).rowCount).toBe(0);
    console.log(JSON.stringify({ ownedSchedulingDatabaseCleanup: true, ownedDatabase, verifiedAbsent: true }));
  }
  await current?.end();
});

it('provisions all three nullable no-default JSONB fields explicitly in the runner schema', async () => {
  const actual = await catalog(current);
  for (const surface of surfaces) expect(actual.columns.find(row => row.table_name === surface.table && row.column_name === surface.column)).toMatchObject({ data_type: 'jsonb', is_nullable: 'YES', column_default: null });
  expect(actual.tables).toHaveLength(142);
});

it('appends 0019 to all 19 predecessors without changing any prior catalog definition or row', async () => {
  const sql = await readFile(migration, 'utf8').catch(() => null);
  expect(sql, 'the reviewed additive migration must exist').not.toBeNull();
  await upgraded.query(sql!);
  const actual = await catalog(upgraded);
  expect(actual.tables).toEqual(beforeCatalog.tables);
  expect(actual.tables).toHaveLength(142);
  const newColumns = actual.columns.filter(row => !beforeCatalog.columns.some(old => old.table_name === row.table_name && old.column_name === row.column_name));
  expect(newColumns.map(row => `${row.table_name}.${row.column_name}`).sort()).toEqual(['appointments.scheduling_reservation', 'org_settings.scheduling_policy', 'projects.scheduling_reservation']);
  expect(actual.columns.filter(row => !newColumns.includes(row))).toEqual(beforeCatalog.columns);
  const addedChecks = actual.constraints.filter(row => !beforeCatalog.constraints.some(old => old.table_name === row.table_name && old.conname === row.conname));
  expect(addedChecks.map(row => row.conname).sort()).toEqual(surfaces.map(row => row.constraint).sort());
  expect(addedChecks.every(row => row.contype === 'c' && row.convalidated)).toBe(true);
  expect(actual.constraints.filter(row => !addedChecks.includes(row))).toEqual(beforeCatalog.constraints);
  const sourceCatalog = await catalog(current);
  expect(addedChecks).toEqual(sourceCatalog.constraints.filter(row => surfaces.some(surface => surface.constraint === row.conname)));
  expect(actual.indexes).toEqual(beforeCatalog.indexes);
  expect(await fingerprints(upgraded, true)).toEqual(beforeRows);
  console.log(JSON.stringify({ schedulingUpgrade: true, tableCount: 142, predecessors: 19, addedColumns: newColumns.length, addedChecks: addedChecks.length, priorCatalogAndRowsUnchanged: true, ownedDatabase }));
});

it('omits scheduling authority from each generic insert contract', () => {
  expect(insertOrgSettingsSchema.parse({ organizationId, schedulingPolicy: policy })).not.toHaveProperty('schedulingPolicy');
  expect(insertAppointmentSchema.parse({ organizationId, scheduledStart: new Date(), schedulingReservation: reservation('appointment') })).not.toHaveProperty('schedulingReservation');
  expect(insertProjectSchema.parse({ organizationId, leadId, name: 'Synthetic', schedulingReservation: reservation('project') })).not.toHaveProperty('schedulingReservation');
});

for (const surface of surfaces) describe(`${surface.table} SQL envelope safeguards`, () => {
  const valid = surface.table === 'org_settings' ? policy : reservation(surface.table === 'appointments' ? 'appointment' : 'project');
  const write = (value: unknown, client = current) => client.query(`UPDATE "${surface.table}" SET "${surface.column}"=$1::jsonb WHERE id=$2`, [value === null ? null : JSON.stringify(value), rowIds[surface.table]]);
  it('retains legacy NULL rows and their explicit missing ends', async () => {
    await write(null);
    const row = (await current.query(`SELECT * FROM "${surface.table}" WHERE id=$1`, [rowIds[surface.table]])).rows[0];
    expect(row[surface.column]).toBeNull();
    if (surface.table !== 'org_settings') expect(row.scheduled_end).toBeNull();
  });
  it('stores the complete valid envelope unchanged', async () => {
    await write(valid);
    expect((await current.query(`SELECT "${surface.column}" AS envelope FROM "${surface.table}" WHERE id=$1`, [rowIds[surface.table]])).rows[0].envelope).toEqual(valid);
  });
  it.each([false, 1, 'wrong', [], {}].map(value => [value]))('refuses a non-envelope value %j with the named CHECK', async bad => {
    await expect(write(bad)).rejects.toMatchObject({ code: '23514', constraint: surface.constraint });
  });
  it('refuses JSON null while keeping SQL NULL as the legacy representation', async () => {
    await expect(current.query(`UPDATE "${surface.table}" SET "${surface.column}"='null'::jsonb WHERE id=$1`, [rowIds[surface.table]])).rejects.toMatchObject({ code: '23514', constraint: surface.constraint });
  });
  for (const field of Object.keys(valid)) it(`refuses missing ${field} rather than admitting SQL NULL`, async () => {
    const bad = { ...valid } as Record<string, unknown>; delete bad[field];
    await expect(write(bad)).rejects.toMatchObject({ code: '23514', constraint: surface.constraint });
  });
  const invalid: [string, unknown][] = [
    ['formatVersion', 0], ['formatVersion', 2], ['formatVersion', '1'], ['formatVersion', null],
    ['minimumTravelGapMinutes', -1], ['minimumTravelGapMinutes', 1441], ['minimumTravelGapMinutes', 0.5], ['minimumTravelGapMinutes', '30'], ['minimumTravelGapMinutes', null], ['minimumTravelGapMinutes', {}],
  ];
  for (const field of surface.table === 'org_settings' ? ['revision'] : ['reservationRevision', 'sourcePolicyRevision']) for (const bad of [0, -1, 1.5, 9007199254740992, '1', null, {}]) invalid.push([field, bad]);
  if (surface.table === 'org_settings') {
    for (const bad of ['true', 1, null, {}]) invalid.push(['enabled', bad]);
    for (const bad of [0, -1, 101, 1.5, '2', {}]) invalid.push(['maxConcurrentReservations', bad]);
    for (const bad of [null, {}, 'presets', Array.from({ length: 51 }, () => policy.durationPresets[0])]) invalid.push(['durationPresets', bad]);
  } else {
    for (const bad of [1, {}, [], true]) invalid.push(['admittedByUserId', bad]);
    for (const bad of [null, {}, 'staff']) invalid.push(['resourceUserIds', bad]);
    for (const bad of [null, [], 'duration']) invalid.push(['duration', bad]);
    for (const field of ['target', 'lastTransition']) for (const bad of [null, [], 'invalid']) invalid.push([field, bad]);
    for (const bad of [[], 'invalid', false]) invalid.push(['inspection', bad]);
  }
  for (const field of surface.table === 'org_settings' ? ['timeZone', 'digest', 'updatedAt', 'updatedByUserId'] : ['sourcePolicyDigest', 'approvedTimeZone', 'startAt', 'endAt', 'admittedAt']) for (const bad of [null, 1, {}, []]) invalid.push([field, bad]);
  it.each(invalid)('refuses wrongly typed or out-of-range %s=%j with CHECK rather than a cast error', async (field, bad) => {
    await expect(write({ ...valid, [field]: bad })).rejects.toMatchObject({ code: '23514', constraint: surface.constraint });
  });
  it.each([0, 1440])('accepts the exact travel bound %i', async gap => { await expect(write({ ...valid, minimumTravelGapMinutes: gap })).resolves.toBeDefined(); });
  if (surface.table === 'org_settings') {
    it.each([null, 1, 100])('accepts the exact nullable/concurrency bound %j', async cap => { await expect(write({ ...policy, maxConcurrentReservations: cap, enabled: false, revision: 9007199254740991 })).resolves.toBeDefined(); });
    it.each([[], Array.from({ length: 50 }, (_, i) => ({ id: randomUUID(), label: `Synthetic ${i}`, elapsedMinutes: i % 2 ? 1 : 1440 }))].map(value => [value]))('accepts the preset count and elapsed bounds', async presets => { await expect(write({ ...policy, durationPresets: presets })).resolves.toBeDefined(); });
    it.each([{}, null, [], [policy.durationPresets[0]], 'preset', 1].map(value => [value]))('refuses a non-preset object %j', async preset => { await expect(write({ ...policy, durationPresets: [preset] })).rejects.toMatchObject({ code: '23514', constraint: surface.constraint }); });
    for (const field of ['id', 'label', 'elapsedMinutes']) it(`refuses a preset missing ${field}`, async () => {
      const preset = { ...policy.durationPresets[0] } as Record<string, unknown>; delete preset[field];
      await expect(write({ ...policy, durationPresets: [preset] })).rejects.toMatchObject({ code: '23514', constraint: surface.constraint });
    });
    it.each([['id', null], ['id', 1], ['label', ''], ['label', '   '], ['label', '\t\n'], ['label', 'a'.repeat(81)], ['label', 1], ['elapsedMinutes', 0], ['elapsedMinutes', 1441], ['elapsedMinutes', 1.5], ['elapsedMinutes', '30'], ['elapsedMinutes', null]])('refuses independently malformed preset %s=%j', async (field, bad) => { await expect(write({ ...policy, durationPresets: [{ ...policy.durationPresets[0], [field]: bad }] })).rejects.toMatchObject({ code: '23514', constraint: surface.constraint }); });
  }
});
