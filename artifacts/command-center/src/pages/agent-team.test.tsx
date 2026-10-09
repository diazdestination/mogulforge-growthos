import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import AgentTeam from './agent-team';
import { AGENT_TEAM } from '@/lib/agent-team';

afterEach(cleanup);

it('represents all eight illustrated profiles with four inspectable tasks each', () => {
  expect(AGENT_TEAM).toHaveLength(8);
  expect(AGENT_TEAM.map(agent => agent.name)).toEqual([
    'ESTI', 'BILL', 'INVO', 'SCHED', 'APPT', 'CALLIE', 'MAINTAIN', 'SCOUT',
  ]);
  expect(AGENT_TEAM.every(agent => agent.tasks.length === 4)).toBe(true);
  render(<AgentTeam publicMode />);
  expect(screen.getAllByRole('button', { name: /^View / })).toHaveLength(8);
  expect(screen.getByRole('heading', { name: 'Growth OS' })).toBeTruthy();
  expect(
    screen.getByRole('link', { name: 'MogulForge GrowthOS home' }).querySelector('img')?.getAttribute('src'),
  ).toBe('/brand/mogulforge-mark.svg');
});

it('keeps customer balances distinct from subscriptions and payment collection', () => {
  render(<AgentTeam />);
  fireEvent.click(screen.getByRole('button', { name: /View BILL/ }));
  expect(screen.getByText(/Billing page manages GrowthOS subscriptions separately/)).toBeTruthy();
  expect(screen.getByText(/do not move money or verify bank settlement/)).toBeTruthy();
  expect(screen.getByRole('link', { name: /Review invoice balances/ }).getAttribute('href')).toBe('/invoices');
  expect(screen.queryByRole('link', { name: /Open billing/ })).toBeNull();
});

it('makes provider and customer-contact boundaries visible', () => {
  render(<AgentTeam />);
  fireEvent.click(screen.getByRole('button', { name: /View CALLIE/ }));
  expect(screen.getByText(/Neither pilot is live/)).toBeTruthy();
  expect(screen.getByText(/A phone answer may be voicemail; neither a call nor a handoff confirms a visit/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /View MAINTAIN/ }));
  expect(screen.getByText(/Staff follow-up tasks do not send customer reminders/)).toBeTruthy();
  expect(screen.getByRole('link', { name: /Open service desk/ }).getAttribute('href')).toBe('/service');
});

it('filters by business responsibilities and keeps detail selection coherent', () => {
  render(<AgentTeam />);
  fireEvent.click(screen.getByRole('button', { name: 'Sales & finance' }));
  expect(screen.getAllByRole('button', { name: /^View / })).toHaveLength(4);
  expect(screen.getByRole('button', { name: /View BILL/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /View BILL/ }));
  expect(screen.getByRole('heading', { name: 'Balances & receipts' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Customer operations' }));
  expect(screen.queryByRole('heading', { name: 'Balances & receipts' })).toBeNull();
});
