import { test, expect, vi } from "vitest";
import {
  prepareOperatorPlan,
  operatorPlanDigest,
} from "./production75-custody.mjs";
import {
  authenticateAttestation,
  attestationEntropy,
} from "./production75-live-admission.mjs";
const plan = prepareOperatorPlan({
  runId: "11111111-1111-4111-8111-111111111111",
  backupId: "backup",
  sourceSnapshotSha256: "a".repeat(64),
  profileSha256: "b".repeat(64),
  moduleManifestSha256: "c".repeat(64),
  preparedAt: 1000,
  workMs: 10000,
  cleanupMs: 10000,
  maxCostUsdMicros: 150000,
});
const bindings = {
  pricingSha256: "e".repeat(64),
  protectedAppsSha256: "f".repeat(64),
};
const body = (kind) => ({
  version: 1,
  ...bindings,
  kind,
  planSha256: operatorPlanDigest(plan),
  issuedAt: 1000,
  expiresAt: plan.cleanupUntil,
  sourceSnapshotSha256: plan.sourceSnapshotSha256,
  profileSha256: plan.profileSha256,
  moduleManifestSha256: plan.moduleManifestSha256,
  maxCostUsdMicros: plan.maxCostUsdMicros,
  maxCopies: 1,
  sourceWritesAuthorized: false,
  provenance: {
    type:
      kind === "owner-approval"
        ? "direct-human-priced-approval"
        : "independent-capability-review",
    evidenceSha256: "d".repeat(64),
    reference: "trusted-local-evidence",
  },
});
const unprotectFor = (v) => vi.fn(async () => Buffer.from(JSON.stringify(v)));
test.each(["owner-approval", "independent-capability-review"])(
  "protected exact %s binds every plan limit and provenance",
  async (kind) => {
    const unprotect = unprotectFor(body(kind));
    const r = await authenticateAttestation({
      unprotect,
      blob: Buffer.alloc(80, 1),
      plan,
      bindings,
      kind,
      now: () => 1100,
    });
    expect(r).toMatchObject({
      authenticated: true,
      kind,
      planSha256: operatorPlanDigest(plan),
    });
    expect(unprotect.mock.calls[0][1]).toEqual(attestationEntropy(plan, kind));
    expect(r.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
  },
);
test("plaintext approval is refused before unprotect", async () => {
  const unprotect = unprotectFor(body("owner-approval"));
  await expect(
    authenticateAttestation({
      unprotect,
      blob: body("owner-approval"),
      plan,
      bindings,
      kind: "owner-approval",
      now: () => 1100,
    }),
  ).rejects.toThrow("production75_live_admission");
  expect(unprotect).not.toHaveBeenCalled();
});
test.each([
  "kind",
  "plan",
  "source",
  "module",
  "profile",
  "cost",
  "copies",
  "provenance",
  "expired",
  "future",
  "pricing",
  "apps",
])("refuses protected %s drift", async (field) => {
  const v = body("owner-approval");
  if (field === "kind") v.kind = "independent-capability-review";
  if (field === "plan") v.planSha256 = "e".repeat(64);
  if (field === "source") v.sourceSnapshotSha256 = "e".repeat(64);
  if (field === "module") v.moduleManifestSha256 = "e".repeat(64);
  if (field === "profile") v.profileSha256 = "e".repeat(64);
  if (field === "cost") v.maxCostUsdMicros++;
  if (field === "copies") v.maxCopies = 2;
  if (field === "provenance") v.provenance.type = "json-claim";
  if (field === "expired") v.expiresAt = 1099;
  if (field === "pricing") v.pricingSha256 = "a".repeat(64);
  if (field === "apps") v.protectedAppsSha256 = "a".repeat(64);
  if (field === "future") v.issuedAt = 1101;
  await expect(
    authenticateAttestation({
      unprotect: unprotectFor(v),
      blob: Buffer.alloc(80, 1),
      plan,
      bindings,
      kind: "owner-approval",
      now: () => 1100,
    }),
  ).rejects.toThrow("production75_live_admission");
});
test("unprotect errors never preserve private message or cause", async () => {
  await expect(
    authenticateAttestation({
      unprotect: async () => {
        throw new Error("private fixture");
      },
      blob: Buffer.alloc(80, 1),
      plan,
      bindings,
      kind: "owner-approval",
      now: () => 1100,
    }),
  ).rejects.toThrow("production75_live_admission");
});
