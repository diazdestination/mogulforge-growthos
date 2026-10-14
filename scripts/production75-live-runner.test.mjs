import { test, expect, vi } from "vitest";
import { createHash } from "node:crypto";
const cleanupProbe = vi.hoisted(() => ({ capture: vi.fn() }));
const coreProbe = vi.hoisted(() => ({ prepare: vi.fn() }));
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
test.each(['ABCDEF01-2345-4678-9abc-def012345678','abcdef01-2345-4678-9abc-def01234567g','abcdef01234546789abcdef012345678'])('mocked preparation refuses invalid UUID %s before provider or source observation',async runId=>{
  const transport={verifyIdentity:vi.fn(async()=>{}),close:vi.fn(async()=>({closed:true}))},api={listClusters:vi.fn(),restoreCopy:vi.fn()};
  cleanupProbe.capture.mockClear();
  await expect(prepareLivePacket({transport,api},{runId})).rejects.toThrow('production75_live_preparation');
  expect(transport.verifyIdentity).not.toHaveBeenCalled();expect(api.listClusters).not.toHaveBeenCalled();expect(api.restoreCopy).not.toHaveBeenCalled();expect(cleanupProbe.capture).not.toHaveBeenCalled();expect(transport.close).toHaveBeenCalledOnce();
});
test("mocked preparation binds one full dashed name to profile, plan and core context", async () => {
  const runId="abcdef01-2345-4678-9abc-def012345678",readerName="growthos-reader-abcdef01234546789abcdef012345678",f=deltaFixture(readerName),baseline=f.after.databases.find(d=>d.name==='fly-db').policy;
  cleanupProbe.capture.mockResolvedValueOnce(f.before);
  coreProbe.prepare.mockClear();
  const transport={verifyIdentity:vi.fn(async()=>{}),protectedApps:vi.fn(async()=>({})),withSourceCredentials:vi.fn(async consumer=>consumer({})),close:vi.fn(async()=>({closed:true})),metadata:()=>({synthetic:true})};
  const api={listClusters:async()=>[{id:plan.sourceCluster,version:1,region:'iad',plan:'basic',status:'ready'},{id:plan.protectedClusters[1],status:'ready'}],listBackups:async()=>[{id:'backup',status:'completed',stop:new Date(Date.now()-60000).toISOString()}],restoreCopy:vi.fn()};
  const packet=await prepareLivePacket({transport,api,catalogs:{},oracle:{templateReader:readerName,policies:{75:baseline,95:baseline,142:baseline}},manifestSha256:async()=>'c'.repeat(64)},{runId,workMs:10000,cleanupMs:10000});
  expect(packet.plan.readerName).toBe(readerName);
  expect(packet.plan.profileSha256).toBe(production75ProfileDigest(f.expectedProfile));
  expect(coreProbe.prepare).toHaveBeenCalledOnce();
  expect(coreProbe.prepare.mock.calls[0][0].target).toMatchObject({readerLogin:readerName,readerRole:readerName,principals:['fly-user','growthos-staging-live','reader',readerName]});
  expect(packet).toMatchObject({resourcesClosed:true,readerProfileActualVerified:false,paidAdmissionIssued:false,sourceWritesAuthorized:false});
  expect(transport.close).toHaveBeenCalledOnce();expect(api.restoreCopy).not.toHaveBeenCalled();
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
      { id: plan.sourceCluster, version: 1, region: "iad", plan: "basic", status: "ready" },
      { id: plan.protectedClusters[1], status: "ready" },
    ],
    listBackups: async () => [{ id: "backup", status: "completed", stop: new Date(Date.now() - 60000).toISOString() }],
    restoreCopy: vi.fn(),
  };
  cleanupProbe.capture.mockImplementationOnce(async ({ resources }) => {
    await resources.acquire(async () => ({}), async () => {
      await new Promise((resolve) => setTimeout(resolve, 15000));
      disposed = true;
    });
    throw new Error("synthetic observation hold");
  });
  try {
    const pending = expect(prepareLivePacket({ transport, api })).rejects.toThrow("production75_live_preparation");
    await vi.advanceTimersByTimeAsync(11000);
    expect(transport.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(disposed).toBe(true);
    expect(transport.close).toHaveBeenCalledOnce();
    expect(api.restoreCopy).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
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
test('coherent synthetic old oracle proof is refused for every changed admitted naming module',()=>{
  const oracle={kind:'OWNED_NATIVE_POLICY_ORACLE',sourceCandidate:plan.sourceCandidate,templateReader:'growthos_reader_fixture'},oldHashes=production75RuntimeHashes(()=>'old-source');
  const proof={kind:'SYNTHETIC_PROXY_REAL_DRIVER_SQL',status:'PASS',sourceCandidate:plan.sourceCandidate,liveProviderCalls:false,cleanup:{clients:1,expectedClients:1,sockets:1,containers:6,expectedContainers:6},oracleSha256:createHash('sha256').update(JSON.stringify(oracle)).digest('hex'),moduleHashesBefore:oldHashes,moduleHashesAfter:oldHashes,cases:{normal:{result:{status:'verified-and-cleaned'}},'lost-commit':{result:{outcomes:{commit:{status:'reconciled-commit-no-replay'}}}},'idle-client-error':{result:{status:'held-and-cleaned'}}},transportProofs:[{clients:1,clientsClosed:1,socketsClosed:1,proxies:1,proxiesClosed:1}]};
  expect(validateLiveOracle(oracle,proof,oldHashes)).toEqual(oracle);
  for(const changed of ['custody','live-runner','reader-delta','live-policy','live-local']){const current=production75RuntimeHashes(p=>p===`scripts/production75-${changed}.mjs`?'new-source':'old-source');expect(()=>validateLiveOracle(oracle,proof,current)).toThrow('production75_live_oracle');}
});
