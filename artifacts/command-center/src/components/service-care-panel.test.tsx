import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto, createHash } from "node:crypto";
import { makeSchedulingContext } from "@/test/scheduling-ui-fixtures";
import {
  careCanonicalJson,
  serviceCareBookingSchema,
} from "../../../api-server/src/services/service-care-booking-contract";
import { formatSchedulingWallTime } from "@workspace/scheduling-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import { renderHook } from "@testing-library/react";
import { workMember, workId } from "@/test/customer-work-fixtures";
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import ServiceCarePanel, {
  useCareBookingCommand,
} from "@/components/service-care-panel";
import { mockApi } from '@/test/mock-api';
import { renderWithQuery } from '@/test/render';

const version = '2026-10-02T12:00:00.000Z';
const preview = { channel: 'email', recipient: 'customer@example.invalid', subject: 'Recorded service', body: 'No appointment is booked yet. This reminder does not determine warranty coverage.', fingerprint: 'a'.repeat(64), runAt: '2035-01-01T15:00:00.000Z', sender: { senderEmail: 'office@example.invalid', provider: 'microsoft' } };
const initial = () => {
  const source = {
    sourceKind: "direct_customer" as const,
    leadId: null,
    contactId: workId(702),
    propertyId: null,
    estimateId: null,
  };
  return {
    expectedUpdatedAt: version,
    active: true,
    preview,
    blockReason: null,
    deferredReason: null,
    reminder: null,
    response: null,
    appointment: null,
    booking: null,
    scheduling: {
      organizationId: workMember.organization.id,
      actorUserId: workMember.id,
      obligationId: workId(801),
      expectedUpdatedAt: version,
      appointmentType: "inspection",
      source,
      review: {
        state: "ready",
        policy: null,
        context: makeSchedulingContext({
          organizationId: workMember.organization.id,
          policyRevision: 0,
          policyDigest: null,
          source,
          applicableRules: {
            newTravelGapMinutes: 0,
            companyCeiling: null,
            inspectionCeiling: 2,
          },
        }),
      },
    },
  };
};
const reminder = (state: string) => ({ state, channel: 'email', recipient: preview.recipient, subject: preview.subject, body: preview.body, agreementNote: 'Reviewed synthetic agreement.', runAt: preview.runAt, detail: null, providerEvidence: null, deliveryConfirmed: false });
function renderPanel(editable = true) {
  return renderWithQuery(
    <ServiceCarePanel
      obligationId={workId(801)}
      editable={editable}
      onChanged={vi.fn(async () => {})}
      onClose={vi.fn()}
    />,
  );
}
function setup(handler: (method: string, path: string) => Response | undefined,
) {
  return mockApi("office", {
    handler: (method, path) =>
      path.endsWith("/me")
        ? Response.json(workMember)
        : path.endsWith('/api/v1/users') ? Response.json([{ id: 'staff-one', firstName: 'Synthetic', lastName: 'Technician', role: 'office', isActive: true, operationallyEligible: true }]) : handler(method, path),
  });
}
beforeEach(() => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("service booking custody", () => {
  const original = () => ({
    requestId: "AB000000-0000-4000-8000-000000000001",
    expectedUpdatedAt: "2026-10-02T12:00:00.123456Z",
    responseId: workId(802),
    assignedUserId: "staff-one",
    scheduledStart: "2035-01-01T17:00:00.123456Z",
    scheduledEnd: "2035-01-01T18:00:00.123456Z",
    type: "other" as const,
    customerConfirmed: true as const,
  });
  const custodyKey = `growthos.service-care.booking.v1:${workMember.organization.id}:${workMember.id}:${workId(801)}`;
  function retained() {
    const body = original(),
      hash = createHash("sha256")
        .update(careCanonicalJson(serviceCareBookingSchema.parse(body)))
        .digest("hex");
    sessionStorage.setItem(
      custodyKey,
      JSON.stringify({
        formatVersion: 1,
        organizationId: workMember.organization.id,
        actorUserId: workMember.id,
        obligationId: workId(801),
        body,
        hash,
        outcome: null,
      }),
    );
    return { body, hash };
  }
  const proof = (hash: string) => ({
    formatVersion: 1,
    status: "committed",
    organizationId: workMember.organization.id,
    actorUserId: workMember.id,
    obligationId: workId(801),
    bookingId: workId(804),
    requestId: original().requestId,
    requestFingerprint: hash,
    responseId: workId(802),
    expectedUpdatedAt: original().expectedUpdatedAt,
    appointmentId: workId(803),
  });
  function mountCustody() {
    const client = new QueryClient();
    client.setQueryData(getGetMeQueryKey(), workMember);
    const changed = vi.fn();
    const hook = renderHook(() => useCareBookingCommand(workId(801), changed), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    return { ...hook, client, changed };
  }
  it("keeps a lost booking across remount and dispatches only its original raw source command on explicit retry", async () => {
    const saved = retained();
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => {
      throw new Error("lost");
    });
    vi.stubGlobal("fetch", fetcher);
    const first = mountCustody();
    await waitFor(() =>
      expect(first.result.current.pending).toEqual(saved.body),
    );
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => {
      await first.result.current.retry();
    });
    first.unmount();
    const second = mountCustody();
    await waitFor(() =>
      expect(second.result.current.pending).toEqual(saved.body),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockImplementation(async () =>
      Response.json({
        appointmentId: workId(803),
        replayed: true,
        bookingOutcome: proof(saved.hash),
      }),
    );
    await act(async () => {
      await second.result.current.retry();
    });
    expect(second.result.current.outcome).toEqual(proof(saved.hash));
    expect(second.changed).toHaveBeenCalledOnce();
    expect(
      fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body))),
    ).toEqual([saved.body, saved.body]);
    await act(async () => {
      await second.result.current.retry();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(["actor", "hash", "request", "timestamp"] as const)(
    "retains original custody after an unbound %s proof",
    async (field) => {
      const saved = retained(),
        bad = proof(saved.hash);
      if (field === "actor") bad.actorUserId = "other";
      if (field === "hash") bad.requestFingerprint = "f".repeat(64);
      if (field === "request") bad.requestId = workId(805);
      if (field === "timestamp") bad.expectedUpdatedAt = version;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            appointmentId: workId(803),
            replayed: true,
            bookingOutcome: bad,
          }),
        ),
      );
      const hook = mountCustody();
      await waitFor(() =>
        expect(hook.result.current.pending).toEqual(saved.body),
      );
      await act(async () => {
        await hook.result.current.retry();
      });
      expect(hook.result.current.outcome).toBeNull();
      expect(hook.result.current.pending).toEqual(saved.body);
      expect(hook.changed).not.toHaveBeenCalled();
    },
  );
  it("fences a valid deferred booking proof after revoke and restore in the actual member cache", async () => {
    const saved = retained();
    let resolve!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((r) => {
            resolve = r;
          }),
      ),
    );
    const hook = mountCustody();
    await waitFor(() => expect(hook.result.current.pending).not.toBeNull());
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.retry();
    });
    await waitFor(() => expect(resolve).toBeDefined());
    act(() => {
      hook.client.setQueryData(getGetMeQueryKey(), {
        ...workMember,
        role: "viewer",
      });
      hook.client.setQueryData(getGetMeQueryKey(), workMember);
    });
    await act(async () => {
      resolve(
        Response.json({
          appointmentId: workId(803),
          replayed: true,
          bookingOutcome: proof(saved.hash),
        }),
      );
      await pending;
    });
    expect(hook.changed).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem(custodyKey)!).outcome).toBeNull();
  });
  it.each(["readback", "WebCrypto"] as const)(
    "blocks a fresh booking before POST when %s fails",
    async (failure) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const hook = mountCustody();
      await waitFor(() => expect(hook.result.current.locked).toBe(false));
      if (failure === "readback")
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {});
      else
        vi.spyOn(crypto.subtle, "digest").mockRejectedValue(
          new Error("unavailable"),
        );
      const context = initial().scheduling.review.context,
        body = {
          ...original(),
          type: "inspection" as const,
          scheduledStart: "2035-01-01T17:00:00Z",
          scheduledEnd: "2035-01-01T18:00:00Z",
          schedulingReview: {
            context,
            duration: { kind: "explicit" as const, preset: null },
            startWallTime: formatSchedulingWallTime(
              "2035-01-01T17:00:00Z",
              context.companyTimeZone,
            ),
            endWallTime: formatSchedulingWallTime(
              "2035-01-01T18:00:00Z",
              context.companyTimeZone,
            ),
          },
        };
      await act(async () => {
        await hook.result.current.submit(body);
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(hook.result.current.locked).toBe(true);
    },
  );
  it.each(["success", "storage failure", "retired UUID"] as const)(
    "retains committed proof while explicitly preparing distinct future service work: %s",
    async (mode) => {
      const saved = retained(),
        value = JSON.parse(sessionStorage.getItem(custodyKey)!);
      value.outcome = proof(saved.hash);
      sessionStorage.setItem(custodyKey, JSON.stringify(value));
      const bytes = sessionStorage.getItem(custodyKey);
      const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => {
        throw new Error("lost new acknowledgement");
      });
      vi.stubGlobal("fetch", fetcher);
      const hook = mountCustody();
      await waitFor(() => expect(hook.result.current.outcome).not.toBeNull());
      const read = initial().scheduling as any;
      act(() =>
        hook.result.current.prepareSeparate(read, original().responseId),
      );
      expect(hook.result.current.locked).toBe(true);
      act(() => hook.result.current.prepareSeparate(read, workId(809)));
      expect(hook.result.current.separate).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
      if (mode === "storage failure")
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {});
      const context = read.review.context,
        fresh = {
          ...original(),
          requestId:
            mode === "retired UUID"
              ? original().requestId.toLowerCase()
              : workId(810),
          responseId: workId(809),
          expectedUpdatedAt: version,
          type: "inspection" as const,
          scheduledStart: "2035-01-01T17:00:00Z",
          scheduledEnd: "2035-01-01T18:00:00Z",
          schedulingReview: {
            context,
            duration: { kind: "explicit" as const, preset: null },
            startWallTime: formatSchedulingWallTime(
              "2035-01-01T17:00:00Z",
              context.companyTimeZone,
            ),
            endWallTime: formatSchedulingWallTime(
              "2035-01-01T18:00:00Z",
              context.companyTimeZone,
            ),
          },
        };
      await act(async () => {
        await hook.result.current.submit(fresh);
      });
      if (mode === "success") {
        expect(fetcher).toHaveBeenCalledOnce();
        const current = JSON.parse(sessionStorage.getItem(custodyKey)!);
        expect(current.completed[0].outcome).toEqual(proof(saved.hash));
        expect(current.retiredRequestIds).toEqual([original().requestId]);
        hook.unmount();
        const remount = mountCustody();
        await waitFor(() =>
          expect(remount.result.current.pending).toEqual(fresh),
        );
        expect(fetcher).toHaveBeenCalledOnce();
      } else {
        expect(fetcher).not.toHaveBeenCalled();
        expect(hook.result.current.outcome).toEqual(proof(saved.hash));
        expect(sessionStorage.getItem(custodyKey)).toBe(bytes);
        expect(hook.result.current.locked).toBe(true);
      }
    },
  );
  it("retains corrupt original bytes and forbids booking or retry dispatch", async () => {
    const client = new QueryClient();
    client.setQueryData(getGetMeQueryKey(), workMember);
    const key = `growthos.service-care.booking.v1:${workMember.organization.id}:${workMember.id}:${workId(801)}`;
    sessionStorage.setItem(key, "{broken");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const hook = renderHook(() => useCareBookingCommand(workId(801), vi.fn()), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() => expect(hook.result.current.locked).toBe(true));
    await act(async () => {
      await hook.result.current.retry();
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBe("{broken");
  });
});

describe("service customer-care approval", () => {
  it('shows the exact recipient, selected Microsoft identity and expected-service limits before approval', async () => {
    const fetch = setup((method, path) => method === 'GET' && path.endsWith('/care') ? Response.json(initial()) : undefined);
    renderPanel();
    expect(await screen.findByText(/To: customer@example.invalid/)).toHaveProperty('textContent', expect.stringContaining('office@example.invalid (microsoft)'));
    expect(screen.getByRole('button', { name: 'Approve one reminder' })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('Current service agreement / customer expectation evidence'), { target: { value: 'Current service agreement confirmed by office.' } });
    fireEvent.click(screen.getByLabelText(/I reviewed this exact message/));
    expect(screen.getByRole('button', { name: 'Approve one reminder' })).toHaveProperty('disabled', false);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });
  it('queues one reviewed fingerprint and shows the stored receipt instead of a resend control', async () => {
    let approved = false;
    const fetch = setup((method, path) => {
      if (method === 'POST' && path.endsWith('/reminder')) { approved = true; return Response.json({ approvalId: 'approval' }); }
      if (method === 'GET' && path.endsWith('/care')) return Response.json({ ...initial(), reminder: approved ? reminder('pending') : null });
    });
    renderPanel(); await screen.findByText(/To: customer@example.invalid/);
    fireEvent.change(screen.getByLabelText('Current service agreement / customer expectation evidence'), { target: { value: 'Current service agreement confirmed by office.' } });
    fireEvent.click(screen.getByLabelText(/I reviewed this exact message/)); fireEvent.click(screen.getByRole('button', { name: 'Approve one reminder' }));
    expect(await screen.findByText('Queued — not sent yet')).toBeTruthy();
    const [, request] = fetch.mock.calls.find(([url, init]) => String(url).endsWith('/reminder') && init?.method === 'POST')!;
    expect(JSON.parse(String(request?.body))).toMatchObject({ expectedUpdatedAt: version, channel: 'email', previewFingerprint: preview.fingerprint, expectedServiceConfirmed: true });
    expect(screen.queryByRole('button', { name: 'Approve one reminder' })).toBeNull();
  });
  it('locks writes after a lost response until explicit refresh reveals the actual receipt, without auto retry', async () => {
    let accepted = false;
    const fetch = setup((method, path) => {
      if (method === 'POST' && path.endsWith('/reminder')) { accepted = true; return Response.json({ error: 'Acknowledgment lost' }, { status: 503 }); }
      if (method === 'GET' && path.endsWith('/care')) return Response.json({ ...initial(), reminder: accepted ? reminder('pending') : null });
    });
    renderPanel();
    await screen.findByText(/To: customer@example.invalid/);
    fireEvent.change(screen.getByLabelText('Current service agreement / customer expectation evidence'), { target: { value: 'Current service agreement confirmed by office.' } });
    fireEvent.click(screen.getByLabelText(/I reviewed this exact message/)); fireEvent.click(screen.getByRole('button', { name: 'Approve one reminder' }));
    expect(
      await screen.findByText(/Acknowledgment lost.*No automatic retry/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve one reminder' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh and review' }));
    expect(await screen.findByText('Queued — not sent yet')).toBeTruthy();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('requires a fresh explicit approval after stale-version refresh, not silently adopted permission', async () => {
    let refreshed = false;
    setup((method, path) => {
      if (method === 'POST') { refreshed = true; return Response.json({ error: 'Service changed' }, { status: 409 }); }
      if (path.endsWith('/care')) return Response.json({ ...initial(), expectedUpdatedAt: refreshed ? '2026-10-02T13:00:00.000Z' : version });
    });
    renderPanel();
    await screen.findByText(/To: customer@example.invalid/);
    fireEvent.change(screen.getByLabelText('Current service agreement / customer expectation evidence'), { target: { value: 'Current service agreement confirmed by office.' } });
    fireEvent.click(screen.getByLabelText(/I reviewed this exact message/)); fireEvent.click(screen.getByRole('button', { name: 'Approve one reminder' }));
    await screen.findByText(/Service changed.*No automatic retry/);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh and review' }));
    await waitFor(() =>
      expect(
        screen.queryByText(/Service changed.*No automatic retry/),
      ).toBeNull(),
    );
    expect(screen.getByLabelText(/I reviewed this exact message/)).toHaveProperty('checked', false);
    expect(screen.getByRole('button', { name: 'Approve one reminder' })).toHaveProperty('disabled', true);
  });
  it('shows an unknown send receipt without a resend or delivered claim', async () => {
    setup(() => Response.json({ ...initial(), reminder: reminder('indeterminate') })); renderPanel();
    expect(await screen.findByText('Unknown send result — operator reconciliation required')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve one reminder' })).toBeNull();
    expect(screen.queryByText(/^Delivered$/)).toBeNull();
  });
  it('labels a standing-admitted original receipt without claiming individual approval or offering a second reminder', async () => {
    setup(() => Response.json({ ...initial(), reminder: { ...reminder('pending'), origin: 'standing', policyRevisionId: 'revision' } })); renderPanel();
    expect(await screen.findByText(/Standing-policy admission — not a new individual staff approval/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve one reminder' })).toBeNull();
  });
  it('invalidates customer evidence checkboxes on edits instead of silently reusing earlier attestation', async () => {
    setup(() => Response.json(initial())); renderPanel(); await screen.findByText(/To: customer@example.invalid/);
    fireEvent.change(screen.getByLabelText('Current service agreement / customer expectation evidence'), { target: { value: 'Synthetic agreement first reviewed.' } });
    fireEvent.click(screen.getByLabelText(/I reviewed this exact message/));
    fireEvent.change(screen.getByLabelText('Current service agreement / customer expectation evidence'), { target: { value: 'Different synthetic agreement evidence.' } });
    expect(screen.getByLabelText(/I reviewed this exact message/)).toHaveProperty('checked', false);
    fireEvent.click(screen.getByLabelText(/I reviewed the actual customer response/));
    fireEvent.change(screen.getByLabelText('Customer outcome'), { target: { value: 'declined' } });
    expect(screen.getByLabelText(/I reviewed the actual customer response/)).toHaveProperty('checked', false);
  });
  it('does not refresh or invoke parent callbacks for a late mutation after the panel has closed', async () => {
    let finish!: (response: Response) => void; const deferred = new Promise<Response>(resolve => { finish = resolve; });
    const fetch = setup((_method, path) => path.endsWith('/care') ? Response.json(initial()) : undefined);
    const fallback = fetch.getMockImplementation()!; fetch.mockImplementation((url, init) => init?.method === 'POST' ? deferred : fallback(url, init));
    const changed = vi.fn(async () => {});
    const view = renderWithQuery(<ServiceCarePanel obligationId="service-one" editable onChanged={changed} onClose={vi.fn()} />);
    await screen.findByText(/To: customer@example.invalid/);
    fireEvent.change(screen.getByLabelText('Current service agreement / customer expectation evidence'), { target: { value: 'Synthetic agreement current and reviewed.' } });
    fireEvent.click(screen.getByLabelText(/I reviewed this exact message/)); fireEvent.click(screen.getByRole('button', { name: 'Approve one reminder' }));
    view.unmount(); await act(async () => { finish(Response.json({ approvalId: 'approval' })); });
    expect(changed).not.toHaveBeenCalled();
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/care?'))).toHaveLength(1);
  });
  it('keeps source/consent holds visible and allows read-only inspection without write controls', async () => {
    setup(() => Response.json({ ...initial(), preview: null, blockReason: 'Reminder held: imported_source_requires_current_review.' })); renderPanel(false);
    expect(await screen.findByText(/imported_source_requires_current_review/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve one reminder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record customer response' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Book confirmed visit' })).toBeNull();
  });
});
describe("office-confirmed service appointment", () => {
  it('requires a fresh staff-recorded response before booking and labels its evidence', async () => {
    setup(() => Response.json(initial())); renderPanel(); await screen.findByText(/To: customer@example.invalid/);
    expect(screen.getByRole('button', { name: 'Book confirmed visit' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/Record a fresh/)).toBeTruthy();
  });
  it('requires exact window confirmation and sends the current response/version', async () => {
    let booked = false;
    const fetch = setup((method, path) =>
      path.endsWith("/care")
        ? Response.json({
            ...initial(),
            preview: null,
            response: {
              id: workId(802),
              outcome: "ready_to_book",
              respondedAt: version,
              channel: "phone",
              note: "Synthetic confirmed service conversation.",
            },
            appointment: booked
              ? {
                  id: workId(803),
                  status: "confirmed",
                  scheduledStart: "2035-01-01T15:00:00.000Z",
                }
              : null,
          })
        : undefined,
    );
    const fallback = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) => {
      if (init?.method === "POST" && String(input).endsWith("/book")) {
        const body = JSON.parse(String(init.body));
        booked = true;
        return Response.json({
          appointmentId: workId(803),
          replayed: false,
          bookingOutcome: {
            formatVersion: 1,
            status: "committed",
            organizationId: workMember.organization.id,
            actorUserId: workMember.id,
            obligationId: workId(801),
            bookingId: workId(804),
            requestId: body.requestId,
            requestFingerprint: createHash("sha256")
              .update(careCanonicalJson(serviceCareBookingSchema.parse(body)))
              .digest("hex"),
            responseId: body.responseId,
            expectedUpdatedAt: body.expectedUpdatedAt,
            appointmentId: workId(803),
          },
        });
      }
      return fallback(input, init);
    });
    renderPanel();
    await screen.findByText("Latest staff-recorded response");
    expect(screen.getByText('Staff attestation — not independently verified inbox evidence.')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByLabelText("Service start").matches(":disabled")).toBe(
        false,
      ),
    );
    fireEvent.change(screen.getByLabelText("Service start"), {
      target: { value: "2035-01-01T10:00" },
    });
    expect(screen.getByLabelText("Service start")).toHaveProperty('value', '2035-01-01T10:00');
    fireEvent.change(screen.getByLabelText("Service end"), {
      target: { value: "2035-01-01T11:00" },
    });
    expect(screen.getByLabelText("Service start")).toHaveProperty('value', '2035-01-01T10:00');
    fireEvent.change(screen.getByLabelText('Assigned team member'), { target: { value: 'staff-one' } });
    fireEvent.click(screen.getByRole("button", { name: "Review interval" }));
    fireEvent.click(screen.getByLabelText(/The customer confirmed this exact time/));
    fireEvent.click(screen.getByRole('button', { name: 'Book confirmed visit' }));
    expect(
      await screen.findByText(
        /original office-confirmed appointment committed/,
      ),
    ).toBeTruthy();
    const [, init] = fetch.mock.calls.find(([url, request]) => String(url).endsWith('/book') && request?.method === 'POST')!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      responseId: workId(802),
      expectedUpdatedAt: version,
      assignedUserId: "staff-one",
      customerConfirmed: true,
    });
    expect(screen.queryByRole('button', { name: 'Book confirmed visit' })).toBeNull();
  });
});
