import { and, eq, inArray } from 'drizzle-orm';
import { db, usersTable } from '@workspace/db';
import { schedulingConflictExplanationRequestSchema, schedulingConflictExplanationSchema, findTravelConflict, type EffectiveReservation } from '@workspace/scheduling-core';
import { getSchedulingReviewContextInTransaction, SchedulingPolicyError, type SchedulingActor } from './scheduling-policy';
import { readSchedulingEvidence } from './scheduling-admission';
export async function explainSchedulingConflict(actor: SchedulingActor, input: unknown) {
  const parsed = schedulingConflictExplanationRequestSchema.parse(input);
  return db.transaction(async tx => {
    const context = await getSchedulingReviewContextInTransaction(tx, actor, parsed.query);
    if (JSON.stringify(context) !== JSON.stringify(parsed.context)) throw new SchedulingPolicyError('stale_scheduling_review', 'Refresh the current schedule before requesting an explanation.');
    const ids = [...new Set(parsed.interval.resourceUserIds)].sort();
    const staff = ids.length ? await tx.select({ id: usersTable.id }).from(usersTable).where(and(eq(usersTable.organizationId, actor.organizationId), inArray(usersTable.id, ids))).orderBy(usersTable.id).for('share') : [];
    if (staff.length !== ids.length) throw new SchedulingPolicyError('scheduling_access_denied', 'The requested scheduling resources are unavailable.', 403);
    const candidate: EffectiveReservation = { kind: parsed.query.reservationKind, id: parsed.query.targetId ?? '00000000-0000-4000-8000-000000000000', ...parsed.interval, resourceUserIds: ids, savedGapMinutes: context.applicableRules.newTravelGapMinutes };
    const neighbors = await readSchedulingEvidence(tx, actor.organizationId, candidate, 'resource', !!parsed.query.targetId);
    const conflict = findTravelConflict(candidate, neighbors, !!parsed.query.targetId);
    return schedulingConflictExplanationSchema.parse({ basis: 'current_schedule', evaluatedAt: new Date().toISOString(), context,
      conflict: conflict ? { reservationKind: conflict.neighbor.kind, reservationId: conflict.neighbor.id, resourceUserId: conflict.resourceUserId, startAt: conflict.neighbor.startAt, endAt: conflict.neighbor.endAt, reason: conflict.reason, requiredGapMinutes: conflict.requiredGapMinutes } : null,
    });
  });
}
