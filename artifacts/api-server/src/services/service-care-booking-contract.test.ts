import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import * as policy from "./service-care-policy";
import {
  careCanonicalJson,
  serviceCareBookingSchema,
  serviceCareSchedulingSourceSchema,
  serviceCareSchedulingReadSchema,
  serviceCareBookingOutcomeSchema,
  serviceCareBookingResultSchema,
  type ServiceCareBookingInput,
  type ServiceCareSchedulingRead,
  type ServiceCareBookingOutcome,
  type ServiceCareBookingResult,
} from "./service-care-booking-contract";
const { careFingerprint } = policy;

const original = {
  requestId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
  expectedUpdatedAt: "2037-06-15T12:00:00.123456Z",
  responseId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  assignedUserId: "staff-original",
  scheduledStart: "2037-06-15T14:00:00.123456Z",
  scheduledEnd: "2037-06-15T15:00:00.123456Z",
  type: "other",
  customerConfirmed: true,
};
const originalSha =
  "b0b001506b1074b0d2a326e253df088603b5983e112bb456a7dcc76288714e3a";
const canonicalOriginal =
  '{"assignedUserId":"staff-original","customerConfirmed":true,"expectedUpdatedAt":"2037-06-15T12:00:00.123456Z","requestId":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA","responseId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","scheduledEnd":"2037-06-15T15:00:00.123456Z","scheduledStart":"2037-06-15T14:00:00.123456Z","type":"other"}';
const org = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const source = {
  sourceKind: "direct_customer" as const,
  leadId: null,
  contactId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  propertyId: null,
  estimateId: null,
};
const context = {
  organizationId: org,
  policyRevision: 0,
  policyDigest: null,
  companyTimeZone: "America/Los_Angeles",
  inspection: null,
  applicableRules: {
    newTravelGapMinutes: 0,
    companyCeiling: null,
    inspectionCeiling: null,
  },
  source,
  targetVersion: null,
  targetFingerprint: null,
};
const read = {
  organizationId: org,
  actorUserId: "staff-original",
  obligationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  expectedUpdatedAt: "2037-06-15T12:00:00.123Z",
  appointmentType: "other" as const,
  source,
  review: { state: "ready" as const, policy: null, context },
};
const outcome = {
  formatVersion: 1 as const,
  status: "committed" as const,
  organizationId: org,
  actorUserId: "staff-original",
  obligationId: read.obligationId,
  bookingId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  requestId: original.requestId,
  requestFingerprint: originalSha,
  responseId: original.responseId,
  expectedUpdatedAt: original.expectedUpdatedAt,
  appointmentId: "11111111-1111-4111-8111-111111111111",
};

describe("browser Service Care booking contract", () => {
  it("pins the frozen original server parsed-booking hash before extraction", () => {
    expect(careFingerprint(serviceCareBookingSchema.parse(original))).toBe(
      originalSha,
    );
  });
  it("keeps all existing policy exports pointing to the exact extracted runtime schemas", () => {
    expect(policy.serviceCareBookingSchema).toBe(serviceCareBookingSchema);
    expect(policy.serviceCareSchedulingSourceSchema).toBe(
      serviceCareSchedulingSourceSchema,
    );
    expect(policy.serviceCareSchedulingReadSchema).toBe(
      serviceCareSchedulingReadSchema,
    );
    expect(policy.serviceCareBookingOutcomeSchema).toBe(
      serviceCareBookingOutcomeSchema,
    );
    expect(policy.serviceCareBookingResultSchema).toBe(
      serviceCareBookingResultSchema,
    );
    expect(policy.careCanonicalJson).toBe(careCanonicalJson);
    const input: ServiceCareBookingInput =
      serviceCareBookingSchema.parse(original);
    const scheduling: ServiceCareSchedulingRead =
      serviceCareSchedulingReadSchema.parse(read);
    const proof: ServiceCareBookingOutcome =
      serviceCareBookingOutcomeSchema.parse(outcome);
    const result: ServiceCareBookingResult =
      serviceCareBookingResultSchema.parse({
        appointmentId: proof.appointmentId,
        replayed: true,
        bookingOutcome: proof,
      });
    expect(input.requestId).toBe(original.requestId);
    expect(scheduling.source).toEqual(source);
    expect(result.bookingOutcome.actorUserId).toBe("staff-original");
  });
  it("matches parsed original bytes and frozen source hash using real browser SHA256", async () => {
    const parsed = serviceCareBookingSchema.parse(original);
    expect(careCanonicalJson(parsed)).toBe(canonicalOriginal);
    const digest = await webcrypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(careCanonicalJson(parsed)),
    );
    expect(Buffer.from(digest).toString("hex")).toBe(originalSha);
    expect(careFingerprint(parsed)).toBe(originalSha);
    expect(
      careFingerprint({
        organizationId: org,
        actorUserId: "staff-original",
        input: parsed,
      }),
    ).not.toBe(originalSha);
    expect(
      careFingerprint({ ...parsed, requestId: parsed.requestId.toLowerCase() }),
    ).not.toBe(originalSha);
    expect(
      careFingerprint({
        ...parsed,
        expectedUpdatedAt: "2037-06-15T12:00:00.123Z",
      }),
    ).not.toBe(originalSha);
    expect(parsed).not.toHaveProperty("schedulingReview");
    expect(
      careFingerprint(
        serviceCareBookingSchema.parse({
          ...original,
          schedulingReview: undefined,
        }),
      ),
    ).not.toBe(originalSha);
  });
  it("retains care undefined-entry, Date, null, locale key sorting and array order behavior", () => {
    expect(
      careCanonicalJson({
        z: undefined,
        a: [undefined, null, { z: 2, a: 1 }],
        date: new Date("2037-06-15T12:00:00Z"),
      }),
    ).toBe('{"a":[null,null,{"a":1,"z":2}],"date":{},"z":null}');
    expect(careCanonicalJson({ z: 1, Z: 2, a: 3, A: 4, ä: 5 })).toBe(
      '{"a":3,"A":4,"ä":5,"z":1,"Z":2}',
    );
    expect(
      careCanonicalJson({ present: null, explicitUndefined: undefined }),
    ).toBe('{"explicitUndefined":null,"present":null}');
    expect(careCanonicalJson(undefined)).toBe("null");
    expect(careCanonicalJson(["z", "a"])).toBe('["z","a"]');
    expect(careFingerprint({ a: [2, 1], b: { d: 4, c: 3 } })).toBe(
      createHash("sha256")
        .update('{"a":[2,1],"b":{"c":3,"d":4}}')
        .digest("hex"),
    );
  });
  it("keeps raw source precision and casing while rejecting forged booking fields", () => {
    expect(serviceCareBookingSchema.parse(original)).toEqual(original);
    for (const extra of [
      { organizationId: org },
      { actorUserId: "forged" },
      { schedulingReview: null },
      { customerConfirmed: false },
      { type: "production" },
      { scheduledStart: "2037-06-15T14:00:00+00:00" },
    ]) {
      expect(
        serviceCareBookingSchema.safeParse({ ...original, ...extra }).success,
      ).toBe(false);
    }
    const reviewed = serviceCareBookingSchema.parse({
      ...original,
      schedulingReview: {
        context,
        duration: { kind: "explicit", preset: null },
        startWallTime: null,
        endWallTime: null,
      },
    });
    expect(reviewed.schedulingReview?.context.source).toEqual(source);
    // Captured by executing the unchanged c54122b server serializer/parser.
    const reviewedSha =
      "db69e441aac8ab788e4a5e527f85dec4064aafbd2aa93013a03804ed9135f864";
    expect(careFingerprint(reviewed)).toBe(reviewedSha);
    expect(
      createHash("sha256").update(careCanonicalJson(reviewed)).digest("hex"),
    ).toBe(reviewedSha);
    expect(
      serviceCareBookingSchema.safeParse({
        ...original,
        schedulingReview: {
          ...reviewed.schedulingReview,
          actorUserId: "forged",
        },
      }).success,
    ).toBe(false);
  });
  it("accepts coherent ready and actorless held source reads without inferring provider permission", () => {
    expect(serviceCareSchedulingReadSchema.parse(read)).toEqual(read);
    expect(
      serviceCareSchedulingReadSchema.parse({
        ...read,
        actorUserId: null,
        review: {
          state: "held",
          code: "scheduling_reader_required",
          message: "Accepted staff required",
        },
      }).actorUserId,
    ).toBeNull();
    const configuredPolicy = {
      formatVersion: 1,
      revision: 2,
      enabled: true,
      timeZone: "America/Los_Angeles",
      minimumTravelGapMinutes: 60,
      maxConcurrentReservations: 3,
      durationPresets: [],
      digest: "a".repeat(64),
      updatedAt: read.expectedUpdatedAt,
      updatedByUserId: "staff-original",
    };
    const configured = {
      ...read,
      review: {
        state: "ready",
        policy: configuredPolicy,
        context: {
          ...context,
          policyRevision: 2,
          policyDigest: configuredPolicy.digest,
        },
      },
    };
    expect(serviceCareSchedulingReadSchema.safeParse(configured).success).toBe(
      true,
    );
    expect(
      serviceCareSchedulingReadSchema.safeParse({
        ...configured,
        review: {
          ...configured.review,
          context: { ...configured.review.context, companyTimeZone: "UTC" },
        },
      }).success,
    ).toBe(false);
  });
  it.each([
    ["actorless ready", { ...read, actorUserId: null }],
    [
      "foreign organization",
      { ...read, organizationId: "99999999-9999-4999-8999-999999999999" },
    ],
    [
      "foreign source",
      {
        ...read,
        source: {
          ...source,
          contactId: "99999999-9999-4999-8999-999999999999",
        },
      },
    ],
    [
      "policy binding",
      {
        ...read,
        review: {
          ...read.review,
          context: {
            ...context,
            policyRevision: 1,
            policyDigest: "a".repeat(64),
          },
        },
      },
    ],
    [
      "target binding",
      {
        ...read,
        review: {
          ...read.review,
          context: {
            ...context,
            targetVersion: read.expectedUpdatedAt,
            targetFingerprint: "a".repeat(64),
          },
        },
      },
    ],
    ["selected type", { ...read, appointmentType: "inspection" }],
    ["null source", { ...read, source: null }],
    ["lead source", { ...read, source: { ...source, leadId: org } }],
    ["uppercase core identity", { ...read, organizationId: org.toUpperCase() }],
    ["extra ready grant", { ...read, providerReady: true }],
  ])("rejects the actual parser negative: %s", (_name, value) => {
    expect(serviceCareSchedulingReadSchema.safeParse(value).success).toBe(
      false,
    );
  });
  it("keeps exact committed outcomes and target coherence for both fresh and replay results", () => {
    for (const replayed of [false, true]) {
      const result = {
        appointmentId: outcome.appointmentId,
        replayed,
        bookingOutcome: outcome,
      };
      expect(serviceCareBookingResultSchema.parse(result)).toEqual(result);
      expect(
        serviceCareBookingResultSchema.safeParse({
          ...result,
          appointmentId: org,
        }).success,
      ).toBe(false);
      expect(
        serviceCareBookingResultSchema.safeParse({ ...result, detail: null })
          .success,
      ).toBe(false);
      expect(
        serviceCareBookingResultSchema.safeParse({
          ...result,
          available: false,
        }).success,
      ).toBe(false);
    }
    expect(
      serviceCareBookingOutcomeSchema.parse(outcome).expectedUpdatedAt,
    ).toBe(original.expectedUpdatedAt);
    for (const extra of [
      { actorUserId: null },
      { status: "refused" },
      { requestFingerprint: "BAD" },
      { available: false },
      { expectedUpdatedAt: "bad" },
    ]) {
      expect(
        serviceCareBookingOutcomeSchema.safeParse({ ...outcome, ...extra })
          .success,
      ).toBe(false);
    }
  });
  it("bundles its runtime schemas and canonical value for the browser without server imports", async () => {
    const result = await build({
      entryPoints: [
        fileURLToPath(
          new URL("./service-care-booking-contract.ts", import.meta.url),
        ),
      ],
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "CareContract",
      write: false,
      metafile: true,
    });
    expect(result.errors).toEqual([]);
    expect(
      Object.keys(result.metafile!.inputs).some((path) =>
        /service-care-policy|lib\/db|node:/.test(path),
      ),
    ).toBe(false);
    const browser = runInNewContext(
      `${result.outputFiles[0]!.text}; CareContract`,
      {},
    );
    expect(
      browser.careCanonicalJson(
        browser.serviceCareBookingSchema.parse(original),
      ),
    ).toBe(canonicalOriginal);
    expect(browser.serviceCareSchedulingReadSchema.parse(read)).toEqual(read);
    expect(
      browser.serviceCareSchedulingReadSchema.safeParse({
        ...read,
        actorUserId: null,
      }).success,
    ).toBe(false);
    expect(browser.serviceCareBookingOutcomeSchema.parse(outcome)).toEqual(
      outcome,
    );
    expect(
      browser.serviceCareBookingResultSchema.parse({
        appointmentId: outcome.appointmentId,
        replayed: true,
        bookingOutcome: outcome,
      }).bookingOutcome.actorUserId,
    ).toBe("staff-original");
  });
});
