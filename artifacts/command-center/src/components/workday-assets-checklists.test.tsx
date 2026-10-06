import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import CustomerAssetsPanel from './customer-assets-panel';
import CompanyChecklistsPanel from './company-checklists-panel';
import { WorkdayDisclosure } from './workday-ui';
import { assetPageFor, catalogFor, workFor } from './workday-contract';
import { appointment, asset, assetId, assets, catalog, contact, definition, org, property, template, templateId, wid, work } from '@/test/workday-fixtures';
import { deferred, json, mountWorkday, otherOrg, workdayClients, workdayServer } from '@/test/workday-test-server';

afterEach(() => { cleanup(); workdayClients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const assetsPanel = (scopeKey = 'staff-a:owner', contactId = contact) => <CustomerAssetsPanel organizationId={org} contactId={contactId} scopeKey={scopeKey} />;
const checklistPanel = (scopeKey = 'staff-a:owner') => <CompanyChecklistsPanel organizationId={org} scopeKey={scopeKey} />;

it('loads assets only on explicit disclosure and leaves historical equipment labels separate', async () => {
  const api = workdayServer(); mountWorkday(<WorkdayDisclosure title="Equipment & assets">{assetsPanel()}</WorkdayDisclosure>);
  expect(api.requests).toHaveLength(0); fireEvent.click(screen.getByRole('button', { name: 'Open equipment & assets' }));
  await screen.findByText('Fictional north unit'); expect(screen.getByText(/Old service equipment labels are separate history/)).toBeTruthy();
  expect(api.writes()).toHaveLength(0); fireEvent.click(screen.getByRole('button', { name: 'Close equipment & assets' })); expect(screen.queryByText('Fictional north unit')).toBeNull();
});
it('loads an independent second asset page without dropping the first page or altering property context', async () => {
  const api = workdayServer(req => req.path.endsWith('/assets') && req.query.get('cursor') ? json(assets({ items: [asset({ id: wid(70), label: 'Fictional second unit' })] })) : undefined);
  api.state.assets = assets({ hasMore: true, nextCursor: 'page_two' }); mountWorkday(assetsPanel()); await screen.findByText('Fictional north unit');
  fireEvent.click(screen.getByRole('button', { name: 'Load more customer assets' })); await screen.findByText('Fictional second unit'); expect(screen.getByText('Fictional north unit')).toBeTruthy();
  expect(api.requests.find(req => req.query.has('cursor'))?.query.get('cursor')).toBe('page_two');
});
it('requires explicit property even for one option, sends recorded nullable facts and preserves request identity', async () => {
  const api = workdayServer(req => req.path.endsWith('/assets') && req.method === 'POST' ? json({ organizationId: org, asset: asset({ label: req.body.label, category: req.body.category, propertyId: req.body.propertyId }), receipt: { requestId: req.body.requestId, replayed: false } }) : undefined);
  mountWorkday(assetsPanel()); fireEvent.click(await screen.findByRole('button', { name: 'Add equipment or asset' }));
  await screen.findByRole('option', { name: /15 Fictional Lane/ }); expect((screen.getByRole('combobox', { name: 'Property for this new asset' }) as HTMLSelectElement).value).toBe('');
  fireEvent.change(screen.getByLabelText('Asset name'), { target: { value: 'New fictional unit' } }); fireEvent.change(screen.getByLabelText('Asset type'), { target: { value: 'hvac_equipment' } });
  expect((screen.getByRole('button', { name: 'Save recorded asset' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole('combobox', { name: 'Property for this new asset' }), { target: { value: property } }); fireEvent.click(screen.getByRole('button', { name: 'Save recorded asset' }));
  await screen.findByText(/Recorded asset saved/); const saved = api.writes()[0].body;
  expect(saved).toMatchObject({ propertyId: property, label: 'New fictional unit', category: 'hvac_equipment', manufacturer: null, model: null, warrantySource: null, attributes: [] }); expect(saved.requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(saved).not.toHaveProperty('leadId');
});
it('keeps fixed asset parent and original optional facts on optimistic edits', async () => {
  const api = workdayServer(req => req.path === `/api/v1/assets/${assetId}` ? json({ organizationId: org, asset: asset({ label: req.body.label, version: 2, serial: 'Recorded serial', notes: 'Original evidence' }), receipt: { requestId: req.body.requestId, replayed: false } }) : undefined);
  api.state.assets = assets({ items: [asset({ serial: 'Recorded serial', notes: 'Original evidence' })] }); mountWorkday(assetsPanel()); fireEvent.click(await screen.findByRole('button', { name: 'Edit Fictional north unit' }));
  expect(screen.queryByRole('combobox', { name: /Property/ })).toBeNull(); fireEvent.change(screen.getByLabelText('Asset name'), { target: { value: 'Updated name' } }); fireEvent.click(screen.getByRole('button', { name: 'Save recorded asset' })); await screen.findByText('Updated name');
  expect(api.writes()[0]).toMatchObject({ method: 'PATCH', body: { expectedVersion: 1, serial: 'Recorded serial', notes: 'Original evidence', status: 'active' } }); expect(api.writes()[0].body).not.toHaveProperty('propertyId');
});
it('holds an unknown asset save with no retry until explicit refresh', async () => {
  const api = workdayServer(req => req.method === 'PATCH' ? Promise.reject(new TypeError('Acknowledgement lost')) : undefined); mountWorkday(assetsPanel());
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Fictional north unit' })); fireEvent.click(screen.getByRole('button', { name: 'Save recorded asset' }));
  await screen.findByText(/No automatic retry was made/); fireEvent.click(screen.getByRole('button', { name: 'Save recorded asset' })); expect(api.writes()).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh assets and review saved records' })); await screen.findByRole('button', { name: 'Edit Fictional north unit' }); expect(screen.queryByText(/No automatic retry was made/)).toBeNull();
});
it('fences pending old-member asset result and keeps the new read-only member unable to write', async () => {
  const pending = deferred<Response>(); let read = 0;
  workdayServer(req => req.path.endsWith('/assets') ? ++read === 1 ? pending.promise : json(assets({ items: [asset({ canEdit: false })], canCreate: false })) : undefined);
  const view = mountWorkday(assetsPanel()); view.rerender(<CustomerAssetsPanel organizationId={org} contactId={contact} scopeKey="viewer-b" />);
  await screen.findByText('Fictional north unit'); await act(async () => pending.resolve(json(assets({ items: [asset({ label: 'Late privileged unit' })] }))));
  expect(screen.queryByText('Late privileged unit')).toBeNull(); expect(screen.queryByRole('button', { name: /Add equipment|Edit Fictional/ })).toBeNull();
});
it('does not present a failed or cross-company asset response as an empty customer', async () => {
  workdayServer(req => req.path.endsWith('/assets') ? json(assets({ organizationId: otherOrg })) : undefined); mountWorkday(assetsPanel());
  await screen.findByText('Assets are unavailable, not an empty result.'); expect(screen.queryByText(/No structured assets recorded/)).toBeNull(); expect(screen.queryByText('Fictional north unit')).toBeNull();
});
it('validates closed context, duplicate identity and private photo paths before rendering', () => {
  expect(assetPageFor(org, contact).safeParse(assets()).success).toBe(true); expect(assetPageFor(org, contact).safeParse(assets({ items: [asset({ contactId: wid(102) })] })).success).toBe(false);
  expect(catalogFor(org).safeParse(catalog({ templates: [template(), template()] })).success).toBe(false);
  const detail = work(); detail.entries[0].photos = [{ id: wid(80), entryId: detail.entries[0].id, itemKey: null, caption: 'Do not load external pixels', state: 'attached', contentType: 'image/jpeg', sizeBytes: 10, expiresAt: new Date().toISOString(), attachedAt: new Date().toISOString(), contentPath: 'https://example.test/tracker', available: true }];
  expect(workFor(org, appointment).safeParse(detail).success).toBe(false);
});
it('copies a suggested baseline into editable draft only, with all four typed item kinds', async () => {
  const api = workdayServer(); mountWorkday(checklistPanel()); fireEvent.click(await screen.findByRole('button', { name: 'Create company checklist' }));
  fireEvent.change(screen.getByLabelText('Suggested baseline'), { target: { value: 'synthetic_baseline' } }); fireEvent.click(screen.getByRole('button', { name: 'Copy selected baseline into editable draft' }));
  expect((screen.getByLabelText('Checklist name') as HTMLInputElement).value).toBe('Synthetic unit visit');
  expect([1, 2, 3, 4].map(n => (screen.getByLabelText(`Item ${n} response kind`) as HTMLSelectElement).value)).toEqual(['result', 'text', 'number', 'photo']);
  expect(screen.getByText(/Suggested baseline — company review required/)).toBeTruthy(); expect(api.writes()).toHaveLength(0); expect(screen.queryByRole('button', { name: 'Approve reviewed revision' })).toBeNull();
});
it('requires exact saved company review, invalidates it on draft edits, and never sends token as visible text', async () => {
  const api = workdayServer(); mountWorkday(checklistPanel()); fireEvent.click(await screen.findByRole('button', { name: 'Edit or review Synthetic unit visit' })); fireEvent.click(screen.getByRole('button', { name: 'Prepare exact company review' }));
  await screen.findByRole('region', { name: 'Exact checklist approval' }); expect(screen.queryByText('synthetic-checklist-review')).toBeNull(); expect((screen.getByRole('button', { name: 'Approve reviewed revision' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Item 1 label'), { target: { value: 'Changed instruction' } }); expect(screen.queryByRole('region', { name: 'Exact checklist approval' })).toBeNull(); expect(screen.getByText(/Unsaved edits cannot be approved/)).toBeTruthy(); expect(api.writes()).toHaveLength(1);
});
it('submits only the reviewed checklist token and explicit confirmation', async () => {
  const api = workdayServer(req => req.path.endsWith('/approve') ? json({ organizationId: org, template: template(), receipt: { requestId: req.body.requestId, replayed: false } }) : undefined); mountWorkday(checklistPanel());
  fireEvent.click(await screen.findByRole('button', { name: 'Edit or review Synthetic unit visit' })); fireEvent.click(screen.getByRole('button', { name: 'Prepare exact company review' })); await screen.findByRole('region', { name: 'Exact checklist approval' });
  fireEvent.click(screen.getByLabelText(/I reviewed these exact instructions/)); fireEvent.click(screen.getByRole('button', { name: 'Approve reviewed revision' })); await screen.findByText(/Exact checklist revision approved/);
  expect(api.writes().at(-1)?.body).toEqual({ requestId: expect.any(String), previewToken: 'synthetic-checklist-review', confirmed: true });
});
it('rejects a checklist preview from a different revision and holds an unknown save without automatic retry', async () => {
  const api = workdayServer(req => req.path.endsWith('/preview') ? json({ organizationId: org, templateId, expectedVersion: 2, revision: { ...template().latestRevision, id: wid(99) }, expiresAt: new Date(Date.now() + 60000).toISOString(), previewToken: 'wrong' }) : req.path.endsWith('/revisions') ? Promise.reject(new TypeError('lost response')) : undefined);
  mountWorkday(checklistPanel()); fireEvent.click(await screen.findByRole('button', { name: 'Edit or review Synthetic unit visit' })); fireEvent.click(screen.getByRole('button', { name: 'Prepare exact company review' })); await screen.findByText(/returned work record could not be verified/); expect(screen.queryByRole('region', { name: 'Exact checklist approval' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Checklist name'), { target: { value: 'New reviewed name' } }); fireEvent.click(screen.getByRole('button', { name: 'Save unreviewed revision' })); await screen.findByText(/No automatic retry was made/); expect(api.writes().filter(req => req.path.endsWith('/revisions'))).toHaveLength(1);
});
it('keeps checklist read-only authority and retained originals without management controls', async () => {
  const api = workdayServer(); api.state.catalog = catalog({ canManage: false }); mountWorkday(checklistPanel()); await screen.findByText(/only owner\/admin company review/); expect(screen.queryByRole('button', { name: /Create company|Edit or review/ })).toBeNull(); expect(api.writes()).toHaveLength(0);
});
it('does not let a late company preview return after actor or company scope changes', async () => {
  const pending = deferred<Response>(); const api = workdayServer(req => req.path.endsWith('/preview') ? pending.promise : undefined); const view = mountWorkday(checklistPanel());
  fireEvent.click(await screen.findByRole('button', { name: 'Edit or review Synthetic unit visit' })); fireEvent.click(screen.getByRole('button', { name: 'Prepare exact company review' }));
  view.rerender(checklistPanel('staff-b:viewer')); await screen.findByText('Company checklists'); await act(async () => pending.resolve(json({ organizationId: org, templateId, expectedVersion: 2, revision: template().latestRevision, expiresAt: new Date(Date.now() + 60000).toISOString(), previewToken: 'late' })));
  expect(screen.queryByRole('region', { name: 'Exact checklist approval' })).toBeNull(); expect(api.writes()).toHaveLength(1);
});

it('refuses an expired checklist approval without resending or minting another token', async () => {
  const api = workdayServer(); mountWorkday(checklistPanel()); fireEvent.click(await screen.findByRole('button', { name: 'Edit or review Synthetic unit visit' })); fireEvent.click(screen.getByRole('button', { name: 'Prepare exact company review' })); await screen.findByRole('region', { name: 'Exact checklist approval' });
  fireEvent.click(screen.getByLabelText(/I reviewed these exact instructions/)); const future = Date.now() + 120000; vi.spyOn(Date, 'now').mockReturnValue(future); fireEvent.click(screen.getByRole('button', { name: 'Approve reviewed revision' }));
  await screen.findByText('This review expired. Prepare a fresh review.'); expect(api.writes()).toHaveLength(1);
});
it('forces a fresh catalog read after an unknown revision save before exposing management controls again', async () => {
  const api = workdayServer(req => req.path.endsWith('/revisions') ? Promise.reject(new TypeError('Unknown save')) : undefined); mountWorkday(checklistPanel()); fireEvent.click(await screen.findByRole('button', { name: 'Edit or review Synthetic unit visit' }));
  fireEvent.change(screen.getByLabelText('Checklist name'), { target: { value: 'Unknown changed name' } }); fireEvent.click(screen.getByRole('button', { name: 'Save unreviewed revision' })); await screen.findByText(/No automatic retry was made/);
  fireEvent.click(screen.getByRole('button', { name: 'Close and refresh company checklist catalog' })); await screen.findByRole('button', { name: 'Create company checklist' }); expect(api.requests.filter(req => req.path === '/api/v1/work-checklists' && req.method === 'GET')).toHaveLength(2); expect(api.writes()).toHaveLength(1);
});
