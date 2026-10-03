import { expect, it } from "vitest";
import { ApproveSourceNurtureResponse, GetSourceNurtureResponse, ListSourceNurtureResponse, PreviewSourceNurtureBody, PreviewSourceNurtureResponse, StartSourceNurtureResponse, StopSourceNurtureResponse } from "../../../../lib/api-zod/src/generated/api";
import { nurtureFixture, nurtureId, nurtureListFixture } from "./source-nurture-fixtures";
import { nurtureCommandSchema, nurtureDraftSchema, nurtureListSchema, parseNurtureDetail } from "./source-nurture-types";

// API generated validators coerce dates. Round-trip the actual JSON boundary,
// rather than comparing source-code strings or pretending dates stay strings.
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
it("parses the same complete GET/preview/list response fixtures through generated HTTP and browser contracts", () => {
  const detail = nurtureFixture(), list = nurtureListFixture(detail);
  expect(parseNurtureDetail(wire(GetSourceNurtureResponse.parse(detail)), detail.organizationId, detail.id)).toEqual(detail);
  expect(parseNurtureDetail(wire(PreviewSourceNurtureResponse.parse(detail)), detail.organizationId)).toEqual(detail);
  expect(nurtureListSchema.parse(wire(ListSourceNurtureResponse.parse(list)))).toEqual(list);
});
it.each(["approve", "start", "stop"] as const)("parses a concrete %s receipt through the generated HTTP contract and strict browser contract", action => {
  const detail = nurtureFixture({ version: 2, state: action === "approve" ? "approved" : action === "start" ? "running" : "stopped" });
  const result = { detail, command: { action, requestId: action === "approve" ? null : nurtureId(40), replayed: false, appliedVersion: 2 } };
  const schema = ({ approve: ApproveSourceNurtureResponse, start: StartSourceNurtureResponse, stop: StopSourceNurtureResponse })[action];
  expect(nurtureCommandSchema.parse(wire(schema.parse(result)))).toEqual(result);
});
it("validates the exact finite draft and rejects eleven recipients, duplicate addresses, missing sync and duplicate step identities", () => {
  const detail = nurtureFixture();
  const draft = { ...detail.settings, leadIds: [detail.items[0].leadId], startNotBefore: detail.startNotBefore, expiresAt: detail.expiresAt };
  expect(nurtureDraftSchema.parse(wire(PreviewSourceNurtureBody.parse(draft)))).toEqual(draft);
  expect(nurtureDraftSchema.safeParse({ ...draft, leadIds: Array.from({ length: 11 }, (_, index) => nurtureId(50 + index)) }).success).toBe(false);
  expect(nurtureDraftSchema.safeParse({ ...draft, leadIds: [detail.items[0].leadId, detail.items[0].leadId] }).success).toBe(false);
  expect(() => parseNurtureDetail({ ...detail, items: [{ ...detail.items[0], mailboxSync: undefined }] }, detail.organizationId)).toThrow();
  const item = structuredClone(detail.items[0]); item.steps[1].id = item.steps[0].id;
  expect(() => parseNurtureDetail({ ...detail, items: [item] }, detail.organizationId)).toThrow();
  const duplicate = structuredClone(detail.items[0]); duplicate.id = nurtureId(70); duplicate.leadId = nurtureId(71); duplicate.snapshot.adoption.leadId = duplicate.leadId;
  expect(() => parseNurtureDetail({ ...detail, items: [detail.items[0], duplicate] }, detail.organizationId)).toThrow();
});
