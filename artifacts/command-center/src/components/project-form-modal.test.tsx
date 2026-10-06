/**
 * Covers the "Start Project" flow launched from an accepted estimate:
 * creating the project must advance the lead to production_scheduled, and a
 * failed lead update must surface an error toast instead of closing silently.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import ProjectFormModal from '@/components/project-form-modal';
import { Toaster } from '@/components/ui/toaster';
import { renderWithQuery } from '@/test/render';
import { mockApi, sampleLead } from '@/test/mock-api';

const sampleProject = {
  id: 'p1-00000000',
  leadId: sampleLead.id,
  name: 'Roof Replacement',
  estimateId: 'e1-00000000',
  status: 'scheduled',
  scheduledStart: null,
  scheduledEnd: null,
  crewUserIds: [],
  crewNotes: null,
  createdAt: new Date().toISOString(),
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function callInfo([input, init]: [RequestInfo | URL, RequestInit?]) {
  return {
    method: (init?.method ?? 'GET').toUpperCase(),
    path: String(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    ).split('?')[0],
    body: init?.body,
  };
}

function renderStartProject(
  handler?: (method: string, path: string) => Response | undefined,
) {
  const fetchMock = mockApi('admin', {
    handler: (method, path) => {
      const override = handler?.(method, path);
      if (override) return override;
      if (method === 'POST' && path.endsWith('/api/v1/projects')) {
        return jsonResponse(sampleProject, 201);
      }
      if (method === 'PATCH' && path.endsWith(`/api/v1/leads/${sampleLead.id}`)) {
        return jsonResponse({ ...sampleLead, status: 'production_scheduled' });
      }
      return undefined;
    },
  });
  const onClose = vi.fn();
  renderWithQuery(
    <>
      <ProjectFormModal
        project={null}
        defaults={{
          leadId: sampleLead.id,
          estimateId: 'e1-00000000',
          name: 'Roof Replacement',
          offerLeadAdvance: true,
        }}
        onClose={onClose}
      />
      <Toaster />
    </>,
  );
  return { fetchMock, onClose };
}

describe('Start Project flow', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('creates the project and advances the lead to production_scheduled', async () => {
    const { fetchMock, onClose } = renderStartProject();

    const advance = await screen.findByRole('checkbox', {
      name: /advance lead status/i,
    }) as HTMLInputElement;
    expect(advance.checked).toBe(true);

    fireEvent.click(await screen.findByRole('button', { name: /start project/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const calls = fetchMock.mock.calls.map(callInfo);

    const createCall = calls.find(
      c => c.method === 'POST' && c.path.endsWith('/api/v1/projects'),
    );
    expect(createCall).toBeDefined();
    expect(JSON.parse(String(createCall!.body))).toMatchObject({
      leadId: sampleLead.id,
      name: 'Roof Replacement',
      estimateId: 'e1-00000000',
    });

    const leadCall = calls.find(
      c => c.method === 'PATCH' && c.path.endsWith(`/api/v1/leads/${sampleLead.id}`),
    );
    expect(leadCall).toBeDefined();
    expect(JSON.parse(String(leadCall!.body))).toMatchObject({
      status: 'production_scheduled',
    });

    // No error toast on the happy path.
    expect(screen.queryByText(/lead status not updated/i)).toBeNull();
  });

  it('shows an error toast and keeps the modal open when project creation fails', async () => {
    const { onClose } = renderStartProject((method, path) => {
      if (method === 'POST' && path.endsWith('/api/v1/projects')) {
        return jsonResponse({ error: 'boom' }, 500);
      }
      return undefined;
    });

    fireEvent.click(await screen.findByRole('button', { name: /start project/i }));

    await waitFor(() => {
      expect(screen.getByText(/project not created/i)).toBeTruthy();
    });
    // The server-provided error message is surfaced when present.
    expect(screen.getByText(/boom/i)).toBeTruthy();

    // The modal must stay open so the user can retry.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows an error toast when the lead status update fails', async () => {
    const { fetchMock, onClose } = renderStartProject((method, path) => {
      if (method === 'PATCH' && path.endsWith(`/api/v1/leads/${sampleLead.id}`)) {
        return jsonResponse({ error: 'boom' }, 500);
      }
      return undefined;
    });

    fireEvent.click(await screen.findByRole('button', { name: /start project/i }));

    // The failure must be surfaced to the user, not swallowed.
    await waitFor(() => {
      expect(screen.getByText(/lead status not updated/i)).toBeTruthy();
    });
    expect(
      screen.getByText(/project was created, but advancing the lead/i),
    ).toBeTruthy();

    // The project itself was still created and the modal closed.
    const createCall = fetchMock.mock.calls
      .map(callInfo)
      .find(c => c.method === 'POST' && c.path.endsWith('/api/v1/projects'));
    expect(createCall).toBeDefined();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('retries the lead update from the toast and dismisses it on success', async () => {
    let failLeadUpdate = true;
    const { fetchMock, onClose } = renderStartProject((method, path) => {
      if (
        failLeadUpdate &&
        method === 'PATCH' &&
        path.endsWith(`/api/v1/leads/${sampleLead.id}`)
      ) {
        return jsonResponse({ error: 'boom' }, 500);
      }
      return undefined;
    });

    fireEvent.click(await screen.findByRole('button', { name: /start project/i }));

    // Wait for the submit flow (and its failed lead update) to finish so we
    // grab the Retry button from the freshly-raised toast, not a stale one.
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const retry = await screen.findByRole('button', { name: /retry/i });

    failLeadUpdate = false;
    fireEvent.click(retry);

    const patchCalls = () =>
      fetchMock.mock.calls
        .map(callInfo)
        .filter(
          c => c.method === 'PATCH' && c.path.endsWith(`/api/v1/leads/${sampleLead.id}`),
        );

    await waitFor(() => expect(patchCalls().length).toBe(2));
    expect(JSON.parse(String(patchCalls()[1].body))).toMatchObject({
      status: 'production_scheduled',
    });

    // Success dismisses the toast.
    await waitFor(() => {
      expect(screen.queryByText(/lead status not updated/i)).toBeNull();
    });
  });

  it('re-surfaces the toast when the retry fails again', async () => {
    const { fetchMock, onClose } = renderStartProject((method, path) => {
      if (method === 'PATCH' && path.endsWith(`/api/v1/leads/${sampleLead.id}`)) {
        return jsonResponse({ error: 'boom' }, 500);
      }
      return undefined;
    });

    fireEvent.click(await screen.findByRole('button', { name: /start project/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const retry = await screen.findByRole('button', { name: /retry/i });
    fireEvent.click(retry);

    const patchCalls = () =>
      fetchMock.mock.calls
        .map(callInfo)
        .filter(
          c => c.method === 'PATCH' && c.path.endsWith(`/api/v1/leads/${sampleLead.id}`),
        );
    await waitFor(() => expect(patchCalls().length).toBe(2));

    // The toast (with its Retry action) is still there for another attempt.
    expect(screen.getByText(/lead status not updated/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });
});
