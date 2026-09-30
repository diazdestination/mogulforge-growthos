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

it('does not present subscription billing as contractor invoicing', () => {
  render(<AgentTeam />);
  fireEvent.click(screen.getByRole('button', { name: /View BILL/ }));
  expect(screen.getByText(/existing Billing page manages GrowthOS subscriptions/)).toBeTruthy();
  expect(screen.getByText(/Not available as an automated agent yet/)).toBeTruthy();
  expect(screen.queryByRole('link', { name: /Open billing/ })).toBeNull();
});

it('makes provider and customer-contact boundaries visible', () => {
  render(<AgentTeam />);
  fireEvent.click(screen.getByRole('button', { name: /View CALLIE/ }));
  expect(screen.getByText(/Automatic missed-call texts and AI voice answering are not implemented/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /View MAINTAIN/ }));
  expect(screen.getByText(/They do not yet send customer reminders/)).toBeTruthy();
  expect(screen.getByRole('link', { name: /Open service desk/ }).getAttribute('href')).toBe('/service');
});

it('filters to profiles without a current workspace and keeps detail selection coherent', () => {
  render(<AgentTeam />);
  fireEvent.click(screen.getByRole('button', { name: 'Still in build' }));
  expect(screen.getAllByRole('button', { name: /^View / })).toHaveLength(2);
  expect(screen.getByRole('button', { name: /View BILL/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /View BILL/ }));
  expect(screen.getByRole('heading', { name: 'The Billing Guardian' })).toBeTruthy();
});
