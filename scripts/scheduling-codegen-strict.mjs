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
export function closeSchedulingSchemas(text) {
  // Orval emits validators for successful operations only. This additional
  // named error validator reuses the already closed acknowledgement boundary.
  const manualError = `export const ManualSchedulingErrorSchema = zod.object({ error: zod.string(), code: zod.enum(['manual_scheduling_refused', 'manual_scheduling_target_unavailable']), schedulingOperation: ReconcileSchedulingOperationResponse }).strict();`;
  if (!/export const ManualSchedulingErrorSchema\s*=/.test(text)) text += `\n${manualError}\n`;
  const tree = ts.createSourceFile(
    "api.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  if (tree.parseDiagnostics.length)
    throw Error("Scheduling codegen parse failed; no file modified.");
  const declarations = new Map(),
    insertions = [];
  function collect(node) {
    if (
      ts.isVariableDeclaration(node) &&
      Object.hasOwn(counts, node.name.getText(tree))
    ) {
      const name = node.name.getText(tree);
      if (declarations.has(name) || !node.initializer)
        throw Error(
          "Scheduling codegen boundary duplicated or missing; no file modified.",
        );
      declarations.set(name, node.initializer);
    }
    ts.forEachChild(node, collect);
  }
  collect(tree);
  const errors = tree.statements.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(tree) === 'ManualSchedulingErrorSchema'));
  if (errors.length !== 1 || errors[0].getText(tree) !== manualError) throw Error('Scheduling manual error boundary changed; no file modified.');
  for (const [name, expected] of Object.entries(counts)) {
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
    `Verified ${Object.keys(counts).length} closed scheduling schema boundaries.`,
  );
}
