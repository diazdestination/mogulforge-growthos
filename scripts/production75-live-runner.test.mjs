import { test, expect, vi } from "vitest";
import {
  prepareOperatorPlan,
  operatorPlanDigest,
} from "./production75-custody.mjs";
import {
  main,
  executeLivePacket,
  prepareLivePacket,
  validateLiveOracle,
  validateLivePricing,
  createGuardedLiveApi,
} from "./production75-live-runner.mjs";
import {
  production75RuntimeHashes,
  PRODUCTION75_RUNTIME_FILES,
} from "./production75-live-manifest.mjs";
const plan = prepareOperatorPlan({
  runId: "11111111-1111-4111-8111-111111111111",
  backupId: "backup",
  sourceSnapshotSha256: "a".repeat(64),
  profileSha256: "b".repeat(64),
  moduleManifestSha256: "c".repeat(64),
  preparedAt: Date.now(),
  workMs: 10000,
  cleanupMs: 10000,
  maxCostUsdMicros: 150000,
});
test.each([[], ["execute"], ["prepare", "extra"], ["--run-live"]])(
  "CLI refuses incomplete or implicit command %s before creating dependencies",
  async (args) => {
    const factory = vi.fn();
    await expect(main(args, { factory })).rejects.toThrow(
      "production75_live_action",
    );
    expect(factory).not.toHaveBeenCalled();
  },
);
test("execute needs protected paid admission and verified pricing before provider access", async () => {
  const transport = { verifyIdentity: vi.fn() },
    deps = { transport };
  await expect(
    executeLivePacket(deps, { plan, planSha256: operatorPlanDigest(plan) }),
  ).rejects.toThrow(/production75_live/);
  expect(transport.verifyIdentity).not.toHaveBeenCalled();
});
test("failed preparation always closes owned transport and produces no paid mutations", async () => {
  const transport = {
      verifyIdentity: vi.fn(async () => {
        throw new Error("private fixture");
      }),
      close: vi.fn(async () => ({ closed: true })),
    },
    api = { restoreCopy: vi.fn() };
  await expect(prepareLivePacket({ transport, api }, {})).rejects.toThrow(
    /production75_live/,
  );
  expect(transport.close).toHaveBeenCalledOnce();
  expect(api.restoreCopy).not.toHaveBeenCalled();
});
test("unverified oracle and source candidate drift are refused", () => {
  expect(() =>
    validateLiveOracle(
      { kind: "OWNED_NATIVE_POLICY_ORACLE", sourceCandidate: "foreign" },
      {},
    ),
  ).toThrow("production75_live_oracle");
});
const price = {
  status: "verified-applicable-legacy-v1",
  evidenceSha256: "d".repeat(64),
  account: plan.account,
  organization: plan.organization,
  providerVersion: 1,
  plan: "basic",
  region: "iad",
  currency: "USD",
  hourlyUsdMicros: 60000,
  meteringQuantumMs: 3600000,
  coveredMs: plan.workMs + plan.cleanupMs,
  maximumUsdMicros: 60000,
};
test.each([-999, 0, 59999, 150001, NaN])(
  "pricing %s is refused before provider access",
  (value) => {
    expect(() =>
      validateLivePricing({ ...price, maximumUsdMicros: value }, plan),
    ).toThrow("production75_live_pricing");
  },
);
test("pricing calculation must cover work plus deletion reserve and actual scope", () => {
  expect(validateLivePricing(price, plan)).toMatch(/^[a-f0-9]{64}$/);
  expect(() =>
    validateLivePricing({ ...price, coveredMs: plan.workMs }, plan),
  ).toThrow("production75_live_pricing");
  expect(() =>
    validateLivePricing({ ...price, providerVersion: 2 }, plan),
  ).toThrow("production75_live_pricing");
});
test.each(["state", "configuration", "secret-metadata"])(
  "protected app %s drift stops before paid create",
  async (change) => {
    const api = { restoreCopy: vi.fn() },
      transport = {
        protectedApps: vi.fn(async () => ({ [change]: "changed" })),
      },
      guarded = createGuardedLiveApi({
        api,
        transport,
        expectedApps: { [change]: "prepared" },
      });
    await expect(guarded.restoreCopy({})).rejects.toThrow(
      "production75_live_protected",
    );
    expect(api.restoreCopy).not.toHaveBeenCalled();
  },
);
test("all executable source dependencies are bound, including query/observer code", () => {
  expect(PRODUCTION75_RUNTIME_FILES).toContain(
    "scripts/staging-observation-core.mjs",
  );
  expect(PRODUCTION75_RUNTIME_FILES).toContain(
    "reports/release-preparation-2026-10-09/schema-catalog.mjs",
  );
  const a = production75RuntimeHashes(() => "baseline");
  for (const changed of PRODUCTION75_RUNTIME_FILES) {
    const b = production75RuntimeHashes((p) =>
      p === changed ? "changed" : "baseline",
    );
    expect(b[changed]).not.toBe(a[changed]);
    expect(Object.keys(b)).toEqual(PRODUCTION75_RUNTIME_FILES);
  }
});
