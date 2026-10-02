import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Capture from './capture';
import { mockApi } from '@/test/mock-api';
import { renderWithQuery } from '@/test/render';

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/components/smart-sites-control', () => ({ SmartSitesControl: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  toast.mockReset();
});

async function showEndpoint() {
  mockApi('owner', {
    handler: (method, path) => method === 'GET' && path.endsWith('/capture-endpoints')
      ? new Response(JSON.stringify([{
          id: 'test-endpoint', name: 'Test form', isActive: false,
          receivedCount: 0, mapping: {}, url: 'https://example.test/test-only',
        }]), { headers: { 'Content-Type': 'application/json' } })
      : undefined,
  });
  renderWithQuery(<Capture />);
  fireEvent.click(screen.getByText('Advanced: existing forms & developer APIs'));
  return screen.findByRole('button', { name: 'Copy webhook URL for Test form' });
}

describe('capture clipboard receipts', () => {
  it('does not claim copied until the clipboard operation finishes', async () => {
    let finish!: () => void;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    fireEvent.click(await showEndpoint());
    expect(toast).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'Webhook URL copied' }));
    expect(writeText).toHaveBeenCalledWith('https://example.test/test-only');
  });

  it.each(['missing', 'rejected'])('offers manual recovery when clipboard is %s', async (failure) => {
    vi.stubGlobal('navigator', failure === 'missing' ? {} : {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) },
    });
    fireEvent.click(await showEndpoint());
    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Could not copy', description: 'Select the text and copy it manually.',
      variant: 'destructive',
    }));
    expect(toast).toHaveBeenCalledTimes(1);
  });
});
