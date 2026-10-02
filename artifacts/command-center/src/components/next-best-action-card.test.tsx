/**
 * Covers the next-best-action copilot card on the lead detail page:
 * - Send records "sent" feedback; edit-then-send records "edited".
 * - Snooze/dismiss record feedback, hide the card, and refetch the query.
 * - A refetched "none" recommendation removes the card (and its stale draft)
 *   so a rep can never send a draft written for an outdated lead situation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { NextBestActionCard } from '@/components/next-best-action-card';
import { Toaster } from '@/components/ui/toaster';
import { renderWithQuery } from '@/test/render';
import { mockApi } from '@/test/mock-api';
import { useQueryClient } from '@tanstack/react-query';
import { getGetLeadNextActionQueryKey } from '@workspace/api-client-react';

const LEAD_ID = 'l1-00000000';
const NEXT_ACTION_PATH = `/api/v1/leads/${LEAD_ID}/next-action`;
const FEEDBACK_PATH = `/api/v1/leads/${LEAD_ID}/next-action/feedback`;
const SEND_EMAIL_PATH = `/api/v1/leads/${LEAD_ID}/send-email`;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const emailAction = {
  leadId: LEAD_ID,
  actionType: 'send_message',
  title: 'Send a follow-up email',
  reasons: ['No contact in 5 days'],
  priority: 80,
  leadStatus: 'contacted',
  score: 72,
  channel: 'email',
  draft: {
    subject: 'Checking in on your roof',
    body: 'Hi Jane, just checking in about the hail damage.',
    provider: 'openai',
  },
};

const noneAction = {
  leadId: LEAD_ID,
  actionType: 'none',
  title: 'No action needed',
  reasons: [],
  priority: 0,
  leadStatus: 'won',
  score: 0,
};

function callInfo([input, init]: [RequestInfo | URL, RequestInit?]) {
  return {
    method: (init?.method ?? 'GET').toUpperCase(),
    path: String(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    ).split('?')[0],
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
}

const callsTo = (fetchMock: ReturnType<typeof mockApi>, method: string, path: string) =>
  fetchMock.mock.calls.map(callInfo).filter(c => c.method === method && c.path.endsWith(path));

// Lets tests trigger the same query invalidation the app performs when the
// lead's situation changes elsewhere (status change, new message, booking).
let invalidateNextAction: () => void = () => {};

function InvalidateBridge({ leadId }: { leadId: string }) {
  const queryClient = useQueryClient();
  invalidateNextAction = () => {
    queryClient.invalidateQueries({ queryKey: getGetLeadNextActionQueryKey(leadId) });
  };
  return null;
}

function renderCard(handler: (method: string, path: string) => Response | undefined) {
  const fetchMock = mockApi('admin', { handler });
  renderWithQuery(
    <>
      <NextBestActionCard leadId={LEAD_ID} canWrite={true} />
      <InvalidateBridge leadId={LEAD_ID} />
      <Toaster />
    </>,
  );
  return fetchMock;
}

async function waitForReadyDraft() {
  await screen.findByTestId('next-best-action-card');
  // The card mounts before the composer's effect copies the fetched draft into
  // editable state. Clicking its initially disabled Send button loses the event.
  await waitFor(() => {
    expect((screen.getByLabelText('Draft subject') as HTMLInputElement).value).toBe(emailAction.draft.subject);
    expect((screen.getByLabelText('Draft message') as HTMLTextAreaElement).value).toBe(emailAction.draft.body);
    expect((screen.getByRole('button', { name: /^send$/i }) as HTMLButtonElement).disabled).toBe(false);
  });
}

/** Standard handler: email action, successful feedback + send-email. */
function happyHandler(getAction: () => unknown) {
  return (method: string, path: string): Response | undefined => {
    if (method === 'GET' && path.endsWith(NEXT_ACTION_PATH)) {
      return jsonResponse(getAction());
    }
    if (method === 'POST' && path.endsWith(FEEDBACK_PATH)) {
      return jsonResponse({ ok: true });
    }
    if (method === 'POST' && path.endsWith(SEND_EMAIL_PATH)) {
      return jsonResponse({ ok: true });
    }
    return undefined;
  };
}

describe('NextBestActionCard', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('sends the draft unchanged and records "sent" feedback', async () => {
    const fetchMock = renderCard(happyHandler(() => emailAction));

    await waitForReadyDraft();
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => expect(callsTo(fetchMock, 'POST', SEND_EMAIL_PATH).length).toBe(1));
    expect(callsTo(fetchMock, 'POST', SEND_EMAIL_PATH)[0].body).toEqual({
      subject: 'Checking in on your roof',
      body: 'Hi Jane, just checking in about the hail damage.',
    });
    await waitFor(() => expect(callsTo(fetchMock, 'POST', FEEDBACK_PATH).length).toBe(1));
    expect(callsTo(fetchMock, 'POST', FEEDBACK_PATH)[0].body).toEqual({
      actionType: 'send_message',
      response: 'sent',
    });
  });

  it('records "edited" feedback and sends the edited body when the rep tweaks the draft', async () => {
    const fetchMock = renderCard(happyHandler(() => emailAction));

    await waitForReadyDraft();
    fireEvent.change(screen.getByLabelText(/draft message/i), {
      target: { value: 'Hi Jane, edited follow-up.' },
    });
    // The button label reflects the edited state before sending.
    fireEvent.click(screen.getByRole('button', { name: /send edited draft/i }));

    await waitFor(() => expect(callsTo(fetchMock, 'POST', SEND_EMAIL_PATH).length).toBe(1));
    expect(callsTo(fetchMock, 'POST', SEND_EMAIL_PATH)[0].body.body).toBe(
      'Hi Jane, edited follow-up.',
    );
    await waitFor(() => expect(callsTo(fetchMock, 'POST', FEEDBACK_PATH).length).toBe(1));
    expect(callsTo(fetchMock, 'POST', FEEDBACK_PATH)[0].body.response).toBe('edited');
  });

  it('snooze records feedback with snoozeHours, refetches, and hides the card once "none" comes back', async () => {
    let current: unknown = emailAction;
    const fetchMock = renderCard(happyHandler(() => current));

    await screen.findByTestId('next-best-action-card');
    const getCalls = callsTo(fetchMock, 'GET', NEXT_ACTION_PATH).length;

    current = noneAction; // the refetch after snoozing returns "nothing to do"
    fireEvent.click(screen.getByRole('button', { name: /snooze 24h/i }));

    await waitFor(() => expect(callsTo(fetchMock, 'POST', FEEDBACK_PATH).length).toBe(1));
    expect(callsTo(fetchMock, 'POST', FEEDBACK_PATH)[0].body).toEqual({
      actionType: 'send_message',
      response: 'snoozed',
      snoozeHours: 24,
    });
    // The card refreshes the recommendation query and disappears.
    await waitFor(() =>
      expect(callsTo(fetchMock, 'GET', NEXT_ACTION_PATH).length).toBeGreaterThan(getCalls),
    );
    await waitFor(() => expect(screen.queryByTestId('next-best-action-card')).toBeNull());
  });

  it('dismiss records feedback, refetches, and hides the card', async () => {
    let current: unknown = emailAction;
    const fetchMock = renderCard(happyHandler(() => current));

    await screen.findByTestId('next-best-action-card');
    const getCalls = callsTo(fetchMock, 'GET', NEXT_ACTION_PATH).length;

    current = noneAction;
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

    await waitFor(() => expect(callsTo(fetchMock, 'POST', FEEDBACK_PATH).length).toBe(1));
    expect(callsTo(fetchMock, 'POST', FEEDBACK_PATH)[0].body).toEqual({
      actionType: 'send_message',
      response: 'dismissed',
    });
    await waitFor(() =>
      expect(callsTo(fetchMock, 'GET', NEXT_ACTION_PATH).length).toBeGreaterThan(getCalls),
    );
    await waitFor(() => expect(screen.queryByTestId('next-best-action-card')).toBeNull());
  });

  it('removes the card and its stale draft when a refetch returns "none"', async () => {
    // Simulates the lead's situation changing while the page is open: the
    // recommendation is invalidated elsewhere, the refetch says "none", and
    // the stale draft must vanish so it can never be sent.
    let current: unknown = emailAction;
    const fetchMock = renderCard(happyHandler(() => current));

    await screen.findByTestId('next-best-action-card');
    expect(screen.getByLabelText(/draft message/i)).toBeTruthy();

    // The lead changed: the next fetch of the recommendation returns "none".
    current = noneAction;
    invalidateNextAction();

    await waitFor(() => expect(screen.queryByTestId('next-best-action-card')).toBeNull());
    expect(screen.queryByLabelText(/draft message/i)).toBeNull();
    expect(callsTo(fetchMock, 'GET', NEXT_ACTION_PATH).length).toBeGreaterThan(1);
  });
});
