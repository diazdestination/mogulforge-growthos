import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App';
import { workspaceContact, workspaceOrg, workspaceId } from '@/test/customer-workspace-fixtures';

vi.mock('@workspace/replit-auth-web', () => ({ useAuth: () => ({ user: null, isAuthenticated: false, isLoading: false }) }));
vi.mock('@/pages/landing', () => ({ default: () => <p>Public landing fixture</p> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([
  `/contacts/${workspaceContact}?organizationId=${workspaceOrg}`,
  `/contacts/${workspaceContact}?organizationId=${workspaceOrg}&section=services`,
  `/appointments?appointmentId=${workspaceId(4)}&organizationId=${workspaceOrg}`,
])('mounts login in place for an exact pinned work record without a redirect or private browser storage: %s', async path => {
  window.history.replaceState(null, '', path);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  render(<App />);
  expect(await screen.findByRole('button', { name: 'SIGN IN' })).toBeTruthy();
  expect(window.location.pathname + window.location.search).toBe(path);
  expect(screen.queryByText('Public landing fixture')).toBeNull(); expect(fetch).not.toHaveBeenCalled(); expect(setItem).not.toHaveBeenCalled();
  setItem.mockRestore();
});

it.each([
  `/contacts/${workspaceContact}`,
  `/contacts/${workspaceContact}?organizationId=${workspaceOrg}&returnTo=/logout`,
  `/contacts/${workspaceContact}?organizationId=${workspaceOrg}&section=unknown`,
  `/appointments?appointmentId=${workspaceId(4)}&organizationId=${workspaceOrg}&returnTo=/logout`,
  `/appointments?appointmentId=${workspaceId(4)}`,
])('does not preserve a malformed or unpinned work record as a login return: %s', async path => {
  window.history.replaceState(null, '', path); render(<App />);
  expect(await screen.findByText('Public landing fixture')).toBeTruthy(); expect(screen.queryByRole('button', { name: 'SIGN IN' })).toBeNull();
});
