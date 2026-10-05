import { cleanup, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import Contacts from './contacts';
import LeadDetail from './lead-detail';
import { renderWithQuery } from '@/test/render';
import { mockApi, sampleLead, sampleContact } from '@/test/mock-api';
import { workspaceOrg as org, workspaceContact as contactId, workspaceId } from '@/test/customer-workspace-fixtures';

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const company = { id: org, name: 'Synthetic Contractor', slug: 'synthetic', timezone: 'America/New_York' };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('adds tenant-pinned work-record links in both contact-directory layouts without changing edit controls', async () => {
  mockApi('owner', { me: { organization: company }, handler: (_method, path) => path.endsWith('/api/v1/contacts') ? json([{ ...sampleContact, id: contactId, organizationId: org }]) : undefined });
  renderWithQuery(<Contacts />);
  const links = await screen.findAllByRole('link', { name: 'Open customer work record for Jane Homeowner' });
  expect(links).toHaveLength(2); for (const link of links) expect(link.getAttribute('href')).toBe(`/contacts/${contactId}?organizationId=${org}`);
  expect(screen.getAllByTestId('edit-contact')).toHaveLength(2);
});

it('does not relabel a mismatched tenant contact as a current-company destination', async () => {
  mockApi('owner', { me: { organization: company }, handler: (_method, path) => path.endsWith('/api/v1/contacts') ? json([{ ...sampleContact, id: contactId, organizationId: workspaceId(99) }]) : undefined });
  renderWithQuery(<Contacts />); await screen.findAllByText('Jane Homeowner');
  expect(screen.queryByRole('link', { name: /Open customer work record/ })).toBeNull();
});

it.each([false, true])('links the exact lead customer only when canonical company/identity agrees (mismatch=%s)', async mismatch => {
  const leadId = workspaceId(6);
  mockApi('viewer', { me: { organization: company }, handler: (_method, path) => {
    if (path.endsWith(`/api/v1/leads/${leadId}`)) return json({ ...sampleLead, id: leadId, organizationId: org, contactId, scoreReasons: [] });
    if (path.endsWith(`/api/v1/contacts/${contactId}`)) return json({ ...sampleContact, id: contactId, organizationId: mismatch ? workspaceId(99) : org });
    return undefined;
  } });
  const { hook } = memoryLocation({ path: `/leads/${leadId}` });
  renderWithQuery(<Router hook={hook}><Route path="/leads/:id" component={LeadDetail} /></Router>);
  await screen.findByText('Jane Homeowner');
  if (mismatch) expect(screen.queryByRole('link', { name: 'Open customer work record' })).toBeNull();
  else expect((await screen.findByRole('link', { name: 'Open customer work record' })).getAttribute('href')).toBe(`/contacts/${contactId}?organizationId=${org}`);
});
