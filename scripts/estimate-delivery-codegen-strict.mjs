import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Orval does not retain additionalProperties:false in generated Zod objects.
// Limit this correction to the three reviewed estimate-delivery operations.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "lib/api-zod/src/generated/api.ts");
let text = fs.readFileSync(file, "utf8");
const markers = ["GetEstimateDeliveryParams", "GetInvoiceDeliveryParams"];
const offsets = markers.map((name) => {
  const marker = `export const ${name} =`;
  const offset = text.indexOf(marker);
  if (offset < 0 || text.indexOf(marker, offset + marker.length) !== -1) {
    throw new Error(
      "Estimate delivery codegen boundaries changed; no file modified.",
    );
  }
  return offset;
});
const [start, end] = offsets;
if (start >= end)
  throw new Error("Estimate delivery codegen order changed; no file modified.");
const region = text.slice(start, end);
for (const name of [
  "GetEstimateDeliveryResponse",
  "PreviewEstimateDeliveryParams",
  "PreviewEstimateDeliveryBody",
  "PreviewEstimateDeliveryResponse",
  "SendEstimateDeliveryParams",
  "SendEstimateDeliveryBody",
  "SendEstimateDeliveryResponse",
]) {
  const marker = `export const ${name} =`;
  const offset = region.indexOf(marker);
  if (offset < 0 || region.indexOf(marker, offset + marker.length) !== -1) {
    throw new Error(
      "Estimate delivery operation schema changed; no file modified.",
    );
  }
}
const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
let count = 0;
const positions = [];
function visit(node) {
  if (
    node.getStart(tree) >= start &&
    node.end <= end &&
    ts.isCallExpression(node) &&
    node.expression.getText(tree) === "zod.object"
  ) {
    count++;
    const parent = node.parent;
    const alreadyStrict =
      ts.isPropertyAccessExpression(parent) &&
      parent.name.text === "strict" &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent &&
      parent.parent.arguments.length === 0;
    if (!alreadyStrict) positions.push(node.end);
  }
  ts.forEachChild(node, visit);
}
visit(tree);
if (count !== 18) {
  throw new Error("Estimate delivery object count changed; no file modified.");
}
for (const position of positions.sort((a, b) => b - a)) {
  text = text.slice(0, position) + ".strict()" + text.slice(position);
}
if (positions.length) fs.writeFileSync(file, text);
console.log(
  `Verified ${count} closed estimate delivery objects; added ${positions.length} strict calls.`,
);
