import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CustomerPropertySelect from './customer-property-select';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const organizationId = id(1), contactId = id(2);
const property = (n: number) => ({ kind: 'property' as const, id: id(n), createdAt: '2026-10-03T00:00:00.000Z', addressLine1: `${n} Fictional Lane`, addressLine2: null, city: 'Atlanta', state: 'GA', postalCode: '30301', propertyType: 'residential' });
const page = (items = [property(3)], nextCursor: string | null = null) => ({ organizationId, contactId, section: 'properties', order: 'created_desc', limit: 25, items, nextCursor, hasMore: nextCursor !== null });
const picker = () => screen.getByRole('combobox', { name: 'Property for this new service' });
function Harness({ contact = contactId, org = organizationId, scope = 'member:company:office', onChange = vi.fn() }: { contact?: string; org?: string; scope?: string; onChange?: (id: string) => void }) {
  const [value, setValue] = useState('');
  return <><CustomerPropertySelect organizationId={org} contactId={contact} scopeKey={scope} value={value} onChange={id => { setValue(id); onChange(id); }} /><output aria-label="Chosen property">{value || 'unlinked'}</output></>;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('explicit new-service property selection', () => {
  it('does not look up an unselected customer, then leaves a single property unselected', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(page())); vi.stubGlobal('fetch', fetch);
    const view = render(<Harness contact="" />);
    expect(fetch).not.toHaveBeenCalled(); expect(picker()).toHaveProperty('disabled', true);
    view.rerender(<Harness />);
    await screen.findByRole('option', { name: /3 Fictional Lane/ });
    expect(picker()).toHaveProperty('value', ''); expect(screen.getByLabelText('Chosen property').textContent).toBe('unlinked');
    fireEvent.change(picker(), { target: { value: id(3) } });
    expect(screen.getByLabelText('Chosen property').textContent).toBe(id(3));
    expect(fetch).toHaveBeenCalledWith(`/api/v1/contacts/${contactId}/workspace/properties`, expect.objectContaining({ credentials: 'include', cache: 'no-store', signal: expect.any(AbortSignal) }));
  });
  it('loads the next explicit opaque-cursor page and permits its property without treating the first page as all results', async () => {
    const fetch = vi.fn(async (url: string) => Response.json(url.includes('?cursor=opaque_next') ? page([property(40)]) : page(Array.from({ length: 25 }, (_, n) => property(10 + n)), 'opaque_next'))); vi.stubGlobal('fetch', fetch);
    render(<Harness />); await screen.findByText('25 linked properties loaded. More properties are available.');
    expect(fetch).toHaveBeenCalledTimes(1); expect(screen.queryByRole('option', { name: /40 Fictional Lane/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Load more customer properties' }));
    await screen.findByRole('option', { name: /40 Fictional Lane/ });
    expect(fetch.mock.calls[1][0]).toBe(`/api/v1/contacts/${contactId}/workspace/properties?cursor=opaque_next`);
    expect(picker()).toHaveProperty('value', '');
    fireEvent.change(picker(), { target: { value: id(40) } }); expect(picker()).toHaveProperty('value', id(40));
    expect(screen.getByText('26 linked properties loaded.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more customer properties' })).toBeNull();
  });
  it('clears a previous choice on explicit refresh and does not represent a failed read as no properties', async () => {
    let failure = false; const fetch = vi.fn(async () => failure ? Response.json({ error: 'Unavailable' }, { status: 503 }) : Response.json(page())); vi.stubGlobal('fetch', fetch);
    render(<Harness />); await screen.findByRole('option', { name: /3 Fictional Lane/ });
    fireEvent.change(picker(), { target: { value: id(3) } }); failure = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh properties and clear selection' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('not an empty-property result'));
    expect(picker()).toHaveProperty('value', ''); expect(picker()).toHaveProperty('disabled', true);
    expect(screen.queryByText('No linked properties were found for this customer.')).toBeNull();
    failure = false; fireEvent.click(screen.getByRole('button', { name: 'Retry customer properties' }));
    await screen.findByRole('option', { name: /3 Fictional Lane/ }); expect(picker()).toHaveProperty('value', '');
  });
  it.each(['organization', 'contact', 'section', 'extra', 'cursor', 'hasMore', 'duplicates'])('rejects an invalid %s page without displaying its address', async mode => {
    const value: Record<string, unknown> = page();
    if (mode === 'organization') value.organizationId = id(99);
    if (mode === 'contact') value.contactId = id(99);
    if (mode === 'section') value.section = 'appointments';
    if (mode === 'extra') value.privateNotes = 'not allowed';
    if (mode === 'cursor') { value.nextCursor = '../other'; value.hasMore = true; }
    if (mode === 'hasMore') value.hasMore = true;
    if (mode === 'duplicates') value.items = [property(3), property(3)];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(value)));
    render(<Harness />); await screen.findByRole('alert');
    expect(screen.queryByRole('option', { name: /3 Fictional Lane/ })).toBeNull(); expect(picker()).toHaveProperty('value', '');
  });
  it('rejects a repeated next cursor and clears the previous selection rather than keeping an ambiguous page chain', async () => {
    const fetch = vi.fn(async (url: string) => Response.json(page([property(url.includes('?') ? 4 : 3)], 'same_cursor'))); vi.stubGlobal('fetch', fetch);
    render(<Harness />); await screen.findByRole('option', { name: /3 Fictional Lane/ });
    fireEvent.change(picker(), { target: { value: id(3) } }); fireEvent.click(screen.getByRole('button', { name: 'Load more customer properties' }));
    await screen.findByRole('alert'); expect(picker()).toHaveProperty('value', ''); expect(screen.queryByRole('option', { name: /Fictional Lane/ })).toBeNull();
  });
  it.each(['contact', 'company', 'role', 'identity'])('aborts and ignores a late property page after a semantic %s change', async mode => {
    let resolve!: (value: Response) => void; const pending = new Promise<Response>(done => { resolve = done; });
    let firstSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url: string, options: RequestInit) => { if (!firstSignal) { firstSignal = options.signal as AbortSignal; return pending; } return Response.json({ ...page([property(4)]), contactId: mode === 'contact' ? id(20) : contactId, organizationId: mode === 'company' ? id(21) : organizationId }); }); vi.stubGlobal('fetch', fetch);
    const view = render(<Harness />); await screen.findByText('Checking customer properties…');
    view.rerender(<Harness contact={mode === 'contact' ? id(20) : contactId} org={mode === 'company' ? id(21) : organizationId} scope={mode === 'role' ? 'member:company:admin' : mode === 'identity' ? 'other-member:company:office' : 'member:company:office'} />);
    await screen.findByRole('option', { name: /4 Fictional Lane/ }); expect(firstSignal!.aborted).toBe(true);
    fireEvent.change(picker(), { target: { value: id(4) } });
    await act(async () => { resolve(Response.json(page())); });
    expect(screen.queryByRole('option', { name: /3 Fictional Lane/ })).toBeNull(); expect(picker()).toHaveProperty('value', id(4));
  });
  it('preserves an explicit choice when only an unchanged render occurs', async () => {
    const fetch = vi.fn(async () => Response.json(page())); vi.stubGlobal('fetch', fetch);
    const view = render(<Harness />); await screen.findByRole('option', { name: /3 Fictional Lane/ });
    fireEvent.change(picker(), { target: { value: id(3) } }); view.rerender(<Harness />);
    await waitFor(() => expect(picker()).toHaveProperty('value', id(3))); expect(fetch).toHaveBeenCalledTimes(1);
  });
});
