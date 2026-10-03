/** Mechanical projection of reviewed finite nurture contracts, not provider setup. */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tsImport } from 'tsx/esm/api';

const requireApi = createRequire(new URL('../artifacts/api-server/package.json', import.meta.url));
const { z } = requireApi('zod');
const contracts = await tsImport('../artifacts/api-server/src/services/source-nurture-contract.ts', import.meta.url);
const mailbox = await tsImport('../artifacts/api-server/src/services/mailbox-contract.ts', import.meta.url);
const target = new URL('../lib/api-spec/openapi.yaml', import.meta.url);
let source = (await readFile(target, 'utf8')).replace(/\r\n/g, '\n');
const schemas = new Map();
function normalize(value) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'string' && ['date', 'date-time'].includes(value.format)) delete value.pattern;
  for (const child of Object.values(value)) normalize(child);
}
const schema = (name, value) => {
  const json = z.toJSONSchema(value, { target: 'openapi-3.0', unrepresentable: 'throw' });
  delete json.$schema; normalize(json); schemas.set(name, json);
  return { $ref: `#/components/schemas/${name}` };
};
const readExisting = name => {
  const prefix = `    ${name}: `;
  const row = source.split('\n').find(line => line.startsWith(prefix));
  if (!row) throw new Error(`nurture_existing_schema_missing_${name}`);
  return JSON.parse(row.slice(prefix.length));
};
const detail = schema('SourceNurtureDetail', contracts.sourceNurtureDetailSchema);
const list = schema('SourceNurtureList', contracts.sourceNurtureListSchema);
const command = schema('SourceNurtureCommandResult', contracts.sourceNurtureCommandResponseSchema);
const draft = schema('SourceNurturePreviewRequest', contracts.sourceNurtureDraftSchema);
const approval = schema('SourceNurtureApprovalRequest', contracts.sourceNurtureApprovalSchema);
const start = schema('SourceNurtureStartRequest', contracts.sourceNurtureStartSchema);
const stop = schema('SourceNurtureStopRequest', contracts.sourceNurtureStopSchema);
const grant = schema('MicrosoftNurtureMonitoring', mailbox.nurtureMonitoringInput);
const sync = schema('NurtureMailboxSync', z.object({ ready: z.boolean(), reason: z.string().nullable(), completedCycleId: z.uuid().nullable(), startedAt: z.iso.datetime().nullable(), completedAt: z.iso.datetime().nullable() }).strict());
const status = readExisting('MicrosoftMailboxStatus');
const nullableTime = { type: ['string', 'null'], format: 'date-time' };
Object.assign(status.properties, {
  nurtureMonitoringEnabled: { type: 'boolean' }, nurtureMonitoringVersion: { type: 'integer', minimum: 0 },
  nurtureMonitoringApprovedAt: nullableTime, nurtureMonitoringChangedAt: nullableTime,
  nurtureSync: sync,
});
status.required = [...new Set([...status.required, 'nurtureMonitoringEnabled', 'nurtureMonitoringVersion', 'nurtureMonitoringApprovedAt', 'nurtureMonitoringChangedAt', 'nurtureSync'])];
schemas.set('MicrosoftMailboxStatus', status);
const reply = readExisting('LeadMailboxReply');
const replyContext = schema('LeadMailboxReplyContext', z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bie_lead_email') }).strict(),
  z.object({ kind: z.literal('source_nurture_email'), planId: z.uuid(), itemId: z.uuid(), stepId: z.uuid(), stepIndex: z.union([z.literal(1), z.literal(2)]) }).strict(),
]));
reply.properties.context = replyContext;
reply.required = [...new Set([...reply.required, 'context'])];
schemas.set('LeadMailboxReply', reply);
const errors = Object.fromEntries(Object.entries({
  400: 'Invalid strict request; unknown fields, duplicate query selectors or malformed review rejected.',
  401: 'Staff sign-in required.', 403: 'Accepted active staff, permission, API-key or trusted-origin restriction.',
  404: 'Plan not found in this company.', 409: 'Changed, expired, owned or uncertain evidence; inspect saved status.',
  415: 'JSON review required.', 423: 'Company held.', 503: 'Outcome unavailable. Do not retry with a new plan or action key.',
}).map(([code, description]) => [code, { description }]));
const operation = (operationId, summary, response, input, withId = false) => ({
  operationId, tags: ['communications'], summary,
  description: 'Accepted staff session only; no API-key authority. Finite imported-source nurture requires separate source adoption, address-specific marketing permission, Microsoft sender/read grant, exact approval and explicit start. Maximum ten addresses, two fixed emails, at least 72 hours after actual predecessor acceptance and a fresh complete reply scan, expiring within fourteen days. Permanent ownership and unknown effects never permit replacement keys or automatic replay. Provider acceptance is not delivery, consent, customer confirmation or collected revenue.',
  parameters: withId ? [{ $ref: '#/components/parameters/IdPathParam' }] : [],
  ...(input ? { requestBody: { required: true, content: { 'application/json': { schema: input } } } } : {}),
  responses: { 200: { description: 'Exact saved authority and current bounded evidence; not live provider activation.', content: { 'application/json': { schema: response } } }, ...errors },
});
const index = operation('listSourceNurture', 'Find oldest bounded nurture attention, waiting work or history', list, null);
index.parameters = [
  { name: 'bucket', in: 'query', schema: { type: 'string', enum: ['attention', 'waiting', 'history'], default: 'attention' } },
  { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 100000, default: 0 } },
];
const paths = new Map([
  ['/v1/source-nurture', { get: index }],
  ['/v1/source-nurture/{id}', { get: operation('getSourceNurture', 'Review exact immutable nurture and original outcome evidence', detail, null, true) }],
  ['/v1/source-nurture/preview', { post: operation('previewSourceNurture', 'Freeze a ten-minute actor-bound two-message review without sending', detail, draft) }],
  ['/v1/source-nurture/{id}/approve', { post: operation('approveSourceNurture', 'Approve the exact saved review without scheduling a send', command, approval, true) }],
  ['/v1/source-nurture/{id}/start', { post: operation('startSourceNurture', 'Explicitly admit the original finite sequence once', command, start, true) }],
  ['/v1/source-nurture/{id}/stop', { post: operation('stopSourceNurture', 'Stop unclaimed future work without releasing original reservations', command, stop, true) }],
]);
const monitoring = operation('setMicrosoftNurtureMonitoring', 'Separately acknowledge or revoke tracked nurture reading on the owned connector', { $ref: '#/components/schemas/MicrosoftMailboxStatus' }, grant);
monitoring.description = 'Own accepted active staff session and exact connector/context versions required. This local context permission is default-off and independent of service and BIE reading. Graph scopes are unchanged. A reconnect or revoke does not adopt old nurture parents. Completed bounded synchronization is explicit evidence, not certainty that the real mailbox contains no customer reply.';
paths.set('/v1/mailbox/microsoft/nurture-monitoring', { post: monitoring });
for (const [name] of schemas) source = source.split('\n').filter(line => !line.startsWith(`    ${name}: `)).join('\n');
for (const [route] of paths) source = source.split('\n').filter(line => !line.startsWith(`  "${route}": `)).join('\n');
if (!source.includes('paths:\n') || !source.includes('  schemas:\n')) throw new Error('nurture_openapi_anchors_missing');
source = source.replace('paths:\n', `paths:\n${[...paths].map(([route, value]) => `  "${route}": ${JSON.stringify(value)}`).join('\n')}\n`);
source = source.replace('  schemas:\n', `  schemas:\n${[...schemas].map(([name, value]) => `    ${name}: ${JSON.stringify(value)}`).join('\n')}\n`);
await writeFile(target, source);
console.log(JSON.stringify({ paths: paths.size, schemas: schemas.size, providerCalls: 0 }));
