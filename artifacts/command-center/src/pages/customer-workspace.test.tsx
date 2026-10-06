import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getGetMeQueryKey } from '@workspace/api-client-react';
import { Route, Router } from 'wouter';
import { afterEach, expect, it, vi } from 'vitest';
import CustomerWorkspace from './customer-workspace';
import { customerWorkspaceHeaderSchema, customerWorkspacePageSchema } from '../../../api-server/src/services/customer-workspace-contract';
import { GetCustomerWorkspaceResponse, GetCustomerWorkspaceSectionResponse } from '../../../../lib/api-zod/src/generated/api';
import { workspaceHeader, workspacePage, workspaceOrg as org, workspaceContact as contact, workspaceId } from '@/test/customer-workspace-fixtures';
import { asset as workdayAsset, assets as workdayAssets } from '@/test/workday-fixtures';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const basePath = `/contacts/${contact}?organizationId=${org}`;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function setup({ search = '', id = contact, role = 'owner', respond }: { search?: string; id?: string; role?: string; respond?: (url: URL) => Response | Promise<Response> | undefined } = {}) {
  const state = { role, organizationId: org, meStatus: 200, active: true, header: workspaceHeader(id), respond };
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin); calls.push(url.pathname + url.search);
    if (url.pathname === '/api/v1/me') return json(state.meStatus === 200 ? {
      id: 'workspace-member', role: state.role, isActive: state.active, email: 'staff@example.test',
      firstName: 'Synthetic', lastName: 'Staff', organization: { id: state.organizationId, name: 'Synthetic Contractor', slug: 'synthetic', timezone: 'America/New_York' },
    } : { error: 'Unavailable' }, state.meStatus);
    if ((init?.method || 'GET') !== 'GET') throw new Error('Read-only workspace attempted a mutation');
    const override = state.respond?.(url); if (override) return override;
    if (url.pathname === `/api/v1/contacts/${id}/workspace`) return json(state.header);
    const match = /\/workspace\/([^/]+)$/.exec(url.pathname);
    if (match) return json(workspacePage(match[1] as Parameters<typeof workspacePage>[0], id));
    return json({ error: 'Unexpected route' }, 404);
  });
  vi.stubGlobal('fetch', fetch);
  window.history.replaceState(null, '', `/contacts/${id}${search || `?organizationId=${org}`}`);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><Router><Route path="/contacts/:id" component={CustomerWorkspace} /></Router></QueryClientProvider>);
  return { state, calls, client, fetch };
}
const select = async (name: string) => fireEvent.click(within(await screen.findByRole('navigation', { name: 'Customer record sections' })).getByRole('link', { name }));
const recordCalls = (calls: string[]) => calls.filter(path => /\/workspace\//.test(path));

it('loads just the header and visits for a service-only customer, and uses a real exact-visit destination', async () => {
  const { calls } = setup();
  await screen.findByRole('link', { name: 'Open visit' });
  expect(screen.getByRole('heading', { name: 'Morgan Synthetic Customer' })).toBeTruthy();
  expect(screen.getByText('No property linked')).toBeTruthy();
  expect(screen.getByText(/not consent or permission to send/)).toBeTruthy();
  expect(screen.getByText('Email: Do not email')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open visit' }).getAttribute('href')).toBe(`/appointments?appointmentId=${workspaceId(4)}&organizationId=${org}`);
  expect(recordCalls(calls)).toEqual([`/api/v1/contacts/${contact}/workspace/appointments`]);
  expect(calls.some(path => /\/api\/v1\/(contacts|appointments|leads)$/.test(path))).toBe(false);
  expect(customerWorkspaceHeaderSchema.safeParse(workspaceHeader()).success).toBe(true);
  expect(customerWorkspacePageSchema.safeParse(workspacePage('appointments')).success).toBe(true);
  expect(GetCustomerWorkspaceResponse.safeParse(workspaceHeader()).success).toBe(true);
  for (const section of workspaceHeader().availableSections) expect(GetCustomerWorkspaceSectionResponse.safeParse(workspacePage(section)).success).toBe(true);
});

it('keeps equipment within the existing nine sections, lazy on open and preserves its draft through unchanged member polling', async () => {
  const asset = workdayAsset({ organizationId: org, contactId: contact, propertyId: workspaceId(3) });
  const { client, calls, state } = setup({ search: `?organizationId=${org}&section=services`, respond: url => url.pathname.endsWith('/assets') ? json(workdayAssets({ organizationId: org, contactId: contact, items: [asset] })) : undefined });
  await screen.findByRole('link', { name: 'Open service' }); expect(within(screen.getByRole('navigation', { name: 'Customer record sections' })).getAllByRole('link')).toHaveLength(9); expect(calls.some(path => path.endsWith('/assets'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Open equipment & assets' })); fireEvent.click(await screen.findByRole('button', { name: 'Edit Fictional north unit' })); fireEvent.change(screen.getByLabelText('Asset name'), { target: { value: 'Unfinished recorded asset name' } });
  await act(async () => { await client.invalidateQueries({ queryKey: getGetMeQueryKey() }); }); expect((screen.getByLabelText('Asset name') as HTMLInputElement).value).toBe('Unfinished recorded asset name'); expect(calls.filter(path => path.endsWith('/assets'))).toHaveLength(1);
  state.meStatus = 503; await act(async () => { await client.invalidateQueries({ queryKey: getGetMeQueryKey() }); }); await screen.findByText(/Current company access could not be verified/); expect(screen.queryByLabelText('Asset name')).toBeNull();
});

it('lazily navigates native work and pinned invoice links while retaining related opportunities separately', async () => {
  const { calls } = setup(); await screen.findByRole('link', { name: 'Open visit' });
  for (const [section, linkName, href] of [
    ['Service & equipment', 'Open service', `/service?serviceObligationId=${workspaceId(5)}&organizationId=${org}`],
    ['Opportunities', 'Open opportunity', `/leads/${workspaceId(6)}?organizationId=${org}`],
    ['Jobs', 'Open related opportunity', `/leads/${workspaceId(6)}?organizationId=${org}`],
    ['Estimates', 'Open related opportunity', `/leads/${workspaceId(6)}?organizationId=${org}`],
    ['Invoices', 'Open invoice', `/invoices/${workspaceId(10)}?organizationId=${org}`],
    ['Tasks', 'Open task', `/tasks?taskId=${workspaceId(9)}`],
  ]) {
    await select(section); expect((await screen.findByRole('link', { name: linkName })).getAttribute('href')).toBe(href);
    expect(screen.queryByRole('link', { name: 'Open visit' })).toBeNull();
  }
  expect(recordCalls(calls)).toHaveLength(7);
  expect(screen.queryByText(/\$[0-9]/)).toBeNull();
  await select('Properties'); await screen.findByText('15 Fictional Lane');
  expect(screen.getByRole('link', { name: 'Open property directory (all customers)' }).getAttribute('href')).toBe('/properties');
  await select('History'); await screen.findByText('Customer response recorded');
  expect(screen.getByText(/not proof of delivery/)).toBeTruthy();
});

it('adds returning estimates/jobs/invoices inside the original nine sections with explicit new links and no null opportunity', async () => {
  setup({ search: `?organizationId=${org}&section=estimates`, respond: url => {
    const section = url.pathname.split('/').at(-1);
    if (!['estimates', 'projects', 'invoices'].includes(section!)) return undefined;
    const page = workspacePage(section as 'estimates');
    return json({ ...page, items: page.items.map(item => ({ ...item, leadId: null, customerWorkId: workspaceId(70), ...(section === 'invoices' ? {} : { workVersion: 1 }) })) });
  } });
  expect((await screen.findByRole('link', { name: 'New customer estimate' })).getAttribute('href')).toBe(`/estimates?new=customer&contactId=${contact}&organizationId=${org}`);
  expect((await screen.findByRole('link', { name: 'Open estimate' })).getAttribute('href')).toBe(`/estimates?estimateId=${workspaceId(8)}&organizationId=${org}`);
  expect(screen.queryByRole('link', { name: 'Open related opportunity' })).toBeNull();
  await select('Jobs'); expect((await screen.findByRole('link', { name: 'Open job' })).getAttribute('href')).toBe(`/projects?projectId=${workspaceId(7)}&organizationId=${org}`); expect(screen.getByRole('link', { name: 'New customer job' }).getAttribute('href')).toBe(`/projects?new=customer&contactId=${contact}&organizationId=${org}`);
  await select('Invoices'); await screen.findByRole('link', { name: 'Open invoice' }); expect(screen.getByRole('link', { name: 'New customer invoice' }).getAttribute('href')).toBe(`/invoices?new=customer&contactId=${contact}&organizationId=${org}`);
  expect(within(screen.getByRole('navigation', { name: 'Customer record sections' })).getAllByRole('link')).toHaveLength(9);
  expect(document.querySelector('a[href*="leads/null"]')).toBeNull();
});

it('keeps calendar coverage dates intact and renders customer content as inert text on a narrow-width-safe card', async () => {
  const { state } = setup({ search: `?organizationId=${org}&section=services` });
  const service = workspacePage('services'); service.items[0].equipmentLabel = '<script>do something unsafe</script>';
  state.respond = url => url.pathname.endsWith('/services') ? json(service) : undefined;
  await screen.findByText('<script>do something unsafe</script>');
  expect(screen.getByText('Recorded coverage: Jan 1, 2026 – Jan 1, 2027')).toBeTruthy();
  expect(screen.getByText(/not a determination of warranty eligibility/)).toBeTruthy();
  const card = screen.getByText('<script>do something unsafe</script>').closest('article')!;
  expect(card.className).toContain('min-w-0'); expect(card.className).toContain('break-words');
  expect(card.querySelector('script')).toBeNull();
});

it('shows the service calendar due date without inventing an appointment time in a non-UTC company', async () => {
  const service = workspacePage('services'); service.items[0].dueAt = '2026-06-01T12:00:00.000Z';
  setup({ search: `?organizationId=${org}&section=services`, respond: url => url.pathname.endsWith('/services') ? json(service) : undefined });
  const due = await screen.findByText('Service due: Jun 1, 2026');
  expect(due.textContent).not.toMatch(/\d+:\d+|AM|PM/);
  expect(screen.getByText(/Times use America\/New_York/)).toBeTruthy();
  await select('Visits');
  expect(await screen.findByText('Visit start: Oct 5, 2026, 11:00 AM')).toBeTruthy();
});

it('pages by only the returned opaque cursor, supports newer/older navigation and preserves the page across unchanged member refresh', async () => {
  const first = workspacePage('appointments'); first.hasMore = true; first.nextCursor = 'opaque_cursor_two';
  const second = workspacePage('appointments'); second.items[0].id = workspaceId(24); second.items[0].type = 'inspection';
  const { client, calls } = setup({ respond: url => url.pathname.endsWith('/appointments') ? json(url.searchParams.has('cursor') ? second : first) : undefined });
  await screen.findByRole('link', { name: 'Open visit' }); fireEvent.click(screen.getByRole('button', { name: 'Older records' }));
  await screen.findByText('inspection visit'); expect(screen.getByText('Page 2')).toBeTruthy();
  expect(calls).toContain(`/api/v1/contacts/${contact}/workspace/appointments?cursor=opaque_cursor_two`);
  await act(async () => { await client.invalidateQueries({ queryKey: getGetMeQueryKey() }); });
  expect(screen.getByText('Page 2')).toBeTruthy(); expect(screen.getByText('inspection visit')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Newer page' })); await screen.findByText('other visit');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Older records' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Older records' })); await screen.findByText('inspection visit');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh record' })); await screen.findByText('other visit'); expect(screen.getByText('Page 1')).toBeTruthy();
});

it('retains section in the URL for reload/back, resetting the cursor chain when sections change', async () => {
  setup(); await screen.findByRole('link', { name: 'Open visit' }); await select('Tasks'); await screen.findByRole('link', { name: 'Open task' });
  expect(window.location.search).toBe(`?organizationId=${org}&section=tasks`);
  await act(async () => { window.history.replaceState(null, '', `${basePath}&section=appointments`); });
  await screen.findByRole('link', { name: 'Open visit' }); expect(screen.getByText('Page 1')).toBeTruthy();
});

it.each(['viewer', 'sales_rep', 'inspector', 'production'])('does not request or display invoices for %s even if a stale header advertises them', async role => {
  const { calls } = setup({ role, search: `?organizationId=${org}&section=invoices` });
  await screen.findByText('This section is not available to your current role');
  expect(screen.queryByRole('link', { name: 'Invoices', exact: true })).toBeNull(); expect(recordCalls(calls)).toEqual([]);
});

it('removes a displayed restricted section on a real role change; profile errors and revocation also fail closed with cached profile data', async () => {
  const { state, client, calls } = setup({ search: `?organizationId=${org}&section=invoices` });
  await screen.findByRole('link', { name: 'Open invoice' }); const before = recordCalls(calls).length;
  state.role = 'viewer'; await act(async () => { await client.invalidateQueries({ queryKey: getGetMeQueryKey() }); });
  await screen.findByText('This section is not available to your current role'); expect(screen.queryByText('Synthetic service invoice')).toBeNull();
  expect(recordCalls(calls)).toHaveLength(before);
  state.meStatus = 503; await act(async () => { await client.invalidateQueries({ queryKey: getGetMeQueryKey() }); });
  await screen.findByText(/Current company access could not be verified/); expect(screen.queryByText('Morgan Synthetic Customer')).toBeNull();
  state.meStatus = 200; state.active = false; await act(async () => { await client.invalidateQueries({ queryKey: getGetMeQueryKey() }); });
  expect(screen.queryByText('Morgan Synthetic Customer')).toBeNull();
});

it('does not follow a pinned link into a changed company', async () => {
  const { state, client, calls } = setup(); await screen.findByRole('link', { name: 'Open visit' }); const before = calls.length;
  state.organizationId = workspaceId(99); await act(async () => { await client.invalidateQueries({ queryKey: getGetMeQueryKey() }); });
  await screen.findByText(/This link belongs to a different company/); expect(screen.queryByText('Morgan Synthetic Customer')).toBeNull();
  expect(calls.slice(before).filter(path => path.includes('/workspace'))).toEqual([]);
});

it.each([`?organizationId=${workspaceId(99)}`, '?organizationId=bad', `?organizationId=${org}&section=bad`, `?organizationId=${org}&section=tasks&section=tasks`, `?organizationId=${org}&cursor=bad`])('rejects foreign or invalid URL context before customer reads: %s', async search => {
  const { calls } = setup({ search }); await screen.findByRole('alert'); expect(calls.filter(path => path.includes('/workspace'))).toEqual([]);
});

it('rejects a malformed customer ID before customer reads', async () => {
  const { calls } = setup({ id: 'bad' }); await screen.findByRole('alert'); expect(calls.filter(path => path.includes('/workspace'))).toEqual([]);
});

it.each(['organization', 'customer', 'section', 'appointment-customer', 'duplicate-record', 'extra-private-data', 'cursor-loop'])('rejects a %s response mismatch instead of showing records', async mismatch => {
  const page: any = workspacePage('appointments');
  if (mismatch === 'organization') page.organizationId = workspaceId(99);
  if (mismatch === 'customer') page.contactId = workspaceId(99);
  if (mismatch === 'section') page.section = 'tasks';
  if (mismatch === 'appointment-customer') page.items[0].contactId = workspaceId(99);
  if (mismatch === 'duplicate-record') page.items.push({ ...page.items[0] });
  if (mismatch === 'extra-private-data') page.items[0].notes = 'Must not display';
  if (mismatch === 'cursor-loop') { page.hasMore = false; page.nextCursor = 'contradictory_cursor'; }
  setup({ respond: url => url.pathname.endsWith('/appointments') ? json(page) : undefined });
  await screen.findByText(/This page could not be verified/); expect(screen.queryByRole('link', { name: 'Open visit' })).toBeNull(); expect(screen.queryByText('Must not display')).toBeNull();
});

it('rejects a different-customer header without requesting any section', async () => {
  const { calls } = setup({ respond: url => url.pathname.endsWith('/workspace') ? json(workspaceHeader(workspaceId(99))) : undefined });
  await screen.findByRole('alert'); expect(recordCalls(calls)).toEqual([]); expect(screen.queryByText('Morgan Synthetic Customer')).toBeNull();
});

it('ignores a late old-section response after switching sections', async () => {
  let resolve!: (value: Response) => void;
  const pending = new Promise<Response>(done => { resolve = done; });
  setup({ respond: url => url.pathname.endsWith('/appointments') ? pending : undefined });
  await screen.findByText('Loading visits…'); await select('Tasks'); await screen.findByRole('link', { name: 'Open task' });
  await act(async () => { resolve(json(workspacePage('appointments'))); await pending; });
  expect(screen.queryByRole('link', { name: 'Open visit' })).toBeNull(); expect(screen.getByRole('link', { name: 'Open task' })).toBeTruthy();
});

it('ignores late old-customer work when navigating to a different customer', async () => {
  let resolve!: (value: Response) => void; const pending = new Promise<Response>(done => { resolve = done; }); const other = workspaceId(55);
  const { state } = setup({ respond: url => url.pathname.endsWith(`/contacts/${contact}/workspace/appointments`) ? pending : undefined });
  await screen.findByText('Loading visits…');
  state.respond = url => {
    if (url.pathname === `/api/v1/contacts/${other}/workspace`) { const header = workspaceHeader(other); header.contact.firstName = 'Different'; return json(header); }
    if (url.pathname === `/api/v1/contacts/${other}/workspace/appointments`) { const page = workspacePage('appointments', other); page.items = []; return json(page); }
    return undefined;
  };
  await act(async () => { window.history.pushState(null, '', `/contacts/${other}?organizationId=${org}`); });
  await screen.findByText('Different Synthetic Customer'); await act(async () => { resolve(json(workspacePage('appointments'))); await pending; });
  expect(screen.queryByText('Morgan Synthetic Customer')).toBeNull(); expect(screen.queryByRole('link', { name: 'Open visit' })).toBeNull();
});

it('shows a truthful empty section and supports retry after an offline page failure', async () => {
  const { state } = setup({ respond: url => url.pathname.endsWith('/appointments') ? json({ error: 'offline' }, 503) : undefined });
  await screen.findByText(/This page could not be verified/);
  state.respond = url => { if (!url.pathname.endsWith('/appointments')) return undefined; const page = workspacePage('appointments'); page.items = []; return json(page); };
  fireEvent.click(screen.getByRole('button', { name: 'Try page again' }));
  await screen.findByText('No visits records on this page for this customer.'); expect(screen.queryByText('Page 0')).toBeNull();
});

it('rejects a hidden financial activity for a role without invoice access', async () => {
  const page = workspacePage('activity'); page.items[0].category = 'invoice'; page.items[0].label = 'Invoice updated';
  setup({ role: 'viewer', search: `?organizationId=${org}&section=activity`, respond: url => url.pathname.endsWith('/activity') ? json(page) : undefined });
  await screen.findByText(/This page could not be verified/); expect(screen.queryByText('Invoice updated')).toBeNull();
});
