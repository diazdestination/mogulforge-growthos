import { describe, expect, it } from 'vitest';
import { appointmentWorkspaceLoginPath, customerWorkspaceLocation, customerWorkspaceLoginPath, customerWorkspacePath } from './customer-workspace-links';
import { workspaceContact as contact, workspaceOrg as org, workspaceId } from '@/test/customer-workspace-fixtures';

const origin = 'https://growthos.example.test';
const customer = `/contacts/${contact}?organizationId=${org}`;
const appointment = `/appointments?appointmentId=${workspaceId(4)}&organizationId=${org}`;
describe('fixed customer and visit navigation boundaries', () => {
  it('pins exact customer identity, defaults visits, and preserves only a valid section through login', () => {
    expect(customerWorkspacePath(contact, org)).toBe(customer);
    expect(customerWorkspaceLocation(contact, '', org)).toEqual({ status: 'allowed', contactId: contact, section: 'appointments' });
    expect(customerWorkspaceLoginPath(`${customer}&section=services`, origin)).toBe(`${customer}&section=services`);
    expect(customerWorkspaceLoginPath(customer, origin)).toBe(customer);
    expect(appointmentWorkspaceLoginPath(appointment, origin)).toBe(appointment);
    expect(customerWorkspaceLoginPath(appointment, origin)).toBeNull();
    expect(appointmentWorkspaceLoginPath(customer, origin)).toBeNull();
  });
  it('does not switch current company or accept unknown and duplicate selectors', () => {
    expect(customerWorkspaceLocation(contact, `organizationId=${workspaceId(99)}`, org)).toEqual({ status: 'different-company' });
    expect(customerWorkspaceLocation(contact, 'section=services&section=tasks', org).status).toBe('invalid');
    expect(customerWorkspaceLocation(contact, 'cursor=pretend_cursor', org).status).toBe('invalid');
    expect(customerWorkspacePath('bad', org)).toBeNull();
  });
  it.each([
    `/contacts/${contact}`, `${customer}&returnTo=/logout`, `${customer}&organizationId=${org}`, `${customer}&section=finance`,
    `${customer}&section=`, `${customer}&section=tasks&section=tasks`, `${customer}#secret`, `/contacts/bad?organizationId=${org}`,
    `/contacts/${contact}?organizationId=bad`, `//evil.test${customer}`, `https://evil.test${customer}`, `/\\evil.test${customer}`,
    `/contacts/${contact}/?organizationId=${org}`, `/contacts/%2F${contact}?organizationId=${org}`,
  ])('rejects ambiguous or unpinned customer login return %s', value => expect(customerWorkspaceLoginPath(value, origin)).toBeNull());
  it.each([
    '/appointments', `/appointments?appointmentId=${workspaceId(4)}`, `${appointment}&next=/logout`, `${appointment}&appointmentId=${workspaceId(4)}`,
    `${appointment}&organizationId=${org}`, `${appointment}#secret`, `//evil.test${appointment}`, `/appointments?appointmentId=bad&organizationId=${org}`,
  ])('rejects ambiguous visit login return %s', value => expect(appointmentWorkspaceLoginPath(value, origin)).toBeNull());
});
