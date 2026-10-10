import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CustomerDetailCorrectionPanel from './customer-detail-correction-panel';
import { ContractorApiError, contractorRequest } from '@/lib/contractor-api';
import type { CustomerDetailSnapshot } from '../../../api-server/src/services/customer-detail-correction-contract';

vi.mock('@/lib/contractor-api', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/contractor-api')>(), contractorRequest: vi.fn() }));
vi.mock('./customer-property-select', () => ({ default: ({ onChange, onReadyChange }: { onChange: (id: string) => void; onReadyChange: (value: boolean) => void }) => <button onClick={() => { onReadyChange(true); onChange('44444444-4444-4444-8444-444444444444'); }} type="button">Select synthetic property</button> }));

const props = { organizationId: '11111111-1111-4111-8111-111111111111', contactId: '22222222-2222-4222-8222-222222222222', scopeKey: 'accepted-office-A' };
const propertyId = '44444444-4444-4444-8444-444444444444';
const api = vi.mocked(contractorRequest);
function snapshot(selected: string | null = null): CustomerDetailSnapshot {
  return { organizationId: props.organizationId, contactId: props.contactId, propertyId: selected,
    details: { firstName: 'Synthetic', lastName: 'Customer', email: 'customer@example.invalid', phone: '+12025550101', property: selected ? { addressLine1: '100 Example Street', addressLine2: null, city: 'Example', state: 'GA', postalCode: '30000' } : null },
    version: { contactUpdatedAt: '2035-01-01T00:00:00.000Z', propertyUpdatedAt: selected ? '2035-01-01T00:00:00.000Z' : null, fingerprint: 'a'.repeat(64) } };
}
async function openAndLoad() {
  fireEvent.click(screen.getByRole('button', { name: 'Review customer details' }));
  fireEvent.click(screen.getByRole('button', { name: 'Load current details' }));
  await screen.findByLabelText('First name *');
}
beforeEach(() => { api.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('customer detail review screen', () => {
  it('loads on explicit review and checks exact company/customer identity before showing details', async () => {
    api.mockResolvedValue({ ...snapshot(), organizationId: '33333333-3333-4333-8333-333333333333' });
    render(<CustomerDetailCorrectionPanel {...props} />);
    expect(api).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review customer details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load current details' }));
    expect((await screen.findByRole('alert')).textContent).toContain('could not be verified');
    expect(screen.queryByLabelText('First name *')).toBeNull();
  });

  it('saves only changed supplied fields against the loaded version', async () => {
    const initial = snapshot(); const saved = vi.fn();
    api.mockImplementation(async (_path, options) => {
      if (!options?.method) return initial;
      const body = options.body as { requestId: string; changes: { firstName: string }; expectedVersion: unknown; propertyId: unknown };
      expect(body).toMatchObject({ changes: { firstName: 'Reviewed' }, propertyId: null, expectedVersion: initial.version });
      expect(Object.keys(body.changes)).toEqual(['firstName']);
      return { receipt: { requestId: body.requestId, status: 'saved', committedAt: '2035-01-01T00:00:01.000Z', changedFields: ['firstName'], snapshot: { ...initial, details: { ...initial.details, firstName: 'Reviewed' } } }, replayed: false };
    });
    render(<CustomerDetailCorrectionPanel {...props} onSaved={saved} />);
    await openAndLoad();
    fireEvent.change(screen.getByLabelText('First name *'), { target: { value: 'Reviewed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save reviewed details' }));
    expect((await screen.findByRole('status')).textContent).toContain('Customer details saved');
    expect(saved).toHaveBeenCalledTimes(1);
    expect(api.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });

  it('holds an unknown save, retains its original ID across closing, and verifies it by read only', async () => {
    const initial = snapshot(); let originalId = ''; const saved = vi.fn();
    api.mockImplementation(async (path, options) => {
      if (options?.method === 'POST') { originalId = (options.body as { requestId: string }).requestId; throw new Error('Synthetic lost response'); }
      if (path.includes('/detail-corrections/')) {
        expect(path).toBe(`/contacts/${props.contactId}/detail-corrections/${originalId}`);
        return { requestId: originalId, status: 'saved', committedAt: '2035-01-01T00:00:01.000Z', changedFields: ['firstName'], snapshot: { ...initial, details: { ...initial.details, firstName: 'Reviewed' } } };
      }
      return initial;
    });
    render(<CustomerDetailCorrectionPanel {...props} onSaved={saved} />);
    await openAndLoad(); fireEvent.change(screen.getByLabelText('First name *'), { target: { value: 'Reviewed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save reviewed details' }));
    await screen.findByRole('button', { name: 'Check original saved result' });
    expect(screen.getByRole('button', { name: 'Save reviewed details' }).matches(':disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close detail review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review customer details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check original saved result' }));
    expect((await screen.findByRole('status')).textContent).toContain('Original save verified');
    expect(screen.queryByRole('button', { name: 'Save reviewed details' })).toBeNull();
    expect(api.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it('requires a fresh review after a stale-version refusal and does not retry the save', async () => {
    api.mockImplementation(async (_path, options) => {
      if (options?.method === 'POST') throw new ContractorApiError(409, 'detail_correction_stale_version');
      return snapshot();
    });
    render(<CustomerDetailCorrectionPanel {...props} />); await openAndLoad();
    fireEvent.change(screen.getByLabelText('First name *'), { target: { value: 'Reviewed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save reviewed details' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Load current details');
    expect(screen.queryByRole('button', { name: 'Save reviewed details' })).toBeNull();
    expect(api.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });

  it('does not automatically choose a property and binds the address review to the selected ID', async () => {
    api.mockResolvedValue(snapshot(propertyId)); render(<CustomerDetailCorrectionPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review customer details' }));
    fireEvent.click(screen.getByLabelText('Also review a property address'));
    expect((screen.getByRole('button', { name: 'Load current details' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Select synthetic property' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load current details' }));
    expect((await screen.findByLabelText('Street address *') as HTMLInputElement).value).toBe('100 Example Street');
    expect(api.mock.calls[0][0]).toBe(`/contacts/${props.contactId}/detail-correction?propertyId=${propertyId}`);
  });

  it('ignores a delayed old-company response after the authenticated workspace changes', async () => {
    let resolve!: (value: unknown) => void;
    api.mockImplementation(() => new Promise(done => { resolve = done; }));
    const { rerender } = render(<CustomerDetailCorrectionPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review customer details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load current details' }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    rerender(<CustomerDetailCorrectionPanel {...props} organizationId="33333333-3333-4333-8333-333333333333" scopeKey="accepted-office-B" />);
    await act(async () => { resolve(snapshot()); });
    expect(screen.queryByLabelText('First name *')).toBeNull();
    expect(screen.getByRole('button', { name: 'Review customer details' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('holds a mismatched save acknowledgement and never treats it as this customer’s saved result', async () => {
    const initial = snapshot(); const saved = vi.fn();
    api.mockImplementation(async (_path, options) => {
      if (!options?.method) return initial;
      return { receipt: { requestId: (options.body as { requestId: string }).requestId, status: 'saved', committedAt: '2035-01-01T00:00:01.000Z', changedFields: ['firstName'], snapshot: { ...initial, contactId: '33333333-3333-4333-8333-333333333333', details: { ...initial.details, firstName: 'Reviewed' } } }, replayed: false };
    });
    render(<CustomerDetailCorrectionPanel {...props} onSaved={saved} />); await openAndLoad();
    fireEvent.change(screen.getByLabelText('First name *'), { target: { value: 'Reviewed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save reviewed details' }));
    await screen.findByRole('button', { name: 'Check original saved result' });
    expect(screen.getByRole('button', { name: 'Save reviewed details' }).matches(':disabled')).toBe(true);
    expect(saved).not.toHaveBeenCalled();
    expect(api.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });

  it('holds a hung save at the real 20-second transport timeout and ignores its late response', async () => {
    const actual = await vi.importActual<typeof import('@/lib/contractor-api')>('@/lib/contractor-api');
    api.mockImplementation(actual.contractorRequest);
    let resolveLate!: (value: Response) => void; let requestId = ''; let posts = 0;
    const saved = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init: RequestInit) => {
      if (init.method !== 'POST') return new Response(JSON.stringify(snapshot()), { headers: { 'content-type': 'application/json' } });
      posts++; requestId = JSON.parse(String(init.body)).requestId;
      return new Promise<Response>((resolve, reject) => { resolveLate = resolve; init.signal!.addEventListener('abort', () => reject(new DOMException('Synthetic aborted transport', 'AbortError')), { once: true }); });
    }));
    render(<CustomerDetailCorrectionPanel {...props} onSaved={saved} />); await openAndLoad();
    fireEvent.change(screen.getByLabelText('First name *'), { target: { value: 'Reviewed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save reviewed details' }));
    await screen.findByRole('button', { name: 'Check original saved result' }, { timeout: 25000 });
    const initial = snapshot();
    await act(async () => { resolveLate(new Response(JSON.stringify({ receipt: { requestId, status: 'saved', committedAt: '2035-01-01T00:00:01.000Z', changedFields: ['firstName'], snapshot: { ...initial, details: { ...initial.details, firstName: 'Reviewed' } } }, replayed: false }), { headers: { 'content-type': 'application/json' } })); });
    expect(saved).not.toHaveBeenCalled(); expect(posts).toBe(1);
    expect(screen.getByRole('button', { name: 'Save reviewed details' }).matches(':disabled')).toBe(true);
  }, 30000);
});
