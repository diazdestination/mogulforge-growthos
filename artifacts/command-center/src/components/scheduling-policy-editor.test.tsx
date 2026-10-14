import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SchedulingPolicyEditor } from './scheduling-policy-editor';
import type { PolicySaveInput, PolicySaveResult, PolicyViewState, SchedulingPolicyPanelProps } from '@/lib/scheduling-ui-contract';
import { makeDurationPreset, makePolicyDraft, makePolicyReadResult, makePolicyViewState, makeSchedulingContext, makeSchedulingScope, schedulingFixtureIds } from '@/test/scheduling-ui-fixtures';

// Radix Switch measures its hidden input; jsdom has no layout observer.
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const saveButton = () => screen.getByRole('button', { name: 'Save scheduling settings' }) as HTMLButtonElement;
const input = (name: string) => screen.getByRole('spinbutton', { name }) as HTMLInputElement;
function props(overrides: Partial<SchedulingPolicyPanelProps> = {}): SchedulingPolicyPanelProps {
  return { state: makePolicyViewState(), draft: makePolicyDraft(), canManage: true, onDraftChange: vi.fn(), onSave: vi.fn(async () => ({ kind: 'saved', value: makePolicyReadResult() })), onRefresh: vi.fn(), ...overrides };
}
function Controlled({ initial = makePolicyDraft(), ...overrides }: Partial<SchedulingPolicyPanelProps> & { initial?: PolicySaveInput }) {
  const [draft, setDraft] = useState(initial);
  return <SchedulingPolicyEditor {...props(overrides)} draft={draft} onDraftChange={setDraft} />;
}
function deferred() {
  let resolve!: (result: PolicySaveResult) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<PolicySaveResult>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('scheduling policy authority and controlled draft', () => {
  it('disables saving and editing for a reader while retaining the root draft', () => {
    const onSave = vi.fn(); render(<SchedulingPolicyEditor {...props({ canManage: false, draft: makePolicyDraft({ minimumTravelGapMinutes: 125 }), onSave })} />);
    expect(saveButton().disabled).toBe(true);
    expect(input('Minimum travel gap (minutes)').value).toBe('125');
    expect(input('Minimum travel gap (minutes)').disabled).toBe(true);
    fireEvent.click(saveButton()); expect(onSave).not.toHaveBeenCalled();
  });
  it.each(['loading', 'read_error', 'invalid', 'saving', 'stale', 'unknown'] as const)('holds %s without dispatching or replacing the root draft', (kind) => {
    const draft = makePolicyDraft({ minimumTravelGapMinutes: 125 });
    const state: PolicyViewState = kind === 'loading' ? { kind, scope: makeSchedulingScope() }
      : kind === 'read_error' || kind === 'invalid' ? { kind, scope: makeSchedulingScope(), message: 'Synthetic policy hold' }
      : { kind, scope: makeSchedulingScope(), value: makePolicyReadResult(), draft, message: 'Synthetic policy hold' };
    const onSave = vi.fn(); const onDraftChange = vi.fn(); render(<SchedulingPolicyEditor {...props({ state, draft, onSave, onDraftChange })} />);
    expect(saveButton().disabled).toBe(true);
    expect(input('Minimum travel gap (minutes)').value).toBe('125');
    if (kind !== 'loading') expect(screen.getByText('Synthetic policy hold')).toBeTruthy();
    fireEvent.click(saveButton()); expect(onSave).not.toHaveBeenCalled(); expect(onDraftChange).not.toHaveBeenCalled();
  });
  it('allows explicit first save at revision zero without inventing company defaults', async () => {
    const value = makePolicyReadResult({ policy: null, context: makeSchedulingContext({ policyRevision: 0, policyDigest: null, inspection: null, source: null, applicableRules: { newTravelGapMinutes: 0, companyCeiling: null, inspectionCeiling: null } }) });
    const onSave = vi.fn(async () => ({ kind: 'unknown' as const, message: 'Synthetic uncertain result' }));
    render(<SchedulingPolicyEditor {...props({ state: makePolicyViewState(value), draft: makePolicyDraft({ expectedRevision: 0, durationPresets: [], minimumTravelGapMinutes: 0, maxConcurrentReservations: null }), onSave })} />);
    expect(screen.getByText(/Not configured/)).toBeTruthy(); expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    expect(onSave).toHaveBeenCalledWith({ expectedRevision: 0, expectedCompanyTimeZone: 'America/Los_Angeles', enabled: true, minimumTravelGapMinutes: 0, maxConcurrentReservations: null, durationPresets: [] });
    await screen.findByText('Synthetic uncertain result');
  });
  it('shows confirmed policy revision and current company zone separately from edits', () => {
    render(<SchedulingPolicyEditor {...props({ draft: makePolicyDraft({ enabled: false, minimumTravelGapMinutes: 10 }) })} />);
    expect(screen.getByText(/Saved policy: enabled/)).toBeTruthy();
    expect(screen.getByText(/Revision 1/)).toBeTruthy(); expect(screen.getByText(/Company time zone: America\/Los_Angeles/)).toBeTruthy();
    expect(input('Minimum travel gap (minutes)').value).toBe('10');
    expect(screen.getByText(/Disabling retains/)).toBeTruthy();
  });
  it('changes only the controlled field and retains revision, zone and saved preset IDs', () => {
    const onDraftChange = vi.fn(); const draft = makePolicyDraft(); render(<SchedulingPolicyEditor {...props({ draft, onDraftChange })} />);
    fireEvent.change(input('Minimum travel gap (minutes)'), { target: { value: '45' } });
    expect(onDraftChange).toHaveBeenCalledWith({ expectedRevision: 1, expectedCompanyTimeZone: 'America/Los_Angeles', enabled: true, minimumTravelGapMinutes: 45, maxConcurrentReservations: 3, durationPresets: [{ id: '33333333-3333-4333-8333-333333333333', label: 'Synthetic visit', elapsedMinutes: 90 }] });
    expect(input('Minimum travel gap (minutes)').value).toBe('60'); expect(draft.minimumTravelGapMinutes).toBe(60);
  });
  it('adds an explicit blank new preset with null ID and preserves retained IDs through editing/removal', () => {
    render(<Controlled />); fireEvent.click(screen.getByRole('button', { name: 'Add duration preset' }));
    expect((screen.getByRole('textbox', { name: 'Preset 2 label' }) as HTMLInputElement).value).toBe(''); expect(saveButton().disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Preset 2 label' }), { target: { value: 'Second explicit visit' } });
    fireEvent.change(input('Preset 2 elapsed minutes'), { target: { value: '120' } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Remove preset 1' }));
    expect((screen.getByRole('textbox', { name: 'Preset 1 label' }) as HTMLInputElement).value).toBe('Second explicit visit');
  });
  it('submits retained and null new IDs without mutating the source policy or allocating client IDs', async () => {
    const onSave = vi.fn(async () => ({ kind: 'refused' as const, message: 'Synthetic refusal' })); render(<Controlled onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add duration preset' })); fireEvent.change(screen.getByRole('textbox', { name: 'Preset 2 label' }), { target: { value: 'Second explicit visit' } }); fireEvent.change(input('Preset 2 elapsed minutes'), { target: { value: '120' } });
    fireEvent.click(saveButton()); expect(onSave.mock.calls[0]?.[0]).toMatchObject({ durationPresets: [{ id: '33333333-3333-4333-8333-333333333333', label: 'Synthetic visit', elapsedMinutes: 90 }, { id: null, label: 'Second explicit visit', elapsedMinutes: 120 }] });
    await screen.findByText('Synthetic refusal');
  });
  it('represents no company ceiling explicitly as null while preserving a zero travel gap', async () => {
    const onSave = vi.fn(async () => ({ kind: 'refused' as const, message: 'Synthetic refusal' })); render(<Controlled onSave={onSave} />);
    fireEvent.change(input('Company concurrent reservation limit'), { target: { value: '' } }); fireEvent.change(input('Minimum travel gap (minutes)'), { target: { value: '0' } });
    fireEvent.click(saveButton()); expect(onSave.mock.calls[0]?.[0]).toMatchObject({ minimumTravelGapMinutes: 0, maxConcurrentReservations: null }); await screen.findByText('Synthetic refusal');
  });
});

describe('closed policy validation before dispatch', () => {
  it.each([
    { minimumTravelGapMinutes: -1 }, { minimumTravelGapMinutes: 1441 }, { minimumTravelGapMinutes: 0.5 },
    { maxConcurrentReservations: 0 }, { maxConcurrentReservations: 101 }, { maxConcurrentReservations: 1.5 },
    { durationPresets: [makeDurationPreset({ label: ' ' })] }, { durationPresets: [makeDurationPreset({ label: 'x'.repeat(81) })] },
    { durationPresets: [makeDurationPreset({ elapsedMinutes: 0 })] }, { durationPresets: [makeDurationPreset({ elapsedMinutes: 1441 })] },
    { durationPresets: [makeDurationPreset({ elapsedMinutes: 1.5 })] },
    { durationPresets: [makeDurationPreset(), makeDurationPreset({ label: 'Other' })] },
    { durationPresets: [makeDurationPreset(), makeDurationPreset({ id: '55555555-5555-4555-8555-555555555555', label: ' Synthetic visit ' })] },
    { durationPresets: Array.from({ length: 51 }, (_, index) => ({ id: null, label: `Preset ${index}`, elapsedMinutes: 1 })) },
  ])('holds invalid draft %j and preserves it for correction', (patch) => {
    const onSave = vi.fn(); render(<SchedulingPolicyEditor {...props({ draft: makePolicyDraft(patch), onSave })} />);
    expect(saveButton().disabled).toBe(true); expect(screen.getByRole('alert')).toBeTruthy(); fireEvent.click(saveButton()); expect(onSave).not.toHaveBeenCalled();
  });
  it.each([{ expectedRevision: 0 }, { expectedCompanyTimeZone: 'America/New_York' }, { durationPresets: [makeDurationPreset({ id: '55555555-5555-4555-8555-555555555555' })] }])('holds stale or foreign draft context %j', (patch) => {
    const onSave = vi.fn(); render(<SchedulingPolicyEditor {...props({ draft: makePolicyDraft(patch), onSave })} />); expect(saveButton().disabled).toBe(true); fireEvent.click(saveButton()); expect(onSave).not.toHaveBeenCalled();
  });
  it('does not convert an empty required gap or duration into a valid zero/default', () => {
    render(<Controlled />); fireEvent.change(input('Minimum travel gap (minutes)'), { target: { value: '' } }); expect(saveButton().disabled).toBe(true);
    fireEvent.change(input('Minimum travel gap (minutes)'), { target: { value: '0' } }); expect(saveButton().disabled).toBe(false);
    fireEvent.change(input('Preset 1 elapsed minutes'), { target: { value: '' } }); expect(saveButton().disabled).toBe(true);
  });
  it('accepts inclusive upper bounds and submits disable without dropping the saved envelope', async () => {
    const onSave = vi.fn(async () => ({ kind: 'refused' as const, message: 'Synthetic refusal' })); render(<Controlled initial={makePolicyDraft({ minimumTravelGapMinutes: 1440, maxConcurrentReservations: 100, durationPresets: [makeDurationPreset({ elapsedMinutes: 1440 })] })} onSave={onSave} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Enable scheduling policy' })); expect(saveButton().disabled).toBe(false); fireEvent.click(saveButton());
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: 1, enabled: false, minimumTravelGapMinutes: 1440, maxConcurrentReservations: 100, durationPresets: [{ id: '33333333-3333-4333-8333-333333333333', label: 'Synthetic visit', elapsedMinutes: 1440 }] }); await screen.findByText('Synthetic refusal');
  });
});

describe('explicit dispatch custody', () => {
  it('keeps duplicate dispatch fenced when the parent clones unchanged authority during a pending save', async () => {
    const pending = deferred(); const onSave = vi.fn(() => pending.promise); const view = render(<SchedulingPolicyEditor {...props({ onSave })} />); fireEvent.click(saveButton());
    view.rerender(<SchedulingPolicyEditor {...props({ onSave })} />);
    expect(saveButton().disabled).toBe(true); fireEvent.click(saveButton()); expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ kind: 'unknown', message: 'Pending save unknown' })); expect(saveButton().disabled).toBe(true);
  });
  it('releases a settled hold only after explicit refresh receives authoritative props', async () => {
    const onSave = vi.fn(async () => ({ kind: 'refused' as const, message: 'Synthetic refusal' })); const onRefresh = vi.fn(); const view = render(<SchedulingPolicyEditor {...props({ onSave, onRefresh })} />); fireEvent.click(saveButton()); await screen.findByText('Synthetic refusal');
    view.rerender(<SchedulingPolicyEditor {...props({ onSave, onRefresh })} />); expect(saveButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh scheduling settings' })); expect(saveButton().disabled).toBe(true);
    view.rerender(<SchedulingPolicyEditor {...props({ onSave, onRefresh })} />); expect(saveButton().disabled).toBe(false);
  });
  it('synchronously blocks duplicate dispatch and never claims saved settings from a callback alone', async () => {
    const pending = deferred(); const onSave = vi.fn(() => pending.promise); const draft = makePolicyDraft({ minimumTravelGapMinutes: 15 }); const view = render(<SchedulingPolicyEditor {...props({ draft, onSave })} />);
    fireEvent.click(saveButton()); fireEvent.click(saveButton()); expect(onSave).toHaveBeenCalledTimes(1); expect(saveButton().disabled).toBe(true); expect(input('Minimum travel gap (minutes)').disabled).toBe(true);
    const updated = makePolicyReadResult(); updated.policy!.revision = 2; updated.policy!.minimumTravelGapMinutes = 15; updated.context.policyRevision = 2;
    await act(async () => pending.resolve({ kind: 'saved', value: updated }));
    expect(screen.getByText(/Revision 1/)).toBeTruthy(); expect(screen.queryByText(/Revision 2/)).toBeNull(); expect(saveButton().disabled).toBe(true);
    view.rerender(<SchedulingPolicyEditor {...props({ state: makePolicyViewState(updated), draft: makePolicyDraft({ expectedRevision: 2, minimumTravelGapMinutes: 15 }), onSave })} />);
    expect(screen.getByText(/Revision 2/)).toBeTruthy(); expect(saveButton().disabled).toBe(false);
  });
  it.each(['stale', 'unknown', 'refused'] as const)('retains the exact draft after a %s result and waits for an explicit refresh', async (kind) => {
    const onRefresh = vi.fn(); const onSave = vi.fn(async () => ({ kind, message: 'Synthetic result hold' })); render(<SchedulingPolicyEditor {...props({ draft: makePolicyDraft({ minimumTravelGapMinutes: 125 }), onSave, onRefresh })} />);
    fireEvent.click(saveButton()); await screen.findByText('Synthetic result hold'); expect(saveButton().disabled).toBe(true); expect(input('Minimum travel gap (minutes)').value).toBe('125');
    fireEvent.click(saveButton()); expect(onSave).toHaveBeenCalledTimes(1); expect(onRefresh).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Refresh scheduling settings' })); expect(onRefresh).toHaveBeenCalledTimes(1); expect(saveButton().disabled).toBe(true);
  });
  it('holds rejected transport as unknown without automatic retry', async () => {
    const onSave = vi.fn(async () => { throw new Error('Synthetic transport loss'); }); render(<SchedulingPolicyEditor {...props({ onSave })} />); fireEvent.click(saveButton()); await screen.findByText(/Save outcome unknown/); expect(saveButton().disabled).toBe(true); fireEvent.click(saveButton()); expect(onSave).toHaveBeenCalledTimes(1);
  });
  it.each(['tenant', 'actor'] as const)('does not publish a late old-%s response or keep its local pending state', async (change) => {
    const pending = deferred(); const onSave = vi.fn(() => pending.promise); const view = render(<SchedulingPolicyEditor {...props({ draft: makePolicyDraft({ minimumTravelGapMinutes: 125 }), onSave })} />); fireEvent.click(saveButton());
    const scope = makeSchedulingScope(change === 'tenant' ? { organizationId: schedulingFixtureIds.alternateOrganization } : { actorUserId: 'other-synthetic-actor' });
    const value = makePolicyReadResult({ context: makeSchedulingContext({ organizationId: scope.organizationId, inspection: null, source: null }) });
    view.rerender(<SchedulingPolicyEditor {...props({ state: { kind: 'loaded', scope, value }, draft: makePolicyDraft({ minimumTravelGapMinutes: 30 }) })} />);
    expect(input('Minimum travel gap (minutes)').value).toBe('30'); expect(saveButton().disabled).toBe(false);
    await act(async () => pending.resolve({ kind: 'unknown', message: 'Old scope unknown' })); expect(screen.queryByText('Old scope unknown')).toBeNull(); expect(input('Minimum travel gap (minutes)').value).toBe('30');
  });
  it('holds missing root draft and hides mismatched organization evidence without dispatch', () => {
    const view = render(<SchedulingPolicyEditor {...props({ draft: null })} />); expect(saveButton().disabled).toBe(true);
    view.rerender(<SchedulingPolicyEditor {...props({ state: { kind: 'loaded', scope: makeSchedulingScope({ organizationId: schedulingFixtureIds.alternateOrganization }), value: makePolicyReadResult() } })} />); expect(saveButton().disabled).toBe(true);
    expect(screen.queryByText(/Revision 1/)).toBeNull(); expect(screen.queryByText(/America\/Los_Angeles/)).toBeNull(); expect(screen.queryByRole('spinbutton')).toBeNull();
  });
  it('discards a late response after authoritative revision and company zone change in the same scope', async () => {
    const pending = deferred(); const view = render(<SchedulingPolicyEditor {...props({ onSave: () => pending.promise })} />); fireEvent.click(saveButton());
    const value = makePolicyReadResult(); value.policy!.revision = 2; value.policy!.timeZone = 'America/New_York'; value.context.policyRevision = 2; value.context.companyTimeZone = 'America/New_York';
    view.rerender(<SchedulingPolicyEditor {...props({ state: makePolicyViewState(value), draft: makePolicyDraft({ expectedRevision: 2, expectedCompanyTimeZone: 'America/New_York' }) })} />);
    await act(async () => pending.resolve({ kind: 'stale', message: 'Old context response' }));
    expect(screen.queryByText('Old context response')).toBeNull(); expect(screen.getByText(/Revision 2/)).toBeTruthy(); expect(saveButton().disabled).toBe(false);
  });
});
