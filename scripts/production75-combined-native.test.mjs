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
