import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as generated from "../lib/api-zod/src/generated/api";
import { closeSchedulingSchemas } from "./scheduling-codegen-strict.mjs";
import { projectSchedulingSourceSpec } from "./scheduling-source-api-spec.mjs";
import {
  createCustomerWorkProjectSchema,
  updateCustomerWorkProjectSchema,
  customerWorkProjectUnavailableSchema,
} from "../artifacts/api-server/src/services/returning-customer-contract";
import {
  serviceCareBookingSchema,
  serviceCareBookingResultSchema,
  serviceCareSchedulingReadSchema,
  careFingerprint,
} from "../artifacts/api-server/src/services/service-care-policy";
import {
  callieBookingSchema,
  callieSchedulingContextReadSchema,
  canonicalCallieBookingInput,
} from "../artifacts/api-server/src/services/callie-office-contract";
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
  it("preserves original service booking wire timestamp precision and optional review", () => {
    const source = {
      requestId: "ABCDEF12-1111-4111-8111-111111111111",
      expectedUpdatedAt: "2035-01-01T00:00:00.123456Z",
      responseId: id,
      assignedUserId: "synthetic",
      scheduledStart: "2035-01-02T09:00:00Z",
      scheduledEnd: "2035-01-02T10:00:00.000Z",
      type: "other",
      customerConfirmed: true,
    };
    expect(generated.BookServiceCareVisitBody.parse(source)).toEqual(source);
    expect(
      generated.BookServiceCareVisitBody.safeParse({
        ...source,
        schedulingReview: null,
      }).success,
    ).toBe(false);
  });
  it.each([
    ["/v1/appointments", "Appointment"],
    ["/v1/projects", "Project"],
  ])(
    "declares original replay and fresh creation with the same native DTO for %s",
    (path, name) => {
      // Use the generator's existing YAML parser, as the other contract scripts do.
      const specRequire = createRequire(
        new URL("../lib/api-spec/package.json", import.meta.url),
      );
      const { parse } = createRequire(specRequire.resolve("orval"))("yaml");
      const spec = parse(
        readFileSync(
          resolve(import.meta.dirname, "../lib/api-spec/openapi.yaml"),
          "utf8",
        ),
      );
      const responses = spec.paths[path].post.responses;
      expect(responses["200"]).toBeDefined();
      expect(responses["200"].description).toMatch(
        /replay.*original.*available/i,
      );
      const native = { $ref: `#/components/schemas/${name}` };
      expect(responses["200"].content["application/json"].schema).toEqual(
        native,
      );
      expect(responses["201"].content["application/json"].schema).toEqual(
        native,
      );
      expect(
        spec.components.schemas[name].properties.schedulingOperation,
      ).toEqual({ $ref: "#/components/schemas/ManualSchedulingAck" });
      expect(
        responses["409"].content["application/json"].schema.anyOf,
      ).toContainEqual({ $ref: "#/components/schemas/ManualSchedulingError" });
    },
  );
  it("closes the native409 envelope and every acknowledgement object", () => {
    const ack = {
      operationId: id,
      organizationId: id,
      actorUserId: "synthetic",
      kind: "appointment_create",
      source: context.source,
      payloadSha256: "a".repeat(64),
      outcome: "no_commit_refused",
      target: null,
      refusalCode: "original_create_fenced",
    };
    const value = {
      error: "Original refused",
      code: "manual_scheduling_refused",
      schedulingOperation: ack,
    };
    expect(generated.ManualSchedulingErrorSchema.safeParse(value).success).toBe(
      true,
    );
    for (const invalid of [
      { ...value, extra: true },
      { ...value, schedulingOperation: { ...ack, extra: true } },
      {
        ...value,
        schedulingOperation: { ...ack, source: { ...ack.source, extra: true } },
      },
    ])
      expect(
        generated.ManualSchedulingErrorSchema.safeParse(invalid).success,
      ).toBe(false);
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

const upperId = "ABCDEF12-1111-4111-8111-111111111111";
const aSample = {
  requestId: upperId,
  confirmed: true,
  source: { kind: "existing_customer", contactId: id, propertyId: null },
  name: "  Synthetic job  ",
  status: "scheduled",
  scheduledStart: "2035-01-01T10:00:00.123456Z",
  scheduledEnd: "2035-01-01T11:00:00Z",
  crewUserIds: [" tech-b ", "tech-a"],
  crewNotes: null,
};
const bSample = {
  requestId: upperId,
  expectedUpdatedAt: "2035-01-01T00:00:00.123456Z",
  responseId: id,
  assignedUserId: "synthetic",
  scheduledStart: "2035-01-02T09:00:00Z",
  scheduledEnd: "2035-01-02T10:00:00.000Z",
  type: "other",
  customerConfirmed: true,
};
const cSample = {
  requestId: upperId,
  expectedVersion: 1,
  expectedFingerprint: "a".repeat(64),
  contactId: id,
  leadId: null,
  propertyId: null,
  assignedUserId: "synthetic",
  type: "other",
  scheduledStart: "2035-01-02T09:00:00Z",
  scheduledEnd: "2035-01-02T10:00:00.123456Z",
  confirmationNote: "  Synthetic exact customer confirmation.  ",
  customerConfirmed: true,
};
// A's source canonicalization is independently exercised against its actual
// crypto helper in the PG writer test; for JSON-safe parsed input its ordering
// equals the original B canonical function (no undefined or Date values).
const hashC = (value) =>
  createHash("sha256").update(canonicalCallieBookingInput(value)).digest("hex");
const sourceCases = [
  {
    name: "returning create",
    actual: createCustomerWorkProjectSchema,
    generated: generated.CreateCustomerWorkProjectBody,
    sample: aSample,
    hash: careFingerprint,
  },
  {
    name: "returning update",
    actual: updateCustomerWorkProjectSchema,
    generated: generated.UpdateCustomerWorkProjectBody,
    sample: (({ source, ...rest }) => ({ ...rest, expectedWorkVersion: 1 }))(
      aSample,
    ),
    hash: careFingerprint,
  },
  {
    name: "service care",
    actual: serviceCareBookingSchema,
    generated: generated.BookServiceCareVisitBody,
    sample: bSample,
    hash: careFingerprint,
  },
  {
    name: "CALLIE",
    actual: callieBookingSchema,
    generated: generated.BookCallieVisitBody,
    sample: cSample,
    hash: hashC,
  },
];
describe("accepted source contract closure and wire custody", () => {
  it.each(sourceCases)(
    "preserves original parsed $name hash, raw ISO, UUID casing, arrays and omission",
    ({ actual, generated: schema, sample, hash }) => {
      const parsed = actual.parse(sample),
        wire = JSON.parse(JSON.stringify(schema.parse(parsed)));
      expect(wire).toEqual(parsed);
      expect(wire.requestId).toBe(upperId);
      expect("schedulingReview" in wire).toBe(false);
      expect(hash(actual.parse(wire))).toBe(hash(parsed));
      expect(
        schema.safeParse({ ...parsed, schedulingReview: null }).success,
      ).toBe(false);
      expect(schema.safeParse({ ...parsed, unrecognized: true }).success).toBe(
        false,
      );
      for (const bad of [
        "2035-02-30T09:00:00Z",
        "2035-01-02",
        "not-a-date",
        "2035-01-02T25:00:00Z",
      ])
        expect(
          schema.safeParse({ ...parsed, scheduledStart: bad }).success,
        ).toBe(false);
      const withReview = { ...parsed, schedulingReview: review };
      expect(schema.safeParse(withReview).success).toBe(true);
      for (const schedulingReview of [
        { ...review, extra: true },
        { ...review, context: { ...context, extra: true } },
        {
          ...review,
          context: { ...context, source: { ...context.source, extra: true } },
        },
        { ...review, duration: { ...review.duration, extra: true } },
      ])
        expect(schema.safeParse({ ...parsed, schedulingReview }).success).toBe(
          false,
        );
    },
  );
  it("validates closed ready/held source reviews while retaining source cross-field validators", () => {
    const source = {
        sourceKind: "direct_customer",
        leadId: null,
        contactId: id,
        propertyId: null,
        estimateId: null,
      },
      sourceContext = { ...context, source };
    const b = {
      organizationId: id,
      actorUserId: "synthetic",
      obligationId: id,
      expectedUpdatedAt: "2035-01-01T00:00:00.000Z",
      appointmentType: "other",
      source,
      review: { state: "ready", policy: null, context: sourceContext },
    };
    const c = {
      organizationId: id,
      actorUserId: "synthetic",
      intakeId: id,
      expectedVersion: 1,
      expectedFingerprint: "a".repeat(64),
      appointmentType: "other",
      source,
      review: b.review,
    };
    const bSchema = generated.GetServiceCareResponse.shape.scheduling,
      cSchema = generated.GetCallieSchedulingContextResponse;
    for (const [schema, actual, ready] of [
      [bSchema, serviceCareSchedulingReadSchema, b],
      [cSchema, callieSchedulingContextReadSchema, c],
    ]) {
      expect(
        actual.safeParse(JSON.parse(JSON.stringify(schema.parse(ready))))
          .success,
      ).toBe(true);
      expect(
        schema.safeParse({ ...ready, source: { ...source, forged: true } })
          .success,
      ).toBe(false);
      expect(
        schema.safeParse({
          ...ready,
          review: {
            ...ready.review,
            context: {
              ...sourceContext,
              applicableRules: {
                ...sourceContext.applicableRules,
                forged: true,
              },
            },
          },
        }).success,
      ).toBe(false);
      // JSON Schema does not encode accepted cross-field superRefine authority.
      expect(
        actual.safeParse({
          ...ready,
          review: {
            ...ready.review,
            context: { ...sourceContext, organizationId: upperId },
          },
        }).success,
      ).toBe(false);
    }
    expect(
      bSchema.safeParse({
        ...b,
        actorUserId: null,
        review: {
          state: "held",
          code: "scheduling_reader_required",
          message: "Review required",
        },
      }).success,
    ).toBe(true);
    expect(
      cSchema.safeParse({
        ...c,
        source: null,
        review: {
          state: "held",
          code: "caller_review_required",
          message: "Review required",
        },
      }).success,
    ).toBe(true);
    expect(
      generated.GetCallieSchedulingContextQueryParams.safeParse({
        appointmentType: "other",
        sourceKind: "lead",
      }).success,
    ).toBe(false);
  });
  it("keeps booking results separate from reminder and office-action responses and closes committed proof", () => {
    const common = {
      formatVersion: 1,
      status: "committed",
      organizationId: id,
      actorUserId: "synthetic",
      bookingId: id,
      requestId: upperId,
      requestFingerprint: careFingerprint(bSample),
      appointmentId: id,
    };
    const b = {
      appointmentId: id,
      replayed: true,
      bookingOutcome: {
        ...common,
        obligationId: id,
        responseId: id,
        expectedUpdatedAt: bSample.expectedUpdatedAt,
      },
    };
    expect(generated.BookServiceCareVisitResponse.parse(b)).toEqual(b);
    expect(serviceCareBookingResultSchema.safeParse(b).success).toBe(true);
    expect(
      generated.BookServiceCareVisitResponse.safeParse({
        approvalId: id,
        replayed: true,
      }).success,
    ).toBe(false);
    expect(
      generated.BookServiceCareVisitResponse.safeParse({
        ...b,
        bookingOutcome: { ...b.bookingOutcome, extra: true },
      }).success,
    ).toBe(false);
    const c = {
      detail: null,
      replayed: true,
      bookingOutcome: {
        ...common,
        intakeId: id,
        expectedVersion: 1,
        expectedFingerprint: "a".repeat(64),
        customerConfirmed: true,
      },
    };
    expect(generated.BookCallieVisitResponse.parse(c)).toEqual(c);
    expect(
      generated.BookCallieVisitResponse.safeParse({
        detail: null,
        replayed: true,
      }).success,
    ).toBe(false);
    expect(
      generated.BookCallieVisitResponse.safeParse({
        ...c,
        bookingOutcome: { ...c.bookingOutcome, extra: true },
      }).success,
    ).toBe(false);
    const unavailable = {
      error: "Current display unavailable",
      code: "customer_work_result_unavailable",
      commandOutcome: {
        formatVersion: 1,
        organizationId: id,
        actorUserId: "synthetic",
        requestId: upperId,
        action: "project_created",
        payloadSha256: "a".repeat(64),
        customerWorkId: id,
        target: { kind: "project", id, available: false },
        resultWorkVersion: 1,
        outcome: "committed",
      },
    };
    expect(
      generated.CustomerWorkProjectUnavailableSchema.parse(unavailable),
    ).toEqual(unavailable);
    expect(
      customerWorkProjectUnavailableSchema.safeParse(unavailable).success,
    ).toBe(true);
    for (const invalid of [
      { ...unavailable, extra: true },
      {
        ...unavailable,
        commandOutcome: { ...unavailable.commandOutcome, extra: true },
      },
      {
        ...unavailable,
        commandOutcome: {
          ...unavailable.commandOutcome,
          target: { ...unavailable.commandOutcome.target, extra: true },
        },
      },
      {
        ...unavailable,
        commandOutcome: {
          ...unavailable.commandOutcome,
          target: { ...unavailable.commandOutcome.target, available: true },
        },
      },
    ])
      expect(
        generated.CustomerWorkProjectUnavailableSchema.safeParse(invalid)
          .success,
      ).toBe(false);
  });
  it("is canonical-LF byte-idempotent and fails closed on missing/duplicated source correction anchors", () => {
    const spec = readFileSync(
        resolve(import.meta.dirname, "../lib/api-spec/openapi.yaml"),
        "utf8",
      ).replace(/\r\n/g, "\n"),
      text = readFileSync(
        resolve(import.meta.dirname, "../lib/api-zod/src/generated/api.ts"),
        "utf8",
      );
    expect(projectSchedulingSourceSpec(spec)).toBe(spec);
    expect(() =>
      projectSchedulingSourceSpec(
        spec.replace(
          '"operationId":"bookCallieVisit"',
          '"operationId":"removedCallieVisit"',
        ),
      ),
    ).toThrow();
    for (const name of [
      "BookServiceCareVisitBody",
      "GetCallieSchedulingContextResponse",
      "CreateCustomerWorkProjectResponse",
    ])
      expect(() =>
        closeSchedulingSchemas(
          text.replace(
            `export const ${name} =`,
            `export const Removed${name} =`,
          ),
        ),
      ).toThrow();
    expect(() =>
      closeSchedulingSchemas(
        text +
          "\nexport const GetServiceCareResponse = zod.object({scheduling:zod.object({})});",
      ),
    ).toThrow();
  });
});

describe("source projection required component anchors", () => {
  const spec = readFileSync(
    resolve(import.meta.dirname, "../lib/api-spec/openapi.yaml"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  it.each(["LF", "CRLF"])(
    "projects %s approved-spec input to exact canonical-LF bytes and remains byte-idempotent",
    (ending) => {
      const input = ending === "CRLF" ? spec.replace(/\n/g, "\r\n") : spec;
      expect(input.includes("\r\n")).toBe(ending === "CRLF");
      const projected = projectSchedulingSourceSpec(input);
      expect(projected).toBe(spec);
      expect(projected.includes("\r\n")).toBe(false);
      expect(projectSchedulingSourceSpec(projected)).toBe(spec);
    },
  );
  const required = [
    "CreateCustomerWorkProject",
    "UpdateCustomerWorkProject",
    "CustomerWorkProject",
    "CustomerWorkProjectMutation",
    "BookServiceCareVisit",
    "CallieBookingRequest",
    "ServiceCareReview",
  ];
  const added = [
    "CustomerWorkProjectOutcome",
    "CustomerWorkProjectUnavailable",
    "ServiceCareSchedulingSource",
    "ServiceCareSchedulingRead",
    "ServiceCareBookingOutcome",
    "ServiceCareBookingResult",
    "CallieSchedulingContextQuery",
    "CallieSchedulingContextRead",
    "CallieBookingOutcome",
    "CallieBookingResult",
  ];
  function changed(name, transform) {
    return spec.replace(
      new RegExp(`^    ${name}: (.+)$`, "m"),
      (_line, json) => {
        const value = transform(JSON.parse(json));
        return value === undefined
          ? ""
          : `    ${name}: ${JSON.stringify(value)}`;
      },
    );
  }
  it.each(required)(
    "rejects missing required existing %s before projection",
    (name) => {
      expect(() =>
        projectSchedulingSourceSpec(changed(name, () => undefined)),
      ).toThrow();
    },
  );
  it.each([...required, ...added])(
    "rejects altered existing %s instead of repairing authority",
    (name) => {
      expect(() =>
        projectSchedulingSourceSpec(changed(name, () => ({ type: "string" }))),
      ).toThrow();
      expect(() =>
        projectSchedulingSourceSpec(
          changed(name, (value) => ({ ...value, additionalProperties: value.additionalProperties !== true })),
        ),
      ).toThrow();
    },
  );
  it.each(added)(
    "allows an absent newly authorized %s, and only its authoritative shape when present",
    (name) => {
      expect(
        projectSchedulingSourceSpec(changed(name, () => undefined)),
      ).toContain(`    ${name}: `);
      expect(projectSchedulingSourceSpec(spec)).toBe(spec);
    },
  );
  it("rejects altered historical service-care members alongside the new review", () => {
    expect(() =>
      projectSchedulingSourceSpec(
        changed("ServiceCareReview", (value) => ({
          ...value,
          properties: { ...value.properties, booking: { type: "string" } },
        })),
      ),
    ).toThrow();
  });
});
