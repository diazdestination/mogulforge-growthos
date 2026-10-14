/** Project only the accepted Task6A/B/C source boundaries. No DB/provider runtime. */
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
const file = new URL("../lib/api-spec/openapi.yaml", import.meta.url);
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
  const care = structuredClone(spec.components.schemas.ServiceCareReview);
  if (!care?.properties?.booking || !care.required)
    throw Error("source_service_care_anchor_changed");
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
