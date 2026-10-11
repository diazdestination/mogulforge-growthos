/**
 * CRM-assistant proposal tools. The model may ask for a follow-up task or a
 * stage change; this module validates tenant ownership and the requesting
 * user's permission, then appends a single `proposed` queue row attributed to
 * an `assistant_proposal` run. Nothing is changed, created or sent until a
 * staff member approves and executes it in Revenue Desk.
 */
import { db, leadsTable, usersTable, type BieActionProposal } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";

import { hasPermission } from "../../lib/permissions";
import { insertSpecialistProposals, specialistSubjectKeys, OPEN_PROPOSAL_STATUSES, withSpecialistRun } from "./contract";

/** Reviewable target stages the assistant may suggest. Closing/winning a deal is never proposed by chat. */
export const ASSISTANT_STAGE_TARGETS = ["contact_attempted", "follow_up", "nurture"] as const;

export interface AssistantProposalResult {
  ok: boolean;
  proposalId?: string;
  actionType?: BieActionProposal["actionType"];
  title?: string;
  leadId?: string;
  status?: "proposed";
  duplicate?: boolean;
  message: string;
}

const taskInput = z.object({
  leadId: z.uuid(),
  title: z.string().trim().min(3).max(120),
  reason: z.string().trim().min(3).max(600),
  priority: z.enum(["normal", "high"]).optional(),
}).strict();
const stageInput = z.object({
  leadId: z.uuid(),
  status: z.enum(ASSISTANT_STAGE_TARGETS),
  reason: z.string().trim().min(3).max(600),
}).strict();

const AWAITING = "Proposed — awaiting staff approval in Revenue Desk. Nothing has been changed, created or sent.";

async function assertProposer(organizationId: string, userId: string) {
  const [user] = await db.select({ role: usersTable.role }).from(usersTable)
    .where(and(eq(usersTable.id, userId), eq(usersTable.organizationId, organizationId), eq(usersTable.isActive, true)));
  return Boolean(user && hasPermission(user.role, "crm.write"));
}

async function propose(
  organizationId: string,
  userId: string,
  leadId: string,
  draft: { actionType: "create_task" | "change_stage"; subjectKey: string; title: string; rationale: string; payload: Record<string, unknown>; evidence: Record<string, unknown> },
): Promise<AssistantProposalResult> {
  if (!(await assertProposer(organizationId, userId)))
    return { ok: false, message: "You do not have permission to propose CRM changes." };
  const [lead] = await db.select({ id: leadsTable.id, status: leadsTable.status, value: leadsTable.estimatedValueCents }).from(leadsTable)
    .where(and(eq(leadsTable.organizationId, organizationId), eq(leadsTable.id, leadId)));
  if (!lead) return { ok: false, message: "That lead was not found in this company." };
  const outcome = await withSpecialistRun({ organizationId, key: "assistant", actorUserId: userId, trigger: "assistant_chat" }, async (tx, runId) => {
    const open = await specialistSubjectKeys(tx, organizationId, "assistant", OPEN_PROPOSAL_STATUSES);
    const existing = open.get(draft.subjectKey)?.[0] ?? null;
    const { inserted } = await insertSpecialistProposals(tx, { organizationId, runId, key: "assistant", actorUserId: userId, drafts: [{
      leadId, actionType: draft.actionType, subjectKey: draft.subjectKey, title: draft.title, rationale: draft.rationale,
      payload: draft.payload, evidence: { ...draft.evidence, leadStatus: lead.status, requestedByUserId: userId }, estimatedValueCents: lead.value,
    }] });
    return { inserted, existing, summary: inserted.length ? "Assistant proposed 1 action for review." : "Assistant request matched an open proposal.", result: { duplicate: !inserted.length } };
  });
  const proposal = outcome.inserted[0] ?? outcome.existing;
  if (!proposal) return { ok: false, message: "The proposal could not be recorded." };
  return { ok: true, proposalId: proposal.id, actionType: proposal.actionType, title: proposal.title, leadId, status: "proposed", duplicate: !outcome.inserted.length, message: AWAITING };
}

export async function proposeFollowUpTask(organizationId: string, userId: string, raw: unknown): Promise<AssistantProposalResult> {
  const input = taskInput.safeParse(raw);
  if (!input.success) return { ok: false, message: "A follow-up task needs a valid lead id, a short title and a reason." };
  return propose(organizationId, userId, input.data.leadId, {
    actionType: "create_task",
    subjectKey: `assistant:lead:${input.data.leadId}:task`,
    title: `Follow-up task: ${input.data.title}`,
    rationale: `Requested in the CRM assistant: ${input.data.reason}`,
    payload: { title: input.data.title, description: input.data.reason, priority: "high" },
    evidence: { rule: "assistant_request", requestedPriority: input.data.priority ?? "high" },
  });
}

export async function proposeStageChange(organizationId: string, userId: string, raw: unknown): Promise<AssistantProposalResult> {
  const input = stageInput.safeParse(raw);
  if (!input.success) return { ok: false, message: `A stage change needs a valid lead id, one of ${ASSISTANT_STAGE_TARGETS.join(", ")}, and a reason.` };
  return propose(organizationId, userId, input.data.leadId, {
    actionType: "change_stage",
    subjectKey: `assistant:lead:${input.data.leadId}:stage:${input.data.status}`,
    title: `Move lead to ${input.data.status.replace("_", " ")}`,
    rationale: `Requested in the CRM assistant: ${input.data.reason}`,
    payload: { status: input.data.status },
    evidence: { rule: "assistant_request", targetStage: input.data.status },
  });
}
