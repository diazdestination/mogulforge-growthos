import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ZapierFlowActions } from './zapier-flow-actions';

const capability = (key: string, mode: 'off' | 'approve' | 'auto' = 'approve', config: Record<string, string> = {}) => ({ key, binding: { config }, policy: { mode, dailyBudget: 10 } });
const calendar = capability('appt.calendar.create_event');
const invoice = capability('invo.accounting.create_invoice');
const crew = capability('sched.sms.send', 'approve', { crew_phone_tech: '+15555550123' });
const records = (url: string) => {
  if (url === '/api/v1/appointments') return [{ id: 'visit', leadLabel: 'Morgan Lee', type: 'inspection', status: 'confirmed', scheduledStart: '2035-07-01T14:00:00Z' }];
  if (url.startsWith('/api/v1/invoices?')) return { items: [{ id: 'invoice', customerName: 'Morgan Lee', invoiceNumber: 'INV-001', status: 'issued', issuedAt: '2035-07-01T14:00:00Z' }, { id: 'draft', customerName: 'Draft customer', status: 'draft' }], page: 0, total: 1, pageSize: 25 };
  if (url === '/api/v1/users') return [{ id: 'tech', firstName: 'Robin', lastName: 'Crew', isActive: true, operationallyEligible: true }, { id: 'inactive', firstName: 'Inactive', isActive: false, operationallyEligible: false }];
  throw new Error(`Unexpected local request: ${url}`);
};
function setup(capabilities = [calendar, invoice, crew], outcome: unknown = { execution: { state: 'pending_approval' } }, canManage = true) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => Response.json(init?.method === 'POST' ? outcome : records(url)));
  vi.stubGlobal('fetch', fetchMock);
  const onComplete = vi.fn(async () => {});
  const view = render(<ZapierFlowActions capabilities={capabilities} canManage={canManage} onComplete={onComplete} />);
  return { fetchMock, onComplete, ...view };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('never requests a flow on load and offers no actions to non-managers', async () => {
  const s = setup();
  await screen.findByRole('option', { name: /INV-001.*Morgan Lee/ });
  expect(s.fetchMock.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  s.rerender(<ZapierFlowActions capabilities={[calendar, invoice, crew]} canManage={false} onComplete={s.onComplete} />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('combobox')).toBeNull();
});

it('requires a binding, enabled policy, and nonzero budget before offering a flow', () => {
  setup([capability('scout.leads.list', 'off'), { ...calendar, binding: null } as unknown as typeof calendar, { ...crew, policy: { mode: 'approve', dailyBudget: 0 } }]);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByText(/Configure an app action and enable its policy/)).toBeTruthy();
});

it('selects an existing appointment by customer/date and explicitly creates its calendar event', async () => {
  const s = setup([calendar]);
  fireEvent.change(await screen.findByLabelText('Appointment'), { target: { value: 'visit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create calendar event' }));
  expect(await screen.findByText(/Awaiting approval/)).toBeTruthy();
  expect(s.fetchMock).toHaveBeenCalledWith('/api/v1/integrations/zapier/flows/appointments/visit/calendar', expect.objectContaining({ method: 'POST', credentials: 'include' }));
  expect(s.onComplete).toHaveBeenCalledOnce();
});

it('exports only an issued invoice selected by its number and customer', async () => {
  const s = setup([invoice]);
  await screen.findByRole('option', { name: /INV-001.*Morgan Lee/ });
  expect(screen.queryByText(/Draft customer/)).toBeNull();
  fireEvent.change(screen.getByLabelText('Issued invoice'), { target: { value: 'invoice' } });
  fireEvent.click(screen.getByRole('button', { name: 'Export invoice to accounting' }));
  expect(await screen.findByText(/Awaiting approval/)).toBeTruthy();
  expect(s.fetchMock).toHaveBeenCalledWith('/api/v1/integrations/zapier/flows/invoices/invoice/accounting', expect.objectContaining({ method: 'POST' }));
});

it('sends a day sheet for a named eligible team member with a saved phone and chosen date', async () => {
  const s = setup([crew]);
  await screen.findByRole('option', { name: 'Robin Crew' });
  expect(screen.queryByText('Inactive')).toBeNull();
  fireEvent.change(screen.getByLabelText('Team member'), { target: { value: 'tech' } });
  fireEvent.change(screen.getByLabelText('Day sheet date (company timezone)'), { target: { value: '2035-07-01' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send crew day sheet by text' }));
  await screen.findByText(/Awaiting approval/);
  expect(s.fetchMock).toHaveBeenCalledWith('/api/v1/integrations/zapier/flows/sched/day-sheet', expect.objectContaining({ body: JSON.stringify({ userId: 'tech', date: '2035-07-01' }) }));
});

it('describes completed read sync using returned counts and does not claim destination delivery', async () => {
  const s = setup([capability('scout.reviews.list')], { execution: { state: 'succeeded' }, received: 3, created: 2, skipped: 1 });
  fireEvent.click(screen.getByRole('button', { name: 'Sync reviews into follow-up tasks' }));
  expect(await screen.findByText(/3 received.*2 created.*1 skipped/)).toBeTruthy();
  expect(s.fetchMock).toHaveBeenCalledWith('/api/v1/integrations/zapier/flows/scout/reviews', expect.objectContaining({ method: 'POST' }));
});

it('holds an indeterminate flow without suggesting another attempt', async () => {
  const s = setup([capability('scout.leads.list')], { execution: { state: 'indeterminate' } });
  const button = screen.getByRole('button', { name: 'Sync marketplace leads into GrowthOS' });
  fireEvent.click(button);
  expect(await screen.findByText(/Outcome needs reconciliation/)).toBeTruthy();
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(s.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  expect(screen.queryByText(/retry|try again/i)).toBeNull();
});

it('holds a lost response and does not expose raw server errors', async () => {
  const s = setup([capability('scout.leads.list')]);
  s.fetchMock.mockImplementationOnce(async () => { throw new Error('secret provider credential'); });
  fireEvent.click(screen.getByRole('button', { name: 'Sync marketplace leads into GrowthOS' }));
  expect(await screen.findByText(/Outcome could not be confirmed/)).toBeTruthy();
  expect(screen.queryByText(/secret provider/)).toBeNull();
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
});

it('rejects a forged record selection and omits call sync that could trigger text-backs', async () => {
  const s = setup([calendar, capability('callie.calls.list'), capability('callie.sms.send')]);
  await screen.findByRole('option', { name: /Morgan Lee/ });
  fireEvent.change(screen.getByLabelText('Appointment'), { target: { value: 'foreign' } });
  expect((screen.getByRole('button', { name: 'Create calendar event' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: /calls|text-back/i })).toBeNull();
  expect(screen.getByText(/Call sync can also request missed-call texts/)).toBeTruthy();
  expect(s.fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});

it('lets a failed record read reload without sending a flow', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 503 })).mockResolvedValueOnce(Response.json(records('/api/v1/appointments')));
  vi.stubGlobal('fetch', fetchMock);
  render(<ZapierFlowActions capabilities={[calendar]} canManage onComplete={async () => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Reload appointment records' }));
  await screen.findByRole('option', { name: /Morgan Lee/ });
  expect(fetchMock.mock.calls).toHaveLength(2);
  expect(fetchMock.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
});

it('paginates issued invoices and clears the previous record selection', async () => {
  const fetchMock = vi.fn(async (url: string) => Response.json(url.endsWith('page=0')
    ? { items: [{ id: 'first', customerName: 'First customer', invoiceNumber: 'INV-001', status: 'issued', issuedAt: null }], total: 26 }
    : { items: [{ id: 'last', customerName: 'Last customer', invoiceNumber: 'INV-026', status: 'issued', issuedAt: null }], total: 26 }));
  vi.stubGlobal('fetch', fetchMock);
  render(<ZapierFlowActions capabilities={[invoice]} canManage onComplete={async () => {}} />);
  await screen.findByRole('option', { name: /INV-001/ });
  fireEvent.change(screen.getByLabelText('Issued invoice'), { target: { value: 'first' } });
  fireEvent.click(screen.getByRole('button', { name: 'Next invoices' }));
  await screen.findByRole('option', { name: /INV-026/ });
  expect((screen.getByRole('button', { name: 'Export invoice to accounting' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText(/First customer/)).toBeNull();
});

it('does not describe a completed action as unknown when the parent reload fails', async () => {
  const s = setup([capability('scout.leads.list')], { execution: { state: 'succeeded' } });
  s.onComplete.mockRejectedValueOnce(new Error('Reload failed'));
  fireEvent.click(screen.getByRole('button', { name: 'Sync marketplace leads into GrowthOS' }));
  await screen.findByText(/connected app reported this action complete/);
  expect(screen.queryByText(/could not be confirmed/)).toBeNull();
});

it('locks setup during an explicit flow and respects setup work already in progress', async () => {
  const fetchMock = vi.fn(async () => Response.json({ execution: { state: 'pending_approval' } }));
  const onBusyChange = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const props = { capabilities: [capability('scout.leads.list')], canManage: true, onComplete: async () => {}, onBusyChange };
  const view = render(<ZapierFlowActions {...props} disabled />);
  fireEvent.click(screen.getByRole('button', { name: 'Sync marketplace leads into GrowthOS' }));
  expect(fetchMock).not.toHaveBeenCalled();
  view.rerender(<ZapierFlowActions {...props} disabled={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Sync marketplace leads into GrowthOS' }));
  await screen.findByText(/Awaiting approval/);
  expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
});

it('holds an unrecognized execution state instead of assuming the action failed safely', async () => {
  setup([capability('scout.leads.list')], { execution: { state: 'new_unknown_state' } });
  const button = screen.getByRole('button', { name: 'Sync marketplace leads into GrowthOS' });
  fireEvent.click(button);
  await screen.findByText(/Outcome could not be confirmed/);
  expect((button as HTMLButtonElement).disabled).toBe(true);
});
