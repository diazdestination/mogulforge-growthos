import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { format } from "prettier";

// Orval8 loses additionalProperties:false. Pin only the reviewed scheduling
// seams. Validate every boundary/count before changing or writing any text.
const counts = {
  GetSchedulingPolicyResponse: 7,
  SaveSchedulingPolicyBody: 2,
  SaveSchedulingPolicyResponse: 7,
  GetSchedulingReviewContextQueryParams: 1,
  GetSchedulingReviewContextResponse: 4,
  ReconcileSchedulingOperationBody: 22,
  ReconcileSchedulingOperationResponse: 3,
  CreateAppointmentBody: 10,
  CreateProjectBody: 10,
  UpdateAppointmentBody: 10,
  UpdateProjectBody: 10,
  UpdateSettingsBody: 14,
  UpdatePlatformOrgBody: 1,
  GetContractorTodayResponse: 21,
  CreateAppointmentResponse: 10,
  CreateProjectResponse: 10,
  UpdateAppointmentResponse: 10,
  UpdateProjectResponse: 10,
  ListAppointmentsResponseItem: 10,
  ListProjectsResponseItem: 10,
};
// Independent Task6 source boundaries; do not change the twenty native counts.
const sourceCounts = {
  ExplainSchedulingConflictBody: 7,
  ExplainSchedulingConflictResponse: 6,
  CreateCustomerWorkProjectBody: 12,
  CreateCustomerWorkProjectResponse: 11,
  UpdateCustomerWorkProjectBody: 10,
  UpdateCustomerWorkProjectResponse: 11,
  GetServiceCareQueryParams: 1,
  "GetServiceCareResponse.scheduling": 10,
  BookServiceCareVisitBody: 10,
  BookServiceCareVisitResponse: 2,
  GetCallieSchedulingContextQueryParams: 1,
  GetCallieSchedulingContextResponse: 10,
  BookCallieVisitBody: 10,
  BookCallieVisitResponse: 18,
};
export function closeSchedulingSchemas(text) {
  // Orval emits validators for successful operations only. This additional
  // named error validator reuses the already closed acknowledgement boundary.
  const manualError = `export const ManualSchedulingErrorSchema = zod.object({ error: zod.string(), code: zod.enum(['manual_scheduling_refused', 'manual_scheduling_target_unavailable']), schedulingOperation: ReconcileSchedulingOperationResponse }).strict();`;
  if (!/export const ManualSchedulingErrorSchema\s*=/.test(text))
    text += `\n${manualError}\n`;
  const sourceError = `export const CustomerWorkProjectUnavailableSchema = zod.object({ error: zod.string(), code: zod.literal('customer_work_result_unavailable'), commandOutcome: CreateCustomerWorkProjectResponse.shape.commandOutcome }).strict().refine(value => value.commandOutcome.target.available === false);`;
  if (!/export const CustomerWorkProjectUnavailableSchema\s*=/.test(text))
    text += `\n${sourceError}\n`;
  const tree = ts.createSourceFile(
    "api.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  if (tree.parseDiagnostics.length)
    throw Error("Scheduling codegen parse failed; no file modified.");
  const seen = new Set();
  const declarations = new Map(),
    insertions = [];
  function collect(node) {
    if (
      ts.isVariableDeclaration(node) &&
      (Object.hasOwn(counts, node.name.getText(tree)) ||
        Object.hasOwn(sourceCounts, node.name.getText(tree)) ||
        node.name.getText(tree) === "GetServiceCareResponse")
    ) {
      const name = node.name.getText(tree);
      if (seen.has(name) || !node.initializer)
        throw Error(
          "Scheduling codegen boundary duplicated or missing; no file modified.",
        );
      seen.add(name);
      if (name === "GetServiceCareResponse") {
        const matches = [];
        function scheduling(child) {
          if (
            ts.isPropertyAssignment(child) &&
            child.name.getText(tree).replaceAll('"', "").replaceAll("'", "") ===
              "scheduling"
          )
            matches.push(child.initializer);
          ts.forEachChild(child, scheduling);
        }
        scheduling(node.initializer);
        if (matches.length !== 1)
          throw Error("Source scheduling member changed; no file modified.");
        declarations.set("GetServiceCareResponse.scheduling", matches[0]);
      } else declarations.set(name, node.initializer);
    }
    ts.forEachChild(node, collect);
  }
  collect(tree);
  const errors = tree.statements.filter(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (d) => d.name.getText(tree) === "ManualSchedulingErrorSchema",
      ),
  );
  if (errors.length !== 1 || errors[0].getText(tree) !== manualError)
    throw Error("Scheduling manual error boundary changed; no file modified.");
  const sourceErrors = tree.statements.filter(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (d) => d.name.getText(tree) === "CustomerWorkProjectUnavailableSchema",
      ),
  );
  if (
    sourceErrors.length !== 1 ||
    sourceErrors[0].getText(tree) !== sourceError
  )
    throw Error(
      "Scheduling source committed error boundary changed; no file modified.",
    );
  for (const [name, expected] of Object.entries({
    ...counts,
    ...sourceCounts,
  })) {
    const node = declarations.get(name);
    if (!node)
      throw Error(`Scheduling codegen missing ${name}; no file modified.`);
    let count = 0;
    function visit(child) {
      if (
        ts.isCallExpression(child) &&
        child.expression.getText(tree) === "zod.object"
      ) {
        count++;
        const parent = child.parent;
        const strict =
          ts.isPropertyAccessExpression(parent) &&
          parent.name.text === "strict" &&
          ts.isCallExpression(parent.parent) &&
          parent.parent.arguments.length === 0;
        if (!strict) insertions.push(child.end);
      }
      ts.forEachChild(child, visit);
    }
    visit(node);
    if (count !== expected)
      throw Error(
        `Scheduling codegen ${name} shape changed (${count}/${expected}); no file modified.`,
      );
  }
  for (const position of insertions.sort((a, b) => b - a))
    text = text.slice(0, position) + ".strict()" + text.slice(position);
  return text;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const file = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../lib/api-zod/src/generated/api.ts",
  );
  const before = fs.readFileSync(file, "utf8"),
    after = closeSchedulingSchemas(before);
  // Preserve the existing checked-in client formatting deterministically;
  // Orval's formatter hook does not consistently format it on every host.
  const clientFile = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../lib/api-client-react/src/generated/api.ts",
  );
  const clientBefore = fs.readFileSync(clientFile, "utf8");
  const clientAfter = await format(clientBefore, { parser: "typescript" });
  if (after !== before) fs.writeFileSync(file, after);
  if (clientAfter !== clientBefore) fs.writeFileSync(clientFile, clientAfter);
  console.log(
    `Verified ${Object.keys(counts).length} existing and ${Object.keys(sourceCounts).length} source scheduling schema boundaries.`,
  );
}
