import { cleanup, screen } from '@testing-library/react';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LeadDetail from './lead-detail';
import { mockApi, sampleLead } from '@/test/mock-api';
import { renderWithQuery } from '@/test/render';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('opening a lead notification when the network or access changes', () => {
  it.each([503, 404])('shows a truthful recoverable state for status %s without stale customer actions', async status => {
    mockApi('owner', { handler: (_method, path) => path.endsWith(`/api/v1/leads/${sampleLead.id}`) ? new Response(JSON.stringify({ error: 'unavailable' }), { status, headers: { 'Content-Type': 'application/json' } }) : undefined });
    const { hook } = memoryLocation({ path: `/leads/${sampleLead.id}` });
    renderWithQuery(<Router hook={hook}><Route path="/leads/:id"><LeadDetail /></Route></Router>);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(status === 503 ? 'Go online and try again' : 'unavailable to the account');
    expect(screen.queryByRole('button', { name: 'Prepare phone text' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
