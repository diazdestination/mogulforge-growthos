import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App';

vi.mock('@workspace/replit-auth-web', () => ({
  useAuth: () => ({ user: { id: 'signed-in-owner' }, isAuthenticated: true, isLoading: false }),
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

it('lets a signed-in owner consume their verification link before opening staff pages', async () => {
  window.history.replaceState(null, '', '/verify-email?token=synthetic-token');
  const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  render(<App />);
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole('button', { name: 'VERIFY EMAIL' }));
  expect(await screen.findByText('Your email is verified. You are securely signed in.')).toBeTruthy();
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/verify-email', expect.objectContaining({
    method: 'POST', credentials: 'include', body: JSON.stringify({ token: 'synthetic-token' }),
  }));
});
