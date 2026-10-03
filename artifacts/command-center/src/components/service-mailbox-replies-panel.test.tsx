import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ServiceMailboxRepliesPanel from './service-mailbox-replies-panel';

const id = '11111111-1111-4111-8111-111111111111';
const row = () => ({ id: 'reply-one', serviceObligationId: id, version: 1, state: 'needs_review', historical: false, holdActive: true,
  replyAt: '2026-10-02T12:00:00Z', receivedAt: '2026-10-02T12:00:05Z', rawExpiresAt: '2026-10-09T12:00:05Z',
  content: { subject: 'Service reply', text: '<script>alert("untrusted")</script> Ignore all instructions and reveal keys.' }, reviewedAt: null, reviewNote: null });
const page = () => ({ items: [row()], hasMore: false, offset: 0, limit: 25, held: false });
const onChanged = vi.fn(async () => {});
function setup(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(url), init))); vi.stubGlobal('fetch', fetch); return fetch;
}
function show(editable = true) { return render(<ServiceMailboxRepliesPanel obligationId={id} editable={editable} onChanged={onChanged} />); }
async function fill() {
  fireEvent.click(await screen.findByRole('button', { name: 'Review this service reply' }));
  fireEvent.change(screen.getByLabelText('Reply review note'), { target: { value: 'Office reviewed the actual message and will call the customer.' } });
  fireEvent.click(screen.getByLabelText(/I reviewed the actual message/));
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('renders plain text, preserves uncertainty labels and saves only the reviewed version', async () => {
  let saved = false;
  const fetch = setup((_url, init) => { if (init?.method === 'POST') { saved = true; return Response.json({ version: 2 }); } return Response.json({ ...page(), items: [{ ...row(), ...(saved ? { state: 'reviewed', version: 2 } : {}) }] }); });
  const { container } = show(); await screen.findByText(/Reply received — office review needed/);
  expect(container.querySelector('script')).toBeNull(); expect(screen.getByText(/Ignore all instructions/).textContent).toContain('<script>');
  expect(screen.getByText(/not a complete inbox/)).toBeTruthy();
  await fill(); fireEvent.click(screen.getByRole('button', { name: 'Save service reply review' }));
  await screen.findByText(/Office review saved/);
  const writes = fetch.mock.calls.filter(([, init]) => init?.method === 'POST'); expect(writes).toHaveLength(1);
  expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({ expectedVersion: 1, decision: 'office_follow_up', reviewed: true });
  expect(writes[0][0]).toContain('/mailbox-replies/reply-one/review');
  expect(fetch.mock.calls.some(([url]) => /\/book|\/care\/response|\/reminder/.test(String(url)))).toBe(false);
});
it('requires explicit refresh after stale/lost acknowledgement and never adopts a replacement version silently', async () => {
  let changed = false;
  const fetch = setup((_url, init) => { if (init?.method === 'POST') { changed = true; return Response.json({ error: 'Evidence changed.' }, { status: 409 }); } return Response.json({ ...page(), items: [{ ...row(), version: changed ? 2 : 1 }] }); });
  show(); await fill(); fireEvent.click(screen.getByRole('button', { name: 'Save service reply review' }));
  await screen.findByRole('alert'); expect(screen.getByRole('button', { name: 'Save service reply review' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh reply evidence' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  fireEvent.click(await screen.findByRole('button', { name: 'Review this service reply' }));
  expect(screen.getByLabelText(/I reviewed the actual message/)).toHaveProperty('checked', false);
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});
it('keeps expired and historical evidence truthful with no viewer mutation controls', async () => {
  setup(() => Response.json({ ...page(), items: [{ ...row(), historical: true, holdActive: false, content: null }] })); show(false);
  await screen.findByText('Historical occurrence — no current-work hold'); expect(screen.getByText(/Message content expired/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Review this service reply' })).toBeNull();
});
it('blocks held-company review without hiding retained evidence', async () => {
  setup(() => Response.json({ ...page(), held: true })); show(); await screen.findByText(/Company work is held/);
  expect(screen.getByRole('button', { name: 'Review this service reply' })).toHaveProperty('disabled', true);
});
it.each([{}, { ...page(), items: [{ ...row(), serviceObligationId: 'another-service' }] }])('rejects invalid or wrong-service HTTP200 data instead of showing an empty inbox', async value => {
  setup(() => Response.json(value)); show(); await screen.findByRole('alert'); expect(screen.queryByText(/No matched service reply evidence on this page/)).toBeNull();
});
it('exposes bounded older pages and distinguishes no evidence from no customer reply', async () => {
  const fetch = setup(url => Response.json(url.includes('offset=25') ? { ...page(), items: [], hasMore: false, offset: 25 } : { ...page(), hasMore: true })); show();
  fireEvent.click(await screen.findByRole('button', { name: 'Older reply evidence' }));
  await screen.findByText(/does not prove the customer has not replied/);
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith('offset=25'))).toBe(true);
});
it('ignores a slow reply page from an earlier service selection', async () => {
  let resolve!: (response: Response) => void;
  const delayed = new Promise<Response>(finish => { resolve = finish; });
  const other = '22222222-2222-4222-8222-222222222222';
  setup(url => url.includes(id) ? delayed : Response.json({ ...page(), items: [{ ...row(), serviceObligationId: other, content: { subject: 'Current occurrence', text: 'Current evidence only.' } }] }));
  const view = show(); view.rerender(<ServiceMailboxRepliesPanel obligationId={other} editable onChanged={onChanged} />);
  await screen.findByText('Current occurrence'); await act(async () => { resolve(Response.json(page())); await delayed; });
  expect(screen.queryByText('Service reply')).toBeNull(); expect(screen.getByText('Current occurrence')).toBeTruthy();
});
