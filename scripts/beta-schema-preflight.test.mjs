import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedBetaIdentity, verifyBetaColumns } from './beta-schema-preflight.mjs';

const expected = [
  { schema: 'public', table: 'users', name: 'email_verified_at' },
  { schema: 'public', table: 'estimate_approvals', name: 'id' },
];
function reader(rows, identityRows) {
  const commands = [];
  return {
    commands,
    async query(sql) {
      commands.push(sql);
      return { rows: sql === identityQuery ? identityRows : rows };
    },
  };
}

const identityQuery = 'SELECT current_database() AS database_name, session_user AS session_user';
const identity = { database: 'intended_db', sessionUser: 'intended_login' };
const identityRow = { database_name: 'intended_db', session_user: 'intended_login' };
const readOnlyStart = ['BEGIN READ ONLY', "SET LOCAL statement_timeout = '15s'", identityQuery];
const completeColumns = expected.map(column => ({
  table_schema: column.schema, table_name: column.table, column_name: column.name,
}));

const production = { FLY_APP_NAME: 'mogulforge-growthos' };
const staging = { FLY_APP_NAME: 'mogulforge-growthos-staging' };
const pair = {
  GROWTHOS_PREFLIGHT_EXPECTED_DATABASE: 'intended_db',
  GROWTHOS_PREFLIGHT_EXPECTED_SESSION_USER: 'intended_login',
};

for (const [label, env] of [
  ['production without expectations', production],
  ['production with a blank role', { ...production, ...pair, GROWTHOS_PREFLIGHT_EXPECTED_SESSION_USER: '  ' }],
  ['production with only a role', { ...production, GROWTHOS_PREFLIGHT_EXPECTED_SESSION_USER: 'intended_login' }],
  ['staging with only a database', { ...staging, GROWTHOS_PREFLIGHT_EXPECTED_DATABASE: 'intended_db' }],
  ['staging with a blank database', { ...staging, ...pair, GROWTHOS_PREFLIGHT_EXPECTED_DATABASE: '' }],
]) {
  test(`rejects ${label} with a redacted configuration error`, () => {
    assert.throws(() => expectedBetaIdentity(env), /^Error: Beta database identity expectations are incomplete\.$/);
  });
}

test('staging may omit identity expectations or supply an exact pair', () => {
  assert.equal(expectedBetaIdentity(staging), null);
  assert.deepEqual(expectedBetaIdentity({ ...staging, ...pair }), identity);
  assert.deepEqual(expectedBetaIdentity({ ...production, ...pair }), identity);
});

test('checks exact identity before reading columns on the same read-only transaction', async () => {
  const client = reader(completeColumns, [identityRow]);
  await verifyBetaColumns(client, expected, identity);
  assert.deepEqual(client.commands.slice(0, 3), readOnlyStart);
  assert.match(client.commands[3], /^SELECT .* FROM information_schema\.columns /);
  assert.deepEqual(client.commands.slice(4), ['ROLLBACK']);
});

for (const [label, rows] of [
  ['the wrong database', [{ ...identityRow, database_name: 'different_db' }]],
  ['the wrong login', [{ ...identityRow, session_user: 'different_login' }]],
  ['a missing row', []],
  ['duplicate rows', [identityRow, identityRow]],
  ['a missing login field', [{ database_name: 'intended_db' }]],
  ['a null row', [null]],
  ['a malformed rows payload', identityRow],
]) {
  test(`rejects ${label} even with complete columns`, async () => {
    const client = reader(completeColumns, rows);
    await assert.rejects(verifyBetaColumns(client, expected, identity), /^Error: Beta database identity check failed\.$/);
    assert.deepEqual(client.commands, [...readOnlyStart, 'ROLLBACK']);
  });
}
test('rejects the historical schema missing beta tables, within a read-only transaction', async () => {
  const client = reader([{ table_schema: 'public', table_name: 'users', column_name: 'email_verified_at' }]);
  await assert.rejects(verifyBetaColumns(client, expected), /incomplete/);
  assert.equal(client.commands[0], 'BEGIN READ ONLY');
  assert.equal(client.commands.at(-1), 'ROLLBACK');
  assert.ok(client.commands.every(sql => /^(BEGIN READ ONLY|SET LOCAL|SELECT|ROLLBACK)/.test(sql)));
});
test('accepts complete columns and leaves no transaction open', async () => {
  const client = reader(expected.map(column => ({ table_schema: column.schema, table_name: column.table, column_name: column.name })));
  await verifyBetaColumns(client, expected);
  assert.equal(client.commands.at(-1), 'ROLLBACK');
});
