import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SmartSiteFollowup, ResponseTarget } from './smart-site-followup';
import { renderWithQuery } from '@/test/render';
import { mockApi } from '@/test/mock-api';

const lead = {
  leadId: 'lead1',
  name: 'Local QA',
  service: 'Siding',
  siteName: 'Painless',
  assignedUserId: null,
  receivedAt: '2026-09-12T10:00:00Z',
  dueAt: '2026-09-12T11:00:00Z',
  firstAttemptAt: null,
};
const report = {
  serverNow: '2026-09-12T12:00:00Z',
  summary: {
    awaitingAttempt: 1,
    unassigned: 1,
    overdue: 1,
    noTarget: 0,
    logged: 0,
    medianMinutesToLog: null,
  },
  pending: [lead],
  members: [{ id: 'u1', name: 'Local Owner' }],
};
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
function setup(
  handler?: (method: string, path: string) => Response | undefined,
) {
  return mockApi('owner', {
    handler: (method, path) =>
      handler?.(method, path) ??
      (path.endsWith('/smart-sites/follow-up')
        ? response(report)
        : path.endsWith('/owner') ||
            path.endsWith('/contact-attempts') ||
            path.endsWith('/response-target')
          ? response({ ok: true })
          : undefined),
  });
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('shows honest overdue and unmeasured states with read-only protection', async () => {
  setup();
  renderWithQuery(
    <SmartSiteFollowup organizationId="o1" userId="u1" canWrite={false} />,
  );
  await screen.findByRole('article', { name: 'Local QA follow-up' });
  expect(screen.getByText('Not yet measured')).not.toBeNull();
  expect(screen.queryByRole('button', { name: 'Claim inquiry' })).toBeNull();
  expect(
    screen.getByText(/Notes and stage changes do not count/),
  ).not.toBeNull();
});
it('claims with the expected current owner to protect against a concurrent teammate', async () => {
  const calls = setup();
  renderWithQuery(
    <SmartSiteFollowup organizationId="o1" userId="u1" canWrite />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Claim inquiry' }));
  await screen.findByText('Ownership saved.');
  const call = calls.mock.calls.find(([url]) => String(url).endsWith('/owner'));
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({
    assignedUserId: 'u1',
    expectedOwnerId: null,
  });
});
it('requires explicit staff confirmation and keeps the same retry ID after a failed log', async () => {
  let sent = 0;
  const calls = setup((method, path) =>
    method === 'POST' && path.endsWith('/contact-attempts')
      ? ++sent === 1
        ? response({ error: 'Try again' }, 503)
        : response({ ok: true })
      : undefined,
  );
  renderWithQuery(
    <SmartSiteFollowup organizationId="o1" userId="u1" canWrite />,
  );
  const card = await screen.findByRole('article', {
    name: 'Local QA follow-up',
  });
  fireEvent.click(within(card).getByText('Log a contact attempt'));
  const save = within(card).getByRole('button', {
    name: 'Record completed attempt',
  });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(card).getByRole('checkbox', { name: /I performed/ }));
  fireEvent.click(save);
  await screen.findByRole('alert');
  fireEvent.click(save);
  await screen.findByText(
    'Attempt recorded. No message was sent by this control.',
  );
  const posts = calls.mock.calls
    .filter(([url]) => String(url).endsWith('/contact-attempts'))
    .map(([, init]) => JSON.parse(String(init?.body)));
  expect(posts).toHaveLength(2);
  expect(posts[0].requestId).toBe(posts[1].requestId);
  expect(posts[0]).toMatchObject({
    channel: 'phone',
    outcome: 'no_answer',
    confirmed: true,
  });
});
it('does not show zeroes or an empty-success message when reporting fails', async () => {
  setup(() => response({ error: 'Unavailable' }, 503));
  renderWithQuery(
    <SmartSiteFollowup organizationId="o1" userId="u1" canWrite />,
  );
  await screen.findByRole('alert');
  expect(screen.getAllByText('—')).toHaveLength(4);
  expect(
    screen.queryByText(
      'No open inquiries need an owner or first logged attempt.',
    ),
  ).toBeNull();
});
it('saves a future-only internal response target', async () => {
  const calls = setup();
  renderWithQuery(
    <ResponseTarget id="site1" minutes={60} organizationId="o1" />,
  );
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '15' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save target' }));
  await waitFor(() =>
    expect(
      calls.mock.calls.some(([url]) =>
        String(url).endsWith('/response-target'),
      ),
    ).toBe(true),
  );
  expect(
    JSON.parse(
      String(
        calls.mock.calls.find(([url]) =>
          String(url).endsWith('/response-target'),
        )?.[1]?.body,
      ),
    ),
  ).toEqual({ minutes: 15 });
});
