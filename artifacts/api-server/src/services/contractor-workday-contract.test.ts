import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createWorkdayAssetSchema, createWorkdayEntrySchema, previewWorkdayCompletionSchema, requestWorkdayPhotoSchema, workdayDefinitionSchema, workdayStarterSchema } from "./contractor-workday-contract";
const definition = { name: "Company draft", trade: "general", description: "Explicitly editable suggestion", items: [{ key: "observed", label: "Record the work", kind: "result", required: true, allowNotApplicable: false, unit: null }] };
it("closed checklist limits reject duplicate keys, invented kinds and unreviewed numeric units", () => {
  expect(workdayDefinitionSchema.safeParse(definition).success).toBe(true);
  for (const items of [[definition.items[0], definition.items[0]], Array.from({ length: 51 }, (_, i) => ({ ...definition.items[0], key: `item_${i}` })), [{ ...definition.items[0], kind: "number" }], [{ ...definition.items[0], kind: "automatically_passed" }]]) expect(workdayDefinitionSchema.safeParse({ ...definition, items }).success).toBe(false);
  expect(workdayDefinitionSchema.safeParse({ ...definition, items: [{ ...definition.items[0], kind: "number", unit: "F" }] }).success).toBe(true);
});
it("starter citations are HTTPS references and never executable or arbitrary URL protocols", () => {
  for (const sourceUrls of [["javascript:alert(1)"], ["http://example.test"], ["file:///private"]]) expect(workdayStarterSchema.safeParse({ id: "sample", version: 1, title: "Sample", description: "", sourceUrls, definition }).success).toBe(false);
});
it("enrollment requires explicit null or chosen equipment and service, not inferred fields", () => {
  const input = { requestId: randomUUID(), expectedAppointmentUpdatedAt: new Date().toISOString(), checklistRevisionId: randomUUID(), assetId: null, serviceObligationId: null };
  expect(createWorkdayEntrySchema.safeParse(input).success).toBe(true);
  expect(createWorkdayEntrySchema.safeParse({ ...input, assetId: undefined }).success).toBe(false);
  expect(createWorkdayEntrySchema.safeParse({ ...input, organizationId: randomUUID() }).success).toBe(false);
});
it("finite completion and photo command shapes reject extra authority and over-limit media", () => {
  const input = { expectedAppointmentUpdatedAt: new Date().toISOString(), entries: [{ id: randomUUID(), version: 1 }], serviceObligationIds: [], performedAt: new Date().toISOString(), summary: "Actual performed-work record", outcome: "completed", followup: null };
  expect(previewWorkdayCompletionSchema.safeParse(input).success).toBe(true);
  expect(previewWorkdayCompletionSchema.safeParse({ ...input, entries: Array.from({ length: 21 }, () => ({ id: randomUUID(), version: 1 })) }).success).toBe(false);
  const photo = { requestId: randomUUID(), expectedVersion: 1, contentType: "image/png", sizeBytes: 10485760, itemKey: null, caption: "" };
  expect(requestWorkdayPhotoSchema.safeParse(photo).success).toBe(true);
  expect(requestWorkdayPhotoSchema.safeParse({ ...photo, sizeBytes: 10485761 }).success).toBe(false);
  expect(requestWorkdayPhotoSchema.safeParse({ ...photo, objectPath: "/objects/uploads/foreign" }).success).toBe(false);
});
