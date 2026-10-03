import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  sourceNurtureApprovalSchema, sourceNurtureDraftSchema, sourceNurtureStartSchema,
  sourceNurtureStopSchema, sourceNurtureListQuerySchema,
  NURTURE_LIFETIME_MS, NURTURE_MAX_RECIPIENTS, NURTURE_REVIEW_MS, NURTURE_SPACING_MS,
} from "./source-nurture-contract";
import { nurturePlanFingerprint } from "./source-nurture-fingerprint";
import { sourceFingerprint } from "./source-adoption-contract";
import type { SourceNurtureItemSnapshot } from "../../../../lib/db/src/schema/source-nurture";

const draft = () => ({
  leadIds: [randomUUID()], businessName: "SYNTHETIC contractor", mailingAddress: "Synthetic non-deliverable office address",
  steps: [{ subject: "First exact subject", body: "First reviewed message body." }, { subject: "Second exact subject", body: "Second reviewed message body." }],
  timezone: "America/New_York", days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], startHour: 9, endHour: 18, dailyLimit: 10,
  startNotBefore: "2026-10-03T12:00:00.000Z", expiresAt: "2026-10-10T12:00:00.000Z",
});
it("defines finite two-touch bounds separately from live contact permission", () => {
  expect(NURTURE_MAX_RECIPIENTS).toBe(10); expect(NURTURE_SPACING_MS).toBe(72 * 3_600_000);
  expect(NURTURE_LIFETIME_MS).toBe(14 * 86_400_000); expect(NURTURE_REVIEW_MS).toBe(600_000);
  expect(sourceNurtureDraftSchema.parse(draft()).steps).toHaveLength(2);
});
it("rejects variable drips, duplicate enrollment, unknown authority and mismatched windows", () => {
  const good = draft();
  for (const value of [
    { ...good, steps: good.steps.slice(0, 1) }, { ...good, steps: [...good.steps, good.steps[0]] },
    { ...good, leadIds: Array.from({ length: 11 }, () => randomUUID()) },
    { ...good, leadIds: [good.leadIds[0], good.leadIds[0]] }, { ...good, leadIds: [] },
    { ...good, followUpDelayHours: 1 }, { ...good, allowFallbackSender: true }, { ...good, organizationId: randomUUID() },
    { ...good, startHour: 18, endHour: 9 }, { ...good, days: ["Mon", "Mon"] }, { ...good, timezone: "Not/AZone" },
    { ...good, dailyLimit: 26 }, { ...good, leadIds: [randomUUID(), randomUUID()], dailyLimit: 1 },
    { ...good, steps: [{ ...good.steps[0], subject: "Injected\r\nBcc: other@example.invalid" }, good.steps[1]] },
  ]) expect(sourceNurtureDraftSchema.safeParse(value).success).toBe(false);
});
it("keeps approval, explicit start and reasoned stop distinct with no replay-key replacement fields", () => {
  const approve = { expectedVersion: 1, payloadSha256: "a".repeat(64), confirmed: true };
  expect(sourceNurtureApprovalSchema.safeParse(approve).success).toBe(true);
  expect(sourceNurtureStartSchema.safeParse(approve).success).toBe(false);
  const start = { ...approve, requestId: randomUUID() };
  expect(sourceNurtureStartSchema.safeParse(start).success).toBe(true);
  expect(sourceNurtureApprovalSchema.safeParse(start).success).toBe(false);
  expect(sourceNurtureStopSchema.safeParse(start).success).toBe(false);
  expect(sourceNurtureStopSchema.safeParse({ ...start, reason: "Owner stopped this exact finite sequence." }).success).toBe(true);
  for (const changed of [{ ...start, confirmed: false }, { ...start, expectedVersion: 0 }, { ...start, payloadSha256: "bad" }, { ...start, force: true }, { ...start, retry: true }, { ...start, newActionKey: randomUUID() }])
    expect(sourceNurtureStartSchema.safeParse(changed).success).toBe(false);
});
it("accepts only bounded evidence buckets and offsets", () => {
  expect(sourceNurtureListQuerySchema.parse({})).toEqual({ bucket: "attention", offset: 0 });
  expect(sourceNurtureListQuerySchema.parse({ bucket: "history", offset: "25" })).toEqual({ bucket: "history", offset: 25 });
  for (const query of [{ bucket: "all" }, { offset: -1 }, { offset: 100001 }, { offset: [0, 1] }, { organizationId: randomUUID() }])
    expect(sourceNurtureListQuerySchema.safeParse(query).success).toBe(false);
});
it("fingerprints exact immutable authority while allowing receipts and stop state to evolve", () => {
  const parsed = sourceNurtureDraftSchema.parse(draft()), { leadIds: _leadIds, startNotBefore, expiresAt, ...settings } = parsed;
  const plan = { id: randomUUID(), organizationId: randomUUID(), settings, reviewId: randomUUID(), createdByUserId: "synthetic-owner",
    createdAt: new Date(startNotBefore), previewExpiresAt: new Date("2026-10-03T12:10:00.000Z"), startNotBefore: new Date(startNotBefore), expiresAt: new Date(expiresAt) };
  // Fingerprinting includes the saved opaque snapshot verbatim; its strict
  // shape/current business authority is tested separately by the runtime.
  const item = { id: randomUUID(), leadId: randomUUID(), contactId: randomUUID(), propertyId: null, ownerUserId: "synthetic-owner", adoptionId: randomUUID(), recipient: "customer@example.invalid",
    snapshot: { version: 1, source: "SYNTHETIC immutable test payload" } as unknown as SourceNurtureItemSnapshot };
  const first = { id: randomUUID(), itemId: item.id, stepIndex: 1 as const, predecessorId: null, ...settings.steps[0], expiresAt: plan.expiresAt,
    messageHash: sourceFingerprint({ to: item.recipient, ...settings.steps[0] }) };
  const second = { ...first, id: randomUUID(), stepIndex: 2 as const, predecessorId: first.id, ...settings.steps[1], messageHash: sourceFingerprint({ to: item.recipient, ...settings.steps[1] }) };
  const digest = nurturePlanFingerprint(plan, [item], [first, second]);
  expect(nurturePlanFingerprint(plan, [item], [second, first])).toBe(digest);
  expect(nurturePlanFingerprint({ ...plan, state: "stopped", version: 4 } as typeof plan, [{ ...item, stoppedAt: new Date() } as typeof item], [{ ...first, claimedAt: new Date() } as typeof first, second])).toBe(digest);
  expect(nurturePlanFingerprint({ ...plan, createdByUserId: "different-actor" }, [item], [first, second])).not.toBe(digest);
  expect(nurturePlanFingerprint({ ...plan, organizationId: randomUUID() }, [item], [first, second])).not.toBe(digest);
  expect(nurturePlanFingerprint(plan, [{ ...item, ownerUserId: "different-owner" }], [first, second])).not.toBe(digest);
  expect(nurturePlanFingerprint(plan, [{ ...item, recipient: "other@example.invalid" }], [first, second])).not.toBe(digest);
  expect(nurturePlanFingerprint(plan, [item], [first, { ...second, body: "Changed after exact review" }])).not.toBe(digest);
  expect(nurturePlanFingerprint({ ...plan, expiresAt: new Date(plan.expiresAt.getTime() + 1) }, [item], [first, second])).not.toBe(digest);
});
