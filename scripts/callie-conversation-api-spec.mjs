/** Mechanical staff API projection of the closed CALLIE reception contracts. */
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const requireApi = createRequire(new URL('../artifacts/api-server/package.json', import.meta.url));
const { z } = requireApi('zod');
const contracts = await tsImport('../artifacts/api-server/src/services/callie-reception-contract.ts', import.meta.url);
const target = new URL('../lib/api-spec/openapi.yaml', import.meta.url);
let source = (await readFile(target, 'utf8')).replace(/\r\n/g, '\n');
const schemas = new Map();
function normalize(value) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'string' && ['date', 'date-time'].includes(value.format)) delete value.pattern;
  for (const child of Object.values(value)) normalize(child);
}
function schema(name, value) {
  const json = z.toJSONSchema(value, { target: 'openapi-3.0', unrepresentable: 'throw' });
  delete json.$schema; normalize(json); schemas.set(name, json);
  return { $ref: `#/components/schemas/${name}` };
}
function readExisting(name) {
  const prefix = `    ${name}: `;
  const row = source.split('\n').find(line => line.startsWith(prefix));
  if (!row) throw new Error(`callie_reception_existing_schema_missing_${name}`);
  return JSON.parse(row.slice(prefix.length));
}
const view = schema('CallieReceptionView', contracts.callieReceptionViewSchema);
const binding = schema('CallieReceptionBindingRequest', contracts.callieReceptionBindingInputSchema);
const settings = schema('CallieReceptionSettings', contracts.callieReceptionSettingsSchema);
const snapshot = schema('CallieReceptionSnapshot', contracts.callieReceptionSnapshotSchema);
const previewInput = schema('CallieReceptionPreviewRequest', contracts.callieReceptionPreviewInputSchema);
const preview = schema('CallieReceptionPreview', contracts.callieReceptionPreviewSchema);
const approval = schema('CallieReceptionApproveRequest', contracts.callieReceptionApprovalInputSchema);
const evidence = schema('CallieReceptionEvidence', contracts.callieReceptionEvidenceSchema);
schema('CallieReceptionCallerFacts', contracts.callieReceptionFactsSchema);

// Legacy approval schemas retain v1 only. Broaden only the read projection
// so existing approvals cannot imply the new voice policy's authority.
const policy = readExisting('CalliePolicy');
const baseline = execFileSync('git', ['show', 'afcb72a810a55ea32c42adb2f342477bb0e7299f:lib/api-spec/openapi.yaml'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', windowsHide: true,
});
const legacyPolicyLine = baseline.split(/\r?\n/).find(line => line.startsWith('    CalliePolicy: '));
if (!legacyPolicyLine) throw new Error('callie_reception_baseline_policy_missing');
const legacyPolicy = JSON.parse(legacyPolicyLine.slice('    CalliePolicy: '.length));
policy.properties.snapshot = { oneOf: [{ $ref: '#/components/schemas/CalliePolicySnapshot' }, snapshot] };
policy.properties.policy = { oneOf: [legacyPolicy.properties.policy, settings] };
schemas.set('CalliePolicy', policy);
const summary = readExisting('CallieIntakeSummary');
Object.assign(summary.properties, {
  organizationId: { type: 'string', format: 'uuid' },
  mode: { type: 'string', enum: ['keypad', 'conversation'] },
});
summary.required = [...new Set([...summary.required, 'organizationId', 'mode'])];
summary.properties.state.enum = [...new Set([...summary.properties.state.enum, 'office_pending'])];
schemas.set('CallieIntakeSummary', summary);
const detail = readExisting('CallieIntakeDetail');
// Detail is an independent flattened schema, not an allOf/reference to summary.
// Keep every inherited field in sync for GET and all office command responses.
Object.assign(detail.properties, structuredClone(summary.properties));
detail.required = [...new Set([...detail.required, ...summary.required])];
detail.properties.reception = { oneOf: [evidence, { type: 'null' }] };
detail.required = [...new Set([...detail.required, 'reception'])];
schemas.set('CallieIntakeDetail', detail);

const errors = Object.fromEntries(Object.entries({
  400: 'Malformed closed request or unsupported selector.',
  401: 'Accepted staff sign-in required.',
  403: 'Current verified staff, permission, API-key or trusted-origin restriction.',
  409: 'Changed version/review/binding or unknown outcome; read saved state before another action.',
  415: 'JSON mutation required.', 429: 'Rate limit.',
  503: 'Unavailable. No successful update or provider readiness can be inferred.',
}).map(([code, description]) => [code, { description }]));
function operation(operationId, summaryText, response, input, permission) {
  return {
    operationId, tags: ['communications'], summary: summaryText,
    description: `Current accepted active verified staff session only; no API-key authority. Requires ${permission}. Shared policy head selects exactly one future-call mode. Binding metadata and exact policy approval do not configure a provider or prove live audio/transfer. Caller statements are unverified; no identity, SMS permission, confirmed visit or emergency dispatch is inferred. Original uncertain effects remain non-retryable.`,
    parameters: [],
    ...(input ? { requestBody: { required: true, content: { 'application/json': { schema: input } } } } : {}),
    responses: { 200: { description: 'Current company-scoped saved configuration and bounded source readiness.', content: { 'application/json': { schema: response } } }, ...errors },
  };
}
const paths = new Map([
  ['/v1/communications/callie/reception', { get: operation('getCallieReception', 'Read conversation setup and separate current source mode', view, null, 'crm.read') }],
  ['/v1/communications/callie/reception/binding', { post: operation('saveCallieReceptionBinding', 'Save exact non-secret company provider identity', view, binding, 'settings.manage') }],
  ['/v1/communications/callie/reception/policy/preview', { post: operation('previewCallieReceptionPolicy', 'Review an expiring actor-bound conversational policy', preview, previewInput, 'settings.manage') }],
  ['/v1/communications/callie/reception/policy/approve', { post: operation('approveCallieReceptionPolicy', 'Approve the exact future-call conversational policy', view, approval, 'settings.manage') }],
]);
for (const [name] of schemas) source = source.split('\n').filter(line => !line.startsWith(`    ${name}: `)).join('\n');
for (const [route] of paths) source = source.split('\n').filter(line => !line.startsWith(`  "${route}": `)).join('\n');
if (!source.includes('paths:\n') || !source.includes('  schemas:\n')) throw new Error('callie_reception_openapi_anchors_missing');
source = source.replace('paths:\n', `paths:\n${[...paths].map(([route, value]) => `  "${route}": ${JSON.stringify(value)}`).join('\n')}\n`);
source = source.replace('  schemas:\n', `  schemas:\n${[...schemas].map(([name, value]) => `    ${name}: ${JSON.stringify(value)}`).join('\n')}\n`);
await writeFile(target, source);
console.log(JSON.stringify({ paths: paths.size, schemas: schemas.size, providerCalls: 0 }));
