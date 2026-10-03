/** Mechanical projection of strict local contracts into the reviewed OpenAPI document. */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tsImport } from 'tsx/esm/api';

const requireApi = createRequire(new URL('../artifacts/api-server/package.json', import.meta.url));
const { z } = requireApi('zod');
const contracts = await tsImport('../artifacts/api-server/src/services/service-standing-contract.ts', import.meta.url);
const sms = await tsImport('../artifacts/api-server/src/services/service-sms-policy.ts', import.meta.url);
const schemas = new Map();
function normalizeForCodegen(value) {
  if (!value || typeof value !== 'object') return;
  // Orval's date-coercing target cannot append string.regex() to a Date schema.
  // The standard date-time format carries the wire type; authoritative runtime
  // schemas above still validate the full ISO grammar before any mutation.
  if (value.type === 'string' && ['date', 'date-time'].includes(value.format)) delete value.pattern;
  for (const child of Object.values(value)) normalizeForCodegen(child);
}
const schema = (name, value) => {
  const json = z.toJSONSchema(value, { target: 'openapi-3.0', unrepresentable: 'throw' });
  delete json.$schema;
  normalizeForCodegen(json);
  schemas.set(name, json);
  return { $ref: `#/components/schemas/${name}` };
};
const view = schema('ServiceStandingView', contracts.serviceStandingViewSchema);
const preview = schema('ServiceStandingPreview', contracts.serviceStandingPreviewResponseSchema);
const previewInput = schema('ServiceStandingPreviewRequest', contracts.serviceStandingPreviewInputSchema);
const approvalInput = schema('ServiceStandingApprovalRequest', contracts.serviceStandingApprovalInputSchema);
// The public API echoes the exact server preview; arbitrary client policy JSON is never authority.
schemas.get('ServiceStandingApprovalRequest').properties.expectedSnapshot = schemas.get('ServiceStandingPreview').properties.expectedSnapshot;
const disableInput = schema('ServiceStandingDisableRequest', contracts.serviceStandingDisableInputSchema);
const errors = Object.fromEntries(Object.entries({
  400: 'Invalid or unknown fields. Calendar dates and ordered agreement bounds are validated server-side.',
  401: 'Sign in required.', 403: 'Accepted staff session, role, API-key or trusted-origin restriction.',
  404: 'Record unavailable in this company.', 409: 'Changed, expired, already-owned or uncertain authority. Inspect retained evidence.',
  415: 'JSON mutation required.', 423: 'Company held.', 503: 'Unavailable; do not infer authority or successful contact.',
}).map(([key, description]) => [key, { description }]));
const operation = (operationId, summary, response, input, permission) => ({
  operationId, tags: ['contractor'], summary,
  description: `Accepted active staff session only; ${permission}. Default-off exact service-series review. One fixed reminder per future eligible occurrence; no backlog, marketing permission, warranty decision or automatic booking. A held/unknown original effect cannot be retried with another policy or channel.`,
  parameters: [{ $ref: '#/components/parameters/IdPathParam' }],
  ...(input ? { requestBody: { required: true, content: { 'application/json': { schema: input } } } } : {}),
  responses: { 200: { description: 'Separate standing authority and occurrence evidence. Approval is not provider delivery or customer acceptance.', content: { 'application/json': { schema: response } } }, ...errors },
});
const base = '/v1/service-obligations/{id}/standing-reminders';
const paths = new Map([
  [base, { get: operation('getServiceStandingPolicy', 'Review standing reminder authority and current occurrence', view, null, 'crm.read') }],
  [`${base}/preview`, { post: operation('previewServiceStandingPolicy', 'Prepare an exact ten-minute service-series review', preview, previewInput, 'settings.manage') }],
  [`${base}/approve`, { post: operation('approveServiceStandingPolicy', 'Approve unchanged forward-only service reminders', view, approvalInput, 'settings.manage') }],
  [`${base}/disable`, { post: operation('disableServiceStandingPolicy', 'Disable future reminders without freeing original receipts', view, disableInput, 'settings.manage') }],
]);
const smsItem = z.object({ id: z.uuid(), serviceObligationId: z.uuid().nullable(), version: z.number().int().positive(), state: z.enum(['needs_review', 'reviewed', 'dismissed']),
  correlation: z.enum(['exact_reference', 'ambiguous']), reason: z.string(), historical: z.boolean(), holdActive: z.boolean(), receivedAt: z.iso.datetime(), recordedAt: z.iso.datetime(),
  rawExpiresAt: z.iso.datetime(), content: z.object({ text: z.string() }).strict().nullable(), reviewedAt: z.iso.datetime().nullable(), reviewNote: z.string().nullable(),
  evidence: z.enum(['signed_sms_reference', 'signed_sms_phone_scope']), candidateServiceObligationIds: z.array(z.uuid()), candidateCount: z.number().int().nonnegative(), candidatesTruncated: z.boolean(),
}).strict();
const smsPage = schema('ServiceSmsReplyPage', z.object({ items: z.array(smsItem).max(25), hasMore: z.boolean(), offset: z.number().int().min(0).max(100000), limit: z.literal(25), held: z.boolean() }).strict());
const smsReview = schema('ReviewServiceSmsReply', sms.serviceSmsReplyReviewInput);
const smsResult = schema('ServiceSmsReplyReviewResult', z.object({ replyId: z.uuid(), version: z.number().int().positive(), replayed: z.boolean() }).strict());
const smsGet = operation('listServiceSmsReplies', 'Read retained exact-reference or ambiguous service text evidence', smsPage, null, 'crm.read');
smsGet.description = 'Accepted staff session; crm.read. Signed SMS origin does not verify customer identity. Exact reference and immutable sender/recipient evidence are distinguished from ambiguous phone-scope evidence. Content expires; retained receipt and hold remain. This is not a complete inbox.';
smsGet.parameters.push({ name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 100000, default: 0 } });
const smsPost = operation('reviewServiceSmsReply', 'Record an office disposition without consent, booking or resend authority', smsResult, smsReview, 'crm.write');
smsPost.description = 'Accepted active staff session; crm.write. Exact version and replay-safe request required. Office follow-up retains the service hold; explicit handling complete or unrelated-evidence dismissal releases only this evidence hold. Separately authorized future work can resume, never an original owned send. No disposition creates customer confirmation, consent or a booking.';
smsPost.parameters.push({ name: 'replyId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } });
paths.set('/v1/service-obligations/{id}/sms-replies', { get: smsGet });
paths.set('/v1/service-obligations/{id}/sms-replies/{replyId}/review', { post: smsPost });
const target = new URL('../lib/api-spec/openapi.yaml', import.meta.url);
let source = (await readFile(target, 'utf8')).replace(/\r\n/g, '\n');
for (const [name] of schemas) source = source.split('\n').filter(line => !line.startsWith(`    ${name}: `)).join('\n');
for (const [route] of paths) source = source.split('\n').filter(line => !line.startsWith(`  "${route}": `)).join('\n');
if (!source.includes('paths:\n') || !source.includes('  schemas:\n')) throw new Error('standing_openapi_anchors_missing');
source = source.replace('paths:\n', `paths:\n${[...paths].map(([route, spec]) => `  "${route}": ${JSON.stringify(spec)}`).join('\n')}\n`);
source = source.replace('  schemas:\n', `  schemas:\n${[...schemas].map(([name, spec]) => `    ${name}: ${JSON.stringify(spec)}`).join('\n')}\n`);
await writeFile(target, source);
console.log(JSON.stringify({ paths: paths.size, schemas: schemas.size, providerCalls: 0 }));
