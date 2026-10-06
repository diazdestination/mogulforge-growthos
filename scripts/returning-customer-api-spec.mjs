/** Mechanical pure-contract projection only; no database, account or provider. */
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tsImport } from "tsx/esm/api";

const apiRequire = createRequire(
  new URL("../artifacts/api-server/package.json", import.meta.url),
);
const specRequire = createRequire(
  new URL("../lib/api-spec/package.json", import.meta.url),
);
const generatorRequire = createRequire(specRequire.resolve("orval"));
const YAML = generatorRequire("yaml"),
  { z } = apiRequire("zod");
const work = await tsImport(
  "../artifacts/api-server/src/services/returning-customer-contract.ts",
  import.meta.url,
);
const invoice = await tsImport(
  "../artifacts/api-server/src/services/invoice-contract.ts",
  import.meta.url,
);
const target = new URL("../lib/api-spec/openapi.yaml", import.meta.url);
let source = (await readFile(target, "utf8")).replace(/\r\n/g, "\n");
const original = YAML.parse(source);
const schemas = new Map();
function normalize(value) {
  if (!value || typeof value !== "object") return;
  if (value.type === "string" && ["date", "date-time"].includes(value.format))
    delete value.pattern;
  for (const child of Object.values(value)) normalize(child);
}
function schema(name, value) {
  const json = z.toJSONSchema(value, {
    target: "openapi-3.0",
    unrepresentable: "throw",
    io: "input",
  });
  delete json.$schema;
  normalize(json);
  schemas.set(name, json);
  return { $ref: `#/components/schemas/${name}` };
}
const definitions = {
  CustomerWorkEstimate: "customerWorkEstimateSchema",
  CustomerWorkProject: "customerWorkProjectSchema",
  CustomerWorkCommand: "customerWorkCommandSchema",
  CustomerWorkEstimateMutation: "customerWorkEstimateMutationSchema",
  CustomerWorkProjectMutation: "customerWorkProjectMutationSchema",
  CreateCustomerWorkEstimate: "createCustomerWorkEstimateSchema",
  UpdateCustomerWorkEstimate: "updateCustomerWorkEstimateSchema",
  CreateCustomerWorkProject: "createCustomerWorkProjectSchema",
  UpdateCustomerWorkProject: "updateCustomerWorkProjectSchema",
};
const refs = Object.fromEntries(
  Object.entries(definitions).map(([name, key]) => [
    name,
    schema(name, work[key]),
  ]),
);
schema("CreateInvoice", invoice.createInvoiceSchema);
const refund = schema("InvoiceRefund", invoice.invoiceRefundSchema);
const uuid = { type: "string", format: "uuid" },
  nullableUuid = { ...uuid, nullable: true };
const context = {
  customerWorkId: nullableUuid,
  contactId: uuid,
  propertyId: nullableUuid,
  sourceKind: { type: "string", enum: ["lead", "customer_work"] },
};
for (const name of ["Estimate", "Project"]) {
  const value = structuredClone(original.components.schemas[name]);
  Object.assign(value.properties, context, {
    leadId: nullableUuid,
    workVersion: {
      type: "integer",
      nullable: true,
      minimum: 1,
      maximum: 2147483646,
    },
    customerLabel: { type: "string" },
    propertyLabel: { type: "string", nullable: true },
  });
  schemas.set(name, value);
}
for (const name of ["InvoiceSummary", "InvoiceDetail"]) {
  const summary = structuredClone(original.components.schemas[name]);
  Object.assign(summary.properties, context, {
    organizationId: uuid,
    leadId: nullableUuid,
  });
  summary.required = [
    ...new Set([
      ...summary.required,
      "organizationId",
      ...Object.keys(context),
    ]),
  ];
  schemas.set(name, summary);
}
const previousPreview = original.components.schemas.InvoiceDeliveryPreview;
const legacyPreview = structuredClone(
  previousPreview.oneOf?.[0] ?? previousPreview,
);
const returningPreview = structuredClone(legacyPreview);
Object.assign(returningPreview.properties, {
  reviewVersion: { type: "integer", enum: [3] },
  leadId: { type: "string", nullable: true, enum: [null] },
  customerWorkId: uuid,
  propertyId: nullableUuid,
  senderIdentitySha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
});
returningPreview.properties.sender.properties.source = {
  type: "string",
  enum: ["company_default"],
};
returningPreview.required = [
  ...new Set([
    ...returningPreview.required,
    "reviewVersion",
    "customerWorkId",
    "propertyId",
    "senderIdentitySha256",
  ]),
];
schemas.set("InvoiceDeliveryPreview", {
  oneOf: [legacyPreview, returningPreview],
});
const worklistItem = structuredClone(
  original.components.schemas.InvoiceDeliveryWorklistItem,
);
Object.assign(worklistItem.properties, context, {
  organizationId: uuid,
  leadId: nullableUuid,
});
schemas.set("InvoiceDeliveryWorklistItem", worklistItem);
for (const name of ["InvoiceAvailableValueEntry", "InvoiceAllocation"]) {
  const value = structuredClone(original.components.schemas[name]);
  value.properties.refundOfValueEntryId = nullableUuid;
  schemas.set(name, value);
}
const day = structuredClone(original.components.schemas.ContractorDayProject);
Object.assign(day.properties, {
  leadId: nullableUuid,
  customerWorkId: nullableUuid,
  contactId: uuid,
});
// Older read fixtures remain compatible; actual new rows always carry context.
schemas.set("ContractorDayProject", day);
function replaceSchema(name, value) {
  const pattern = new RegExp(
    `^    ${name}:[\\s\\S]*?(?=^    [A-Za-z0-9_]+:|^  [A-Za-z0-9_]+:|(?![\\s\\S]))`,
    "m",
  );
  const line = `    ${name}: ${JSON.stringify(value)}\n`;
  if (pattern.test(source)) source = source.replace(pattern, line);
  else source = source.replace("  schemas:\n", `  schemas:\n${line}`);
}
for (const [name, value] of schemas) replaceSchema(name, value);
const errors = Object.fromEntries(
  Object.entries({
    400: "Malformed strict request, source or selector.",
    401: "Human staff sign-in required.",
    403: "Current accepted verified active membership/effective permission required; API keys rejected.",
    404: "Native record unavailable in this company.",
    409: "Saved version, immutable parent or original request conflict. Reconcile the exact submitted request.",
    415: "JSON required.",
    503: "Unavailable or unknown acknowledgement; no fresh request/effect may be inferred.",
  }).map(([code, description]) => [code, { description }]),
);
const paths = new Map();
function op(operationId, response, input, path) {
  return {
    operationId,
    tags: ["customer-work"],
    summary: operationId,
    description:
      "Explicit canonical returning-customer work. No acquisition lead, signature, provider delivery or payment is inferred. Exact original request/result is retained transactionally. The root/property is immutable and native estimate/job history is versioned.",
    parameters: [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: uuid,
    })),
    requestBody: {
      required: true,
      content: { "application/json": { schema: input } },
    },
    responses: {
      200: {
        description:
          "Actual committed native record and original request result.",
        content: { "application/json": { schema: response } },
      },
      ...errors,
    },
  };
}
for (const [path, method, id, response, input] of [
  [
    "/v1/customer-work/estimates",
    "post",
    "createCustomerWorkEstimate",
    "CustomerWorkEstimateMutation",
    "CreateCustomerWorkEstimate",
  ],
  [
    "/v1/customer-work/estimates/{id}",
    "patch",
    "updateCustomerWorkEstimate",
    "CustomerWorkEstimateMutation",
    "UpdateCustomerWorkEstimate",
  ],
  [
    "/v1/customer-work/projects",
    "post",
    "createCustomerWorkProject",
    "CustomerWorkProjectMutation",
    "CreateCustomerWorkProject",
  ],
  [
    "/v1/customer-work/projects/{id}",
    "patch",
    "updateCustomerWorkProject",
    "CustomerWorkProjectMutation",
    "UpdateCustomerWorkProject",
  ],
])
  paths.set(path, { [method]: op(id, refs[response], refs[input], path) });
const refundPath = "/v1/invoices/{id}/refunds";
const refundOp = op(
  "recordInvoiceRefund",
  { $ref: "#/components/schemas/InvoiceMutation" },
  refund,
  refundPath,
);
refundOp.description =
  "Current human invoice manager only. Append a staff-recorded external refund correction tied to the original same-work receipt and remaining invoice allocation. It does not issue a processor refund or move cash. Existing invoice operation/request ledger and cumulative receipt cap apply.";
paths.set(refundPath, { post: refundOp });
for (const [path, value] of paths) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^  "${escaped}": \\{[^\\n]*\\}\\n?`, "m");
  source = source.replace(pattern, "");
  source = source.replace(
    "paths:\n",
    `paths:\n  "${path}": ${JSON.stringify(value)}\n`,
  );
}
// Existing paged reads accept exact business scope; keep their old filters too.
const updated = YAML.parse(source);
for (const [path, names] of [
  ["/v1/estimates", ["contactId", "customerWorkId", "propertyId"]],
  ["/v1/projects", ["contactId", "customerWorkId", "propertyId"]],
  ["/v1/invoices", ["contactId", "customerWorkId"]],
]) {
  const operation = updated.paths[path]?.get;
  if (!operation) throw new Error(`returning_spec_path_missing:${path}`);
  for (const name of names)
    if (!operation.parameters?.some((p) => p.name === name)) {
      operation.parameters ??= [];
      operation.parameters.push({ name, in: "query", schema: uuid });
    }
  const pattern = new RegExp(
    `^  "?${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?:[\\s\\S]*?(?=^  [^ \\n]|(?![\\s\\S]))`,
    "m",
  );
  if (!pattern.test(source))
    throw new Error("returning_spec_read_anchor_missing");
  source = source.replace(
    pattern,
    `  "${path}": ${JSON.stringify(updated.paths[path])}\n`,
  );
}
const verified = YAML.parse(source);
if (
  !verified.paths[refundPath] ||
  verified.components.schemas.CustomerWorkEstimate.properties.leadId
    .nullable !== true ||
  !verified.components.schemas.CreateInvoice.anyOf
)
  throw new Error("returning_spec_contract_invalid");
await writeFile(target, source);
console.log(
  JSON.stringify({
    paths: paths.size,
    schemas: schemas.size,
    providerCalls: 0,
  }),
);
