/** Closed supplied-client Reader observer. Caller owns its read-only transaction. */
import { isDeepStrictEqual } from "node:util";
import { CATALOG_QUERIES } from "../reports/release-preparation-2026-10-09/schema-catalog.mjs";
import {
  PRODUCTION75_PRIVILEGE_QUERIES,
  OWNERSHIP_SQL,
  IDENTITY_SQL,
} from "./production75-core.mjs";
import { PRODUCTION75_EXTRA_QUERIES } from "./production75-observer.mjs";
import { assertScheduling0019Catalogs } from "./production75-scheduling0019.mjs";
const MAX = Object.freeze({
  metadataRows: 20000,
  metadataBytes: 8000000,
  operationMs: 240000,
  queryMs: 15000,
});
const errors = new WeakMap();
const safe = (code) => {
  const e = Object.assign(Error(`scheduling0019_observer_${code}`), {
    safeCode: `scheduling0019_observer_${code}`,
  });
  errors.set(e, code);
  return e;
};
const check = (ok, code) => {
  if (!ok) throw safe(code);
};
const keys = (v) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Reflect.ownKeys(v).every(
    (k) =>
      typeof k === "string" &&
      Object.getOwnPropertyDescriptor(v, k)?.enumerable &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(v, k), "value"),
  )
    ? Reflect.ownKeys(v).sort().join(",")
    : null;
const q = (v) => {
  check(typeof v === "string" && /^[a-z_][a-z0-9_]*$/.test(v), "catalog");
  return `"${v}"`;
};
export function createScheduling0019Observer(input = {}) {
  check(
    keys(input) !== null &&
      Object.keys(input).every((k) =>
        [
          "client",
          "principals",
          "catalogs",
          "identity",
          "limits",
          "now",
        ].includes(k),
      ),
    "input",
  );
  const {
    client,
    principals,
    catalogs,
    identity,
    limits = {},
    now = Date.now,
  } = input;
  check(
    client && typeof client.query === "function" && typeof now === "function",
    "input",
  );
  check(
    Array.isArray(principals) &&
      principals.length >= 2 &&
      principals.length <= 8 &&
      principals.every(
        (n) => typeof n === "string" && /^[a-z_][a-z0-9_-]{0,62}$/.test(n),
      ) &&
      new Set(principals).size === principals.length &&
      principals.includes("fly-user"),
    "principals",
  );
  check(
    keys(identity) === "database,login,role" &&
      identity.database === "fly-db" &&
      /^growthos-reader-[a-f0-9]{32}$/.test(identity.login ?? "") &&
      identity.role === identity.login &&
      principals.includes(identity.login),
    "identity",
  );
  const admittedCatalogs = assertScheduling0019Catalogs(catalogs);
  check(
    keys(limits) !== null &&
      Object.keys(limits).every((k) => Object.hasOwn(MAX, k)),
    "limits",
  );
  const bound = { ...MAX, ...limits };
  check(
    Object.entries(bound).every(
      ([k, v]) => Number.isSafeInteger(v) && v > 0 && v <= MAX[k],
    ),
    "limits",
  );
  const expected = structuredClone(identity),
    actors = structuredClone(principals),
    registry = new Map();
  const add = (sql, args) =>
    registry.set(sql, args === undefined ? undefined : structuredClone(args));
  for (const sql of [
    ...Object.values(CATALOG_QUERIES),
    OWNERSHIP_SQL,
    IDENTITY_SQL,
    ...Object.values(PRODUCTION75_EXTRA_QUERIES),
  ])
    add(sql);
  for (const sql of Object.values(PRODUCTION75_PRIVILEGE_QUERIES))
    add(sql, sql.includes("$1") ? [actors] : undefined);
  for (const table of admittedCatalogs.before.tables) {
    const columns = admittedCatalogs.before.columns
        .filter((c) => c.table_name === table.name)
        .sort((a, b) => a.ordinal - b.ordinal),
      projection = `(SELECT ${columns.map((c) => q(c.name)).join(",")} FROM public.${q(table.name)}) AS original`;
    add(
      `SELECT count(*)::text AS rows,COALESCE(sum(octet_length(row_to_json(original)::text)),0)::text AS bytes FROM ${projection}`,
    );
    add(
      `SELECT count(*)::text AS rows,md5(COALESCE(string_agg(h,'' ORDER BY h COLLATE "C"),'')) AS digest FROM (SELECT md5(row_to_json(original)::text) AS h FROM ${projection}) AS hashes`,
    );
  }
  for (const [table, column] of [
    ["appointments", "scheduling_reservation"],
    ["org_settings", "scheduling_policy"],
    ["projects", "scheduling_reservation"],
  ])
    add(
      `SELECT count(*)::text AS mismatches FROM public.${q(table)} WHERE ${q(column)} IS NOT NULL`,
    );
  const start = now();
  check(Number.isFinite(start), "input");
  const until = start + bound.operationMs;
  let pid = null,
    busy = false,
    unusable = false;
  const remaining = () => {
    const ms = until - now();
    check(Number.isFinite(ms) && ms > 0, "deadline");
    return Math.min(ms, bound.queryMs);
  };
  async function dispatch(sql, args) {
    let timer;
    try {
      const ms = remaining(),
        queryUntil = now() + ms;
      const r = await Promise.race([
        Promise.resolve().then(() => client.query(sql, args)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(safe("deadline")), ms);
        }),
      ]);
      check(now() < queryUntil, "deadline");
      remaining();
      check(
        r &&
          Array.isArray(r.rows) &&
          r.rows.length <= bound.metadataRows &&
          Buffer.byteLength(JSON.stringify(r.rows)) <= bound.metadataBytes,
        "bound",
      );
      return r;
    } catch (e) {
      unusable = true;
      throw safe(errors.get(e) ?? "database");
    } finally {
      clearTimeout(timer);
    }
  }
  return Object.freeze({
    query: async (sql, args) => {
      check(args === undefined || Array.isArray(args), "query");
      let parameters;
      try {
        parameters =
          args === undefined || args.length === 0
            ? undefined
            : structuredClone(args);
      } catch {
        throw safe("query");
      }
      check(
        typeof sql === "string" &&
          registry.has(sql) &&
          isDeepStrictEqual(parameters, registry.get(sql)),
        "query",
      );
      check(!busy && !unusable, "unusable");
      remaining();
      busy = true;
      try {
        const id = await dispatch(IDENTITY_SQL),
          row = id.rows[0];
        check(
          id.rows.length === 1 &&
            keys(row) ===
              "database,isolation,login,pid,read_only,role,version" &&
            Object.entries(expected).every(([k, v]) => row[k] === v) &&
            row.read_only === "on" &&
            row.isolation === "repeatable read" &&
            Number.isInteger(row.version) &&
            row.version >= 160000 &&
            row.version < 170000 &&
            Number.isInteger(row.pid) &&
            row.pid > 0 &&
            (pid === null || pid === row.pid),
          "identity",
        );
        pid = row.pid;
        return sql === IDENTITY_SQL ? id : await dispatch(sql, parameters);
      } catch (e) {
        unusable = true;
        throw e;
      } finally {
        busy = false;
      }
    },
  });
}
