import { beforeAll, expect, test } from "vitest";
import * as local from "./production75-live-local.mjs";
import { makeCombinedFixture } from "./production75-operator-test-support.mjs";

let fixture;
beforeAll(async () => {
  fixture = await makeCombinedFixture();
}, 30000);
const finish = (proof, oracle = fixture.oracle) => {
  expect(typeof local.finalizeCombinedLocalProof).toBe("function");
  return local.finalizeCombinedLocalProof({
    proof,
    oracle,
    currentHashes: fixture.modules,
    candidate: fixture.candidate,
  });
};

test("local action selects combined explicitly while legacy remains separate", () => {
  expect(typeof local.selectLocalAction).toBe("function");
  expect(local.selectLocalAction(["--run-local"])).toBe("legacy");
  expect(local.selectLocalAction(["--run-combined-local"])).toBe("combined");
  for (const args of [
    [],
    ["--run-combined-local", "--run-local"],
    ["--run-combined-local", "extra"],
  ])
    expect(() => local.selectLocalAction(args)).toThrow(
      /production75_operator_local_action/,
    );
});

test("only completed execution and exact cleanup can finalize the native proof", () => {
  const p = { ...structuredClone(fixture.proof), status: "EXECUTED" };
  const result = finish(p);
  expect(result.status).toBe("PASS");
  expect(p.status).toBe("EXECUTED");
  expect(result.moduleManifestSha256).toBe(fixture.proof.moduleManifestSha256);
});

test("late failure fixture preserves exact pinned bytes across six anchored ALTER chunks", () => {
  expect(typeof local.splitScheduling0019FaultFixture).toBe("function");
  const sql = fixture.schedulingSource.sql;
  const chunks = local.splitScheduling0019FaultFixture(sql);
  expect(chunks).toHaveLength(6);
  expect(chunks.join("")).toBe(sql);
  expect(
    chunks[5].startsWith(
      'ALTER TABLE "projects" ADD CONSTRAINT "projects_scheduling_reservation_ck"',
    ),
  ).toBe(true);
  expect(() => local.splitScheduling0019FaultFixture(sql + " ")).toThrow(
    /production75_/,
  );
});

test("combined work expiration never admits new work and cleanup has its own four minute ceiling", () => {
  expect(typeof local.createCombinedLocalBudget).toBe("function");
  let at = 1000;
  const budget = local.createCombinedLocalBudget(() => at);
  at = 1201000;
  expect(() => budget.remaining()).toThrow(
    /production75_operator_local_deadline/,
  );
  budget.beginCleanup();
  expect(budget.remaining()).toBe(240000);
  at += 240000;
  expect(() => budget.remaining()).toThrow(
    /production75_operator_local_deadline/,
  );
  budget.beginCleanup();
  expect(() => budget.remaining()).toThrow(
    /production75_operator_local_deadline/,
  );
});

test("native finalization rejects proof accessors without invoking them", () => {
  const proof = { ...structuredClone(fixture.proof), status: "EXECUTED" };
  let invoked = 0;
  Object.defineProperty(proof, "status", {
    enumerable: true,
    get() {
      invoked++;
      return "EXECUTED";
    },
  });
  expect(() => finish(proof)).toThrow(/production75_/);
  expect(invoked).toBe(0);
});

function cleanupFixture(expireAt, rejectRemoval = false) {
  let at = 0,
    present = true,
    expired = false;
  const budget = local.createCombinedLocalBudget(() => at);
  const identity = {
    runId: "12345678-1234-4123-8123-123456789012",
    name: "production75-local-123-12345678",
    id: "a".repeat(64),
  };
  const dispatched = [];
  const inspection = {
    Name: `/${identity.name}`,
    Id: identity.id,
    Config: {
      Labels: {
        "com.forge.local-test": identity.runId,
        "com.forge.fixture-purpose": "production75-local",
      },
    },
  };
  const execute = async (args, beforeDispatch) => {
    budget.remaining();
    beforeDispatch?.();
    dispatched.push([...args]);
    if (args[0] === "ps") {
      if (expireAt === "after-inventory" && !expired) {
        at = 1200000;
        expired = true;
      }
      return { output: present ? identity.id : "" };
    }
    if (args[0] === "inspect") {
      if (expireAt === "after-inspection" && !expired) {
        at = 1200000;
        expired = true;
      }
      return { output: JSON.stringify([inspection]) };
    }
    expect(args).toEqual(["rm", "--force", identity.id]);
    if (rejectRemoval) throw Error("synthetic removal rejected");
    present = false;
    return { output: identity.id };
  };
  if (expireAt === "before-inventory") at = 1200000;
  return { identity, budget, execute, dispatched };
}

test.each(["before-inventory", "after-inventory", "after-inspection"])(
  "combined cleanup resumes exact ownership checks in reserve after work expiry %s",
  async (expireAt) => {
    const f = cleanupFixture(expireAt);
    await expect(
      local.cleanupCombinedLocalContainer(f.identity, f.execute),
    ).rejects.toThrow(/production75_operator_local_deadline/);
    expect(f.dispatched.filter((args) => args[0] === "rm")).toHaveLength(0);
    f.budget.beginCleanup();
    const proof = await local.cleanupCombinedLocalContainer(
      f.identity,
      f.execute,
    );
    expect(proof?.containerRemoved).toBe(true);
    expect(proof.removedId).toBe(f.identity.id);
    expect(f.dispatched.filter((args) => args[0] === "rm")).toHaveLength(1);
    expect(f.dispatched.at(-1)[0]).toBe("ps");
  },
);

test("combined cleanup never retries an actual rejected removal in the reserved phase", async () => {
  const f = cleanupFixture(null, true);
  await expect(
    local.cleanupCombinedLocalContainer(f.identity, f.execute),
  ).rejects.toThrow("synthetic removal rejected");
  f.budget.beginCleanup();
  expect(
    await local.cleanupCombinedLocalContainer(f.identity, f.execute),
  ).toBeNull();
  expect(f.dispatched.filter((args) => args[0] === "rm")).toEqual([
    ["rm", "--force", f.identity.id],
  ]);
});

const storageIdentity = {
  id: "b".repeat(64),
  runId: "87654321-1234-4123-8123-123456789012",
  name: "production75-local-123-87654321",
};
const storageInspection = () => ({
  Id: storageIdentity.id,
  Name: `/${storageIdentity.name}`,
  Config: {
    Env: ["FICTIONAL_PRIVATE=must-never-be-retained"],
    Labels: {
      "com.forge.local-test": storageIdentity.runId,
      "com.forge.fixture-purpose": "production75-local",
    },
  },
  Mounts: [
    {
      Type: "tmpfs",
      Source: "",
      Destination: "/var/lib/postgresql/data",
      RW: true,
      Propagation: "",
    },
  ],
  HostConfig: {
    Mounts: [
      {
        Type: "tmpfs",
        Target: "/var/lib/postgresql/data",
        ReadOnly: false,
        TmpfsOptions: { SizeBytes: 536870912, Mode: 448 },
      },
    ],
  },
});

test("combined container arguments explicitly replace implicit PGDATA volumes within the existing memory cap", () => {
  expect(typeof local.production75LocalStorageArguments).toBe("function");
  expect(local.production75LocalStorageArguments(false)).toEqual([]);
  expect(local.production75LocalStorageArguments(true)).toEqual([
    "--mount",
    "type=tmpfs,destination=/var/lib/postgresql/data,tmpfs-size=536870912,tmpfs-mode=0700",
  ]);
});

test("actual owned tmpfs inspection produces bounded storage and only selected redacted mount evidence", () => {
  expect(typeof local.inspectCombinedLocalStorage).toBe("function");
  const actual = local.inspectCombinedLocalStorage(
    storageInspection(),
    storageIdentity,
  );
  expect(actual.storage).toEqual({
    type: "tmpfs",
    destination: "/var/lib/postgresql/data",
    sizeBytes: 536870912,
    writable: true,
    volumeMounts: 0,
  });
  expect(actual.mountEvidence.Mounts).toEqual([
    { Type: "tmpfs", Destination: "/var/lib/postgresql/data", RW: true },
  ]);
  expect(actual.mountEvidence.HostConfig.Mounts[0].TmpfsOptions).toEqual({
    SizeBytes: 536870912,
    Mode: 448,
  });
  expect(JSON.stringify(actual)).not.toContain("FICTIONAL_PRIVATE");
  expect(JSON.stringify(actual)).not.toContain('"Env"');
});

test.each([
  "implicit-volume",
  "wrong-destination",
  "wrong-size",
  "read-only",
  "configured-read-only",
  "bind",
  "wrong-mode",
  "missing-config",
  "wrong-owner",
])("pre-SQL storage admission refuses %s", (kind) => {
  const actual = storageInspection();
  if (kind === "implicit-volume") actual.Mounts[0].Type = "volume";
  if (kind === "wrong-destination")
    actual.Mounts[0].Destination = actual.HostConfig.Mounts[0].Target =
      "/other";
  if (kind === "wrong-size")
    actual.HostConfig.Mounts[0].TmpfsOptions.SizeBytes++;
  if (kind === "read-only") actual.Mounts[0].RW = false;
  if (kind === "configured-read-only")
    actual.HostConfig.Mounts[0].ReadOnly = true;
  if (kind === "bind")
    actual.Mounts.push({ Type: "bind", Destination: "/other", RW: true });
  if (kind === "wrong-mode")
    actual.HostConfig.Mounts[0].TmpfsOptions.Mode = 511;
  if (kind === "missing-config") actual.HostConfig.Mounts = [];
  if (kind === "wrong-owner")
    actual.Config.Labels["com.forge.local-test"] =
      "ffffffff-1234-4123-8123-123456789012";
  expect(() =>
    local.inspectCombinedLocalStorage(actual, storageIdentity),
  ).toThrow(/production75_operator_local_storage/);
});

test("native volume inventory normalizes actual CLI order and admits unchanged unique bounded names", () => {
  expect(typeof local.readCombinedLocalVolumeNames).toBe("function");
  expect(typeof local.assertCombinedLocalStorageInventory).toBe("function");
  const before = local.readCombinedLocalVolumeNames("existing-b\nexisting-a\n");
  const after = local.readCombinedLocalVolumeNames(
    "existing-a\r\nexisting-b\r\n",
  );
  expect(local.assertCombinedLocalStorageInventory(before, after)).toEqual({
    before: ["existing-a", "existing-b"],
    after: ["existing-a", "existing-b"],
    unchanged: true,
  });
});

test.each([
  "changed",
  "duplicate",
  "invalid-name",
  "too-many",
  "too-long",
  "unsorted",
])(
  "storage inventory admission refuses %s without resource mutation",
  (kind) => {
    const before = ["existing-a"],
      after = ["existing-a"];
    if (kind === "changed") after.push("unexpected-anonymous-volume");
    if (kind === "duplicate") after.push("existing-a");
    if (kind === "invalid-name") after[0] = "../volume";
    if (kind === "too-many")
      after.push(
        ...Array.from(
          { length: 10000 },
          (_, i) => `v${String(i).padStart(5, "0")}`,
        ),
      );
    if (kind === "too-long") after[0] = "a".repeat(256);
    if (kind === "unsorted") {
      before.push("existing-b");
      after.push("existing-0");
    }
    // Equal malformed inventories must still refuse; equality alone cannot
    // stand in for name, uniqueness, bounds or strict-order validation.
    if (kind !== "changed") before.splice(0, before.length, ...after);
    expect(() =>
      local.assertCombinedLocalStorageInventory(before, after),
    ).toThrow(/production75_operator_local_storage/);
  },
);

test.each([
  "unfinished",
  "layout",
  "legacy-six",
  "delta",
  "reader",
  "full-data",
  "inventory",
  "aggregate",
  "unclosed-socket",
  "transport",
  "concurrent-drift",
])("native finalization refuses %s evidence", (kind) => {
  const p = { ...structuredClone(fixture.proof), status: "EXECUTED" };
  const o = structuredClone(fixture.oracle);
  if (kind === "unfinished") p.status = "RUNNING";
  if (kind === "layout") o.scheduling.layouts.pop();
  if (kind === "legacy-six")
    p.cleanup.containers = p.cleanup.expectedContainers = 6;
  if (kind === "delta") delete p.cases.normal.result.outcomes.scheduling;
  if (kind === "reader")
    p.schedulingCases[1].commit.proof.freshReaderVerified = false;
  if (kind === "full-data") p.schedulingCases[0].coverage.columnsBefore = 849;
  if (kind === "inventory") p.ownedContainers[0].removed = false;
  if (kind === "aggregate") p.moduleManifestSha256 = "f".repeat(64);
  if (kind === "unclosed-socket") p.cleanup.sockets--;
  if (kind === "transport") p.transportProofs.pop();
  if (kind === "concurrent-drift")
    p.schedulingCases[0].preLockConcurrentDriftRejected = false;
  expect(() => finish(p, o)).toThrow(/production75_/);
});
