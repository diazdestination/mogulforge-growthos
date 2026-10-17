import { webcrypto, createHash } from 'node:crypto';
import { it, expect, vi, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { getGetMeQueryKey } from '@workspace/api-client-react';
import { Router } from 'wouter';
import { CustomerLifecycle } from '@/components/customer-lifecycle';
import { CustomerWorkForm } from '@/components/customer-work-form';
import Appointments from '@/pages/appointments';
import ServiceCarePanel from '@/components/service-care-panel';
import CallieCasePanel from '@/components/callie-case-panel';
import { memberAuthorityScope } from '@/lib/member-authority-scope';
import ProjectFormModal from '@/components/project-form-modal';
import { mockApi } from './mock-api';
const fixture = JSON.parse(process.env.SCHEDULING_HOST_API_FIXTURE!);
const realFetch = globalThis.fetch;
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it(`actual ${fixture.kind} host ${fixture.scenario} through authenticated API`, async () => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  const fetcher = mockApi('owner', { me: fixture.profile });
  const fallback = fetcher.getMockImplementation()!;
  const writes: any[] = [], replies: any[] = [];
  fetcher.mockImplementation(async (input, init) => {
    const path = String(input).split('?')[0];
    const method = init?.method ?? 'GET';
    if ((method !== 'GET' && (path.includes('/appointments') || path.includes('/projects'))) || path.includes('/customer-lifecycle/export') || path.includes('/customer-work/') || path.includes('/service-obligations/') || path.includes('/communications/callie/') || path.includes('/scheduling/') || path.endsWith('/scheduling-policy')) {
      if (method !== 'GET' && !path.includes('/scheduling/')) writes.push(JSON.parse(String(init?.body)));
      const res = await realFetch(new URL(String(input), fixture.origin), { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), cookie: `sid=${fixture.sid}`, Origin: 'https://growth.example' } });
      if (method !== 'GET' && !path.includes('/scheduling/')) replies.push({ status: res.status, body: await res.clone().json() });
      return res;
    }
    if (path.endsWith('/users')) return Response.json(fixture.users);
    if (path.endsWith('/appointments')) return Response.json(fixture.kind === 'appointment' && fixture.row ? [fixture.row] : []);
    if (path.endsWith('/leads')) return Response.json([fixture.lead]);
    if (path.endsWith('/contacts')) return Response.json([fixture.contact]);
    return fallback(input, init);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(getGetMeQueryKey(), fixture.profile);
  const close = vi.fn();
  render(<QueryClientProvider client={client}><Router>{fixture.kind === 'appointment' ? <Appointments /> : fixture.kind === 'project' ? <ProjectFormModal project={fixture.row} initialLeadId={fixture.lead.id} onClose={close} /> : fixture.kind === 'returning' ? <CustomerWorkForm kind="projects" actor={{ id: fixture.profile.id, organizationId: fixture.profile.organization.id, scopeKey: memberAuthorityScope(fixture.profile) }} record={fixture.row} onClose={close} /> : fixture.kind === 'care' ? <ServiceCarePanel obligationId={fixture.sourceId} editable onChanged={async () => {}} onClose={close} /> : <CallieCasePanel scopeKey={memberAuthorityScope(fixture.profile)} organizationId={fixture.profile.organization.id} id={fixture.sourceId} editable onChanged={() => {}} onClose={close} />}</Router></QueryClientProvider>);
  if (fixture.scenario === 'explain') {
    await waitFor(() => expect(screen.getByLabelText('Service start')).toHaveProperty('disabled', false));
    fireEvent.change(screen.getByLabelText('Service start'), { target: { value: '2035-01-01T12:00' } });
    fireEvent.change(screen.getByLabelText('Service end'), { target: { value: '2035-01-01T14:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review interval' }));
    await screen.findAllByText(/Current schedule explanation/);
    expect(document.body.textContent).toContain(fixture.neighborId); expect(document.body.textContent).toContain('120 elapsed minutes');
    expect(writes).toHaveLength(0); expect(sessionStorage.length).toBe(0);
    fireEvent.change(screen.getByLabelText('Service start'), { target: { value: '2035-01-01T13:00' } });
    expect(screen.getByLabelText('Service end')).toHaveProperty('value', '2035-01-01T14:00');
    expect(screen.queryByText(/Current schedule explanation/)).toBeNull(); return;
  }
  if (fixture.scenario === 'create') {
    if (fixture.kind === 'appointment') fireEvent.click(await screen.findByRole('button', { name: 'Schedule appointment' }));
    if (fixture.kind === 'project') fireEvent.change(await screen.findByLabelText('Project name'), { target: { value: 'Synthetic manual project' } });
    else fireEvent.change(await screen.findByLabelText(fixture.kind === 'appointment' ? 'Appointment type' : fixture.kind === 'care' ? 'Visit type' : 'CALLIE visit type'), { target: { value: 'other' } });
    if (fixture.kind === 'care') await screen.findByRole('button', { name: 'Refresh service scheduling review' });
    await waitFor(() => expect(screen.getByLabelText('Service start')).toHaveProperty('disabled', false));
    if (fixture.kind === 'care' || fixture.kind === 'callie') fireEvent.change(screen.getByLabelText(fixture.kind === 'care' ? 'Assigned team member' : 'Accepted technician'), { target: { value: fixture.users[0].id } });
    else fireEvent.click(screen.getByRole('checkbox', { name: fixture.users[0].firstName }));
    const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
    change('Service start', '2035-01-01T09:00'); change('Service end', fixture.kind === 'project' ? '2035-01-01T14:00' : '2035-01-01T10:00'); change('Service start', '2035-01-01T12:00');
    expect(screen.getByLabelText('Service end')).toHaveProperty('value', fixture.kind === 'project' ? '2035-01-01T14:00' : '2035-01-01T13:00');
    fireEvent.click(screen.getByRole('button', { name: 'Review interval' }));
    await screen.findByText(/Current schedule explanation/);
    expect(document.body.textContent).toContain(fixture.neighborId);
    expect(document.body.textContent).toContain('Required adjacent travel gap: 60 minutes');
    expect(document.body.textContent).not.toContain('Private adjacent notes');
    expect(writes).toHaveLength(0); expect(sessionStorage.length).toBe(0);
    change('Service start', '2035-01-01T13:00');
    expect(screen.queryByText(/Current schedule explanation/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review interval' }));
    if (fixture.kind === 'callie') change('Actual customer agreement', 'Synthetic customer agreed to this exact appointment.');
    if (fixture.kind === 'care' || fixture.kind === 'callie') fireEvent.click(screen.getByRole('checkbox', { name: /The customer confirmed this exact time/ }));
    const save = screen.getByRole('button', { name: fixture.kind === 'appointment' ? 'Save Appt' : fixture.kind === 'project' ? 'Save' : fixture.kind === 'care' ? 'Book confirmed visit' : 'Book CALLIE confirmed visit' });
    await waitFor(() => expect(save).toHaveProperty('disabled', false)); fireEvent.click(save);
    await waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0], JSON.stringify(replies[0])).toMatchObject({ status: fixture.kind === 'appointment' || fixture.kind === 'project' ? 201 : 200 });
    expect(writes[0].schedulingReview.duration).toEqual({ kind: 'explicit', preset: null });
    if (fixture.kind === 'project') {
      const expected = await (await realFetch(fixture.origin + '/api/v1/customer-lifecycle/export', { headers: { cookie: `sid=${fixture.sid}` } })).json();
      cleanup(); let captured: Blob | undefined;
      URL.createObjectURL = (blob: Blob) => { captured = blob; return 'blob:synthetic-export'; }; URL.revokeObjectURL = () => {};
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      render(<CustomerLifecycle accountKey={fixture.profile.id} />);
      fireEvent.click(screen.getByRole('button', { name: 'Download core records' }));
      await screen.findByRole('status');
      const downloaded = JSON.parse(await new Promise<string>((done) => { const reader = new FileReader(); reader.onload = () => done(String(reader.result)); reader.readAsText(captured!); }));
      expect(downloaded.manifest.tables).toHaveLength(28);
      expect(createHash('sha256').update(JSON.stringify(downloaded.organization.schedulingPolicy)).digest('hex')).toBe(downloaded.manifest.schedulingPolicySha256);
      expect(createHash('sha256').update(JSON.stringify(downloaded.organization.schedulingHistory)).digest('hex')).toBe(downloaded.manifest.schedulingHistorySha256);
      expect(downloaded.organization.schedulingHistory.length).toBeGreaterThan(0);
      // The export id/time vary per read; business bytes and all three checksums must survive the UI parser unchanged.
      expect(downloaded.organization).toEqual(expected.organization); expect(downloaded.data).toEqual(expected.data); expect(downloaded.manifest).toEqual(expected.manifest);
    }
    return;
  }
  if (fixture.kind === 'appointment') fireEvent.click(await screen.findByRole('button', { name: 'Edit appointment' }));
  else await screen.findByLabelText('Crew notes');
  const scenario = fixture.scenario;
  if (scenario === 'confirmation' || scenario === 'closure') fireEvent.change(screen.getAllByLabelText(fixture.kind === 'appointment' ? 'Appointment status' : 'Job status').at(-1)!, { target: { value: scenario === 'confirmation' ? 'confirmed' : 'completed' } });
  else if (scenario === 'release') fireEvent.click(screen.getByRole('button', { name: `Remove ${fixture.users[0].id} from saved crew` }));
  else fireEvent.change(screen.getByLabelText(fixture.kind === 'appointment' ? 'Appointment notes' : 'Crew notes'), { target: { value: 'Retained host API notes' } });
  if (fixture.kind === 'returning') fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed this native work/ }));
  const save = screen.getByRole('button', { name: fixture.kind === 'appointment' ? 'Save Appt' : fixture.kind === 'returning' ? 'Save customer job' : 'Save' });
  await waitFor(() => expect(save).toHaveProperty('disabled', false));
  fireEvent.click(save);
  await waitFor(() => expect(replies).toHaveLength(1));
  expect(replies[0], JSON.stringify(replies[0])).toMatchObject({ status: 200 });
  expect(writes).toHaveLength(1);
  if (scenario === 'notes') {
    const current = fixture.kind === 'returning' ? replies[0].body.project : replies[0].body;
    const body = { ...writes[0], ...(fixture.kind === 'returning' ? { requestId: crypto.randomUUID(), expectedWorkVersion: current.workVersion } : { expectedUpdatedAt: current.updatedAt }), expectedTargetFingerprint: current.schedulingTargetFingerprint };
    const path = fixture.kind === 'returning' ? `/api/v1/customer-work/projects/${fixture.row.id}` : `/api/v1/${fixture.kind === 'appointment' ? 'appointments' : 'projects'}/${fixture.row.id}`;
    for (const changes of [{ scheduledStart: '2035-01-01T12:00:00.000Z', scheduledEnd: '2035-01-01T13:00:00.000Z' }, ...(fixture.row.scheduledEnd ? [{ scheduledEnd: null }] : [])]) {
      const denied = await realFetch(fixture.origin + path, { method: 'PATCH', headers: { cookie: `sid=${fixture.sid}`, Origin: 'https://growth.example', 'content-type': 'application/json' }, body: JSON.stringify({ ...body, ...changes }) });
      expect(denied.status).toBeGreaterThanOrEqual(400);
    }
  }
  if (fixture.kind === 'returning') { expect(writes[0].scheduledStart).toBe(fixture.row.scheduledStart); expect(writes[0].scheduledEnd).toBe(fixture.row.scheduledEnd); expect(writes[0].requestId).toBeTruthy(); return; }
  expect(writes[0]).not.toHaveProperty('scheduledStart');
  expect(writes[0]).not.toHaveProperty('scheduledEnd');
  expect(writes[0]).not.toHaveProperty('operationId');
  if (scenario !== 'release') expect(writes[0]).not.toHaveProperty(fixture.kind === 'appointment' ? 'assignedUserId' : 'crewUserIds');
});
