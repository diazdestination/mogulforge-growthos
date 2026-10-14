import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { canonicalSchedulingEnvelope, type SchedulingMutationReview } from './index';

const id = '11111111-1111-4111-8111-111111111111';
const review: SchedulingMutationReview = { context: { organizationId: id, policyRevision: 0, policyDigest: null, companyTimeZone: 'UTC', inspection: null, applicableRules: { newTravelGapMinutes: 0, companyCeiling: null, inspectionCeiling: null }, source: { sourceKind: 'unlinked_manual', leadId: null, contactId: null, propertyId: null, estimateId: null }, targetVersion: null, targetFingerprint: null }, duration: { kind: 'explicit', preset: null }, startWallTime: null, endWallTime: null };
const args = { organizationId: id, actorUserId: 'staff_é', kind: 'appointment_create' as const, body: { scheduledStart: '2026-10-13T09:00:00.000Z', notes: 'Visit 🛠' }, review };

it('sorts envelope and nested object keys with exact UTF8 values', () => {
  const expected = '{"actorUserId":"staff_é","body":{"notes":"Visit 🛠","scheduledStart":"2026-10-13T09:00:00.000Z"},"kind":"appointment_create","organizationId":"11111111-1111-4111-8111-111111111111","review":{"context":{"applicableRules":{"companyCeiling":null,"inspectionCeiling":null,"newTravelGapMinutes":0},"companyTimeZone":"UTC","inspection":null,"organizationId":"11111111-1111-4111-8111-111111111111","policyDigest":null,"policyRevision":0,"source":{"contactId":null,"estimateId":null,"leadId":null,"propertyId":null,"sourceKind":"unlinked_manual"},"targetFingerprint":null,"targetVersion":null},"duration":{"kind":"explicit","preset":null},"endWallTime":null,"startWallTime":null}}';
  expect(canonicalSchedulingEnvelope(args)).toBe(expected);
  expect(createHash('sha256').update(new TextEncoder().encode(canonicalSchedulingEnvelope(args))).digest('hex')).toBe('9a0e21a763dfee9372a40768d5639c3ab249bedfdb11c9638da1d2c60f946274');
});
it('ignores object insertion order but preserves array order', () => {
  expect(canonicalSchedulingEnvelope({ review, body: { notes: 'Visit 🛠', scheduledStart: args.body.scheduledStart }, kind: args.kind, actorUserId: args.actorUserId, organizationId: id })).toBe(canonicalSchedulingEnvelope(args));
  const job = { ...args, kind: 'project_create' as const, body: { leadId: id, name: 'Job', crewUserIds: ['a', 'b'] } };
  expect(canonicalSchedulingEnvelope(job)).not.toBe(canonicalSchedulingEnvelope({ ...job, body: { ...job.body, crewUserIds: ['b', 'a'] } }));
});
it('preserves omitted versus null without expanding defaults or refreshing review', () => {
  expect(canonicalSchedulingEnvelope(args)).not.toBe(canonicalSchedulingEnvelope({ ...args, body: { ...args.body, propertyId: null } }));
  expect(canonicalSchedulingEnvelope(args)).not.toBe(canonicalSchedulingEnvelope({ ...args, review: { ...review, context: { ...review.context, companyTimeZone: 'America/New_York' } } }));
  expect(canonicalSchedulingEnvelope(args)).not.toContain('"status"');
});
it('refuses invalid or extra envelope/body fields before canonicalization', () => {
  expect(() => canonicalSchedulingEnvelope({ ...args, body: { ...args.body, actorUserId: 'forged' } } as typeof args)).toThrow();
  expect(() => canonicalSchedulingEnvelope({ ...args, body: { ...args.body, scheduledStart: 'invalid' } })).toThrow();
  expect(() => canonicalSchedulingEnvelope({ ...args, extra: true } as typeof args)).toThrow();
});
