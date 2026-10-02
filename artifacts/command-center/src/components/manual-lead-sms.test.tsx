import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/test/render';
import { ManualLeadSms, manualSmsBlockedReason } from './manual-lead-sms';

const org = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const lead = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const templates = [
  { id: 'first-response', title: 'First response', body: 'Hi, thank you for your inquiry. How can we help?' },
  { id: 'arrange-visit', title: 'Arrange a visit', body: 'What day works for discussing a visit?' },
  { id: 'follow-up', title: 'Follow up', body: 'Do you still need help with your service request?' },
];
const response = { allowed: true, reason: null, phoneE164: '+14045550100', templates, orgId: org };

function setup(options: { role?: boolean; get?: Partial<typeof response>; post?: Partial<typeof response> & { prepared?: boolean; templateId?: string }; postStatus?: number; failed?: boolean } = {}) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({ ...response, ...(init?.method === 'POST' ? { prepared: true, templateId: 'first-response', ...options.post } : options.get) }), { status: options.failed ? 503 : init?.method === 'POST' ? options.postStatus ?? 200 : 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  const rendered = renderWithQuery(<ManualLeadSms leadId={lead} organizationId={org} canWrite={options.role !== false} />);
  return { fetchMock, ...rendered };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function selectAndConfirm() {
  fireEvent.click(await screen.findByRole('button', { name: 'First response' }));
  fireEvent.click(screen.getByRole('checkbox'));
}

describe('manual lead SMS review', () => {
  it('offers exactly three editable drafts and no send is made or claimed', async () => {
    const { fetchMock } = setup();
    await selectAndConfirm();
    expect(screen.getByRole('button', { name: 'Arrange a visit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Follow up' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello & welcome' } });
    expect(screen.queryByRole('link', { name: 'Open phone messages' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare phone text' }));
    const link = await screen.findByRole('link', { name: 'Open phone messages' });
    expect(link.getAttribute('href')).toBe('sms:+14045550100?body=Hello%20%26%20welcome');
    expect(screen.getByText(/Draft prepared only/)).toBeTruthy();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe(`/api/v1/leads/${lead}/manual-sms/draft-opened`);
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ templateId: 'first-response', confirmedServiceReply: true });
    expect(fetchMock.mock.calls.every(([url]) => !url.includes('/send'))).toBe(true);
  });
  it('requires the visible human confirmation before preparation', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'First response' }));
    expect((screen.getByRole('button', { name: 'Prepare phone text' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('fresh suppression blocks a previously eligible contact before composer handoff', async () => {
    setup({ post: { allowed: false, reason: 'suppressed:stop_keyword', prepared: false } as never, postStatus: 409 });
    await selectAndConfirm();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare phone text' }));
    await screen.findByText('This customer opted out of text messages. Do not text this number.');
    expect(screen.queryByRole('link', { name: 'Open phone messages' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText('suppressed:stop_keyword')).toBeNull();
  });
  it('does not fetch drafts for a read-only role', async () => {
    const { fetchMock } = setup({ role: false });
    expect(screen.getByText('Your role cannot prepare customer outreach.')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('fails closed on wrong-company or missing eligibility', async () => {
    setup({ get: { orgId: lead } });
    await screen.findByText('This contact belongs to a different account.');
    expect(screen.queryByRole('button', { name: 'First response' })).toBeNull();
  });
  it('does not expose a composer after an eligibility error', async () => {
    setup({ failed: true });
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'First response' })).toBeNull();
  });
  it('clears a prepared link when changing draft or editing', async () => {
    setup(); await selectAndConfirm();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare phone text' }));
    await screen.findByRole('link', { name: 'Open phone messages' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Changed draft' } });
    expect(screen.queryByRole('link', { name: 'Open phone messages' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Follow up' }));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });
  it('expires the link after returning later and always keeps copy fallback visible', async () => {
    setup(); await selectAndConfirm();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare phone text' }));
    await screen.findByRole('link', { name: 'Open phone messages' });
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy();
    const future = Date.now() + 61_000;
    vi.spyOn(Date, 'now').mockReturnValue(future);
    fireEvent.focus(window);
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Open phone messages' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy();
  });
  it('removes a copyable draft if fresh permission checking fails', async () => {
    setup({ postStatus: 503 }); await selectAndConfirm();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare phone text' }));
    await screen.findByText(/Contact permission could not be verified/);
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('gives plain-language blocked reasons and never echoes arbitrary server reason content', () => {
    expect(manualSmsBlockedReason('no_sms_consent')).toContain('permission has not been recorded');
    expect(manualSmsBlockedReason('do_not_contact_sms')).toContain('do not text');
    expect(manualSmsBlockedReason('invalid_phone')).toContain('incomplete or invalid');
    expect(manualSmsBlockedReason('sensitive arbitrary server value')).not.toContain('sensitive arbitrary');
  });
});
