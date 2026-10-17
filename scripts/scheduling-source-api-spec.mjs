/** Project only the accepted Task6A/B/C source boundaries. No DB/provider runtime. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { tsImport } from "tsx/esm/api";
const requireApi = createRequire(
  new URL("../artifacts/api-server/package.json", import.meta.url),
);
const requireSpec = createRequire(
  new URL("../lib/api-spec/package.json", import.meta.url),
);
const YAML = createRequire(requireSpec.resolve("orval"))("yaml"),
  { z } = requireApi("zod");
const a = await tsImport(
  "../artifacts/api-server/src/services/returning-customer-contract.ts",
  import.meta.url,
);
// Node-only CLI: this crypto-bearing module is never imported into a browser.
const b = await tsImport(
  "../artifacts/api-server/src/services/service-care-policy.ts",
  import.meta.url,
);
const c = await tsImport(
  "../artifacts/api-server/src/services/callie-office-contract.ts",
  import.meta.url,
);
const d = await tsImport("../lib/scheduling-core/src/explanation.ts", import.meta.url);
const file = new URL("../lib/api-spec/openapi.yaml", import.meta.url);
// Exact reviewed pre-Task6D component shapes at 8563ecdb. Required old
// components may match this shape or their authoritative source projection;
// absence or any other shape must never be silently repaired.
const requiredComponentDigests = {
  CreateCustomerWorkProject:
    "6a071a65d2c91c344de84c69fff833c1c82f54ce4f2d53fa275ee50423d63eba",
  UpdateCustomerWorkProject:
    "4b086d5109ee8b7dd061e72a5739505b066cf2b12f4abe1d16ca251ff40e91e1",
  CustomerWorkProject:
    "43dab9ad607a82c558f9ab3aac7e361b2264a45d35c9292c516fb45b2b171ca7",
  CustomerWorkProjectMutation:
    "7212aa8c42bce5602253729e6953f9b3ef0b7cbce1d5ed42a4649999a1a065a7",
  BookServiceCareVisit:
    "64bc14c69a5e607596d7c195e10075b8e6f2fd37fd0609d0d7d32f60a0d1f158",
  CallieBookingRequest:
    "1af8b73281e6b2fc5cb71c8226738299d42c85013c55ee6b7da64bc0352940b1",
  ServiceCareReview:
    "116424e0278d93294fbbfe06f6d257c7b85eaf0509a063f0dfeb71850493b596",
};
const newComponents = new Set([
  "SchedulingConflictExplanationRequest", "SchedulingConflictExplanation",
  "CustomerWorkProjectOutcome",
  "CustomerWorkProjectUnavailable",
  "ServiceCareSchedulingSource",
  "ServiceCareSchedulingRead",
  "ServiceCareBookingOutcome",
  "ServiceCareBookingResult",
  "CallieSchedulingContextQuery",
  "CallieSchedulingContextRead",
  "CallieBookingOutcome",
  "CallieBookingResult",
]);
function componentCanonical(value) {
  if (Array.isArray(value))
    return `[${value.map(componentCanonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${componentCanonical(item)}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
const componentDigest = (value) =>
  createHash("sha256").update(componentCanonical(value)).digest("hex");

export function projectSchedulingSourceSpec(before) {
  let text = before.replace(/\r\n/g, "\n");
  const spec = YAML.parse(text),
    changed = new Map();
  function rawInstants(value) {
    if (!value || typeof value !== "object") return;
    if (value.type === "string" && value.format === "date-time") {
      if (typeof value.pattern !== "string")
        throw Error("source_datetime_pattern_missing");
      delete value.format;
      value.description =
        "Original ISO datetime string; preserve spelling and fractional precision for source command custody.";
    }
    for (const child of Object.values(value)) rawInstants(child);
  }
  function schema(name, value) {
    const json = z.toJSONSchema(value, {
      target: "openapi-3.0",
      unrepresentable: "throw",
      io: "input",
    });
    delete json.$schema;
    rawInstants(json);
    changed.set(name, json);
    return { $ref: `#/components/schemas/${name}` };
  }
  const refs = {};
  for (const [name, contract] of Object.entries({
    SchedulingConflictExplanationRequest: d.schedulingConflictExplanationRequestSchema,
    SchedulingConflictExplanation: d.schedulingConflictExplanationSchema,
    CreateCustomerWorkProject: a.createCustomerWorkProjectSchema,
    UpdateCustomerWorkProject: a.updateCustomerWorkProjectSchema,
    CustomerWorkProject: a.customerWorkProjectSchema,
    CustomerWorkProjectMutation: a.customerWorkProjectMutationSchema,
    CustomerWorkProjectOutcome: a.customerWorkProjectOutcomeSchema,
    CustomerWorkProjectUnavailable: a.customerWorkProjectUnavailableSchema,
    BookServiceCareVisit: b.serviceCareBookingSchema,
    ServiceCareSchedulingSource: b.serviceCareSchedulingSourceSchema,
    ServiceCareSchedulingRead: b.serviceCareSchedulingReadSchema,
    ServiceCareBookingOutcome: b.serviceCareBookingOutcomeSchema,
    ServiceCareBookingResult: b.serviceCareBookingResultSchema,
    CallieBookingRequest: c.callieBookingSchema,
    CallieSchedulingContextQuery: c.callieSchedulingContextQuerySchema,
    CallieSchedulingContextRead: c.callieSchedulingContextReadSchema,
    CallieBookingOutcome: c.callieBookingOutcomeSchema,
  }))
    refs[name] = schema(name, contract);
  const care = structuredClone(spec.components?.schemas?.ServiceCareReview);
  if (!care?.properties?.booking || !Array.isArray(care.required))
    throw Error("source_component_anchor_changed:ServiceCareReview");
  // This legacy envelope is not defined by the source booking schema. Validate
  // every historical member against its reviewed shape before adding our one
  // scheduling member; cloning arbitrary existing members would bless drift.
  const historicalCare = structuredClone(care);
  if (Object.hasOwn(historicalCare.properties, "scheduling")) {
    if (
      componentCanonical(historicalCare.properties.scheduling) !==
        componentCanonical(refs.ServiceCareSchedulingRead) ||
      historicalCare.required.filter((name) => name === "scheduling").length !==
        1
    )
      throw Error("source_component_shape_changed:ServiceCareReview");
    delete historicalCare.properties.scheduling;
    historicalCare.required = historicalCare.required.filter(
      (name) => name !== "scheduling",
    );
  }
  if (
    componentDigest(historicalCare) !==
    requiredComponentDigests.ServiceCareReview
  )
    throw Error("source_component_shape_changed:ServiceCareReview");
  care.properties.scheduling = refs.ServiceCareSchedulingRead;
  care.required = [...new Set([...care.required, "scheduling"])];
  changed.set("ServiceCareReview", care);
  changed.set("CallieBookingResult", {
    type: "object",
    additionalProperties: false,
    required: ["detail", "replayed", "bookingOutcome"],
    properties: {
      detail: {
        anyOf: [
          { $ref: "#/components/schemas/CallieIntakeDetail" },
          { type: "null" },
        ],
      },
      replayed: { type: "boolean" },
      bookingOutcome: refs.CallieBookingOutcome,
    },
  });
  // Validate all component anchors before replacement. Only the named new
  // components may be inserted; if present they must already be authoritative.
  for (const [name, value] of changed) {
    const prior = spec.components.schemas[name];
    const required = Object.hasOwn(requiredComponentDigests, name);
    if (required && prior === undefined)
      throw Error(`source_component_missing:${name}`);
    if (!required && !newComponents.has(name))
      throw Error(`source_component_not_authorized:${name}`);
    if (
      prior !== undefined &&
      componentCanonical(prior) !== componentCanonical(value) &&
      (!required || componentDigest(prior) !== requiredComponentDigests[name])
    )
      throw Error(`source_component_shape_changed:${name}`);
  }
  const paths = new Map();
  function operation(path, method, id) {
    const value = structuredClone(spec.paths[path]);
    if (value?.[method]?.operationId !== id)
      throw Error(`source_operation_anchor_changed:${id}`);
    paths.set(path, value);
    return value[method];
  }
  for (const [path, method, id] of [
    ["/v1/customer-work/projects", "post", "createCustomerWorkProject"],
    ["/v1/customer-work/projects/{id}", "patch", "updateCustomerWorkProject"],
  ]) {
    const op = operation(path, method, id);
    op.responses["409"] = {
      description:
        "A source conflict or original committed result whose current display is unavailable. Validate committed proof independently of HTTP success; never infer no commit.",
      content: {
        "application/json": {
          schema: {
            anyOf: [
              refs.CustomerWorkProjectUnavailable,
              {
                type: "object",
                additionalProperties: false,
                required: ["error"],
                properties: {
                  error: { type: "string" },
                  code: { type: "string" },
                },
              },
            ],
          },
        },
      },
    };
  }
  const read = operation(
    "/v1/service-obligations/{id}/care",
    "get",
    "getServiceCare",
  );
  read.parameters = (read.parameters ?? []).filter(
    (p) => p.name !== "appointmentType",
  );
  read.parameters.push({
    name: "appointmentType",
    in: "query",
    required: false,
    schema: { type: "string", enum: ["inspection", "other"] },
  });
  const book = operation(
    "/v1/service-obligations/{id}/care/book",
    "post",
    "bookServiceCareVisit",
  );
  book.responses["200"].content = {
    "application/json": { schema: refs.ServiceCareBookingResult },
  };
  const call = operation(
    "/v1/communications/callie/{id}/book",
    "post",
    "bookCallieVisit",
  );
  call.responses["200"].content = {
    "application/json": {
      schema: { $ref: "#/components/schemas/CallieBookingResult" },
    },
  };
  const contextPath = "/v1/communications/callie/{id}/scheduling-context";
  if (
    spec.paths[contextPath] &&
    spec.paths[contextPath].get?.operationId !== "getCallieSchedulingContext"
  )
    throw Error("source_callie_context_anchor_changed");
  paths.set(contextPath, {
    get: {
      operationId: "getCallieSchedulingContext",
      tags: ["communications"],
      summary:
        "Review the actual CALLIE customer, selected visit type and property against current scheduling",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
        ...Object.entries(
          changed.get("CallieSchedulingContextQuery").properties,
        ).map(([name, schema]) => ({
          name,
          in: "query",
          required: name === "appointmentType",
          schema,
        })),
      ],
      responses: {
        200: {
          description:
            "Locked source review for this accepted staff reader; a held review grants no booking authority.",
          content: {
            "application/json": { schema: refs.CallieSchedulingContextRead },
          },
        },
        400: { description: "Invalid strict source query." },
        403: { description: "Accepted staff required." },
        404: { description: "Source unavailable." },
        409: { description: "Source or scheduling review held." },
      },
    },
  });
  const explanationPath = '/v1/scheduling/conflict-explanation';
  const explanationOperation = { post: { operationId: 'explainSchedulingConflict', tags: ['scheduling'], summary: 'Read one authorized current adjacent staff conflict; never original operation evidence', requestBody: { required: true, content: { 'application/json': { schema: refs.SchedulingConflictExplanationRequest } } }, responses: { 200: { description: 'Current schedule only; no save or original-operation authority.', content: { 'application/json': { schema: refs.SchedulingConflictExplanation } } }, 400: { description: 'Invalid closed request.' }, 403: { description: 'Current staff read authority required.' }, 404: { description: 'Authorized source or target unavailable.' }, 409: { description: 'Stale or invalid current scheduling evidence.' } } } };
  if (spec.paths[explanationPath] && componentCanonical(spec.paths[explanationPath]) !== componentCanonical(explanationOperation)) throw Error('source_explanation_anchor_changed');
  paths.set(explanationPath, explanationOperation);
  function replaceSection(indent, key, value, anchor) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `^${indent}"?${escaped}"?:[\\s\\S]*?(?=^${indent}[^ \\n]|(?![\\s\\S]))`,
      "m",
    );
    const line = `${indent}${indent.length === 2 ? JSON.stringify(key) : key}: ${JSON.stringify(value)}\n`;
    if (pattern.test(text)) text = text.replace(pattern, line);
    else text = text.replace(anchor, anchor + line);
  }
  for (const [name, value] of changed)
    replaceSection("    ", name, value, "  schemas:\n");
  for (const [path, value] of paths)
    replaceSection("  ", path, value, "paths:\n");
  const verified = YAML.parse(text);
  for (const [name, value] of changed)
    if (
      JSON.stringify(verified.components.schemas[name]) !==
      JSON.stringify(value)
    )
      throw Error(`source_schema_projection_failed:${name}`);
  for (const [path, value] of paths)
    if (JSON.stringify(verified.paths[path]) !== JSON.stringify(value))
      throw Error(`source_path_projection_failed:${path}`);
  // No unrelated component or endpoint may be rewritten by this script.
  for (const [name, value] of Object.entries(spec.components.schemas))
    if (
      !changed.has(name) &&
      JSON.stringify(value) !==
        JSON.stringify(verified.components.schemas[name])
    )
      throw Error(`source_unrelated_schema_changed:${name}`);
  for (const [path, value] of Object.entries(spec.paths))
    if (
      !paths.has(path) &&
      JSON.stringify(value) !== JSON.stringify(verified.paths[path])
    )
      throw Error(`source_unrelated_path_changed:${path}`);
  return text;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const before = await readFile(file, "utf8"),
    text = projectSchedulingSourceSpec(before);
  if (text !== before) await writeFile(file, text);
  console.log(
    JSON.stringify({
      sourceSchemas: 17,
      sourcePaths: 6,
      changed: text !== before,
    }),
  );
}
