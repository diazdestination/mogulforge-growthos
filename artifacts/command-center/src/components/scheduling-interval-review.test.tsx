import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithQuery } from '@/test/render';
import { SchedulingIntervalReview } from './scheduling-interval-review';
import type { SchedulingTravelReviewProps } from '@/lib/scheduling-ui-contract';
import { makeSchedulingInterval, makeSchedulingProposal, makeSchedulingResources, makeReservationSnapshot } from '@/test/scheduling-ui-fixtures';
afterEach(cleanup);
function props(overrides: Partial<SchedulingTravelReviewProps> = {}): SchedulingTravelReviewProps { return { companyTimeZone: 'America/Los_Angeles', interval: makeSchedulingInterval({ reservation: null, evidence: 'legacy' }), proposal: makeSchedulingProposal(), resources: makeSchedulingResources(), conflict: null, ...overrides }; }
function text() { return screen.getByRole('region', { name: 'Interval and travel review' }).textContent!; }
describe('authoritative interval and travel review', () => {
  it('shows a new NULL-snapshot proposal with separate travel and capacity gates', () => {
    renderWithQuery(<SchedulingIntervalReview {...props()} />);
    expect(text()).toContain('Travel gap: 60 minutes');
    expect(text()).toContain('Company capacity: 3');
    expect(text()).toContain('Inspection capacity: 2');
    expect(screen.getAllByText('Rechecked when saving').length).toBe(2);
    expect(text()).toContain('09:00'); expect(text()).toContain('10:30');
    expect(text()).toContain('Unassigned');
    expect(text()).toContain('does not establish availability');
  });
  it('does not invent legacy history for a new proposal with no stored interval', () => {
    renderWithQuery(<SchedulingIntervalReview {...props({ interval: makeSchedulingInterval({ startAt: null, endAt: null, legacyEffectiveEnd: null, reservation: null, evidence: 'legacy' }) })} />);
    expect(text()).toContain('Travel gap: 60 minutes');
    expect(text()).not.toContain('Legacy travel gap');
    expect(text()).not.toContain('Legacy effective end');
  });
  it('does not convert a partial-list available gate into final admission', () => {
    renderWithQuery(<SchedulingIntervalReview {...props({ proposal: makeSchedulingProposal({ companyGate: { kind: 'available', message: 'Available' }, inspectionGate: { kind: 'available', message: 'Available' } }) })} />);
    expect(screen.getAllByText('Rechecked when saving').length).toBe(2);
    expect(text()).not.toContain('Available');
  });
  it('keeps staff conflict separate and uses only the authorized adjacent reference', () => {
    renderWithQuery(<SchedulingIntervalReview {...props({ proposal: makeSchedulingProposal({ resourceUserIds: ['staff-synthetic'] }), conflict: { reservationKind: 'project', reservationId: '22222222-2222-4222-8222-222222222222', resourceLabel: 'Synthetic staff', startAt: '2035-01-01T19:00:00.000Z', endAt: '2035-01-01T20:00:00.000Z', reason: 'Required travel gap before adjacent work' } })} />);
    expect(screen.getByRole('alert').textContent).toContain('Staff resource conflict');
    expect(screen.getByRole('alert').textContent).toContain('Required travel gap');
    expect(text()).toContain('project 22222222-2222-4222-8222-222222222222');
    expect(text()).toContain('Company capacity: 3');
  });
  it('retains saved provenance when current travel policy decreases or disables', () => {
    renderWithQuery(<SchedulingIntervalReview {...props({ interval: makeSchedulingInterval(), proposal: makeSchedulingProposal({ basis: 'saved_preservation', appliedTravelGapMinutes: 60, companyCeiling: null, inspectionCeiling: null }) })} />);
    expect(text()).toContain('Saved protection preserved');
    expect(text()).toContain('Saved travel gap: 60 minutes');
    expect(text()).toContain('Synthetic visit');
    expect(text()).toContain('Source policy revision: 1');
    expect(text()).toContain('Company capacity: Recorded work retained');
  });
  it('renders current company offsets and retains the approved zone only as history', () => {
    renderWithQuery(<SchedulingIntervalReview {...props({ companyTimeZone: 'America/New_York', interval: makeSchedulingInterval({ reservation: makeReservationSnapshot() }) })} />);
    expect(text()).toContain('America/New_York'); expect(text()).toContain('12:00'); expect(text()).toContain('-05:00');
    expect(text()).toContain('Historical approved zone: America/Los_Angeles');
    expect(text()).toContain('Inspection rule time zone: America/New_York');
    expect(text()).toContain('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });
  it('displays exact seconds and milliseconds for the proposed service endpoints', () => {
    renderWithQuery(<SchedulingIntervalReview {...props({ proposal: makeSchedulingProposal({ startAt: '2035-01-01T17:00:00.123Z', endAt: '2035-01-01T18:30:40.456Z' }) })} />);
    expect(text()).toContain('09:00:00.123');
    expect(text()).toContain('10:30:40.456');
    expect(text()).toContain('-08:00');
  });
  it('shows legacy NULL end without filling storage or inventing travel', () => {
    renderWithQuery(<SchedulingIntervalReview {...props({ proposal: null, interval: makeSchedulingInterval({ endAt: null, legacyEffectiveEnd: '2035-01-01T19:00:00.000Z', reservation: null, evidence: 'legacy' }) })} />);
    expect(text()).toContain('Stored end: Empty'); expect(text()).toContain('Legacy effective end'); expect(text()).toContain('11:00');
    expect(text()).toContain('Legacy travel gap: 0 minutes');
    expect(text()).toContain('Review pending');
  });
  it('keeps legacy pending NULL-end assignment unknown even with a nonempty resource directory', () => {
    renderWithQuery(<SchedulingIntervalReview {...props({ proposal: null, interval: makeSchedulingInterval({ endAt: null, legacyEffectiveEnd: '2035-01-01T19:00:00.000Z', reservation: null, evidence: 'legacy' }), resources: makeSchedulingResources() })} />);
    expect(text()).toContain('Assigned resources: Unknown');
    expect(text()).toContain('Assignment and availability are unchecked');
    expect(text()).not.toContain('Unassigned');
    expect(text()).not.toContain('Synthetic staff');
    expect(text()).toContain('Stored end: Empty');
    expect(text()).toContain('Legacy effective end');
    expect(text()).toContain('Review pending');
  });
  it('retains Unassigned for an explicitly empty saved resource list with no proposal', () => {
    renderWithQuery(<SchedulingIntervalReview {...props({ proposal: null, interval: makeSchedulingInterval({ reservation: makeReservationSnapshot({ resourceUserIds: [] }) }) })} />);
    expect(text()).toContain('Assigned resources: Unassigned');
    expect(text()).toContain('does not establish availability');
    expect(text()).not.toContain('Assigned resources: Unknown');
    expect(text()).not.toContain('Synthetic staff');
  });
  it.each([null, 'America/Imaginary'])('holds display without a usable current zone %s', companyTimeZone => {
    renderWithQuery(<SchedulingIntervalReview {...props({ companyTimeZone })} />);
    expect(screen.getByRole('alert').textContent).toContain('Current company time zone');
    expect(text()).not.toContain('09:00');
  });
  it('holds invalid saved evidence instead of showing legacy compatibility', () => {
    renderWithQuery(<SchedulingIntervalReview {...props({ interval: makeSchedulingInterval({ evidence: 'invalid', reservation: null }) })} />);
    expect(screen.getByRole('alert').textContent).toContain('Saved scheduling evidence');
    expect(text()).not.toContain('Legacy travel gap: 0');
  });
  it('announces resource removal while retaining surviving saved protection', () => {
    renderWithQuery(<SchedulingIntervalReview {...props({ interval: makeSchedulingInterval(), proposal: makeSchedulingProposal({ basis: 'saved_release', resourceUserIds: [], appliedTravelGapMinutes: 60 }) })} />);
    expect(text()).toContain('Resource release'); expect(text()).toContain('Saved travel gap: 60');
  });
  it.each(['saved_preservation', 'saved_release'] as const)('renders %s null ceilings as retention without a new admission gate', basis => {
    renderWithQuery(<SchedulingIntervalReview {...props({ interval: makeSchedulingInterval(), proposal: makeSchedulingProposal({ basis, companyCeiling: null, inspectionCeiling: null, companyGate: { kind: 'held', message: 'Recorded work is retained; no new capacity admission is requested.' }, inspectionGate: { kind: 'held', message: 'Recorded work is retained; no new capacity admission is requested.' } }) })} />);
    expect(screen.getAllByText('Recorded work is retained; no new capacity admission is requested.').length).toBe(2);
    expect(text()).not.toContain('Not configured');
    expect(text()).not.toContain('Rechecked when saving');
    expect(text()).toContain('Saved travel gap: 60');
  });
});

it.each([
  ['2035-01-01T17:00:00.000Z', '2035-01-01T18:30:00.000Z', 90],
  ['2035-01-01T17:00:00.000Z', '2035-01-04T18:30:00.000Z', 4410],
  ['2035-03-11T09:30:00.000Z', '2035-03-11T10:30:00.000Z', 60],
  ['2035-11-04T08:30:00.000Z', '2035-11-04T10:30:00.000Z', 120],
])('shows exact elapsed minutes for manual UTC endpoints %s', (startAt, endAt, minutes) => {
  renderWithQuery(<SchedulingIntervalReview {...props({ interval: makeSchedulingInterval({ startAt: null, endAt: null, reservation: null, legacyEffectiveEnd: null, evidence: 'legacy' }), proposal: makeSchedulingProposal({ startAt, endAt }) })} />);
  expect(text()).toContain(`${minutes} elapsed minutes`);
});
