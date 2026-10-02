/**
 * Task/contact/estimate/property form modals must surface a destructive
 * toast when the primary create call fails, and stay open so the user can
 * retry (same pattern as the project form modal). The appointment modal
 * surfaces an inline error instead — covered here too so no save form can
 * fail silently.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import TasksPage from '@/pages/tasks';
import ContactsPage from '@/pages/contacts';
import EstimatesPage from '@/pages/estimates';
import PropertiesPage from '@/pages/properties';
import AppointmentsPage from '@/pages/appointments';
import LeadDetailPage from '@/pages/lead-detail';
import { Route, Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { Toaster } from '@/components/ui/toaster';
import { renderWithQuery } from '@/test/render';
import { mockApi, sampleLead } from '@/test/mock-api';

function failPost(endpoint: string, message: string) {
  return (method: string, path: string) =>
    method === 'POST' && path.endsWith(endpoint)
      ? new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      : undefined;
}

function renderPage(page: React.ReactElement, handler: (method: string, path: string) => Response | undefined) {
  mockApi('admin', { handler });
  renderWithQuery(
    <>
      {page}
      <Toaster />
    </>,
  );
}

function modalRoot(): HTMLElement {
  // The modal overlay is the fixed inset-0 container rendered while open.
  const overlay = Array.from(document.querySelectorAll('div.fixed.inset-0')).at(-1);
  expect(overlay).toBeTruthy();
  return overlay as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('save forms never fail silently', () => {
  it('task form shows a destructive toast and stays open when create fails', async () => {
    renderPage(<TasksPage />, failPost('/api/v1/tasks', 'task boom'));

    fireEvent.click(await screen.findByTestId('add-task'));
    const modal = screen.getByRole('dialog', { name: 'New Task' });
    const title = modal.querySelector('input[aria-label="Title"]');
    expect(title).toBeTruthy();
    fireEvent.change(title!, { target: { value: 'Call the adjuster' } });
    fireEvent.click(screen.getByRole('button', { name: /save task/i }));

    await waitFor(() => expect(screen.getByText(/task not created/i)).toBeTruthy());
    expect(screen.getByText(/task boom/i)).toBeTruthy();
    // Modal stays open for retry.
    expect(screen.getByRole('button', { name: /save task/i })).toBeTruthy();
  });

  it('contact form shows a destructive toast and stays open when create fails', async () => {
    renderPage(<ContactsPage />, failPost('/api/v1/contacts', 'contact boom'));

    fireEvent.click(await screen.findByTestId('add-contact'));
    const modal = modalRoot();
    const [firstName] = Array.from(modal.querySelectorAll('input'));
    fireEvent.change(firstName, { target: { value: 'Jane' } });
    fireEvent.click(screen.getByRole('button', { name: /save contact/i }));

    await waitFor(() => expect(screen.getByText(/contact not created/i)).toBeTruthy());
    expect(screen.getByText(/contact boom/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /save contact/i })).toBeTruthy();
  });

  it('estimate form shows a destructive toast and stays open when create fails', async () => {
    renderPage(<EstimatesPage />, failPost('/api/v1/estimates', 'estimate boom'));

    fireEvent.click(await screen.findByRole('button', { name: /new estimate/i }));
    const modal = modalRoot();
    const [title] = Array.from(modal.querySelectorAll('input'));
    fireEvent.change(title, { target: { value: 'Roof replacement' } });

    const leadSelect = await screen.findByTestId('lead-select');
    await waitFor(() =>
      expect(
        Array.from((leadSelect as HTMLSelectElement).options).some(o => o.value === sampleLead.id),
      ).toBe(true),
    );
    fireEvent.change(leadSelect, { target: { value: sampleLead.id } });

    fireEvent.click(screen.getByRole('button', { name: /save estimate/i }));

    await waitFor(() => expect(screen.getByText(/estimate not created/i)).toBeTruthy());
    expect(screen.getByText(/estimate boom/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /save estimate/i })).toBeTruthy();
  });

  it('property form shows a destructive toast and stays open when create fails', async () => {
    renderPage(<PropertiesPage />, failPost('/api/v1/properties', 'property boom'));

    fireEvent.click(await screen.findByRole('button', { name: /add property/i }));
    const modal = modalRoot();
    const inputs = Array.from(modal.querySelectorAll('input'));
    // address1, address2, city, state, zip
    const values = ['1 Main St', '', 'Springfield', 'IL', '62701'];
    inputs.slice(0, 5).forEach((input, i) => {
      if (values[i]) fireEvent.change(input, { target: { value: values[i] } });
    });
    fireEvent.click(screen.getByRole('button', { name: /save property/i }));

    await waitFor(() => expect(screen.getByText(/property not created/i)).toBeTruthy());
    expect(screen.getByText(/property boom/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /save property/i })).toBeTruthy();
  });

  it('appointment form surfaces the failure inline and stays open when create fails', async () => {
    const failCreate = failPost('/api/v1/appointments', 'appointment boom');
    renderPage(<AppointmentsPage />, (method, path) => {
      if (method === 'GET' && path.endsWith('/api/v1/settings/inspection-availability')) {
        return new Response(
          JSON.stringify({
            days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
            windows: [{ startHour: 0, endHour: 24 }],
            timezone: 'UTC',
            blackoutDates: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return failCreate(method, path);
    });

    fireEvent.click(await screen.findByTestId('add-appointment'));
    const modal = modalRoot();
    const start = modal.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    expect(start).toBeTruthy();
    fireEvent.change(start, { target: { value: '2030-06-01T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: /save appt/i }));

    await waitFor(() => expect(screen.getByText(/appointment boom/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: /save appt/i })).toBeTruthy();
  });

  it('lead note composer shows a destructive toast and keeps the note text when save fails', async () => {
    const failCreate = failPost(`/api/v1/leads/${sampleLead.id}/activities`, 'note boom');
    mockApi('admin', {
      handler: (method, path) => {
        if (method === 'GET' && path.endsWith(`/api/v1/leads/${sampleLead.id}`)) {
          return new Response(JSON.stringify({ ...sampleLead, scoreReasons: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return failCreate(method, path);
      },
    });
    const { hook } = memoryLocation({ path: `/leads/${sampleLead.id}` });
    renderWithQuery(
      <Router hook={hook}>
        <Route path="/leads/:id" component={LeadDetailPage} />
        <Toaster />
      </Router>,
    );

    const noteInput = (await screen.findByPlaceholderText(/add a note to this lead/i)) as HTMLTextAreaElement;
    fireEvent.change(noteInput, { target: { value: 'Homeowner called back' } });
    fireEvent.click(screen.getByRole('button', { name: /post note/i }));

    await waitFor(() => expect(screen.getByText(/note not saved/i)).toBeTruthy());
    expect(screen.getByText(/note boom/i)).toBeTruthy();
    // The composer keeps the note text so the user can retry.
    expect(noteInput.value).toBe('Homeowner called back');
  });

  it('lead status dropdown shows a destructive toast when the update fails', async () => {
    mockApi('admin', {
      handler: (method, path) => {
        if (method === 'GET' && path.endsWith(`/api/v1/leads/${sampleLead.id}`)) {
          return new Response(JSON.stringify({ ...sampleLead, scoreReasons: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (method !== 'GET' && path.endsWith(`/api/v1/leads/${sampleLead.id}`)) {
          return new Response(JSON.stringify({ error: 'status boom' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          });
        }
        return undefined;
      },
    });
    const { hook } = memoryLocation({ path: `/leads/${sampleLead.id}` });
    renderWithQuery(
      <Router hook={hook}>
        <Route path="/leads/:id" component={LeadDetailPage} />
        <Toaster />
      </Router>,
    );

    const stageSelect = (await screen.findByDisplayValue(sampleLead.status)) as HTMLSelectElement;
    fireEvent.change(stageSelect, { target: { value: 'qualified' } });

    await waitFor(() => expect(screen.getByText(/status not updated/i)).toBeTruthy());
    expect(screen.getByText(/status boom/i)).toBeTruthy();
  });
});
