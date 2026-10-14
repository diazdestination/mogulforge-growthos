import { describe, expect, it } from "vitest";
import * as contract from "./returning-customer-contract";
import { customerWorkHash } from "./customer-work-lineage";
import { createHash, webcrypto } from "node:crypto";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const original = {
  requestId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
  confirmed: true,
  source: {
    kind: "existing_customer",
    contactId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    propertyId: null,
  },
  name: "  Original work  ",
  status: "scheduled",
  scheduledStart: "2037-06-15T14:00:00.123456Z",
  scheduledEnd: "2037-06-15T15:00:00.123456Z",
  crewUserIds: [" staff-z ", "staff-a"],
  crewNotes: null,
};
const canonicalOriginal =
  '{"action":"project_created","actorUserId":"staff-original","input":{"confirmed":true,"crewNotes":null,"crewUserIds":["staff-z","staff-a"],"name":"Original work","requestId":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA","scheduledEnd":"2037-06-15T15:00:00.123456Z","scheduledStart":"2037-06-15T14:00:00.123456Z","source":{"contactId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","kind":"existing_customer","propertyId":null},"status":"scheduled"},"targetId":null}';
const originalSha =
  "275aeab014f53c83a8f6c7258b8ceba6d516f32f3009df671819a277db04813a";
const envelope = () => ({
  action: "project_created",
  targetId: null,
  input: contract.createCustomerWorkProjectSchema.parse(original),
  actorUserId: "staff-original",
});
const canonical = (value: unknown): string => {
  const fn = (
    contract as unknown as {
      canonicalCustomerWorkValue: (value: unknown) => string;
    }
  ).canonicalCustomerWorkValue;
  return fn(value);
};

describe("browser customer-work command canonicalization", () => {
  it("exports the existing server canonical value as a pure browser API", () => {
    expect(contract).toHaveProperty(
      "canonicalCustomerWorkValue",
      expect.any(Function),
    );
  });
  it("pins the frozen original server project envelope hash before extraction", () => {
    expect(customerWorkHash(envelope())).toBe(originalSha);
    expect(createHash("sha256").update(canonicalOriginal).digest("hex")).toBe(
      originalSha,
    );
  });
  it("hashes the parsed original envelope byte-for-byte through real browser SHA256", async () => {
    const value = envelope();
    expect(canonical(value)).toBe(canonicalOriginal);
    const digest = await webcrypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical(value)),
    );
    expect(Buffer.from(digest).toString("hex")).toBe(originalSha);
    expect(customerWorkHash(value)).toBe(originalSha);
    expect(
      customerWorkHash({ ...value, actorUserId: "another-reader" }),
    ).not.toBe(originalSha);
    expect(
      customerWorkHash({ ...value, targetId: original.source.contactId }),
    ).not.toBe(originalSha);
    expect(customerWorkHash(value.input)).not.toBe(originalSha);
    expect(customerWorkHash({ ...value, input: original })).not.toBe(
      originalSha,
    );
    expect(
      customerWorkHash({
        ...value,
        input: contract.createCustomerWorkProjectSchema.parse({
          ...original,
          schedulingReview: undefined,
        }),
      }),
    ).toBe(originalSha);
    expect(
      customerWorkHash({
        ...value,
        input: { ...value.input, requestId: original.requestId.toLowerCase() },
      }),
    ).not.toBe(originalSha);
  });
  it("retains the server Date and undefined semantics, locale key sorting and array order", () => {
    const value = {
      z: undefined,
      a: [undefined, null, { z: 2, a: 1 }],
      date: new Date("2037-06-15T12:00:00Z"),
    };
    expect(canonical(value)).toBe(
      '{"a":[null,null,{"a":1,"z":2}],"date":"2037-06-15T12:00:00.000Z"}',
    );
    expect(canonical({ z: 1, Z: 2, a: 3, A: 4, ä: 5 })).toBe(
      '{"a":3,"A":4,"ä":5,"z":1,"Z":2}',
    );
    expect(canonical({ present: null, omitted: undefined })).toBe(
      '{"present":null}',
    );
    expect(canonical(undefined)).toBe("null");
    expect(canonical(["z", "a"])).toBe('["z","a"]');
    expect(customerWorkHash(value)).toBe(
      createHash("sha256").update(canonical(value)).digest("hex"),
    );
  });
  it("keeps actual source parsers strict and raw rather than converting to core instants", () => {
    const parsed = contract.createCustomerWorkProjectSchema.parse(original);
    expect(parsed.requestId).toBe(original.requestId);
    expect(parsed.scheduledStart).toBe(original.scheduledStart);
    expect(parsed).not.toHaveProperty("schedulingReview");
    expect(
      contract.createCustomerWorkProjectSchema.safeParse({
        ...original,
        schedulingReview: null,
      }).success,
    ).toBe(false);
    expect(
      contract.createCustomerWorkProjectSchema.safeParse({
        ...original,
        actorUserId: "forged",
      }).success,
    ).toBe(false);
    expect(
      contract.createCustomerWorkProjectSchema.safeParse({
        ...original,
        crewUserIds: ["staff", " staff "],
      }).success,
    ).toBe(false);
    expect(
      contract.createCustomerWorkProjectSchema.safeParse({
        ...original,
        scheduledStart: "2037-06-15T14:00:00+00:00",
      }).success,
    ).toBe(false);
    const { source: _source, ...fields } = original;
    const update = contract.updateCustomerWorkProjectSchema.parse({
      ...fields,
      expectedWorkVersion: 7,
    });
    expect(update.expectedWorkVersion).toBe(7);
    expect(update).not.toHaveProperty("expectedTargetFingerprint");
    const updateEnvelope = {
      action: "project_updated",
      targetId: "11111111-1111-4111-8111-111111111111",
      input: update,
      actorUserId: "staff-original",
    };
    // Captured by executing the unchanged c54122b server serializer/parser.
    const updateSha =
      "05154739273b9ef2662ea667aa521fb0839021265c73f31058ff630ba21db5c6";
    expect(customerWorkHash(updateEnvelope)).toBe(updateSha);
    expect(
      createHash("sha256").update(canonical(updateEnvelope)).digest("hex"),
    ).toBe(updateSha);
    expect(
      contract.updateCustomerWorkProjectSchema.safeParse({
        ...fields,
        expectedWorkVersion: 0,
      }).success,
    ).toBe(false);
  });
  it("preserves the frozen original reviewed-project hash without adding actor or company fields", () => {
    const schedulingReview = {
      context: {
        organizationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
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
          sourceKind: "direct_customer",
          leadId: null,
          contactId: original.source.contactId,
          propertyId: null,
          estimateId: null,
        },
        targetVersion: null,
        targetFingerprint: null,
      },
      duration: { kind: "explicit", preset: null },
      startWallTime: null,
      endWallTime: null,
    };
    const input = contract.createCustomerWorkProjectSchema.parse({
      ...original,
      schedulingReview,
    });
    const value = { ...envelope(), input };
    // Captured by executing the unchanged c54122b server serializer/parser.
    const reviewedSha =
      "6ac41e2efa32859d446992286d6fbec869f963a9331daf013a3670d6aba276ab";
    expect(customerWorkHash(value)).toBe(reviewedSha);
    expect(createHash("sha256").update(canonical(value)).digest("hex")).toBe(
      reviewedSha,
    );
  });
  it("executes the actual canonical source API in a browser bundle without Node or DB globals", async () => {
    const result = await build({
      entryPoints: [
        fileURLToPath(
          new URL("./returning-customer-contract.ts", import.meta.url),
        ),
      ],
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "ReturningContract",
      write: false,
      metafile: true,
    });
    expect(
      Object.keys(result.metafile!.inputs).some((path) =>
        /customer-work-lineage|lib\/db|node:/.test(path),
      ),
    ).toBe(false);
    const browser = runInNewContext(
      `${result.outputFiles[0]!.text}; ReturningContract`,
      {},
    );
    const parsed = browser.createCustomerWorkProjectSchema.parse(original);
    expect(
      browser.canonicalCustomerWorkValue({
        action: "project_created",
        targetId: null,
        input: parsed,
        actorUserId: "staff-original",
      }),
    ).toBe(canonicalOriginal);
  });
});
