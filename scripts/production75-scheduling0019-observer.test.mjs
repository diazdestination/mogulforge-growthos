import { beforeAll, test, expect } from "vitest";
import { createScheduling0019Observer } from "./production75-scheduling0019-observer.mjs";
import {
  captureScheduling0019State,
  prepareScheduling0019,
  buildScheduling0019Source,
} from "./production75-scheduling0019.mjs";
import {
  makeScheduling0019Fixture,
  withScheduling0019Database,
} from "./production75-scheduling0019-test-support.mjs";
import {
  IDENTITY_SQL,
  PRODUCTION75_PRIVILEGE_QUERIES,
} from "./production75-core.mjs";
import { CATALOG_QUERIES } from "../reports/release-preparation-2026-10-09/schema-catalog.mjs";
let f;
beforeAll(async () => {
  f = await makeScheduling0019Fixture();
}, 30000);
function fixture(extra = {}) {
  const calls = [],
    client = {
      query: async (sql, args) => {
        calls.push([sql, args]);
        return { rows: sql === IDENTITY_SQL ? [f.before.identity] : [] };
      },
    };
  return {
    calls,
    observer: createScheduling0019Observer({
      client,
      principals: f.target.principals,
      catalogs: f.catalogs,
      identity: {
        database: "fly-db",
        login: f.target.readerLogin,
        role: f.target.readerRole,
      },
      ...extra,
    }),
  };
}
test.each([
  "SELECT 1",
  "SELECT * FROM public.appointment_work_entries",
  "BEGIN READ ONLY",
  "SELECT 1; DELETE FROM users",
])("closed observer refuses %s", async (sql) => {
  const { observer, calls } = fixture();
  await expect(observer.query(sql)).rejects.toMatchObject({
    safeCode: "scheduling0019_observer_query",
  });
  expect(calls).toHaveLength(0);
});
test("nested toJSON substitution cannot register injected caller SQL", () => {
  const catalogs = structuredClone(f.catalogs),
    original = { ...catalogs.before.tables[0] },
    calls = [];
  const injected = 'x") AS original; SELECT 123 AS injected; --';
  for (const catalog of [catalogs.before, catalogs.after]) {
    const row = catalog.tables[0];
    row.name = injected;
    Object.defineProperty(row, "toJSON", { value: () => original });
  }
  expect(() =>
    fixture({
      catalogs,
      client: {
        query: async (...args) => {
          calls.push(args);
          return { rows: [f.before.identity] };
        },
      },
    }),
  ).toThrow(/scheduling0019_catalog/);
  expect(calls).toHaveLength(0);
});
test.each([
  "accessor",
  "hidden",
  "symbol",
  "enumerable-toJSON",
  "array-hidden",
  "array-accessor",
  "nested-array-hidden",
  "nested-array-accessor",
  "array-toJSON",
  "custom-prototype",
  "proxy",
])("nested catalog %s is rejected without invoking hooks or client", (kind) => {
  // Retained constraints share fixture references; isolate each attack setup so
  // constructing the second layout cannot read the first layout's accessor.
  const catalogs = {
      before: structuredClone(f.catalogs.before),
      after: structuredClone(f.catalogs.after),
    },
    calls = [],
    hiddenSymbol = Symbol("hidden");
  let hookReads = 0;
  for (const catalog of [catalogs.before, catalogs.after]) {
    const row = catalog.tables[0];
    if (kind === "accessor") {
      const name = row.name;
      Object.defineProperty(row, "name", {
        enumerable: true,
        get: () => {
          hookReads++;
          return name;
        },
      });
    }
    if (kind === "hidden")
      Object.defineProperty(row, "hidden", { value: true });
    if (kind === "symbol") row[hiddenSymbol] = true;
    if (kind === "enumerable-toJSON")
      row.toJSON = () => {
        hookReads++;
        return { ...row, toJSON: undefined };
      };
    if (kind === "array-hidden")
      Object.defineProperty(catalog.tables, "hidden", { value: true });
    if (kind === "array-accessor") {
      const original = catalog.tables[0];
      Object.defineProperty(catalog.tables, "0", {
        enumerable: true,
        get: () => {
          hookReads++;
          return original;
        },
      });
    }
    if (kind === "nested-array-hidden")
      Object.defineProperty(catalog.constraints[0].columns, "hidden", {
        value: true,
      });
    if (kind === "nested-array-accessor") {
      const columns = catalog.constraints.find(
          (c) => c.columns.length > 0,
        ).columns,
        original = columns[0];
      Object.defineProperty(columns, "0", {
        enumerable: true,
        get: () => {
          hookReads++;
          return original;
        },
      });
    }
    if (kind === "array-toJSON")
      Object.defineProperty(catalog.tables, "toJSON", {
        value: () => {
          hookReads++;
          return [...catalog.tables];
        },
      });
    if (kind === "custom-prototype")
      Object.setPrototypeOf(row, {
        toJSON: () => {
          hookReads++;
          return row;
        },
      });
    if (kind === "proxy")
      catalog.tables[0] = new Proxy(row, {
        getOwnPropertyDescriptor(...args) {
          hookReads++;
          return Reflect.getOwnPropertyDescriptor(...args);
        },
      });
  }
  expect(() =>
    fixture({
      catalogs,
      client: {
        query: async (...args) => {
          calls.push(args);
          return { rows: [] };
        },
      },
    }),
  ).toThrow(/scheduling0019_catalog/);
  expect(hookReads).toBe(0);
  expect(calls).toHaveLength(0);
});
test("post-construction catalog mutation cannot add registry queries", async () => {
  const catalogs = structuredClone(f.catalogs),
    { observer, calls } = fixture({ catalogs });
  const injected = 'x") AS original; SELECT 123 AS injected; --';
  catalogs.before.tables[0].name = injected;
  const sql = `SELECT count(*)::text AS rows,COALESCE(sum(octet_length(row_to_json(original)::text)),0)::text AS bytes FROM (SELECT  FROM public."${injected}") AS original`;
  await expect(observer.query(sql)).rejects.toMatchObject({
    safeCode: "scheduling0019_observer_query",
  });
  expect(calls).toHaveLength(0);
  await observer.query(CATALOG_QUERIES.tables);
  expect(calls.map((c) => c[0])).toEqual([
    IDENTITY_SQL,
    CATALOG_QUERIES.tables,
  ]);
});
test("caller-added args, objects, principals and malformed bounds are refused before dispatch", async () => {
  const { observer, calls } = fixture();
  for (const [sql, args] of [
    [{ text: CATALOG_QUERIES.tables }, undefined],
    [CATALOG_QUERIES.tables, ["bad"]],
    [CATALOG_QUERIES.tables, { length: 0 }],
    [PRODUCTION75_PRIVILEGE_QUERIES.tables, [["bad"]]],
  ])
    await expect(observer.query(sql, args)).rejects.toMatchObject({
      safeCode: "scheduling0019_observer_query",
    });
  expect(calls).toHaveLength(0);
  for (const change of [
    { limits: { queryMs: 15001 } },
    { limits: { unrelated: 1 } },
    { extra: true },
    {
      identity: { database: "fly-db", login: "fly-user", role: "schema_admin" },
    },
  ])
    expect(() => fixture(change)).toThrow(/scheduling0019_observer/);
});
test.each([
  { database: "other" },
  { login: "other" },
  { role: "schema_admin" },
  { version: 170000 },
  { pid: 0 },
  { read_only: "off" },
  { isolation: "read committed" },
])("wrong identity %j blocks dispatch", async (change) => {
  const calls = [],
    { observer } = fixture({
      client: {
        query: async (sql) => {
          calls.push(sql);
          return { rows: [{ ...f.before.identity, ...change }] };
        },
      },
    });
  await expect(observer.query(CATALOG_QUERIES.tables)).rejects.toMatchObject({
    safeCode: "scheduling0019_observer_identity",
  });
  expect(calls).toEqual([IDENTITY_SQL]);
});
test("backend PID change poisons the observer and overlapping use is rejected", async () => {
  let n = 0;
  const { observer } = fixture({
    client: {
      query: async (sql) => ({
        rows:
          sql === IDENTITY_SQL ? [{ ...f.before.identity, pid: 42 + n++ }] : [],
      }),
    },
  });
  await observer.query(CATALOG_QUERIES.tables);
  await expect(observer.query(CATALOG_QUERIES.tables)).rejects.toMatchObject({
    safeCode: "scheduling0019_observer_identity",
  });
  let release;
  const o = fixture({
      client: {
        query: async () =>
          new Promise((r) => {
            release = r;
          }),
      },
    }).observer,
    p = o.query(IDENTITY_SQL);
  await Promise.resolve();
  await expect(o.query(IDENTITY_SQL)).rejects.toMatchObject({
    safeCode: "scheduling0019_observer_unusable",
  });
  release({ rows: [f.before.identity] });
  await p;
});
test("expired operation/query and backend details remain bounded and redacted", async () => {
  let now = 0;
  const { observer, calls } = fixture({
    now: () => now,
    limits: { operationMs: 10 },
  });
  now = 11;
  await expect(observer.query(IDENTITY_SQL)).rejects.toMatchObject({
    safeCode: "scheduling0019_observer_deadline",
  });
  expect(calls).toHaveLength(0);
  const hang = fixture({
    limits: { queryMs: 5 },
    client: { query: () => new Promise(() => {}) },
  }).observer;
  await expect(hang.query(IDENTITY_SQL)).rejects.toMatchObject({
    safeCode: "scheduling0019_observer_deadline",
  });
  await expect(hang.query(IDENTITY_SQL)).rejects.toMatchObject({
    safeCode: "scheduling0019_observer_unusable",
  });
  const broken = fixture({
    client: {
      query: async () => {
        throw Object.assign(Error("private parameter"), {
          safeCode: "scheduling0019_observer_bound",
        });
      },
    },
  }).observer;
  await expect(broken.query(IDENTITY_SQL)).rejects.toThrow(
    /^scheduling0019_observer_database$/,
  );
});
test("late query results and malformed/oversized metadata poison subsequent reads", async () => {
  let clock = 0;
  const late = fixture({
    now: () => clock,
    limits: { queryMs: 5, operationMs: 100 },
    client: {
      query: async () => {
        clock += 10;
        return { rows: [f.before.identity] };
      },
    },
  }).observer;
  await expect(late.query(IDENTITY_SQL)).rejects.toMatchObject({
    safeCode: "scheduling0019_observer_deadline",
  });
  for (const result of [
    { rows: null },
    { rows: [f.before.identity], large: true },
  ]) {
    const { observer } = fixture({
      limits: { metadataBytes: 3 },
      client: { query: async () => result },
    });
    await expect(observer.query(IDENTITY_SQL)).rejects.toMatchObject({
      safeCode: "scheduling0019_observer_bound",
    });
    await expect(observer.query(IDENTITY_SQL)).rejects.toMatchObject({
      safeCode: "scheduling0019_observer_unusable",
    });
  }
});
test(
  "full142 fixed registry captures real embedded aggregate queries with existing collectors",
  async () =>
    withScheduling0019Database({}, async (f, { clientFor }) => {
      const observer = createScheduling0019Observer({
        client: clientFor(),
        principals: f.target.principals,
        catalogs: f.catalogs,
        identity: {
          database: "fly-db",
          login: f.target.readerLogin,
          role: f.target.readerRole,
        },
      });
      const plan = prepareScheduling0019({
        source: buildScheduling0019Source(f.sourceInput),
        catalogs: f.catalogs,
        target: f.target,
        policyBefore: f.policyBefore,
        policyAfter: f.policyAfter,
        sourceBinding: f.sourceBinding,
      });
      const state = await captureScheduling0019State(observer, plan);
      expect(state.fingerprints).toEqual(f.after.fingerprints);
      expect(state.nullCounts).toEqual(f.after.nullCounts);
    }),
  30000,
);
