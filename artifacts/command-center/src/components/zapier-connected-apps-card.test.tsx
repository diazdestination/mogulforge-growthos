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

const status = { configured: true, provisioning: 'mogulforge', connectionFingerprint: 'opaque-v1', connected: true, serverMode: 'agentic', toolCount: 1, connectedAt: null, lastUsedAt: null, lastErrorAt: null, lastErrorCode: null };
const capability = { key: 'appt.calendar.create_event', specialistId: 'appt', direction: 'write', label: 'Book calendar events', description: 'Send a scheduled visit to your calendar.', candidates: [{ app: 'googlecalendar', appName: 'Google Calendar', action: 'create_event', actionName: 'Create Event', configFields: [{ key: 'calendarid', label: 'Calendar', required: true }] }], binding: null, policy: { mode: 'off', dailyBudget: 20, updatedAt: null } };
const action = { app: 'googlecalendar', appName: 'Google Calendar', action: 'create_event', actionName: 'Create Event', actionType: 'write', description: null };
let connected = true;
let liveActions: any[] = [action];
let actionsResponse: (() => Promise<Response>) | undefined;
const response = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 502, json: async () => body }) as Response;
const calls = (suffix: string) => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith(suffix));
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

beforeEach(() => {
  connected = true; liveActions = [action]; actionsResponse = undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
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
    render(<ZapierConnectedAppsCard canManage />);
    await waitFor(() => expect(calls('/actions')).toHaveLength(1));
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method)).toBe(true);
    expect(screen.getByText('Managed by MogulForge')).toBeTruthy();
    expect(screen.getByText(/Saving the flow sets its policy to Off/)).toBeTruthy();
    expect(document.querySelector('zapier-mcp, script[src*="mcp.zapier.com"], [sign-up-email]')).toBeNull();
    expect(screen.queryByRole('button', { name: /Connect Zapier|Manage apps in Zapier|Enable action|Search actions/ })).toBeNull();
  });

  it('recommends Automatic only for the tap-sent field texts, without switching them on', async () => {
    const onMyWay = { ...capability, key: 'appt.sms.on_my_way', label: 'Text On My Way', recommendedMode: 'auto', candidates: [{ app: 'OpenPhoneCLIAPI', appName: 'Quo', action: 'send_message', actionName: 'Send Message', configFields: [] }] };
    const reminder = { ...capability, key: 'appt.sms.send', label: 'Text appointment reminders', recommendedMode: 'approve', candidates: onMyWay.candidates };
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url: any, init?: RequestInit) => String(url).endsWith('/capabilities') ? response({ capabilities: [onMyWay, reminder] }) : base(url, init));
    render(<ZapierConnectedAppsCard canManage />);
    expect(await screen.findAllByText(/Recommended: Automatic/)).toHaveLength(1);
    expect(screen.getAllByText(/Configured · Off|Select and configure a supported action/).length).toBeGreaterThan(0);
  });

  it('requires the texting registration checkbox before CALLIE text-back can leave Off, and saves who confirmed it', async () => {
    const quo = [{ app: 'OpenPhoneCLIAPI', appName: 'Quo', action: 'send_message', actionName: 'Send Message', configFields: [] }];
    let registered = false;
    const textBack = () => ({ messagingRegistered: registered, registeredByName: registered ? 'Test Owner' : null, registeredAt: registered ? '2026-11-10T15:00:00.000Z' : null, windowHours: 24, windowChoices: [12, 24, 48, 72] });
    const callie = () => ({ ...capability, key: 'callie.sms.send', specialistId: 'callie', label: 'Text back missed callers', candidates: quo, binding: { app: 'OpenPhoneCLIAPI', appName: 'Quo', action: 'send_message', actionName: 'Send Message', config: {}, boundAt: '2026-11-10T00:00:00Z' }, textBack: textBack() });
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url: any, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/capabilities')) return response({ capabilities: [callie()] });
      if (path.endsWith('/callie/text-back-settings')) { registered = JSON.parse(String(init!.body)).messagingRegistered; return response({ textBack: textBack() }); }
      return base(url, init);
    });
    render(<ZapierConnectedAppsCard canManage />);
    const box = await screen.findByRole('checkbox', { name: /business texting is registered \(required\)/i });
    expect(box.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/A2P 10DLC brand and campaign \(Twilio\) or completed Quo business-texting registration/)).toBeTruthy();
    expect(screen.getByText(/Not confirmed · missed-call text-back stays Off/)).toBeTruthy();
    expect(screen.getByText(/Built to support texting rules, not a guarantee of legal compliance/)).toBeTruthy();
    expect(screen.queryByText(/guarantees? legal compliance\b(?!,)/)).toBeNull();
    // Policy stays locked at Off until registration is confirmed.
    const policy = screen.getAllByLabelText('Action or policy').find(select => (select as HTMLSelectElement).value === 'off') as HTMLSelectElement;
    expect(policy.disabled).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(calls('/callie/text-back-settings')).toHaveLength(1));
    expect(calls('/callie/text-back-settings')[0]![1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ messagingRegistered: true }) });
    expect(await screen.findByText(/Confirmed by Test Owner on/)).toBeTruthy();
    await waitFor(() => expect((screen.getAllByLabelText('Action or policy').find(select => (select as HTMLSelectElement).value === 'off') as HTMLSelectElement).disabled).toBe(false));
    const windowSelect = screen.getByLabelText('Text-back window') as HTMLSelectElement;
    expect(Array.from(windowSelect.options).map(option => option.textContent)).toEqual(['At most one text per caller every 12 hours', 'At most one text per caller every 24 hours', 'At most one text per caller every 2 days', 'At most one text per caller every 3 days']);
    fireEvent.change(windowSelect, { target: { value: '48' } });
    await waitFor(() => expect(calls('/callie/text-back-settings')).toHaveLength(2));
    expect(calls('/callie/text-back-settings')[1]![1]).toMatchObject({ body: JSON.stringify({ messagingRegistered: true, windowHours: 48 }) });
  });

  it('shows the CALLIE registration state read-only to members who cannot manage settings', async () => {
    const callie = { ...capability, key: 'callie.sms.send', specialistId: 'callie', label: 'Text back missed callers', textBack: { messagingRegistered: false, registeredByName: null, registeredAt: null, windowHours: 24, windowChoices: [12, 24, 48, 72] } };
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url: any, init?: RequestInit) => String(url).endsWith('/capabilities') ? response({ capabilities: [callie] }) : base(url, init));
    render(<ZapierConnectedAppsCard canManage={false} />);
    const box = await screen.findByRole('checkbox', { name: /business texting is registered/i });
    expect((box as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Text-back window') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(box);
    expect(calls('/callie/text-back-settings')).toHaveLength(0);
  });

  it('shows supported app/action and missing setup guidance even before connection', async () => {
    connected = false;
    vi.mocked(fetch).mockImplementationOnce(async () => response({ ...status, connected: false, configured: false, provisioning: 'unassigned', connectionFingerprint: null }));
    render(<ZapierConnectedAppsCard canManage />);
    await screen.findByText('Awaiting MogulForge setup');
    expect(screen.getByText(/Google Calendar → Create Event/)).toBeTruthy();
    expect(screen.getByText(/Contact MogulForge to connect your apps/)).toBeTruthy();
  });

  it('blocks saving missing or whitespace-only required configuration and links its label', async () => {
    render(<ZapierConnectedAppsCard canManage />);
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
    render(<ZapierConnectedAppsCard canManage />);
    fireEvent.click(await screen.findByRole('button', { name: /(?:Load|Reload) enabled actions/ }));
    await screen.findByText(/Contact MogulForge to make a supported app available/);
    expect(screen.queryByRole('button', { name: 'Save flow' })).toBeNull();
  });

  it('explains manager access and never requests manager-only actions for a read-only member', async () => {
    render(<ZapierConnectedAppsCard canManage={false} />);
    expect(await screen.findByText(/An owner or administrator/)).toBeTruthy();
    expect(calls('/actions')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Manage apps in Zapier' })).toBeNull();
  });

  it('offers action discovery recovery without misreporting an unavailable provider as no matching apps', async () => {
    actionsResponse = async () => response({ error: 'Zapier authorization expired' }, false);
    render(<ZapierConnectedAppsCard canManage />);
    await screen.findByText('Could not load available actions');
    expect(screen.queryByText(/Contact MogulForge to make a supported app available/)).toBeNull();
    actionsResponse = undefined;
    fireEvent.click(screen.getByRole('button', { name: /(?:Load|Reload) enabled actions/ }));
    await screen.findByRole('button', { name: 'Save flow' });
    expect(screen.queryByText('Could not load available actions')).toBeNull();
  });

  it('ignores an action discovery result after disconnect', async () => {
    render(<ZapierConnectedAppsCard canManage />);
    await screen.findByRole('button', { name: /(?:Load|Reload) enabled actions/ });
    const pending = deferred<Response>(); actionsResponse = () => pending.promise;
    fireEvent.click(screen.getByRole('button', { name: /(?:Load|Reload) enabled actions/ }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(calls('/integrations/zapier').filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await screen.findByText('Disconnected');
    await act(async () => pending.resolve(response({ actions: [action] })));
    expect(screen.queryByRole('button', { name: 'Save flow' })).toBeNull();
  });

  it('labels a legacy connection for review and preserves business approval', async () => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    const pending = { id: 'action-1', specialistId: 'appt', capability: 'Calendar booking', state: 'pending_approval', requestSummary: { customer: 'Fixture' }, createdAt: new Date().toISOString() };
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/integrations/zapier')) return response({ ...status, provisioning: 'legacy', configured: false, serverMode: 'managed' });
      if (String(url).includes('/executions?')) return response({ executions: [pending] });
      return base(url, init);
    });
    const view = render(<ZapierConnectedAppsCard key="reader" canManage={false} />);
    await screen.findByText('Connection needs review');
    expect(screen.queryByText('Managed by MogulForge')).toBeNull();
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    view.rerender(<ZapierConnectedAppsCard key="owner" canManage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls('/executions/action-1/approve')).toHaveLength(1));
    expect(calls('/executions/action-1/approve')[0]?.[1]?.method).toBe('POST');
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
    render(<ZapierConnectedAppsCard canManage />);
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
  it('changes the automatic sync interval only for managers, from the offered choices', async () => {
    const polled = { ...status, pollIntervalMinutes: 240, pollIntervalChoices: [60, 240, 1440] };
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/actions')) return response({ actions: liveActions });
      if (path.endsWith('/capabilities')) return response({ capabilities: [capability] });
      if (path.includes('/executions?')) return response({ executions: [] });
      return response(polled);
    });
    const view = render(<ZapierConnectedAppsCard canManage />);
    const select = await screen.findByLabelText('Automatic sync interval') as HTMLSelectElement;
    expect(select.value).toBe('240');
    expect(Array.from(select.options).map(option => option.textContent)).toEqual(['Every hour', 'Every 4 hours', 'Every 24 hours']);
    fireEvent.change(select, { target: { value: '60' } });
    await waitFor(() => expect(calls('/poll-interval')).toHaveLength(1));
    expect(calls('/poll-interval')[0]![1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ minutes: 60 }) });
    view.unmount();
    render(<ZapierConnectedAppsCard canManage={false} />);
    expect(((await screen.findByLabelText('Automatic sync interval')) as HTMLSelectElement).disabled).toBe(true);
  });
});
