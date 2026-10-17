/** Independent native oracle additions over a measured baseline. Never live DDL. */
import { isDeepStrictEqual, types } from "node:util";
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

/** Only measured additive scheduling columns; actual provider vectors survive. */
export function deriveLiveScheduling0019Policy(input) {
  const fail = () => check(false, "production75_live_scheduling_policy");
  let nodes = 0,
    bytes = 0;
  const seen = new Set();
  const copy = (v, depth = 0) => {
    if (++nodes > 2000000 || depth > 40) fail();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") {
      bytes += Buffer.byteLength(v);
      if (bytes > 32000000) fail();
      return v;
    }
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v)) fail();
      return v;
    }
    if (!v || typeof v !== "object" || types.isProxy(v) || seen.has(v)) fail();
    const array = Array.isArray(v);
    if (
      Object.getPrototypeOf(v) !== (array ? Array.prototype : Object.prototype)
    )
      fail();
    seen.add(v);
    const out = array ? [] : {};
    const own = Reflect.ownKeys(v);
    for (const key of own) {
      if (array && key === "length") continue;
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (
        typeof key !== "string" ||
        !d.enumerable ||
        !Object.hasOwn(d, "value") ||
        (array && !/^(0|[1-9][0-9]*)$/.test(key))
      )
        fail();
      bytes += Buffer.byteLength(key) + 4;
      if (bytes > 32000000) fail();
      Object.defineProperty(out, key, {
        value: copy(d.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (array && (own.length !== v.length + 1 || out.length !== v.length))
      fail();
    seen.delete(v);
    return out;
  };
  const p = copy(input),
    exact = (v, keys) =>
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.keys(v).sort().join(",") === keys.split(",").sort().join(",");
  if (
    !exact(p, "baseline142,oracle,readerName,templateReader") ||
    !exact(p.oracle, "before,after") ||
    !/^growthos-reader-[a-f0-9]{32}$/.test(p.readerName) ||
    !/^growthos-reader-[a-f0-9]{32}$/.test(p.templateReader)
  )
    fail();
  const { baseline142: baseline, readerName, templateReader } = p,
    templates = rename(p.oracle, templateReader, readerName),
    before = templates.before,
    after = templates.after;
  if (
    !exact(baseline, "ownership,privileges") ||
    !exact(before, "ownership,privileges") ||
    !exact(after, "ownership,privileges") ||
    !Array.isArray(before.ownership) ||
    !Array.isArray(after.ownership) ||
    !Array.isArray(baseline.ownership)
  )
    fail();
  const sections = Object.keys(before.privileges).sort();
  if (
    !isDeepStrictEqual(sections, Object.keys(after.privileges).sort()) ||
    !isDeepStrictEqual(sections, Object.keys(baseline.privileges).sort())
  )
    fail();
  const added = [
      ["appointments", "scheduling_reservation"],
      ["org_settings", "scheduling_policy"],
      ["projects", "scheduling_reservation"],
    ],
    isNew = (r) => added.some(([t, c]) => r.table_name === t && r.name === c),
    isOwner = (r) =>
      r.kind === "column" &&
      r.schema === "public" &&
      added.some(([t, c]) => r.name === t && r.sub_name === c);
  const principals = [
    ...new Set(before.privileges.tables?.map((r) => r.principal) ?? []),
  ];
  if (
    principals.length < 2 ||
    principals.length > 8 ||
    !principals.includes(readerName) ||
    !principals.includes("fly-user")
  )
    fail();
  for (const section of sections) {
    const old = before.privileges[section],
      future = after.privileges[section],
      actual = baseline.privileges[section];
    if (!Array.isArray(old) || !Array.isArray(future) || !Array.isArray(actual))
      fail();
    if (
      !isDeepStrictEqual(
        section === "columns" ? future.filter((r) => !isNew(r)) : future,
        old,
      )
    )
      fail();
    if (
      [
        "tables",
        "columns",
        "roles",
        "memberships",
        "namespaces",
        "database",
        "sequences",
        "defaultGrants",
      ].includes(section) &&
      !isDeepStrictEqual(ordered(old, section), actual)
    )
      fail();
  }
  if (
    !isDeepStrictEqual(
      after.ownership.filter((r) => !isOwner(r)),
      before.ownership,
    ) ||
    after.ownership.length !== before.ownership.length + 3 ||
    after.privileges.columns.length !==
      before.privileges.columns.length + principals.length * 3
  )
    fail();
  for (const [table, column] of added) {
    const expectedParent = before.ownership.find(
        (r) =>
          r.kind === "relation" && r.schema === "public" && r.name === table,
      ),
      actualParent = baseline.ownership.find(
        (r) =>
          r.kind === "relation" && r.schema === "public" && r.name === table,
      );
    if (!expectedParent || !isDeepStrictEqual(actualParent, expectedParent))
      fail();
    const owners = after.ownership.filter(
      (r) =>
        r.kind === "column" &&
        r.schema === "public" &&
        r.name === table &&
        r.sub_name === column,
    );
    if (
      !isDeepStrictEqual(owners, [
        {
          kind: "column",
          schema: "public",
          name: table,
          sub_name: column,
          owner: actualParent.owner,
          acl: "DEFAULT",
        },
      ])
    )
      fail();
    for (const principal of principals) {
      const t = before.privileges.tables.find(
          (r) => r.principal === principal && r.name === table,
        ),
        columns = after.privileges.columns.filter(
          (r) =>
            r.principal === principal &&
            r.table_name === table &&
            r.name === column,
        );
      if (
        !t ||
        !isDeepStrictEqual(columns, [
          {
            principal,
            table_name: table,
            name: column,
            select: t.select,
            insert: t.insert,
            update: t.update,
            references: t.references,
          },
        ])
      )
        fail();
    }
  }
  const result = structuredClone(baseline);
  result.ownership = ordered(
    [...result.ownership, ...after.ownership.filter(isOwner)],
    "ownership",
  );
  result.privileges.columns = ordered(
    [...result.privileges.columns, ...after.privileges.columns.filter(isNew)],
    "columns",
  );
  return freeze({ before: baseline, after: result });
}
