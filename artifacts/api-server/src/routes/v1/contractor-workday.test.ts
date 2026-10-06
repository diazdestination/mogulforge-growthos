import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { appointmentsTable, db, leadsTable, usersTable } from "@workspace/db";
import { AttachAppointmentWorkPhotoResponse, CancelAppointmentWorkEntryResponse, CompleteAppointmentWorkResponse, CreateAppointmentWorkEntryResponse, GetAppointmentWorkResponse, GetWorkdayAssetsResponse, GetWorkdayChecklistsResponse, PreviewAppointmentWorkCompletionResponse, ReserveAppointmentWorkPhotoResponse, SaveAppointmentWorkEntryResponse } from "@workspace/api-zod";
import { eq } from "drizzle-orm";
import app from "../../app";
import { createSession, deleteSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { contractorWorkdayFixture, workdayTestAsset, type WorkdayFixture } from "../../test-helpers/contractor-workday-fixture";
import { appointmentWorkSchema, workdayAssetPageSchema, workdayCompletionPreviewSchema, workdayMutationSchema, workdayPhotoReservationSchema, workdayTemplateCatalogSchema } from "../../services/contractor-workday-contract";
import * as apiKeys from "../../services/api-keys";
const originalFetch = globalThis.fetch, origin = "https://workday.example", sessions: string[] = [], extraOrgs: string[] = [];
let server: Server, base: string, a: WorkdayFixture, b: WorkdayFixture, owner: string, tech: string, viewer: string, foreign: string, unverified: string, pending: string;
async function session(id: string) { const sid = await createSession({ user: { id, email: null, firstName: null, lastName: null, profileImageUrl: null }, access_token: "synthetic" }); sessions.push(sid); return sid; }
async function request(path: string, options: { method?: string; body?: unknown; sid?: string; headers?: Record<string, string> } = {}) {
  return originalFetch(`${base}/api/v1${path}`, { method: options.method ?? "GET", headers: { origin, cookie: `sid=${options.sid ?? tech}`, ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
}
function generatedResponse(schema: { parse(value: unknown): unknown }, value: unknown) {
  // Exercise the published, generated HTTP contract, not just the service DTO.
  // Date coercion is normalized back to wire JSON; no field may be discarded.
  expect(JSON.parse(JSON.stringify(schema.parse(value)))).toEqual(value);
  return value;
}
beforeAll(async () => {
  vi.stubEnv("APP_ORIGIN", origin); vi.stubEnv("SESSION_SECRET", "synthetic-workday-http-signing-key"); vi.stubEnv("OBJECT_STORAGE_PROVIDER", "postgres");
  a = await contractorWorkdayFixture(); b = await contractorWorkdayFixture();
  owner = await session(a.owner.id); tech = await session(a.tech.id); viewer = await session(a.viewer.id); foreign = await session(b.owner.id);
  const [uv, invite] = await db.insert(usersTable).values([{ organizationId: a.org, role: "owner", emailVerifiedAt: null }, { organizationId: a.org, id: `invite:${randomUUID()}`, role: "owner", emailVerifiedAt: new Date() }]).returning();
  unverified = await session(uv.id); pending = await session(invite.id);
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal("fetch", async () => { throw Error("No remote provider transport permitted"); });
});
afterAll(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } for (const sid of sessions) await deleteSession(sid); await deleteTestOrgs(a?.org, b?.org, ...extraOrgs); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("real staff GETs return closed company-scoped asset, template and native work projections", async () => {
  const assets = await request(`/contacts/${a.contact.id}/assets`, { sid: viewer }); expect(assets.status).toBe(200); workdayAssetPageSchema.parse(generatedResponse(GetWorkdayAssetsResponse, await assets.json()));
  const templates = await request("/work-checklists", { sid: viewer }); expect(templates.status).toBe(200); expect(workdayTemplateCatalogSchema.parse(generatedResponse(GetWorkdayChecklistsResponse, await templates.json())).canManage).toBe(false);
  const work = await request(`/appointments/${a.appointment.id}/work`, { sid: viewer }); expect(work.status).toBe(200); const body = appointmentWorkSchema.parse(generatedResponse(GetAppointmentWorkResponse, await work.json()));
  expect(body.capabilities.canEdit).toBe(false); expect(body.entries[0].contactId).toBe(a.contact.id);
  expect(work.headers.get("cache-control")).toBe("no-store"); expect(work.headers.get("referrer-policy")).toBe("no-referrer");
});
it("new GETs and commands reject blank API keys, unaccepted or unverified sessions and foreign origins before side effects", async () => {
  const key = vi.spyOn(apiKeys, "resolveApiKey"), path = `/appointments/${a.appointment.id}/work`;
  for (const value of ["", "synthetic-never-resolve"]) expect((await request(path, { headers: { "x-api-key": value } })).status).toBe(403);
  expect(key).not.toHaveBeenCalled();
  for (const sid of [unverified, pending]) expect((await request(path, { sid })).status).toBe(403);
  expect((await request(path, { headers: { cookie: "" } })).status).toBe(401);
  expect((await request(path, { headers: { origin: "https://untrusted.example" } })).status).toBe(403);
  expect((await request(path, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
  expect((await request(`/contacts/${a.contact.id}/assets`, { method: "POST", body: { ...workdayTestAsset, propertyId: a.property.id, requestId: randomUUID() }, headers: { "content-type": "text/plain" } })).status).toBe(415);
});
it("tenant, effective-role and strict selector defenses do not rely on UI capabilities", async () => {
  expect((await request(`/appointments/${a.appointment.id}/work`, { sid: foreign })).status).toBe(404);
  expect((await request(`/contacts/${a.contact.id}/assets`, { sid: foreign })).status).toBe(404);
  expect((await request(`/appointments/${a.appointment.id}/work?organizationId=${b.org}`)).status).toBe(400);
  expect((await request(`/contacts/${a.contact.id}/assets?cursor=bad&cursor=other`)).status).toBe(400);
  expect((await request("/appointments/not-a-uuid/work")).status).toBe(400);
  const draft = { requestId: randomUUID(), expectedVersion: 1, answers: [], notes: "Viewer cannot record work" };
  const work = appointmentWorkSchema.parse(await (await request(`/appointments/${a.appointment.id}/work`)).json());
  expect((await request(`/appointments/${a.appointment.id}/work/entries/${work.entries[0].id}`, { method: "PATCH", sid: viewer, body: draft })).status).toBe(403);
  expect((await request("/work-checklists", { method: "POST", body: { requestId: randomUUID(), definition: work.entries[0].checklist.definition } })).status).toBe(403);
});
it("actual save/reopen and signed private photo PUT/attachment retain exact entry versions", async () => {
  const path = `/appointments/${a.appointment.id}/work`, work = appointmentWorkSchema.parse(generatedResponse(GetAppointmentWorkResponse, await (await request(path)).json())), entry = work.entries[0];
  const draft = { requestId: randomUUID(), expectedVersion: entry.version, answers: [{ itemKey: "observed", result: "done", value: null, reason: null }], notes: "Real HTTP staff observation" };
  const saved = await request(`${path}/entries/${entry.id}`, { method: "PATCH", body: draft }); expect(saved.status).toBe(200); const current = workdayMutationSchema.parse(generatedResponse(SaveAppointmentWorkEntryResponse, await saved.json()));
  expect(current.work.entries[0].notes).toBe(draft.notes); expect((await request(`${path}/entries/${entry.id}`, { method: "PATCH", body: { ...draft, requestId: randomUUID() } })).status).toBe(409);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlSMAAAAASUVORK5CYII=", "base64");
  const reserve = await request(`${path}/entries/${entry.id}/photos/request-url`, { method: "POST", body: { requestId: randomUUID(), expectedVersion: current.work.entries[0].version, contentType: "image/png", sizeBytes: png.length, itemKey: null, caption: "Private exact-visit HTTP photo" } }); expect(reserve.status).toBe(200);
  const reservation = workdayPhotoReservationSchema.parse(generatedResponse(ReserveAppointmentWorkPhotoResponse, await reserve.json())); expect(reservation.uploadUrl).toMatch(/^\/api\/v1\/public\/uploads\/local\//);
  const uploaded = await originalFetch(base + reservation.uploadUrl, { method: "PUT", headers: { "content-type": "image/png" }, body: png }); expect(uploaded.status).toBe(201);
  const attached = await request(`${path}/entries/${entry.id}/photos`, { method: "POST", body: { requestId: randomUUID(), expectedVersion: reservation.work.entries[0].version, photoId: reservation.photoId } }); expect(attached.status).toBe(200);
  const final = workdayMutationSchema.parse(generatedResponse(AttachAppointmentWorkPhotoResponse, await attached.json())), contentPath = final.work.entries[0].photos[0].contentPath!;
  const image = await originalFetch(base + contentPath, { headers: { cookie: `sid=${tech}`, origin } }); expect(image.status).toBe(200); expect(image.headers.get("x-content-type-options")).toBe("nosniff"); expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
  expect((await originalFetch(base + contentPath, { headers: { cookie: `sid=${foreign}`, origin } })).status).toBe(404);
  const previewResponse = await request(`${path}/completion-preview`, { method: "POST", body: { expectedAppointmentUpdatedAt: final.work.appointment.updatedAt, entries: final.work.entries.map(e => ({ id: e.id, version: e.version })), serviceObligationIds: [a.service!.id], performedAt: new Date(Date.now() - 1000).toISOString(), summary: "Recorded by the assigned technician through the actual staff API", outcome: "completed", followup: null } });
  expect(previewResponse.status).toBe(200); const preview = workdayCompletionPreviewSchema.parse(generatedResponse(PreviewAppointmentWorkCompletionResponse, await previewResponse.json())), requestId = randomUUID();
  const completedResponse = await request(`${path}/complete`, { method: "POST", body: { requestId, previewToken: preview.previewToken, confirmed: true } }); expect(completedResponse.status).toBe(200);
  const completed = workdayMutationSchema.parse(generatedResponse(CompleteAppointmentWorkResponse, await completedResponse.json())); expect(completed.work.completion).toMatchObject({ requestId, performerUserId: a.tech.id, nativeAppointmentStatus: "completed" });
  expect(completed.work.entries[0].photos[0].contentPath).toBe(contentPath);
  const repeated = await request(`${path}/complete`, { method: "POST", body: { requestId, previewToken: preview.previewToken, confirmed: true } }); expect(repeated.status).toBe(200); expect(workdayMutationSchema.parse(generatedResponse(CompleteAppointmentWorkResponse, await repeated.json())).receipt.replayed).toBe(true);
});
it("legacy explicit lead-only visits project their resolved customer without rewriting native null or inventing a property", async () => {
  const [lead] = await db.insert(leadsTable).values({ organizationId: a.org, contactId: a.contact.id, propertyId: a.property.id }).returning();
  const [visit] = await db.insert(appointmentsTable).values({ organizationId: a.org, contactId: null, propertyId: null, leadId: lead.id, assignedUserId: a.tech.id, type: "other", scheduledStart: new Date("2035-05-01T12:00:00Z"), scheduledEnd: new Date("2035-05-01T13:00:00Z") }).returning();
  const path = `/appointments/${visit.id}/work`, before = appointmentWorkSchema.parse(generatedResponse(GetAppointmentWorkResponse, await (await request(path)).json()));
  expect(before.appointment).toMatchObject({ contactId: a.contact.id, propertyId: null, leadId: lead.id });
  const enrolled = await request(`${path}/entries`, { method: "POST", body: { requestId: randomUUID(), expectedAppointmentUpdatedAt: visit.updatedAt.toISOString(), checklistRevisionId: a.template.approvedRevision.id, assetId: null, serviceObligationId: null } }); expect(enrolled.status).toBe(200);
  const result = workdayMutationSchema.parse(generatedResponse(CreateAppointmentWorkEntryResponse, await enrolled.json())); expect(result.work.entries.every(e => e.contactId === result.work.appointment.contactId)).toBe(true);
  const entry = result.work.entries[0];
  const savedResponse = await request(`${path}/entries/${entry.id}`, { method: "PATCH", body: { requestId: randomUUID(), expectedVersion: entry.version, answers: [{ itemKey: "observed", result: "done", value: null, reason: null }], notes: "Legacy explicit customer work" } }); expect(savedResponse.status).toBe(200);
  const saved = workdayMutationSchema.parse(generatedResponse(SaveAppointmentWorkEntryResponse, await savedResponse.json()));
  const previewResponse = await request(`${path}/completion-preview`, { method: "POST", body: { expectedAppointmentUpdatedAt: saved.work.appointment.updatedAt, entries: saved.work.entries.map(e => ({ id: e.id, version: e.version })), serviceObligationIds: [], performedAt: new Date(Date.now() - 1000).toISOString(), summary: "Lead-derived canonical customer, no native parent backfill", outcome: "completed", followup: null } }); expect(previewResponse.status).toBe(200);
  const preview = workdayCompletionPreviewSchema.parse(generatedResponse(PreviewAppointmentWorkCompletionResponse, await previewResponse.json()));
  const completed = await request(`${path}/complete`, { method: "POST", body: { requestId: randomUUID(), previewToken: preview.previewToken, confirmed: true } }); expect(completed.status).toBe(200);
  expect(workdayMutationSchema.parse(generatedResponse(CompleteAppointmentWorkResponse, await completed.json())).work.completion?.contactId).toBe(a.contact.id);
  expect((await db.select().from(appointmentsTable).where(eq(appointmentsTable.id, visit.id)))[0]).toMatchObject({ contactId: null, propertyId: null, leadId: lead.id });
});
it.each(["asset", "parent"] as const)("generated HTTP contracts expose explicit office cancellation and re-preparation for a held %s without granting edits", async kind => {
  const f = await contractorWorkdayFixture(); extraOrgs.push(f.org);
  const officeSid = await session(f.office.id), techSid = await session(f.tech.id), path = `/appointments/${f.appointment.id}/work`;
  const read = async (sid: string) => { const response = await request(path, { sid }); expect(response.status).toBe(200); return appointmentWorkSchema.parse(generatedResponse(GetAppointmentWorkResponse, await response.json())); };
  const before = await read(officeSid), original = before.entries[0];
  const changed = kind === "asset"
    ? await request(`/assets/${f.assetId}`, { method: "PATCH", sid: officeSid, body: { ...workdayTestAsset, requestId: randomUUID(), expectedVersion: 1, status: "active", label: "Office corrected this exact unit" } })
    : await request(`/properties/${f.property.id}`, { method: "PATCH", sid: officeSid, body: { addressLine1: "Office corrected this original property address" } });
  expect(changed.status).toBe(200);
  const held = await read(officeSid); expect(held.capabilities).toMatchObject({ canCancel: true, canComplete: false, requiresActingNote: true });
  expect(held.entries[0].holdReasons).toContain(`workday_${kind}_changed`);
  expect((await read(techSid)).capabilities.canCancel).toBe(false);
  const actingNote = "Office cancels the held preparation on behalf of the assigned technician";
  const edit = await request(`${path}/entries/${original.id}`, { method: "PATCH", sid: officeSid, body: { requestId: randomUUID(), expectedVersion: original.version, answers: [], notes: "Must not overwrite held answers", actingNote } });
  expect(edit.status).toBe(409); expect(await edit.json()).toMatchObject({ code: `workday_${kind}_changed` });
  const command = { requestId: randomUUID(), expectedVersion: original.version, reason: "Explicitly review corrected source through fresh preparation", actingNote };
  expect((await request(`${path}/entries/${original.id}/cancel`, { method: "POST", sid: techSid, body: command })).status).toBe(403);
  expect((await request(`${path}/entries/${original.id}/cancel`, { method: "POST", sid: officeSid, body: { ...command, actingNote: undefined } })).status).toBe(409);
  expect((await request(`${path}/entries/${original.id}/cancel`, { method: "POST", sid: officeSid, body: { ...command, expectedVersion: original.version + 1 } })).status).toBe(409);
  const cancelledResponse = await request(`${path}/entries/${original.id}/cancel`, { method: "POST", sid: officeSid, body: command }); expect(cancelledResponse.status).toBe(200);
  const cancelled = workdayMutationSchema.parse(generatedResponse(CancelAppointmentWorkEntryResponse, await cancelledResponse.json()));
  expect(cancelled.work.entries[0]).toMatchObject({ id: original.id, state: "cancelled", version: original.version + 1, answers: original.answers, notes: original.notes, assetSnapshot: original.assetSnapshot });
  expect(cancelled.work.capabilities.canCancel).toBe(false); expect(cancelled.work.completion).toBeNull(); expect(cancelled.work.appointment).toEqual(held.appointment);
  const repeat = await request(`${path}/entries/${original.id}/cancel`, { method: "POST", sid: officeSid, body: command }); expect(repeat.status).toBe(200);
  expect(workdayMutationSchema.parse(generatedResponse(CancelAppointmentWorkEntryResponse, await repeat.json())).receipt.replayed).toBe(true);
  expect((await request(`${path}/entries/${original.id}/cancel`, { method: "POST", sid: officeSid, body: { ...command, reason: "Changed old command" } })).status).toBe(409);
  const moved = await request(`/appointments/${f.appointment.id}`, { method: "PATCH", sid: officeSid, body: { contactId: f.otherContact.id, propertyId: null } });
  expect(moved.status).toBe(409); expect(await moved.json()).toMatchObject({ code: "workday_parent_locked", error: expect.stringContaining("separate visit") });
  const preparedResponse = await request(`${path}/entries`, { method: "POST", sid: officeSid, body: { requestId: randomUUID(), expectedAppointmentUpdatedAt: cancelled.work.appointment.updatedAt, checklistRevisionId: f.template.approvedRevision.id, assetId: f.assetId, serviceObligationId: f.service!.id, actingNote: "Office prepares the reviewed corrected original visit for the assigned technician" } }); expect(preparedResponse.status).toBe(200);
  const prepared = workdayMutationSchema.parse(generatedResponse(CreateAppointmentWorkEntryResponse, await preparedResponse.json()));
  const replacement = prepared.work.entries.find(entry => entry.state === "draft")!;
  expect(replacement.id).not.toBe(original.id); expect(replacement.answers).toEqual([]); expect(replacement.contactId).toBe(f.contact.id); expect(replacement.propertyId).toBe(f.property.id);
  expect(prepared.work.entries.find(entry => entry.id === original.id)).toEqual(cancelled.work.entries[0]);
  expect(replacement.holdReasons).toEqual([]); expect(prepared.work.capabilities.canCancel).toBe(true);
  expect((await db.select().from(appointmentsTable).where(eq(appointmentsTable.id, f.appointment.id)))[0]).toEqual(f.appointment);
});
it("freshly revoked assignment permission is honored by actual HTTP writes", async () => {
  const work = appointmentWorkSchema.parse(await (await request(`/appointments/${a.appointment.id}/work`)).json());
  await db.update(usersTable).set({ role: "viewer" }).where(eq(usersTable.id, a.tech.id));
  try { expect((await request(`/appointments/${a.appointment.id}/work/entries/${work.entries[0].id}`, { method: "PATCH", body: { requestId: randomUUID(), expectedVersion: work.entries[0].version, answers: [], notes: "Stale role" } })).status).toBe(403); }
  finally { await db.update(usersTable).set({ role: "inspector" }).where(eq(usersTable.id, a.tech.id)); }
});
