import { cleanup, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import Reactivation from './reactivation';
import { Shell } from '@/components/shell';
import { mockApi } from '@/test/mock-api';
import { renderWithQuery } from '@/test/render';

vi.mock('@workspace/replit-auth-web', () => ({ useAuth: () => ({ logout: vi.fn() }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('shares the application shell without duplicating daily navigation or main landmarks', async () => {
  mockApi('owner');
  const { hook } = memoryLocation({ path: '/reactivation' });
  renderWithQuery(<Router hook={hook}><Shell><Reactivation /></Shell></Router>);
  await screen.findByRole('region', { name: 'Reviewed source cutover & recovery email' });
  expect(screen.getAllByRole('navigation', { name: 'Daily work', exact: true })).toHaveLength(1);
  expect(screen.getAllByRole('main')).toHaveLength(1);
  expect(screen.getByText('Review imported opportunities, preserve their history, and prepare approved follow-up.')).toBeTruthy();
});
