import { test, expect, vi } from "vitest";
import { beforeAll } from "vitest";
import * as combinedRunner from "./production75-live-runner.mjs";
import {
  makeCombinedFixture,
  combinedSourceSnapshot,
} from "./production75-operator-test-support.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
let combinedRunnerFixture;
beforeAll(async () => {
  combinedRunnerFixture = await makeCombinedFixture();
}, 30000);
const validateCombined = (...args) => {
  if (!combinedRunner.validateCombinedLiveOracle)
    throw Error("not_implemented_combined_oracle");
  return combinedRunner.validateCombinedLiveOracle(...args);
};
test("combined oracle validates full two-layout finished synthetic contract without relabeling legacy proof", () => {
  const f = combinedRunnerFixture;
  expect(validateCombined(f.oracle, f.proof, f.modules, f.candidate)).toEqual(
    f.oracle,
  );
  expect(() => validateLiveOracle(f.oracle, f.proof, f.modules)).toThrow(
    "production75_live_oracle",
  );
  expect(() =>
    validateCombined(
      f.oracle.legacy,
      { ...f.proof, kind: "SYNTHETIC_PROXY_REAL_DRIVER_SQL" },
      f.modules,
      f.candidate,
    ),
  ).toThrow(/production75_combined_live_oracle/);
});
test.each([
  "six-containers",
  "missing-layout",
  "missing-reader",
  "module",
  "lockfile",
  "package",
  "catalog",
  "aggregate",
  "source",
  "candidate",
  "resource",
  "unfinished",
  "missing-delta",
  "result-source",
  "duplicate-attempt",
  "resource-binding",
  "late-failure-proof",
])(
  "combined oracle refuses %s before real dependencies can be used",
  (kind) => {
    const f = combinedRunnerFixture,
      o = structuredClone(f.oracle),
      p = structuredClone(f.proof),
      hashes = { ...f.modules };
    if (kind === "six-containers")
      p.cleanup.containers = p.cleanup.expectedContainers = 6;
    if (kind === "missing-layout") o.scheduling.layouts.pop();
    if (kind === "missing-reader")
      p.schedulingCases[1].commit.proof.freshReaderVerified = false;
    if (kind === "module")
      hashes["scripts/production75-operator.mjs"] = "e".repeat(64);
    if (kind === "lockfile") hashes["pnpm-lock.yaml"] = "e".repeat(64);
    if (kind === "package")
      hashes["artifacts/api-server/package.json"] = "e".repeat(64);
    if (kind === "catalog")
      p.catalogs.scheduling[0].before.columns[0].ordinal++;
    if (kind === "aggregate") p.moduleManifestSha256 = "e".repeat(64);
    if (kind === "source") o.scheduling.source.sourceCommit = "e".repeat(40);
    if (kind === "candidate") o.candidate.commit = "e".repeat(40);
    if (kind === "resource") p.ownedContainers[0].removed = false;
    if (kind === "unfinished") p.status = "RUNNING";
    if (kind === "missing-delta")
      delete p.cases.normal.result.outcomes.scheduling;
    if (kind === "result-source")
      p.schedulingCases[1].commit.sourceSha256 = "e".repeat(64);
    if (kind === "duplicate-attempt")
      p.schedulingCases[1].commit.attemptId =
        p.schedulingCases[0].commit.attemptId;
    if (kind === "resource-binding")
      p.ownedContainers[0].runId = "ffffffff-0000-4000-8000-000000000000";
    if (kind === "late-failure-proof") {
      p.schedulingCases[0].lateFailure.result.proof.sourceDispatched = false;
      p.schedulingCases[0].lateFailure.sqlState = "00000";
    }
    expect(() => validateCombined(o, p, hashes, f.candidate)).toThrow(
      /production75_combined_live_oracle/,
    );
  },
);
test("combined preparation rejects absent native coverage before provider observation or mutation", async () => {
  const api = { restoreCopy: vi.fn(), listClusters: vi.fn() },
    transport = {
      verifyIdentity: vi.fn(),
      close: vi.fn(async () => ({ closed: true })),
    };
  expect(typeof combinedRunner.prepareCombinedLivePacket).toBe("function");
  await expect(
    combinedRunner.prepareCombinedLivePacket({
      api,
      transport,
      oracle: combinedRunnerFixture.oracle,
    }),
  ).rejects.toThrow(/production75_combined/);
  expect(api.restoreCopy).not.toHaveBeenCalled();
  expect(api.listClusters).not.toHaveBeenCalled();
  expect(transport.verifyIdentity).not.toHaveBeenCalled();
});
function combinedDepsFixture() {
  const f = combinedRunnerFixture;
  return {
    candidate: f.candidate,
    oracle: f.oracle,
    nativeProof: f.proof,
    currentHashes: () => f.modules,
    catalogs: f.catalogs.legacy,
    source: f.source,
    schedulingSource: f.schedulingSource,
    manifestSha256: async () => f.proof.moduleManifestSha256,
  };
}
test("combined preparation preserves candidate and all scheduling fields without provider mutation", async () => {
  const f = combinedRunnerFixture,
    deps = combinedDepsFixture(),
    runId = "abcdef01-2345-4678-9abc-def012345678";
  cleanupProbe.capture.mockResolvedValueOnce(combinedSourceSnapshot(f));
  legacyPolicyProbe.derive.mockReturnValueOnce({
    policy75: f.oracle.legacy.policies[75],
    policy95: f.oracle.legacy.policies[95],
    policy142: f.oracle.legacy.policies[142],
  });
  coreProbe.prepare.mockReturnValue({
    policies: f.oracle.legacy.policies,
    target: f.fixtures[0].target,
  });
  const transport = {
    verifyIdentity: vi.fn(async () => {}),
    protectedApps: vi.fn(async () => ({ protected: "unchanged" })),
    withSourceCredentials: vi.fn(async (fn) => fn({})),
    close: vi.fn(async () => ({ closed: true })),
    metadata: () => ({ synthetic: true }),
  };
  const api = {
    listClusters: async () => [
      {
        id: plan.sourceCluster,
        version: 1,
        region: "iad",
        plan: "basic",
        status: "ready",
      },
      { id: plan.protectedClusters[1], status: "ready" },
    ],
    listBackups: async () => [
      {
        id: "backup",
        status: "completed",
        stop: new Date(Date.now() - 60000).toISOString(),
      },
    ],
    restoreCopy: vi.fn(),
  };
  const packet = await combinedRunner.prepareCombinedLivePacket(
    { ...deps, api, transport },
    { runId, workMs: 10000, cleanupMs: 10000 },
  );
  expect(packet.kind).toBe("UNADMITTED_COMBINED_LIVE_PREPARATION");
  expect(packet.plan.kind).toBe("PRODUCTION75_SCHEDULING0019_OPERATOR_V2");
  expect(packet.plan.candidate).toEqual(f.candidate);
  expect(packet.plan.scheduling.source).toEqual(f.descriptor);
  expect(packet.plan.scheduling.layouts).toHaveLength(2);
  expect(packet.paidAdmissionIssued).toBe(false);
  expect(packet.resourcesClosed).toBe(true);
  expect(api.restoreCopy).not.toHaveBeenCalled();
  await expect(executeLivePacket(deps, packet)).rejects.toThrow(
    "production75_live_admission",
  );
});
test.each(["catalogs", "source", "manifest", "coverage", "target"])(
  "combined preparation refuses missing or mismatched %s before provider access",
  async (kind) => {
    const f = combinedRunnerFixture,
      deps = combinedDepsFixture(),
      api = { listClusters: vi.fn(), restoreCopy: vi.fn() },
      transport = { verifyIdentity: vi.fn(), close: vi.fn() };
    if (kind === "catalogs") deps.catalogs = {};
    if (kind === "source") deps.schedulingSource = { ...deps.schedulingSource };
    if (kind === "manifest")
      deps.nativeProof = {
        ...deps.nativeProof,
        moduleManifestSha256: "f".repeat(64),
      };
    if (kind === "coverage")
      deps.nativeProof = { ...deps.nativeProof, schedulingCases: [] };
    if (kind === "target")
      deps.candidate = { ...deps.candidate, repository: "other/repo" };
    await expect(
      combinedRunner.prepareCombinedLivePacket({ ...deps, api, transport }),
    ).rejects.toThrow(/production75_|scheduling0019_/);
    expect(api.listClusters).not.toHaveBeenCalled();
    expect(api.restoreCopy).not.toHaveBeenCalled();
    expect(transport.verifyIdentity).not.toHaveBeenCalled();
  },
);
test("explicit combined CLI selects only the combined factory after exact argument validation", async () => {
  const oldFactory = vi.fn(),
    combinedFactory = vi.fn(() => {
      throw Error("bounded synthetic factory");
    }),
    root = fs.mkdtempSync(path.join(os.tmpdir(), "production75-combined-cli-"));
  try {
    await expect(
      main(["prepare-combined", root, path.join(root, "new-output")], {
        factory: oldFactory,
        combinedFactory,
      }),
    ).rejects.toThrow("bounded synthetic factory");
    expect(combinedFactory).toHaveBeenCalledWith(root);
    expect(oldFactory).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, "new-output"))).toBe(false);
  } finally {
    const actual = fs.realpathSync(root);
    expect(path.dirname(actual)).toBe(fs.realpathSync(os.tmpdir()));
    expect(path.basename(actual).startsWith("production75-combined-cli-")).toBe(
      true,
    );
    fs.rmSync(actual, { recursive: true });
  }
});
test("supplied combined composition is explicit and has no default native factory or unfinished-proof admission", async () => {
  expect(typeof combinedRunner.executeSuppliedCombinedPacket).toBe("function");
  await expect(
    combinedRunner.executeSuppliedCombinedPacket({}, {}),
  ).rejects.toThrow(/production75_combined/);
});
test("combined dependency accessor is rejected without invocation before provider access", async () => {
  const deps = combinedDepsFixture();
  let calls = 0;
  Object.defineProperty(deps, "currentHashes", {
    get() {
      calls++;
      return () => combinedRunnerFixture.modules;
    },
    enumerable: true,
  });
  await expect(combinedRunner.prepareCombinedLivePacket(deps)).rejects.toThrow(
    /production75_combined/,
  );
  expect(calls).toBe(0);
});
test.each([
  ["prepare-combined"],
  ["prepare-combined", "relative", "relative"],
  ["execute-combined", "relative", "relative", "relative"],
  ["execute-combined", "a", "b", "c", "d"],
])(
  "combined CLI retains absolute-path and argument-count guards %s",
  async (args) => {
    const factory = vi.fn();
    await expect(
      main(args, { factory, combinedFactory: factory }),
    ).rejects.toThrow("production75_live_action");
    expect(factory).not.toHaveBeenCalled();
  },
);
import { createHash } from "node:crypto";
const cleanupProbe = vi.hoisted(() => ({ capture: vi.fn() }));
const coreProbe = vi.hoisted(() => ({ prepare: vi.fn() }));
const legacyPolicyProbe = vi.hoisted(() => ({ derive: vi.fn() }));
vi.mock("./production75-live-policy.mjs", async (original) => {
  const actual = await original();
  legacyPolicyProbe.derive.mockImplementation(actual.deriveLivePolicies);
  return { ...actual, deriveLivePolicies: legacyPolicyProbe.derive };
});
vi.mock("./production75-core.mjs", async (original) => ({
  ...(await original()),
  prepareProduction75: coreProbe.prepare,
}));
vi.mock("./production75-live-observation.mjs", async (original) => ({
  ...(await original()),
  captureLiveSnapshot: cleanupProbe.capture,
}));
import {
  prepareOperatorPlan,
  prepareCombinedOperatorPlan,
  operatorPlanDigest,
} from "./production75-custody.mjs";
import {
  expectedProduction75ReaderProfile,
  production75SnapshotDigest,
} from "./production75-reader-delta.mjs";
import { catalogDigest } from "../reports/release-preparation-2026-10-09/schema-catalog.mjs";
test.each(["owner-approval", "independent-capability-review"])(
  "combined execution rejects old %s before provider access",
  async (oldKind) => {
    const f = combinedRunnerFixture,
      hash = (v) =>
        createHash("sha256").update(JSON.stringify(v)).digest("hex"),
      before = combinedSourceSnapshot(f),
      preparedAt = Date.now();
    const p = prepareCombinedOperatorPlan({
      runId: "abcdef01-2345-4678-9abc-def012345678",
      backupId: "backup",
      sourceSnapshotSha256: production75SnapshotDigest(before),
      profileSha256: production75ProfileDigest(
        expectedProduction75ReaderProfile(f.readerName),
      ),
      moduleManifestSha256: f.proof.moduleManifestSha256,
      preparedAt,
      workMs: 30000,
      cleanupMs: 30000,
      maxCostUsdMicros: 150000,
      candidate: f.candidate,
      scheduling: {
        source: f.descriptor,
        coverage: f.oracle.scheduling.coverage,
        layouts: f.fixtures.map((x) => ({
          beforeCatalogSha256: catalogDigest(x.catalogs.before, {
            physical: true,
          }),
          afterCatalogSha256: catalogDigest(x.catalogs.after, {
            physical: true,
          }),
          beforePolicySha256: hash(x.policyBefore),
          afterPolicySha256: hash(x.policyAfter),
        })),
      },
    });
    const pricing = {
        status: "verified-applicable-legacy-v1",
        evidenceSha256: "d".repeat(64),
        account: p.account,
        organization: p.organization,
        providerVersion: p.providerVersion,
        plan: p.plan,
        region: p.region,
        currency: "USD",
        hourlyUsdMicros: 60000,
        meteringQuantumMs: 3600000,
        coveredMs: 60000,
        maximumUsdMicros: 60000,
      },
      apps = { synthetic: "unchanged" },
      packet = {
        kind: "UNADMITTED_COMBINED_LIVE_PREPARATION",
        plan: p,
        planSha256: operatorPlanDigest(p),
        sourceBefore: before,
        protectedApps: apps,
        pricing,
        oracleSha256: f.proof.oracleSha256,
      };
    const api = Object.fromEntries(
        [
          "listClusters",
          "getCluster",
          "listBackups",
          "listUsers",
          "restoreCopy",
          "createReader",
          "deleteCopy",
          "credentials",
        ].map((k) => [k, vi.fn()]),
      ),
      transport = Object.fromEntries(
        [
          "verifyIdentity",
          "withSourceCredentials",
          "protectedApps",
          "close",
          "metadata",
          "openProxy",
          "connect",
          "closeResources",
        ].map((k) => [k, vi.fn()]),
      );
    const unprotect = vi.fn(async (_blob, entropy) => {
      const kind = entropy.toString().includes(":owner-approval:")
        ? "owner-approval"
        : "independent-capability-review";
      return Buffer.from(
        JSON.stringify({
          version: 1,
          kind,
          planSha256:
            kind === oldKind ? operatorPlanDigest(plan) : operatorPlanDigest(p),
          issuedAt: preparedAt,
          expiresAt: p.cleanupUntil,
          sourceSnapshotSha256: p.sourceSnapshotSha256,
          profileSha256: p.profileSha256,
          moduleManifestSha256: p.moduleManifestSha256,
          maxCostUsdMicros: p.maxCostUsdMicros,
          maxCopies: 1,
          sourceWritesAuthorized: false,
          pricingSha256: hash(pricing),
          protectedAppsSha256: hash(apps),
          provenance: {
            type:
              kind === "owner-approval"
                ? "direct-human-priced-approval"
                : "independent-capability-review",
            evidenceSha256: "d".repeat(64),
            reference: "synthetic unit only",
          },
        }),
      );
    });
    await expect(
      combinedRunner.executeCombinedLivePacket(
        { ...combinedDepsFixture(), api, transport, unprotect },
        packet,
        { owner: Buffer.alloc(80, 1), review: Buffer.alloc(80, 2) },
      ),
    ).rejects.toThrow("production75_live_admission");
    expect(unprotect).toHaveBeenCalledTimes(
      oldKind === "owner-approval" ? 1 : 2,
    );
    expect(api.restoreCopy).not.toHaveBeenCalled();
    expect(transport.verifyIdentity).not.toHaveBeenCalled();
  },
);
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
import { deltaFixture } from "./production75-operator-test-support.mjs";
import { production75ProfileDigest } from "./production75-reader-delta.mjs";
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
test.each([
  "ABCDEF01-2345-4678-9abc-def012345678",
  "abcdef01-2345-4678-9abc-def01234567g",
  "abcdef01234546789abcdef012345678",
])(
  "mocked preparation refuses invalid UUID %s before provider or source observation",
  async (runId) => {
    const transport = {
        verifyIdentity: vi.fn(async () => {}),
        close: vi.fn(async () => ({ closed: true })),
      },
      api = { listClusters: vi.fn(), restoreCopy: vi.fn() };
    cleanupProbe.capture.mockClear();
    await expect(
      prepareLivePacket({ transport, api }, { runId }),
    ).rejects.toThrow("production75_live_preparation");
    expect(transport.verifyIdentity).not.toHaveBeenCalled();
    expect(api.listClusters).not.toHaveBeenCalled();
    expect(api.restoreCopy).not.toHaveBeenCalled();
    expect(cleanupProbe.capture).not.toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalledOnce();
  },
);
test("mocked preparation binds one full dashed name to profile, plan and core context", async () => {
  const runId = "abcdef01-2345-4678-9abc-def012345678",
    readerName = "growthos-reader-abcdef01234546789abcdef012345678",
    f = deltaFixture(readerName),
    baseline = f.after.databases.find((d) => d.name === "fly-db").policy;
  cleanupProbe.capture.mockResolvedValueOnce(f.before);
  coreProbe.prepare.mockClear();
  const transport = {
    verifyIdentity: vi.fn(async () => {}),
    protectedApps: vi.fn(async () => ({})),
    withSourceCredentials: vi.fn(async (consumer) => consumer({})),
    close: vi.fn(async () => ({ closed: true })),
    metadata: () => ({ synthetic: true }),
  };
  const api = {
    listClusters: async () => [
      {
        id: plan.sourceCluster,
        version: 1,
        region: "iad",
        plan: "basic",
        status: "ready",
      },
      { id: plan.protectedClusters[1], status: "ready" },
    ],
    listBackups: async () => [
      {
        id: "backup",
        status: "completed",
        stop: new Date(Date.now() - 60000).toISOString(),
      },
    ],
    restoreCopy: vi.fn(),
  };
  const packet = await prepareLivePacket(
    {
      transport,
      api,
      catalogs: {},
      oracle: {
        templateReader: readerName,
        policies: { 75: baseline, 95: baseline, 142: baseline },
      },
      manifestSha256: async () => "c".repeat(64),
    },
    { runId, workMs: 10000, cleanupMs: 10000 },
  );
  expect(packet.plan.readerName).toBe(readerName);
  expect(packet.plan.profileSha256).toBe(
    production75ProfileDigest(f.expectedProfile),
  );
  expect(coreProbe.prepare).toHaveBeenCalledOnce();
  expect(coreProbe.prepare.mock.calls[0][0].target).toMatchObject({
    readerLogin: readerName,
    readerRole: readerName,
    principals: ["fly-user", "growthos-staging-live", "reader", readerName],
  });
  expect(packet).toMatchObject({
    resourcesClosed: true,
    readerProfileActualVerified: false,
    paidAdmissionIssued: false,
    sourceWritesAuthorized: false,
  });
  expect(transport.close).toHaveBeenCalledOnce();
  expect(api.restoreCopy).not.toHaveBeenCalled();
});

test("preparation waits for measured Windows closure beyond ten seconds", async () => {
  vi.useFakeTimers();
  let disposed = false;
  const transport = {
    verifyIdentity: vi.fn(async () => {}),
    protectedApps: vi.fn(async () => ({})),
    withSourceCredentials: vi.fn(async (consumer) => consumer({})),
    close: vi.fn(async () => ({ closed: disposed })),
  };
  const api = {
    listClusters: async () => [
      {
        id: plan.sourceCluster,
        version: 1,
        region: "iad",
        plan: "basic",
        status: "ready",
      },
      { id: plan.protectedClusters[1], status: "ready" },
    ],
    listBackups: async () => [
      {
        id: "backup",
        status: "completed",
        stop: new Date(Date.now() - 60000).toISOString(),
      },
    ],
    restoreCopy: vi.fn(),
  };
  cleanupProbe.capture.mockImplementationOnce(async ({ resources }) => {
    await resources.acquire(
      async () => ({}),
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 15000));
        disposed = true;
      },
    );
    throw new Error("synthetic observation hold");
  });
  try {
    const pending = expect(
      prepareLivePacket({ transport, api }),
    ).rejects.toThrow("production75_live_preparation");
    await vi.advanceTimersByTimeAsync(11000);
    expect(transport.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(disposed).toBe(true);
    expect(transport.close).toHaveBeenCalledOnce();
    expect(api.restoreCopy).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
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
test("coherent synthetic old oracle proof is refused for every changed admitted naming module", () => {
  const oracle = {
      kind: "OWNED_NATIVE_POLICY_ORACLE",
      sourceCandidate: plan.sourceCandidate,
      templateReader: "growthos_reader_fixture",
    },
    oldHashes = production75RuntimeHashes(() => "old-source");
  const proof = {
    kind: "SYNTHETIC_PROXY_REAL_DRIVER_SQL",
    status: "PASS",
    sourceCandidate: plan.sourceCandidate,
    liveProviderCalls: false,
    cleanup: {
      clients: 1,
      expectedClients: 1,
      sockets: 1,
      containers: 6,
      expectedContainers: 6,
    },
    oracleSha256: createHash("sha256")
      .update(JSON.stringify(oracle))
      .digest("hex"),
    moduleHashesBefore: oldHashes,
    moduleHashesAfter: oldHashes,
    cases: {
      normal: { result: { status: "verified-and-cleaned" } },
      "lost-commit": {
        result: {
          outcomes: { commit: { status: "reconciled-commit-no-replay" } },
        },
      },
      "idle-client-error": { result: { status: "held-and-cleaned" } },
    },
    transportProofs: [
      {
        clients: 1,
        clientsClosed: 1,
        socketsClosed: 1,
        proxies: 1,
        proxiesClosed: 1,
      },
    ],
  };
  expect(validateLiveOracle(oracle, proof, oldHashes)).toEqual(oracle);
  for (const changed of [
    "custody",
    "live-runner",
    "reader-delta",
    "live-policy",
    "live-local",
  ]) {
    const current = production75RuntimeHashes((p) =>
      p === `scripts/production75-${changed}.mjs` ? "new-source" : "old-source",
    );
    expect(() => validateLiveOracle(oracle, proof, current)).toThrow(
      "production75_live_oracle",
    );
  }
});

const guardedSchedulingWriter = (input) => {
  if (!combinedRunner.guardCombinedSchedulingWriter)
    throw Error("not_implemented_combined_writer_guard");
  return combinedRunner.guardCombinedSchedulingWriter(input);
};
test("late protected-app observation cannot dispatch a scheduling BEGIN after its guard expired", async () => {
  vi.useFakeTimers();
  let resolveProtected;
  const query = vi.fn(async () => ({ command: "BEGIN" })),
    writer = { query, connection: { stream: { destroy: vi.fn() } } },
    resources = { deadline: Date.now() + 60000, assertActive: vi.fn() };
  try {
    const guard = guardedSchedulingWriter({
        writer,
        resources,
        verifyProtected: () =>
          new Promise((r) => {
            resolveProtected = r;
          }),
      }),
      pending = expect(
        guard.query("BEGIN ISOLATION LEVEL REPEATABLE READ"),
      ).rejects.toThrow(/production75_combined_writer_guard/);
    await vi.advanceTimersByTimeAsync(12001);
    await pending;
    expect(query).not.toHaveBeenCalled();
    resolveProtected(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(query).not.toHaveBeenCalled();
    await expect(guard.query("ROLLBACK")).rejects.toThrow(
      /production75_combined_writer_guard/,
    );
    expect(query).not.toHaveBeenCalled();
    expect(writer.connection.stream.destroy).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
test("scheduling guard captures its writer callback before awaiting protected-app observation", async () => {
  let resolveProtected;
  const query = vi.fn(async () => ({ command: "BEGIN" })),
    replacement = vi.fn(),
    writer = { query },
    resources = { deadline: Date.now() + 60000, assertActive: vi.fn() },
    guard = guardedSchedulingWriter({
      writer,
      resources,
      verifyProtected: () =>
        new Promise((r) => {
          resolveProtected = r;
        }),
    }),
    pending = guard.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  await Promise.resolve();
  writer.query = replacement;
  resolveProtected(true);
  await pending;
  expect(query).toHaveBeenCalledOnce();
  expect(replacement).not.toHaveBeenCalled();
});
