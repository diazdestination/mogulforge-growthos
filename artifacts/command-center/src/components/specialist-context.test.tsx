import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { SpecialistContext } from './specialist-context';
import { specialistContextFor } from '@/lib/agent-team';
afterEach(cleanup);

it('matches workspace path segments without using arbitrary query text', () => {
  expect(specialistContextFor('/invoices/123?next=https://example.com')?.ids).toEqual(['invo','bill']);
  expect(specialistContextFor('/invoices-extra')).toBeNull();
  expect(specialistContextFor('/settings?next=/invoices')).toBeNull();
  expect(specialistContextFor('/account')).toBeNull();
});
it('opens a local guide and keeps financial roles and setup requirements distinct', () => {
  render(<SpecialistContext location="/invoices" />);
  fireEvent.click(screen.getByRole('button', {name:'Workspace guide'}));
  expect(screen.getByRole('dialog', {name:'Invoices workspace guide'})).toBeTruthy();
  expect(screen.getByRole('heading', {name:'Invoice documents & delivery'})).toBeTruthy();
  expect(screen.getByText(/Sending requires an approved mailbox/)).toBeTruthy();
  fireEvent.mouseDown(screen.getByRole('tab', {name:'BILL'}), {button:0,ctrlKey:false});
  fireEvent.click(screen.getByRole('tab', {name:'BILL'}));
  expect(screen.getByRole('heading', {name:'Balances & receipts'})).toBeTruthy();
  expect(screen.getByText(/do not move money or verify bank settlement/)).toBeTruthy();
  expect(screen.getByRole('link', {name:/Meet the specialist team/}).getAttribute('href')).toBe('/agent-team?specialist=bill');
});
it('closes the guide when navigating and leaves settings uncluttered', () => {
  const view=render(<SpecialistContext location="/invoices"/>);
  fireEvent.click(screen.getByRole('button', {name:'Workspace guide'}));
  view.rerender(<SpecialistContext location="/appointments"/>);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('complementary', {name:'Schedule specialist support'})).toBeTruthy();
  view.rerender(<SpecialistContext location="/settings"/>);
  expect(screen.queryByRole('button', {name:'Workspace guide'})).toBeNull();
});
it('returns keyboard focus to the guide trigger after closing', async () => {
  render(<SpecialistContext location="/estimates"/>);
  const trigger=screen.getByRole('button',{name:'Workspace guide'});
  trigger.focus(); fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('button',{name:'Close workspace guide'}));
  await waitFor(()=>expect(document.activeElement).toBe(trigger));
});
