import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import VisitWorkPanel from './visit-work-panel';
import VisitWorkCompletion from './visit-work-completion';
import { appointment, asset, assetId, assets, completion, contact, entry, entryId, instant, org, property, revisionId, serviceId, wid, work } from '@/test/workday-fixtures';
import { deferred, json, mountWorkday, otherOrg, workdayClients, workdayServer, type WorkdayRequest } from '@/test/workday-test-server';
import type { AppointmentWork } from './workday-contract';

afterEach(() => { cleanup(); workdayClients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const panel = (scopeKey = 'staff-a:owner', appointmentId = appointment, onCompleted?: (value: AppointmentWork) => void) => <VisitWorkPanel organizationId={org} appointmentId={appointmentId} scopeKey={scopeKey} onCompleted={onCompleted} />;
const mutate = (request: WorkdayRequest, value: AppointmentWork) => json({ organizationId: org, work: value, receipt: { requestId: request.body.requestId, replayed: false } });
const progressButton = () => screen.getByRole('button', { name: 'Save progress for Synthetic unit visit' });
async function ready() { await screen.findByRole('heading', { name: 'Fictional north unit · Synthetic unit visit' }); await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh visit work and discard unsaved drafts' }) as HTMLButtonElement).disabled).toBe(false)); }
async function review() { fireEvent.change(screen.getByLabelText('Completion summary'), { target: { value: 'Human recorded visit summary' } }); fireEvent.click(screen.getByRole('button', { name: 'Review exact completion' })); return screen.findByRole('region', { name: 'Exact completion review' }); }
function reservation(request: WorkdayRequest, value: AppointmentWork, url: string | null = `/api/v1/public/uploads/local/${wid(80)}?token=synthetic-private-capability`) {
  value.entries[0].version = 2; value.entries[0].photos = [{ id: wid(80), entryId, itemKey: request.body.itemKey, caption: request.body.caption, state: 'reserved', contentType: request.body.contentType, sizeBytes: request.body.sizeBytes, expiresAt: new Date(Date.now() + 60_000).toISOString(), attachedAt: null, contentPath: null, available: false }];
  return json({ organizationId: org, work: value, receipt: { requestId: request.body.requestId, replayed: false }, photoId: wid(80), uploadUrl: url, uploadExpiresAt: new Date(Date.now() + 60_000).toISOString() });
}

it('shows exact native context and saved facts without adopting old schedule notes or historical equipment labels', async () => {
  const api = workdayServer(); mountWorkday(panel()); await ready();
  expect(screen.getByText('Fictional customer')).toBeTruthy(); expect(screen.getByText('12 Fictional Way')).toBeTruthy(); expect(screen.getByText('Original private schedule note')).toBeTruthy();
  expect((screen.getByLabelText('Work notes for Synthetic unit visit') as HTMLTextAreaElement).value).toBe('Original saved work note'); expect(api.writes()).toHaveLength(0);
  expect(screen.getByRole('link', { name: 'Open this service' }).getAttribute('href')).toBe(`/service?serviceObligationId=${serviceId}&organizationId=${org}`);
});
it('requires explicit checklist and explicit none or selected asset even for single options', async () => {
  const api = workdayServer(req => req.path.endsWith('/entries') ? mutate(req, work({ entries: [entry(), entry({ id: wid(30), assetId: null, assetSnapshot: null, serviceObligationId: null })] })) : undefined); mountWorkday(panel()); await ready(); fireEvent.click(screen.getByText('Prepare another explicit work entry'));
  await screen.findByRole('option', { name: 'Synthetic unit visit · revision 1' }); expect((screen.getByLabelText('Company-reviewed checklist') as HTMLSelectElement).value).toBe(''); expect((screen.getByLabelText('Equipment for this entry') as HTMLSelectElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('Company-reviewed checklist'), { target: { value: revisionId } }); fireEvent.change(screen.getByLabelText('Equipment for this entry'), { target: { value: 'none' } }); fireEvent.click(screen.getByRole('button', { name: 'Prepare this visit entry' }));
  await screen.findByText(/Explicit visit entry prepared/); expect(api.writes()[0].body).toEqual({ requestId: expect.any(String), expectedAppointmentUpdatedAt: instant, checklistRevisionId: revisionId, assetId: null, serviceObligationId: null }); expect(api.writes()[0].body).not.toHaveProperty('leadId');
});
it('supports explicit second-page equipment for another unit without choosing a service automatically', async () => {
  const api = workdayServer(req => req.path.endsWith('/assets') && req.query.get('cursor') ? json(assets({ propertyId: property, items: [asset({ id: wid(31), label: 'Second-page south unit' })] })) : req.path.endsWith('/entries') ? mutate(req, work()) : undefined); api.state.assets = assets({ nextCursor: 'asset_next', hasMore: true });
  mountWorkday(panel()); await ready(); fireEvent.click(screen.getByText('Prepare another explicit work entry')); fireEvent.click(await screen.findByRole('button', { name: 'Load more property assets' })); await screen.findByRole('option', { name: 'Second-page south unit' });
  fireEvent.change(screen.getByLabelText('Company-reviewed checklist'), { target: { value: revisionId } }); fireEvent.change(screen.getByLabelText('Equipment for this entry'), { target: { value: wid(31) } }); fireEvent.click(screen.getByRole('button', { name: 'Prepare this visit entry' })); await screen.findByText(/Explicit visit entry prepared/);
  expect(api.writes()[0].body).toMatchObject({ assetId: wid(31), serviceObligationId: null }); expect(api.requests.find(req => req.query.has('cursor'))?.query.get('propertyId')).toBe(property);
});
it('records four typed item kinds without invented numeric thresholds or default outcomes', async () => {
  const api = workdayServer(req => req.method === 'PATCH' ? mutate(req, work({ entries: [entry({ version: 2, answers: req.body.answers, notes: req.body.notes })] })) : undefined); mountWorkday(panel()); await ready();
  expect((screen.getByLabelText('Staff observation outcome') as HTMLSelectElement).value).toBe(''); expect((screen.getByLabelText('Recorded reading outcome') as HTMLSelectElement).value).toBe(''); expect(screen.getByText(/no automatic pass\/fail threshold/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Staff observation observation'), { target: { value: '<script>literal staff note</script>' } }); fireEvent.change(screen.getByLabelText('Recorded reading value (company unit)'), { target: { value: '17.25' } }); fireEvent.change(screen.getByLabelText('Visit evidence outcome'), { target: { value: 'not_applicable' } }); fireEvent.change(screen.getByLabelText('Visit evidence reason (required)'), { target: { value: 'Not applicable for this recorded work.' } });
  expect(screen.getByText(/save before photos or completion/)).toBeTruthy(); expect((screen.getByRole('button', { name: 'Review exact completion' }).closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
  fireEvent.click(progressButton()); await screen.findByText(/Visit progress saved/); expect(api.writes()[0].body).toMatchObject({ expectedVersion: 1, notes: 'Original saved work note' }); expect(api.writes()[0].body.answers).toEqual(expect.arrayContaining([{ itemKey: 'reading', result: 'done', value: 17.25, reason: null }, { itemKey: 'evidence', result: 'not_applicable', value: null, reason: 'Not applicable for this recorded work.' }])); expect(document.querySelector('script')).toBeNull();
});
it('requires an explicit office acting note and never allows client override of the assigned performer', async () => {
  const api = workdayServer(req => req.method === 'PATCH' ? mutate(req, work()) : undefined); api.state.work.capabilities.requiresActingNote = true; mountWorkday(panel()); await screen.findByLabelText('Office acting-on-behalf note');
  expect(screen.queryByRole('button', { name: 'Save progress for Synthetic unit visit' })).toBeNull(); fireEvent.change(screen.getByLabelText('Office acting-on-behalf note'), { target: { value: 'Office recording technician supplied evidence' } });
  fireEvent.change(screen.getByLabelText('Work notes for Synthetic unit visit'), { target: { value: 'Changed staff note' } }); fireEvent.click(progressButton()); await screen.findByText(/Visit progress saved/);
  expect(api.writes()[0].body.actingNote).toBe('Office recording technician supplied evidence'); expect(api.writes()[0].body).not.toHaveProperty('performerUserId');
});
it('preserves human drafts on unchanged semantic props but destroys them on real member change', async () => {
  workdayServer(); const view = mountWorkday(panel()); await ready(); fireEvent.change(screen.getByLabelText('Work notes for Synthetic unit visit'), { target: { value: 'My unfinished observation' } });
  view.rerender(panel()); expect((screen.getByLabelText('Work notes for Synthetic unit visit') as HTMLTextAreaElement).value).toBe('My unfinished observation');
  view.rerender(panel('staff-b:owner')); await ready(); expect((screen.getByLabelText('Work notes for Synthetic unit visit') as HTMLTextAreaElement).value).toBe('Original saved work note');
});
it('ignores a late save after membership change and does not close or populate the replacement record', async () => {
  const pending = deferred<Response>(); let originalRequest: WorkdayRequest | undefined; const api = workdayServer(req => req.method === 'PATCH' ? (originalRequest = req, pending.promise) : undefined); const view = mountWorkday(panel()); await ready();
  fireEvent.change(screen.getByLabelText('Work notes for Synthetic unit visit'), { target: { value: 'Old actor note' } }); fireEvent.click(progressButton());
  view.rerender(panel('other-user:owner')); await ready(); await act(async () => pending.resolve(mutate(originalRequest!, work({ entries: [entry({ version: 2, notes: 'Late privileged result' })] }))));
  expect((screen.getByLabelText('Work notes for Synthetic unit visit') as HTMLTextAreaElement).value).toBe('Original saved work note'); expect(screen.queryByText(/Visit progress saved/)).toBeNull(); expect(api.writes()).toHaveLength(1);
});
it('rejects cross-company or mismatched appointment work instead of showing unrelated evidence', async () => {
  workdayServer(req => req.path.endsWith('/work') ? json(work({ organizationId: otherOrg })) : undefined); mountWorkday(panel()); await screen.findByText(/Visit work unavailable/); expect(screen.queryByText('Fictional customer')).toBeNull();
});
it('requires named accepted follow-up for needs attention and explicitly selects only actual linked services', async () => {
  const api = workdayServer(); api.state.work.entries[0].answers[0] = { itemKey: 'condition', result: 'needs_attention', value: null, reason: 'Fictional attention finding' }; mountWorkday(panel()); await ready();
  fireEvent.change(screen.getByLabelText('Completion summary'), { target: { value: 'Needs office review' } }); fireEvent.click(screen.getByRole('button', { name: 'Review exact completion' })); await screen.findByText(/Needs-attention observations require/); expect(api.writes()).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('Work outcome'), { target: { value: 'needs_followup' } }); await screen.findByRole('option', { name: 'Accepted Office' }); expect(screen.queryByRole('option', { name: 'Pending Invitation' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Office follow-up owner'), { target: { value: 'office-a' } }); fireEvent.change(screen.getByLabelText(/Office follow-up due/), { target: { value: '2026-10-07T10:00' } }); fireEvent.change(screen.getByLabelText('Office follow-up action'), { target: { value: 'Contact technician about the recorded finding' } }); fireEvent.click(screen.getByLabelText('Historical label remains separate'));
  fireEvent.click(screen.getByRole('button', { name: 'Review exact completion' })); await screen.findByRole('region', { name: 'Exact completion review' }); expect(api.writes()[0].body).toMatchObject({ outcome: 'needs_followup', serviceObligationIds: [serviceId], followup: { assignedUserId: 'office-a', note: 'Contact technician about the recorded finding' } });
});
it('requires exact completion confirmation, sends only the token and keeps native notes untouched', async () => {
  const onCompleted = vi.fn(); const api = workdayServer(req => req.path.endsWith('/complete') ? mutate(req, work({ appointment: { ...work().appointment, status: 'completed' }, completion: completion({ requestId: req.body.requestId }), entries: [entry({ state: 'finalized', completionId: completion().id })] })) : undefined); mountWorkday(panel(undefined, undefined, onCompleted)); await ready(); await review();
  expect((screen.getByRole('button', { name: 'Record reviewed completion' }) as HTMLButtonElement).disabled).toBe(true); expect(screen.queryByText('synthetic-completion-review')).toBeNull();
  fireEvent.click(screen.getByLabelText('I checked the saved work and selected service outcomes.')); fireEvent.click(screen.getByRole('button', { name: 'Record reviewed completion' })); await screen.findByRole('region', { name: 'Recorded work completion' });
  expect(api.writes().at(-1)?.body).toEqual({ requestId: expect.any(String), previewToken: 'synthetic-completion-review', confirmed: true }); expect(api.writes()[0].body).toMatchObject({ entries: [{ id: entryId, version: 1 }], serviceObligationIds: [] }); expect(api.writes()[0].body).not.toHaveProperty('notes');
  expect(onCompleted).toHaveBeenCalledTimes(1); expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({ organizationId: org, appointment: expect.objectContaining({ id: appointment, status: 'completed' }), completion: expect.objectContaining({ requestId: api.writes().at(-1)?.body.requestId }) }));
});
it('invalidates a prepared completion on a human edit and after saved entry versions change', async () => {
  const api = workdayServer(); mountWorkday(panel()); await ready(); await review(); fireEvent.change(screen.getByLabelText('Completion summary'), { target: { value: 'Changed intent' } }); expect(screen.queryByRole('region', { name: 'Exact completion review' })).toBeNull();
  await review(); fireEvent.change(screen.getByLabelText('Work notes for Synthetic unit visit'), { target: { value: 'Unfinished work entry' } }); await waitFor(() => expect(screen.queryByRole('region', { name: 'Exact completion review' })).toBeNull()); expect(api.writes().filter(req => req.path.endsWith('/complete'))).toHaveLength(0);
});
it('does not revive an old preview after target authority changed', async () => {
  const pending = deferred<Response>(); let request: WorkdayRequest | undefined; const api = workdayServer(req => req.path.endsWith('/completion-preview') ? (request = req, pending.promise) : undefined); const view = mountWorkday(panel()); await ready();
  fireEvent.change(screen.getByLabelText('Completion summary'), { target: { value: 'Old review' } }); fireEvent.click(screen.getByRole('button', { name: 'Review exact completion' })); view.rerender(panel('new-staff:owner')); await ready();
  await act(async () => pending.resolve(json({ organizationId: org, appointmentId: appointment, expiresAt: new Date(Date.now() + 60000).toISOString(), previewToken: 'late-review', entries: api.state.work.entries, intent: request!.body, serviceVersions: [], warning: 'Staff-recorded work; not warranty coverage, customer acceptance, invoice delivery or payment.' })));
  expect(screen.queryByRole('region', { name: 'Exact completion review' })).toBeNull(); expect((screen.getByLabelText('Completion summary') as HTMLTextAreaElement).value).toBe('');
});
it('holds unknown completion instead of retrying or claiming completed work', async () => {
  const onCompleted = vi.fn(); const api = workdayServer(req => req.path.endsWith('/complete') ? Promise.reject(new TypeError('Unknown completion acknowledgement')) : undefined); mountWorkday(panel(undefined, undefined, onCompleted)); await ready(); await review(); fireEvent.click(screen.getByLabelText('I checked the saved work and selected service outcomes.')); fireEvent.click(screen.getByRole('button', { name: 'Record reviewed completion' }));
  await screen.findByText(/No automatic retry was made/); expect(screen.queryByRole('region', { name: 'Recorded work completion' })).toBeNull(); fireEvent.click(screen.getByRole('button', { name: 'Record reviewed completion' })); expect(api.writes().filter(req => req.path.endsWith('/complete'))).toHaveLength(1);
  expect(onCompleted).not.toHaveBeenCalled();
});
it('does not publish a late completion to the surrounding schedule after semantic membership changes', async () => {
  const pending = deferred<Response>(), onCompleted = vi.fn(); let request: WorkdayRequest | undefined;
  const api = workdayServer(req => req.path.endsWith('/complete') ? (request = req, pending.promise) : undefined); const view = mountWorkday(panel(undefined, undefined, onCompleted)); await ready(); await review();
  fireEvent.click(screen.getByLabelText('I checked the saved work and selected service outcomes.')); fireEvent.click(screen.getByRole('button', { name: 'Record reviewed completion' })); expect(onCompleted).not.toHaveBeenCalled();
  view.rerender(panel('other-member:owner', undefined, onCompleted)); await ready();
  await act(async () => pending.resolve(mutate(request!, work({ appointment: { ...work().appointment, status: 'completed' }, completion: completion({ requestId: request!.body.requestId }), entries: [entry({ state: 'finalized', completionId: completion().id })] }))));
  expect(onCompleted).not.toHaveBeenCalled(); expect(screen.queryByRole('region', { name: 'Recorded work completion' })).toBeNull(); expect(api.writes().filter(req => req.path.endsWith('/complete'))).toHaveLength(1);
});
it('retains immutable historical completion and appends an attributed correction without replacing originals', async () => {
  const api = workdayServer(req => req.path.endsWith('/corrections') ? mutate(req, { ...api.state.work, corrections: [{ id: wid(40), originalCompletionId: completion().id, note: req.body.note, recordedAt: instant, recordedByUserId: 'staff-a' }] }) : undefined);
  api.state.work = work({ completion: completion(), entries: [entry({ state: 'finalized', completionId: completion().id })], capabilities: { canPrepare: false, canEdit: false, canCancel: false, canComplete: false, canCorrect: true, requiresActingNote: false, reasons: [] } }); mountWorkday(panel()); await screen.findByRole('region', { name: 'Recorded work completion' });
  expect(screen.queryByRole('button', { name: /Save progress/ })).toBeNull(); fireEvent.change(screen.getByLabelText('Correction note'), { target: { value: 'Correction: recorded label was transcribed incorrectly.' } }); fireEvent.click(screen.getByRole('button', { name: 'Append correction note' })); await screen.findByText(/Correction appended/);
  expect(screen.getByText('Original completed visit summary')).toBeTruthy(); expect(api.writes()[0].body).toEqual({ requestId: expect.any(String), note: 'Correction: recorded label was transcribed incorrectly.' });
});
it('keeps read-only or held historical visit evidence visible without work actions', async () => {
  const api = workdayServer(); api.state.work.capabilities = { canPrepare: false, canEdit: false, canCancel: false, canComplete: false, canCorrect: false, requiresActingNote: false, reasons: ['actor_cannot_edit'] }; api.state.work.entries[0].holdReasons = ['property_parent_changed']; mountWorkday(panel()); await ready();
  expect(screen.getByText(/Work held: property parent changed/)).toBeTruthy(); expect(screen.queryByRole('button', { name: /Save progress|Record reviewed|Upload and attach|Prepare this visit/ })).toBeNull(); expect(api.writes()).toHaveLength(0);
});
it('uploads raw private bytes then attaches the original reservation using its returned version', async () => {
  const api = workdayServer(req => {
    if (req.path.endsWith('/request-url')) return reservation(req, structuredClone(api.state.work));
    if (req.method === 'PUT') return new Response(null, { status: 204 });
    if (req.path.endsWith('/photos') && req.method === 'POST') return mutate(req, work({ entries: [entry({ version: 3, photos: [{ id: wid(80), entryId, itemKey: 'evidence', caption: 'Recorded nameplate', state: 'attached', contentType: 'image/jpeg', sizeBytes: 3, expiresAt: instant, attachedAt: instant, contentPath: `/api/v1/appointments/${appointment}/work/photos/${wid(80)}/content`, available: true }] })] }));
  }); mountWorkday(panel()); await ready(); fireEvent.change(screen.getByLabelText('Photo evidence item'), { target: { value: 'evidence' } }); fireEvent.change(screen.getByLabelText('Photo caption'), { target: { value: 'Recorded nameplate' } }); const file = new File(['abc'], 'fictional.jpg', { type: 'image/jpeg' }); fireEvent.change(screen.getByLabelText('Choose private work photo'), { target: { files: [file] } }); fireEvent.click(screen.getByRole('button', { name: 'Upload and attach private photo' }));
  await screen.findByText(/Private photo attached/); expect(api.writes()).toHaveLength(3); expect(api.writes()[0].body).toMatchObject({ expectedVersion: 1, sizeBytes: 3, contentType: 'image/jpeg', itemKey: 'evidence' }); expect(api.writes()[1].rawBody).toBe(file); expect(api.writes()[1].init).toMatchObject({ method: 'PUT', credentials: 'include', redirect: 'error', headers: { 'Content-Type': 'image/jpeg' } }); expect(api.writes()[2].body).toMatchObject({ expectedVersion: 2, photoId: wid(80) });
  expect(screen.getByRole('img', { name: 'Recorded nameplate' }).getAttribute('src')).toBe(`/api/v1/appointments/${appointment}/work/photos/${wid(80)}/content`);
});
it.each([null, 'https://example.test/capture?token=bad', `/api/v1/public/uploads/local/${wid(80)}?token=a&other=b`])('does not PUT or recreate a replayed or unsafe photo authority: %s', async url => {
  const api = workdayServer(req => req.path.endsWith('/request-url') ? reservation(req, structuredClone(api.state.work), url) : undefined); mountWorkday(panel()); await ready(); fireEvent.change(screen.getByLabelText('Choose private work photo'), { target: { files: [new File(['abc'], 'synthetic.png', { type: 'image/png' })] } }); fireEvent.click(screen.getByRole('button', { name: 'Upload and attach private photo' })); await screen.findByText(/No automatic retry was made/); expect(api.writes()).toHaveLength(1); expect(screen.queryByText(/Private photo attached/)).toBeNull();
});
it('stops multi-step photo authority after member change while reservation is pending', async () => {
  const pending = deferred<Response>(); let request: WorkdayRequest | undefined; const api = workdayServer(req => req.path.endsWith('/request-url') ? (request = req, pending.promise) : undefined); const view = mountWorkday(panel()); await ready(); fireEvent.change(screen.getByLabelText('Choose private work photo'), { target: { files: [new File(['abc'], 'synthetic.png', { type: 'image/png' })] } }); fireEvent.click(screen.getByRole('button', { name: 'Upload and attach private photo' }));
  view.rerender(panel('other-user:owner')); await ready(); await act(async () => pending.resolve(reservation(request!, structuredClone(api.state.work)))); expect(api.writes()).toHaveLength(1); expect(screen.queryByText(/Private photo attached/)).toBeNull();
});
it('rejects unsupported or oversized photos before reserving and never calls analysis providers', async () => {
  const api = workdayServer(); mountWorkday(panel()); await ready(); fireEvent.change(screen.getByLabelText('Choose private work photo'), { target: { files: [new File(['video'], 'synthetic.mp4', { type: 'video/mp4' })] } }); fireEvent.click(screen.getByRole('button', { name: 'Upload and attach private photo' })); await screen.findByText(/Choose a JPEG, PNG or WebP image/); expect(api.writes()).toHaveLength(0);
  const file = new File(['abc'], 'oversized.png', { type: 'image/png' }); Object.defineProperty(file, 'size', { value: 10485761 }); fireEvent.change(screen.getByLabelText('Choose private work photo'), { target: { files: [file] } }); fireEvent.click(screen.getByRole('button', { name: 'Upload and attach private photo' })); expect(api.writes()).toHaveLength(0);
});

it('does not submit completion after the exact token expires, even if confirmation remains checked', async () => {
  const api = workdayServer(); mountWorkday(panel()); await ready(); await review(); fireEvent.click(screen.getByLabelText('I checked the saved work and selected service outcomes.')); const future = Date.now() + 120000; vi.spyOn(Date, 'now').mockReturnValue(future); fireEvent.click(screen.getByRole('button', { name: 'Record reviewed completion' })); expect(api.writes().filter(req => req.path.endsWith('/complete'))).toHaveLength(0);
});
it('separates all linked native task reconciliation from explicitly performed service occurrences', async () => {
  const api = workdayServer(); api.state.work.linkedServices.push({ id: wid(90), equipmentLabel: 'Retained completed occurrence', status: 'completed', updatedAt: instant }); mountWorkday(panel()); await ready(); await review();
  expect(screen.getByText(/Native task reconciliation is checked for 2 linked service records/)).toBeTruthy(); expect(api.writes()[0].body.serviceObligationIds).toEqual([]); expect(screen.queryByLabelText('Retained completed occurrence')).toBeNull();
});
it('retains another unit’s unsaved draft when one unit save returns a new version', async () => {
  const second = entry({ id: wid(92), assetId: wid(93), assetSnapshot: { ...entry().assetSnapshot!, id: wid(93), label: 'Fictional south unit' } });
  const api = workdayServer(req => req.method === 'PATCH' ? mutate(req, work({ entries: [entry({ version: 2, notes: req.body.notes }), second] })) : undefined); api.state.work.entries.push(second); mountWorkday(panel()); await ready();
  const regions = screen.getAllByRole('region', { name: 'Visit entry: Synthetic unit visit' }); fireEvent.change(within(regions[1]).getByLabelText('Work notes for Synthetic unit visit'), { target: { value: 'Unfinished south observation' } }); fireEvent.change(within(regions[0]).getByLabelText('Work notes for Synthetic unit visit'), { target: { value: 'Saved north observation' } }); fireEvent.click(within(regions[0]).getByRole('button', { name: 'Save progress for Synthetic unit visit' })); await screen.findByText(/Visit progress saved/);
  expect((within(screen.getAllByRole('region', { name: 'Visit entry: Synthetic unit visit' })[1]).getByLabelText('Work notes for Synthetic unit visit') as HTMLTextAreaElement).value).toBe('Unfinished south observation'); expect(screen.getByText(/Save or discard each unsaved work-entry draft/)).toBeTruthy();
});
it('holds failed raw photo upload without attaching or reminting a reservation', async () => {
  const api = workdayServer(req => req.path.endsWith('/request-url') ? reservation(req, structuredClone(api.state.work)) : req.method === 'PUT' ? new Response(null, { status: 503 }) : undefined); mountWorkday(panel()); await ready(); fireEvent.change(screen.getByLabelText('Choose private work photo'), { target: { files: [new File(['abc'], 'synthetic.png', { type: 'image/png' })] } }); fireEvent.click(screen.getByRole('button', { name: 'Upload and attach private photo' }));
  await screen.findByText(/No automatic retry was made/); expect(api.writes()).toHaveLength(2); expect(api.writes().some(req => req.path.endsWith('/photos'))).toBe(false); expect(screen.queryByText(/Private photo attached/)).toBeNull();
});
it('does not attach bytes after authority changes while the raw upload is pending', async () => {
  const pending = deferred<Response>(); const api = workdayServer(req => req.path.endsWith('/request-url') ? reservation(req, structuredClone(api.state.work)) : req.method === 'PUT' ? pending.promise : undefined); const view = mountWorkday(panel()); await ready(); fireEvent.change(screen.getByLabelText('Choose private work photo'), { target: { files: [new File(['abc'], 'synthetic.png', { type: 'image/png' })] } }); fireEvent.click(screen.getByRole('button', { name: 'Upload and attach private photo' })); await waitFor(() => expect(api.writes()).toHaveLength(2));
  view.rerender(panel('new-actor:owner')); await ready(); await act(async () => pending.resolve(new Response(null, { status: 204 }))); expect(api.writes()).toHaveLength(2); expect(screen.queryByText(/Private photo attached/)).toBeNull();
});

it('does not claim completion when a nominally successful response lacks original atomic completion evidence', async () => {
  const onCompleted = vi.fn(); const api = workdayServer(req => req.path.endsWith('/complete') ? mutate(req, work()) : undefined); mountWorkday(panel(undefined, undefined, onCompleted)); await ready(); await review(); fireEvent.click(screen.getByLabelText('I checked the saved work and selected service outcomes.')); fireEvent.click(screen.getByRole('button', { name: 'Record reviewed completion' }));
  await screen.findByText(/No automatic retry was made/); expect(screen.queryByText(/Work completion recorded against/)).toBeNull(); expect(screen.queryByRole('region', { name: 'Recorded work completion' })).toBeNull(); expect(api.writes().filter(req => req.path.endsWith('/complete'))).toHaveLength(1);
  expect(onCompleted).not.toHaveBeenCalled();
});

it.each(['workday_asset_changed', 'workday_parent_changed'])('lets authorized office cancel a %s held draft, preserve its history and explicitly prepare fresh work', async hold => {
  const original = entry({ version: 7, holdReasons: [hold] });
  const api = workdayServer(req => {
    if (req.path.endsWith('/cancel')) {
      api.state.work = work({ entries: [{ ...original, version: 8, state: 'cancelled', holdReasons: [] }], capabilities: { ...work().capabilities, canCancel: false, canComplete: false, requiresActingNote: true } }); return mutate(req, api.state.work);
    }
    if (req.path.endsWith('/entries')) {
      api.state.work = { ...api.state.work, entries: [...api.state.work.entries, entry({ id: wid(115), version: 1, notes: '', answers: [], assetSnapshot: { ...original.assetSnapshot!, version: 2 } })], capabilities: { ...work().capabilities, requiresActingNote: true } }; return mutate(req, api.state.work);
    }
  });
  api.state.work = work({ entries: [original], capabilities: { ...work().capabilities, canComplete: false, requiresActingNote: true, reasons: [hold] } }); api.state.assets.items = [asset({ version: 2 })]; mountWorkday(panel()); await ready();
  fireEvent.click(screen.getByText('Cancel this entry')); expect((screen.getByRole('button', { name: 'Cancel this work entry' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Office acting-on-behalf note'), { target: { value: 'Office reviewed technician evidence after recorded facts changed' } });
  expect(screen.queryByRole('button', { name: /Save progress|Upload and attach|Record reviewed completion/ })).toBeNull(); expect(api.writes()).toHaveLength(0);
  fireEvent.click(screen.getByText('Prepare another explicit work entry')); await screen.findByRole('option', { name: 'Synthetic unit visit · revision 1' }); fireEvent.change(screen.getByLabelText('Company-reviewed checklist'), { target: { value: revisionId } }); fireEvent.change(screen.getByLabelText('Equipment for this entry'), { target: { value: assetId } }); fireEvent.click(screen.getByText('Prepare another explicit work entry'));
  fireEvent.change(screen.getByLabelText('Entry cancellation reason'), { target: { value: 'Retain the old evidence; prepare against reviewed current facts.' } }); fireEvent.click(screen.getByRole('button', { name: 'Cancel this work entry' })); await screen.findByText(/Entry cancelled; retained history is unchanged/);
  expect(api.writes()).toHaveLength(1); expect(api.writes()[0].body).toEqual({ requestId: expect.any(String), expectedVersion: 7, reason: 'Retain the old evidence; prepare against reviewed current facts.', actingNote: 'Office reviewed technician evidence after recorded facts changed' });
  expect((screen.getByLabelText('Work notes for Synthetic unit visit') as HTMLTextAreaElement).value).toBe('Original saved work note'); expect(screen.queryByRole('button', { name: 'Cancel this work entry' })).toBeNull();
  fireEvent.click(screen.getByText('Prepare another explicit work entry')); await screen.findByRole('option', { name: 'Synthetic unit visit · revision 1' }); expect((screen.getByLabelText('Company-reviewed checklist') as HTMLSelectElement).value).toBe(''); expect((screen.getByLabelText('Equipment for this entry') as HTMLSelectElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('Company-reviewed checklist'), { target: { value: revisionId } }); fireEvent.change(screen.getByLabelText('Equipment for this entry'), { target: { value: assetId } }); fireEvent.click(screen.getByRole('button', { name: 'Prepare this visit entry' })); await screen.findByText(/Explicit visit entry prepared/);
  expect(api.writes()).toHaveLength(2); expect(api.writes()[1].body).toMatchObject({ assetId, checklistRevisionId: revisionId, serviceObligationId: null }); expect(api.writes()[1].body).not.toHaveProperty('answers'); expect(api.writes()[1].body).not.toHaveProperty('notes');
  const notes = screen.getAllByLabelText('Work notes for Synthetic unit visit') as HTMLTextAreaElement[]; expect(notes.map(note => note.value)).toEqual(['Original saved work note', '']);
});

it('uses canCancel independently of canEdit, but does not invent office cancellation authority from an editable draft', async () => {
  const api = workdayServer(); api.state.work = work({ entries: [entry({ holdReasons: ['workday_parent_changed'] })], capabilities: { ...work().capabilities, canPrepare: false, canEdit: false, canComplete: false, canCancel: true, reasons: ['workday_parent_changed'] } }); mountWorkday(panel()); await ready();
  fireEvent.click(screen.getByText('Cancel this entry')); expect(screen.getByLabelText('Entry cancellation reason')).toBeTruthy(); expect(screen.queryByRole('button', { name: /Save progress|Upload and attach|Prepare this visit|Review exact completion/ })).toBeNull();
  api.state.work = work({ capabilities: { ...work().capabilities, canCancel: false } }); fireEvent.click(screen.getByRole('button', { name: 'Refresh visit work and discard unsaved drafts' })); await ready(); expect(screen.queryByText('Cancel this entry')).toBeNull(); expect(progressButton()).toBeTruthy(); expect(api.writes()).toHaveLength(0);
});

it('holds an unknown office cancellation and never automatically cancels again or prepares a replacement', async () => {
  const api = workdayServer(req => req.path.endsWith('/cancel') ? Promise.reject(new TypeError('Cancellation result unknown')) : undefined); api.state.work.entries[0].holdReasons = ['workday_asset_changed']; api.state.work.capabilities.canComplete = false; mountWorkday(panel()); await ready(); fireEvent.click(screen.getByText('Cancel this entry')); fireEvent.change(screen.getByLabelText('Entry cancellation reason'), { target: { value: 'Review asset correction' } }); fireEvent.click(screen.getByRole('button', { name: 'Cancel this work entry' })); await screen.findByText(/No automatic retry was made/);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel this work entry' })); expect(api.writes()).toHaveLength(1); expect(api.writes().some(req => req.path.endsWith('/entries'))).toBe(false); expect(screen.queryByText(/Entry cancelled; retained history/)).toBeNull();
});

it('ignores a late held-draft cancellation after the current member changes', async () => {
  const pending = deferred<Response>(); let request: WorkdayRequest | undefined; const api = workdayServer(req => req.path.endsWith('/cancel') ? (request = req, pending.promise) : undefined); api.state.work.entries[0].holdReasons = ['workday_asset_changed']; api.state.work.capabilities.canComplete = false; const view = mountWorkday(panel()); await ready(); fireEvent.click(screen.getByText('Cancel this entry')); fireEvent.change(screen.getByLabelText('Entry cancellation reason'), { target: { value: 'Office cancellation' } }); fireEvent.click(screen.getByRole('button', { name: 'Cancel this work entry' }));
  api.state.work.capabilities.canCancel = false; view.rerender(panel('other-technician')); await ready(); await act(async () => pending.resolve(mutate(request!, work({ entries: [entry({ state: 'cancelled', version: 2 })] })))); expect(api.writes()).toHaveLength(1); expect(screen.queryByText(/Entry cancelled; retained history/)).toBeNull(); expect(screen.queryByText('Cancel this entry')).toBeNull();
});

it('uses the server-resolved customer of a lead-only native visit without rewriting native lineage or inferring a property', async () => {
  // Native contactId remains null; the read projection resolves only the explicit coherent lead.
  const native = { ...work().appointment, contactId: null, leadId: wid(116), propertyId: null, propertyLabel: null };
  const projection = { ...native, contactId: contact };
  const api = workdayServer(req => req.path.endsWith('/entries') ? (api.state.work = work({ appointment: projection, entries: [entry({ assetId: null, assetSnapshot: null, propertyId: null, serviceObligationId: null, notes: '', answers: [] })], linkedServices: [] }), mutate(req, api.state.work)) : undefined); api.state.work = work({ appointment: projection, entries: [], linkedServices: [] }); mountWorkday(panel()); await screen.findByText('Fictional customer'); fireEvent.click(screen.getByText('Prepare another explicit work entry')); await screen.findByRole('option', { name: 'Synthetic unit visit · revision 1' });
  expect(screen.getByText(/This appointment has no property/)).toBeTruthy(); expect(api.requests.some(req => req.path.endsWith('/assets'))).toBe(false);
  fireEvent.change(screen.getByLabelText('Company-reviewed checklist'), { target: { value: revisionId } }); fireEvent.change(screen.getByLabelText('Equipment for this entry'), { target: { value: 'none' } }); fireEvent.click(screen.getByRole('button', { name: 'Prepare this visit entry' })); await screen.findByText(/Explicit visit entry prepared/);
  expect(api.writes()[0].body).toMatchObject({ assetId: null, serviceObligationId: null, expectedAppointmentUpdatedAt: native.updatedAt }); expect(api.writes()[0].body).not.toHaveProperty('contactId'); expect(api.writes()[0].body).not.toHaveProperty('leadId'); expect(api.writes()[0].body).not.toHaveProperty('propertyId'); expect(native.contactId).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh visit work and discard unsaved drafts' })); await screen.findByLabelText('Work notes for Synthetic unit visit'); expect(screen.queryByText(/Visit work unavailable/)).toBeNull(); expect(api.writes()).toHaveLength(1);
});
