import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ImportCard } from './reactivation';

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const batch = { id: 'batch-1', fileName: 'history.csv', totalRows: 3, imported: 1, updated: 1, duplicates: 0, conflicts: 1, skipped: 0, suppressed: 0, errors: ['Row 4: stale source update; not applied'], sourceKey: 'sample-account', snapshotAsOf: null, createdAt: '2026-10-01T12:00:00Z' };
const csv = 'First name,Email,Opportunity ID,Original opportunity date,Source updated date,Estimate amount,Currency\nSample,sample@example.invalid,op-1,2025-01-01,2025-08-01,1000,USD';
function mount(fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const fetcher = vi.fn(fetchImpl ?? (async (_input, init) => response(init?.method === 'POST' ? batch : [])));
  vi.stubGlobal('fetch', fetcher);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><ImportCard /></QueryClientProvider>);
  return fetcher;
}
async function chooseFile(contents = csv) {
  const file = new File([contents], 'history.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'text', { value: async () => contents });
  fireEvent.change(screen.getByLabelText('Choose a CSV file'), { target: { files: [file] } });
  await screen.findByRole('button', { name: 'Import opportunities' });
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('opportunity import controls', () => {
  it('requires a stable source key for IDs and sends mapped history without guessing snapshot freshness', async () => {
    const fetcher = mount();
    expect(screen.getByText(/A CSV is a snapshot/)).toBeTruthy();
    await chooseFile();
    const importButton = screen.getByRole('button', { name: 'Import opportunities' });
    expect(importButton.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Source account key'), { target: { value: 'sample-account' } });
    expect(importButton.hasAttribute('disabled')).toBe(false);
    fireEvent.click(importButton);
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    const [, init] = fetcher.mock.calls.find(([, options]) => options?.method === 'POST')!;
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ sourceKey: 'sample-account', mapping: { externalOpportunityId: 2, originalCreatedAt: 3, sourceUpdatedAt: 4, estimatedValue: 5, currency: 6 } });
    expect(body).not.toHaveProperty('snapshotAsOf');
    expect(body.mapping).not.toHaveProperty('source');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Import opportunities' })).toBeNull());
  });

  it('retains file, mapping and source values after a failed import', async () => {
    mount(async (_input, init) => init?.method === 'POST' ? response({ error: 'Source history could not be saved' }, 500) : response([]));
    await chooseFile();
    fireEvent.change(screen.getByLabelText('Source account key'), { target: { value: 'sample-account' } });
    fireEvent.change(screen.getByLabelText('Export snapshot date, if known'), { target: { value: '2025-09-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import opportunities' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import opportunities' }).hasAttribute('disabled')).toBe(false));
    expect((screen.getByLabelText('Source account key') as HTMLInputElement).value).toBe('sample-account');
    expect((screen.getByLabelText('Export snapshot date, if known') as HTMLInputElement).value).toBe('2025-09-01');
    expect(screen.getByText('history.csv')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Column for Opportunity / job ID' }).textContent).toContain('Opportunity ID');
  });

  it('keeps controls locked while an import is pending', async () => {
    let complete!: (value: Response) => void;
    mount(async (_input, init) => init?.method === 'POST' ? new Promise<Response>((resolve) => { complete = resolve; }) : response([]));
    await chooseFile();
    fireEvent.change(screen.getByLabelText('Source account key'), { target: { value: 'sample-account' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import opportunities' }));
    await waitFor(() => expect(screen.getByLabelText('Choose a CSV file').hasAttribute('disabled')).toBe(true));
    expect(screen.getByLabelText('Source account key').hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('combobox', { name: 'Column for Opportunity / job ID' }).hasAttribute('disabled')).toBe(true);
    complete(response(batch));
    await waitFor(() => expect(screen.getByLabelText('Choose a CSV file').hasAttribute('disabled')).toBe(false));
  });

  it('shows review conflicts and an unknown snapshot independently of the upload date', async () => {
    mount(async () => response([batch]));
    await screen.findByText(/1 added, 1 updated, 0 unchanged, 1 need review/);
    expect(screen.getByText(/Snapshot: unknown/)).toBeTruthy();
    fireEvent.click(screen.getByText('Review row issues'));
    expect(screen.getByText('Row 4: stale source update; not applied')).toBeTruthy();
  });
});
