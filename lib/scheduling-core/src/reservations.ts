import { Temporal } from '@js-temporal/polyfill';
import { effectiveReservationSchema, schedulingCandidateSchema, type EffectiveReservation, type SchedulingCandidate } from './models';

const resources = (ids: string[]) => [...new Set(ids)].sort();
const consumes = (row: SchedulingCandidate) => row.startAt !== null && (row.kind === 'appointment'
  ? row.status === 'scheduled' || row.status === 'confirmed'
  : row.status === 'scheduled' || row.status === 'in_progress');
const utc = (instant: string) => Temporal.Instant.from(instant).toString({ fractionalSecondDigits: 3 });

/** Legacy null ends are elapsed defaults, never company calendar or route inference. */
export function effectiveReservation(candidate: SchedulingCandidate): EffectiveReservation | null {
  schedulingCandidateSchema.parse(candidate);
  const saved = candidate.reservation;
  if (saved && (saved.target.kind !== candidate.kind || saved.target.id !== candidate.id)) throw new RangeError('Reservation evidence belongs to another target');
  if (!consumes(candidate)) return null;
  if (saved && candidate.endAt === null) throw new RangeError('Protected active reservation requires its actual end');
  const startAt = utc(candidate.startAt!);
  const endAt = candidate.endAt === null
    ? Temporal.Instant.from(startAt).add({ hours: candidate.kind === 'appointment' ? 2 : 24 }).toString({ fractionalSecondDigits: 3 })
    : utc(candidate.endAt);
  const result = { kind: candidate.kind, id: candidate.id, startAt, endAt, resourceUserIds: resources(candidate.resourceUserIds), savedGapMinutes: saved?.minimumTravelGapMinutes ?? 0 };
  effectiveReservationSchema.parse(result);
  return result;
}

export function classifyReservationTransition(before: SchedulingCandidate | null, after: SchedulingCandidate): 'admission' | 'release' | 'preserve' {
  schedulingCandidateSchema.parse(after);
  if (before) {
    schedulingCandidateSchema.parse(before);
    if (before.kind !== after.kind || before.id !== after.id) throw new RangeError('Cannot transition a different target');
  }
  if (!consumes(after)) return before && (consumes(before) || (before.reservation !== null && before.startAt !== null)) ? 'release' : 'preserve';
  if (!before || !consumes(before)) return 'admission';
  const startChanged = utc(before.startAt!) !== utc(after.startAt!);
  const endChanged = before.endAt === null || after.endAt === null
    ? before.endAt !== after.endAt : utc(before.endAt) !== utc(after.endAt);
  const sourceChanged = (['sourceKind', 'leadId', 'contactId', 'propertyId', 'estimateId'] as const).some(key => before.source[key] !== after.source[key]);
  if (startChanged || endChanged || before.type !== after.type || sourceChanged) return 'admission';
  const oldResources = resources(before.resourceUserIds);
  const nextResources = resources(after.resourceUserIds);
  if (nextResources.some(id => !oldResources.includes(id))) return 'admission';
  return oldResources.length > nextResources.length ? 'release' : 'preserve';
}

export function assertTravel(candidate: EffectiveReservation, neighbors: EffectiveReservation[]): void {
  effectiveReservationSchema.parse(candidate);
  const candidateStart = Temporal.Instant.from(candidate.startAt).epochMilliseconds;
  const candidateEnd = Temporal.Instant.from(candidate.endAt).epochMilliseconds;
  const shared: { row: EffectiveReservation; start: number; end: number }[] = [];
  for (const neighbor of neighbors) {
    effectiveReservationSchema.parse(neighbor);
    if (neighbor.kind === candidate.kind && neighbor.id === candidate.id) continue;
    if (!neighbor.resourceUserIds.some(id => candidate.resourceUserIds.includes(id))) continue;
    const start = Temporal.Instant.from(neighbor.startAt).epochMilliseconds;
    const end = Temporal.Instant.from(neighbor.endAt).epochMilliseconds;
    if (candidateStart < end && start < candidateEnd) throw new RangeError('Same-staff reservations overlap');
    shared.push({ row: neighbor, start, end });
  }
  for (const userId of resources(candidate.resourceUserIds)) {
    const staffNeighbors = shared.filter(neighbor => neighbor.row.resourceUserIds.includes(userId));
    let precedingEnd = -Infinity;
    let followingStart = Infinity;
    for (const neighbor of staffNeighbors) {
      if (neighbor.end <= candidateStart) precedingEnd = Math.max(precedingEnd, neighbor.end);
      if (neighbor.start >= candidateEnd) followingStart = Math.min(followingStart, neighbor.start);
    }
    for (const neighbor of staffNeighbors) {
      if (neighbor.end !== precedingEnd && neighbor.start !== followingStart) continue;
      const requiredGap = Math.max(candidate.savedGapMinutes, neighbor.row.savedGapMinutes) * 60_000;
      const gap = candidateStart >= neighbor.end ? candidateStart - neighbor.end : neighbor.start - candidateEnd;
      if (gap < requiredGap) throw new RangeError('Saved travel gap is not satisfied');
    }
  }
}

/** Peak is measured only inside the candidate interval; half-open ends release first. */
export function peakConcurrency(candidate: EffectiveReservation, neighbors: EffectiveReservation[]): number {
  effectiveReservationSchema.parse(candidate);
  const from = Temporal.Instant.from(candidate.startAt).epochMilliseconds;
  const to = Temporal.Instant.from(candidate.endAt).epochMilliseconds;
  const events: { at: number; delta: number }[] = [{ at: from, delta: 1 }, { at: to, delta: -1 }];
  const seen = new Set<string>([`${candidate.kind}:${candidate.id}`]);
  for (const neighbor of neighbors) {
    effectiveReservationSchema.parse(neighbor);
    const key = `${neighbor.kind}:${neighbor.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const start = Math.max(from, Temporal.Instant.from(neighbor.startAt).epochMilliseconds);
    const end = Math.min(to, Temporal.Instant.from(neighbor.endAt).epochMilliseconds);
    if (start < end) events.push({ at: start, delta: 1 }, { at: end, delta: -1 });
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let count = 0;
  let peak = 0;
  for (const event of events) { count += event.delta; peak = Math.max(peak, count); }
  return peak;
}
