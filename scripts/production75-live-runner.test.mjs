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
} from "./production75-live-runner.mjs";
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
