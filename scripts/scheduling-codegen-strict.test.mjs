import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as generated from "../lib/api-zod/src/generated/api";
import { closeSchedulingSchemas } from "./scheduling-codegen-strict.mjs";
import * as typedFixtures from "../artifacts/command-center/src/lib/scheduling-ui-contract.fixtures";

const id = "11111111-1111-4111-8111-111111111111";
const context = {
  organizationId: id,
  policyRevision: 0,
  policyDigest: null,
  companyTimeZone: "America/Los_Angeles",
  inspection: null,
  applicableRules: {
    newTravelGapMinutes: 0,
    companyCeiling: null,
    inspectionCeiling: null,
  },
  source: {
    sourceKind: "unlinked_manual",
    leadId: null,
    contactId: null,
    propertyId: null,
    estimateId: null,
  },
  targetVersion: null,
  targetFingerprint: null,
};
const review = {
  context,
  duration: { kind: "explicit", preset: null },
  startWallTime: null,
  endWallTime: null,
};
const body = {
  operationId: id,
  kind: "appointment_create",
  body: { scheduledStart: "2035-01-01T12:00:00.000Z" },
  review,
};
describe("closed scheduling generation", () => {
  it('closes the native409 envelope and every acknowledgement object',()=>{
    const ack={operationId:id,organizationId:id,actorUserId:'synthetic',kind:'appointment_create',source:context.source,payloadSha256:'a'.repeat(64),outcome:'no_commit_refused',target:null,refusalCode:'original_create_fenced'};
    const value={error:'Original refused',code:'manual_scheduling_refused',schedulingOperation:ack};
    expect(generated.ManualSchedulingErrorSchema.safeParse(value).success).toBe(true);
    for(const invalid of [{...value,extra:true},{...value,schedulingOperation:{...ack,extra:true}},{...value,schedulingOperation:{...ack,source:{...ack.source,extra:true}}}])expect(generated.ManualSchedulingErrorSchema.safeParse(invalid).success).toBe(false);
  });
  it("publishes the exact typed JSON examples accepted by generated schemas", () => {
    const fixtures = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          "../reports/scheduling-consumer-fixtures-2026-10-13.json",
        ),
        "utf8",
      ),
    );
    for (const [name, value] of Object.entries(fixtures))
      expect(value).toEqual(typedFixtures[name]);
    for (const name of [
      "enabledContext",
      "disabledContext",
      "projectContext",
      "legacy101Context",
    ])
      expect(
        generated.GetSchedulingReviewContextResponse.safeParse(fixtures[name])
          .success,
      ).toBe(true);
    for (const name of ["appointmentCommand", "projectCommand"])
      expect(
        generated.ReconcileSchedulingOperationBody.safeParse(fixtures[name])
          .success,
      ).toBe(true);
    for (const name of [
      "newInspectionQuery",
      "projectQuery",
      "editNoninspectionQuery",
    ])
      expect(
        generated.GetSchedulingReviewContextQueryParams.safeParse(
          fixtures[name],
        ).success,
      ).toBe(true);
    expect(
      generated.ReconcileSchedulingOperationResponse.safeParse(
        fixtures.acknowledgement,
      ).success,
    ).toBe(true);
    expect(
      generated.SaveSchedulingPolicyBody.safeParse(fixtures.saveInput).success,
    ).toBe(true);
    expect(fixtures.enabledContext.applicableRules).toEqual({
      newTravelGapMinutes: 60,
      companyCeiling: 3,
      inspectionCeiling: 2,
    });
    expect(fixtures.disabledContext.applicableRules).toEqual({
      newTravelGapMinutes: 0,
      companyCeiling: null,
      inspectionCeiling: 2,
    });
    expect(
      fixtures.projectContext.applicableRules.inspectionCeiling,
    ).toBeNull();
  });
  it("rejects server-owned command body fields and nested review extras", () => {
    const schema = generated.ReconcileSchedulingOperationBody;
    expect(schema.safeParse(body).success).toBe(true);
    expect(
      schema.safeParse({
        ...body,
        kind: "project_create",
        body: { leadId: id, name: "Synthetic job" },
        review: {
          ...review,
          context: {
            ...context,
            source: {
              ...context.source,
              sourceKind: "lead",
              leadId: id,
              contactId: id,
            },
          },
        },
      }).success,
    ).toBe(true);
    for (const forbidden of [
      "schedulingReservation",
      "actorUserId",
      "digest",
      "operationId",
      "review",
    ])
      expect(
        schema.safeParse({ ...body, body: { ...body.body, [forbidden]: id } })
          .success,
      ).toBe(false);
    expect(
      schema.safeParse({
        ...body,
        review: { ...review, context: { ...context, forged: true } },
      }).success,
    ).toBe(false);
  });
  it("validates booking kind, distinct ceilings and closed policy saves", () => {
    expect(
      generated.GetSchedulingReviewContextQueryParams.safeParse({
        sourceKind: "unlinked_manual",
        reservationKind: "project",
        actorUserId: id,
      }).success,
    ).toBe(false);
    const save = {
      expectedRevision: 0,
      expectedCompanyTimeZone: "UTC",
      enabled: true,
      minimumTravelGapMinutes: 60,
      maxConcurrentReservations: 3,
      durationPresets: [],
    };
    expect(generated.SaveSchedulingPolicyBody.safeParse(save).success).toBe(
      true,
    );
    expect(
      generated.SaveSchedulingPolicyBody.safeParse({ ...save, digest: id })
        .success,
    ).toBe(false);
    expect(
      generated.GetSchedulingReviewContextResponse.safeParse({
        ...context,
        applicableRules: { ...context.applicableRules, inspectionCeiling: 101 },
      }).success,
    ).toBe(true);
    expect(
      generated.GetSchedulingReviewContextResponse.safeParse({
        ...context,
        applicableRules: { ...context.applicableRules, companyCeiling: 101 },
      }).success,
    ).toBe(false);
  });
  it("keeps estimate delivery nested DTO strictness", () => {
    const previewSchema = generated.PreviewEstimateDeliveryBody;
    const sendSchema = generated.SendEstimateDeliveryBody;
    const preview = {
      expectedUpdatedAt: "2035-01-01T12:00:00.000Z",
      expectedWorkVersion: null,
    };
    const send = {
      previewId: id,
      payloadSha256: "a".repeat(64),
      confirmed: true,
    };
    for (const [schema, valid] of [
      [previewSchema, preview],
      [sendSchema, send],
    ]) {
      expect(schema.safeParse(valid).success).toBe(true);
      for (const forbidden of [
        { actorUserId: "forged" },
        { recipient: "forged@example.test" },
        { document: { title: "forged" } },
      ]) {
        const result = schema.safeParse({ ...valid, ...forbidden });
        expect(result.success).toBe(false);
        expect(result.error.issues).toEqual([
          {
            code: "unrecognized_keys",
            keys: Object.keys(forbidden),
            path: [],
            message: expect.any(String),
          },
        ]);
      }
    }
    const response = {
      estimateId: id,
      previewId: id,
      payloadSha256: "a".repeat(64),
      expiresAt: "2035-01-01T12:00:00.000Z",
      document: {
        estimateId: id,
        businessName: "Synthetic",
        customerLabel: "Synthetic customer",
        propertyLabel: null,
        title: "Synthetic estimate",
        lineItems: [
          {
            description: "Synthetic work",
            quantity: 1,
            unitPriceCents: 100,
            totalCents: 100,
          },
        ],
        subtotalCents: 100,
        taxCents: 0,
        totalCents: 100,
        notes: null,
      },
      message: {
        recipient: "customer@example.test",
        subject: "Synthetic estimate",
        body: "Synthetic",
      },
      sender: {
        provider: "gmail",
        senderEmail: "staff@example.test",
        source: "company_default",
      },
    };
    expect(
      generated.PreviewEstimateDeliveryResponse.safeParse(response).success,
    ).toBe(true);
    const nested = generated.PreviewEstimateDeliveryResponse.safeParse({
      ...response,
      document: {
        ...response.document,
        lineItems: [
          { ...response.document.lineItems[0], actorUserId: "forged" },
        ],
      },
    });
    expect(nested.success).toBe(false);
    expect(nested.error.issues).toEqual([
      {
        code: "unrecognized_keys",
        keys: ["actorUserId"],
        path: ["document", "lineItems", 0],
        message: expect.any(String),
      },
    ]);
  });
  it("is idempotent and refuses a missing operation before returning changed text", () => {
    const text = readFileSync(
      resolve(import.meta.dirname, "../lib/api-zod/src/generated/api.ts"),
      "utf8",
    );
    expect(closeSchedulingSchemas(text)).toBe(text);
    expect(() =>
      closeSchedulingSchemas(
        text.replace(
          "export const SaveSchedulingPolicyBody =",
          "export const RemovedPolicyBody =",
        ),
      ),
    ).toThrow();
    expect(() =>
      closeSchedulingSchemas(
        text.replace(
          "export const SaveSchedulingPolicyBody = zod.object(",
          "export const SaveSchedulingPolicyBody = zod.record(",
        ),
      ),
    ).toThrow();
  });
});
