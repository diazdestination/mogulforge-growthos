/**
 * The AutomationsTab message-body field must show a live preview using sample
 * placeholder values when the action type is send_email or send_sms, and must
 * warn about unknown placeholders — reusing the same TemplatePreviewBlock
 * already used on the Templates tab.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import Settings from '@/pages/settings';
import { CLIENT } from '@/lib/client.config';
import { renderWithQuery } from '@/test/render';
import { mockApi } from '@/test/mock-api';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderAutomationsTab() {
  mockApi('admin', {
    handler: (method, path) => {
      if (path.endsWith('/api/v1/settings')) {
        return json({
          id: 's1',
          organizationId: 'o1',
          businessProfile: {},
          services: [],
          serviceAreas: [],
        });
      }
      if (path.endsWith('/api/v1/automations')) return json([]);
      if (path.endsWith('/api/v1/automation-runs')) return json([]);
      if (path.endsWith('/api/v1/email-provider-status')) {
        return json({ provider: 'mock', recentSendFailures: 0 });
      }
      if (path.endsWith('/api/v1/sms-provider-status')) {
        return json({ provider: 'mock' });
      }
      return undefined;
    },
  });
  renderWithQuery(<Settings />);
}

async function openAutomationsTab() {
  const tab = await screen.findByRole('tab', { name: /automations/i });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
}

describe('Automation form message-body preview', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows a live preview with sample values while typing the message body (send_email)', async () => {
    renderAutomationsTab();
    await openAutomationsTab();

    const textarea = await screen.findByPlaceholderText(
      /Hi \{\{contact\.firstName\}\}/,
    );
    fireEvent.change(textarea, {
      target: { value: 'Hi {{contact.firstName}}, call {{business.phone}}!' },
    });

    const preview = await screen.findByTestId('preview-automation-create');
    expect(preview.textContent).toContain('Jordan');
    expect(preview.textContent).toContain(CLIENT.phone);
    expect(preview.textContent).not.toContain('{{contact.firstName}}');
  });

  it('warns about unknown placeholders in the message body', async () => {
    renderAutomationsTab();
    await openAutomationsTab();

    const textarea = await screen.findByPlaceholderText(
      /Hi \{\{contact\.firstName\}\}/,
    );
    fireEvent.change(textarea, {
      target: { value: 'Your job ref is {{lead.jobRef}}.' },
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('preview-automation-create-unknown-warning'),
      ).toBeTruthy();
    });
    const warning = screen.getByTestId('preview-automation-create-unknown-warning');
    expect(warning.textContent).toContain('{{lead.jobRef}}');
  });

  it('hides the preview when the message body is empty', async () => {
    renderAutomationsTab();
    await openAutomationsTab();

    // Confirm the textarea is present but the preview block is absent initially
    await screen.findByPlaceholderText(/Hi \{\{contact\.firstName\}\}/);
    expect(screen.queryByTestId('preview-automation-create')).toBeNull();
  });


});
