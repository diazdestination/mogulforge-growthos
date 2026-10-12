/**
 * Contractor eval dataset contracts.
 *
 * Every case carries a label provenance. Only `contractor-verified` cases may
 * contribute to a reported contractor-agreement figure; `research-draft`
 * labels were written from public research and owner interviews and are a
 * development signal only.
 */
import { z } from "zod";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{1,80}$/, "ids are lowercase kebab-case");
const alias = z.string().regex(/^E\d{1,3}$/, "artifact aliases look like E1, E2, ...");
/** Lexical-judge hints: every entry must appear; `a|b` means either alternative. */
const keyTerms = z.array(z.string().min(1)).max(8).optional();

export const labelProvenanceSchema = z
  .object({
    status: z.enum(["research-draft", "contractor-verified"]),
    /** A role or pseudonymous reviewer handle, never a person's name. */
    labeledBy: z.string().min(1),
    labeledAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
    reviewerRole: z.string().min(1),
    /** Where the case material came from, e.g. an owner-supplied redacted invoice. */
    source: z.string().min(1).optional(),
  })
  .strict();

export const evalArtifactSchema = z
  .object({
    alias,
    filename: z.string().min(1),
    mimeType: z.literal("text/plain"),
    sourceLabel: z.string().min(1),
    text: z.string().min(1),
  })
  .strict();

export const expectedObservationSchema = z
  .object({
    id,
    statement: z.string().min(1),
    category: z.string().min(1),
    critical: z.boolean(),
    supportingAliases: z.array(alias).min(1),
    keyTerms,
  })
  .strict();

export const expectedConflictSchema = z
  .object({ id, description: z.string().min(1), aliases: z.array(alias).min(2), keyTerms })
  .strict();

export const expectedGapSchema = z
  .object({ id, description: z.string().min(1), keyTerms })
  .strict();

export const forbiddenClaimSchema = z
  .object({
    id,
    description: z.string().min(1),
    /** Case-insensitive regular expressions used by the deterministic judge. */
    patterns: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const expectedLineItemSchema = z
  .object({
    title: z.string().min(1),
    qty: z.number().positive().nullable(),
    amountCents: z.number().int().nonnegative(),
    descriptionComponents: z.array(z.string().min(1)),
  })
  .strict();

const centsOrAbsent = z.number().int().nonnegative().nullable();

/** Labels for invoice/estimate line-item extraction and invoice-wording review. */
export const documentLabelsSchema = z
  .object({
    documentType: z.enum(["invoice", "estimate"]),
    lineItems: z.array(expectedLineItemSchema).min(1),
    totals: z
      .object({
        subtotalCents: centsOrAbsent,
        totalCents: centsOrAbsent,
        amountPaidCents: centsOrAbsent,
        balanceDueCents: centsOrAbsent,
      })
      .strict(),
    paymentTerms: z.string().min(1).nullable(),
    warranty: z
      .object({ present: z.boolean(), terms: z.array(z.string().min(1)) })
      .strict(),
    flags: z.array(z.object({ id, description: z.string().min(1), keyTerms }).strict()),
  })
  .strict();

export const evidenceCaseSchema = z
  .object({
    id,
    kind: z.enum(["evidence", "document-extraction"]),
    trade: z.enum(["roofing", "hvac"]),
    /** Which real workflow the case reflects, e.g. `css-intake-2026-10-09#invoicing`. */
    workflow: z.string().min(1),
    tags: z.array(z.string().min(1)).default([]),
    caseSummary: z.string().min(1),
    artifacts: z.array(evalArtifactSchema).min(1),
    labels: z
      .object({
        expectedObservations: z.array(expectedObservationSchema),
        expectedConflicts: z.array(expectedConflictSchema),
        expectedGaps: z.array(expectedGapSchema),
        forbiddenClaims: z.array(forbiddenClaimSchema),
        document: documentLabelsSchema.optional(),
      })
      .strict(),
    labelProvenance: labelProvenanceSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const aliases = new Set(value.artifacts.map((artifact) => artifact.alias));
    if (aliases.size !== value.artifacts.length) {
      ctx.addIssue({ code: "custom", message: `${value.id}: duplicate artifact alias` });
    }
    const cited = [
      ...value.labels.expectedObservations.flatMap((item) => item.supportingAliases),
      ...value.labels.expectedConflicts.flatMap((item) => item.aliases),
    ];
    for (const citedAlias of cited) {
      if (!aliases.has(citedAlias)) {
        ctx.addIssue({ code: "custom", message: `${value.id}: label cites unknown alias ${citedAlias}` });
      }
    }
    const ids = [
      ...value.labels.expectedObservations,
      ...value.labels.expectedConflicts,
      ...value.labels.expectedGaps,
      ...value.labels.forbiddenClaims,
    ].map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: `${value.id}: duplicate label id` });
    }
    if ((value.kind === "document-extraction") !== Boolean(value.labels.document)) {
      ctx.addIssue({ code: "custom", message: `${value.id}: document labels must match kind` });
    }
  });

export type EvidenceEvalCase = z.infer<typeof evidenceCaseSchema>;
export type ExpectedObservation = z.infer<typeof expectedObservationSchema>;
export type ForbiddenClaim = z.infer<typeof forbiddenClaimSchema>;
export type DocumentLabels = z.infer<typeof documentLabelsSchema>;
export type LabelProvenance = z.infer<typeof labelProvenanceSchema>;

export const ASSISTANT_TOOL_NAMES = [
  "get_pipeline_snapshot",
  "get_conversion_insights",
  "get_appointments_stats",
  "get_team_workload",
  "get_revenue_summary",
  "get_stale_leads",
] as const;

const toolName = z.enum(ASSISTANT_TOOL_NAMES);

export const assistantCaseSchema = z
  .object({
    id,
    trade: z.enum(["roofing", "hvac", "any"]),
    workflow: z.string().min(1),
    orgName: z.string().min(1).nullable(),
    question: z.string().min(1),
    /** Canned results for the assistant's existing read-only tools. */
    toolFixtures: z.partialRecord(toolName, z.unknown()),
    expectedTools: z.array(toolName),
    /** Tools that are acceptable but not required. */
    optionalTools: z.array(toolName).default([]),
    requiredFacts: z.array(z.object({ id, statement: z.string().min(1), keyTerms }).strict()),
    forbiddenBehaviors: z.array(forbiddenClaimSchema),
    labelProvenance: labelProvenanceSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const tool of value.expectedTools) {
      if (!(tool in value.toolFixtures)) {
        ctx.addIssue({ code: "custom", message: `${value.id}: expected tool ${tool} has no fixture` });
      }
    }
  });

export type AssistantEvalCase = z.infer<typeof assistantCaseSchema>;

export const calibrationPairSchema = z
  .object({
    id,
    expected: z.object({ statement: z.string().min(1), keyTerms }).strict(),
    finding: z.object({ statement: z.string().min(1) }).strict(),
    humanVerdict: z.enum(["match", "no-match"]),
    rationale: z.string().min(1),
    labelProvenance: labelProvenanceSchema,
  })
  .strict();

export type CalibrationPair = z.infer<typeof calibrationPairSchema>;

/* ------------------------------------------------- candidate (model) outputs */

/** Structural copy of the production evidence draft (aliases, not database ids). */
export const evalDraftSchema = z.object({
  executiveSummary: z.string(),
  findings: z.array(
    z.object({
      category: z.string(),
      statement: z.string(),
      citations: z.array(
        z.object({ artifactId: z.string(), locator: z.string(), basis: z.string(), strength: z.string() }),
      ),
      confidence: z.number(),
      needsHumanReview: z.boolean(),
    }),
  ),
  conflicts: z.array(z.object({ summary: z.string(), artifactIds: z.array(z.string()) })),
  gaps: z.array(z.object({ title: z.string(), reason: z.string(), recommendedAction: z.string() })),
  limitations: z.array(z.string()),
  recommendedNextSteps: z.array(z.string()),
});

export type EvalDraft = z.infer<typeof evalDraftSchema>;

export const documentExtractionSchema = z.object({
  lineItems: z.array(
    z.object({
      title: z.string(),
      qty: z.number().nullable(),
      amountCents: z.number().int().nullable(),
      descriptionComponents: z.array(z.string()),
      /** Any per-component price the extractor asserted. Must be empty when the document does not itemize. */
      componentPricesCents: z.array(z.number().int()).default([]),
    }),
  ),
  totals: z.object({
    subtotalCents: centsOrAbsent,
    totalCents: centsOrAbsent,
    amountPaidCents: centsOrAbsent,
    balanceDueCents: centsOrAbsent,
  }),
  paymentTerms: z.string().nullable(),
  warranty: z.object({ present: z.boolean(), terms: z.array(z.string()) }),
  flags: z.array(z.string()),
});

export type DocumentExtraction = z.infer<typeof documentExtractionSchema>;

export const assistantOutputSchema = z.object({
  toolCalls: z.array(z.object({ name: z.string(), args: z.record(z.string(), z.unknown()).nullable() })),
  answer: z.string(),
});

export type AssistantOutput = z.infer<typeof assistantOutputSchema>;
