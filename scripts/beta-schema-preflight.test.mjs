import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyBetaColumns } from './beta-schema-preflight.mjs';

const expected = [
  { schema: 'public', table: 'users', name: 'email_verified_at' },
  { schema: 'public', table: 'estimate_approvals', name: 'id' },
];
function reader(rows) {
  const commands = [];
  return { commands, async query(sql) { commands.push(sql); return { rows }; } };
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
