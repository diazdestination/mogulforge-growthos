import { describe, expect, it } from 'vitest';
import {
  schedulingPolicySchema, policySaveInputSchema, reservationSnapshotSchema,
  schedulingReviewContextSchema, schedulingMutationReviewSchema, manualSchedulingCommandSchema, manualSchedulingAckSchema,
} from './index';

const id = '11111111-1111-4111-8111-111111111111';
const digest = 'a'.repeat(64);
const instant = '2026-10-13T09:00:00.000Z';
const source = { sourceKind: 'unlinked_manual', leadId: null, contactId: null, propertyId: null, estimateId: null };
const preset = { id, label: 'A visit', elapsedMinutes: 60 };
const policy = { formatVersion: 1, revision: 1, enabled: true, timeZone: 'America/New_York', minimumTravelGapMinutes: 0, maxConcurrentReservations: null, durationPresets: [preset], digest, updatedAt: instant, updatedByUserId: 'staff_1' };
const context = { organizationId: id, policyRevision: 1, policyDigest: digest, companyTimeZone: 'America/New_York', inspection: null, applicableRules: { newTravelGapMinutes: 0, companyCeiling: null, inspectionCeiling: null }, source, targetVersion: null, targetFingerprint: null };
const review = { context, duration: { kind: 'explicit', preset: null }, startWallTime: null, endWallTime: null };
const snapshot = { formatVersion: 1, reservationRevision: 1, sourcePolicyRevision: 1, sourcePolicyDigest: digest, approvedTimeZone: 'America/New_York', inspection: null, startAt: instant, endAt: '2026-10-13T10:00:00.000Z', resourceUserIds: ['staff_1'], minimumTravelGapMinutes: 60, duration: { kind: 'explicit', preset: null }, admittedAt: instant, admittedByUserId: 'staff_1', target: { kind: 'appointment', id }, lastTransition: { kind: 'admission', actorUserId: 'staff_1', at: instant } };

describe('policy validation', () => {
  it('accepts the travel and company-cap boundaries', () => {
    expect(schedulingPolicySchema.safeParse({ ...policy, minimumTravelGapMinutes: 1440, maxConcurrentReservations: 100 }).success).toBe(true);
    expect(schedulingPolicySchema.safeParse({ ...policy, minimumTravelGapMinutes: 1441 }).success).toBe(false);
    expect(schedulingPolicySchema.safeParse({ ...policy, maxConcurrentReservations: 101 }).success).toBe(false);
    expect(schedulingPolicySchema.safeParse({ ...policy, maxConcurrentReservations: 0 }).success).toBe(false);
  });
  it('accepts 50 distinct presets and refuses the 51st', () => {
    const durationPresets = Array.from({ length: 51 }, (_, i) => ({ id: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`, label: `Visit ${i}`, elapsedMinutes: 1 }));
    expect(schedulingPolicySchema.safeParse({ ...policy, durationPresets: durationPresets.slice(0, 50) }).success).toBe(true);
    expect(schedulingPolicySchema.safeParse({ ...policy, durationPresets }).success).toBe(false);
  });
  it.each([NaN, Infinity, 1.5, -1])('rejects a noninteger or nonfinite gap %s', (minimumTravelGapMinutes) => {
    expect(schedulingPolicySchema.safeParse({ ...policy, minimumTravelGapMinutes }).success).toBe(false);
  });
  it.each([0, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects an unsafe policy revision %s', (revision) => {
    expect(schedulingPolicySchema.safeParse({ ...policy, revision }).success).toBe(false);
  });
  it('refuses duplicate stable IDs and duplicate nonblank labels', () => {
    expect(schedulingPolicySchema.safeParse({ ...policy, durationPresets: [preset, { ...preset, label: 'Different' }] }).success).toBe(false);
    expect(schedulingPolicySchema.safeParse({ ...policy, durationPresets: [preset, { ...preset, id: '22222222-2222-4222-8222-222222222222' }] }).success).toBe(false);
    expect(schedulingPolicySchema.safeParse({ ...policy, durationPresets: [{ ...preset, label: '   ' }] }).success).toBe(false);
    expect(schedulingPolicySchema.safeParse({ ...policy, durationPresets: [{ ...preset, label: 'x'.repeat(81) }] }).success).toBe(false);
  });
  it.each([0, 1441, 1.5, NaN])('refuses an invalid preset elapsed duration %s', (elapsedMinutes) => {
    expect(schedulingPolicySchema.safeParse({ ...policy, durationPresets: [{ ...preset, elapsedMinutes }] }).success).toBe(false);
  });
  it('rejects malformed identifiers and implicit or invalid instants', () => {
    for (const patch of [{ updatedByUserId: '' }, { updatedAt: '2026-10-13T09:00' }, { updatedAt: '2026-02-30T09:00:00.000Z' }, { digest: 'bad' }, { timeZone: 'Imaginary/Zone' }]) {
      expect(schedulingPolicySchema.safeParse({ ...policy, ...patch }).success).toBe(false);
    }
    expect(schedulingPolicySchema.safeParse({ ...policy, durationPresets: [{ ...preset, id: '11111111-1111-4111-8111-11111111111A' }] }).success).toBe(false);
  });
  it('lets save request new preset IDs while refusing server-owned fields', () => {
    const save = { expectedRevision: 0, expectedCompanyTimeZone: 'America/New_York', enabled: false, minimumTravelGapMinutes: 0, maxConcurrentReservations: null, durationPresets: [{ id: null, label: 'Custom', elapsedMinutes: 1440 }] };
    expect(policySaveInputSchema.safeParse(save).success).toBe(true);
    expect(policySaveInputSchema.safeParse({ ...save, revision: 1 }).success).toBe(false);
    expect(policySaveInputSchema.safeParse({ ...save, durationPresets: [{ id: null, label: 'Custom', elapsedMinutes: 60 }, { id: null, label: 'Another', elapsedMinutes: 60 }] }).success).toBe(true);
  });
});

describe('closed scheduling DTOs', () => {
  it('refuses unknown keys and missing required keys at every model boundary', () => {
    for (const [schema, value] of [[schedulingPolicySchema, policy], [reservationSnapshotSchema, snapshot], [schedulingReviewContextSchema, context], [schedulingMutationReviewSchema, review]] as const) {
      expect(schema.safeParse(value).success).toBe(true);
      expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
    }
    expect(schedulingReviewContextSchema.safeParse({ ...context, applicableRules: { ...context.applicableRules, actor: 'staff_1' } }).success).toBe(false);
  });
  it('requires coherent source lineage while retaining customerless manual visits', () => {
    expect(schedulingReviewContextSchema.safeParse(context).success).toBe(true);
    expect(schedulingReviewContextSchema.safeParse({ ...context, source: { ...source, leadId: id } }).success).toBe(false);
    expect(schedulingReviewContextSchema.safeParse({ ...context, source: { ...source, sourceKind: 'lead' } }).success).toBe(false);
    expect(schedulingReviewContextSchema.safeParse({ ...context, source: { ...source, sourceKind: 'direct_customer', contactId: id } }).success).toBe(true);
  });
  it('rejects inconsistent preset and interval snapshots', () => {
    expect(reservationSnapshotSchema.safeParse({ ...snapshot, duration: { kind: 'preset', preset: null } }).success).toBe(false);
    expect(reservationSnapshotSchema.safeParse({ ...snapshot, endAt: instant }).success).toBe(false);
    expect(reservationSnapshotSchema.safeParse({ ...snapshot, duration: { kind: 'explicit', preset } }).success).toBe(false);
  });
  it('reports malformed interval instants as validation failures rather than throwing from safeParse', () => {
    expect(reservationSnapshotSchema.safeParse({ ...snapshot, startAt: 'not-an-instant' }).success).toBe(false);
  });
  it('rejects malformed wall-time evidence at the closed review boundary', () => {
    for (const evidence of [
      { localDateTime: 'tomorrow', offset: '-04:00', timeZone: 'America/New_York' },
      { localDateTime: '2026-02-30T09:00', offset: '-04:00', timeZone: 'America/New_York' },
      { localDateTime: '2026-10-13T09:00Z', offset: '-04:00', timeZone: 'America/New_York' },
      { localDateTime: '2026-10-13T09:00', offset: '+99:99', timeZone: 'America/New_York' },
    ]) expect(schedulingMutationReviewSchema.safeParse({ ...review, startWallTime: evidence }).success).toBe(false);
  });
  it('requires paired policy and target version tokens', () => {
    expect(schedulingReviewContextSchema.safeParse({ ...context, policyRevision: 0, policyDigest: null }).success).toBe(true);
    expect(schedulingReviewContextSchema.safeParse({ ...context, policyRevision: 0 }).success).toBe(false);
    expect(schedulingReviewContextSchema.safeParse({ ...context, targetVersion: instant }).success).toBe(false);
    expect(schedulingReviewContextSchema.safeParse({ ...context, targetVersion: instant, targetFingerprint: digest }).success).toBe(true);
  });
  it.each([
    { kind: 'appointment_create', body: { scheduledStart: instant } },
    { kind: 'project_create', body: { leadId: id, name: 'Job' } },
  ])('rejects existing-target edit tokens in a $kind command', ({ kind, body }) => {
    const command = { operationId: id, kind, body, review };
    expect(manualSchedulingCommandSchema.safeParse(command).success).toBe(true);
    const editReview = { ...review, context: { ...context, targetVersion: instant, targetFingerprint: digest } };
    expect(manualSchedulingCommandSchema.safeParse({ ...command, review: editReview }).success).toBe(false);
  });
  it('pins native enums and refuses client snapshot or actor metadata in commands', () => {
    const command = { operationId: id, kind: 'appointment_create', body: { scheduledStart: instant, propertyId: null }, review };
    expect(manualSchedulingCommandSchema.safeParse(command).success).toBe(true);
    for (const status of ['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show']) expect(manualSchedulingCommandSchema.safeParse({ ...command, body: { ...command.body, status } }).success).toBe(true);
    for (const type of ['inspection', 'estimate_review', 'production', 'final_walkthrough', 'other']) expect(manualSchedulingCommandSchema.safeParse({ ...command, body: { ...command.body, type } }).success).toBe(true);
    for (const body of [{ ...command.body, status: 'on_hold' }, { ...command.body, schedulingReservation: snapshot }, { ...command.body, actorUserId: 'staff_1' }, { ...command.body, review }]) expect(manualSchedulingCommandSchema.safeParse({ ...command, body }).success).toBe(false);
    expect(manualSchedulingCommandSchema.safeParse({ operationId: id, kind: 'project_create', review, body: { leadId: id, name: 'Job', status: 'on_hold' } }).success).toBe(true);
    expect(manualSchedulingCommandSchema.safeParse({ operationId: id, kind: 'project_create', review, body: { name: 'Job' } }).success).toBe(false);
  });
  it('validates terminal ack outcomes without inventing a no-commit target', () => {
    const ack = { operationId: id, organizationId: id, actorUserId: 'staff_1', kind: 'appointment_create', source, payloadSha256: digest, outcome: 'committed', target: { kind: 'appointment', id, available: false }, refusalCode: null };
    expect(manualSchedulingAckSchema.safeParse(ack).success).toBe(true);
    expect(manualSchedulingAckSchema.safeParse({ ...ack, extra: true }).success).toBe(false);
    expect(manualSchedulingAckSchema.safeParse({ ...ack, target: null }).success).toBe(false);
    expect(manualSchedulingAckSchema.safeParse({ ...ack, outcome: 'no_commit_refused', target: null, refusalCode: 'stale_review' }).success).toBe(true);
    expect(manualSchedulingAckSchema.safeParse({ ...ack, outcome: 'no_commit_refused', refusalCode: null }).success).toBe(false);
  });
});
