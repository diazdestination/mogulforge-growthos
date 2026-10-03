/**
 * Guards the Messages tab on the lead detail page.
 *
 * Verifies that:
 *  - portal_message and team_message activities appear in the Messages tab
 *  - Their sender labels read "Homeowner" and "Team" respectively
 *  - Messages are shown oldest-first (the API returns them newest-first and
 *    the component reverses them)
 *  - "Homeowner" / "Team" chat labels are absent while on the Timeline tab
 *    (MessageThread is only mounted under the Messages tab)
 *  - The reply composer is present for crm.write roles and absent for viewers
 *  - Submitting the composer calls createLeadActivity with type "team_message"
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LeadDetail from './lead-detail';
import { mockApi, sampleContact, sampleLead } from '@/test/mock-api';
import { renderWithQuery } from '@/test/render';

beforeEach(() => {
  // jsdom does not implement scrollIntoView; stub it so MessageThread's
  // auto-scroll useEffect does not crash the tests.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Two activities returned newest-first (as the API would).
const olderPortalMsg = {
  id: 'act-portal-1',
  type: 'portal_message',
  title: 'Homeowner asking about timeline',
  body: 'When will the crew arrive?',
  occurredAt: '2026-07-01T09:00:00.000Z',
  metadata: {},
};

const newerTeamMsg = {
  id: 'act-team-1',
  type: 'team_message',
  title: 'Reply from your roofing team',
  body: 'We will be there at noon.',
  occurredAt: '2026-07-01T10:00:00.000Z',
  metadata: {},
};

// Unrelated activity that must NOT appear in the Messages tab.
const noteActivity = {
  id: 'act-note-1',
  type: 'note',
  title: 'Called the adjuster',
  body: 'Left a voicemail.',
  occurredAt: '2026-07-01T08:00:00.000Z',
  metadata: {},
};

// API returns activities newest-first.
const activitiesDesc = [newerTeamMsg, olderPortalMsg, noteActivity];

function setup(role: string, search = '') {
  const fetchMock = mockApi(role, {
    handler: (method, path) => {
      if (method === 'GET' && path.endsWith('/mailbox-replies')) return new Response(JSON.stringify({ items: [], hasMore: false, offset: 0, limit: 25 }), { status: 200 });
      if (
        method === 'GET' &&
        path.endsWith(`/api/v1/leads/${sampleLead.id}/activities`)
      ) {
        return new Response(JSON.stringify(activitiesDesc), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (
        method === 'GET' &&
        path.endsWith(`/api/v1/leads/${sampleLead.id}`)
      ) {
        return new Response(
          JSON.stringify({
            ...sampleLead,
            contactId: sampleContact.id,
            scoreReasons: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (
        method === 'GET' &&
        path.endsWith(`/api/v1/contacts/${sampleContact.id}`)
      ) {
        return new Response(JSON.stringify(sampleContact), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (
        method === 'POST' &&
        path.endsWith(`/api/v1/leads/${sampleLead.id}/activities`)
      ) {
        return new Response(
          JSON.stringify({
            id: 'act-new-1',
            type: 'team_message',
            title: 'Reply from your roofing team',
            body: 'Hello from test',
            occurredAt: new Date().toISOString(),
            metadata: {},
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      return undefined;
    },
  });

  const { hook } = memoryLocation({ path: `/leads/${sampleLead.id}` });
  renderWithQuery(
    <Router hook={hook} searchHook={() => search}>
      <Route path="/leads/:id" component={LeadDetail} />
    </Router>,
  );

  return fetchMock;
}

async function openMessagesTab() {
  const tab = await screen.findByRole('button', { name: /messages/i });
  fireEvent.click(tab);
}

describe('lead detail – Messages tab', () => {
  it('opens the canonical Messages evidence panel from a validated tab query without scrolling away', async () => {
    setup('sales_rep', '?tab=messages');
    await screen.findByRole('region', { name: 'Original-mailbox lead replies' });
    expect(screen.getByText(/This is not a general inbox/)).toBeTruthy();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
  it('shows both portal_message and team_message in the Messages tab', async () => {
    setup('sales_rep');

    await openMessagesTab();

    await screen.findByText('When will the crew arrive?');
    expect(screen.getByText('We will be there at noon.')).toBeTruthy();
  });

  it('labels homeowner and team messages correctly', async () => {
    setup('sales_rep');

    await openMessagesTab();

    await screen.findByText('When will the crew arrive?');

    const homeownerLabels = screen.getAllByText(/homeowner/i);
    expect(homeownerLabels.length).toBeGreaterThan(0);

    const teamLabels = screen.getAllByText(/^team$/i);
    expect(teamLabels.length).toBeGreaterThan(0);
  });

  it('displays messages oldest-first despite API returning newest-first', async () => {
    setup('sales_rep');

    await openMessagesTab();

    await screen.findByText('When will the crew arrive?');

    const allText = document.body.textContent ?? '';
    const homeownerIdx = allText.indexOf('When will the crew arrive?');
    const teamIdx = allText.indexOf('We will be there at noon.');

    // The older portal_message should appear before the newer team_message.
    expect(homeownerIdx).toBeLessThan(teamIdx);
  });

  it('does not show the Homeowner/Team chat labels while on the Timeline tab', async () => {
    setup('sales_rep');

    // Wait for the page AND the timeline activities to load (Timeline tab is
    // active by default). Note the timeline itself legitimately shows a
    // "Homeowner" badge on portal messages, so we assert on the MessageThread
    // composer instead of the label text.
    await screen.findByText('Hail damage roof');
    await screen.findByText('When will the crew arrive?');

    // The MessageThread (with its reply composer) is not yet mounted.
    expect(
      screen.queryByPlaceholderText(/reply to homeowner/i),
    ).toBeNull();
    expect(screen.queryByText(/^team$/i)).toBeNull();
  });

  it('does not show the note-type activity in the Messages tab', async () => {
    setup('sales_rep');

    await openMessagesTab();

    await screen.findByText('When will the crew arrive?');
    // The note's body text must not appear in the messages view.
    expect(screen.queryByText('Left a voicemail.')).toBeNull();
  });

  it('shows the reply composer for crm.write roles', async () => {
    setup('sales_rep');

    await openMessagesTab();

    await screen.findByText('When will the crew arrive?');

    expect(
      screen.getByTestId('input-message-thread-reply'),
    ).toBeTruthy();
  });

  it('hides the reply composer for viewers', async () => {
    setup('viewer');

    await openMessagesTab();

    await screen.findByText('When will the crew arrive?');

    expect(
      screen.queryByTestId('input-message-thread-reply'),
    ).toBeNull();
  });

  it('shows the empty-state placeholder when no portal or team messages exist', async () => {
    // Seed only a note and a status-change — no portal_message or team_message.
    const noMessageActivities = [
      {
        id: 'act-note-only',
        type: 'note',
        title: 'Left a voicemail',
        body: 'Called and left message.',
        occurredAt: '2026-07-01T08:00:00.000Z',
        metadata: {},
      },
      {
        id: 'act-status-1',
        type: 'status_change',
        title: 'Status changed to qualified',
        body: null,
        occurredAt: '2026-07-01T09:00:00.000Z',
        metadata: {},
      },
    ];

    mockApi('sales_rep', {
      handler: (method, path) => {
        if (
          method === 'GET' &&
          path.endsWith(`/api/v1/leads/${sampleLead.id}/activities`)
        ) {
          return new Response(JSON.stringify(noMessageActivities), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (
          method === 'GET' &&
          path.endsWith(`/api/v1/leads/${sampleLead.id}`)
        ) {
          return new Response(
            JSON.stringify({
              ...sampleLead,
              contactId: sampleContact.id,
              scoreReasons: [],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (
          method === 'GET' &&
          path.endsWith(`/api/v1/contacts/${sampleContact.id}`)
        ) {
          return new Response(JSON.stringify(sampleContact), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return undefined;
      },
    });

    const { hook } = memoryLocation({ path: `/leads/${sampleLead.id}` });
    renderWithQuery(
      <Router hook={hook}>
        <Route path="/leads/:id" component={LeadDetail} />
      </Router>,
    );

    await openMessagesTab();

    // Empty-state placeholder must be visible.
    await screen.findByText('No messages yet.');

    // The note body must not leak into the Messages tab.
    expect(screen.queryByText('Called and left message.')).toBeNull();
  });

  it('still shows the reply composer when activities contain only non-message entries', async () => {
    const noMessageActivities = [
      {
        id: 'act-note-only-2',
        type: 'note',
        title: 'Sent brochure',
        body: 'Emailed the product brochure.',
        occurredAt: '2026-07-01T08:00:00.000Z',
        metadata: {},
      },
    ];

    mockApi('sales_rep', {
      handler: (method, path) => {
        if (
          method === 'GET' &&
          path.endsWith(`/api/v1/leads/${sampleLead.id}/activities`)
        ) {
          return new Response(JSON.stringify(noMessageActivities), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (
          method === 'GET' &&
          path.endsWith(`/api/v1/leads/${sampleLead.id}`)
        ) {
          return new Response(
            JSON.stringify({
              ...sampleLead,
              contactId: sampleContact.id,
              scoreReasons: [],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (
          method === 'GET' &&
          path.endsWith(`/api/v1/contacts/${sampleContact.id}`)
        ) {
          return new Response(JSON.stringify(sampleContact), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return undefined;
      },
    });

    const { hook } = memoryLocation({ path: `/leads/${sampleLead.id}` });
    renderWithQuery(
      <Router hook={hook}>
        <Route path="/leads/:id" component={LeadDetail} />
      </Router>,
    );

    await openMessagesTab();

    // Composer must still be available so reps can start a conversation.
    await screen.findByTestId('input-message-thread-reply');
  });

  it('submitting the composer calls createLeadActivity with type team_message', async () => {
    const fetchMock = setup('sales_rep');

    await openMessagesTab();

    const textarea = await screen.findByTestId('input-message-thread-reply');
    fireEvent.change(textarea, { target: { value: 'Hello from test' } });

    const form = textarea.closest('form')!;
    fireEvent.submit(form);

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([input, init]) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.href
                : (input as Request).url;
          const method = (
            init?.method ??
            (input instanceof Request ? (input as Request).method : 'GET')
          ).toUpperCase();
          return (
            method === 'POST' &&
            url.includes(`/api/v1/leads/${sampleLead.id}/activities`)
          );
        },
      );
      expect(postCall).toBeTruthy();

      const [, init] = postCall!;
      const body = JSON.parse(
        typeof init?.body === 'string' ? init.body : '{}',
      );
      expect(body.type).toBe('team_message');
    });
  });
});
