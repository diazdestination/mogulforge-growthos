import {
  canonicalJson,
  CLAIM_KERNEL_VERSION,
  sha256Canonical,
} from "./claim-kernel";

export const CLAIM_GRAPH_VERSION = "mogulforge-canonical-claim-graph-v1";
export const CLAIM_GRAPH_RULESET_VERSION = "mogulforge-native-estimate-rules-v1";

export type NativeEstimateLineItem = {
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
};

export type ClaimGraphSource = {
  sourceId: string;
  sourceType: "native_estimate";
  sourceDigest: string;
  priority: number;
};

export type ClaimGraphNode = {
  id: string;
  kind: "claim" | "line_item" | "subtotal" | "tax" | "total";
  value: Record<string, string | number | null>;
};

export type ClaimGraphEdge = {
  from: string;
  to: string;
  relation: "contributes_to" | "depends_on";
};

export type MappingLedgerEntry = {
  canonicalPath: string;
  sourceId: string;
  sourcePath: string;
  sourceDigest: string;
  ruleId: string;
  transformation: "copied" | "computed";
};

export type ClaimInvariant = {
  code: string;
  passed: boolean;
  expected: number | string | boolean;
  observed: number | string | boolean;
  message: string;
};

export type CanonicalClaimGraph = {
  version: typeof CLAIM_GRAPH_VERSION;
  kernelVersion: typeof CLAIM_KERNEL_VERSION;
  rulesetVersion: typeof CLAIM_GRAPH_RULESET_VERSION;
  claimId: string;
  sources: ClaimGraphSource[];
  nodes: ClaimGraphNode[];
  edges: ClaimGraphEdge[];
  mappingLedger: MappingLedgerEntry[];
  invariants: ClaimInvariant[];
  valid: boolean;
  digest: string;
};

export type ClaimGraphTarget = "mogulforge-estimate-v1" | "contractor-claim-statement-v1";

type UnsignedGraph = Omit<CanonicalClaimGraph, "digest">;

function finiteInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value);
}

function normalizeDescription(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function invariant(
  code: string,
  passed: boolean,
  expected: number | string | boolean,
  observed: number | string | boolean,
  message: string,
): ClaimInvariant {
  return { code, passed, expected, observed, message };
}

/**
 * Compiles the existing native MogulForge estimate model into a neutral graph.
 * It never silently accepts a corrupted declared line total: the canonical
 * value is independently recomputed and the invariant report records any
 * disagreement with the source representation.
 */
export function compileNativeEstimateClaimGraph(input: {
  claimId: string;
  estimateId: string;
  lineItems: NativeEstimateLineItem[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}): CanonicalClaimGraph {
  if (!input.claimId.trim()) throw new Error("A claim ID is required for graph compilation.");
  if (!input.estimateId.trim()) throw new Error("An estimate ID is required for graph compilation.");

  const sourcePayload = {
    estimateId: input.estimateId,
    lineItems: input.lineItems.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      totalCents: item.totalCents,
    })),
    subtotalCents: input.subtotalCents,
    taxCents: input.taxCents,
    totalCents: input.totalCents,
  };
  const sourceDigest = sha256Canonical(sourcePayload);
  const source: ClaimGraphSource = {
    sourceId: input.estimateId,
    sourceType: "native_estimate",
    sourceDigest,
    priority: 1,
  };
  const nodes: ClaimGraphNode[] = [
    {
      id: "claim",
      kind: "claim",
      value: { claimId: input.claimId, sourceType: source.sourceType, sourceId: input.estimateId },
    },
  ];
  const edges: ClaimGraphEdge[] = [];
  const mappingLedger: MappingLedgerEntry[] = [];
  const invariants: ClaimInvariant[] = [];
  let computedSubtotalCents = 0;

  input.lineItems.forEach((lineItem, index) => {
    const description = normalizeDescription(lineItem.description);
    const quantityIsValid = Number.isFinite(lineItem.quantity) && lineItem.quantity >= 0;
    const unitPriceIsValid = finiteInteger(lineItem.unitPriceCents) && lineItem.unitPriceCents >= 0;
    const sourceTotalIsValid = finiteInteger(lineItem.totalCents) && lineItem.totalCents >= 0;
    const computedTotalCents = quantityIsValid && unitPriceIsValid ? Math.round(lineItem.quantity * lineItem.unitPriceCents) : 0;
    const id = `line:${index + 1}`;
    nodes.push({
      id,
      kind: "line_item",
      value: {
        description: description || null,
        quantity: quantityIsValid ? lineItem.quantity : null,
        unitPriceCents: unitPriceIsValid ? lineItem.unitPriceCents : null,
        totalCents: computedTotalCents,
      },
    });
    edges.push({ from: id, to: "subtotal", relation: "contributes_to" });
    mappingLedger.push(
      {
        canonicalPath: `nodes.${id}.value.description`,
        sourceId: input.estimateId,
        sourcePath: `lineItems[${index}].description`,
        sourceDigest,
        ruleId: "native-estimate-description-v1",
        transformation: "copied",
      },
      {
        canonicalPath: `nodes.${id}.value.quantity`,
        sourceId: input.estimateId,
        sourcePath: `lineItems[${index}].quantity`,
        sourceDigest,
        ruleId: "native-estimate-quantity-v1",
        transformation: "copied",
      },
      {
        canonicalPath: `nodes.${id}.value.unitPriceCents`,
        sourceId: input.estimateId,
        sourcePath: `lineItems[${index}].unitPriceCents`,
        sourceDigest,
        ruleId: "native-estimate-unit-price-v1",
        transformation: "copied",
      },
      {
        canonicalPath: `nodes.${id}.value.totalCents`,
        sourceId: input.estimateId,
        sourcePath: `lineItems[${index}].quantity, lineItems[${index}].unitPriceCents`,
        sourceDigest,
        ruleId: "native-estimate-line-total-v1",
        transformation: "computed",
      },
    );
    invariants.push(
      invariant(
        `line.${index + 1}.description`,
        Boolean(description),
        true,
        Boolean(description),
        `Line ${index + 1} has a non-empty canonical description.`,
      ),
      invariant(
        `line.${index + 1}.quantity`,
        quantityIsValid,
        true,
        quantityIsValid,
        `Line ${index + 1} quantity is finite and non-negative.`,
      ),
      invariant(
        `line.${index + 1}.unit_price`,
        unitPriceIsValid,
        true,
        unitPriceIsValid,
        `Line ${index + 1} unit price is a non-negative integer number of cents.`,
      ),
      invariant(
        `line.${index + 1}.source_total`,
        sourceTotalIsValid,
        true,
        sourceTotalIsValid,
        `Line ${index + 1} source total is a non-negative integer number of cents.`,
      ),
      invariant(
        `line.${index + 1}.total_conservation`,
        sourceTotalIsValid && lineItem.totalCents === computedTotalCents,
        computedTotalCents,
        lineItem.totalCents,
        `Line ${index + 1} source total equals quantity × unit price after cent rounding.`,
      ),
    );
    computedSubtotalCents += computedTotalCents;
  });

  const taxIsValid = finiteInteger(input.taxCents) && input.taxCents >= 0;
  const subtotalIsValid = finiteInteger(input.subtotalCents) && input.subtotalCents >= 0;
  const totalIsValid = finiteInteger(input.totalCents) && input.totalCents >= 0;
  const computedTotalCents = computedSubtotalCents + (taxIsValid ? input.taxCents : 0);
  nodes.push(
    { id: "subtotal", kind: "subtotal", value: { totalCents: computedSubtotalCents } },
    { id: "tax", kind: "tax", value: { totalCents: taxIsValid ? input.taxCents : null } },
    { id: "total", kind: "total", value: { totalCents: computedTotalCents } },
  );
  edges.push(
    { from: "subtotal", to: "total", relation: "contributes_to" },
    { from: "tax", to: "total", relation: "contributes_to" },
    { from: "claim", to: "subtotal", relation: "depends_on" },
    { from: "claim", to: "total", relation: "depends_on" },
  );
  mappingLedger.push(
    {
      canonicalPath: "nodes.subtotal.value.totalCents",
      sourceId: input.estimateId,
      sourcePath: "lineItems[*].quantity, lineItems[*].unitPriceCents",
      sourceDigest,
      ruleId: "native-estimate-subtotal-v1",
      transformation: "computed",
    },
    {
      canonicalPath: "nodes.tax.value.totalCents",
      sourceId: input.estimateId,
      sourcePath: "taxCents",
      sourceDigest,
      ruleId: "native-estimate-tax-v1",
      transformation: "copied",
    },
    {
      canonicalPath: "nodes.total.value.totalCents",
      sourceId: input.estimateId,
      sourcePath: "lineItems[*].quantity, lineItems[*].unitPriceCents, taxCents",
      sourceDigest,
      ruleId: "native-estimate-total-v1",
      transformation: "computed",
    },
  );
  invariants.push(
    invariant(
      "subtotal.declared_total",
      subtotalIsValid && input.subtotalCents === computedSubtotalCents,
      computedSubtotalCents,
      input.subtotalCents,
      "Declared subtotal equals the sum of canonical line totals.",
    ),
    invariant("tax.valid", taxIsValid, true, taxIsValid, "Tax is a non-negative integer number of cents."),
    invariant(
      "total.declared_total",
      totalIsValid && input.totalCents === computedTotalCents,
      computedTotalCents,
      input.totalCents,
      "Declared total equals canonical subtotal plus tax.",
    ),
  );

  const unsigned: UnsignedGraph = {
    version: CLAIM_GRAPH_VERSION,
    kernelVersion: CLAIM_KERNEL_VERSION,
    rulesetVersion: CLAIM_GRAPH_RULESET_VERSION,
    claimId: input.claimId,
    sources: [source],
    nodes,
    edges,
    mappingLedger,
    invariants,
    valid: invariants.every((item) => item.passed),
  };
  return { ...unsigned, digest: sha256Canonical(unsigned) };
}

/**
 * A target compiler only accepts a graph whose source and financial
 * invariants are intact. These profiles are vendor-neutral by design; target
 * adapters will translate them into actual platform APIs or browser actions.
 */
export function compileClaimGraphTarget(graph: CanonicalClaimGraph, target: ClaimGraphTarget): {
  target: ClaimGraphTarget;
  sourceGraphDigest: string;
  payload: Record<string, unknown>;
  digest: string;
} {
  if (!verifyCanonicalClaimGraph(graph)) throw new Error("Canonical claim graph digest does not match its contents.");
  if (!graph.valid) throw new Error("Cannot compile a claim graph with failed invariants.");
  const lineItems = graph.nodes
    .filter((node) => node.kind === "line_item")
    .map((node) => ({
      description: node.value.description,
      quantity: node.value.quantity,
      unitPriceCents: node.value.unitPriceCents,
      totalCents: node.value.totalCents,
      nodeId: node.id,
    }));
  const totalCents = graph.nodes.find((node) => node.kind === "total")?.value.totalCents ?? null;
  const payload =
    target === "mogulforge-estimate-v1"
      ? { claimId: graph.claimId, lineItems, totalCents, graphDigest: graph.digest }
      : {
          claimId: graph.claimId,
          statement: {
            lineItems: lineItems.map((item) => ({ description: item.description, amountCents: item.totalCents, sourceNode: item.nodeId })),
            requestedTotalCents: totalCents,
          },
          graphDigest: graph.digest,
        };
  return {
    target,
    sourceGraphDigest: graph.digest,
    payload,
    digest: sha256Canonical({ target, sourceGraphDigest: graph.digest, payload }),
  };
}

export function canonicalClaimGraphBytes(graph: CanonicalClaimGraph): string {
  return canonicalJson(graph);
}

export function verifyCanonicalClaimGraph(graph: CanonicalClaimGraph): boolean {
  const { digest, ...unsigned } = graph;
  return sha256Canonical(unsigned) === digest && graph.valid === graph.invariants.every((item) => item.passed);
}
