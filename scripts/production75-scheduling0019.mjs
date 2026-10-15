/** Pure additive0019 contract. No I/O, transport, environment or SQL execution. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual, types } from "node:util";
import {
  catalogDigest,
  collectSchemaCatalog,
  CATALOG_QUERIES,
} from "../reports/release-preparation-2026-10-09/schema-catalog.mjs";
import {
  IDENTITY_SQL,
  captureProduction75Policy,
  PRODUCTION75_PRIVILEGE_QUERIES,
} from "./production75-core.mjs";
const check = (ok, code) => {
  if (!ok)
    throw Object.assign(Error(`scheduling0019_${code}`), {
      safeCode: `scheduling0019_${code}`,
    });
};
const keys = (v, names) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Reflect.ownKeys(v).every(
    (k) =>
      typeof k === "string" &&
      Object.getOwnPropertyDescriptor(v, k)?.enumerable &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(v, k), "value"),
  ) &&
  Reflect.ownKeys(v).sort().join(",") === names.split(",").sort().join(",");
const equal = (a, b, code) => check(isDeepStrictEqual(a, b), code);
const freeze = (v) => {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
const sha = (v) => createHash("sha256").update(v).digest("hex");
const hex = (v, n) =>
  typeof v === "string" && new RegExp(`^[a-f0-9]{${n}}$`).test(v);
const name = (v) => typeof v === "string" && /^[a-z_][a-z0-9_-]{0,62}$/.test(v);
const q = (v) => {
  check(typeof v === "string" && /^[a-z_][a-z0-9_]*$/.test(v), "catalog");
  return `"${v}"`;
};
const SOURCE = "91b7fd2c1fd98d441848e0357954e35c9f65d688",
  PATH =
    "reports/staging-schema-preview-2026-10-01/0019_saved-scheduling-policy.sql",
  HASH = "76e88d3410235f1b6a8a20e595b126455fd5711b46f87055b586786b28f81ca9";
const sources = new WeakSet(),
  plans = new WeakSet(),
  // T3's verifier belongs in this module and retrieves exact SQL privately.
  planSources = new WeakMap();
const PRE = new Set([
  "307fee292bc66d8f9fe11858d9cd8fe2c2983a59563ba867d6ebf50504f3ef6e",
  "2ed9500b5fb077a19aa16003bd346f8369a1b1cb3da8ea8f9a396265b6410f7b",
]);
const verificationAttempts = new Set(),
  verificationPlans = new WeakSet(),
  verificationWriters = new WeakSet();
const ADDED = Object.freeze([
  [
    "appointments",
    "scheduling_reservation",
    "3ae75000d10385b19e7f5c06fb93850946645c93fd95507b49732f7674a68c0e",
  ],
  [
    "org_settings",
    "scheduling_policy",
    "00130bf8ebca4ac632bc0311102790c417a9ad18cb0da120949d3a048a4f5c09",
  ],
  [
    "projects",
    "scheduling_reservation",
    "e46438afcbd2192510543a07ccde43a1d3f5fdbbdb8a53b8f67850b58427df98",
  ],
]);
const addedColumn = (c) =>
  ADDED.some(([t, n]) => c.table_name === t && c.name === n);
const addedOwner = (r) =>
  r.kind === "column" &&
  r.schema === "public" &&
  ADDED.some(([t, n]) => r.name === t && r.sub_name === n);
export function buildScheduling0019Source(input) {
  check(
    keys(input, "sourceCommit,path,bytes") &&
      input.sourceCommit === SOURCE &&
      input.path === PATH &&
      Buffer.isBuffer(input.bytes) &&
      input.bytes.length === 8126 &&
      sha(input.bytes) === HASH &&
      !input.bytes.includes(13) &&
      Buffer.from(input.bytes.toString("utf8")).equals(input.bytes),
    "source_drift",
  );
  const source = freeze({
    stage: "scheduling0019",
    sourceCommit: SOURCE,
    path: PATH,
    bytes: 8126,
    sha256: HASH,
    sql: input.bytes.toString("utf8"),
  });
  sources.add(source);
  return source;
}
const CATALOG_ROW_FIELDS = Object.freeze({
  tables:
    "schema,name,kind,persistence,row_security,force_row_security,is_partition",
  columns:
    "table_name,name,ordinal,type_schema,type_name,type_modifier,formatted_type,nullable,default_expression,identity,generated,collation_schema,collation_name",
  constraints:
    "table_name,name,kind,deferrable,initially_deferred,validated,no_inherit,definition,columns,referenced_schema,referenced_table,referenced_columns,update_action,delete_action,match_type",
  indexes:
    "table_name,name,method,is_unique,is_primary,is_exclusion,is_immediate,is_valid,is_ready,is_live,nulls_not_distinct,key_count,attribute_count,definition,expressions,predicate",
  enums: "schema,name,labels",
  triggers: "table_name,name,enabled,definition",
  policies:
    "schema,table_name,name,permissive,roles,command,using_expression,check_expression",
});
const CATALOG_ARRAY_FIELDS = new Set([
  "constraints.columns",
  "constraints.referenced_columns",
  "enums.labels",
  "policies.roles",
]);
// Descriptor reads never invoke accessors/serialization hooks. No caller object
// is serialized or retained; array indices and every row key are closed too.
function catalogRecord(value, fields, read) {
  check(
    value &&
      typeof value === "object" &&
      !types.isProxy(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      keys(value, fields),
    "catalog",
  );
  const result = {};
  for (const key of Object.keys(value))
    result[key] = read(key, Object.getOwnPropertyDescriptor(value, key).value);
  return result;
}
function catalogArray(value, read) {
  check(
    value &&
      typeof value === "object" &&
      !types.isProxy(value) &&
      Array.isArray(value) &&
      Object.getPrototypeOf(value) === Array.prototype,
    "catalog",
  );
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  check(
    Number.isSafeInteger(length) &&
      length >= 0 &&
      length <= 20000 &&
      Reflect.ownKeys(value).length === length + 1,
    "catalog",
  );
  const result = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    check(
      descriptor?.enumerable && Object.hasOwn(descriptor, "value"),
      "catalog",
    );
    result.push(read(descriptor.value));
  }
  return result;
}
function snapshotCatalogs(input) {
  return catalogRecord(input, "before,after", (_phase, catalog) => {
    let bytes = 0;
    const scalar = (value) => {
      check(
        value === null ||
          typeof value === "string" ||
          typeof value === "boolean" ||
          Number.isSafeInteger(value),
        "catalog",
      );
      bytes += typeof value === "string" ? Buffer.byteLength(value) : 8;
      check(bytes <= 8000000, "catalog");
      return value;
    };
    return catalogRecord(
      catalog,
      ["formatVersion", ...Object.keys(CATALOG_QUERIES)].join(","),
      (section, value) => {
        if (section === "formatVersion") return scalar(value);
        return catalogArray(value, (row) =>
          catalogRecord(row, CATALOG_ROW_FIELDS[section], (field, leaf) => {
            if (CATALOG_ARRAY_FIELDS.has(`${section}.${field}`))
              return catalogArray(leaf, (item) => {
                check(typeof item === "string", "catalog");
                return scalar(item);
              });
            return scalar(leaf);
          }),
        );
      },
    );
  });
}
/** Returns admitted frozen metadata only; measured expectations are not native proof. */
export function assertScheduling0019Catalogs(input) {
  const catalogs = snapshotCatalogs(input);
  for (const c of [catalogs.before, catalogs.after])
    check(
      keys(c, ["formatVersion", ...Object.keys(CATALOG_QUERIES)].join(",")) &&
        c.formatVersion === 1 &&
        Object.keys(CATALOG_QUERIES).every(
          (k) => Array.isArray(c[k]) && c[k].length <= 20000,
        ) &&
        Buffer.byteLength(JSON.stringify(c)) <= 8000000,
      "catalog",
    );
  const { before, after } = catalogs;
  check(
    before.tables.length === 142 &&
      before.columns.length === 1867 &&
      PRE.has(catalogDigest(before, { physical: true })) &&
      after.tables.length === 142 &&
      after.columns.length === 1870,
    "catalog",
  );
  for (const section of Object.keys(CATALOG_QUERIES).filter(
    (k) => !["columns", "constraints"].includes(k),
  ))
    equal(after[section], before[section], "catalog");
  equal(
    after.columns.filter((c) => !addedColumn(c)),
    before.columns,
    "catalog",
  );
  const additions = after.columns.filter(addedColumn);
  check(additions.length === 3, "catalog");
  for (const [table, column, hash] of ADDED) {
    const cols = before.columns.filter((c) => c.table_name === table),
      expected = {
        table_name: table,
        name: column,
        ordinal: Math.max(...cols.map((c) => c.ordinal)) + 1,
        type_schema: "pg_catalog",
        type_name: "jsonb",
        type_modifier: -1,
        formatted_type: "jsonb",
        nullable: true,
        default_expression: null,
        identity: "",
        generated: "",
        collation_schema: null,
        collation_name: null,
      };
    equal(
      additions.find((c) => c.table_name === table && c.name === column),
      expected,
      "catalog",
    );
    const checks = after.constraints.filter(
      (c) => c.table_name === table && c.name === `${table}_${column}_ck`,
    );
    check(
      checks.length === 1 && sha(JSON.stringify(checks[0])) === hash,
      "catalog",
    );
  }
  equal(
    after.constraints.filter(
      (c) =>
        !ADDED.some(
          ([t, n]) => c.table_name === t && c.name === `${t}_${n}_ck`,
        ),
    ),
    before.constraints,
    "catalog",
  );
  check(after.constraints.length === before.constraints.length + 3, "catalog");
  return freeze(catalogs);
}
function validateTarget(t) {
  check(
    keys(
      t,
      "database,writerLogin,writerInitialRoles,writerRole,readerLogin,readerRole,principals",
    ) &&
      t.database === "fly-db" &&
      t.writerLogin === "fly-user" &&
      t.writerRole === "schema_admin" &&
      /^growthos-reader-[a-f0-9]{32}$/.test(t.readerLogin ?? "") &&
      t.readerRole === t.readerLogin &&
      Array.isArray(t.writerInitialRoles) &&
      t.writerInitialRoles.length > 0 &&
      t.writerInitialRoles.length <= 2 &&
      new Set(t.writerInitialRoles).size === t.writerInitialRoles.length &&
      t.writerInitialRoles.every((r) =>
        ["fly-user", "schema_admin"].includes(r),
      ) &&
      Array.isArray(t.principals) &&
      t.principals.length >= 2 &&
      t.principals.length <= 8 &&
      t.principals.every(name) &&
      new Set(t.principals).size === t.principals.length &&
      t.principals.includes(t.writerLogin) &&
      t.principals.includes(t.readerLogin),
    "target",
  );
}
function validatePolicy(p, catalog, target) {
  check(
    keys(p, "ownership,privileges") &&
      keys(
        p.privileges,
        Object.keys(PRODUCTION75_PRIVILEGE_QUERIES).join(","),
      ) &&
      [p.ownership, ...Object.values(p.privileges)].every(
        (r) =>
          Array.isArray(r) &&
          r.length <= 20000 &&
          Buffer.byteLength(JSON.stringify(r)) <= 8000000,
      ),
    "policy",
  );
  for (const principal of target.principals) {
    for (const [section, expected, key] of [
      ["tables", catalog.tables, (r) => r.name],
      ["columns", catalog.columns, (r) => `${r.table_name}.${r.name}`],
    ]) {
      const rows = p.privileges[section].filter(
        (r) => r.principal === principal,
      );
      check(
        rows.length === expected.length &&
          new Set(rows.map(key)).size === expected.length &&
          expected.every((r) => rows.some((x) => key(x) === key(r))),
        "policy_coverage",
      );
    }
    check(
      p.privileges.roles.some(
        (r) => r.principal === principal && r.name === principal,
      ),
      "policy_coverage",
    );
  }
  check(
    [...p.privileges.tables, ...p.privileges.columns].every((r) =>
      target.principals.includes(r.principal),
    ),
    "policy",
  );
  for (const t of catalog.tables)
    check(
      p.ownership.some(
        (r) =>
          r.kind === "relation" && r.schema === "public" && r.name === t.name,
      ),
      "policy_coverage",
    );
  for (const c of catalog.columns)
    check(
      p.ownership.some(
        (r) =>
          r.kind === "column" &&
          r.schema === "public" &&
          r.name === c.table_name &&
          r.sub_name === c.name,
      ),
      "policy_coverage",
    );
}
function preservePolicy(before, after, target) {
  equal(
    after.ownership.filter((r) => !addedOwner(r)),
    before.ownership,
    "policy_retained",
  );
  check(after.ownership.length === before.ownership.length + 3, "policy");
  for (const [table, column] of ADDED) {
    const owner = before.ownership.find(
      (r) => r.kind === "relation" && r.schema === "public" && r.name === table,
    );
    equal(
      after.ownership.filter(
        (r) =>
          r.kind === "column" &&
          r.schema === "public" &&
          r.name === table &&
          r.sub_name === column,
      ),
      [
        {
          kind: "column",
          schema: "public",
          name: table,
          sub_name: column,
          owner: owner.owner,
          acl: "DEFAULT",
        },
      ],
      "policy_added",
    );
    for (const principal of target.principals) {
      const tableGrant = before.privileges.tables.find(
          (r) => r.principal === principal && r.name === table,
        ),
        columnGrant = after.privileges.columns.find(
          (r) =>
            r.principal === principal &&
            r.table_name === table &&
            r.name === column,
        );
      check(
        columnGrant &&
          ["select", "insert", "update", "references"].every(
            (k) => columnGrant[k] === tableGrant[k],
          ),
        "policy_added",
      );
    }
  }
  for (const [section, rows] of Object.entries(before.privileges))
    equal(
      section === "columns"
        ? after.privileges[section].filter((r) => !addedColumn(r))
        : after.privileges[section],
      rows,
      "policy_retained",
    );
}
export function prepareScheduling0019(input) {
  check(
    keys(
      input,
      "source,catalogs,target,policyBefore,policyAfter,sourceBinding",
    ) && sources.has(input.source),
    "source_required",
  );
  // Check closure before structuredClone, which intentionally drops hidden fields.
  const admittedCatalogs = assertScheduling0019Catalogs(input.catalogs);
  validateTarget(input.target);
  const binding = input.sourceBinding;
  check(
    keys(binding, "candidate,moduleManifestSha256") &&
      keys(binding.candidate, "repository,commit,tree"),
    "source_binding",
  );
  for (const policy of [input.policyBefore, input.policyAfter])
    check(
      keys(policy, "ownership,privileges") &&
        keys(
          policy.privileges,
          Object.keys(PRODUCTION75_PRIVILEGE_QUERIES).join(","),
        ),
      "policy",
    );
  const { catalogs, target, policyBefore, policyAfter, sourceBinding } =
    structuredClone({
      ...input,
      source: undefined,
      catalogs: admittedCatalogs,
    });
  assertScheduling0019Catalogs(catalogs);
  validateTarget(target);
  check(
    keys(sourceBinding, "candidate,moduleManifestSha256") &&
      keys(sourceBinding.candidate, "repository,commit,tree") &&
      sourceBinding.candidate.repository ===
        "diazdestination/mogulforge-growthos" &&
      hex(sourceBinding.candidate.commit, 40) &&
      hex(sourceBinding.candidate.tree, 40) &&
      hex(sourceBinding.moduleManifestSha256, 64),
    "source_binding",
  );
  validatePolicy(policyBefore, catalogs.before, target);
  validatePolicy(policyAfter, catalogs.after, target);
  preservePolicy(policyBefore, policyAfter, target);
  const { sql: _sql, ...descriptor } = input.source;
  const plan = freeze({
    source: descriptor,
    catalogs,
    target,
    policyBefore,
    policyAfter,
    sourceBinding,
  });
  plans.add(plan);
  planSources.set(plan, input.source);
  return plan;
}
function identityValid(i, target) {
  check(
    keys(i, "database,login,role,version,pid,isolation,read_only") &&
      i.database === target.database &&
      Number.isInteger(i.version) &&
      i.version >= 160000 &&
      i.version < 170000 &&
      Number.isInteger(i.pid) &&
      i.pid > 0 &&
      i.isolation === "repeatable read" &&
      ((i.login === target.readerLogin &&
        i.role === target.readerRole &&
        i.read_only === "on") ||
        (i.login === target.writerLogin &&
          i.role === target.writerRole &&
          i.read_only === "off")),
    "identity",
  );
}
const decimal = (v, max) =>
  typeof v === "string" && /^(0|[1-9][0-9]{0,11})$/.test(v) && BigInt(v) <= max;
function fingerprintsValid(rows, catalog) {
  check(
    Array.isArray(rows) &&
      rows.length === 142 &&
      new Set(rows.map((r) => r.table)).size === 142 &&
      catalog.tables.every((t) => rows.some((r) => r.table === t.name)),
    "coverage",
  );
  let totalRows = 0n,
    totalBytes = 0n;
  for (const r of rows) {
    check(
      keys(r, "table,rows,bytes,digest") &&
        decimal(r.rows, 1000000n) &&
        decimal(r.bytes, 268435456n) &&
        hex(r.digest, 32),
      "fingerprint",
    );
    totalRows += BigInt(r.rows);
    totalBytes += BigInt(r.bytes);
  }
  check(totalRows <= 5000000n && totalBytes <= 536870912n, "data_bound");
}
function validateState(state, plan, phase) {
  check(
    keys(state, "phase,identity,catalog,fingerprints,policy,nullCounts") &&
      state.phase === phase,
    "state",
  );
  identityValid(state.identity, plan.target);
  equal(
    state.catalog,
    plan.catalogs[phase === "pre0019" ? "before" : "after"],
    "catalog",
  );
  equal(
    state.policy,
    plan[phase === "pre0019" ? "policyBefore" : "policyAfter"],
    "policy",
  );
  fingerprintsValid(state.fingerprints, plan.catalogs.before);
  equal(
    state.nullCounts,
    phase === "pre0019"
      ? {}
      : Object.fromEntries(ADDED.map(([t, c]) => [`${t}.${c}`, "0"])),
    "nulls",
  );
}
export function assertScheduling0019Preserved(
  before,
  after,
  plan,
  phase = "post0019",
) {
  check(plans.has(plan), "plan_required");
  check(["pre0019", "post0019"].includes(phase), "phase");
  validateState(before, plan, "pre0019");
  validateState(after, plan, phase);
  equal(after.identity.version, before.identity.version, "identity");
  const sorted = (r) => [...r].sort((a, b) => a.table.localeCompare(b.table));
  equal(
    sorted(after.fingerprints),
    sorted(before.fingerprints),
    "data_changed",
  );
}
export async function captureScheduling0019State(observer, plan) {
  check(
    plans.has(plan) && typeof observer?.query === "function",
    "plan_required",
  );
  const catalog = await collectSchemaCatalog(observer),
    phase = isDeepStrictEqual(catalog, plan.catalogs.before)
      ? "pre0019"
      : isDeepStrictEqual(catalog, plan.catalogs.after)
        ? "post0019"
        : null;
  check(phase, "catalog");
  const result = await observer.query(IDENTITY_SQL);
  check(result.rows?.length === 1, "identity");
  const identity = result.rows[0];
  identityValid(identity, plan.target);
  const fingerprints = [];
  for (const table of plan.catalogs.before.tables) {
    const columns = plan.catalogs.before.columns
        .filter((c) => c.table_name === table.name)
        .sort((a, b) => a.ordinal - b.ordinal),
      projection = `(SELECT ${columns.map((c) => q(c.name)).join(",")} FROM public.${q(table.name)}) AS original`;
    const sizes = await observer.query(
        `SELECT count(*)::text AS rows,COALESCE(sum(octet_length(row_to_json(original)::text)),0)::text AS bytes FROM ${projection}`,
      ),
      size = sizes.rows?.[0];
    check(
      sizes.rows?.length === 1 &&
        keys(size, "rows,bytes") &&
        decimal(size.rows, 1000000n) &&
        decimal(size.bytes, 268435456n),
      "fingerprint",
    );
    const hashes = await observer.query(
        `SELECT count(*)::text AS rows,md5(COALESCE(string_agg(h,'' ORDER BY h COLLATE "C"),'')) AS digest FROM (SELECT md5(row_to_json(original)::text) AS h FROM ${projection}) AS hashes`,
      ),
      hash = hashes.rows?.[0];
    check(
      hashes.rows?.length === 1 &&
        keys(hash, "rows,digest") &&
        hash.rows === size.rows &&
        hex(hash.digest, 32),
      "fingerprint",
    );
    fingerprints.push({ table: table.name, ...size, digest: hash.digest });
  }
  fingerprintsValid(fingerprints, plan.catalogs.before);
  const policy = await captureProduction75Policy(
      observer,
      plan.target.principals,
    ),
    nullCounts = {};
  if (phase === "post0019")
    for (const [t, c] of ADDED) {
      const result = await observer.query(
        `SELECT count(*)::text AS mismatches FROM public.${q(t)} WHERE ${q(c)} IS NOT NULL`,
      );
      check(
        result.rows?.length === 1 &&
          keys(result.rows[0], "mismatches") &&
          result.rows[0].mismatches === "0",
        "nulls",
      );
      nullCounts[`${t}.${c}`] = result.rows[0].mismatches;
    }
  const state = { phase, identity, catalog, fingerprints, policy, nullCounts };
  validateState(state, plan, phase);
  return state;
}

// The binding intentionally excludes transient Reader identity/PID. Custody
// consumes this exact immutable intent instead of inventing a second formula.
function bindSchedulingBaseline(baseline, plan) {
  assertScheduling0019Preserved(baseline, baseline, plan, "pre0019");
  const catalogSha256 = catalogDigest(baseline.catalog, { physical: true }),
    policySha256 = sha(JSON.stringify(baseline.policy));
  const fingerprints = [...baseline.fingerprints]
    .sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0))
    .map(({ table, rows, bytes, digest }) => ({ table, rows, bytes, digest }));
  return freeze({
    baselineSha256: sha(
      JSON.stringify({
        phase: "pre0019",
        catalogSha256,
        fingerprints,
        policySha256,
        nullCounts: {},
      }),
    ),
    catalogSha256,
    policySha256,
  });
}
function verificationReader(state, plan, baseline, writerPid) {
  const i = state?.identity,
    t = plan.target;
  check(
    i?.database === t.database &&
      i.login === t.readerLogin &&
      i.role === t.readerRole &&
      i.read_only === "on" &&
      i.isolation === "repeatable read" &&
      i.version === baseline.identity.version &&
      Number.isInteger(i.pid) &&
      i.pid > 0 &&
      (writerPid === undefined || i.pid !== writerPid),
    "verification_reader",
  );
}
/** One supplied-client transaction. Caller owns admission, clients and cleanup. */
export async function runScheduling0019Verification(input = {}) {
  check(
    input &&
      keys(
        input,
        "writer,plan,baseline,outcome,attemptId,reserve,persist,readFresh" +
          (Object.hasOwn(input, "now") ? ",now" : ""),
      ),
    "verification_input",
  );
  const {
    writer,
    plan,
    outcome,
    attemptId,
    reserve,
    persist,
    readFresh,
    now = Date.now,
  } = input;
  const writerQuery = writer?.query;
  check(
    plans.has(plan) &&
      planSources.has(plan) &&
      typeof writerQuery === "function" &&
      ["rollback", "commit"].includes(outcome) &&
      typeof reserve === "function" &&
      typeof persist === "function" &&
      typeof readFresh === "function" &&
      typeof now === "function" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        attemptId ?? "",
      ),
    "verification_input",
  );
  // All input snapshots, callbacks and branding are fixed before the first await.
  assertScheduling0019Preserved(
    input.baseline,
    input.baseline,
    plan,
    "pre0019",
  );
  let baseline;
  try {
    baseline = freeze(structuredClone(input.baseline));
  } catch {
    check(false, "verification_input");
  }
  verificationReader(baseline, plan, baseline);
  const binding = bindSchedulingBaseline(baseline, plan),
    source = planSources.get(plan);
  check(
    !verificationAttempts.has(attemptId) &&
      !verificationPlans.has(plan) &&
      !verificationWriters.has(writer),
    "verification_replay",
  );
  verificationAttempts.add(attemptId);
  verificationPlans.add(plan);
  verificationWriters.add(writer);
  const started = now();
  check(Number.isFinite(started), "verification_input");
  const deadline = started + 240000;
  const proof = {
    originalTables: 142,
    originalColumns: 1867,
    newColumns: 3,
    nullColumnsVerified: 0,
    reservationConfirmed: false,
    beginDispatched: false,
    beginAcknowledged: false,
    sourceDispatched: false,
    sourceAcknowledged: false,
    commitDispatched: false,
    commitAcknowledged: false,
    rollbackDispatched: false,
    rollbackAcknowledged: false,
    freshReaderVerified: false,
    journalConfirmed: false,
    preimageVerified: false,
    postimageVerified: false,
    transactionClosure: "not-opened",
    requiresOwningCleanup: false,
  };
  const result = {
    kind: "SCHEDULING0019_VERIFICATION",
    status: "failed-or-held",
    attemptId,
    baselineSha256: binding.baselineSha256,
    sourceSha256: source.sha256,
    proof,
    errorCode: null,
  };
  const faultCodes = new WeakMap();
  const fault = (code) => {
    const error = Object.assign(Error(`scheduling0019_verification_${code}`), {
      safeCode: `scheduling0019_verification_${code}`,
    });
    faultCodes.set(error, code);
    return error;
  };
  let mutationBlocked = false,
    open = false,
    writerPid,
    finalReadAttempted = false;
  const remaining = () => {
    const ms = deadline - now();
    if (!Number.isFinite(ms) || ms <= 0) {
      mutationBlocked = true;
      throw fault("deadline");
    }
    return ms;
  };
  async function bounded(operation, cap, kind) {
    let timer;
    const ms = Math.min(cap, remaining()),
      until = now() + ms;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => {
          remaining();
          return operation();
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            mutationBlocked = true;
            reject(fault("timeout"));
          }, ms);
        }),
      ]);
      if (now() >= until) {
        mutationBlocked = true;
        throw fault("deadline");
      }
      remaining();
      return value;
    } catch (error) {
      if (faultCodes.has(error)) throw error;
      if (kind === "query") {
        // Only an actual settled PostgreSQL error permits transaction cleanup.
        const code = error?.code,
          known =
            typeof code === "string" &&
            /^[0-9A-Z]{5}$/.test(code) &&
            !code.startsWith("08") &&
            !["57P01", "57P02", "57P03"].includes(code) &&
            !["FATAL", "PANIC"].includes(error?.severity);
        if (!known) mutationBlocked = true;
      }
      throw fault(kind === "query" ? "database" : "callback");
    } finally {
      clearTimeout(timer);
    }
  }
  const query = (sql, args, onDispatch) =>
    bounded(
      () => {
        onDispatch?.();
        return writerQuery.call(writer, sql, args);
      },
      15000,
      "query",
    );
  const journal = (event) =>
    bounded(() => persist(freeze(event)), 5000, "journal");
  const acknowledge = (response, commands) => {
    const responses = Array.isArray(response) ? response : [response];
    if (
      responses.length !== commands.length ||
      responses.some((r, i) => r?.command !== commands[i])
    ) {
      mutationBlocked = true;
      throw fault("ack");
    }
  };
  function writerIdentity(row, inTransaction) {
    const valid =
      row &&
      row.database === plan.target.database &&
      row.login === plan.target.writerLogin &&
      (inTransaction
        ? row.role === plan.target.writerRole
        : plan.target.writerInitialRoles.includes(row.role)) &&
      row.version === baseline.identity.version &&
      Number.isInteger(row.pid) &&
      row.pid > 0 &&
      (writerPid === undefined || row.pid === writerPid) &&
      row.read_only === "off" &&
      (!inTransaction || row.isolation === "repeatable read");
    if (!valid) {
      mutationBlocked = true;
      throw fault("writer_identity");
    }
  }
  const writerView = {
    query: async (sql, args) => {
      const response = await query(sql, args);
      if (sql === IDENTITY_SQL) {
        if (response.rows?.length !== 1) {
          mutationBlocked = true;
          throw fault("writer_identity");
        }
        writerIdentity(response.rows[0], true);
      }
      return response;
    },
  };
  async function observe(final = false) {
    if (final) finalReadAttempted = true;
    const state = await bounded(
      () => readFresh(),
      Math.min(240000, remaining()),
      "reader",
    );
    verificationReader(state, plan, baseline, writerPid);
    assertScheduling0019Preserved(baseline, state, plan, state.phase);
    return state;
  }
  const finish = () => {
    proof.requiresOwningCleanup =
      proof.beginDispatched &&
      !(proof.commitAcknowledged || proof.rollbackAcknowledged);
    return freeze(result);
  };
  try {
    const initialReader = await observe();
    if (initialReader.phase === "post0019") {
      proof.freshReaderVerified = true;
      proof.postimageVerified = true;
      proof.nullColumnsVerified = 3;
      result.status =
        outcome === "commit"
          ? "reconciled-commit-no-replay"
          : "verification-held-no-replay";
      result.errorCode = "scheduling0019_verification_already_applied";
      return finish();
    }
    const initial = (await query(IDENTITY_SQL)).rows;
    check(initial?.length === 1, "verification_writer");
    writerIdentity(initial[0], false);
    writerPid = initial[0].pid;
    verificationReader(initialReader, plan, baseline, writerPid);
    const intent = freeze({
      kind: "SCHEDULING0019_TRANSACTION_RESERVATION",
      attemptId,
      database: plan.target.database,
      sourceCommit: source.sourceCommit,
      sourceSha256: source.sha256,
      ...binding,
      moduleManifestSha256: plan.sourceBinding.moduleManifestSha256,
      candidate: plan.sourceBinding.candidate,
      outcome,
    });
    if ((await bounded(() => reserve(intent), 5000, "reservation")) !== true)
      throw fault("reservation");
    proof.reservationConfirmed = true;
    await journal({ phase: "begin-intent" });
    acknowledge(
      await query("BEGIN ISOLATION LEVEL REPEATABLE READ", undefined, () => {
        proof.beginDispatched = true;
        proof.transactionClosure = "unconfirmed";
      }),
      ["BEGIN"],
    );
    open = true;
    proof.beginAcknowledged = true;
    const settings = [
      "SET LOCAL statement_timeout='15000ms'",
      "SET LOCAL lock_timeout='3000ms'",
      "SET LOCAL idle_in_transaction_session_timeout='20000ms'",
      "SET LOCAL search_path=public,pg_catalog",
      "SET LOCAL timezone='UTC'",
      "SET LOCAL datestyle='ISO,YMD'",
      "SET LOCAL intervalstyle='postgres'",
      "SET LOCAL extra_float_digits=3",
      "SET LOCAL bytea_output='hex'",
      "SET LOCAL row_security=off",
      `SET LOCAL ROLE "${plan.target.writerRole}"`,
    ];
    acknowledge(
      await query(settings.join("; ")),
      settings.map(() => "SET"),
    );
    await journal({ phase: "begin-ack", pid: writerPid });
    // RR freezes its snapshot at the first SELECT. Acquire every protecting
    // lock first, including before the otherwise read-only identity query.
    acknowledge(
      await query(
        `LOCK TABLE ${plan.catalogs.before.tables
          .map((t) => `public.${q(t.name)}`)
          .sort()
          .join(",")} IN ACCESS EXCLUSIVE MODE`,
      ),
      ["LOCK"],
    );
    await writerView.query(IDENTITY_SQL);
    const before = await captureScheduling0019State(writerView, plan);
    assertScheduling0019Preserved(baseline, before, plan, "pre0019");
    proof.preimageVerified = true;
    await journal({
      phase: "step-intent",
      path: source.path,
      sha256: source.sha256,
    });
    acknowledge(
      await query(source.sql, undefined, () => {
        proof.sourceDispatched = true;
      }),
      Array(6).fill("ALTER"),
    );
    proof.sourceAcknowledged = true;
    await journal({ phase: "step-ack", path: source.path });
    const after = await captureScheduling0019State(writerView, plan);
    assertScheduling0019Preserved(baseline, after, plan, "post0019");
    proof.postimageVerified = true;
    proof.nullColumnsVerified = 3;
    await journal({
      phase: "precommit-verified",
      proof: {
        originalTables: 142,
        originalColumns: 1867,
        newColumns: 3,
        nullColumnsVerified: 3,
      },
    });
    await journal({ phase: `${outcome}-intent` });
    acknowledge(
      await query(outcome.toUpperCase(), undefined, () => {
        proof[`${outcome}Dispatched`] = true;
      }),
      [outcome.toUpperCase()],
    );
    proof[`${outcome}Acknowledged`] = true;
    proof.transactionClosure = `acknowledged-${outcome}`;
    open = false;
    await journal({ phase: `${outcome}-ack` });
    proof.journalConfirmed = true;
    const observed = await observe(true);
    check(
      observed.phase === (outcome === "commit" ? "post0019" : "pre0019"),
      "verification_reader_phase",
    );
    proof.freshReaderVerified = true;
    result.status = `verified-${outcome}`;
    return finish();
  } catch (error) {
    result.errorCode = /^scheduling0019_[a-z_]+$/.test(error?.safeCode ?? "")
      ? error.safeCode
      : "scheduling0019_verification_failure";
    // No second terminal query after dispatch or unresolved/expired work. A
    // settled pre-terminal server/journal failure can receive one real ROLLBACK.
    if (
      open &&
      !mutationBlocked &&
      !proof.commitDispatched &&
      !proof.rollbackDispatched
    ) {
      try {
        acknowledge(
          await query("ROLLBACK", undefined, () => {
            proof.rollbackDispatched = true;
          }),
          ["ROLLBACK"],
        );
        proof.rollbackAcknowledged = true;
        proof.transactionClosure = "acknowledged-rollback";
        open = false;
        await journal({ phase: "rollback-ack", afterFailure: true });
      } catch {}
    }
    if (proof.beginDispatched && !finalReadAttempted) {
      try {
        const observed = await observe(true);
        proof.freshReaderVerified = true;
        if (proof.commitDispatched && observed.phase === "post0019") {
          proof.postimageVerified = true;
          proof.nullColumnsVerified = 3;
          result.status = "reconciled-commit-no-replay";
        } else if (
          mutationBlocked ||
          !proof.rollbackAcknowledged ||
          proof.commitDispatched ||
          (!proof.sourceAcknowledged && proof.rollbackDispatched === false)
        )
          result.status = "verification-held-no-replay";
      } catch {
        result.status = "verification-held-no-replay";
      }
    } else if (proof.beginDispatched)
      result.status = "verification-held-no-replay";
    return finish();
  }
}
