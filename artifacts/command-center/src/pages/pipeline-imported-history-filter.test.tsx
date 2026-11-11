/**
 * Imported Housecall Pro history (completed or lost jobs) stays off the pipeline
 * by default; the "Show imported history" toggle asks the API to include it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import Pipeline from '@/pages/pipeline';
import { renderWithQuery } from '@/test/render';
import { mockApi } from '@/test/mock-api';

function leadRequests(fetchMock: ReturnType<typeof mockApi>) {
  return fetchMock.mock.calls
    .map(([input, init]: [RequestInfo | URL, RequestInit?]) => ({
      raw: String(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url),
      method: (init?.method ?? 'GET').toUpperCase(),
    }))
    .filter(c => c.method === 'GET' && c.raw.split('?')[0].endsWith('/api/v1/leads'))
    .map(c => Object.fromEntries(new URL(c.raw, 'http://test.local').searchParams.entries()));
}

describe('Pipeline "Show imported history" filter', () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, '', '/');
  });

  it('leaves imported history out by default and includes it when toggled', async () => {
    const fetchMock = mockApi('admin');
    renderWithQuery(<Pipeline />);
    await waitFor(() => expect(leadRequests(fetchMock).length).toBe(1));
    expect(leadRequests(fetchMock)[0].importedHistory).toBeUndefined();
    const toggle = screen.getByTestId('imported-history-filter');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);
    await waitFor(() => expect(leadRequests(fetchMock).length).toBe(2));
    expect(leadRequests(fetchMock)[1].importedHistory).toBe('include');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(window.location.search).toContain('imported=1');

    fireEvent.click(toggle);
    await waitFor(() => expect(window.location.search).not.toContain('imported=1'));
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('restores the toggle from the URL', async () => {
    window.history.replaceState(null, '', '/pipeline?imported=1');
    const fetchMock = mockApi('admin');
    renderWithQuery(<Pipeline />);
    await waitFor(() => expect(leadRequests(fetchMock).length).toBeGreaterThan(0));
    expect(leadRequests(fetchMock)[0].importedHistory).toBe('include');
    expect(screen.getByTestId('imported-history-filter').getAttribute('aria-pressed')).toBe('true');
  });
});
