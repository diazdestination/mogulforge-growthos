import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getGetMeQueryKey } from '@workspace/api-client-react';
import ServiceDesk from '@/pages/service-desk';
import { renderWithQuery } from '@/test/render';
import { mockApi, sampleMe } from '@/test/mock-api';
import { approvedView, contactId, orgId, serviceId, smsPage, smsReply, standingPreview, standingView, versionTime } from '@/test/service-standing-fixtures';
import { makeSchedulingContext } from '@/test/scheduling-ui-fixtures';
import { serviceCareSchedulingReadSchema } from '../../../api-server/src/services/service-care-booking-contract';
const emptyWatch = () => Response.json({ items: [], hasMore: false, unmonitoredCount: 0, held: false });

describe('customer service desk status', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('shows unavailable, not an empty schedule, when service dates fail to load', async () => {
    mockApi('admin', {
      handler: (_method, path) => path.endsWith('/api/v1/service-watch') ? emptyWatch() : path.endsWith('/api/v1/service-obligations')
        ? Response.json({ error: 'service_unavailable' }, { status: 503 })
        : undefined,
    });
    renderWithQuery(<ServiceDesk />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Service dates are unavailable'));
    });
    expect(screen.queryByText('No active service dates yet.')).toBeNull();
  });

  it('waits for verified company access before reading service data and never calls a failed schedule empty', async () => {
    let resolveIdentity!: (response: Response) => void;
    let resolveCompanySchedule!: (response: Response) => void;
    const identityResponse = new Promise<Response>(resolve => { resolveIdentity = resolve; });
    const companyScheduleResponse = new Promise<Response>(resolve => { resolveCompanySchedule = resolve; });
    const fetchMock = mockApi('admin', { handler: (_method, path) => path.endsWith('/api/v1/service-watch') ? emptyWatch() : undefined });
    const fallback = fetchMock.getMockImplementation()!;
    let scheduleRequests = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = raw.split('?')[0];
      if (path.endsWith('/api/v1/me')) return identityResponse;
      if (path.endsWith('/api/v1/service-obligations')) {
        scheduleRequests += 1;
        return companyScheduleResponse;
      }
      return fallback(input, init);
    });
    renderWithQuery(<ServiceDesk />);
    expect(await screen.findByText('Confirming company access before opening service work…')).toBeTruthy();
    expect(scheduleRequests).toBe(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/service-watch'))).toBe(false);

    await act(async () => { resolveIdentity(Response.json(sampleMe('admin'))); });
    expect(await screen.findByText('Loading service dates…')).toBeTruthy();
    expect(scheduleRequests).toBe(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('No active service dates yet.')).toBeNull();

    await act(async () => {
      resolveCompanySchedule(Response.json({ error: 'service_unavailable' }, { status: 503 }));
    });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Service dates are unavailable'));
    });
    expect(screen.queryByText('No active service dates yet.')).toBeNull();
  });

  it('shows an empty schedule only after a successful response', async () => {
    mockApi('admin', {
      handler: (_method, path) => path.endsWith('/api/v1/service-watch') ? emptyWatch() : path.endsWith('/api/v1/service-obligations')
        ? Response.json([])
        : undefined,
    });
    renderWithQuery(<ServiceDesk />);
    expect(await screen.findByText('No active service dates yet.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

const row = () => ({ obligation: { id: serviceId, contactId, kind: 'maintenance', equipmentLabel: 'Fictional heat pump', dueAt: '2035-01-01T12:00:00.000Z', status: 'active', source: 'manual', appointmentId: null, updatedAt: versionTime, recurrence: standingView().sourceSummary.recurrence, coverageStartsOn: null, coverageEndsOn: null, coverageEvidence: null }, contact: { id: contactId, firstName: 'Fictional', lastName: 'Customer', phone: '+15005550006', email: 'customer@example.invalid' }, task: { status: 'open', dueAt: null, assignedUserId: 'staff' } });
const care = () => {
  const source = { sourceKind: 'direct_customer' as const, leadId: null, contactId, propertyId: null, estimateId: null };
  return {
    expectedUpdatedAt: versionTime, active: true, preview: null, blockReason: null, deferredReason: null, reminder: null,
    response: { id: '99999999-9999-4999-8999-999999999999', outcome: 'ready_to_book', note: 'Synthetic actual service conversation.', respondedAt: versionTime, channel: 'phone' }, appointment: null, booking: null,
    // Source booking review is available independently of any reminder provider.
    scheduling: serviceCareSchedulingReadSchema.parse({
      organizationId: orgId, actorUserId: 'u1', obligationId: serviceId, expectedUpdatedAt: versionTime, appointmentType: 'inspection', source,
      review: { state: 'ready', policy: null, context: makeSchedulingContext({
        organizationId: orgId, companyTimeZone: 'UTC', policyRevision: 0, policyDigest: null, source,
        applicableRules: { newTravelGapMinutes: 0, companyCeiling: null, inspectionCeiling: 2 },
      }) },
    }),
  };
};
function authoritySetup() {
  let profile = { ...sampleMe('admin'), organization: { id: orgId, name: 'Fictional HVAC', slug: 'fictional', timezone: 'UTC' } };
  let failed = false;
  let standingApproved = false, smsHandled = false;
  const fetch = mockApi('admin', { handler: (_method, path) => {
    if (path.endsWith('/me')) return failed ? Response.json({ error: 'Session could not be verified.' }, { status: 403 }) : Response.json(profile);
    if (path.endsWith('/service-watch')) return emptyWatch();
    if (path.endsWith('/service-obligations')) return Response.json([row()]);
    if (path.endsWith('/care')) return Response.json(care());
    if (path.endsWith('/standing-reminders')) return Response.json(standingApproved ? approvedView() : standingView());
    if (path.endsWith('/standing-reminders/preview')) return Response.json(standingPreview());
    if (path.endsWith('/standing-reminders/approve')) { standingApproved = true; return Response.json(approvedView()); }
    if (path.endsWith('/sms-replies')) return Response.json(smsPage([smsHandled ? smsReply({ version: 2, state: 'reviewed', holdActive: false, reviewNote: 'Actual office handling completed with the customer.' }) : smsReply()]));
    if (path.endsWith(`/sms-replies/${smsReply().id}/review`)) { smsHandled = true; return Response.json({ replyId: smsReply().id, version: 2, replayed: false }); }
    if (path.endsWith('/users')) return Response.json([{ id: 'staff', firstName: 'Fictional', lastName: 'Technician', isActive: true, operationallyEligible: true, role: 'office' }]);
  } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><ServiceDesk /></QueryClientProvider>);
  return { client, fetch, setProfile: (value: Partial<typeof profile>) => { profile = { ...profile, ...value }; }, fail: () => { failed = true; }, recover: () => { failed = false; } };
}
async function openCareDraft() {
  fireEvent.click(await screen.findByRole('button', { name: 'Customer care & booking' })); await screen.findByText('Latest staff-recorded response');
  const posts = () => vi.mocked(globalThis.fetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts()).toHaveLength(0);
  fireEvent.change(screen.getByLabelText(/Conversation and agreed next step/), { target: { value: 'Unfinished actual customer conversation note.' } });
  fireEvent.click(screen.getByLabelText(/I reviewed the actual customer response/));
  await waitFor(() => expect(screen.getByLabelText('Service start').matches(':disabled')).toBe(false));
  fireEvent.change(screen.getByLabelText('Service start'), { target: { value: '2035-01-02T10:00' } });
  fireEvent.change(screen.getByLabelText('Service end'), { target: { value: '2035-01-02T11:00' } });
  fireEvent.change(screen.getByLabelText('Assigned team member'), { target: { value: 'staff' } });
  expect(screen.getByRole('button', { name: 'Book confirmed visit' })).toHaveProperty('disabled', true);
  expect(screen.getByLabelText(/The customer confirmed this exact time/).matches(':disabled')).toBe(true);
  expect(posts()).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Review interval' }));
  fireEvent.click(screen.getByLabelText(/The customer confirmed this exact time/));
  expect(screen.getByRole('button', { name: 'Book confirmed visit' })).toHaveProperty('disabled', false);
  expect(posts()).toHaveLength(0);
}
async function prepareStandingReview() {
  fireEvent.click(screen.getByRole('button', { name: 'Review automatic series reminders' })); await screen.findByText('Standing reminders are off');
  fireEvent.click(screen.getByLabelText(/Enable one fixed reminder/));
  fireEvent.change(screen.getByLabelText(/Source last verified/), { target: { value: '2026-10-03T08:00' } });
  fireEvent.change(screen.getByLabelText('Source reconciliation evidence'), { target: { value: 'Synthetic source reviewed against the actual current service.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Prepare exact standing reminder review' })); await screen.findByLabelText(/I approve this exact agreement/);
  fireEvent.click(screen.getByLabelText(/I approve this exact agreement/));
}
function holdNextSchedule(fetchMock: ReturnType<typeof mockApi>) {
  const fallback = fetchMock.getMockImplementation()!;
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>(done => { resolve = done; });
  let held = false;
  fetchMock.mockImplementation(async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!held && raw.split('?')[0].endsWith('/api/v1/service-obligations')) { held = true; return pending; }
    return fallback(input, init);
  });
  return resolve;
}

describe('service authority boundaries', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  it('preserves drafts and fresh checkboxes through an unchanged successful 30-second profile refresh', async () => {
    const { client } = authoritySetup(); await openCareDraft();
    fireEvent.change(screen.getByLabelText('Equipment'), { target: { value: 'Unfinished new service draft' } });
    await act(async () => { await client.refetchQueries({ queryKey: getGetMeQueryKey() }); client.setQueryData(getGetMeQueryKey(), value => value, { updatedAt: Date.now() + 30_000 }); });
    expect(screen.getByLabelText('Equipment')).toHaveProperty('value', 'Unfinished new service draft');
    expect(screen.getByLabelText(/Conversation and agreed next step/)).toHaveProperty('value', 'Unfinished actual customer conversation note.');
    expect(screen.getByLabelText(/I reviewed the actual customer response/)).toHaveProperty('checked', true);
    expect(screen.getByLabelText('Service start')).toHaveProperty('value', '2035-01-02T10:00');
    expect(screen.getByLabelText('Service end')).toHaveProperty('value', '2035-01-02T11:00');
    expect(screen.getByLabelText(/The customer confirmed this exact time/)).toHaveProperty('checked', true);
    expect(screen.getByRole('button', { name: 'Book confirmed visit' })).toHaveProperty('disabled', false);
  });
  it('preserves an exact standing review during an unchanged profile refresh instead of remounting it', async () => {
    const { client } = authoritySetup(); await openCareDraft();
    await prepareStandingReview();
    await act(async () => { await client.refetchQueries({ queryKey: getGetMeQueryKey() }); });
    expect(screen.getByLabelText(/I approve this exact agreement/)).toHaveProperty('checked', true);
    expect(screen.getByRole('button', { name: 'Approve exact standing reminders' })).toHaveProperty('disabled', false);
  });
  it.each(['role', 'organization', 'identity', 'inactive'])('clears privileged drafts when actual %s authority changes', async mode => {
    const { client, setProfile } = authoritySetup(); await openCareDraft();
    if (mode === 'role') setProfile({ role: 'viewer' });
    if (mode === 'organization') setProfile({ organization: { id: 'other-company', name: 'Other', slug: 'other', timezone: 'UTC' } });
    if (mode === 'identity') setProfile({ id: 'other-user' });
    if (mode === 'inactive') setProfile({ isActive: false });
    await act(async () => { await client.refetchQueries({ queryKey: getGetMeQueryKey() }); });
    await waitFor(() => expect(screen.queryByLabelText(/Conversation and agreed next step/)).toBeNull());
    expect(screen.queryByRole('button', { name: 'Book confirmed visit' })).toBeNull();
    if (mode === 'inactive') expect(screen.getByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Active company access is required'));
  });
  it('fails closed even with cached profile data after a session-check error, and does not restore old review on recovery', async () => {
    const { client, fail, recover } = authoritySetup(); await openCareDraft(); fail();
    await act(async () => { await client.refetchQueries({ queryKey: getGetMeQueryKey() }); });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Company access could not be verified'));
    expect(screen.queryByLabelText(/The customer confirmed this exact time/)).toBeNull();
    recover(); fireEvent.click(screen.getByRole('button', { name: 'Check service access' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Customer care & booking' })); await screen.findByText('Latest staff-recorded response');
    expect(screen.getByLabelText(/The customer confirmed this exact time/)).toHaveProperty('checked', false);
    expect(screen.getByLabelText(/Conversation and agreed next step/)).toHaveProperty('value', '');
  });
});

describe('service child command background refresh', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  it('keeps the actual standing panel and saved confirmation visible through the parent list refresh', async () => {
    const { fetch } = authoritySetup(); await openCareDraft(); await prepareStandingReview();
    const finishRefresh = holdNextSchedule(fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Approve exact standing reminders' }));
    await screen.findByText('Refreshing service records…');
    expect(screen.getByText(/Standing approval saved for future eligible occurrences only/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide standing reminder setup' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Close customer care' })).toBeTruthy();
    await act(async () => { finishRefresh(Response.json([row()])); });
    await waitFor(() => expect(screen.queryByText('Refreshing service records…')).toBeNull());
    expect(screen.getByText(/Standing approval saved for future eligible occurrences only/)).toBeTruthy();
    expect(screen.getByText('Standing approval saved, but held')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve exact standing reminders' })).toBeNull();
  });
  it('keeps the actual SMS panel and saved handling receipt visible through the parent refresh', async () => {
    const { fetch } = authoritySetup(); await openCareDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Review service SMS evidence' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review this service text' }));
    fireEvent.change(screen.getByLabelText('SMS office disposition'), { target: { value: 'handled' } });
    fireEvent.change(screen.getByLabelText('SMS reply review note'), { target: { value: 'Actual office handling completed with the customer.' } });
    fireEvent.click(screen.getByLabelText(/I reviewed this exact evidence and disposition/));
    const finishRefresh = holdNextSchedule(fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Save SMS reply review' }));
    await screen.findByText('Refreshing service records…');
    expect(screen.getByText(/Office handling recorded. Only this service reply hold was released/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide service SMS evidence' })).toBeTruthy();
    await act(async () => { finishRefresh(Response.json([row()])); });
    await waitFor(() => expect(screen.queryByText('Refreshing service records…')).toBeNull());
    expect(screen.getByText(/Office handling recorded. Only this service reply hold was released/)).toBeTruthy();
    expect(screen.getByText(/Office note: Actual office handling completed/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review this service text' })).toBeNull();
  });
  it('closes child controls if the post-save schedule refresh fails and requires reopening after recovery', async () => {
    const { fetch } = authoritySetup(); await openCareDraft(); await prepareStandingReview();
    const finishRefresh = holdNextSchedule(fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Approve exact standing reminders' }));
    await screen.findByText('Refreshing service records…');
    await act(async () => { finishRefresh(Response.json({ error: 'Service access unavailable.' }, { status: 403 })); });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Service dates are unavailable'));
    expect(screen.queryByRole('button', { name: 'Close customer care' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Hide standing reminder setup' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh service records' }));
    await screen.findByRole('button', { name: 'Customer care & booking' });
    expect(screen.queryByRole('button', { name: 'Close customer care' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Customer care & booking' })); await screen.findByText('Latest staff-recorded response');
    expect(screen.getByLabelText(/The customer confirmed this exact time/)).toHaveProperty('checked', false);
    expect(screen.queryByRole('button', { name: 'Hide standing reminder setup' })).toBeNull();
  });
  it('does not restore a saved privileged panel when authority changes during its background refresh', async () => {
    const { client, fetch, setProfile } = authoritySetup(); await openCareDraft(); await prepareStandingReview();
    const finishRefresh = holdNextSchedule(fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Approve exact standing reminders' }));
    await screen.findByText('Refreshing service records…');
    setProfile({ role: 'viewer' });
    await act(async () => { await client.refetchQueries({ queryKey: getGetMeQueryKey() }); });
    await act(async () => { finishRefresh(Response.json([row()])); });
    expect(screen.queryByText(/Standing approval saved for future eligible occurrences only/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Hide standing reminder setup' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Book confirmed visit' })).toBeNull();
  });
});
