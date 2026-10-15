import { beforeAll, test, expect, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  buildScheduling0019Source,
  prepareScheduling0019,
  captureScheduling0019State,
  assertScheduling0019Preserved,
  runScheduling0019Verification,
} from "./production75-scheduling0019.mjs";
import {
  IDENTITY_SQL,
  OWNERSHIP_SQL,
  PRODUCTION75_PRIVILEGE_QUERIES,
} from "./production75-core.mjs";
import {
  CATALOG_QUERIES,
  catalogDigest,
} from "../reports/release-preparation-2026-10-09/schema-catalog.mjs";
import {
  makeScheduling0019Fixture,
  withScheduling0019Database,
} from "./production75-scheduling0019-test-support.mjs";
let fixtures;
beforeAll(async () => {
  fixtures = await Promise.all(
    [0, 1].map((layout) => makeScheduling0019Fixture({ layout })),
  );
}, 30000);
const input = (f) => ({
  source: buildScheduling0019Source(f.sourceInput),
  catalogs: f.catalogs,
  target: f.target,
  policyBefore: f.policyBefore,
  policyAfter: f.policyAfter,
  sourceBinding: f.sourceBinding,
});
test.each([0, 1])(
  "exact source and complete layout %i preserve142/1867 through1870 and three NULL additions",
  (layout) => {
    const f = fixtures[layout],
      i = input(f),
      plan = prepareScheduling0019(i);
    expect(i.source.bytes).toBe(8126);
    expect(Object.isFrozen(plan.catalogs.before.columns)).toBe(true);
    expect(f.before.catalog.tables).toHaveLength(142);
    expect(f.before.catalog.columns).toHaveLength(1867);
    expect(f.after.catalog.columns).toHaveLength(1870);
    expect(Object.values(f.after.nullCounts)).toEqual(["0", "0", "0"]);
    expect(() =>
      assertScheduling0019Preserved(f.before, f.after, plan, "post0019"),
    ).not.toThrow();
    expect(() =>
      assertScheduling0019Preserved(f.before, f.before, plan, "pre0019"),
    ).not.toThrow();
    expect(JSON.stringify(plan)).not.toContain("ALTER TABLE");
  },
);

// Transport-boundary transaction model. Catalog/data expectations come only
// from independently executed T2 fixtures; native transactions remain T6 proof.
function transactionFixture(options = {}) {
  const f = fixtures[0],
    baseline = structuredClone(f.before),
    plan = prepareScheduling0019(input(f));
  const calls = [],
    events = [],
    reservations = [];
  let transaction = false,
    phase = "pre0019",
    committed = "pre0019",
    readerCalls = 0,
    ddlDispatches = 0;
  const writerIdentity = {
    ...baseline.identity,
    login: "fly-user",
    role: "schema_admin",
    pid: 77,
    read_only: "off",
    isolation: "read committed",
  };
  const state = () => (phase === "post0019" ? f.after : f.before);
  const writer = {
    query: async (sql, args) => {
      calls.push(["query", sql]);
      if (options.query) return options.query(sql, args, defaultQuery);
      return defaultQuery(sql, args);
    },
  };
  async function defaultQuery(sql, args) {
    if (sql === IDENTITY_SQL)
      return {
        rows: [
          {
            ...writerIdentity,
            isolation: transaction ? "repeatable read" : "read committed",
            ...options.writerIdentity,
          },
        ],
      };
    if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ") {
      transaction = true;
      return options.beginAck ?? { command: "BEGIN" };
    }
    if (sql.startsWith("SET LOCAL "))
      return sql
        .split(";")
        .filter((s) => s.trim())
        .map(() => ({ command: "SET" }));
    if (sql.startsWith("LOCK TABLE ")) return { command: "LOCK" };
    if (sql === f.sourceInput.bytes.toString("utf8")) {
      ddlDispatches++;
      phase = "post0019";
      if (options.sourceError) throw options.sourceError;
      return (
        options.sourceAck ??
        Array.from({ length: 6 }, () => ({ command: "ALTER" }))
      );
    }
    if (sql === "COMMIT") {
      transaction = false;
      committed = phase;
      if (options.commitError) throw options.commitError;
      return options.commitAck ?? { command: "COMMIT" };
    }
    if (sql === "ROLLBACK") {
      transaction = false;
      phase = "pre0019";
      if (options.rollbackError) throw options.rollbackError;
      return options.rollbackAck ?? { command: "ROLLBACK" };
    }
    const catalogKey = Object.keys(CATALOG_QUERIES).find(
      (k) => CATALOG_QUERIES[k] === sql,
    );
    if (catalogKey) {
      const catalog = structuredClone(state().catalog);
      if (options.partialAfter && phase === "post0019") catalog.columns.pop();
      return { rows: catalog[catalogKey] };
    }
    if (sql === OWNERSHIP_SQL)
      return { rows: structuredClone(state().policy.ownership) };
    const policyKey = Object.keys(PRODUCTION75_PRIVILEGE_QUERIES).find(
      (k) => PRODUCTION75_PRIVILEGE_QUERIES[k] === sql,
    );
    if (policyKey)
      return { rows: structuredClone(state().policy.privileges[policyKey]) };
    const table = /FROM public\."([a-z_]+)"/.exec(sql)?.[1],
      fingerprint = state().fingerprints.find((x) => x.table === table);
    if (sql.includes("AS mismatches")) return { rows: [{ mismatches: "0" }] };
    if (fingerprint && sql.includes("AS bytes FROM"))
      return { rows: [{ rows: fingerprint.rows, bytes: fingerprint.bytes }] };
    if (fingerprint && sql.includes("AS hashes"))
      return { rows: [{ rows: fingerprint.rows, digest: fingerprint.digest }] };
    throw Error("unexpected synthetic dispatch");
  }
  const args = {
    writer,
    plan,
    baseline,
    outcome: options.outcome ?? "rollback",
    attemptId: randomUUID(),
    reserve: async (intent) => {
      calls.push(["reserve"]);
      reservations.push(intent);
      return options.reserve ? options.reserve(intent) : true;
    },
    persist: async (event) => {
      calls.push(["persist", event.phase]);
      events.push(event);
      if (options.persist) return options.persist(event);
    },
    readFresh: async () => {
      calls.push(["readFresh"]);
      readerCalls++;
      if (options.readFresh) return options.readFresh(readerCalls);
      const s = structuredClone(committed === "post0019" ? f.after : f.before);
      s.identity.pid = 88 + readerCalls;
      return s;
    },
    ...(options.now ? { now: options.now } : {}),
  };
  return {
    args,
    calls,
    events,
    reservations,
    writer,
    plan,
    baseline,
    get ddlDispatches() {
      return ddlDispatches;
    },
  };
}
const queryCalls = (f) =>
  f.calls.filter((c) => c[0] === "query").map((c) => c[1]);
test.each(["rollback", "commit"])(
  "transaction %s reserves durably, dispatches exact SQL once, and verifies independent Reader",
  async (outcome) => {
    const f = transactionFixture({ outcome }),
      result = await runScheduling0019Verification(f.args);
    expect(result.status).toBe(`verified-${outcome}`);
    expect(f.ddlDispatches).toBe(1);
    expect(f.calls.findIndex((c) => c[0] === "reserve")).toBeLessThan(
      f.calls.findIndex(
        (c) => c[1] === "BEGIN ISOLATION LEVEL REPEATABLE READ",
      ),
    );
    expect(queryCalls(f).filter((s) => s.includes("ALTER TABLE"))).toEqual([
      fixtures[0].sourceInput.bytes.toString("utf8"),
    ]);
    const end = queryCalls(f).indexOf(outcome.toUpperCase());
    expect(
      queryCalls(f)
        .slice(0, end)
        .filter((s) => s.includes("AS mismatches")),
    ).toHaveLength(3);
    expect(f.events.map((e) => e.phase)).toEqual([
      "begin-intent",
      "begin-ack",
      "step-intent",
      "step-ack",
      "precommit-verified",
      `${outcome}-intent`,
      `${outcome}-ack`,
    ]);
    expect(result.proof.freshReaderVerified).toBe(true);
    expect(result.proof.transactionClosure).toBe(`acknowledged-${outcome}`);
    expect(JSON.stringify(result)).not.toContain("ALTER TABLE");
    expect(JSON.stringify(result)).not.toContain("Preserve Ω");
  },
);
test("reservation binds exact stable baseline digests and never serializes SQL or ephemeral identity", async () => {
  const f = transactionFixture(),
    result = await runScheduling0019Verification(f.args),
    intent = f.reservations[0],
    base = fixtures[0].before;
  const digest = (v) =>
      createHash("sha256").update(JSON.stringify(v)).digest("hex"),
    catalogSha256 = catalogDigest(base.catalog, { physical: true }),
    policySha256 = digest(base.policy),
    fingerprints = [...base.fingerprints]
      .sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0))
      .map(({ table, rows, bytes, digest }) => ({
        table,
        rows,
        bytes,
        digest,
      }));
  const baselineSha256 = digest({
    phase: "pre0019",
    catalogSha256,
    fingerprints,
    policySha256,
    nullCounts: {},
  });
  expect(intent).toEqual({
    kind: "SCHEDULING0019_TRANSACTION_RESERVATION",
    attemptId: f.args.attemptId,
    database: "fly-db",
    sourceCommit: fixtures[0].sourceInput.sourceCommit,
    sourceSha256:
      "76e88d3410235f1b6a8a20e595b126455fd5711b46f87055b586786b28f81ca9",
    baselineSha256,
    catalogSha256,
    policySha256,
    moduleManifestSha256: f.plan.sourceBinding.moduleManifestSha256,
    candidate: f.plan.sourceBinding.candidate,
    outcome: "rollback",
  });
  expect(Object.isFrozen(intent.candidate)).toBe(true);
  expect(result.baselineSha256).toBe(baselineSha256);
});
test("baseline and callback references are captured before the first await", async () => {
  const f = transactionFixture(),
    original = f.args.persist,
    pending = runScheduling0019Verification(f.args);
  f.args.baseline.fingerprints[0].digest = "a".repeat(32);
  f.args.persist = () => {
    throw Error("mutated callback");
  };
  f.writer.query = () => {
    throw Error("mutated writer method");
  };
  const result = await pending;
  expect(result.status).toBe("verified-rollback");
  expect(f.events).toHaveLength(7);
  expect(original).not.toBe(f.args.persist);
});
test("constructor rejects callback accessors before invoking hooks or consuming attempts", async () => {
  const f = transactionFixture();
  let reads = 0;
  const args = { ...f.args };
  Object.defineProperty(args, "persist", {
    enumerable: true,
    get: () => {
      reads++;
      return f.args.persist;
    },
  });
  await expect(runScheduling0019Verification(args)).rejects.toMatchObject({
    safeCode: "scheduling0019_verification_input",
  });
  expect(reads).toBe(0);
  expect(f.calls).toHaveLength(0);
});
test("writer backend drift after LOCK blocks DDL and unsafe terminal cleanup", async () => {
  let identities = 0;
  const f = transactionFixture({
      query: async (sql, args, next) => {
        const response = await next(sql, args);
        if (sql === IDENTITY_SQL && ++identities > 1) response.rows[0].pid = 78;
        return response;
      },
    }),
    result = await runScheduling0019Verification(f.args);
  expect(result.status).toBe("verification-held-no-replay");
  expect(f.ddlDispatches).toBe(0);
  expect(queryCalls(f).filter((s) => s.startsWith("LOCK TABLE"))).toHaveLength(
    1,
  );
  expect(queryCalls(f)).not.toContain("ROLLBACK");
  expect(result.proof.requiresOwningCleanup).toBe(true);
});
test("RR locks precede the first SELECT so a concurrent pre-lock commit blocks DDL", async () => {
  let inTransaction = false,
    locked = false,
    changedCommittedData = false,
    snapshot = null,
    sourceCommitted = false;
  const f = transactionFixture({
      outcome: "commit",
      query: async (sql, args, next) => {
        if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ")
          inTransaction = true;
        // Model a concurrent writer committing immediately before lock acquisition.
        if (sql.startsWith("LOCK TABLE")) {
          changedCommittedData = true;
          locked = true;
        }
        if (inTransaction && sql.startsWith("SELECT") && snapshot === null)
          snapshot = { changed: changedCommittedData, beforeLock: !locked };
        const response = await next(sql, args);
        if (
          sql.includes("AS hashes") &&
          sql.includes('FROM public."appointment_work_entries"') &&
          snapshot?.changed
        )
          response.rows[0].digest = "a".repeat(32);
        if (sql === "COMMIT") {
          sourceCommitted = true;
          inTransaction = false;
        }
        if (sql === "ROLLBACK") inTransaction = false;
        return response;
      },
      readFresh: async (n) => {
        const state = structuredClone(
          sourceCommitted ? fixtures[0].after : fixtures[0].before,
        );
        state.identity.pid = 89 + n;
        if (changedCommittedData)
          state.fingerprints.find(
            (x) => x.table === "appointment_work_entries",
          ).digest = "a".repeat(32);
        return state;
      },
    }),
    result = await runScheduling0019Verification(f.args);
  expect(f.ddlDispatches).toBe(0);
  expect(queryCalls(f)).not.toContain("COMMIT");
  expect(snapshot.beforeLock).toBe(false);
  expect(result.proof.preimageVerified).toBe(false);
  const sql = queryCalls(f),
    begin = sql.indexOf("BEGIN ISOLATION LEVEL REPEATABLE READ"),
    lock = sql.findIndex((s) => s.startsWith("LOCK TABLE")),
    firstSelect = sql.findIndex((s, i) => i > begin && s.startsWith("SELECT"));
  expect(lock).toBeLessThan(firstSelect);
  expect(sql[lock].match(/public\."[a-z_]+"/g)).toHaveLength(142);
});
test("reservation denial and persistence failure before BEGIN never dispatch DDL", async () => {
  for (const options of [
    { reserve: async () => false },
    {
      persist: async () => {
        throw Error("private journal detail");
      },
    },
  ]) {
    const f = transactionFixture(options),
      result = await runScheduling0019Verification(f.args);
    expect(result.status).toBe("failed-or-held");
    expect(f.ddlDispatches).toBe(0);
    expect(queryCalls(f)).not.toContain(
      "BEGIN ISOLATION LEVEL REPEATABLE READ",
    );
    expect(JSON.stringify(result)).not.toContain("private journal");
  }
});
test("late sixth statement error rolls the actual transaction back and never dispatches a down migration", async () => {
  const f = transactionFixture({
      sourceError: Object.assign(Error("private sixth CHECK"), {
        code: "23514",
      }),
    }),
    result = await runScheduling0019Verification(f.args);
  expect(f.ddlDispatches).toBe(1);
  expect(queryCalls(f)).toContain("ROLLBACK");
  expect(queryCalls(f).filter((s) => s.includes("DROP"))).toEqual([]);
  expect(result.status).toBe("failed-or-held");
  expect(result.proof.rollbackAcknowledged).toBe(true);
  expect(JSON.stringify(result)).not.toContain("private sixth");
});
test.each([
  { beginAck: {} },
  { sourceAck: [{ command: "ALTER" }] },
  { sourceAck: Array.from({ length: 6 }, () => ({ command: "SELECT" })) },
  { commitAck: { command: "ROLLBACK" }, outcome: "commit" },
  { rollbackAck: { command: "COMMIT" } },
])(
  "missing/contradictory ACK %j cannot verify the requested transaction",
  async (options) => {
    const f = transactionFixture(options),
      result = await runScheduling0019Verification(f.args);
    expect(result.status).not.toBe(`verified-${f.args.outcome}`);
    expect(f.ddlDispatches).toBeLessThanOrEqual(1);
  },
);
test("lost COMMIT reconciles through independent full post-state with no replay", async () => {
  const f = transactionFixture({
      outcome: "commit",
      commitError: Error("lost COMMIT private"),
    }),
    result = await runScheduling0019Verification(f.args);
  expect(result.status).toBe("reconciled-commit-no-replay");
  expect(result.proof.commitAcknowledged).toBe(false);
  expect(result.proof.freshReaderVerified).toBe(true);
  expect(f.ddlDispatches).toBe(1);
  expect(queryCalls(f)).not.toContain("ROLLBACK");
  await expect(
    runScheduling0019Verification({ ...f.args, attemptId: randomUUID() }),
  ).rejects.toMatchObject({ safeCode: "scheduling0019_verification_replay" });
  expect(f.ddlDispatches).toBe(1);
});
test("lost ROLLBACK stays held even when Reader sees the original preimage", async () => {
  const f = transactionFixture({ rollbackError: Error("lost ROLLBACK") }),
    result = await runScheduling0019Verification(f.args);
  expect(result.status).toBe("verification-held-no-replay");
  expect(result.proof.rollbackAcknowledged).toBe(false);
  expect(queryCalls(f).filter((s) => s === "ROLLBACK")).toHaveLength(1);
  expect(f.ddlDispatches).toBe(1);
});
test.each([
  { database: "other-db" },
  { login: "fly-user", role: "schema_admin", read_only: "off" },
  { pid: 77 },
  { isolation: "read committed" },
  { version: 160015 },
])("fresh Reader identity %j cannot complete verification", async (change) => {
  const f = transactionFixture({
      readFresh: async (n) => {
        const state = structuredClone(fixtures[0].before);
        state.identity.pid = 89;
        if (n > 1) Object.assign(state.identity, change);
        return state;
      },
    }),
    result = await runScheduling0019Verification(f.args);
  expect(result.status).toBe("verification-held-no-replay");
  expect(f.ddlDispatches).toBe(1);
});
test.each(["post0019", "partial"])(
  "already observed %s never acquires a new ALTER reservation",
  async (phase) => {
    const f = transactionFixture({
        outcome: "commit",
        readFresh: async () => {
          const s = structuredClone(fixtures[0].after);
          s.identity.pid = 89;
          if (phase === "partial") s.catalog.columns.pop();
          return s;
        },
      }),
      result = await runScheduling0019Verification(f.args);
    expect(f.reservations).toHaveLength(0);
    expect(f.ddlDispatches).toBe(0);
    expect(result.status).toBe(
      phase === "post0019" ? "reconciled-commit-no-replay" : "failed-or-held",
    );
  },
);
test("partial after-DDL catalog causes rollback rather than a terminal commit", async () => {
  const f = transactionFixture({ outcome: "commit", partialAfter: true }),
    result = await runScheduling0019Verification(f.args);
  expect(result.status).toBe("failed-or-held");
  expect(queryCalls(f)).toContain("ROLLBACK");
  expect(queryCalls(f)).not.toContain("COMMIT");
});
test.each(["step-ack", "commit-ack"])(
  "persistence rejection at %s cannot erase dispatch or ACK evidence",
  async (failure) => {
    const f = transactionFixture({
        outcome: "commit",
        persist: async (event) => {
          if (event.phase === failure)
            throw Error("private persistence detail");
        },
      }),
      result = await runScheduling0019Verification(f.args);
    expect(f.ddlDispatches).toBe(1);
    expect(result.status).toBe(
      failure === "commit-ack"
        ? "reconciled-commit-no-replay"
        : "failed-or-held",
    );
    expect(result.proof.commitAcknowledged).toBe(failure === "commit-ack");
    expect(queryCalls(f).filter((s) => s === "ROLLBACK")).toHaveLength(
      failure === "commit-ack" ? 0 : 1,
    );
  },
);
test("late source response holds without queueing another mutation", async () => {
  let clock = 0;
  const f = transactionFixture({
      now: () => clock,
      query: async (sql, args, next) => {
        const result = await next(sql, args);
        if (sql === fixtures[0].sourceInput.bytes.toString("utf8"))
          clock = 15001;
        return result;
      },
    }),
    result = await runScheduling0019Verification(f.args);
  expect(result.status).toBe("verification-held-no-replay");
  expect(f.ddlDispatches).toBe(1);
  expect(queryCalls(f)).not.toContain("ROLLBACK");
  expect(queryCalls(f)).not.toContain("COMMIT");
  expect(result.proof.requiresOwningCleanup).toBe(true);
});
test("unresolved source timeout does not close owner socket or enqueue rollback after late resolution", async () => {
  vi.useFakeTimers();
  let resolve;
  let destroyed = 0;
  try {
    const f = transactionFixture({
      query: async (sql, args, next) => {
        const value = await next(sql, args);
        if (sql === fixtures[0].sourceInput.bytes.toString("utf8"))
          return new Promise((r) => {
            resolve = () => r(value);
          });
        return value;
      },
    });
    f.writer.connection = { stream: { destroy: () => destroyed++ } };
    const pending = runScheduling0019Verification(f.args);
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(15001);
    const result = await pending;
    expect(result.status).toBe("verification-held-no-replay");
    const length = f.calls.length;
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.calls).toHaveLength(length);
    expect(queryCalls(f)).not.toContain("ROLLBACK");
    expect(destroyed).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
test("unresolved journal callback after DDL holds without rollback or late progression", async () => {
  vi.useFakeTimers();
  let release;
  try {
    const f = transactionFixture({
        persist: async (event) => {
          if (event.phase === "step-ack")
            return new Promise((resolve) => {
              release = resolve;
            });
        },
      }),
      pending = runScheduling0019Verification(f.args);
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(5001);
    const result = await pending;
    expect(result.status).toBe("verification-held-no-replay");
    expect(result.proof.sourceAcknowledged).toBe(true);
    expect(result.proof.journalConfirmed).toBe(false);
    expect(f.ddlDispatches).toBe(1);
    expect(queryCalls(f)).not.toContain("ROLLBACK");
    const length = f.calls.length;
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.calls).toHaveLength(length);
  } finally {
    vi.useRealTimers();
  }
});
test("late reservation and already applied rollback never BEGIN or rearm", async () => {
  let clock = 0;
  const late = transactionFixture({
      now: () => clock,
      reserve: async () => {
        clock = 5001;
        return true;
      },
    }),
    lateResult = await runScheduling0019Verification(late.args);
  expect(lateResult.status).toBe("failed-or-held");
  expect(queryCalls(late)).not.toContain(
    "BEGIN ISOLATION LEVEL REPEATABLE READ",
  );
  const applied = transactionFixture({
      readFresh: async () => structuredClone(fixtures[0].after),
    }),
    result = await runScheduling0019Verification(applied.args);
  expect(result.status).toBe("verification-held-no-replay");
  expect(applied.reservations).toHaveLength(0);
  expect(applied.ddlDispatches).toBe(0);
});
test("one-use guards bind attempt, writer and plan independently", async () => {
  const original = transactionFixture();
  await runScheduling0019Verification(original.args);
  for (const field of ["attemptId", "writer", "plan"]) {
    const next = transactionFixture();
    next.args[field] = original.args[field];
    await expect(
      runScheduling0019Verification(next.args),
    ).rejects.toMatchObject({ safeCode: "scheduling0019_verification_replay" });
    expect(next.calls).toHaveLength(0);
  }
});
test("changed full142 Reader data prevents successful rollback acceptance", async () => {
  const f = transactionFixture({
      readFresh: async (n) => {
        const state = structuredClone(fixtures[0].before);
        state.identity.pid = 89;
        if (n > 1)
          state.fingerprints.find(
            (x) => x.table === "appointment_work_entries",
          ).digest = "a".repeat(32);
        return state;
      },
    }),
    result = await runScheduling0019Verification(f.args);
  expect(result.status).toBe("verification-held-no-replay");
  expect(result.proof.rollbackAcknowledged).toBe(true);
  expect(result.proof.freshReaderVerified).toBe(false);
});
test("source rejects byte drift, CRLF, wrong source/path and unknown keys", () => {
  const f = fixtures[0];
  for (const change of [
    { bytes: Buffer.concat([f.sourceInput.bytes, Buffer.from(" ")]) },
    {
      bytes: Buffer.from(
        f.sourceInput.bytes.toString().replaceAll("\n", "\r\n"),
      ),
    },
    { sourceCommit: "a".repeat(40) },
    { path: "0019.sql" },
    { extra: true },
  ])
    expect(() =>
      buildScheduling0019Source({ ...f.sourceInput, ...change }),
    ).toThrow(/scheduling0019_source/);
  const same = Buffer.from(f.sourceInput.bytes);
  same[100] ^= 1;
  expect(() =>
    buildScheduling0019Source({ ...f.sourceInput, bytes: same }),
  ).toThrow(/scheduling0019_source/);
});
test("closed plan rejects forged source, unknown keys and invalid candidate binding", () => {
  const f = fixtures[0],
    i = input(f);
  for (const changes of [
    { source: { ...i.source } },
    { extra: true },
    {
      sourceBinding: {
        ...i.sourceBinding,
        moduleManifestSha256: "A".repeat(64),
      },
    },
    {
      sourceBinding: {
        ...i.sourceBinding,
        candidate: { ...i.sourceBinding.candidate, commit: "a".repeat(39) },
      },
    },
    { target: { ...i.target, database: "other-db" } },
    {
      target: {
        ...i.target,
        readerLogin: "reader",
        readerRole: "reader",
        principals: ["reader", "fly-user"],
      },
    },
  ])
    expect(() => prepareScheduling0019({ ...i, ...changes })).toThrow(
      /scheduling0019_/,
    );
  expect(() =>
    assertScheduling0019Preserved(
      f.before,
      f.after,
      { ...prepareScheduling0019(i) },
      "post0019",
    ),
  ).toThrow(/scheduling0019_plan/);
});
test("142 count alone, partial schema changes and relaxed checks cannot admit a catalog", () => {
  const f = fixtures[0],
    i = input(f);
  for (const mutate of [
    (c) => {
      c.before.columns[0].ordinal++;
    },
    (c) => {
      c.after.columns.pop();
    },
    (c) => {
      c.after.constraints.find(
        (x) => x.name === "org_settings_scheduling_policy_ck",
      ).definition = "CHECK (true)";
    },
    (c) => {
      c.after.tables[0].name = "pg_authid";
    },
  ]) {
    const catalogs = structuredClone(f.catalogs);
    mutate(catalogs);
    expect(() => prepareScheduling0019({ ...i, catalogs })).toThrow(
      /scheduling0019_catalog/,
    );
  }
});
test("policy validation rejects missing coverage, old ACL changes and added privilege drift", () => {
  const f = fixtures[0],
    i = input(f);
  for (const mutate of [
    (p) => p.privileges.columns.pop(),
    (p) => {
      p.ownership[0].acl = "changed";
    },
    (p) => {
      p.privileges.columns.find((c) => c.name === "scheduling_policy").update =
        true;
    },
  ]) {
    const policyAfter = structuredClone(f.policyAfter);
    mutate(policyAfter);
    expect(() => prepareScheduling0019({ ...i, policyAfter })).toThrow(
      /scheduling0019_policy/,
    );
  }
});
test("state rejects changed value with same count, incomplete/duplicate coverage and unsafe count conversion", () => {
  const f = fixtures[0],
    plan = prepareScheduling0019(input(f));
  for (const mutate of [
    (s) => {
      s.fingerprints.find(
        (x) => x.table === "appointment_work_entries",
      ).digest = "a".repeat(32);
    },
    (s) => s.fingerprints.pop(),
    (s) => {
      s.fingerprints[1] = s.fingerprints[0];
    },
    (s) => {
      s.fingerprints[0].rows = 0;
    },
    (s) => {
      s.fingerprints[0].bytes = "9007199254740993";
    },
    (s) => {
      s.nullCounts["org_settings.scheduling_policy"] = "1";
    },
    (s) => {
      s.extra = true;
    },
  ]) {
    const after = structuredClone(f.after);
    mutate(after);
    expect(() =>
      assertScheduling0019Preserved(f.before, after, plan, "post0019"),
    ).toThrow(/scheduling0019_/);
  }
});
test("fingerprint output order does not change a complete multiset", () => {
  const f = fixtures[0],
    after = structuredClone(f.after);
  after.fingerprints.reverse();
  expect(() =>
    assertScheduling0019Preserved(
      f.before,
      after,
      prepareScheduling0019(input(f)),
      "post0019",
    ),
  ).not.toThrow();
});
test("hidden constructor keys and accessor metadata cannot bypass closed input validation", () => {
  const f = fixtures[0],
    sourceInput = { ...f.sourceInput };
  Object.defineProperty(sourceInput, "hidden", { value: true });
  expect(() => buildScheduling0019Source(sourceInput)).toThrow(
    /scheduling0019_source/,
  );
  const accessor = { ...f.sourceInput };
  Object.defineProperty(accessor, "bytes", {
    enumerable: true,
    get: () => f.sourceInput.bytes,
  });
  expect(() => buildScheduling0019Source(accessor)).toThrow(
    /scheduling0019_source/,
  );
  const i = input(f);
  Object.defineProperty(i, "hidden", { value: true });
  expect(() => prepareScheduling0019(i)).toThrow(/scheduling0019_/);
});
test("nested hidden source-binding and catalog fields remain unknown keys", () => {
  const f = fixtures[0];
  for (const path of [
    "sourceBinding",
    "catalogs",
    "target",
    "policyBefore",
    "policyAfter",
  ]) {
    const i = input(f);
    i[path] = structuredClone(i[path]);
    Object.defineProperty(i[path], "hidden", { value: "unapproved" });
    expect(() => prepareScheduling0019(i)).toThrow(/scheduling0019_/);
  }
});
test("same-server version is retained while exact guarded writer/off observation is accepted", () => {
  const f = fixtures[0],
    plan = prepareScheduling0019(input(f)),
    writer = structuredClone(f.after);
  Object.assign(writer.identity, {
    login: "fly-user",
    role: "schema_admin",
    read_only: "off",
    pid: 43,
  });
  expect(() =>
    assertScheduling0019Preserved(f.before, writer, plan, "post0019"),
  ).not.toThrow();
  writer.identity.version = 160015;
  expect(() =>
    assertScheduling0019Preserved(f.before, writer, plan, "post0019"),
  ).toThrow(/scheduling0019_identity/);
});
test(
  "capture rejects unsafe backend counts before hashing or converting to numbers",
  async () =>
    withScheduling0019Database({}, async (f, { clientFor }) => {
      const plan = prepareScheduling0019(input(f));
      for (const value of ["9007199254740993", -1, 1, "01", "1000001"]) {
        const real = clientFor(),
          client = {
            query: async (sql, args) =>
              sql.includes("AS bytes FROM")
                ? { rows: [{ rows: value, bytes: "1" }] }
                : real.query(sql, args),
          };
        await expect(
          captureScheduling0019State(client, plan),
        ).rejects.toMatchObject({ safeCode: "scheduling0019_fingerprint" });
      }
    }),
  30000,
);
test(
  "real embedded queries catch changed late-stage data and duplicate multiplicity independent of output order",
  async () =>
    withScheduling0019Database({}, async (f, { db, clientFor }) => {
      const plan = prepareScheduling0019(input(f)),
        observed = await captureScheduling0019State(clientFor(), plan);
      expect(() =>
        assertScheduling0019Preserved(f.before, observed, plan, "post0019"),
      ).not.toThrow();
      const reversed = await captureScheduling0019State(
        clientFor("post0019", (sql) =>
          sql.replace(
            'FROM public."appointment_work_entries"',
            'FROM (SELECT * FROM public."appointment_work_entries" ORDER BY id DESC) AS reversed',
          ),
        ),
        plan,
      );
      expect(reversed.fingerprints).toEqual(observed.fingerprints);
      const duplicated = await captureScheduling0019State(
        clientFor("post0019", (sql) =>
          sql.replace(
            'FROM public."appointment_work_entries"',
            `FROM (SELECT * FROM public."appointment_work_entries" WHERE id='00000000-0000-4000-8000-000000000011' UNION ALL SELECT * FROM public."appointment_work_entries" WHERE id='00000000-0000-4000-8000-000000000011') AS duplicates`,
          ),
        ),
        plan,
      );
      const originalEntry = observed.fingerprints.find(
          (x) => x.table === "appointment_work_entries",
        ),
        duplicatedEntry = duplicated.fingerprints.find(
          (x) => x.table === "appointment_work_entries",
        );
      expect(duplicatedEntry.rows).toBe(originalEntry.rows);
      expect(duplicatedEntry.bytes).toBe(originalEntry.bytes);
      expect(duplicatedEntry.digest).not.toBe(originalEntry.digest);
      expect(() =>
        assertScheduling0019Preserved(f.before, duplicated, plan, "post0019"),
      ).toThrow(/scheduling0019_data/);
      await db.exec(
        "UPDATE appointment_work_entries SET notes='changed same row count'",
      );
      const changed = await captureScheduling0019State(clientFor(), plan);
      expect(
        changed.fingerprints.find((x) => x.table === "appointment_work_entries")
          .rows,
      ).toBe("2");
      expect(() =>
        assertScheduling0019Preserved(f.before, changed, plan, "post0019"),
      ).toThrow(/scheduling0019_data/);
    }),
  30000,
);
