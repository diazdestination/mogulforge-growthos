import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('./zapier-flow-actions', () => ({ ZapierFlowActions: () => null }));
// Keep the tests focused on setup decisions, with native keyboard-accessible selects.
vi.mock('@/components/ui/select', () => ({
  Select: ({ children, value, onValueChange, disabled }: any) => <select aria-label="Action or policy" value={value} disabled={disabled} onChange={event => onValueChange(event.target.value)}>{children}</select>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ value, children }: any) => <option value={value}>{children}</option>,
}));
import { ZapierConnectedAppsCard } from './zapier-connected-apps-card';

const status = { configured: true, embedId: 'fixture-embed', connected: true, serverMode: 'agentic', toolCount: 1, connectedAt: null, lastUsedAt: null, lastErrorAt: null, lastErrorCode: null };
const capability = { key: 'appt.calendar.create_event', specialistId: 'appt', direction: 'write', label: 'Book calendar events', description: 'Send a scheduled visit to your calendar.', candidates: [{ app: 'googlecalendar', appName: 'Google Calendar', action: 'create_event', actionName: 'Create Event', configFields: [{ key: 'calendarid', label: 'Calendar', required: true }] }], binding: null, policy: { mode: 'off', dailyBudget: 20, updatedAt: null } };
const action = { app: 'googlecalendar', appName: 'Google Calendar', action: 'create_event', actionName: 'Create Event', actionType: 'write', description: null };
const signUp = { email: null, firstName: null, lastName: null };
let connected = true;
let liveActions: any[] = [action];
let actionsResponse: (() => Promise<Response>) | undefined;
let registerResponse: (() => Promise<Response>) | undefined;
const response = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 502, json: async () => body }) as Response;
const calls = (suffix: string) => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith(suffix));
const embed = () => document.querySelector('zapier-mcp')!;
const event = async (name: string, detail?: unknown) => { await act(async () => { embed().dispatchEvent(new CustomEvent(name, { detail })); }); };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

beforeEach(() => {
  connected = true; liveActions = [action]; actionsResponse = undefined; registerResponse = undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/server-url')) return registerResponse ? registerResponse() : response({ ...status, connected: connected = true });
    if (url.endsWith('/actions')) return actionsResponse ? actionsResponse() : response({ actions: liveActions });
    if (url.endsWith('/capabilities')) return response({ capabilities: [capability] });
    if (url.includes('/executions?')) return response({ executions: [] });
    if (init?.method === 'DELETE') connected = false;
    return response({ ...status, connected });
  }));
});
afterEach(() => { cleanup(); document.querySelectorAll('script[src*="mcp.zapier.com"]').forEach(script => script.remove()); vi.unstubAllGlobals(); vi.restoreAllMocks(); toast.mockReset(); });

describe('client Zapier setup', () => {
  it('discovers enabled actions automatically without granting any action authority', async () => {
    render(<ZapierConnectedAppsCard signUp={signUp} canManage />);
    await waitFor(() => expect(calls('/actions')).toHaveLength(1));
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method)).toBe(true);
    expect(screen.getByText(/Connect your own Zapier account/)).toBeTruthy();
    expect(screen.getByText(/Connection alone does not enable/)).toBeTruthy();
  });

  it('refreshes on tools-changed and preserves the same embed during refresh', async () => {
    render(<ZapierConnectedAppsCard signUp={signUp} canManage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage apps in Zapier' }));
    const original = embed();
    await event('tools-changed');
    await waitFor(() => expect(calls('/actions').length).toBeGreaterThanOrEqual(2));
    expect(embed()).toBe(original);
  });

  it('keeps setup open after registration and discovers tools changed before registration', async () => {
    connected = false;
    const pending = deferred<Response>(); registerResponse = () => pending.promise;
    render(<ZapierConnectedAppsCard signUp={signUp} canManage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Zapier' }));
    const original = embed();
    await event('mcp-server-url', { serverUrl: 'https://mcp.zapier.com/api/mcp/fixture' });
    await event('tools-changed');
    connected = true;
    await act(async () => pending.resolve(response(status)));
    await waitFor(() => expect(calls('/actions').length).toBeGreaterThan(0));
    expect(embed()).toBe(original);
  });

  it('offers an actual script retry after a failed load', async () => {
    render(<ZapierConnectedAppsCard signUp={signUp} canManage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage apps in Zapier' }));
    const failed = document.querySelector('script[src*="mcp.zapier.com"]')!;
    fireEvent.error(failed);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry loading Zapier' }));
    await waitFor(() => expect(document.querySelector('script[src*="mcp.zapier.com"]')).not.toBe(failed));
  });

  it('refreshes again for a tools change received after discovery starts during registration', async () => {
    connected = false;
    liveActions = [];
    render(<ZapierConnectedAppsCard signUp={signUp} canManage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Zapier' }));
    const pendingStatus = deferred<Response>();
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, init) => String(url).endsWith('/integrations/zapier') && !init?.method ? pendingStatus.promise : originalFetch(url, init));
    await event('mcp-server-url', { serverUrl: 'https://mcp.zapier.com/api/mcp/fixture' });
    await waitFor(() => expect(calls('/actions')).toHaveLength(1));
    liveActions = [action];
    await event('tools-changed');
    await act(async () => pendingStatus.resolve(response(status)));
    await waitFor(() => expect(calls('/actions')).toHaveLength(2));
    await screen.findByRole('button', { name: 'Save flow' });
  });

  it('shows supported app/action and missing setup guidance even before connection', async () => {
    connected = false;
    render(<ZapierConnectedAppsCard signUp={signUp} canManage />);
    await screen.findByRole('button', { name: 'Connect Zapier' });
    expect(screen.getByText(/Google Calendar → Create Event/)).toBeTruthy();
    expect(screen.getByText(/Add the app and enable its listed action/)).toBeTruthy();
  });

  it('blocks saving missing or whitespace-only required configuration and links its label', async () => {
    render(<ZapierConnectedAppsCard signUp={signUp} canManage />);
    // Clicking Reload keeps this regression independent of automatic discovery.
    fireEvent.click(await screen.findByRole('button', { name: /(?:Load|Reload) enabled actions/ }));
    await screen.findByRole('button', { name: 'Save flow' });
    const selects = await screen.findAllByRole('combobox');
    fireEvent.change(selects.at(-1)!, { target: { value: 'googlecalendar::create_event' } });
    const save = screen.getByRole('button', { name: 'Save flow' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const calendar = screen.getByLabelText(/Calendar \*/);
    fireEvent.change(calendar, { target: { value: '   ' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(calendar, { target: { value: 'primary' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(calls('/binding')).toHaveLength(1));
    expect(JSON.parse(String(calls('/binding')[0][1]?.body))).toEqual({ app: 'googlecalendar', action: 'create_event', config: { calendarid: 'primary' } });
    expect(calls('/policy')).toHaveLength(0);
  });

  it('does not offer an action with the wrong read/write direction', async () => {
    liveActions = [{ ...action, actionType: 'read' }];
    render(<ZapierConnectedAppsCard signUp={signUp} canManage />);
    fireEvent.click(await screen.findByRole('button', { name: /(?:Load|Reload) enabled actions/ }));
    await screen.findByText(/None of your enabled Zapier actions match/);
    expect(screen.queryByRole('button', { name: 'Save flow' })).toBeNull();
  });

  it('explains manager access and never requests manager-only actions for a read-only member', async () => {
    render(<ZapierConnectedAppsCard signUp={signUp} canManage={false} />);
    expect(await screen.findByText(/Ask an owner or administrator/)).toBeTruthy();
    expect(calls('/actions')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Manage apps in Zapier' })).toBeNull();
  });

  it('offers action discovery recovery without misreporting an unavailable provider as no matching apps', async () => {
    actionsResponse = async () => response({ error: 'Zapier authorization expired' }, false);
    render(<ZapierConnectedAppsCard signUp={signUp} canManage />);
    await screen.findByText('Could not discover enabled actions');
    expect(screen.queryByText(/None of your enabled Zapier actions match/)).toBeNull();
    actionsResponse = undefined;
    fireEvent.click(screen.getByRole('button', { name: /(?:Load|Reload) enabled actions/ }));
    await screen.findByRole('button', { name: 'Save flow' });
    expect(screen.queryByText('Could not discover enabled actions')).toBeNull();
  });

  it('keeps the same usable embed while status refresh is pending', async () => {
    render(<ZapierConnectedAppsCard signUp={signUp} canManage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage apps in Zapier' }));
    const original = embed();
    const pending = deferred<Response>();
    vi.mocked(fetch).mockImplementationOnce(() => pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(embed()).toBe(original);
    await act(async () => pending.resolve(response(status)));
    expect(embed()).toBe(original);
  });

  it('ignores a late registration failure after close without an error toast', async () => {
    connected = false;
    const pending = deferred<Response>(); registerResponse = () => pending.promise;
    render(<ZapierConnectedAppsCard signUp={signUp} canManage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Zapier' }));
    await event('mcp-server-url', { serverUrl: 'https://mcp.zapier.com/api/mcp/fixture' });
    await event('close-requested');
    await act(async () => pending.resolve(response({ error: 'Late registration failure' }, false)));
    expect(toast).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Connect Zapier' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('ignores an action discovery result after disconnect', async () => {
    render(<ZapierConnectedAppsCard signUp={signUp} canManage />);
    await screen.findByRole('button', { name: /(?:Load|Reload) enabled actions/ });
    const pending = deferred<Response>(); actionsResponse = () => pending.promise;
    fireEvent.click(screen.getByRole('button', { name: /(?:Load|Reload) enabled actions/ }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await screen.findByRole('button', { name: 'Connect Zapier' });
    await act(async () => pending.resolve(response({ actions: [action] })));
    expect(screen.queryByRole('button', { name: 'Save flow' })).toBeNull();
  });

  it('ignores a late registration response after the embed requests close', async () => {
    connected = false;
    const pending = deferred<Response>(); registerResponse = () => pending.promise;
    render(<ZapierConnectedAppsCard signUp={signUp} canManage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Zapier' }));
    await event('mcp-server-url', { serverUrl: 'https://mcp.zapier.com/api/mcp/fixture' });
    await event('close-requested');
    await act(async () => pending.resolve(response(status)));
    expect(embed()).toBeNull();
    expect(screen.queryByText('Zapier connected')).toBeNull();
    expect(calls('/actions')).toHaveLength(0);
  });

  it('sets crew phones by eligible member name and validates the phone without exposing raw ids', async () => {
    const crewCandidate = { app: 'twilio', appName: 'Twilio', action: 'send_sms', actionName: 'Send SMS', configFields: [] };
    liveActions = [{ ...crewCandidate, actionType: 'write' }];
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/capabilities')) return response({ capabilities: [{ ...capability, key: 'sched.sms.send', specialistId: 'sched', candidates: [crewCandidate] }] });
      if (String(url).endsWith('/users')) return response([{ id: 'private-crew-id', firstName: 'Fictional', lastName: 'Crew', email: 'crew@example.test', isActive: true, operationallyEligible: true }, { id: 'ineligible-id', firstName: 'Unavailable', isActive: false, operationallyEligible: true }]);
      return originalFetch(url, init);
    });
    render(<ZapierConnectedAppsCard signUp={signUp} canManage />);
    await screen.findByRole('button', { name: 'Save flow' });
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'twilio::send_sms' } });
    const member = await screen.findByLabelText('Crew member');
    await screen.findByRole('option', { name: 'Fictional Crew' });
    expect(screen.queryByText('private-crew-id')).toBeNull();
    expect(screen.queryByRole('option', { name: 'Unavailable' })).toBeNull();
    fireEvent.change(member, { target: { value: 'private-crew-id' } });
    fireEvent.change(screen.getByLabelText('Mobile phone'), { target: { value: '555' } });
    expect((screen.getByRole('button', { name: 'Add crew phone' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Mobile phone'), { target: { value: '+14045550100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add crew phone' }));
    expect(screen.getByText(/Fictional Crew.*14045550100/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove phone for Fictional Crew' }));
    expect(screen.queryByText(/Fictional Crew.*14045550100/)).toBeNull();
  });
});
