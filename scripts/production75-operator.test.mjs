import { test, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  deltaFixture,
  verificationFixture,
  makeCombinedFixture,
} from "./production75-operator-test-support.mjs";
import { beforeAll } from "vitest";
import * as custodyV2 from "./production75-custody.mjs";
import { prepareScheduling0019 } from "./production75-scheduling0019.mjs";
import { catalogDigest } from "../reports/release-preparation-2026-10-09/schema-catalog.mjs";
import { createHash } from "node:crypto";
import {
  prepareOperatorPlan,
  operatorPlanDigest,
} from "./production75-custody.mjs";
import {
  expectedProduction75ReaderProfile,
  production75ProfileDigest,
  production75SnapshotDigest,
} from "./production75-reader-delta.mjs";
import {
  runProduction75Operator,
  createOperatorResources,
} from "./production75-operator.mjs";
import { createProduction75V1Client } from "./production75-fly-v1.mjs";
import { createLiveTransportFixture } from "./test-support/live-transport-fixture.mjs";
import { withProduction75Stage } from "./production75-safe-diagnostics.mjs";
import { createProduction75Observer } from "./production75-observer.mjs";
import { createScheduling0019Observer } from "./production75-scheduling0019-observer.mjs";
import { IDENTITY_SQL } from "./production75-core.mjs";
const mocks = vi.hoisted(() => ({ verify: vi.fn(), scheduling: vi.fn() }));
vi.mock("./production75-verification.mjs", () => ({
  runProduction75Verification: mocks.verify,
}));
vi.mock("./production75-scheduling0019.mjs", async (original) => ({
  ...(await original()),
  runScheduling0019Verification: mocks.scheduling,
}));
beforeEach(() => {
  mocks.verify.mockReset();
  mocks.scheduling.mockReset();
});
let combinedOperatorFixture;
beforeAll(async () => {
  combinedOperatorFixture = await makeCombinedFixture();
}, 30000);
async function v2Fixture() {
  const f = fixture(),
    v = combinedOperatorFixture,
    rename = (x) =>
      Array.isArray(x)
        ? x.map(rename)
        : x && typeof x === "object"
          ? Object.fromEntries(
              Object.entries(x).map(([k, y]) => [k, rename(y)]),
            )
          : x === v.readerName
            ? f.p.readerName
            : x;
  const state = rename(v.fixtures[0]),
    hash = (x) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
  const scheduling = {
    source: v.descriptor,
    layouts: v.fixtures.map((x) => ({
      beforeCatalogSha256: catalogDigest(x.catalogs.before, { physical: true }),
      afterCatalogSha256: catalogDigest(x.catalogs.after, { physical: true }),
      beforePolicySha256: hash(rename(x.policyBefore)),
      afterPolicySha256: hash(rename(x.policyAfter)),
    })),
    coverage: v.oracle.scheduling.coverage,
  };
  const plan = custodyV2.prepareCombinedOperatorPlan({
    ...Object.fromEntries(
      [
        "runId",
        "backupId",
        "sourceSnapshotSha256",
        "profileSha256",
        "moduleManifestSha256",
        "preparedAt",
        "workMs",
        "cleanupMs",
        "maxCostUsdMicros",
      ].map((k) => [k, f.p[k]]),
    ),
    candidate: v.candidate,
    scheduling,
  });
  f.args.plan = plan;
  for (const [name, kind] of [
    ["verifyOwnerApproval", "owner-approval"],
    ["verifyCapabilityReview", "independent-capability-review"],
  ]) {
    const old = f.args[name];
    f.args[name] = async () => ({
      ...(await old()),
      kind,
      planSha256: operatorPlanDigest(plan),
    });
  }
  f.order = [];
  f.schedulingState = state;
  mocks.verify.mockImplementation(async (a) => {
    f.order.push("A-" + a.outcome);
    await a.reserve({
      attemptId: randomUUID(),
      outcome: a.outcome,
      database: "fly-db",
      sourceCommit: a.plan.sourceCommit,
    });
    await a.persist({
      phase: "precommit-verified",
      proof: {
        originalTables: 75,
        originalColumns: 849,
        newTablesEmpty: 67,
        defaultsVerified: 13,
      },
    });
    await a.persist({ phase: a.outcome + "-intent" });
    await a.persist({ phase: a.outcome + "-ack" });
    return {
      status: "verified-" + a.outcome,
      mechanism: {
        status:
          a.outcome === "commit"
            ? "committed-awaiting-reader"
            : "rehearsed-rolled-back",
        stepsAcknowledged: 19,
        commitDispatched: a.outcome === "commit",
        commitAcknowledged: a.outcome === "commit",
        rollbackAcknowledged: a.outcome === "rollback",
      },
      proof: {
        freshReaderVerified: a.outcome === "commit",
        extraPreserved: true,
        nonTargetDatabasesPreserved: true,
        originalTables: 75,
        originalColumns: 849,
        newTablesEmpty: 67,
        defaultsVerified: 13,
      },
    };
  });
  f.callbacks.schedulingContext = async ({ outcome, baseline }) => {
    f.order.push("B-context-" + outcome);
    expect(baseline === null).toBe(outcome === "rollback");
    const deltaPlan = prepareScheduling0019({
      source: v.schedulingSource,
      catalogs: state.catalogs,
      target: state.target,
      policyBefore: state.policyBefore,
      policyAfter: state.policyAfter,
      sourceBinding: {
        candidate: plan.candidate,
        moduleManifestSha256: plan.moduleManifestSha256,
      },
    });
    return {
      plan: deltaPlan,
      writer: { query: async () => ({}) },
      baseline: structuredClone(state.before),
      readFresh: async () =>
        structuredClone(outcome === "commit" ? state.after : state.before),
    };
  };
  mocks.scheduling.mockImplementation(async (a) => {
    f.order.push("B-" + a.outcome);
    await a.reserve({
      kind: "SCHEDULING0019_TRANSACTION_RESERVATION",
      attemptId: a.attemptId,
      database: "fly-db",
      sourceCommit: v.descriptor.sourceCommit,
      sourceSha256: v.descriptor.sha256,
      baselineSha256: "f".repeat(64),
      catalogSha256: catalogDigest(a.baseline.catalog, { physical: true }),
      policySha256: hash(a.baseline.policy),
      moduleManifestSha256: plan.moduleManifestSha256,
      candidate: plan.candidate,
      outcome: a.outcome,
    });
    for (const event of [
      { phase: "begin-intent" },
      { phase: "begin-ack", pid: 43 },
      {
        phase: "step-intent",
        path: v.descriptor.path,
        sha256: v.descriptor.sha256,
      },
      { phase: "step-ack", path: v.descriptor.path },
      {
        phase: "precommit-verified",
        proof: {
          originalTables: 142,
          originalColumns: 1867,
          newColumns: 3,
          nullColumnsVerified: 3,
        },
      },
      { phase: a.outcome + "-intent" },
      { phase: a.outcome + "-ack" },
    ])
      await a.persist(event);
    return {
      ...v.deltaResult(a.outcome),
      baselineSha256: "f".repeat(64),
      attemptId: a.attemptId,
    };
  });
  return f;
}
test("v2 cannot certify success from legacy-only callbacks and creates no copy", async () => {
  const f = await v2Fixture();
  try {
    delete f.callbacks.schedulingContext;
    const r = await runProduction75Operator(f.args);
    expect(r.status).toBe("held-before-create");
    expect(f.calls).toEqual([]);
    expect(mocks.verify).not.toHaveBeenCalled();
  } finally {
    f.cleanup();
  }
});
test("v2 orders both legacy outcomes before fresh full142 context and both scheduling outcomes", async () => {
  const f = await v2Fixture();
  try {
    const r = await runProduction75Operator(f.args);
    expect(r.status).toBe("verified-and-cleaned");
    expect(f.order).toEqual([
      "A-rollback",
      "A-commit",
      "B-context-rollback",
      "B-rollback",
      "B-context-commit",
      "B-commit",
    ]);
    expect(r.outcomes.scheduling.rollback.status).toBe("verified-rollback");
    expect(r.outcomes.scheduling.commit.status).toBe("verified-commit");
    expect(f.calls).toEqual(["create", "reader", "delete"]);
  } finally {
    f.cleanup();
  }
});
test.each(["target", "candidate", "manifest", "baseline", "policy"])(
  "v2 rejects dynamic %s mismatch before scheduling mutation while cleaning only its copy",
  async (kind) => {
    const f = await v2Fixture();
    try {
      const get = f.callbacks.schedulingContext;
      f.callbacks.schedulingContext = async (a) => {
        const c = await get(a);
        if (kind === "target") c.baseline.identity.database = "other-db";
        if (kind === "candidate")
          c.plan = {
            ...c.plan,
            sourceBinding: {
              ...c.plan.sourceBinding,
              candidate: {
                ...c.plan.sourceBinding.candidate,
                commit: "e".repeat(40),
              },
            },
          };
        if (kind === "manifest")
          c.plan = {
            ...c.plan,
            sourceBinding: {
              ...c.plan.sourceBinding,
              moduleManifestSha256: "e".repeat(64),
            },
          };
        if (kind === "baseline") c.baseline.fingerprints.pop();
        if (kind === "policy")
          c.baseline.policy.privileges.publicGrants.push({
            name: "projects",
            privilege_type: "UPDATE",
          });
        return c;
      };
      const r = await runProduction75Operator(f.args);
      expect(r.status).toBe("held-and-cleaned");
      expect(mocks.scheduling).not.toHaveBeenCalled();
      expect(f.calls).toEqual(["create", "reader", "delete"]);
    } finally {
      f.cleanup();
    }
  },
);
test("v2 held scheduling commit never creates a replacement or marks complete", async () => {
  const f = await v2Fixture();
  try {
    const verified = mocks.scheduling.getMockImplementation();
    mocks.scheduling.mockImplementation(async (a) => {
      const r = await verified(a);
      return a.outcome === "commit"
        ? { ...r, status: "verification-held-no-replay" }
        : r;
    });
    const r = await runProduction75Operator(f.args);
    expect(r.status).toBe("held-and-cleaned");
    expect(r.copyDeleted).toBe(true);
    expect(f.calls).toEqual(["create", "reader", "delete"]);
  } finally {
    f.cleanup();
  }
});
test("v2 captured scheduling callback survives caller replacement during identity await", async () => {
  const f = await v2Fixture();
  try {
    const verify = f.callbacks.verifyIdentity;
    f.callbacks.verifyIdentity = async () => {
      f.callbacks.schedulingContext = () => {
        throw Error("changed callback");
      };
      return verify();
    };
    expect((await runProduction75Operator(f.args)).status).toBe(
      "verified-and-cleaned",
    );
    expect(mocks.scheduling).toHaveBeenCalledTimes(2);
  } finally {
    f.cleanup();
  }
});
test("v2 refuses a successful legacy status without actual Reader and closure proof", async () => {
  const f = await v2Fixture();
  try {
    const original = mocks.verify.getMockImplementation();
    mocks.verify.mockImplementation(async (a) => ({
      ...(await original(a)),
      proof: {},
    }));
    const r = await runProduction75Operator(f.args);
    expect(r.status).toBe("held-and-cleaned");
    expect(mocks.scheduling).not.toHaveBeenCalled();
    expect(f.calls).toEqual(["create", "reader", "delete"]);
  } finally {
    f.cleanup();
  }
});
test("v2 lost scheduling COMMIT ACK only reconciles the one admitted copy", async () => {
  const f = await v2Fixture();
  try {
    const original = mocks.scheduling.getMockImplementation();
    mocks.scheduling.mockImplementation(async (a) => {
      const r = await original(a);
      return a.outcome === "commit"
        ? {
            ...r,
            status: "reconciled-commit-no-replay",
            proof: {
              ...r.proof,
              commitAcknowledged: false,
              journalConfirmed: false,
              transactionClosure: "unconfirmed",
              requiresOwningCleanup: true,
            },
          }
        : r;
    });
    const r = await runProduction75Operator(f.args);
    expect(r.status).toBe("verified-and-cleaned");
    expect(r.outcomes.scheduling.commit.status).toBe(
      "reconciled-commit-no-replay",
    );
    expect(f.calls).toEqual(["create", "reader", "delete"]);
  } finally {
    f.cleanup();
  }
});
test.each(["attempt-result", "other-layout-intent"])(
  "v2 refuses %s cross-binding inside the one scheduling attempt",
  async (kind) => {
    const f = await v2Fixture();
    try {
      const original = mocks.scheduling.getMockImplementation();
      mocks.scheduling.mockImplementation(async (a) => {
        if (kind === "other-layout-intent") {
          const reserve = a.reserve;
          return original({
            ...a,
            reserve: (intent) =>
              reserve({
                ...intent,
                catalogSha256:
                  f.args.plan.scheduling.layouts[1].beforeCatalogSha256,
              }),
          });
        }
        return { ...(await original(a)), attemptId: randomUUID() };
      });
      const r = await runProduction75Operator(f.args);
      expect(r.status).toBe("held-and-cleaned");
      expect(f.calls).toEqual(["create", "reader", "delete"]);
    } finally {
      f.cleanup();
    }
  },
);
function fixture(planChanges = {}) {
  const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "production75-operator-test-"),
    ),
    runId = randomUUID(),
    readerName = `growthos-reader-${runId.replaceAll("-", "")}`,
    d = deltaFixture(readerName),
    profile = expectedProduction75ReaderProfile(readerName),
    p = prepareOperatorPlan({
      runId,
      backupId: "backup_fixture",
      sourceSnapshotSha256: production75SnapshotDigest(d.before),
      profileSha256: production75ProfileDigest(profile),
      moduleManifestSha256: "a".repeat(64),
      preparedAt: Date.now(),
      workMs: 90000,
      cleanupMs: 30000,
      maxCostUsdMicros: 150000,
      ...planChanges,
    }),
    digest = operatorPlanDigest(p),
    copy = {
      id: "abcdefghijklmnop",
      name: p.copyName,
      organization: p.organization,
      version: 1,
      region: "iad",
      plan: "basic",
      status: "ready",
      attachedApps: [],
    },
    originals = [
      { ...copy, id: p.sourceCluster, name: "production" },
      { ...copy, id: p.protectedClusters[1], name: "staging", version: 2 },
    ],
    calls = [];
  let created = false,
    deleted = false;
  const api = {
    listClusters: async () => [
      ...originals,
      ...(created && !deleted ? [copy] : []),
    ],
    getCluster: async (id) =>
      id === copy.id
        ? deleted
          ? null
          : copy
        : originals.find((m) => m.id === id),
    listBackups: async () => [
      {
        id: p.backupId,
        status: "completed",
        type: "full",
        start: new Date(p.preparedAt - 120000).toISOString(),
        stop: new Date(p.preparedAt - 60000).toISOString(),
      },
    ],
    listUsers: async () => [],
    restoreCopy: async () => {
      calls.push("create");
      created = true;
      return copy;
    },
    createReader: async () => {
      calls.push("reader");
      return { name: readerName, role: "reader" };
    },
    deleteCopy: async () => {
      calls.push("delete");
      deleted = true;
      return { status: 202, acknowledged: true };
    },
  };
  const callbacks = {
    verifyIdentity: async () => ({
      account: p.account,
      organization: p.organization,
    }),
    moduleManifestSha256: async () => p.moduleManifestSha256,
    observeOriginals: async () => structuredClone(d.before),
    observeCopy: async (_copy, { readerName: r }) =>
      structuredClone(r ? d.after : d.before),
    verificationContext: async () => verificationFixture(d.after, readerName),
    closeResources: async () => ({ closed: true }),
    verifyProtected: async () => ({ unchanged: true }),
  };
  const auth = {
    verifyOwnerApproval: async () => ({
      authenticated: true,
      kind: "owner-approval",
      planSha256: digest,
      receiptSha256: "b".repeat(64),
      maxCopies: 1,
      maxCostUsdMicros: p.maxCostUsdMicros,
      expiresAt: p.cleanupUntil,
      sourceWritesAuthorized: false,
    }),
    verifyCapabilityReview: async () => ({
      authenticated: true,
      kind: "independent-capability-review",
      planSha256: digest,
      receiptSha256: "c".repeat(64),
      profileSha256: p.profileSha256,
      sourceSnapshotSha256: p.sourceSnapshotSha256,
      scope: "fixed-query-observation-with-inherited-capabilities",
      zeroDdlClusterWideVerified: false,
    }),
  };
  mocks.verify.mockImplementation(async (args) => {
    await args.reserve({
      attemptId: randomUUID(),
      outcome: args.outcome,
      database: "fly-db",
      sourceCommit: args.plan.sourceCommit,
    });
    return {
      status: `verified-${args.outcome}`,
      proof: { freshReaderVerified: true },
    };
  });
  return {
    root,
    p,
    copy,
    d,
    calls,
    api,
    callbacks,
    auth,
    args: {
      plan: p,
      custodyRoot: root,
      api,
      callbacks,
      ...auth,
      pause: async () => {},
    },
    cleanup() {
      const r = fs.realpathSync(root);
      if (
        path.dirname(r) !== fs.realpathSync(os.tmpdir()) ||
        !path.basename(r).startsWith("production75-operator-test-")
      )
        throw new Error("owned temp refused");
      fs.rmSync(r, { recursive: true });
    },
  };
}

test("idle driver failure crosses real transport and operator boundaries as bounded evidence with owned cleanup", async () => {
  const f = fixture(),
    live = createLiveTransportFixture();
  f.callbacks.verificationContext = async ({ resources }) => {
    await live.transport.verifyIdentity();
    const proxy = await live.transport.openProxy("abcdefghijklmnop", resources);
    const client = await live.transport.connect(
      proxy,
      "fly-db",
      { user: "fly-user", password: "fixture" },
      { readonly: true, resources },
    );
    client.emit(
      "error",
      Object.assign(Error("synthetic private credential and customer row"), {
        code: "25P03",
        severity: "FATAL",
        detail: "synthetic private row",
      }),
    );
    return withProduction75Stage("legacy-reader-state", () =>
      client.query("SELECT 1"),
    );
  };
  f.callbacks.closeResources = () => live.transport.close();
  try {
    const result = await runProduction75Operator(f.args);
    expect(result.callbackFailure).toEqual({
      callback: "legacy-context",
      stage: "legacy-reader-state",
      safeCode: "production75_live_client",
      sqlState: "25P03",
    });
    expect(result.status).toBe("held-and-cleaned");
    expect(result.resourcesClosed).toBe(true);
    expect(result.outcomes).toEqual({});
    expect(f.calls).toEqual(["create", "reader", "delete"]);
    expect(live.transport.metadata()).toMatchObject({
      clients: 1,
      clientsClosed: 1,
      socketsClosed: 1,
      proxies: 1,
      proxiesClosed: 1,
    });
    expect(JSON.stringify(result)).not.toContain("synthetic private");
  } finally {
    f.cleanup();
  }
});

test.each(["legacy", "scheduling"])(
  "%s observer preserves transport diagnostics through the real operator result after successful rollback",
  async (kind) => {
    const f = kind === "legacy" ? fixture() : await v2Fixture();
    const live = createLiveTransportFixture({
      queryFn: async (sql) => {
        if (sql === "ROLLBACK") return { rows: [] };
        throw Object.assign(Error("synthetic private database detail"), {
          code: "42501",
          severity: "ERROR",
        });
      },
    });
    const callback =
      kind === "legacy" ? "verificationContext" : "schedulingContext";
    f.callbacks[callback] = async ({ resources }) => {
      await live.transport.verifyIdentity();
      const proxy = await live.transport.openProxy(
        "abcdefghijklmnop",
        resources,
      );
      const client = await live.transport.connect(
        proxy,
        "fly-db",
        { user: "fly-user", password: "fixture" },
        { readonly: true, resources },
      );
      const identity = {
        database: "fly-db",
        login: f.p.readerName,
        role: f.p.readerName,
      };
      const principals = ["fly-user", f.p.readerName];
      const observer =
        kind === "legacy"
          ? createProduction75Observer({
              client,
              principals,
              identity,
              catalog75: combinedOperatorFixture.catalogs.legacy.fly75,
              catalog142: JSON.parse(
                fs.readFileSync(
                  new URL(
                    "../reports/production75-recovery-2026-10-11/catalog142-fly-db.json",
                    import.meta.url,
                  ),
                ),
              ),
            })
          : createScheduling0019Observer({
              client,
              principals,
              identity,
              catalogs: f.schedulingState.catalogs,
            });
      try {
        return await withProduction75Stage(`${kind}-reader-state`, () =>
          observer.query(IDENTITY_SQL),
        );
      } catch (error) {
        expect(error.safeCode).toBe(
          kind === "legacy"
            ? "production75_observer_database"
            : "scheduling0019_observer_database",
        );
        expect(error).not.toHaveProperty("code");
        expect(error).not.toHaveProperty("severity");
        throw error;
      } finally {
        await client.query("ROLLBACK");
      }
    };
    f.callbacks.closeResources = () => live.transport.close();
    try {
      const result = await runProduction75Operator(f.args);
      expect(JSON.parse(JSON.stringify(result)).callbackFailure).toEqual({
        callback: `${kind}-context`,
        stage: `${kind}-reader-state`,
        safeCode: "production75_live_query",
        sqlState: "42501",
      });
      expect(result).toMatchObject({
        status: "held-and-cleaned",
        errorCode: "production75_operator_callback",
        copyDeleted: true,
        resourcesClosed: true,
      });
      expect(f.calls).toEqual(["create", "reader", "delete"]);
      expect(mocks.scheduling).not.toHaveBeenCalled();
      if (kind === "legacy") expect(mocks.verify).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("synthetic private");
      expect(live.transport.metadata()).toMatchObject({
        clientsClosed: 1,
        socketsClosed: 1,
        proxiesClosed: 1,
      });
    } finally {
      f.cleanup();
    }
  },
);

test.each([
  "error",
  "string",
  "undefined",
  "null",
  "false",
  "zero",
  "empty",
  "getter",
  "proxy",
])(
  "callback diagnostics bound unknown %s values without reading hooks or weakening cleanup",
  async (kind) => {
    const f = fixture();
    let hooks = 0;
    const privateValue = "synthetic-customer-row-and-private-credential";
    let failure;
    if (kind === "error")
      failure = Object.assign(Error(privateValue), {
        safeCode: "production75_live_query",
        cause: privateValue,
      });
    if (kind === "string") failure = privateValue;
    if (kind === "null") failure = null;
    if (kind === "false") failure = false;
    if (kind === "zero") failure = 0;
    if (kind === "empty") failure = "";
    if (kind === "getter")
      failure = Object.defineProperties(
        {},
        {
          safeCode: {
            get() {
              hooks++;
              throw Error(privateValue);
            },
          },
          toJSON: {
            get() {
              hooks++;
              throw Error(privateValue);
            },
          },
        },
      );
    if (kind === "proxy") {
      const revoked = Proxy.revocable(
        {},
        {
          get() {
            hooks++;
            throw Error(privateValue);
          },
        },
      );
      revoked.revoke();
      failure = revoked.proxy;
    }
    f.callbacks.verificationContext = async () => {
      throw failure;
    };
    try {
      const result = await runProduction75Operator(f.args);
      expect(result.callbackFailure).toEqual({
        callback: "legacy-context",
        stage: "legacy-context",
        safeCode: "production75_diagnostic_unknown",
      });
      expect(result.errorCode).toBe("production75_operator_callback");
      expect(result.status).toBe("held-and-cleaned");
      expect(result.outcomes).toEqual({});
      expect(result.resourcesClosed).toBe(true);
      expect(f.calls).toEqual(["create", "reader", "delete"]);
      expect(JSON.stringify(result)).not.toContain(privateValue);
      expect(hooks).toBe(0);
      expect(mocks.verify).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  },
);
test("one copy/Reader, rollback then commit and owned deletion pass in order", async () => {
  const f = fixture();
  try {
    const result = await runProduction75Operator(f.args);
    expect(result).toMatchObject({
      status: "verified-and-cleaned",
      copyDeleted: true,
      originalsPreserved: true,
      readerProfileVerified: true,
    });
    expect(f.calls).toEqual(["create", "reader", "delete"]);
    expect(mocks.verify).toHaveBeenCalledTimes(2);
  } finally {
    f.cleanup();
  }
});

test("opaque non-ready waits before clone/Reader/SQL then progresses to ready", async () => {
  const f = fixture();
  try {
    let reads = 0,
      readySeen = false;
    const get = f.api.getCluster,
      observe = f.callbacks.observeCopy,
      reader = f.api.createReader;
    f.api.getCluster = async (id) => {
      const m = await get(id);
      if (!m || id !== f.copy.id) return m;
      if (++reads < 3) return { ...m, status: "not-ready" };
      readySeen = true;
      return m;
    };
    f.callbacks.observeCopy = async (...args) => {
      expect(readySeen).toBe(true);
      return observe(...args);
    };
    f.api.createReader = async (...args) => {
      expect(readySeen).toBe(true);
      return reader(...args);
    };
    const result = await runProduction75Operator(f.args);
    expect(result).toMatchObject({
      status: "verified-and-cleaned",
      copyDeleted: true,
      readerProfileVerified: true,
    });
    expect(reads).toBeGreaterThanOrEqual(3);
  } finally {
    f.cleanup();
  }
});
test("permanent opaque non-ready reaches deadline and uses only owned cleanup", async () => {
  const f = fixture();
  try {
    let clock = f.p.preparedAt;
    f.args.now = () => clock;
    f.args.pause = async () => {
      clock = f.p.workUntil;
    };
    const get = f.api.getCluster;
    f.api.getCluster = async (id) => {
      const m = await get(id);
      return m && id === f.copy.id ? { ...m, status: "not-ready" } : m;
    };
    const observe = vi.fn();
    f.callbacks.observeCopy = observe;
    const result = await runProduction75Operator(f.args);
    expect(result).toMatchObject({
      copyDeleted: true,
      resourcesClosed: true,
      status: "held-and-cleaned",
    });
    expect(f.calls).toEqual(["create", "delete"]);
    expect(observe).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
  } finally {
    f.cleanup();
  }
});
test("ambiguous creation never observes non-ready clone before reconciliation", async () => {
  const f = fixture();
  try {
    let readySeen = false,
      reads = 0;
    const restore = f.api.restoreCopy,
      get = f.api.getCluster,
      list = f.api.listClusters,
      observe = f.callbacks.observeCopy;
    f.api.restoreCopy = async (permit) => {
      await restore(permit);
      throw Error("lost create acknowledgment");
    };
    f.api.getCluster = async (id) => {
      const m = await get(id);
      if (!m || id !== f.copy.id) return m;
      if (++reads < 3) return { ...m, status: "not-ready" };
      readySeen = true;
      return m;
    };
    f.api.listClusters = async () =>
      (await list()).map((m) =>
        m.id === f.copy.id && !readySeen ? { ...m, status: "not-ready" } : m,
      );
    f.callbacks.observeCopy = async (...args) => {
      expect(readySeen).toBe(true);
      return observe(...args);
    };
    const result = await runProduction75Operator(f.args);
    expect(result).toMatchObject({
      copyDeleted: true,
      errorCode: "production75_operator_create_unknown_no_replay",
    });
    expect(f.calls).toEqual(["create", "delete"]);
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(mocks.verify).not.toHaveBeenCalled();
  } finally {
    f.cleanup();
  }
});
test.each(["version", "region", "plan"])(
  "readiness progression cannot admit %s drift",
  async (field) => {
    const f = fixture();
    try {
      let reads = 0;
      const get = f.api.getCluster,
        list = f.api.listClusters;
      const changed = (m) =>
        reads >= 2
          ? {
              ...m,
              [field]:
                field === "version" ? 2 : field === "region" ? "ord" : "large",
            }
          : { ...m, status: "not-ready" };
      f.api.getCluster = async (id) => {
        const m = await get(id);
        if (m && id === f.copy.id) {
          reads++;
          return changed(m);
        }
        return m;
      };
      f.api.listClusters = async () =>
        (await list()).map((m) => (m.id === f.copy.id ? changed(m) : m));
      const observe = vi.fn(async () => structuredClone(f.d.before));
      f.callbacks.observeCopy = observe;
      const result = await runProduction75Operator(f.args);
      expect(result).toMatchObject({
        copyDeleted: true,
        status: "held-and-cleaned",
      });
      expect(observe).not.toHaveBeenCalled();
      expect(f.calls).toEqual(["create", "delete"]);
      expect(mocks.verify).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  },
);

test.each([
  { httpStatus: 503, safeCode: "production75_v1_rejected_unknown" },
  { httpStatus: 200, safeCode: "production75_v1_response" },
  {
    httpStatus: 422,
    safeCode: "production75_v1_rejected_user_name_invalid",
    errors: { user_name: ["has invalid format"] },
  },
])(
  "Reader failure $httpStatus survives callback normalization while owned cleanup remains",
  async ({ httpStatus, safeCode, errors }) => {
    const f = fixture();
    try {
      const live = createProduction75V1Client({
        organization: "adam-diaz",
        getAuthorization: async () => "Bearer fixture",
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              data: { name: "private-provider-body", role: "reader" },
              ...(errors ? { errors } : {}),
            }),
            { status: httpStatus },
          ),
      });
      f.api.createReader = async (permit) => {
        f.calls.push("reader");
        return live.createReader(permit);
      };
      const result = await runProduction75Operator(f.args);
      expect(result).toMatchObject({
        status: "held-and-cleaned",
        errorCode: "production75_operator_callback",
        copyDeleted: true,
        originalsPreserved: true,
        resourcesClosed: true,
        providerFailure: {
          operation: "create-reader",
          method: "POST",
          httpStatus,
          safeCode,
        },
      });
      expect(f.calls).toEqual(["create", "reader", "delete"]);
      expect(mocks.verify).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("private-provider-body");
    } finally {
      f.cleanup();
    }
  },
);

test("work and uncertain deletion retain separate diagnostics without replay", async () => {
  const f = fixture();
  try {
    const live = createProduction75V1Client({
      organization: "adam-diaz",
      getAuthorization: async () => "Bearer fixture",
      fetchFn: async (_url, options) =>
        new Response("private-provider-body", {
          status: options.method === "DELETE" ? 500 : 503,
        }),
    });
    f.api.createReader = async (permit) => {
      f.calls.push("reader");
      return live.createReader(permit);
    };
    const remove = f.api.deleteCopy;
    f.api.deleteCopy = async (permit) => {
      await remove(permit);
      return live.deleteCopy(permit);
    };
    const result = await runProduction75Operator(f.args);
    expect(result).toMatchObject({
      status: "held-and-cleaned",
      copyDeleted: true,
      deleteAcknowledgmentUnknown: true,
      providerFailure: { operation: "create-reader", httpStatus: 503 },
      cleanupProviderFailure: { operation: "delete-copy", httpStatus: 500 },
    });
    expect(f.calls).toEqual(["create", "reader", "delete"]);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private-provider-body");
  } finally {
    f.cleanup();
  }
});

test.each([
  ["version", 2],
  ["region", "ord"],
  ["plan", "premium"],
  ["attachedApps", ["customer-app"]],
])(
  "explicit restore acknowledgment %s conflicts hold before copy reads but retain owned deletion",
  async (field, value) => {
    const f = fixture();
    try {
      const restore = f.api.restoreCopy;
      f.api.restoreCopy = async (permit) => ({
        ...(await restore(permit)),
        [field]: value,
      });
      const observe = f.callbacks.observeCopy;
      f.callbacks.observeCopy = vi.fn(observe);
      const r = await runProduction75Operator(f.args);
      expect(r).toMatchObject({
        status: "held-and-cleaned",
        copyDeleted: true,
        readerProfileVerified: false,
      });
      expect(f.calls).toEqual(["create", "delete"]);
      expect(f.callbacks.observeCopy).not.toHaveBeenCalled();
      expect(mocks.verify).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  },
);

test("measured Windows transport closure beyond ten seconds preserves verified cleanup", async () => {
  vi.useFakeTimers();
  const f = fixture({ cleanupMs: 180000 });
  try {
    let closes = 0;
    f.callbacks.closeResources = async () => {
      closes++;
      await new Promise((resolve) => setTimeout(resolve, 15000));
      return { closed: true };
    };
    const pending = runProduction75Operator(f.args);
    await vi.advanceTimersByTimeAsync(31000);
    expect(await pending).toMatchObject({
      status: "verified-and-cleaned",
      copyDeleted: true,
      originalsPreserved: true,
      resourcesClosed: true,
    });
    expect(closes).toBe(2);
    expect(f.calls).toEqual(["create", "reader", "delete"]);
  } finally {
    vi.useRealTimers();
    f.cleanup();
  }
});
test("missing or foreign admission has zero provider mutations", async () => {
  const f = fixture();
  try {
    f.args.verifyOwnerApproval = async () => true;
    expect(await runProduction75Operator(f.args)).toMatchObject({
      status: "held-before-create",
    });
    expect(f.calls).toEqual([]);
  } finally {
    f.cleanup();
  }
});
test.each(["account", "manifest", "source", "backup"])(
  "wrong %s holds before create",
  async (kind) => {
    const f = fixture();
    try {
      if (kind === "account")
        f.callbacks.verifyIdentity = async () => ({
          account: "foreign",
          organization: f.p.organization,
        });
      else if (kind === "manifest")
        f.callbacks.moduleManifestSha256 = async () => "0".repeat(64);
      else if (kind === "source")
        f.callbacks.observeOriginals = async () => {
          const s = structuredClone(f.d.before);
          s.databases[0].fingerprints[0].digest = "0".repeat(32);
          return s;
        };
      else f.api.listBackups = async () => [];
      expect(await runProduction75Operator(f.args)).toMatchObject({
        status: "held-before-create",
      });
      expect(f.calls).toEqual([]);
    } finally {
      f.cleanup();
    }
  },
);
test("lost create acknowledgment only reconciles and cleans; it cannot create Reader or run SQL", async () => {
  const f = fixture();
  try {
    const create = f.api.restoreCopy;
    f.api.restoreCopy = async (permit) => {
      await create(permit);
      throw new Error("private lost acknowledgment");
    };
    expect(await runProduction75Operator(f.args)).toMatchObject({
      status: "held-and-cleaned",
      copyDeleted: true,
    });
    expect(f.calls).toEqual(["create", "delete"]);
    expect(mocks.verify).not.toHaveBeenCalled();
  } finally {
    f.cleanup();
  }
});
test.each(["role", "delta", "rollback", "commit"])(
  "failure in %s cleans owned copy without replay",
  async (kind) => {
    const f = fixture();
    try {
      if (kind === "role")
        f.api.createReader = async () => {
          f.calls.push("reader");
          throw new Error("private role reply");
        };
      else if (kind === "delta")
        f.callbacks.observeCopy = async (_c, { readerName }) => {
          const s = structuredClone(readerName ? f.d.after : f.d.before);
          if (readerName)
            s.databases[0].extra.roles.find(
              (r) => r.name === readerName,
            ).create_role = true;
          return s;
        };
      else
        mocks.verify.mockImplementation(async (a) => {
          await a.reserve({
            attemptId: randomUUID(),
            outcome: a.outcome,
            database: "fly-db",
            sourceCommit: a.plan.sourceCommit,
          });
          return {
            status:
              a.outcome === kind
                ? "verification-held-no-replay"
                : `verified-${a.outcome}`,
          };
        });
      expect(await runProduction75Operator(f.args)).toMatchObject({
        status: "held-and-cleaned",
        copyDeleted: true,
      });
      expect(f.calls.filter((x) => x === "create")).toHaveLength(1);
      expect(f.calls.filter((x) => x === "reader")).toHaveLength(1);
      expect(f.calls.filter((x) => x === "delete")).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  },
);
test("source drift does not strand an owned copy and is reported", async () => {
  const f = fixture();
  try {
    f.callbacks.verifyProtected = async () => ({ unchanged: false });
    const result = await runProduction75Operator(f.args);
    expect(result).toMatchObject({
      status: "held-and-cleaned",
      copyDeleted: true,
      originalsPreserved: false,
    });
    expect(f.calls.at(-1)).toBe("delete");
  } finally {
    f.cleanup();
  }
});
test("lost DELETE reply is reconciled with reads and never resent", async () => {
  const f = fixture();
  try {
    const remove = f.api.deleteCopy;
    f.api.deleteCopy = async (permit) => {
      await remove(permit);
      throw new Error("private delete reply");
    };
    expect(await runProduction75Operator(f.args)).toMatchObject({
      status: "verified-and-cleaned",
      copyDeleted: true,
    });
    expect(f.calls.filter((x) => x === "delete")).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});
test("unknown create with no ownership proof is reported as possible paid resource", async () => {
  const f = fixture();
  try {
    f.api.restoreCopy = async () => {
      f.calls.push("create");
      throw new Error("lost reply");
    };
    expect(await runProduction75Operator(f.args)).toMatchObject({
      status: "held-owner-action-required",
      creationAttempted: true,
      copyDeleted: false,
    });
    expect(f.calls).toEqual(["create"]);
  } finally {
    f.cleanup();
  }
});
test("closure runs again after final source reads", async () => {
  const f = fixture();
  try {
    let closes = 0;
    f.callbacks.closeResources = async () => {
      closes++;
      return { closed: true };
    };
    await runProduction75Operator(f.args);
    expect(closes).toBe(2);
  } finally {
    f.cleanup();
  }
});
test("slow original observations run after owned DELETE and cannot starve it", async () => {
  const f = fixture();
  try {
    let clock = f.p.preparedAt;
    f.args.now = () => clock;
    f.callbacks.verifyProtected = async () => {
      clock = f.p.cleanupUntil + 1;
      return { unchanged: true };
    };
    const result = await runProduction75Operator(f.args);
    expect(f.calls.at(-1)).toBe("delete");
    expect(result.copyDeleted).toBe(true);
    expect(result.originalsPreserved).toBe(false);
  } finally {
    f.cleanup();
  }
});
test("expired callback cannot acquire a connection after final shutdown", async () => {
  const f = fixture();
  let late,
    closes = 0;
  try {
    let clock = f.p.preparedAt;
    f.args.now = () => clock;
    f.callbacks.observeCopy = async (_c, options) => {
      late = () =>
        options.resources.acquire(
          async () => ({}),
          async () => {
            closes++;
          },
        );
      clock = f.p.workUntil + 1;
      return structuredClone(f.d.before);
    };
    const r = await runProduction75Operator(f.args);
    expect(r).toMatchObject({ copyDeleted: true, resourcesClosed: true });
    await expect(late()).rejects.toMatchObject({
      safeCode: "production75_operator_resources",
    });
    expect(closes).toBe(0);
  } finally {
    f.cleanup();
  }
});
test("pending connection cannot report closed and is disposed when it arrives late", async () => {
  let arrive,
    disposed = 0;
  const r = createOperatorResources({ until: Date.now() + 10000 }),
    pending = r.acquire(
      () =>
        new Promise((resolve) => {
          arrive = resolve;
        }),
      async () => {
        disposed++;
      },
    );
  expect(await r.drain()).toEqual({ closed: false });
  arrive({});
  await expect(pending).rejects.toMatchObject({
    safeCode: "production75_operator_resources",
  });
  expect(disposed).toBe(1);
  expect(await r.drain()).toEqual({ closed: true });
});
test("SQL dispatch refuses an expired operator clock", async () => {
  let clock = 100;
  const r = createOperatorResources({ now: () => clock, until: 200 }),
    query = vi.fn();
  clock = 200;
  await expect(r.query({ query }, "COMMIT")).rejects.toMatchObject({
    safeCode: "production75_operator_resources",
  });
  expect(query).not.toHaveBeenCalled();
});
test("hanging shutdown is bounded and owned deletion still happens", async () => {
  vi.useFakeTimers();
  const f = fixture({ cleanupMs: 180000 });
  try {
    f.callbacks.closeResources = async () => new Promise(() => {});
    const pending = runProduction75Operator(f.args);
    await vi.advanceTimersByTimeAsync(61000);
    expect(f.calls).toContain("delete");
    await vi.advanceTimersByTimeAsync(61000);
    expect(await pending).toMatchObject({
      copyDeleted: true,
      resourcesClosed: false,
      status: "held-and-cleaned",
    });
  } finally {
    vi.useRealTimers();
    f.cleanup();
  }
});
test("minimum cleanup window keeps deletion time after hanging shutdown", async () => {
  vi.useFakeTimers();
  const f = fixture({ cleanupMs: 10000 });
  try {
    const verify = mocks.verify.getMockImplementation();
    mocks.verify.mockImplementation(async (args) => {
      const result = await verify(args);
      if (args.outcome === "commit") vi.setSystemTime(f.p.workUntil - 1);
      return result;
    });
    let closes = 0;
    f.callbacks.closeResources = async () =>
      ++closes === 1 ? new Promise(() => {}) : { closed: true };
    const pending = runProduction75Operator(f.args);
    await vi.advanceTimersByTimeAsync(2600);
    expect(f.calls).toContain("delete");
    expect(await pending).toMatchObject({
      copyDeleted: true,
      originalsPreserved: true,
      status: "held-and-cleaned",
    });
  } finally {
    vi.useRealTimers();
    f.cleanup();
  }
});
test.each(["target-data", "other-data", "roles", "settings", "policy"])(
  "context cannot rebaseline %s drift",
  async (kind) => {
    const f = fixture();
    try {
      const context = f.callbacks.verificationContext;
      f.callbacks.verificationContext = async (args) => {
        const c = await context(args);
        if (kind === "target-data") c.baseline.state.fingerprints[0].rows++;
        if (kind === "other-data")
          c.baseline.otherDatabases[0].fingerprints[0].rows++;
        if (kind === "roles") c.baseline.extra.roles[0].superuser = true;
        if (kind === "settings")
          c.baseline.extra.roleSettings.push({
            role: "reader",
            setting: "changed",
          });
        if (kind === "policy") c.plan.policies[75].ownership[0].acl = "changed";
        return c;
      };
      const r = await runProduction75Operator(f.args);
      expect(r).toMatchObject({
        status: "held-and-cleaned",
        copyDeleted: true,
        errorCode: "production75_operator_verification_context",
      });
      expect(mocks.verify).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  },
);

test("measured53s original proof fits after deletion without widening paid requests", async () => {
  const f = fixture({ cleanupMs: 180000 });
  try {
    let clock = f.p.preparedAt,
      reads = 0;
    f.args.now = () => clock;
    f.callbacks.observeOriginals = async () => {
      if (++reads === 2) {
        expect(f.calls.at(-1)).toBe("delete");
        clock += 53138;
      }
      return structuredClone(f.d.before);
    };
    const result = await runProduction75Operator(f.args);
    expect(result).toMatchObject({
      status: "verified-and-cleaned",
      copyDeleted: true,
      originalsPreserved: true,
      resourcesClosed: true,
    });
    expect(f.calls).toEqual(["create", "reader", "delete"]);
  } finally {
    f.cleanup();
  }
});
test("slow deletion retains30s bound and its dispatched effect is never replayed", async () => {
  const f = fixture({ cleanupMs: 180000 });
  try {
    let clock = f.p.preparedAt;
    f.args.now = () => clock;
    const remove = f.api.deleteCopy;
    f.api.deleteCopy = async (permit) => {
      const r = await remove(permit);
      clock += 35000;
      return r;
    };
    const result = await runProduction75Operator(f.args);
    expect(f.calls.filter((c) => c === "delete")).toHaveLength(1);
    expect(result).toMatchObject({
      copyDeleted: true,
      deleteAcknowledgmentUnknown: true,
    });
  } finally {
    f.cleanup();
  }
});
