/**
 * Approval-gated specialist contract (`proposeOnly`).
 *
 * SCOUT, INVO and the CRM assistant are deterministic or model-assisted
 * *proposers*. They may only append `proposed` rows to the existing BIE
 * action queue, attributed to a `bie_agent_runs` row of their own kind. They
 * can never approve, execute, edit, or retry an action: the only path to an
 * effect stays the existing human review (exact expectedPayload) → execute
 * route in services/bie.ts, with its durable, non-replayable execution
 * ledger. No schema change is needed: `bie_agent_runs.kind` is unconstrained
 * text and the specialist subject key lives in proposal evidence.
 *
 * Guard: this module deliberately imports nothing from ./bie's review or
 * execution functions; specialist-guard.test.ts enforces that statically.
 */
import {
  auditEventsTable,
  bieActionProposalsTable,
  bieAgentRunsTable,
  db,
  type BieActionProposal,
  type BieActionType,
  type BieAgentRunKind,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";

export const SPECIALIST_KEYS = ["scout", "invo", "assistant"] as const;
export type SpecialistKey = (typeof SPECIALIST_KEYS)[number];
/** Specialists a staff member can run from Revenue Desk. The assistant proposes only inside chat. */
export const RUNNABLE_SPECIALISTS = ["scout", "invo"] as const;
export type RunnableSpecialistKey = (typeof RUNNABLE_SPECIALISTS)[number];

export const SPECIALIST_RUN_KIND: Record<SpecialistKey, BieAgentRunKind> = {
  scout: "specialist_scout",
  invo: "specialist_invo",
  assistant: "assistant_proposal",
};
export const SPECIALIST_LABEL: Record<SpecialistKey, string> = {
  scout: "SCOUT",
  invo: "INVO",
  assistant: "Assistant",
};

export function specialistForRunKind(kind: string | null | undefined): SpecialistKey | null {
  for (const key of SPECIALIST_KEYS) if (SPECIALIST_RUN_KIND[key] === kind) return key;
  return null;
}

/** Statuses that mean a proposal is still open or its effect is not yet settled. */
export const OPEN_PROPOSAL_STATUSES = ["proposed", "approved", "processing", "indeterminate"] as const;

/**
 * Everything a specialist may decide. There is intentionally no `status`,
 * reviewer, execution or run field: those are assigned by this module only.
 */
export interface SpecialistProposalDraft {
  leadId: string;
  actionType: BieActionType;
  title: string;
  rationale: string;
  /** Deterministic idempotency key, e.g. `scout:estimate:<id>:step:2`. */
  subjectKey: string;
  /** The facts that triggered the proposal. Stored verbatim for review. */
  evidence: Record<string, unknown>;
  payload: Record<string, unknown>;
  estimatedValueCents?: number | null;
}

const DRAFT_KEYS = new Set([
  "leadId", "actionType", "title", "rationale", "subjectKey", "evidence", "payload", "estimatedValueCents",
]);
const ACTION_TYPES = new Set<BieActionType>(["create_task", "change_stage", "send_email"]);

export class SpecialistContractError extends Error {}

/** Reject anything outside the proposal draft shape (e.g. a smuggled `status`). */
export function assertProposalDraft(draft: SpecialistProposalDraft): void {
  for (const key of Object.keys(draft))
    if (!DRAFT_KEYS.has(key)) throw new SpecialistContractError(`Specialist drafts cannot set "${key}".`);
  if (!ACTION_TYPES.has(draft.actionType)) throw new SpecialistContractError("Unsupported specialist action type.");
  if (!draft.subjectKey || !draft.leadId || !draft.title || !draft.rationale)
    throw new SpecialistContractError("Specialist drafts need a lead, title, rationale and subject key.");
  if ("status" in draft.evidence) throw new SpecialistContractError("Evidence cannot carry a proposal status.");
  // Only a stage change carries a (lead) status, and only as its reviewed target stage.
  if ("status" in draft.payload && draft.actionType !== "change_stage")
    throw new SpecialistContractError("Only a stage-change proposal may name a target lead stage.");
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Writer = typeof db | Tx;

/** Subject keys of a specialist's proposals in the given statuses (all statuses when omitted). */
export async function specialistSubjectKeys(
  writer: Writer,
  organizationId: string,
  key: SpecialistKey,
  statuses?: readonly string[],
): Promise<Map<string, BieActionProposal[]>> {
  const rows = await writer
    .select({ proposal: bieActionProposalsTable })
    .from(bieActionProposalsTable)
    .innerJoin(bieAgentRunsTable, eq(bieActionProposalsTable.runId, bieAgentRunsTable.id))
    .where(and(
      eq(bieActionProposalsTable.organizationId, organizationId),
      eq(bieAgentRunsTable.organizationId, organizationId),
      eq(bieAgentRunsTable.kind, SPECIALIST_RUN_KIND[key]),
      statuses ? inArray(bieActionProposalsTable.status, [...statuses] as BieActionProposal["status"][]) : undefined,
    ));
  const out = new Map<string, BieActionProposal[]>();
  for (const { proposal } of rows) {
    const subject = typeof proposal.evidence.subjectKey === "string" ? proposal.evidence.subjectKey : null;
    if (!subject) continue;
    out.set(subject, [...(out.get(subject) ?? []), proposal]);
  }
  return out;
}

/**
 * The only insert path for specialist proposals. Status is always `proposed`;
 * a draft whose subject key already has an open proposal is skipped, so a
 * re-run never duplicates open work.
 */
export async function insertSpecialistProposals(
  writer: Writer,
  params: { organizationId: string; runId: string; key: SpecialistKey; actorUserId: string; drafts: SpecialistProposalDraft[] },
): Promise<{ inserted: BieActionProposal[]; skippedOpen: string[] }> {
  for (const draft of params.drafts) assertProposalDraft(draft);
  const open = await specialistSubjectKeys(writer, params.organizationId, params.key, OPEN_PROPOSAL_STATUSES);
  const seen = new Set<string>();
  const skippedOpen: string[] = [];
  const values: Array<typeof bieActionProposalsTable.$inferInsert> = [];
  for (const draft of params.drafts) {
    if (open.has(draft.subjectKey) || seen.has(draft.subjectKey)) { skippedOpen.push(draft.subjectKey); continue; }
    seen.add(draft.subjectKey);
    values.push({
      organizationId: params.organizationId,
      runId: params.runId,
      leadId: draft.leadId,
      actionType: draft.actionType,
      status: "proposed",
      title: draft.title.slice(0, 200),
      rationale: draft.rationale.slice(0, 2000),
      evidence: { ...draft.evidence, specialist: SPECIALIST_LABEL[params.key], subjectKey: draft.subjectKey },
      payload: draft.payload,
      estimatedValueCents: draft.estimatedValueCents ?? null,
      createdByUserId: params.actorUserId,
    });
  }
  const inserted = values.length ? await writer.insert(bieActionProposalsTable).values(values).returning() : [];
  return { inserted, skippedOpen };
}

/**
 * Run a specialist planner under the tenant's BIE proposal lock, with a run
 * row and an audit event in the same transaction. The planner receives a
 * read/insert-only handle; it never receives review or execution functions.
 */
export async function withSpecialistRun<T extends { inserted: BieActionProposal[] }>(
  params: { organizationId: string; key: SpecialistKey; actorUserId: string; trigger?: string },
  plan: (tx: Tx, runId: string) => Promise<T & { summary: string; result: Record<string, unknown> }>,
): Promise<T & { runId: string }> {
  return db.transaction(async (tx) => {
    // Same lock as BIE's generator: one proposal writer per tenant at a time.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`bie-proposals:${params.organizationId}`}, 0))`);
    const [run] = await tx.insert(bieAgentRunsTable).values({
      organizationId: params.organizationId,
      kind: SPECIALIST_RUN_KIND[params.key],
      status: "running",
      trigger: params.trigger ?? "manual",
      initiatedByUserId: params.actorUserId,
    }).returning({ id: bieAgentRunsTable.id });
    if (!run) throw new Error("Could not create the specialist run.");
    const outcome = await plan(tx, run.id);
    await tx.update(bieAgentRunsTable).set({
      status: "completed",
      summary: outcome.summary.slice(0, 500),
      result: { ...outcome.result, proposalCount: outcome.inserted.length, proposalIds: outcome.inserted.map((p) => p.id) },
      completedAt: new Date(),
    }).where(and(eq(bieAgentRunsTable.id, run.id), eq(bieAgentRunsTable.organizationId, params.organizationId)));
    await tx.insert(auditEventsTable).values({
      organizationId: params.organizationId,
      actorUserId: params.actorUserId,
      action: `bie.specialist_${params.key}_run`,
      entityType: "bie_agent_run",
      entityId: run.id,
      metadata: { specialist: SPECIALIST_LABEL[params.key], proposalCount: outcome.inserted.length, proposalOnly: true, ...outcome.result },
    });
    return { ...outcome, runId: run.id };
  });
}
