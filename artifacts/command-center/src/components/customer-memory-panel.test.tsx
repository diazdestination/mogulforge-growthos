import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CustomerMemoryPanel from './customer-memory-panel';
import { contractorRequest } from '@/lib/contractor-api';
import type { CustomerMemoryDto } from '../../../api-server/src/services/customer-memory-contract';

vi.mock('@/lib/contractor-api', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/contractor-api')>(), contractorRequest: vi.fn() }));

const props = { organizationId: '11111111-1111-4111-8111-111111111111', contactId: '22222222-2222-4222-8222-222222222222', scopeKey: 'accepted-office-A' };
const api = vi.mocked(contractorRequest);
function memory(id: string, content: string, status: 'active' | 'retired' = 'active'): CustomerMemoryDto {
  return { id, organizationId: props.organizationId, contactId: props.contactId, kind: 'access_note', content, sourceType: 'manual', sourceId: null,
    status, createdByUserId: 'user-1', createdAt: '2035-01-01T00:00:00.000Z', retiredAt: status === 'retired' ? '2035-01-02T00:00:00.000Z' : null, retiredByUserId: status === 'retired' ? 'user-1' : null };
}
const first = memory('33333333-3333-4333-8333-333333333333', 'Gate code is kept by the office.');

beforeEach(() => { api.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('customer memory panel', () => {
  it('lists, adds and retires memories for the exact customer', async () => {
    let list: CustomerMemoryDto[] = [first];
    api.mockImplementation(async (path, options) => {
      if (!options?.method) return { organizationId: props.organizationId, contactId: props.contactId, memories: list };
      if (path.endsWith('/retire')) {
        expect(path).toBe(`/contacts/${props.contactId}/memories/${first.id}/retire`);
        list = [];
        return memory(first.id, first.content, 'retired');
      }
      expect(path).toBe(`/contacts/${props.contactId}/memories`);
      expect(options.body).toEqual({ kind: 'preference', content: 'Prefers texts before visits.' });
      const created = { ...memory('44444444-4444-4444-8444-444444444444', 'Prefers texts before visits.'), kind: 'preference' as const };
      list = [created, ...list];
      return created;
    });
    render(<CustomerMemoryPanel {...props} canWrite />);
    expect(await screen.findByText('Gate code is kept by the office.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'preference' } });
    fireEvent.change(screen.getByLabelText('Memory'), { target: { value: '  Prefers texts before visits. ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add memory' }));
    expect((await screen.findByRole('status')).textContent).toContain('Memory saved');
    expect(await screen.findByText('Prefers texts before visits.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Retire memory: Gate code/ }));
    expect((await screen.findByRole('status')).textContent).toContain('Memory retired');
    expect(screen.queryByText('Gate code is kept by the office.')).toBeNull();
  });

  it('is read-only without write access and rejects another customer\'s data', async () => {
    api.mockResolvedValueOnce({ organizationId: props.organizationId, contactId: '55555555-5555-4555-8555-555555555555', memories: [] });
    render(<CustomerMemoryPanel {...props} canWrite={false} />);
    expect((await screen.findByRole('alert')).textContent).toContain('could not be loaded');
    expect(screen.queryByRole('button', { name: 'Add memory' })).toBeNull();
    expect(screen.queryByLabelText('Memory')).toBeNull();
  });
});
