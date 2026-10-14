import { describe, expect, it } from 'vitest';
import { assertTravel, classifyReservationTransition, effectiveReservation, peakConcurrency, type EffectiveReservation, type SchedulingCandidate } from './index';

const id = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const source = { sourceKind: 'unlinked_manual' as const, leadId: null, contactId: null, propertyId: null, estimateId: null };
const candidate: SchedulingCandidate = { kind: 'appointment', id, startAt: '2026-10-13T10:00:00.000Z', endAt: '2026-10-13T12:00:00.000Z', resourceUserIds: ['b', 'a', 'b'], type: 'inspection', status: 'scheduled', source, reservation: null };
const snapshot = { formatVersion: 1 as const, reservationRevision: 2, sourcePolicyRevision: 1, sourcePolicyDigest: 'a'.repeat(64), approvedTimeZone: 'America/New_York', inspection: null, startAt: '2026-10-13T10:00:00.000Z', endAt: '2026-10-13T12:00:00.000Z', resourceUserIds: ['a', 'b'], minimumTravelGapMinutes: 60, duration: { kind: 'explicit' as const, preset: null }, admittedAt: '2026-10-13T09:00:00.000Z', admittedByUserId: 'a', target: { kind: 'appointment' as const, id }, lastTransition: { kind: 'release' as const, actorUserId: 'a', at: '2026-10-13T09:30:00.000Z' } };
const reserve = (id: string, start: string, end: string, resources = ['a'], gap = 0): EffectiveReservation => ({ kind: 'appointment', id, startAt: `2026-10-13T${start}:00.000Z`, endAt: `2026-10-13T${end}:00.000Z`, resourceUserIds: resources, savedGapMinutes: gap });

describe('effective reservations', () => {
  it('derives the fixed two-hour legacy appointment end and sorts distinct staff', () => {
    expect(effectiveReservation({ ...candidate, endAt: null })).toEqual({ kind: 'appointment', id, startAt: candidate.startAt, endAt: '2026-10-13T12:00:00.000Z', resourceUserIds: ['a', 'b'], savedGapMinutes: 0 });
  });
  it('derives one elapsed day for legacy projects while preserving explicit multiday ends', () => {
    expect(effectiveReservation({ ...candidate, kind: 'project', endAt: null })?.endAt).toBe('2026-10-14T10:00:00.000Z');
    expect(effectiveReservation({ ...candidate, kind: 'project', endAt: '2026-10-17T10:00:00.000Z' })?.endAt).toBe('2026-10-17T10:00:00.000Z');
  });
  it.each(['completed', 'cancelled', 'no_show'])('does not consume appointment capacity in %s', (status) => {
    expect(effectiveReservation({ ...candidate, status })).toBeNull();
  });
  it.each(['on_hold', 'completed', 'cancelled'])('does not consume project capacity in %s', (status) => {
    expect(effectiveReservation({ ...candidate, kind: 'project', status })).toBeNull();
  });
  it('counts confirmed visits and in-progress jobs even without staff', () => {
    expect(effectiveReservation({ ...candidate, status: 'confirmed', resourceUserIds: [] })).not.toBeNull();
    expect(effectiveReservation({ ...candidate, kind: 'project', status: 'in_progress', resourceUserIds: [] })).not.toBeNull();
    expect(effectiveReservation({ ...candidate, startAt: null, endAt: null })).toBeNull();
  });
  it('retains saved gap protection through a release revision', () => {
    expect(effectiveReservation({ ...candidate, resourceUserIds: ['a'], reservation: snapshot })?.savedGapMinutes).toBe(60);
  });
  it('rejects invalid versioned evidence instead of silently falling back to legacy', () => {
    expect(() => effectiveReservation({ ...candidate, reservation: { ...snapshot, formatVersion: 2 } as typeof snapshot })).toThrow();
    expect(() => effectiveReservation({ ...candidate, reservation: { ...snapshot, target: { kind: 'appointment', id: otherId } } })).toThrow();
  });
  it.each(['appointment', 'project'] as const)('refuses a protected active %s with a cleared end', (kind) => {
    expect(() => effectiveReservation({ ...candidate, kind, endAt: null, reservation: { ...snapshot, target: { kind, id } } })).toThrow();
  });
});

describe('same-staff travel', () => {
  it.each([{ resources: ['a'] }, { resources: ['b'] }, { resources: ['b', 'a'] }, { resources: ['a', 'a'] }])('applies the larger saved gap for every shared resource $resources', ({ resources }) => {
    const earlier = reserve(otherId, '10:00', '12:00', resources, 60);
    const onBoundary = reserve(id, '13:00', '14:00', ['a', 'b'], 30);
    const tooSoon = reserve(id, '12:59', '14:00', ['a', 'b'], 30);
    expect(() => assertTravel(onBoundary, [earlier])).not.toThrow();
    expect(() => assertTravel(earlier, [onBoundary])).not.toThrow();
    expect(() => assertTravel(tooSoon, [earlier])).toThrow();
    expect(() => assertTravel(earlier, [tooSoon])).toThrow();
  });
  it('rejects overlapping same-staff work even with a zero saved gap', () => {
    expect(() => assertTravel(reserve(id, '11:00', '13:00'), [reserve(otherId, '10:00', '12:00')])).toThrow();
  });
  it('permits overlap for different staff and zero-gap touching endpoints', () => {
    expect(() => assertTravel(reserve(id, '11:00', '13:00', ['a']), [reserve(otherId, '10:00', '12:00', ['b'])])).not.toThrow();
    expect(() => assertTravel(reserve(id, '12:00', '13:00'), [reserve(otherId, '10:00', '12:00')])).not.toThrow();
  });
  it('applies travel only to the nearest reservation per resource', () => {
    expect(() => assertTravel(reserve(id, '13:00', '14:00'), [
      reserve(otherId, '10:00', '11:00', ['a'], 180),
      reserve('33333333-3333-4333-8333-333333333333', '11:30', '12:00', ['a'], 30),
    ])).not.toThrow();
  });
  it('finds independent nearest reservations for each staff member', () => {
    expect(() => assertTravel(reserve(id, '13:00', '14:00', ['a', 'b']), [
      reserve(otherId, '11:00', '12:00', ['a']),
      reserve('33333333-3333-4333-8333-333333333333', '11:00', '12:30', ['b'], 31),
    ])).toThrow();
  });
  it('checks every tied nearest gap on both sides', () => {
    const ties = [reserve(otherId, '11:00', '12:00', ['a']), reserve('33333333-3333-4333-8333-333333333333', '11:30', '12:00', ['a'], 61)];
    expect(() => assertTravel(reserve(id, '13:00', '14:00'), ties)).toThrow();
    expect(() => assertTravel(reserve(id, '09:00', '10:00'), [reserve(otherId, '11:00', '12:00'), reserve('33333333-3333-4333-8333-333333333333', '11:00', '12:30', ['a'], 61)])).toThrow();
  });
});

describe('company concurrency', () => {
  it('calculates the true peak across nonoverlapping neighbors', () => {
    expect(peakConcurrency(reserve(id, '09:00', '17:00'), [reserve(otherId, '10:00', '11:00'), reserve('33333333-3333-4333-8333-333333333333', '12:00', '13:00')])).toBe(2);
  });
  it('releases half-open endpoints before starting touching work', () => {
    expect(peakConcurrency(reserve(id, '10:00', '12:00'), [reserve(otherId, '09:00', '10:00'), reserve('33333333-3333-4333-8333-333333333333', '12:00', '13:00')])).toBe(1);
  });
  it('counts a multi-staff reservation once and replaces its own old interval', () => {
    const next = reserve(id, '10:00', '12:00', ['a', 'b']);
    expect(peakConcurrency(next, [reserve(id, '09:00', '11:00'), reserve(otherId, '11:00', '13:00', ['a', 'b'])])).toBe(2);
  });
  it('does not let unrelated neighbor peaks outside the candidate window refuse admission', () => {
    expect(peakConcurrency(reserve(id, '15:00', '16:00'), [reserve(otherId, '10:00', '12:00'), reserve('33333333-3333-4333-8333-333333333333', '10:00', '12:00')])).toBe(1);
  });
});

describe('reservation transitions', () => {
  it('admits new consuming work and preserves new unscheduled work', () => {
    expect(classifyReservationTransition(null, candidate)).toBe('admission');
    expect(classifyReservationTransition(null, { ...candidate, startAt: null, endAt: null })).toBe('preserve');
  });
  it('preserves confirmation, equivalent staff sets and explicit long intervals', () => {
    expect(classifyReservationTransition(candidate, { ...candidate, status: 'confirmed', resourceUserIds: ['a', 'b'] })).toBe('preserve');
    const long = { ...candidate, kind: 'project' as const, endAt: '2026-10-17T10:00:00.000Z' };
    expect(classifyReservationTransition(long, { ...long, status: 'in_progress' })).toBe('preserve');
  });
  it('releases only removed resources and closure without current admission', () => {
    expect(classifyReservationTransition(candidate, { ...candidate, resourceUserIds: ['a'] })).toBe('release');
    expect(classifyReservationTransition(candidate, { ...candidate, status: 'completed' })).toBe('release');
  });
  it('admits changed intervals, staff additions, source lineage and appointment type', () => {
    for (const patch of [{ endAt: '2026-10-13T13:00:00.000Z' }, { resourceUserIds: ['a', 'b', 'c'] }, { type: 'production' }, { source: { ...source, sourceKind: 'direct_customer' as const, contactId: otherId } }]) {
      expect(classifyReservationTransition(candidate, { ...candidate, ...patch })).toBe('admission');
    }
    expect(classifyReservationTransition({ ...candidate, status: 'cancelled' }, candidate)).toBe('admission');
  });
  it('releases a protected job when both dates clear even if crew remains', () => {
    const protectedJob = { ...candidate, kind: 'project' as const, reservation: { ...snapshot, target: { kind: 'project' as const, id } } };
    expect(classifyReservationTransition(protectedJob, { ...protectedJob, startAt: null, endAt: null })).toBe('release');
  });
  it('classifies protected end-only clearing as admission for downstream refusal', () => {
    const protectedVisit = { ...candidate, reservation: snapshot };
    expect(classifyReservationTransition(protectedVisit, { ...protectedVisit, endAt: null })).toBe('admission');
  });
});
