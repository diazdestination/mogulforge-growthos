/** Project the reviewed read-only DTOs. Does not change schema or activate providers. */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tsImport } from 'tsx/esm/api';

const requireApi = createRequire(new URL('../artifacts/api-server/package.json', import.meta.url));
const { z } = requireApi('zod');
const contract = await tsImport('../artifacts/api-server/src/services/customer-workspace-contract.ts', import.meta.url);
const target = new URL('../lib/api-spec/openapi.yaml', import.meta.url);
let source = (await readFile(target, 'utf8')).replace(/\r\n/g, '\n');
function normalize(value) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'string' && ['date', 'date-time'].includes(value.format)) delete value.pattern;
  for (const child of Object.values(value)) normalize(child);
}
const schemas = new Map();
function schema(name, value) {
  const json = z.toJSONSchema(value, { target: 'openapi-3.0', unrepresentable: 'throw' });
  delete json.$schema; normalize(json); schemas.set(name, json);
  return { $ref: `#/components/schemas/${name}` };
}
const header = schema('CustomerWorkspaceHeader', contract.customerWorkspaceHeaderSchema);
const page = schema('CustomerWorkspacePage', contract.customerWorkspacePageSchema);
const appointment = schema('CustomerWorkspaceAppointmentDetail', contract.customerWorkspaceAppointmentDetailSchema);
const errors = Object.fromEntries(Object.entries({
  400: 'Invalid UUID, section, cursor or query. Unknown and duplicate selectors rejected.',
  401: 'Staff sign-in required.', 403: 'Accepted active staff session and current section permission required. API keys are not accepted.',
  404: 'Canonical record not found in this company.', 503: 'Record unavailable; refresh before continuing.',
}).map(([code, description]) => [code, { description }]));
function operation(operationId, summary, response) {
  return {
    operationId, tags: ['contacts'], summary,
    description: 'Read-only canonical customer records for current accepted staff. Company comes only from the session. No writes, financial totals, raw activity/mailbox contents or inferred parent links. Sending holds do not block historical reading. Section pages contain at most 25 valid rows in created-descending order, using company/customer/section-bound keyset cursors; not a frozen export.',
    parameters: [{ $ref: '#/components/parameters/IdPathParam' }],
    responses: { 200: { description: 'Safe canonical read projection.', content: { 'application/json': { schema: response } } }, ...errors },
  };
}
const section = operation('getCustomerWorkspaceSection', 'Read one bounded canonical customer record section', page);
section.parameters.push(
  { name: 'section', in: 'path', required: true, schema: { type: 'string', enum: contract.CUSTOMER_WORKSPACE_SECTIONS } },
  { name: 'cursor', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 2048, pattern: '^[A-Za-z0-9_-]+$' } },
);
const paths = new Map([
  ['/v1/contacts/{id}/workspace', { get: operation('getCustomerWorkspace', 'Read a canonical customer header and available sections', header) }],
  ['/v1/contacts/{id}/workspace/{section}', { get: section }],
]);
for (const [name] of schemas) source = source.split('\n').filter(line => !line.startsWith(`    ${name}: `)).join('\n');
for (const [route] of paths) source = source.split('\n').filter(line => !line.startsWith(`  "${route}": `)).join('\n');
if (!source.includes('paths:\n') || !source.includes('  schemas:\n') || !source.includes('  /v1/appointments/{id}:\n'))
  throw new Error('customer_workspace_openapi_anchors_missing');
source = source.replace('paths:\n', `paths:\n${[...paths].map(([route, value]) => `  "${route}": ${JSON.stringify(value)}`).join('\n')}\n`);
source = source.replace('  schemas:\n', `  schemas:\n${[...schemas].map(([name, value]) => `    ${name}: ${JSON.stringify(value)}`).join('\n')}\n`);
// Preserve the existing PATCH operation; only replace our own one-line GET projection.
source = source.replace(/(  \/v1\/appointments\/\{id\}:\n)(?:    get: \{[^\n]*\}\n)?/, (_match, anchor) => `${anchor}    get: ${JSON.stringify(operation('getCustomerWorkspaceAppointment', 'Read one exact appointment outside schedule list filters', appointment))}\n`);
await writeFile(target, source);
console.log(JSON.stringify({ paths: 3, schemas: schemas.size, providerCalls: 0 }));
