import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { afterEach, expect, it, vi } from 'vitest';
import LeadDetail from './lead-detail';
import { mockApi, sampleContact, sampleLead } from '@/test/mock-api';
import { renderWithQuery } from '@/test/render';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('refreshes next-action evidence after a note and after a stage change', async () => {
  let actionReads = 0;
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  mockApi('owner', { handler: (method, path) => {
    if (path.endsWith('/next-action')) { actionReads += 1; return json({ leadId: sampleLead.id, actionType: 'none', title: 'Nothing to do', reasons: [], priority: 0, leadStatus: 'new', score: 0 }); }
    if (path.endsWith(`/leads/${sampleLead.id}`)) return json({ ...sampleLead, contactId: sampleContact.id, status: method === 'PATCH' ? 'follow_up' : 'new', scoreReasons: [] });
    if (path.endsWith(`/contacts/${sampleContact.id}`)) return json(sampleContact);
    if (path.endsWith('/activities')) return json(method === 'GET' ? [] : { id: 'a-local', type: 'note', title: 'Added Note', occurredAt: new Date().toISOString() });
    return undefined;
  } });
  const { hook } = memoryLocation({ path: `/leads/${sampleLead.id}` });
  renderWithQuery(<Router hook={hook}><Route path="/leads/:id"><LeadDetail /></Route></Router>);
  await screen.findByPlaceholderText('Add a note to this lead...');
  // Mobile uses one scrollable body so the manual-SMS panel and timeline remain
  // reachable; independent columns are restored only at the desktop breakpoint.
  expect(screen.getByTestId('lead-detail-scroll-body').className).toContain('overflow-y-auto md:overflow-hidden');
  await waitFor(() => expect(actionReads).toBe(1));
  fireEvent.change(screen.getByPlaceholderText('Add a note to this lead...'), { target: { value: 'Local review only' } });
  fireEvent.click(screen.getByRole('button', { name: 'Post Note' }));
  await waitFor(() => expect(actionReads).toBe(2));
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'follow_up' } });
  await waitFor(() => expect(actionReads).toBe(3));
});
