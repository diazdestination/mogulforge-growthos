import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import ServiceCarePanel from '@/components/service-care-panel';
import { mockApi } from '@/test/mock-api';
import { renderWithQuery } from '@/test/render';

const version = '2026-10-02T12:00:00.000Z';
const preview = { channel: 'email', recipient: 'customer@example.invalid', subject: 'Recorded service', body: 'No appointment is booked yet. This reminder does not determine warranty coverage.', fingerprint: 'a'.repeat(64), runAt: '2035-01-01T15:00:00.000Z', sender: { senderEmail: 'office@example.invalid', provider: 'microsoft' } };
const initial = () => ({ expectedUpdatedAt: version, active: true, preview, blockReason: null, deferredReason: null, reminder: null, response: null, appointment: null, booking: null });
const reminder = (state: string) => ({ state, channel: 'email', recipient: preview.recipient, subject: preview.subject, body: preview.body, agreementNote: 'Reviewed synthetic agreement.', runAt: preview.runAt, detail: null, providerEvidence: null, deliveryConfirmed: false });
function renderPanel(editable = true) { return renderWithQuery(<ServiceCarePanel obligationId="service-one" editable={editable} onChanged={vi.fn(async () => {})} onClose={vi.fn()} />); }
function setup(handler: (method: string, path: string) => Response | undefined) {
  return mockApi('office', { handler: (method, path) => path.endsWith('/api/v1/users') ? Response.json([{ id: 'staff-one', firstName: 'Synthetic', lastName: 'Technician', role: 'office', isActive: true, operationallyEligible: true }]) : handler(method, path) });
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('service customer-care approval', () => {
  it('shows the exact recipient, selected Microsoft identity and expected-service limits before approval', async () => {
    const fetch = setup((method, path) => method === 'GET' && path.endsWith('/care') ? Response.json(initial()) : undefined);
    renderPanel();
    expect(await screen.findByText(/To: customer@example.invalid/)).toHaveProperty('textContent', expect.stringContaining('office@example.invalid (microsoft)'));
    expect(screen.getByRole('button', { name: 'Approve one reminder' })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('Current service agreement / customer expectation evidence'), { target: { value: 'Current service agreement confirmed by office.' } });
    fireEvent.click(screen.getByLabelText(/I reviewed this exact message/));
    expect(screen.getByRole('button', { name: 'Approve one reminder' })).toHaveProperty('disabled', false);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });
  it('queues one reviewed fingerprint and shows the stored receipt instead of a resend control', async () => {
    let approved = false;
    const fetch = setup((method, path) => {
      if (method === 'POST' && path.endsWith('/reminder')) { approved = true; return Response.json({ approvalId: 'approval' }); }
      if (method === 'GET' && path.endsWith('/care')) return Response.json({ ...initial(), reminder: approved ? reminder('pending') : null });
    });
    renderPanel(); await screen.findByText(/To: customer@example.invalid/);
    fireEvent.change(screen.getByLabelText('Current service agreement / customer expectation evidence'), { target: { value: 'Current service agreement confirmed by office.' } });
    fireEvent.click(screen.getByLabelText(/I reviewed this exact message/)); fireEvent.click(screen.getByRole('button', { name: 'Approve one reminder' }));
    expect(await screen.findByText('Queued — not sent yet')).toBeTruthy();
    const [, request] = fetch.mock.calls.find(([url, init]) => String(url).endsWith('/reminder') && init?.method === 'POST')!;
    expect(JSON.parse(String(request?.body))).toMatchObject({ expectedUpdatedAt: version, channel: 'email', previewFingerprint: preview.fingerprint, expectedServiceConfirmed: true });
    expect(screen.queryByRole('button', { name: 'Approve one reminder' })).toBeNull();
  });
  it('locks writes after a lost response until explicit refresh reveals the actual receipt, without auto retry', async () => {
    let accepted = false;
    const fetch = setup((method, path) => {
      if (method === 'POST' && path.endsWith('/reminder')) { accepted = true; return Response.json({ error: 'Acknowledgment lost' }, { status: 503 }); }
      if (method === 'GET' && path.endsWith('/care')) return Response.json({ ...initial(), reminder: accepted ? reminder('pending') : null });
    });
    renderPanel(); await screen.findByText(/To: customer@example.invalid/);
    fireEvent.change(screen.getByLabelText('Current service agreement / customer expectation evidence'), { target: { value: 'Current service agreement confirmed by office.' } });
    fireEvent.click(screen.getByLabelText(/I reviewed this exact message/)); fireEvent.click(screen.getByRole('button', { name: 'Approve one reminder' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('No automatic retry'));
    expect(screen.getByRole('button', { name: 'Approve one reminder' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh and review' }));
    expect(await screen.findByText('Queued — not sent yet')).toBeTruthy();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('requires a fresh explicit approval after stale-version refresh, not silently adopted permission', async () => {
    let refreshed = false;
    setup((method, path) => {
      if (method === 'POST') { refreshed = true; return Response.json({ error: 'Service changed' }, { status: 409 }); }
      if (path.endsWith('/care')) return Response.json({ ...initial(), expectedUpdatedAt: refreshed ? '2026-10-02T13:00:00.000Z' : version });
    });
    renderPanel(); await screen.findByText(/To: customer@example.invalid/);
    fireEvent.change(screen.getByLabelText('Current service agreement / customer expectation evidence'), { target: { value: 'Current service agreement confirmed by office.' } });
    fireEvent.click(screen.getByLabelText(/I reviewed this exact message/)); fireEvent.click(screen.getByRole('button', { name: 'Approve one reminder' }));
    await screen.findByRole('alert'); fireEvent.click(screen.getByRole('button', { name: 'Refresh and review' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByLabelText(/I reviewed this exact message/)).toHaveProperty('checked', false);
    expect(screen.getByRole('button', { name: 'Approve one reminder' })).toHaveProperty('disabled', true);
  });
  it('shows an unknown send receipt without a resend or delivered claim', async () => {
    setup(() => Response.json({ ...initial(), reminder: reminder('indeterminate') })); renderPanel();
    expect(await screen.findByText('Unknown send result — operator reconciliation required')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve one reminder' })).toBeNull();
    expect(screen.queryByText(/^Delivered$/)).toBeNull();
  });
  it('labels a standing-admitted original receipt without claiming individual approval or offering a second reminder', async () => {
    setup(() => Response.json({ ...initial(), reminder: { ...reminder('pending'), origin: 'standing', policyRevisionId: 'revision' } })); renderPanel();
    expect(await screen.findByText(/Standing-policy admission — not a new individual staff approval/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve one reminder' })).toBeNull();
  });
  it('invalidates customer evidence checkboxes on edits instead of silently reusing earlier attestation', async () => {
    setup(() => Response.json(initial())); renderPanel(); await screen.findByText(/To: customer@example.invalid/);
    fireEvent.change(screen.getByLabelText('Current service agreement / customer expectation evidence'), { target: { value: 'Synthetic agreement first reviewed.' } });
    fireEvent.click(screen.getByLabelText(/I reviewed this exact message/));
    fireEvent.change(screen.getByLabelText('Current service agreement / customer expectation evidence'), { target: { value: 'Different synthetic agreement evidence.' } });
    expect(screen.getByLabelText(/I reviewed this exact message/)).toHaveProperty('checked', false);
    fireEvent.click(screen.getByLabelText(/I reviewed the actual customer response/));
    fireEvent.change(screen.getByLabelText('Customer outcome'), { target: { value: 'declined' } });
    expect(screen.getByLabelText(/I reviewed the actual customer response/)).toHaveProperty('checked', false);
  });
  it('does not refresh or invoke parent callbacks for a late mutation after the panel has closed', async () => {
    let finish!: (response: Response) => void; const deferred = new Promise<Response>(resolve => { finish = resolve; });
    const fetch = setup((_method, path) => path.endsWith('/care') ? Response.json(initial()) : undefined);
    const fallback = fetch.getMockImplementation()!; fetch.mockImplementation((url, init) => init?.method === 'POST' ? deferred : fallback(url, init));
    const changed = vi.fn(async () => {});
    const view = renderWithQuery(<ServiceCarePanel obligationId="service-one" editable onChanged={changed} onClose={vi.fn()} />);
    await screen.findByText(/To: customer@example.invalid/);
    fireEvent.change(screen.getByLabelText('Current service agreement / customer expectation evidence'), { target: { value: 'Synthetic agreement current and reviewed.' } });
    fireEvent.click(screen.getByLabelText(/I reviewed this exact message/)); fireEvent.click(screen.getByRole('button', { name: 'Approve one reminder' }));
    view.unmount(); await act(async () => { finish(Response.json({ approvalId: 'approval' })); });
    expect(changed).not.toHaveBeenCalled();
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/care?'))).toHaveLength(1);
  });
  it('keeps source/consent holds visible and allows read-only inspection without write controls', async () => {
    setup(() => Response.json({ ...initial(), preview: null, blockReason: 'Reminder held: imported_source_requires_current_review.' })); renderPanel(false);
    expect(await screen.findByText(/imported_source_requires_current_review/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve one reminder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record customer response' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Book confirmed visit' })).toBeNull();
  });
});
describe('office-confirmed service appointment', () => {
  it('requires a fresh staff-recorded response before booking and labels its evidence', async () => {
    setup(() => Response.json(initial())); renderPanel(); await screen.findByText(/To: customer@example.invalid/);
    expect(screen.getByRole('button', { name: 'Book confirmed visit' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/Record a fresh/)).toBeTruthy();
  });
  it('requires exact window confirmation and sends the current response/version', async () => {
    let booked = false;
    const fetch = setup((method, path) => {
      if (method === 'POST' && path.endsWith('/book')) { booked = true; return Response.json({ appointmentId: 'visit-one' }); }
      if (path.endsWith('/care')) return Response.json({ ...initial(), response: { id: 'response-one', outcome: 'ready_to_book', respondedAt: version, channel: 'phone', note: 'Synthetic confirmed service conversation.' }, appointment: booked ? { id: 'visit-one', status: 'confirmed', scheduledStart: '2035-01-01T15:00:00.000Z' } : null });
    });
    renderPanel(); await screen.findByText('Latest staff-recorded response');
    expect(screen.getByText('Staff attestation — not independently verified inbox evidence.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Visit starts/), { target: { value: '2035-01-01T10:00' } });
    fireEvent.change(screen.getByLabelText(/Visit ends/), { target: { value: '2035-01-01T11:00' } });
    fireEvent.change(screen.getByLabelText('Assigned team member'), { target: { value: 'staff-one' } });
    fireEvent.click(screen.getByLabelText(/The customer confirmed this exact time/));
    fireEvent.click(screen.getByRole('button', { name: 'Book confirmed visit' }));
    expect(await screen.findByText(/Office-confirmed appointment booked and linked/)).toBeTruthy();
    const [, init] = fetch.mock.calls.find(([url, request]) => String(url).endsWith('/book') && request?.method === 'POST')!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ responseId: 'response-one', expectedUpdatedAt: version, assignedUserId: 'staff-one', customerConfirmed: true });
    expect(screen.queryByRole('button', { name: 'Book confirmed visit' })).toBeNull();
  });
});
