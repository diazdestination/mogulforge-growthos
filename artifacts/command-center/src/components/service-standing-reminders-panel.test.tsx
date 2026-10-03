import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GetServiceStandingPolicyResponse, PreviewServiceStandingPolicyBody, PreviewServiceStandingPolicyResponse, ApproveServiceStandingPolicyBody, DisableServiceStandingPolicyBody } from '../../../../lib/api-zod/src/generated/api';
import ServiceStandingRemindersPanel from './service-standing-reminders-panel';
import { mockApi } from '@/test/mock-api';
import { renderWithQuery } from '@/test/render';
import { approvedView, scopeKey, serviceId, secondServiceId, settings, snapshot, standingPreview, standingView, versionTime } from '@/test/service-standing-fixtures';

function setup(handler: (method: string, path: string) => Response | undefined) {
  return mockApi('admin', { handler: (method, path) => path.endsWith('/users') ? Response.json([{ id: 'staff', firstName: 'Fictional', lastName: 'Coordinator', role: 'office', isActive: true, operationallyEligible: true }]) : handler(method, path) });
}
function mount(manage = true) { return renderWithQuery(<ServiceStandingRemindersPanel obligationId={serviceId} scopeKey={scopeKey} manage={manage} onChanged={vi.fn(async () => {})} />); }
async function open() { fireEvent.click(screen.getByRole('button', { name: 'Review automatic series reminders' })); await screen.findByRole('button', { name: 'Refresh standing reminder policy' }); }
function fillDraft() {
  fireEvent.click(screen.getByLabelText(/Enable one fixed reminder/));
  fireEvent.change(screen.getByLabelText('Actual service agreement starts'), { target: { value: '2026-10-01' } });
  fireEvent.change(screen.getByLabelText('Standing service agreement evidence'), { target: { value: settings().agreementEvidence } });
  fireEvent.change(screen.getByLabelText(/Source last verified/), { target: { value: '2026-10-03T08:00' } });
  fireEvent.change(screen.getByLabelText('Source reconciliation evidence'), { target: { value: settings().sourceReview.evidence } });
}
const posts = (fetch: ReturnType<typeof mockApi>) => fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('standing service authority review', () => {
  it('loads only on request, defaults off, and separates canonical source/service validity from warranty coverage', async () => {
    const fetch = setup((_method, path) => path.endsWith('/standing-reminders') ? Response.json(standingView()) : undefined);
    mount(); expect(fetch.mock.calls).toHaveLength(0); await open();
    await screen.findByText('Standing reminders are off');
    expect(screen.getByLabelText(/Enable one fixed reminder/)).toHaveProperty('checked', false);
    expect(screen.getByLabelText('Actual service agreement starts')).toHaveProperty('value', '2035-01-01');
    expect(screen.getByLabelText('Actual service agreement ends')).toHaveProperty('value', '2036-01-01');
    expect(await screen.findByText(/Current accountable owner: Fictional Coordinator/)).toBeTruthy();
    expect(screen.getByText(/Forward-only:/)).toHaveProperty('textContent', expect.stringContaining('no catch-up sweep'));
    expect(screen.queryByLabelText(/Recipient|Sender|Responsible staff/)).toBeNull();
    expect(posts(fetch)).toHaveLength(0);
  });
  it('prepares and echoes an exact actor-bound expiring snapshot only after fresh explicit approval', async () => {
    const preview = standingPreview(); let approved = false;
    const fetch = setup((method, path) => {
      if (path.endsWith('/preview')) return Response.json(preview);
      if (path.endsWith('/approve')) { approved = true; return Response.json(approvedView()); }
      if (path.endsWith('/standing-reminders')) return Response.json(approved ? approvedView() : standingView());
    });
    mount(); await open(); await screen.findByText('Standing reminders are off'); fillDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare exact standing reminder review' }));
    const review = await screen.findByLabelText('Exact standing service review');
    expect(within(review).getByText(/office@example.invalid \(microsoft\)/)).toBeTruthy();
    expect(within(review).getByText(/Mon, Tue, Wed, Thu, Fri, Sat/)).toBeTruthy();
    expect(within(review).getByText(snapshot().template.body)).toBeTruthy();
    expect(screen.queryByText(/synthetic-private-provider-id/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve exact standing reminders' })).toHaveProperty('disabled', true);
    expect(PreviewServiceStandingPolicyResponse.safeParse(preview).success).toBe(true);
    expect(PreviewServiceStandingPolicyBody.safeParse(JSON.parse(String(posts(fetch)[0][1]?.body))).success).toBe(true);
    fireEvent.click(screen.getByLabelText(/I approve this exact agreement/));
    fireEvent.click(screen.getByRole('button', { name: 'Approve exact standing reminders' }));
    await screen.findByText(/Standing approval saved for future eligible occurrences only/);
    const body = JSON.parse(String(posts(fetch)[1][1]?.body));
    expect(body).toEqual({ expectedVersion: 0, expectedSnapshot: preview.expectedSnapshot, previewHash: preview.previewHash, confirmed: true });
    expect(ApproveServiceStandingPolicyBody.safeParse(body).success).toBe(true);
    expect(GetServiceStandingPolicyResponse.safeParse(approvedView()).success).toBe(true);
    expect(screen.getByText('Standing approval saved, but held')).toBeTruthy();
    expect(posts(fetch)).toHaveLength(2);
  });
  it('invalidates the exact preview and checkbox when the agreement or channel changes', async () => {
    setup((_method, path) => path.endsWith('/preview') ? Response.json(standingPreview()) : path.endsWith('/standing-reminders') ? Response.json(standingView()) : undefined);
    mount(); await open(); await screen.findByText('Standing reminders are off'); fillDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare exact standing reminder review' })); await screen.findByLabelText(/I approve this exact agreement/);
    fireEvent.click(screen.getByLabelText(/I approve this exact agreement/));
    fireEvent.change(screen.getByLabelText('Standing reminder channel'), { target: { value: 'sms' } });
    expect(screen.queryByRole('button', { name: 'Approve exact standing reminders' })).toBeNull();
  });
  it('rejects an expired preview rather than approving it', async () => {
    const preview = standingPreview(); preview.expiresAt = new Date(Date.now() - 1000).toISOString(); preview.expectedSnapshot.expiresAt = preview.expiresAt;
    setup((_method, path) => path.endsWith('/preview') ? Response.json(preview) : path.endsWith('/standing-reminders') ? Response.json(standingView()) : undefined);
    mount(); await open(); await screen.findByText('Standing reminders are off'); fillDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare exact standing reminder review' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('preview expired'));
    expect(screen.getByRole('button', { name: 'Approve exact standing reminders' })).toHaveProperty('disabled', true);
  });
  it.each(['different actor', 'different occurrence', 'changed service version'])('rejects a successful HTTP preview for %s', async mismatch => {
    const preview = standingPreview();
    if (mismatch === 'different actor') preview.expectedSnapshot.actorUserId = 'different-user';
    else if (mismatch === 'different occurrence') preview.expectedSnapshot.policy.scope.reviewedObligationId = secondServiceId;
    else preview.expectedSnapshot.policy.scope.reviewedUpdatedAt = '2026-10-03T13:00:00.000Z';
    setup((_method, path) => path.endsWith('/preview') ? Response.json(preview) : path.endsWith('/standing-reminders') ? Response.json(standingView()) : undefined);
    mount(); await open(); await screen.findByText('Standing reminders are off'); fillDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare exact standing reminder review' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('exact standing preview could not be verified'));
    expect(screen.queryByLabelText(/I approve this exact agreement/)).toBeNull();
  });
  it('locks an unknown save result until explicit refresh, without reapproval or retry', async () => {
    let saved = false;
    const fetch = setup((_method, path) => {
      if (path.endsWith('/preview')) return Response.json(standingPreview());
      if (path.endsWith('/approve')) { saved = true; return Response.json({ error: 'Acknowledgment lost' }, { status: 503 }); }
      if (path.endsWith('/standing-reminders')) return Response.json(saved ? approvedView() : standingView());
    });
    mount(); await open(); await screen.findByText('Standing reminders are off'); fillDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare exact standing reminder review' })); await screen.findByLabelText(/I approve this exact agreement/);
    fireEvent.click(screen.getByLabelText(/I approve this exact agreement/)); fireEvent.click(screen.getByRole('button', { name: 'Approve exact standing reminders' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('No automatic retry'));
    expect(screen.getByRole('button', { name: 'Prepare exact standing reminder review' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh standing reminder policy' }));
    await screen.findByText('Standing approval saved, but held');
    expect(screen.queryByLabelText(/I approve this exact agreement/)).toBeNull(); expect(posts(fetch)).toHaveLength(2);
  });
  it('can disable approved-but-held authority with a versioned idempotent command and preserves receipt evidence', async () => {
    const active = approvedView({ occurrence: { ...standingView().occurrence, origin: 'standing', receiptState: 'indeterminate' } });
    const fetch = setup((_method, path) => path.endsWith('/disable') ? Response.json({ ...active, version: 2, policy: { ...settings(), enabled: false } }) : path.endsWith('/standing-reminders') ? Response.json(active) : undefined);
    mount(); await open(); await screen.findByText('Standing approval saved, but held');
    expect(screen.getByText(/Unknown result — reconcile the original send/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Disable standing reminders' })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('Reason for disabling standing reminders'), { target: { value: 'The customer ended this agreed plan.' } });
    fireEvent.click(screen.getByLabelText(/I confirm disabling this saved series policy/));
    fireEvent.click(screen.getByRole('button', { name: 'Disable standing reminders' }));
    await screen.findByText(/Future standing reminders disabled/);
    const body = JSON.parse(String(posts(fetch)[0][1]?.body));
    expect(body).toMatchObject({ expectedVersion: 1, confirmed: true, reason: 'The customer ended this agreed plan.' });
    expect(DisableServiceStandingPolicyBody.safeParse(body).success).toBe(true);
    expect(screen.getByText(/Unknown result — reconcile the original send/)).toBeTruthy();
    expect(posts(fetch)).toHaveLength(1);
  });
  it('requires explicit imported cutover evidence without creating recipient or owner overrides', async () => {
    const imported = standingView(); imported.sourceSummary.source = 'housecall-pro';
    setup((_method, path) => path.endsWith('/standing-reminders') ? Response.json(imported) : undefined);
    mount(); await open(); await screen.findByText('Standing reminders are off');
    expect(screen.getByLabelText('Source review basis')).toHaveProperty('value', 'reconciled_import');
    expect(screen.getByLabelText(/Actual source cutover/)).toHaveProperty('required', true);
    expect(screen.getByText(/Imported history is not consent/)).toBeTruthy();
  });
  it('shows the fully wrapped fixed SMS copy, including exact reference routing and STOP/HELP', async () => {
    const preview = standingPreview(); preview.expectedSnapshot.policy.settings.channel = 'sms';
    preview.expectedSnapshot.policy.sender = { kind: 'sms', id: 'sender', accountSid: 'synthetic-account-private', sender: '+15005550006', messagingServiceSid: 'synthetic-program-private', disclosureVersion: 'v1', origin: 'https://fictional.example.invalid', businessName: 'Fictional HVAC' };
    preview.expectedSnapshot.policy.template.body += '\nReply SERVICE [occurrence service reference] followed by your message.';
    setup((_method, path) => path.endsWith('/preview') ? Response.json(preview) : path.endsWith('/standing-reminders') ? Response.json(standingView()) : undefined);
    mount(); await open(); await screen.findByText('Standing reminders are off'); fillDraft();
    fireEvent.change(screen.getByLabelText('Standing reminder channel'), { target: { value: 'sms' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare exact standing reminder review' }));
    const review = await screen.findByLabelText('Exact standing service review');
    const body = within(review).getByText(/Reply STOP to opt out\. HELP for help\./);
    expect(body.textContent).toBe(`Fictional HVAC: ${preview.expectedSnapshot.policy.template.body.trim()}\nReply STOP to opt out. HELP for help.`);
    expect(within(review).getByText(/reference routes a reply to its original occurrence/)).toBeTruthy();
    expect(screen.queryByText(/synthetic-account-private|synthetic-program-private/)).toBeNull();
  });
  it('separates future eligibility and quiet-hour deferral from current send confirmation', async () => {
    setup((_method, path) => path.endsWith('/standing-reminders') ? Response.json(approvedView({ readiness: { ready: true, reason: null }, occurrence: { ...standingView().occurrence, eligible: true, reason: null } })) : undefined);
    mount(); await open(); await screen.findByText(/Waiting for the future notice window — not queued or sent/); cleanup();
    setup((_method, path) => path.endsWith('/standing-reminders') ? Response.json(approvedView({ readiness: { ready: false, reason: 'quiet_hours' }, occurrence: { ...standingView().occurrence, reason: 'quiet_hours' } })) : undefined);
    mount(); await open(); await screen.findByText('Standing approval saved — sending deferred');
    expect(screen.getByText(/Current deferral:/)).toHaveProperty('textContent', expect.stringContaining('no send is claimed'));
  });
  it('shows retained individual origin and read-only standing evidence without owner controls to office/viewers', async () => {
    const view = approvedView({ occurrence: { ...standingView().occurrence, origin: 'individual', receiptState: 'succeeded' } });
    setup((_method, path) => path.endsWith('/standing-reminders') ? Response.json(view) : undefined);
    mount(false); await open(); await screen.findByText(/Original reminder authority: Individual staff approval/);
    expect(screen.getByText(/Provider accepted — delivery unconfirmed/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Prepare exact standing reminder review' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disable standing reminders' })).toBeNull();
  });
  it('ignores late previews after a service/authority change', async () => {
    let finish!: (response: Response) => void; const deferred = new Promise<Response>(resolve => { finish = resolve; });
    const fetch = setup((_method, path) => path.endsWith('/standing-reminders') ? Response.json(standingView({ serviceObligationId: path.includes(secondServiceId) ? secondServiceId : serviceId })) : undefined);
    const fallback = fetch.getMockImplementation()!; fetch.mockImplementation((url, init) => String(url).endsWith('/preview') ? deferred : fallback(url, init));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (id: string) => <QueryClientProvider client={client}><ServiceStandingRemindersPanel obligationId={id} scopeKey={scopeKey} manage onChanged={vi.fn(async () => {})} /></QueryClientProvider>;
    const view = render(tree(serviceId)); await open(); await screen.findByText('Standing reminders are off'); fillDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare exact standing reminder review' }));
    view.rerender(tree(secondServiceId)); await screen.findByText('Standing reminders are off');
    await act(async () => { finish(Response.json(standingPreview())); });
    expect(screen.queryByLabelText(/I approve this exact agreement/)).toBeNull();
    expect(screen.getByLabelText(/Enable one fixed reminder/)).toHaveProperty('checked', false);
  });
  it('does not infer disabled or ready from malformed successful state data', async () => {
    setup((_method, path) => path.endsWith('/standing-reminders') ? Response.json([]) : undefined); mount(); await open();
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('No approval or readiness can be inferred'));
    expect(screen.queryByText('Standing reminders are off')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Prepare exact standing reminder review' })).toBeNull();
  });
});
