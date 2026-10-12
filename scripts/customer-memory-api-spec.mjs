/** Project the customer-memory/retrieval contract into OpenAPI. Does not change schema or call providers. */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tsImport } from 'tsx/esm/api';

const requireApi = createRequire(new URL('../artifacts/api-server/package.json', import.meta.url));
const { z } = requireApi('zod');
const contract = await tsImport('../artifacts/api-server/src/services/customer-memory-contract.ts', import.meta.url);
const target = new URL('../lib/api-spec/openapi.yaml', import.meta.url);
let source = (await readFile(target, 'utf8')).replace(/\r\n/g, '\n');
const schemas = new Map();
function schema(name, value, io = 'output') {
  const json = z.toJSONSchema(value, { target: 'openapi-3.0', unrepresentable: 'throw', io });
  delete json.$schema; schemas.set(name, json);
  return { $ref: `#/components/schemas/${name}` };
}
const memory = schema('CustomerMemory', contract.customerMemorySchema);
const list = schema('CustomerMemoryList', contract.customerMemoryListSchema);
const create = schema('CreateCustomerMemory', contract.createCustomerMemorySchema, 'input');
const search = schema('CustomerContextSearch', contract.customerContextSearchSchema);
const reindex = schema('RetrievalReindexRequest', contract.reindexRequestSchema, 'input');
const errors = (extra = {}) => Object.fromEntries(Object.entries({
  400: 'Malformed strict request; unknown fields rejected.', 401: 'Sign-in required.', 403: 'Membership permission required.',
  404: 'Customer or memory not found in this company.', 503: 'Unavailable; check saved state before repeating a write.', ...extra,
}).map(([code, description]) => [code, { description }]));
const idParam = { $ref: '#/components/parameters/IdPathParam' };
const description = 'Company scope comes only from the authenticated membership. Memories are staff-authored, audited without their text, and retiring one removes it from retrieval in the same transaction. Search text is PII-redacted (email, phone, SSN, policy identifiers) before storage or any embedding provider. Without an enabled provider, search uses deterministic keyword matching and says mode=keyword.';
const ok = (desc, ref) => ({ description: desc, content: { 'application/json': { schema: ref } } });
const paths = new Map([
  ['/v1/contacts/{id}/memories', {
    get: { operationId: 'listCustomerMemories', tags: ['contacts'], summary: 'List one customer\'s memories (crm.read)', description,
      parameters: [idParam, { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'all'] } }], responses: { 200: ok('Active (or all) memories, newest first.', list), ...errors() } },
    post: { operationId: 'createCustomerMemory', tags: ['contacts'], summary: 'Add a customer memory (crm.write)', description,
      parameters: [idParam], requestBody: { required: true, content: { 'application/json': { schema: create } } },
      responses: { 201: ok('Saved memory.', memory), ...errors() } },
  }],
  ['/v1/contacts/{id}/memories/{memoryId}/retire', {
    post: { operationId: 'retireCustomerMemory', tags: ['contacts'], summary: 'Retire a customer memory (crm.write)', description,
      parameters: [idParam, { name: 'memoryId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: { 200: ok('Retired memory (kept for provenance).', memory), ...errors({ 409: 'Already retired.' }) } },
  }],
  ['/v1/contacts/{id}/context-search', {
    get: { operationId: 'searchCustomerContext', tags: ['contacts'], summary: 'Search one customer\'s history and memories (crm.read)', description,
      parameters: [idParam, { name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 500 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 10 } }],
      responses: { 200: ok('Ranked redacted snippets for this customer only.', search), ...errors() } },
  }],
  ['/v1/retrieval/reindex', {
    post: { operationId: 'reindexRetrieval', tags: ['knowledge'], summary: 'Backfill the company retrieval index (owner/admin; API keys rejected)',
      description: 'Re-embeds knowledge and up to `limit` customers after `afterContactId`; unchanged records are skipped by content hash, so repeating is safe. Requires an explicitly enabled embedding provider (spend approval is an owner gate).',
      requestBody: { required: false, content: { 'application/json': { schema: reindex } } },
      responses: { 200: { description: 'Counts and the next cursor.' }, ...errors({ 409: 'No embedding provider enabled; search keeps using keyword matching.' }) } },
  }],
]);
for (const [name] of schemas) source = source.split('\n').filter(line => !line.startsWith(`    ${name}: `)).join('\n');
for (const [route] of paths) source = source.split('\n').filter(line => !line.startsWith(`  "${route}": `)).join('\n');
if (!source.includes('paths:\n') || !source.includes('  schemas:\n')) throw new Error('customer_memory_openapi_anchors_missing');
source = source.replace('paths:\n', `paths:\n${[...paths].map(([route, value]) => `  "${route}": ${JSON.stringify(value)}`).join('\n')}\n`);
source = source.replace('  schemas:\n', `  schemas:\n${[...schemas].map(([name, value]) => `    ${name}: ${JSON.stringify(value)}`).join('\n')}\n`);
await writeFile(target, source);
console.log(JSON.stringify({ paths: paths.size, schemas: schemas.size, providerCalls: 0 }));
