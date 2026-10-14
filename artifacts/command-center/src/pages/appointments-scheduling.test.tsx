import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  getGetMeQueryKey,
  getListAppointmentsQueryKey,
} from '@workspace/api-client-react';
import { Router } from 'wouter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  companyDayBounds,
  type ManualSchedulingCommand,
} from '@workspace/scheduling-core';
import {
  manualSchedulingHash,
  manualSchedulingSourceKey,
} from '@/lib/scheduling-command';
import {
  makePolicyReadResult,
  makeReservationSnapshot,
} from '@/test/scheduling-ui-fixtures';
import { mockApi, sampleMe } from '@/test/mock-api';
import Appointments from './appointments';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const org = id(1),
  actor = 'appointment-actor',
  customer = id(3),
  target = id(5);
const row = () => ({
  id: target,
  organizationId: org,
  leadId: null,
  contactId: customer,
  propertyId: null,
  assignedUserId: null,
  type: 'inspection',
  status: 'confirmed',
  scheduledStart: '2035-07-01T14:00:00.123Z',
  scheduledEnd: '2035-07-01T16:00:00.123Z',
  notes: 'Private historical notes',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  schedulingEvidence: 'legacy',
  schedulingTargetFingerprint: 'b'.repeat(64),
});
async function ack(command: ManualSchedulingCommand, available = true) {
  return {
    operationId: command.operationId,
    organizationId: org,
    actorUserId: actor,
    kind: command.kind,
    source: command.review.context.source,
    payloadSha256: await manualSchedulingHash(command, {
      organizationId: org,
      actorUserId: actor,
    }),
    outcome: 'committed',
    target: { kind: 'appointment', id: target, available },
    refusalCode: null,
  };
}
function setup(
  options: {
    role?: string;
    zone?: string;
    existing?: Record<string, unknown>;
    post?: (command: ManualSchedulingCommand) => Promise<Response>;
    reconcile?: (command: ManualSchedulingCommand) => Promise<Response>;
    held?: boolean;
    disabledPolicy?: boolean;
    property?: boolean;
  } = {},
) {
  let profile = {
    ...sampleMe(options.role ?? 'office'),
    id: actor,
    organization: {
      id: org,
      name: 'Synthetic company',
      slug: 'synthetic',
      timezone: options.zone ?? 'America/Los_Angeles',
    },
  };
  let held = options.held ?? false;
  const fetch = mockApi(options.role ?? 'office'),
    fallback = fetch.getMockImplementation()!;
  const commands: ManualSchedulingCommand[] = [],
    reconciled: ManualSchedulingCommand[] = [],
    writes: Record<string, unknown>[] = [];
  fetch.mockImplementation(async (input, init) => {
    const url = String(input),
      path = url.split('?')[0],
      method = init?.method ?? 'GET';
    if (path === '/api/v1/settings/inspection-availability')
      return Response.json({
        timezone: 'UTC',
        days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        windows: [{ startHour: 0, endHour: 24 }],
        blackoutDates: [],
        slotCapacity: 10,
      });
    if (path === '/api/v1/me') return Response.json(profile);
    if (path === '/api/v1/users')
      return Response.json([
        {
          id: actor,
          role: 'office',
          isActive: true,
          firstName: 'Synthetic',
          lastName: 'Staff',
          email: 'synthetic@example.test',
        },
      ]);
    if (path === '/api/v1/contacts')
      return Response.json([
        { id: customer, firstName: 'Synthetic', lastName: 'Customer' },
      ]);
    if (path === '/api/v1/leads') return Response.json([]);
    if (path.endsWith('/workspace/properties') && held && options.property)
      return Response.json({ error: 'Unavailable' }, { status: 503 });
    if (path.endsWith('/workspace/properties'))
      return Response.json({
        organizationId: org,
        contactId: customer,
        section: 'properties',
        order: 'created_desc',
        limit: 25,
        items: options.property
          ? [
              {
                kind: 'property',
                id: id(10),
                createdAt: '2026-01-01T00:00:00.000Z',
                addressLine1: '10 Synthetic Lane',
                addressLine2: null,
                city: 'Synthetic',
                state: 'GA',
                postalCode: '30301',
                propertyType: 'residential',
              },
            ]
          : [],
        nextCursor: null,
        hasMore: false,
      });
    if (
      path === '/api/v1/settings/scheduling-policy' ||
      path === '/api/v1/scheduling/review-context'
    ) {
      if (held) return Response.json({ error: 'Unavailable' }, { status: 503 });
      const params = new URL(url, 'http://localhost').searchParams,
        sourceKind = params.get('sourceKind') ?? 'unlinked_manual';
      const source = {
        sourceKind,
        leadId: sourceKind === 'lead' ? params.get('sourceId') : null,
        contactId:
          sourceKind === 'lead'
            ? customer
            : sourceKind === 'direct_customer'
              ? params.get('sourceId')
              : null,
        propertyId: params.get('propertyId'),
        estimateId: null,
      };
      const value = makePolicyReadResult();
      value.context = {
        ...value.context,
        organizationId: org,
        companyTimeZone: profile.organization.timezone,
        source: source as typeof value.context.source,
        inspection: {
          ruleTimeZone: 'America/New_York',
          availabilityDigest: 'c'.repeat(64),
          sourceState: 'recorded',
        },
        applicableRules: {
          newTravelGapMinutes: 60,
          companyCeiling: 3,
          inspectionCeiling: 2,
        },
        targetVersion: options.existing
          ? String(options.existing.updatedAt)
          : null,
        targetFingerprint: options.existing
          ? String(options.existing.schedulingTargetFingerprint)
          : null,
      };
      value.policy!.timeZone = profile.organization.timezone;
      if (options.disabledPolicy) {
        value.policy!.enabled = false;
        value.context.applicableRules = {
          ...value.context.applicableRules,
          newTravelGapMinutes: 0,
          companyCeiling: null,
        };
      }
      return Response.json(
        path.endsWith('review-context') ? value.context : value,
      );
    }
    if (path === '/api/v1/appointments' && method === 'POST') {
      const { operationId, schedulingReview, ...body } = JSON.parse(
        String(init?.body),
      );
      const command: ManualSchedulingCommand = {
        operationId,
        review: schedulingReview,
        body,
        kind: 'appointment_create',
      };
      commands.push(command);
      const key = `growthos.scheduling.pending.v1:${org}:${actor}:appointment_create:${manualSchedulingSourceKey(command.review.context.source!)}`;
      expect(JSON.parse(sessionStorage.getItem(key)!).command).toEqual(command);
      return options.post
        ? options.post(command)
        : Response.json({
            ...row(),
            ...body,
            schedulingOperation: await ack(command),
          });
    }
    if (path === '/api/v1/scheduling/operations/reconcile') {
      const command = JSON.parse(String(init?.body));
      reconciled.push(command);
      return options.reconcile
        ? options.reconcile(command)
        : Response.json(await ack(command));
    }
    if (path === `/api/v1/appointments/${target}` && method === 'PATCH') {
      writes.push(JSON.parse(String(init?.body)));
      return Response.json({ ...row(), ...writes.at(-1) });
    }
    if (path === '/api/v1/appointments')
      return Response.json(options.existing ? [options.existing] : []);
    return fallback(input, init);
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: 3 } },
  });
  const mount = () =>
      render(
        <QueryClientProvider client={client}>
          <Router>
            <Appointments />
          </Router>
        </QueryClientProvider>,
      ),
    view = mount();
  return {
    fetch,
    client,
    commands,
    reconciled,
    writes,
    view,
    mount,
    hold: () => {
      held = true;
    },
    changeProfile: (next: Partial<typeof profile>) => {
      profile = { ...profile, ...next };
    },
  };
}
async function open() {
  fireEvent.click(
    await screen.findByRole('button', { name: 'Schedule appointment' }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText('Service start')).toHaveProperty(
      'disabled',
      false,
    ),
  );
}
async function review() {
  fireEvent.change(screen.getByLabelText('Service start'), {
    target: { value: '2035-07-01T10:00:00.123' },
  });
  fireEvent.change(screen.getByLabelText('Service end'), {
    target: { value: '2035-07-01T11:30:00.123' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review interval' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save Appt' })).toHaveProperty(
      'disabled',
      false,
    ),
  );
}
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('native appointment scheduling consumer', () => {
  it('captures exact company-zone review and UUID/hash before a single native create', async () => {
    const s = setup();
    await open();
    await review();
    expect(screen.getByText('Travel gap: 60 minutes')).toBeTruthy();
    expect(screen.getByText('Company capacity: 3')).toBeTruthy();
    expect(screen.getByText('Inspection capacity: 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
    await waitFor(() => expect(s.commands).toHaveLength(1));
    expect(s.commands[0].body).toMatchObject({
      scheduledStart: '2035-07-01T17:00:00.123Z',
      scheduledEnd: '2035-07-01T18:30:00.123Z',
      propertyId: null,
    });
    expect(s.commands[0].review.startWallTime).toMatchObject({
      offset: '-07:00',
      timeZone: 'America/Los_Angeles',
    });
    await screen.findByText(/Original appointment committed/);
  });
  it('retains lost acknowledgement through GET failure, close and remount, reconciling the exact original', async () => {
    const s = setup({
      post: async () => {
        throw new Error('lost ACK');
      },
    });
    await open();
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
    await screen.findByText(/Original appointment result is unknown/);
    const bytes = sessionStorage.getItem(sessionStorage.key(0)!)!,
      original = structuredClone(s.commands[0]);
    s.hold();
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh scheduling review' }),
    );
    await act(async () => {
      await s.client.invalidateQueries({
        queryKey: getListAppointmentsQueryKey(),
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
    expect(s.commands).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    s.view.unmount();
    s.mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Schedule appointment' }),
    );
    await screen.findByText(/Original appointment result is unknown/);
    expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(bytes);
    fireEvent.click(
      screen.getByRole('button', { name: 'Reconcile original appointment' }),
    );
    await screen.findByText(/Original appointment committed/);
    expect(s.reconciled).toEqual([original]);
    expect(s.commands).toHaveLength(1);
  });
  it.each([
    'operationId',
    'actorUserId',
    'organizationId',
    'payloadSha256',
    'kind',
    'source',
  ])('holds mismatched %s ACK despite HTTP success', async (field) => {
    const s = setup({
      post: async (command) => {
        const proof: Record<string, unknown> = await ack(command);
        proof[field] =
          field === 'payloadSha256'
            ? 'd'.repeat(64)
            : field === 'kind'
              ? 'project_create'
              : field === 'source'
                ? {
                    ...command.review.context.source,
                    sourceKind: 'direct_customer',
                    contactId: customer,
                  }
                : id(99);
        return Response.json({ ...row(), schedulingOperation: proof });
      },
    });
    await open();
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
    await screen.findByText(/Original appointment result is unknown/);
    expect(s.commands).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Save Appt' })).toHaveProperty(
      'disabled',
      true,
    );
  });
  it('keeps committed unavailable original terminal without target link', async () => {
    const s = setup({
      reconcile: async (command) => Response.json(await ack(command, false)),
      post: async () => {
        throw new Error('unknown');
      },
    });
    await open();
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
    await screen.findByText(/Original appointment result is unknown/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Reconcile original appointment' }),
    );
    await screen.findByText(/Original appointment committed.*unavailable/);
    expect(
      screen.queryByRole('link', { name: 'Open original appointment' }),
    ).toBeNull();
    expect(s.commands).toHaveLength(1);
  });
  it('rejects unavailable session custody before dispatch', async () => {
    const s = setup();
    await open();
    await review();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
    await screen.findByText(/Original command custody is unavailable/);
    expect(s.commands).toHaveLength(0);
  });
  it('requires fresh review after resources or appointment type change', async () => {
    const s = setup();
    await open();
    await review();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Synthetic Staff' }));
    expect(screen.getByRole('button', { name: 'Save Appt' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review interval' }));
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Appointment type' }),
      { target: { value: 'other' } },
    );
    expect(screen.getByRole('button', { name: 'Save Appt' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(s.commands).toHaveLength(0);
  });
  it.each(['office', 'owner', 'admin', 'inspector', 'production'])(
    'keeps past legacy notes eligible for %s with failed context',
    async (role) => {
      const old = {
        ...row(),
        scheduledStart: '2020-01-01T14:00:00.123Z',
        scheduledEnd: null,
      };
      const s = setup({ role, held: true, existing: old });
      fireEvent.click(
        await screen.findByRole('button', { name: 'Edit appointment' }),
      );
      fireEvent.change(screen.getByLabelText('Appointment notes'), {
        target: { value: 'Retained private notes' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
      await waitFor(() => expect(s.writes).toHaveLength(1));
      expect(s.writes[0]).toMatchObject({
        notes: 'Retained private notes',
        expectedUpdatedAt: old.updatedAt,
      });
      expect(s.writes[0]).not.toHaveProperty('scheduledEnd');
      expect(s.writes[0]).not.toHaveProperty('schedulingReview');
      expect(s.writes[0]).not.toHaveProperty('propertyId');
    },
  );
  it('preserves saved travel protection and actual target binding', async () => {
    const saved = makeReservationSnapshot({
      target: { kind: 'appointment', id: target },
      startAt: row().scheduledStart,
      endAt: row().scheduledEnd,
      resourceUserIds: [],
    });
    setup({
      zone: 'America/New_York',
      disabledPolicy: true,
      existing: {
        ...row(),
        schedulingEvidence: 'versioned',
        schedulingReservation: saved,
      },
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit appointment' }),
    );
    await screen.findByText('Saved protection preserved.');
    expect(
      screen.getAllByText(/Saved travel gap: 60 minutes/).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(
        'Recorded work is retained; no new capacity admission is requested.',
      ).length,
    ).toBeGreaterThan(0);
  });
  it.each([
    ['America/New_York', '2035-03-11'],
    ['Australia/Lord_Howe', '2035-10-07'],
  ])('queries company calendar boundaries in %s', async (zone, date) => {
    const s = setup({ zone });
    await screen.findByText(
      `Times shown in ${zone}. Office confirmation is required for website requests.`,
    );
    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: date },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Show' }), {
      target: { value: '1' },
    });
    const bounds = companyDayBounds(date, zone);
    await waitFor(() =>
      expect(
        s.fetch.mock.calls.some(([url]) => {
          const u = new URL(String(url), 'http://localhost');
          return (
            u.pathname === '/api/v1/appointments' &&
            u.searchParams.get('from') === bounds.from &&
            u.searchParams.get('to') === bounds.to
          );
        }),
      ).toBe(true),
    );
  });
  it('requires explicit DST occurrence and rejects nonexistent wall time', async () => {
    setup({ zone: 'America/New_York' });
    await open();
    fireEvent.change(screen.getByLabelText('Service start'), {
      target: { value: '2035-03-11T02:30' },
    });
    expect(screen.getByText(/This local time does not exist/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Service start'), {
      target: { value: '2035-11-04T01:30' },
    });
    expect(
      screen.getByRole('combobox', { name: 'Service start occurrence' }),
    ).toHaveProperty('value', '');
    expect(
      screen.getByRole('button', { name: 'Review interval' }),
    ).toHaveProperty('disabled', true);
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Service start occurrence' }),
      '2035-11-04T06:30:00.000Z',
    );
    fireEvent.change(screen.getByLabelText('Service end'), {
      target: { value: '2035-11-04T03:00' },
    });
    expect(
      screen.getByRole('button', { name: 'Review interval' }),
    ).toHaveProperty('disabled', false);
  });
  it('supports real keyboard dialog traversal and focus restoration', async () => {
    setup();
    const user = userEvent.setup(),
      launch = await screen.findByRole('button', {
        name: 'Schedule appointment',
      });
    launch.focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(screen.getByLabelText('Service start')).toHaveProperty(
        'disabled',
        false,
      ),
    );
    const dialog = screen.getByRole('dialog'),
      close = within(dialog).getByRole('button', { name: 'Close' });
    close.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: 'Cancel' }),
    );
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(launch);
  });

  it.each(['viewer', 'inactive', 'missing-org', 'incomplete'])(
    'holds material controls for %s authority',
    async (mode) => {
      const s = setup({ role: mode === 'viewer' ? 'viewer' : 'office' });
      await screen.findByRole('heading', { name: 'Appointments' });
      if (mode !== 'viewer')
        await act(async () => {
          s.client.setQueryData(getGetMeQueryKey(), {
            ...sampleMe('office'),
            id: actor,
            ...(mode === 'inactive'
              ? {
                  isActive: false,
                  organization: {
                    id: org,
                    name: 'Synthetic',
                    slug: 'synthetic',
                    timezone: 'UTC',
                  },
                }
              : mode === 'missing-org'
                ? { organization: null }
                : {
                    email: undefined,
                    organization: {
                      id: org,
                      name: 'Synthetic',
                      slug: 'synthetic',
                      timezone: 'UTC',
                    },
                  }),
          });
        });
      const launch = screen.queryByRole('button', {
        name: 'Schedule appointment',
      });
      if (launch) fireEvent.click(launch);
      expect(screen.queryByRole('button', { name: 'Save Appt' })).toBeNull();
      expect(s.commands).toHaveLength(0);
    },
  );
  it('keeps a deferred create fenced through equivalent profile polling and ignores its late ACK after actor change', async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    const s = setup({ post: () => pending });
    await open();
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
    await waitFor(() => expect(s.commands).toHaveLength(1));
    const bytes = sessionStorage.getItem(sessionStorage.key(0)!)!;
    await act(async () => {
      await s.client.refetchQueries({ queryKey: getGetMeQueryKey() });
    });
    expect(screen.getByRole('button', { name: 'Save Appt' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
    expect(s.commands).toHaveLength(1);
    s.changeProfile({ id: 'other-actor' });
    await act(async () => {
      await s.client.refetchQueries({ queryKey: getGetMeQueryKey() });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Schedule appointment' }),
    );
    fireEvent.change(screen.getByLabelText('Appointment notes'), {
      target: { value: 'Other actor draft' },
    });
    const reads = s.fetch.mock.calls.filter(([url]) =>
      String(url).startsWith('/api/v1/appointments?'),
    ).length;
    await act(async () => {
      resolve(
        Response.json({
          ...row(),
          schedulingOperation: await ack(s.commands[0]),
        }),
      );
    });
    expect(screen.getByLabelText('Appointment notes')).toHaveProperty(
      'value',
      'Other actor draft',
    );
    expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(bytes);
    expect(
      s.fetch.mock.calls.filter(([url]) =>
        String(url).startsWith('/api/v1/appointments?'),
      ),
    ).toHaveLength(reads);
  });
  it('recovers deliberately selected direct-customer source after GET failure on remount without selecting it from blank', async () => {
    const s = setup({
      post: async () => {
        throw new Error('unknown');
      },
    });
    await open();
    fireEvent.change(await screen.findByTestId('appointment-contact'), {
      target: { value: customer },
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Service start')).toHaveProperty(
        'disabled',
        false,
      ),
    );
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
    await screen.findByText(/Original appointment result is unknown/);
    const original = structuredClone(s.commands[0]);
    s.hold();
    s.view.unmount();
    s.mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Schedule appointment' }),
    );
    await screen.findByText(
      'Current scheduling review is unavailable. Refresh before changing the schedule.',
    );
    expect(
      screen.queryByText(/Original appointment result is unknown/),
    ).toBeNull();
    fireEvent.change(await screen.findByTestId('appointment-contact'), {
      target: { value: customer },
    });
    await screen.findByText(/Original appointment result is unknown/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Reconcile original appointment' }),
    );
    await screen.findByText(/Original appointment committed/);
    expect(s.reconciled).toEqual([original]);
    expect(s.commands).toHaveLength(1);
  });
  it('retains typed terminal refusal, requires acknowledgement and a deliberate new review', async () => {
    const s = setup({
      post: async (command) =>
        Response.json(
          {
            error: 'Refused',
            code: 'manual_scheduling_refused',
            schedulingOperation: {
              ...(await ack(command)),
              outcome: 'no_commit_refused',
              target: null,
              refusalCode: 'staff_conflict',
            },
          },
          { status: 409 },
        ),
    });
    await open();
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
    await screen.findByText(/Original appointment was refused/);
    const operationId = s.commands[0].operationId;
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Acknowledge refusal and review a new appointment',
      }),
    );
    expect(screen.getByRole('button', { name: 'Save Appt' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(
      JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!).command
        .operationId,
    ).toBe(operationId);
    fireEvent.click(screen.getByRole('button', { name: 'Review interval' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save Appt' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    expect(s.commands).toHaveLength(1);
  });
  it('rejects counterfeit shaped refusal as unknown and failed reconciliation never releases the fence', async () => {
    const s = setup({
      post: async () =>
        Response.json(
          { code: 'manual_scheduling_refused', error: 'not a receipt' },
          { status: 409 },
        ),
      reconcile: async () =>
        Response.json({ error: 'No match' }, { status: 503 }),
    });
    await open();
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
    await screen.findByText(/Original appointment result is unknown/);
    const bytes = sessionStorage.getItem(sessionStorage.key(0)!)!;
    fireEvent.click(
      screen.getByRole('button', { name: 'Reconcile original appointment' }),
    );
    await waitFor(() => expect(s.reconciled).toHaveLength(1));
    await screen.findByText(/Original appointment result is unknown/);
    expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(bytes);
    expect(s.commands).toHaveLength(1);
  });
  it.each(['corrupt', 'missing'])(
    'holds %s original custody during in-session reconciliation readback',
    async (mode) => {
      const s = setup({
        post: async () => {
          throw new Error('unknown');
        },
      });
      await open();
      await review();
      fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
      await screen.findByText(/Original appointment result is unknown/);
      const key = sessionStorage.key(0)!;
      if (mode === 'corrupt') sessionStorage.setItem(key, '{bad json');
      else sessionStorage.removeItem(key);
      fireEvent.click(
        screen.getByRole('button', { name: 'Reconcile original appointment' }),
      );
      await screen.findByText(/Original command custody is unavailable/);
      expect(s.commands).toHaveLength(1);
      expect(s.reconciled).toHaveLength(0);
    },
  );
  it.each(['cancelled', 'completed', 'confirmed'])(
    'allows historical %s with invalid saved evidence and failed context',
    async (status) => {
      const s = setup({
        held: true,
        existing: {
          ...row(),
          status: 'scheduled',
          scheduledStart: '2020-01-01T00:00:00.000Z',
          schedulingEvidence: 'invalid',
          schedulingReservation: { rawPrivate: 'never expose' },
        },
      });
      fireEvent.click(
        await screen.findByRole('button', { name: 'Edit appointment' }),
      );
      fireEvent.change(
        within(screen.getByRole('dialog')).getByRole('combobox', {
          name: 'Appointment status',
        }),
        { target: { value: status } },
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
      await waitFor(() => expect(s.writes).toHaveLength(1));
      expect(s.writes[0]).toMatchObject({
        status,
        expectedUpdatedAt: row().updatedAt,
      });
      expect(s.writes[0]).not.toHaveProperty('schedulingReview');
      expect(screen.queryByText('never expose')).toBeNull();
    },
  );
  it('permits valid pure release without current context and holds invalid active release', async () => {
    const saved = makeReservationSnapshot({
      target: { kind: 'appointment', id: target },
      startAt: row().scheduledStart,
      endAt: row().scheduledEnd,
      resourceUserIds: [actor],
    });
    const s = setup({
      held: true,
      existing: {
        ...row(),
        assignedUserId: actor,
        schedulingEvidence: 'versioned',
        schedulingReservation: saved,
      },
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit appointment' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove assigned resource' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
    await waitFor(() => expect(s.writes).toHaveLength(1));
    expect(s.writes[0]).toMatchObject({
      assignedUserId: null,
      expectedTargetFingerprint: row().schedulingTargetFingerprint,
    });
    expect(s.writes[0]).not.toHaveProperty('schedulingReview');
  });
  it('requires current review for an intentional material edit and preserves a legacy empty end on unrelated notes', async () => {
    const s = setup({ existing: { ...row(), scheduledEnd: null } });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit appointment' }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Service start')).toHaveProperty(
        'disabled',
        false,
      ),
    );
    fireEvent.change(screen.getByLabelText('Service start'), {
      target: { value: '2035-07-03T10:00' },
    });
    expect(screen.getByLabelText('Service end')).toHaveProperty('value', '');
    expect(screen.getByRole('button', { name: 'Save Appt' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(
      screen.getByRole('button', { name: 'Review interval' }),
    ).toHaveProperty('disabled', true);
    expect(s.writes).toHaveLength(0);
  });
  it('does not downgrade an absent projection or wrong-target snapshot to legacy zero protection', async () => {
    setup({ existing: { ...row(), schedulingEvidence: undefined } });
    await screen.findByText('Private historical notes');
    expect(
      screen.queryByText(
        'Legacy travel gap: 0 minutes. No saved scheduling policy or preset evidence.',
      ),
    ).toBeNull();
    expect(
      screen.getByText(
        'Scheduling evidence is invalid. Review is held; saved protection cannot be assumed.',
      ),
    ).toBeTruthy();
  });
  it('preserves multi-day elapsed duration and milliseconds on a start-only edit without a preset', async () => {
    const s = setup({
      existing: { ...row(), scheduledEnd: '2035-07-04T16:00:00.123Z' },
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit appointment' }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Service start')).toHaveProperty(
        'disabled',
        false,
      ),
    );
    fireEvent.change(screen.getByLabelText('Service start'), {
      target: { value: '2035-07-05T07:00:00.123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review interval' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
    await waitFor(() => expect(s.writes).toHaveLength(1));
    expect(s.writes[0]).toMatchObject({
      scheduledStart: '2035-07-05T14:00:00.123Z',
      scheduledEnd: '2035-07-08T16:00:00.123Z',
    });
  });

  it('requires fresh review when a terminal action also deliberately edits the interval', async () => {
    const s = setup({ existing: row() });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit appointment' }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Service end')).toHaveProperty(
        'disabled',
        false,
      ),
    );
    fireEvent.change(screen.getByLabelText('Service end'), {
      target: { value: '2035-07-01T12:00' },
    });
    fireEvent.change(
      within(screen.getByRole('dialog')).getByRole('combobox', {
        name: 'Appointment status',
      }),
      { target: { value: 'cancelled' } },
    );
    expect(screen.getByRole('button', { name: 'Save Appt' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(s.writes).toHaveLength(0);
  });

  it('refreshes the native schedule only after exact committed proof', async () => {
    const s = setup();
    await open();
    await review();
    const reads = s.fetch.mock.calls.filter(([url]) =>
      String(url).startsWith('/api/v1/appointments?'),
    ).length;
    fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
    await screen.findByText(/Original appointment committed/);
    await waitFor(() =>
      expect(
        s.fetch.mock.calls.filter(([url]) =>
          String(url).startsWith('/api/v1/appointments?'),
        ).length,
      ).toBeGreaterThan(reads),
    );
  });
  it('supports keyboard preset/resource choice, Review and submit while preserving the exact original', async () => {
    const s = setup();
    await open();
    const user = userEvent.setup();
    fireEvent.change(screen.getByLabelText('Service start'), {
      target: { value: '2035-07-01T10:00:00.123' },
    });
    const preset = screen.getByRole('combobox', { name: 'Duration preset' });
    preset.focus();
    await user.selectOptions(preset, '33333333-3333-4333-8333-333333333333');
    const resource = screen.getByRole('checkbox', { name: 'Synthetic Staff' });
    resource.focus();
    await user.keyboard(' ');
    const approve = screen.getByRole('button', { name: 'Review interval' });
    approve.focus();
    await user.keyboard('{Enter}');
    const save = screen.getByRole('button', { name: 'Save Appt' });
    expect(save).toHaveProperty('disabled', false);
    save.focus();
    await user.keyboard('{Enter}');
    await screen.findByText(/Original appointment committed/);
    expect(s.commands).toHaveLength(1);
    expect(s.commands[0].body).toMatchObject({
      assignedUserId: actor,
      scheduledEnd: '2035-07-01T18:30:00.123Z',
    });
    expect(s.commands[0].review.duration).toMatchObject({
      kind: 'preset',
      preset: { label: 'Synthetic visit', elapsedMinutes: 90 },
    });
  });
  it('keeps invalid active release held without blocking unrelated historical notes', async () => {
    const s = setup({
      held: true,
      existing: {
        ...row(),
        assignedUserId: actor,
        schedulingEvidence: 'invalid',
        schedulingReservation: { raw: 'private evidence' },
      },
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit appointment' }),
    );
    expect(
      screen.getByRole('button', { name: 'Remove assigned resource' }),
    ).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('Appointment notes'), {
      target: { value: 'Historical note' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
    await waitFor(() => expect(s.writes).toHaveLength(1));
    expect(s.writes[0]).toMatchObject({
      assignedUserId: actor,
      notes: 'Historical note',
    });
  });
  it('rejects wrong-target versioned summary without exposing historical bytes as legacy evidence', async () => {
    setup({
      existing: {
        ...row(),
        schedulingEvidence: 'versioned',
        schedulingReservation: makeReservationSnapshot({
          target: { kind: 'appointment', id: id(99) },
        }),
      },
    });
    await screen.findByText('Private historical notes');
    expect(
      screen.getByText(
        'Scheduling evidence is invalid. Review is held; saved protection cannot be assumed.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Legacy travel gap: 0/)).toBeNull();
  });

  it('recovers the original property command after same-tab remount despite failed property and context GETs', async () => {
    const s = setup({
      property: true,
      post: async () => {
        throw new Error('unknown');
      },
    });
    await open();
    fireEvent.change(await screen.findByTestId('appointment-contact'), {
      target: { value: customer },
    });
    await screen.findByRole('option', { name: /10 Synthetic Lane/ });
    fireEvent.change(
      screen.getByRole('combobox', {
        name: 'Property for this new appointment',
      }),
      { target: { value: id(10) } },
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Service start')).toHaveProperty(
        'disabled',
        false,
      ),
    );
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
    await screen.findByText(/Original appointment result is unknown/);
    const original = structuredClone(s.commands[0]);
    s.hold();
    s.view.unmount();
    s.mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Schedule appointment' }),
    );
    await screen.findByText(
      'Current scheduling review is unavailable. Refresh before changing the schedule.',
    );
    fireEvent.change(await screen.findByTestId('appointment-contact'), {
      target: { value: customer },
    });
    await screen.findByText(/Original appointment result is unknown/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Reconcile original appointment' }),
    );
    await screen.findByText(/Original appointment committed/);
    expect(s.reconciled).toEqual([original]);
    expect(s.reconciled[0].body).toHaveProperty('propertyId', id(10));
    expect(s.commands).toHaveLength(1);
  });

  it('holds ambiguous original property custody instead of selecting a pending operation', async () => {
    const s = setup({
      property: true,
      post: async () => {
        throw new Error('unknown');
      },
    });
    await open();
    fireEvent.change(await screen.findByTestId('appointment-contact'), {
      target: { value: customer },
    });
    await screen.findByRole('option', { name: /10 Synthetic Lane/ });
    fireEvent.change(
      screen.getByRole('combobox', {
        name: 'Property for this new appointment',
      }),
      { target: { value: id(10) } },
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Service start')).toHaveProperty(
        'disabled',
        false,
      ),
    );
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
    await screen.findByText(/Original appointment result is unknown/);
    const stored = JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!);
    const command = structuredClone(stored.command) as ManualSchedulingCommand;
    if (command.kind !== 'appointment_create')
      throw new Error('Wrong fixture command');
    command.operationId = id(80);
    command.body.propertyId = id(11);
    command.review.context.source!.propertyId = id(11);
    const sourceKey = manualSchedulingSourceKey(command.review.context.source!);
    const second = {
      ...stored,
      command,
      sourceKey,
      payloadSha256: await manualSchedulingHash(command, {
        organizationId: org,
        actorUserId: actor,
      }),
    };
    sessionStorage.setItem(
      'growthos.scheduling.pending.v1:' +
        org +
        ':' +
        actor +
        ':appointment_create:' +
        sourceKey,
      JSON.stringify(second),
    );
    s.view.unmount();
    s.mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Schedule appointment' }),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('appointment-contact').matches(':disabled'),
      ).toBe(false),
    );
    fireEvent.change(screen.getByTestId('appointment-contact'), {
      target: { value: customer },
    });
    await screen.findByText(/Original command custody is unavailable/);
    expect(
      screen.queryByRole('button', { name: 'Reconcile original appointment' }),
    ).toBeNull();
    expect(s.commands).toHaveLength(1);
    expect(sessionStorage.length).toBe(2);
  });
  it('holds deliberate property changes and clearing while the original command is unknown', async () => {
    const s = setup({
      property: true,
      post: async () => {
        throw new Error('unknown');
      },
    });
    await open();
    fireEvent.change(await screen.findByTestId('appointment-contact'), {
      target: { value: customer },
    });
    await screen.findByRole('option', { name: /10 Synthetic Lane/ });
    const property = screen.getByRole('combobox', {
      name: 'Property for this new appointment',
    });
    fireEvent.change(property, { target: { value: id(10) } });
    await waitFor(() =>
      expect(screen.getByLabelText('Service start')).toHaveProperty(
        'disabled',
        false,
      ),
    );
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
    await screen.findByText(/Original appointment result is unknown/);
    const bytes = sessionStorage.getItem(sessionStorage.key(0)!)!;
    expect(property.matches(':disabled')).toBe(true);
    fireEvent.change(property, { target: { value: '' } });
    expect(property).toHaveProperty('value', id(10));
    expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(bytes);
    expect(s.commands).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Save Appt' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('reconciles and cancels using actual keyboard navigation without another CREATE', async () => {
    const s = setup({
      post: async () => {
        throw new Error('lost ACK');
      },
    });
    const user = userEvent.setup();
    const launch = await screen.findByRole('button', {
      name: 'Schedule appointment',
    });
    launch.focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(screen.getByLabelText('Service start')).toHaveProperty(
        'disabled',
        false,
      ),
    );
    fireEvent.change(screen.getByLabelText('Service start'), {
      target: { value: '2035-07-01T10:00:00.123' },
    });
    fireEvent.change(screen.getByLabelText('Service end'), {
      target: { value: '2035-07-01T11:30:00.123' },
    });
    const tabTo = async (target: HTMLElement) => {
      for (
        let index = 0;
        index < 25 && document.activeElement !== target;
        index++
      )
        await user.tab();
      expect(document.activeElement).toBe(target);
    };
    await tabTo(screen.getByRole('button', { name: 'Review interval' }));
    await user.keyboard('{Enter}');
    await tabTo(screen.getByRole('button', { name: 'Save Appt' }));
    await user.keyboard('{Enter}');
    await screen.findByText(/Original appointment result is unknown/);
    const original = structuredClone(s.commands[0]);
    await tabTo(
      screen.getByRole('button', { name: 'Reconcile original appointment' }),
    );
    await user.keyboard('{Enter}');
    await screen.findByText(/Original appointment committed/);
    expect(s.reconciled).toEqual([original]);
    expect(s.commands).toHaveLength(1);
    await tabTo(screen.getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(launch);
  });

  it.each(['new', 'material edit'] as const)(
    'offers no disabled-policy presets for %s while explicit intervals remain reviewable',
    async (mode) => {
      const saved = makeReservationSnapshot({
        target: { kind: 'appointment', id: target },
        startAt: row().scheduledStart,
        endAt: row().scheduledEnd,
        resourceUserIds: [],
      });
      const s = setup({
        disabledPolicy: true,
        existing:
          mode === 'material edit'
            ? {
                ...row(),
                schedulingEvidence: 'versioned',
                schedulingReservation: saved,
              }
            : undefined,
      });
      if (mode === 'new') await open();
      else {
        fireEvent.click(
          await screen.findByRole('button', { name: 'Edit appointment' }),
        );
        await waitFor(() =>
          expect(screen.getByLabelText('Service start')).toHaveProperty(
            'disabled',
            false,
          ),
        );
      }
      const preset = screen.getByRole('combobox', { name: 'Duration preset' });
      expect(
        within(preset).queryByRole('option', { name: /Synthetic visit/ }),
      ).toBeNull();
      expect((preset as HTMLSelectElement).options).toHaveLength(1);
      if (mode === 'material edit')
        expect(
          screen.getAllByText(/Saved travel gap: 60 minutes/).length,
        ).toBeGreaterThan(0);
      await review();
      fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
      if (mode === 'new') {
        await waitFor(() => expect(s.commands).toHaveLength(1));
        expect(s.commands[0].review.duration).toEqual({
          kind: 'explicit',
          preset: null,
        });
      } else {
        await waitFor(() => expect(s.writes).toHaveLength(1));
        expect(s.writes[0]).toHaveProperty('schedulingReview.duration', {
          kind: 'explicit',
          preset: null,
        });
      }
    },
  );
  it.each(['addition', 'replacement'] as const)(
    'requires fresh review for terminal status plus staff %s',
    async (mode) => {
      const originalResources =
        mode === 'replacement' ? ['original-staff'] : [];
      const saved = makeReservationSnapshot({
        target: { kind: 'appointment', id: target },
        startAt: row().scheduledStart,
        endAt: row().scheduledEnd,
        resourceUserIds: originalResources,
      });
      const s = setup({
        existing: {
          ...row(),
          assignedUserId: originalResources[0] ?? null,
          schedulingEvidence: 'versioned',
          schedulingReservation: saved,
        },
      });
      fireEvent.click(
        await screen.findByRole('button', { name: 'Edit appointment' }),
      );
      await waitFor(() =>
        expect(screen.getByLabelText('Service start')).toHaveProperty(
          'disabled',
          false,
        ),
      );
      if (mode === 'replacement')
        fireEvent.click(
          screen.getByRole('button', { name: 'Remove assigned resource' }),
        );
      fireEvent.click(
        screen.getByRole('checkbox', { name: 'Synthetic Staff' }),
      );
      fireEvent.change(
        within(screen.getByRole('dialog')).getByRole('combobox', {
          name: 'Appointment status',
        }),
        { target: { value: 'cancelled' } },
      );
      expect(screen.getByRole('button', { name: 'Save Appt' })).toHaveProperty(
        'disabled',
        true,
      );
      expect(s.writes).toHaveLength(0);
      await userEvent.click(
        screen.getByRole('button', { name: 'Review interval' }),
      );
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Save Appt' }),
        ).toHaveProperty('disabled', false),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save Appt' }));
      await waitFor(() => expect(s.writes).toHaveLength(1));
      expect(s.writes[0]).toMatchObject({
        status: 'cancelled',
        assignedUserId: actor,
        scheduledStart: row().scheduledStart,
        scheduledEnd: row().scheduledEnd,
        expectedUpdatedAt: row().updatedAt,
        expectedTargetFingerprint: row().schedulingTargetFingerprint,
      });
      expect(s.writes[0]).toHaveProperty(
        'schedulingReview.context.targetFingerprint',
        row().schedulingTargetFingerprint,
      );
    },
  );
});
