import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkdayDisclosure, WorkdayNotice, useWorkdayOperation } from './workday-ui';
import { AssetFields, emptyAssetForm } from './workday-asset-fields';

afterEach(cleanup);
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function Runner({ scope, save, refresh, accepted }: { scope: string; save: () => Promise<string>; refresh: () => Promise<string>; accepted: (value: string) => void }) {
  const operation = useWorkdayOperation(scope);
  return <><button onClick={() => void operation.run(save, accepted, { mutation: true, success: 'Saved original work' })}>Save</button><button onClick={() => void operation.run(refresh, accepted, { refresh: true })}>Refresh</button><span>{operation.busy ? 'Busy' : 'Ready'}</span><WorkdayNotice {...operation} /></>;
}

it('mounts a lazy panel only when explicitly opened and unmounts on close', () => {
  const mounted = vi.fn(); function Reader() { mounted(); return <p>Private panel</p>; }
  render(<WorkdayDisclosure title="Equipment & assets"><Reader /></WorkdayDisclosure>);
  expect(mounted).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Open equipment & assets' })); expect(screen.getByText('Private panel')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close equipment & assets' })); expect(screen.queryByText('Private panel')).toBeNull();
});
it('blocks duplicate in-flight saves synchronously and ignores a late response after semantic target change', async () => {
  const pending = deferred<string>(), save = vi.fn(() => pending.promise), accepted = vi.fn(), refresh = vi.fn(async () => 'current');
  const view = render(<Runner scope="member:company:visit-a" save={save} refresh={refresh} accepted={accepted} />);
  fireEvent.click(screen.getByText('Save')); fireEvent.click(screen.getByText('Save')); expect(save).toHaveBeenCalledTimes(1);
  view.rerender(<Runner scope="member:company:visit-b" save={save} refresh={refresh} accepted={accepted} />);
  await act(async () => pending.resolve('old visit')); expect(accepted).not.toHaveBeenCalled(); expect(screen.queryByText('Saved original work')).toBeNull();
});
it('holds an unknown mutation until successful current-record refresh, not an automatic retry', async () => {
  const save = vi.fn(async () => { throw new Error('acknowledgement_unavailable'); }), refresh = vi.fn(async () => 'saved server evidence'), accepted = vi.fn();
  render(<Runner scope="scope" save={save} refresh={refresh} accepted={accepted} />);
  await act(async () => fireEvent.click(screen.getByText('Save'))); expect(screen.getByRole('alert').textContent).toContain('acknowledgement unavailable');
  fireEvent.click(screen.getByText('Save')); expect(save).toHaveBeenCalledTimes(1); expect(screen.getByText(/No automatic retry/)).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByText('Refresh'))); expect(accepted).toHaveBeenCalledWith('saved server evidence');
  await act(async () => fireEvent.click(screen.getByText('Save'))); expect(save).toHaveBeenCalledTimes(2);
});
it('does not call a late mutation callback after unmount', async () => {
  const pending = deferred<string>(), accepted = vi.fn(); const view = render(<Runner scope="scope" save={() => pending.promise} refresh={async () => ''} accepted={accepted} />);
  fireEvent.click(screen.getByText('Save')); view.unmount(); await act(async () => pending.resolve('saved')); expect(accepted).not.toHaveBeenCalled();
});
it('preserves the current operation across unchanged semantic scope rerenders', async () => {
  const pending = deferred<string>(), accepted = vi.fn(), save = () => pending.promise, refresh = async () => '';
  const view = render(<Runner scope="same-member-role-company" save={save} refresh={refresh} accepted={accepted} />); fireEvent.click(screen.getByText('Save'));
  view.rerender(<Runner scope="same-member-role-company" save={save} refresh={refresh} accepted={accepted} />); await act(async () => pending.resolve('original')); expect(accepted).toHaveBeenCalledWith('original');
});
it('keeps identifiers optional, records explicit descriptive values and renders literal text', () => {
  function Form() { const [value, setValue] = useState(emptyAssetForm()); return <AssetFields value={value} onChange={setValue} />; }
  const view = render(<Form />); expect((screen.getByLabelText('Serial number') as HTMLInputElement).required).toBe(false);
  fireEvent.change(screen.getByLabelText('Asset name'), { target: { value: '<script>not executable</script>' } }); expect(view.container.querySelector('script')).toBeNull();
  fireEvent.click(screen.getByText('Add recorded detail')); fireEvent.change(screen.getByLabelText('Detail 1 label'), { target: { value: 'Recorded roof area' } }); expect((screen.getByLabelText('Detail 1 label') as HTMLInputElement).value).toBe('Recorded roof area');
  fireEvent.change(screen.getByLabelText('Warranty ends on'), { target: { value: '2030-01-01' } }); expect((screen.getByLabelText('Warranty source / document reference') as HTMLTextAreaElement).required).toBe(true);
  fireEvent.click(screen.getByText('Remove detail 1')); expect(screen.queryByLabelText('Detail 1 label')).toBeNull();
});
