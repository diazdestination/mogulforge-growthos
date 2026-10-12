import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/test/render';
import { mockApi } from '@/test/mock-api';
import { AssistantProposalMarkers, isAssistantProposalMarker } from '@/components/assistant-proposal-marker';
vi.mock('@/components/revenue-workspace', () => ({ RevenueWorkspace: () => null }));
vi.mock('@/components/customer-replies', () => ({ CustomerReplies: () => null }));
import Bie from './bie';
import AgentTeam from './agent-team';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const briefing = {
  generatedAt: '2026-10-11T12:00:00Z', totalLeads: 1, importedLeads: 0,
  dataReadiness: { score: 1, leadsWithContactMethod: 1, leadsWithKnownValue: 0, googleSourcesConnected: 0, totalGoogleSources: 4 },
  revenueAtRiskCents: 0, unknownValueLeadCount: 0, opportunityCount: 0, opportunities: [], narrative: 'Synthetic BIE review', sources: [],
  policy: { enabled: false, allowedActions: [], dailyEmailCap: 1 },
};
const queued = (id: string, specialist: string | null, title: string) => ({
  id, actionType: 'create_task', status: 'proposed', title, rationale: 'Synthetic', evidence: {}, payload: { title }, estimatedValueCents: null,
  executionDetail: null, createdAt: '2026-10-11T12:00:00Z', specialist,
});

function setupBie(role: string, onRun = vi.fn((key: string) => json({ specialist: key.toUpperCase(), runId: 'run-1', proposals: [queued('p-new', key, 'New')], skippedCount: 0 }, 201))) {
  const request = mockApi(role, {
    handler: (method, path) => {
      if (path.endsWith('/bie/briefing')) return json(briefing);
      if (path.endsWith('/bie/actions')) return json([queued('p-1', 'scout', 'Estimate reminder 1 of 3'), queued('p-2', 'invo', 'Office review: multi-repair invoice before sending'), queued('p-3', null, 'Generic BIE task')]);
      if (path.endsWith('/email-intelligence')) return json({ source: null, providerConfigured: false, messagesAccepted: 0, factsAwaitingReview: 0, rawMessagesHeld: 0 });
      const run = path.match(/\/bie\/specialists\/(scout|invo)\/run$/);
      if (method === 'POST' && run) return onRun(run[1]!);
      return undefined;
    },
  });
  renderWithQuery(<Bie />);
  return { request, onRun };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('labels specialist proposals and runs SCOUT/INVO as proposal-only checks', async () => {
  const { onRun } = setupBie('owner');
  fireEvent.click(await screen.findByText('Advanced BIE analysis, integrations & policy'));
  expect(await screen.findByText('Estimate reminder 1 of 3')).toBeTruthy();
  expect(screen.getByText('SCOUT')).toBeTruthy();
  expect(screen.getByText('INVO')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Find follow-ups \(SCOUT\)/ }));
  await waitFor(() => expect(onRun).toHaveBeenCalledWith('scout'));
  expect(await screen.findByText(/SCOUT proposed 1 action for review\. Nothing was sent or changed\./)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Check invoices \(INVO\)/ }));
  await waitFor(() => expect(onRun).toHaveBeenCalledWith('invo'));
});

it('hides INVO from roles without invoice access and both runs from read-only roles', async () => {
  setupBie('sales_rep');
  expect(await screen.findByRole('button', { name: /Find follow-ups \(SCOUT\)/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Check invoices \(INVO\)/ })).toBeNull();
  cleanup();
  setupBie('viewer');
  await screen.findByText('Synthetic BIE review');
  expect(screen.queryByRole('button', { name: /Find follow-ups/ })).toBeNull();
});

it('renders assistant proposal markers with a Revenue Desk link and no approval controls', () => {
  const marker = { id: 'p-9', actionType: 'create_task', title: 'Follow-up task: Call back', status: 'proposed', reviewPath: '/bie' };
  expect(isAssistantProposalMarker(marker)).toBe(true);
  expect(isAssistantProposalMarker({ ...marker, status: 'executed' })).toBe(false);
  render(<AssistantProposalMarkers proposals={[marker as never]} />);
  expect(screen.getByText(/awaiting approval in Revenue Desk\. Nothing has been changed or sent\./)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Review in Revenue Desk' }).getAttribute('href')).toBe('/bie');
  expect(screen.queryByRole('button', { name: /approve|execute/i })).toBeNull();
});

it('shows SCOUT and INVO pending-approval counts in the signed-in team guide only', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/bie/specialists/scout/proposals')) return json([{ status: 'proposed' }, { status: 'proposed' }, { status: 'executed' }]);
    if (url.endsWith('/bie/specialists/invo/proposals')) return json([{ status: 'proposed' }]);
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<AgentTeam />);
  expect(await screen.findByText('2 awaiting approval')).toBeTruthy();
  expect(screen.getByText('1 awaiting approval')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /View SCOUT/ }));
  expect(screen.getByText(/SCOUT has 2 proposals awaiting staff approval/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Review in Revenue Desk' }).getAttribute('href')).toBe('/bie');
  cleanup();
  fetchMock.mockClear();
  render(<AgentTeam publicMode />);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.queryByText(/awaiting approval/)).toBeNull();
});
