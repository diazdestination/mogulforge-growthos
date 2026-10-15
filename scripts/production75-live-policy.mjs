/** Independent native oracle additions over a measured baseline. Never live DDL. */
import { isDeepStrictEqual } from "node:util";
const check = (ok, code) => {
  if (!ok) throw Object.assign(new Error(code), { safeCode: code });
};
const freeze = (v) => {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
const cmp = (a, b) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;
const KEYS = {
  ownership: ["kind", "schema", "name", "sub_name"],
  tables: ["principal", "name"],
  columns: ["principal", "table_name", "name"],
  roles: ["principal", "name"],
  memberships: ["role", "member", "grantor"],
};
const ordered = (rows, section) =>
  [...rows].sort((a, b) => {
    for (const key of KEYS[section] ?? []) {
      const c = cmp(a[key] ?? null, b[key] ?? null);
      if (c) return c;
    }
    return 0;
  });
const rename = (v, oldName, newName) =>
  Array.isArray(v)
    ? v.map((x) => rename(x, oldName, newName))
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v).map(([k, x]) => [k, rename(x, oldName, newName)]),
        )
      : v === oldName
        ? newName
        : v;
export function deriveLivePolicies({
  baseline,
  oracle,
  readerName,
  templateReader,
} = {}) {
  check(
    baseline?.ownership &&
      baseline.privileges &&
      oracle?.[75] &&
      oracle[95] &&
      oracle[142] &&
      typeof readerName === "string" &&
      /^growthos-reader-[a-f0-9]{32}$/.test(readerName) &&
      typeof templateReader === "string" &&
      // Legacy oracle templates retain their original private grammar only here.
      (/^growthos_reader_[a-z0-9_]{1,32}$/.test(templateReader) ||
        /^growthos-reader-[a-f0-9]{32}$/.test(templateReader)),
    "production75_live_policy_input",
  );
  const templates = rename(structuredClone(oracle), templateReader, readerName),
    base = templates[75];
  check(
    Object.keys(baseline.privileges).sort().join(",") ===
      Object.keys(base.privileges).sort().join(","),
    "production75_live_policy_sections",
  );
  for (const section of [
    "tables",
    "columns",
    "roles",
    "memberships",
    "namespaces",
    "database",
    "sequences",
    "defaultGrants",
  ])
    if (base.privileges[section])
      check(
        isDeepStrictEqual(
          ordered(base.privileges[section], section),
          baseline.privileges[section],
        ),
        "production75_live_policy_basis",
      );
  const build = (phase) => {
    const future = templates[phase],
      result = structuredClone(baseline);
    check(
      Object.keys(future.privileges).sort().join(",") ===
        Object.keys(base.privileges).sort().join(","),
      "production75_live_policy_sections",
    );
    const additions = (oldRows, newRows) => {
      check(
        Array.isArray(oldRows) &&
          Array.isArray(newRows) &&
          oldRows.every((r) => newRows.some((n) => isDeepStrictEqual(n, r))),
        "production75_live_policy_original",
      );
      return newRows.filter(
        (r) => !oldRows.some((o) => isDeepStrictEqual(r, o)),
      );
    };
    for (const [section, oldRows] of Object.entries(base.privileges)) {
      const added = additions(oldRows, future.privileges[section]);
      if (!["tables", "columns"].includes(section)) {
        check(added.length === 0, "production75_live_policy_provider");
        continue;
      }
      check(
        isDeepStrictEqual(
          ordered(result.privileges[section], section),
          result.privileges[section],
        ),
        "production75_live_policy_order",
      );
      result.privileges[section] = ordered(
        [...result.privileges[section], ...added],
        section,
      );
    }
    const added = additions(base.ownership, future.ownership);
    check(
      added.every(
        (r) => ["column", "relation"].includes(r.kind) && r.schema === "public",
      ),
      "production75_live_policy_provider",
    );
    check(
      isDeepStrictEqual(
        ordered(result.ownership, "ownership"),
        result.ownership,
      ),
      "production75_live_policy_order",
    );
    result.ownership = ordered([...result.ownership, ...added], "ownership");
    return result;
  };
  return freeze({
    policy75: structuredClone(baseline),
    policy95: build(95),
    policy142: build(142),
  });
}
