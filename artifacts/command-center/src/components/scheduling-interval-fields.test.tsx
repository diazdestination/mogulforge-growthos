import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithQuery } from '@/test/render';
import { SchedulingIntervalFields } from './scheduling-interval-fields';
import type { SchedulingIntervalFieldsProps, SchedulingMutationReview } from '@/lib/scheduling-ui-contract';
import { appointmentCommand } from '@/lib/scheduling-ui-contract.fixtures';
import { makeDurationPreset, makeSchedulingContext, makeSchedulingDraft, makeSchedulingInterval, makeSchedulingResources } from '@/test/scheduling-ui-fixtures';

afterEach(cleanup);
function props(overrides: Partial<SchedulingIntervalFieldsProps> = {}): SchedulingIntervalFieldsProps {
  return { context: makeSchedulingContext(), companyTimeZone: 'America/Los_Angeles', interval: makeSchedulingInterval(), draft: makeSchedulingDraft(), resources: makeSchedulingResources(), presets: [makeDurationPreset()], review: structuredClone(appointmentCommand.review), disabled: false, onDraftChange: () => {}, onReviewChange: () => {}, ...overrides };
}
function Harness({ value }: { value: SchedulingIntervalFieldsProps }) {
  const [draft, setDraft] = useState(value.draft);
  const [review, setReview] = useState<SchedulingMutationReview | null>(value.review);
  const [events, setEvents] = useState<string[]>([]);
  return <><SchedulingIntervalFields {...value} draft={draft} review={review} onDraftChange={next => { setEvents(events => [...events, 'draft']); setDraft(next); }} onReviewChange={next => { setEvents(events => [...events, next ? 'review' : 'invalidate']); setReview(next); }} /><output aria-label="Root draft">{JSON.stringify(draft)}</output><output aria-label="Root review">{JSON.stringify(review)}</output><output aria-label="Callback order">{JSON.stringify(events)}</output></>;
}
function state(name: string) { return JSON.parse(screen.getByLabelText(name).textContent!); }
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
function review() { fireEvent.click(screen.getByRole('button', { name: 'Review interval' })); }
function ContextHarness() {
  const [context, setContext] = useState(makeSchedulingContext());
  return <><Harness value={props({ context })} /><button onClick={() => setContext(makeSchedulingContext({ organizationId: '44444444-4444-4444-8444-444444444444' }))}>Switch context</button></>;
}

describe('controlled scheduling interval fields', () => {
  it('invalidates a valid review before publishing an invalid draft', () => {
    renderWithQuery(<Harness value={props()} />);
    change('Service end', '2035-01-01T08:00');
    expect(state('Callback order').slice(0, 2)).toEqual(['invalidate', 'draft']);
    expect(state('Root draft')).toEqual({ startAt: '2035-01-01T17:00:00.000Z', endAt: '2035-01-01T16:00:00.000Z', resourceUserIds: [] });
    expect(state('Root review')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('End must follow start');
  });
  it('does not infer a preset and applies only an explicit selected preset', () => {
    renderWithQuery(<Harness value={props()} />);
    expect((screen.getByLabelText('Duration preset') as HTMLSelectElement).value).toBe('');
    change('Duration preset', '33333333-3333-4333-8333-333333333333');
    expect(state('Root draft').endAt).toBe('2035-01-01T18:30:00.000Z');
    expect(state('Root review')).toBeNull();
    review();
    expect(state('Root review').duration).toEqual({ kind: 'preset', preset: { id: '33333333-3333-4333-8333-333333333333', label: 'Synthetic visit', elapsedMinutes: 90 } });
    expect(state('Callback order')).toEqual(['invalidate', 'draft', 'review']);
  });
  it('requires explicit preset choice again on remount without resource-bound choice evidence', () => {
    const value = props({ review: { ...structuredClone(appointmentCommand.review), duration: { kind: 'preset', preset: makeDurationPreset() } } });
    renderWithQuery(<Harness value={value} />);
    expect((screen.getByLabelText('Duration preset') as HTMLSelectElement).value).toBe('');
    expect(state('Callback order')).toEqual([]);
    review();
    expect(state('Root review').duration).toEqual({ kind: 'preserved_interval', preset: null });
  });
  it('preserves elapsed duration across a spring-forward start-only edit', () => {
    renderWithQuery(<Harness value={props({ context: makeSchedulingContext({ companyTimeZone: 'America/New_York' }), companyTimeZone: 'America/New_York', draft: makeSchedulingDraft({ startAt: '2026-03-07T06:30:00.000Z', endAt: '2026-03-07T09:30:00.000Z' }) })} />);
    change('Service start', '2026-03-08T01:30');
    expect(state('Root draft')).toEqual({ startAt: '2026-03-08T06:30:00.000Z', endAt: '2026-03-08T09:30:00.000Z', resourceUserIds: [] });
    expect((screen.getByLabelText('Service end') as HTMLInputElement).value).toBe('2026-03-08T05:30');
    review();
    expect(state('Root review').endWallTime.offset).toBe('-04:00');
  });
  it('rejects the New York spring gap without retaining approval', () => {
    renderWithQuery(<Harness value={props({ context: makeSchedulingContext({ companyTimeZone: 'America/New_York' }), companyTimeZone: 'America/New_York' })} />);
    change('Service start', '2026-03-08T02:30');
    expect(state('Root draft').startAt).toBeNull();
    expect(state('Root review')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('does not exist');
    expect((screen.getByRole('button', { name: 'Review interval' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it.each([['2026-11-01T05:30:00.000Z', '-04:00', '2026-11-01T07:00:00.000Z'], ['2026-11-01T06:30:00.000Z', '-05:00', '2026-11-01T08:00:00.000Z']])('requires the explicit fold occurrence %s', (instant, offset, end) => {
    renderWithQuery(<Harness value={props({ context: makeSchedulingContext({ companyTimeZone: 'America/New_York' }), companyTimeZone: 'America/New_York' })} />);
    change('Service start', '2026-11-01T01:30');
    expect(state('Root review')).toBeNull();
    expect(state('Root draft').startAt).toBeNull();
    change('Service start occurrence', instant);
    expect(state('Root draft').startAt).toBe(instant);
    expect(state('Root draft').endAt).toBe(end);
    review();
    expect(state('Root review').startWallTime.offset).toBe(offset);
  });
  it('holds an ambiguous end until its occurrence is selected', () => {
    renderWithQuery(<Harness value={props({ context: makeSchedulingContext({ companyTimeZone: 'America/New_York' }), companyTimeZone: 'America/New_York', draft: makeSchedulingDraft({ startAt: '2026-11-01T04:30:00.000Z', endAt: '2026-11-01T07:00:00.000Z' }) })} />);
    change('Service end', '2026-11-01T01:30');
    expect(state('Root review')).toBeNull();
    change('Service end occurrence', '2026-11-01T06:30:00.000Z');
    expect(state('Root draft').endAt).toBe('2026-11-01T06:30:00.000Z');
    review();
    expect(state('Root review').endWallTime.offset).toBe('-05:00');
  });
  it('retains legacy NULL end during unrelated resource changes and unchanged review', () => {
    const legacy = makeSchedulingInterval({ endAt: null, reservation: null, evidence: 'legacy', legacyEffectiveEnd: '2035-01-01T19:00:00.000Z' });
    renderWithQuery(<Harness value={props({ interval: legacy, draft: makeSchedulingDraft({ endAt: null }), review: null })} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Synthetic staff' }));
    expect(state('Root draft')).toEqual({ startAt: '2035-01-01T17:00:00.000Z', endAt: null, resourceUserIds: ['staff-synthetic'] });
    review();
    expect(state('Root review').duration).toEqual({ kind: 'preserved_interval', preset: null });
    expect(state('Root review').endWallTime).toBeNull();
    expect(screen.getByText(/Legacy stored end remains empty/)).toBeTruthy();
  });
  it('supports a manually entered multiday interval', () => {
    renderWithQuery(<Harness value={props()} />);
    change('Service end', '2035-01-04T09:00');
    expect(state('Root draft').endAt).toBe('2035-01-04T17:00:00.000Z');
    review();
    expect(state('Root review').duration).toEqual({ kind: 'explicit', preset: null });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Second synthetic staff' }));
    expect(state('Root draft').endAt).toBe('2035-01-04T17:00:00.000Z');
  });
  it('preserves exact endpoint spelling and unknown assigned resources on an unrelated edit', () => {
    renderWithQuery(<Harness value={props({ draft: makeSchedulingDraft({ startAt: '2035-01-01T09:00:00-08:00', endAt: '2035-01-01T10:30:00-08:00', resourceUserIds: ['staff-unlisted'] }) })} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Synthetic staff' }));
    expect(state('Root draft')).toEqual({ startAt: '2035-01-01T09:00:00-08:00', endAt: '2035-01-01T10:30:00-08:00', resourceUserIds: ['staff-unlisted', 'staff-synthetic'] });
  });
  it('retains exact wire endpoints when a start edit resolves to the same instant', () => {
    renderWithQuery(<Harness value={props({ draft: makeSchedulingDraft({ startAt: '2035-01-01T09:00:00-08:00', endAt: '2035-01-04T09:00:40.456-08:00' }) })} />);
    change('Service start', '');
    change('Service start', '2035-01-01T09:00');
    expect(state('Root draft')).toEqual({ startAt: '2035-01-01T09:00:00-08:00', endAt: '2035-01-04T09:00:40.456-08:00', resourceUserIds: [] });
    review();
    expect(state('Root review')).not.toBeNull();
  });
  it.each([{ context: null }, { companyTimeZone: null }, { companyTimeZone: 'America/New_York' }, { disabled: true }])('holds unavailable or mismatched authority %#', overrides => {
    renderWithQuery(<Harness value={props(overrides)} />);
    expect((screen.getByLabelText('Service start') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Review interval' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows current company offsets and the independent inspection zone and digest', () => {
    renderWithQuery(<Harness value={props()} />);
    expect((screen.getByLabelText('Service start') as HTMLInputElement).value).toBe('2035-01-01T09:00');
    expect(screen.getByText(/Company time zone: America\/Los_Angeles/).textContent).toContain('-08:00');
    expect(screen.getByText(/Inspection rule time zone: America\/New_York/)).toBeTruthy();
    expect(screen.getByText(/Inspection availability digest/).textContent).toContain('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });
  it('clears local preset and invalid wall input when context changes', () => {
    renderWithQuery(<ContextHarness />);
    change('Duration preset', '33333333-3333-4333-8333-333333333333');
    change('Service end', '');
    fireEvent.click(screen.getByRole('button', { name: 'Switch context' }));
    expect((screen.getByLabelText('Duration preset') as HTMLSelectElement).value).toBe('');
    expect(state('Root review')).toBeNull();
  });
  it('preserves a three-day elapsed interval on a start-only edit', () => {
    renderWithQuery(<Harness value={props({ draft: makeSchedulingDraft({ startAt: '2026-03-06T14:00:00.000Z', endAt: '2026-03-09T14:00:00.000Z' }), companyTimeZone: 'America/New_York', context: makeSchedulingContext({ companyTimeZone: 'America/New_York' }) })} />);
    change('Service start', '2026-03-07T09:00');
    expect(state('Root draft').endAt).toBe('2026-03-10T14:00:00.000Z');
    review();
    expect(state('Root review').duration.kind).toBe('preserved_interval');
  });
  it('preserves seconds and milliseconds in an elapsed interval', () => {
    renderWithQuery(<Harness value={props({ draft: makeSchedulingDraft({ startAt: '2035-01-01T17:00:00.123Z', endAt: '2035-01-01T18:30:40.456Z' }) })} />);
    change('Service start', '2035-01-02T09:00:00.123');
    expect(state('Root draft').endAt).toBe('2035-01-02T18:30:40.456Z');
    review();
    expect(state('Root review')).not.toBeNull();
  });
  it('preserves elapsed duration after an intermediate nonexistent start is corrected', () => {
    renderWithQuery(<Harness value={props({ companyTimeZone: 'America/New_York', context: makeSchedulingContext({ companyTimeZone: 'America/New_York' }) })} />);
    change('Service start', '2026-03-08T02:30');
    change('Service start', '2026-03-08T03:30');
    expect(state('Root draft').endAt).toBe('2026-03-08T09:00:00.000Z');
    review();
    expect(state('Root review')).not.toBeNull();
  });
  it('does not emit a next-draft review before the controlled draft returns', () => {
    const events: string[] = [];
    const value = props({ onDraftChange: () => events.push('draft'), onReviewChange: next => events.push(next ? 'review' : 'invalidate') });
    renderWithQuery(<SchedulingIntervalFields {...value} />);
    change('Service end', '2035-01-01T11:00');
    expect(events).toEqual(['invalidate', 'draft']);
  });
  it('holds explicit review until the controlled resource draft returns', () => {
    const events: string[] = [];
    renderWithQuery(<SchedulingIntervalFields {...props({ onDraftChange: () => events.push('draft'), onReviewChange: next => events.push(next ? 'review' : 'invalidate') })} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Synthetic staff' }));
    const control = screen.getByRole('button', { name: 'Review interval' }) as HTMLButtonElement;
    expect(control.disabled).toBe(true);
    fireEvent.click(control);
    expect(events).toEqual(['invalidate', 'draft']);
  });
  it('applies an explicitly selected preset after an unresolved start is corrected', () => {
    renderWithQuery(<Harness value={props({ companyTimeZone: 'America/New_York', context: makeSchedulingContext({ companyTimeZone: 'America/New_York' }), presets: [makeDurationPreset({ elapsedMinutes: 60 })] })} />);
    change('Service start', '2026-03-08T02:30');
    change('Duration preset', '33333333-3333-4333-8333-333333333333');
    change('Service start', '2026-03-08T03:30');
    expect(state('Root draft').endAt).toBe('2026-03-08T08:30:00.000Z');
    review();
    expect(state('Root review').duration.preset.elapsedMinutes).toBe(60);
  });
  it('allows keyboard focus on explicit review and records the latest assigned resource', () => {
    renderWithQuery(<Harness value={props()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Synthetic staff' }));
    expect(state('Root review')).toBeNull();
    const control = screen.getByRole('button', { name: 'Review interval' });
    control.focus();
    expect(document.activeElement).toBe(control);
    fireEvent.click(control);
    expect(state('Root draft').resourceUserIds).toEqual(['staff-synthetic']);
    expect(state('Root review').context.companyTimeZone).toBe('America/Los_Angeles');
    expect(state('Callback order')).toEqual(['invalidate', 'draft', 'review']);
  });
  it('holds invalid saved evidence with a recovery reason', () => {
    renderWithQuery(<Harness value={props({ interval: makeSchedulingInterval({ evidence: 'invalid', reservation: null }) })} />);
    expect(screen.getByRole('alert').textContent).toContain('Saved scheduling evidence');
    expect((screen.getByRole('button', { name: 'Review interval' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('preserves a legacy NULL end during a start-only edit', () => {
    renderWithQuery(<Harness value={props({ interval: makeSchedulingInterval({ endAt: null, reservation: null, evidence: 'legacy', legacyEffectiveEnd: '2035-01-01T19:00:00.000Z' }), draft: makeSchedulingDraft({ endAt: null }), review: null })} />);
    change('Service start', '2035-01-02T09:00');
    expect(state('Root draft')).toEqual({ startAt: '2035-01-02T17:00:00.000Z', endAt: null, resourceUserIds: [] });
    review();
    expect(state('Root review').endWallTime).toBeNull();
  });
  it('retains legacy compatibility duration across repeated start-only edits', () => {
    renderWithQuery(<Harness value={props({ interval: makeSchedulingInterval({ endAt: null, reservation: null, evidence: 'legacy', legacyEffectiveEnd: '2035-01-01T19:00:00.000Z' }), draft: makeSchedulingDraft({ endAt: null }), review: null })} />);
    change('Service start', '2035-01-02T09:00');
    change('Service start', '2035-01-03T09:00');
    expect((screen.getByRole('button', { name: 'Review interval' }) as HTMLButtonElement).disabled).toBe(false);
    review();
    expect(state('Root draft').endAt).toBeNull();
    expect(state('Root review').endWallTime).toBeNull();
  });
  it('rejects an end inside the spring gap while preserving its visible wall input', () => {
    renderWithQuery(<Harness value={props({ companyTimeZone: 'America/New_York', context: makeSchedulingContext({ companyTimeZone: 'America/New_York' }), draft: makeSchedulingDraft({ startAt: '2026-03-08T06:30:00.000Z', endAt: '2026-03-08T09:30:00.000Z' }) })} />);
    change('Service end', '2026-03-08T02:30');
    expect(state('Root draft').endAt).toBeNull();
    expect((screen.getByLabelText('Service end') as HTMLInputElement).value).toBe('2026-03-08T02:30');
    expect(state('Root review')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('does not exist');
  });
});
