import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeadContactActions } from './lead-contact-actions';
import { mockApi, sampleLead } from '@/test/mock-api';
import { renderWithQuery } from '@/test/render';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('contact action handoff evidence', () => {
  it('takes Text to the gated lead drafts, not a bypassing native SMS link', async () => {
    const requests = mockApi('owner');
    renderWithQuery(<LeadContactActions leadId={sampleLead.id} phone="(404) 555-0100" />);
    const link = await screen.findByTestId('button-lead-text');
    expect(link.getAttribute('href')).toBe(`/leads/${sampleLead.id}#manual-sms`);
    link.addEventListener('click', event => event.preventDefault());
    fireEvent.click(link);
    expect(requests.mock.calls.every(([, init]) => (init?.method || 'GET') === 'GET')).toBe(true);
  });
  it('does not invent contacted/sent evidence from opening a phone dialer', async () => {
    const requests = mockApi('owner');
    renderWithQuery(<LeadContactActions leadId={sampleLead.id} phone="(404) 555-0100" />);
    const link = await screen.findByTestId('button-lead-call');
    expect(link.getAttribute('href')).toBe('tel:+14045550100');
    link.addEventListener('click', event => event.preventDefault());
    fireEvent.click(link);
    expect(requests.mock.calls.every(([, init]) => (init?.method || 'GET') === 'GET')).toBe(true);
  });
  it('rejects a multi-recipient/URI-injected stored phone', () => {
    mockApi('owner');
    renderWithQuery(<LeadContactActions leadId={sampleLead.id} phone="+14045550100;6785550100?body=injected" />);
    expect(screen.queryByTestId('button-lead-call')).toBeNull();
    expect(screen.queryByTestId('button-lead-text')).toBeNull();
  });
});
