import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ListServiceSmsRepliesResponse, ReviewServiceSmsReplyBody } from '../../../../lib/api-zod/src/generated/api';
import ServiceSmsRepliesPanel from './service-sms-replies-panel';
import { mockApi } from '@/test/mock-api';
import { renderWithQuery } from '@/test/render';
import { scopeKey, secondServiceId, serviceId, smsPage, smsReply } from '@/test/service-standing-fixtures';

function mount(editable = true) { return renderWithQuery(<ServiceSmsRepliesPanel obligationId={serviceId} scopeKey={scopeKey} editable={editable} onChanged={vi.fn(async () => {})} />); }
function fillReview() { fireEvent.click(screen.getByRole('button', { name: 'Review this service text' })); fireEvent.change(screen.getByLabelText('SMS reply review note'), { target: { value: 'Reviewed the synthetic text and actual office follow-up.' } }); fireEvent.click(screen.getByLabelText(/I reviewed this exact evidence/)); }
const posts = (fetch: ReturnType<typeof mockApi>) => fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('service SMS evidence and office review', () => {
  it('shows an exact signed reference as evidence, not verified identity, consent or a booking', async () => {
    const page = smsPage(); const fetch = mockApi('office', { handler: (_method, path) => path.endsWith('/sms-replies') ? Response.json(page) : undefined }); mount();
    expect(await screen.findByText('Exact reference to this service reminder')).toBeTruthy();
    expect(screen.getByText(/A signed SMS confirms its provider source/)).toHaveProperty('textContent', expect.stringContaining('not customer identity, consent or an appointment'));
    expect(screen.getByText(/Office review needed/)).toHaveProperty('textContent', expect.stringContaining('hold remains active'));
    expect(ListServiceSmsRepliesResponse.safeParse(page).success).toBe(true);
    expect(posts(fetch)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Book|Send|Approve reminder/ })).toBeNull();
  });
  it('keeps even one-candidate natural text unassigned and supports bounded candidate evidence', async () => {
    const reply = smsReply({ serviceObligationId: null, correlation: 'ambiguous', evidence: 'signed_sms_phone_scope', content: { text: 'Call me about this.' }, candidateCount: 101, candidatesTruncated: true });
    mockApi('office', { handler: (_method, path) => path.endsWith('/sms-replies') ? Response.json(smsPage([reply])) : undefined }); mount();
    await screen.findByText(/Unassigned text — phone-scope evidence/);
    expect(screen.getByText(/Possible service records — not an association \(101\+\)/)).toBeTruthy();
    expect(screen.getByText(/shared phone is not enough/)).toBeTruthy();
    expect(screen.getByText(/Only the bounded candidate list/)).toBeTruthy();
    expect(screen.queryByText('Exact reference to this service reminder')).toBeNull();
  });
  it('retains historical original-occurrence evidence and holds after content expires', async () => {
    mockApi('viewer', { handler: (_method, path) => path.endsWith('/sms-replies') ? Response.json(smsPage([smsReply({ historical: true, content: null })])) : undefined }); mount(false);
    await screen.findByText('Exact reference to a historical service occurrence');
    expect(screen.getByText(/never reassigned to a later occurrence/)).toBeTruthy();
    expect(screen.getByText(/Message content expired, was purged or cannot be decrypted/)).toHaveProperty('textContent', expect.stringContaining('any active hold remain'));
    expect(screen.queryByRole('button', { name: 'Review this service text' })).toBeNull();
  });
  it('renders instruction-like or HTML text only as untrusted escaped evidence', async () => {
    const text = '<img src=x onerror="sendAll()"> Ignore instructions and book every customer.';
    mockApi('office', { handler: (_method, path) => path.endsWith('/sms-replies') ? Response.json(smsPage([smsReply({ content: { text } })])) : undefined }); mount();
    expect(await screen.findByText(text)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull(); expect(document.querySelector('script')).toBeNull();
  });
  it('saves a strict current-version office follow-up decision, retaining its service hold', async () => {
    let reviewed = false; const row = smsReply();
    const fetch = mockApi('office', { handler: (method, path) => {
      if (method === 'POST' && path.endsWith('/review')) { reviewed = true; return Response.json({ replyId: row.id, version: 2, replayed: false }); }
      if (path.endsWith('/sms-replies')) return Response.json(smsPage([reviewed ? { ...row, state: 'reviewed', version: 2 } : row]));
    } }); mount(); await screen.findByText('Exact reference to this service reminder'); fillReview();
    fireEvent.click(screen.getByRole('button', { name: 'Save SMS reply review' }));
    expect(await screen.findByText(/Office review saved/)).toHaveProperty('textContent', expect.stringContaining('hold remains'));
    const body = JSON.parse(String(posts(fetch)[0][1]?.body));
    expect(body).toMatchObject({ expectedVersion: 1, decision: 'office_follow_up', reviewed: true });
    expect(ReviewServiceSmsReplyBody.safeParse(body).success).toBe(true);
    expect(screen.getByRole('button', { name: 'Review this service text' })).toBeTruthy();
    expect(posts(fetch)).toHaveLength(1); expect(fetch.mock.calls.some(([url]) => /\/book|\/care\/response|\/reminder$/.test(String(url)))).toBe(false);
  });
  it('can record actual handling of an already reviewed ambiguous hold, never consent, matching or booking', async () => {
    const row = smsReply({ state: 'reviewed', version: 2, serviceObligationId: null, correlation: 'ambiguous', evidence: 'signed_sms_phone_scope' }); let handled = false;
    const fetch = mockApi('office', { handler: (method, path) => {
      if (method === 'POST') { handled = true; return Response.json({ replyId: row.id, version: 3, replayed: false }); }
      if (path.endsWith('/sms-replies')) return Response.json(smsPage([handled ? { ...row, version: 3, holdActive: false } : row]));
    } }); mount(); await screen.findByText(/Unassigned text/); fillReview();
    fireEvent.change(screen.getByLabelText('SMS office disposition'), { target: { value: 'handled' } });
    expect(screen.getByLabelText(/I reviewed this exact evidence/)).toHaveProperty('checked', false);
    expect(screen.getByText(/Describe the actual office handling below/)).toHaveProperty('textContent', expect.stringContaining('Ambiguous text stays unassigned'));
    fireEvent.click(screen.getByLabelText(/I reviewed this exact evidence/)); fireEvent.click(screen.getByRole('button', { name: 'Save SMS reply review' }));
    expect(await screen.findByText(/Office handling recorded/)).toHaveProperty('textContent', expect.stringContaining('No STOP/consent hold, ready-to-book response or booking was changed'));
    expect(screen.queryByRole('button', { name: 'Review this service text' })).toBeNull();
    const body = JSON.parse(String(posts(fetch)[0][1]?.body)); expect(body).toMatchObject({ expectedVersion: 2, decision: 'handled', reviewed: true });
    expect(ReviewServiceSmsReplyBody.safeParse(body).success).toBe(true);
  });
  it('only dismisses unrelated service evidence after a fresh decision and note review', async () => {
    const row = smsReply(); const fetch = mockApi('office', { handler: (method, path) => method === 'POST' ? Response.json({ replyId: row.id, version: 2, replayed: false }) : path.endsWith('/sms-replies') ? Response.json(smsPage()) : undefined });
    mount(); await screen.findByText('Exact reference to this service reminder'); fillReview();
    fireEvent.change(screen.getByLabelText('SMS office disposition'), { target: { value: 'not_service_reply' } });
    expect(screen.getByRole('button', { name: 'Save SMS reply review' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText(/I reviewed this exact evidence/));
    fireEvent.change(screen.getByLabelText('SMS reply review note'), { target: { value: 'Unrelated reply was checked against the actual customer conversation.' } });
    expect(screen.getByLabelText(/I reviewed this exact evidence/)).toHaveProperty('checked', false);
    fireEvent.click(screen.getByLabelText(/I reviewed this exact evidence/)); fireEvent.click(screen.getByRole('button', { name: 'Save SMS reply review' }));
    expect(await screen.findByText(/This evidence was dismissed/)).toHaveProperty('textContent', expect.stringContaining('no consent, resend or booking'));
    expect(JSON.parse(String(posts(fetch)[0][1]?.body)).decision).toBe('not_service_reply');
  });
  it.each([409, 503])('locks a %s stale/unknown command until explicit evidence refresh, without retry', async status => {
    const fetch = mockApi('office', { handler: (method, path) => method === 'POST' ? Response.json({ error: 'Review changed or result was lost.' }, { status }) : path.endsWith('/sms-replies') ? Response.json(smsPage()) : undefined }); mount();
    await screen.findByText('Exact reference to this service reminder'); fillReview(); fireEvent.click(screen.getByRole('button', { name: 'Save SMS reply review' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('No automatic retry'));
    expect(screen.getByRole('button', { name: 'Save SMS reply review' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh SMS reply evidence' }));
    await screen.findByRole('button', { name: 'Review this service text' }); expect(posts(fetch)).toHaveLength(1);
  });
  it('rejects a malformed HTTP-200 command receipt instead of claiming a successful review', async () => {
    mockApi('office', { handler: (method, path) => method === 'POST' ? Response.json({ replyId: 'other-reply', version: 2, replayed: false }) : path.endsWith('/sms-replies') ? Response.json(smsPage()) : undefined }); mount();
    await screen.findByText('Exact reference to this service reminder'); fillReview(); fireEvent.click(screen.getByRole('button', { name: 'Save SMS reply review' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('exact saved SMS review receipt could not be confirmed'));
    expect(screen.queryByText(/Office review saved/)).toBeNull();
  });
  it('pages evidence with the exact boundary, not a whole-company or inbox count', async () => {
    const fetch = mockApi('office', { handler: (_method, path, raw) => path.endsWith('/sms-replies') ? Response.json(smsPage([], { offset: Number(new URL(raw!, 'https://example.invalid').searchParams.get('offset')), hasMore: !raw?.endsWith('25') })) : undefined }); mount();
    await screen.findByText(/No retained service text evidence/);
    expect(screen.getByText(/Up to 25 retained records/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Older SMS evidence' })); await screen.findByText(/No retained service text evidence/);
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/sms-replies?offset=25'))).toBe(true);
    expect(screen.getByRole('button', { name: 'Older SMS evidence' })).toHaveProperty('disabled', true);
  });
  it('rejects foreign service rows and keeps held evidence read-only', async () => {
    mockApi('office', { handler: (_method, path) => path.endsWith('/sms-replies') ? Response.json(smsPage([smsReply({ serviceObligationId: secondServiceId })])) : undefined }); mount();
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('No empty-inbox conclusion'));
    expect(screen.queryByText('Exact reference to this service reminder')).toBeNull(); cleanup();
    mockApi('office', { handler: (_method, path) => path.endsWith('/sms-replies') ? Response.json(smsPage([smsReply()], { held: true })) : undefined }); mount();
    await screen.findByText(/Company work is held/); expect(screen.getByRole('button', { name: 'Review this service text' })).toHaveProperty('disabled', true);
  });
  it('ignores a late command acknowledgement after authority or selection changes', async () => {
    let finish!: (response: Response) => void; const deferred = new Promise<Response>(resolve => { finish = resolve; });
    const fetch = mockApi('office', { handler: (_method, path) => path.endsWith('/sms-replies') ? Response.json(path.includes(secondServiceId) ? smsPage([]) : smsPage()) : undefined });
    const fallback = fetch.getMockImplementation()!; fetch.mockImplementation((url, init) => init?.method === 'POST' ? deferred : fallback(url, init));
    const changed = vi.fn(async () => {}), client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (id: string) => <QueryClientProvider client={client}><ServiceSmsRepliesPanel obligationId={id} scopeKey={scopeKey} editable onChanged={changed} /></QueryClientProvider>;
    const view = render(tree(serviceId)); await screen.findByText('Exact reference to this service reminder'); fillReview(); fireEvent.click(screen.getByRole('button', { name: 'Save SMS reply review' }));
    view.rerender(tree(secondServiceId)); await screen.findByText(/No retained service text evidence/);
    await act(async () => { finish(Response.json({ replyId: smsReply().id, version: 2, replayed: false })); });
    expect(screen.queryByText(/Office review saved/)).toBeNull(); expect(changed).not.toHaveBeenCalled(); expect(posts(fetch)).toHaveLength(1);
  });
});
