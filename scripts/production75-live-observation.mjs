/** Full fixed-query snapshots; no default I/O or provider mutation. */
import { isDeepStrictEqual } from "node:util";
import {
  collectSchemaCatalog,
  catalogDigest,
} from "../reports/release-preparation-2026-10-09/schema-catalog.mjs";
import {
  deriveProduction75Catalogs,
  captureProduction75Policy,
  IDENTITY_SQL,
} from "./production75-core.mjs";
import {
  createProduction75Observer,
  captureProduction75Extras,
} from "./production75-observer.mjs";
import {
  production75SnapshotDigest,
  production75ProfileDigest,
  assertProduction75ReaderDelta,
} from "./production75-reader-delta.mjs";
const NAMES = ["fly-db", "growthos_staging", "mogulforge-growthos-db"];
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
const q = (v) => {
  check(/^[a-z_][a-z0-9_]*$/.test(v), "production75_live_identifier");
  return `"${v}"`;
};
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export function validateSourceSnapshot(snapshot) {
  production75SnapshotDigest(snapshot);
  check(
    snapshot.databases.every(
      (d) =>
        d.identity.login === "fly-user" && d.identity.role === "schema_admin",
    ),
    "production75_live_source_identity",
  );
  return snapshot;
}
export function projectLiveReader(snapshot, profile) {
  production75ProfileDigest(profile);
  validateSourceSnapshot(snapshot);
  const after = structuredClone(snapshot),
    reader = profile.readerLogin;
  for (const d of after.databases) {
    check(
      !d.extra.roles.some((r) => r.name === reader),
      "production75_live_reader_collision",
    );
    d.identity = {
      ...d.identity,
      login: reader,
      role: profile.readerRole,
      pid: d.identity.pid + 1,
    };
    d.extra.roles.push(structuredClone(profile.role));
    d.extra.roles.sort((a, b) => cmp(a.name, b.name));
    d.policy.privileges.memberships.push(structuredClone(profile.membership));
    d.policy.privileges.memberships.sort(
      (a, b) =>
        cmp(a.role, b.role) ||
        cmp(a.member, b.member) ||
        cmp(a.grantor, b.grantor),
    );
    for (const [section, rows] of Object.entries(d.policy.privileges)) {
      if (["memberships", "publicGrants", "defaultGrants"].includes(section))
        continue;
      const template = rows.filter((r) => r.principal === "reader"),
        added = template.map((r) => ({ ...r, principal: reader }));
      if (section === "roles") {
        const self = template.find((r) => r.name === "reader");
        check(self, "production75_live_group_coverage");
        added.push(
          Object.fromEntries(
            Object.entries(self).map(([k, v]) => [
              k,
              k === "principal" || k === "name"
                ? reader
                : Object.hasOwn(profile.role, k)
                  ? profile.role[k]
                  : v,
            ]),
          ),
        );
      }
      rows.push(...added);
      rows.sort(
        (a, b) =>
          cmp(a.principal, b.principal) ||
          cmp(a.table_name ?? a.name ?? "", b.table_name ?? b.name ?? "") ||
          cmp(
            a.table_name ? a.name : (a.arguments ?? ""),
            b.table_name ? b.name : (b.arguments ?? ""),
          ),
      );
    }
  }
  assertProduction75ReaderDelta({
    before: snapshot,
    after,
    readerName: reader,
    expectedProfile: profile,
  });
  return freeze(after);
}
export async function captureLiveSnapshot({
  transport,
  cluster,
  credentials,
  readerName = null,
  resources,
  catalogs,
  databases = NAMES,
  proxy = null,
} = {}) {
  check(
    transport &&
      resources &&
      catalogs &&
      Array.isArray(databases) &&
      databases.length > 0 &&
      new Set(databases).size === databases.length &&
      databases.every((n) => NAMES.includes(n)),
    "production75_live_observation_input",
  );
  resources.assertActive();
  proxy ??= await transport.openProxy(cluster, resources);
  const principals = [
      "fly-user",
      "growthos-staging-live",
      "reader",
      ...(readerName ? [readerName] : []),
    ],
    snapshots = [];
  for (const database of databases) {
    const original =
        database === "growthos_staging" ? catalogs.other75 : catalogs.fly75,
      derived = deriveProduction75Catalogs(
        original,
        catalogs.canonical95,
        catalogs.canonical142,
      ),
      login = readerName ?? "fly-user",
      role = readerName ?? "schema_admin";
    const client = await transport.connect(proxy, database, credentials, {
      readonly: true,
      resources,
    });
    let began = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      began = true;
      const observer = createProduction75Observer({
          client,
          principals,
          catalog75: original,
          catalog142: derived.catalog142,
          identity: { database, login, role },
        }),
        catalog = await collectSchemaCatalog(observer);
      if (database === "mogulforge-growthos-db")
        check(
          catalog.tables.length === 0 && catalog.columns.length === 0,
          "production75_live_empty_database",
        );
      else
        check(
          catalogDigest(catalog, { physical: true }) ===
            catalogDigest(original, { physical: true }),
          "production75_live_catalog",
        );
      const fingerprints = [];
      let totalRows = 0,
        totalBytes = 0;
      for (const table of catalog.tables) {
        const columns = catalog.columns
            .filter((c) => c.table_name === table.name)
            .sort((a, b) => a.ordinal - b.ordinal),
          projection = `(SELECT ${columns.map((c) => q(c.name)).join(",")} FROM public.${q(table.name)}) AS original`,
          size = (
            await observer.query(
              `SELECT count(*)::text AS rows,COALESCE(sum(octet_length(row_to_json(original)::text)),0)::text AS bytes FROM ${projection}`,
            )
          ).rows[0],
          fp = (
            await observer.query(
              `SELECT count(*)::text AS rows,md5(COALESCE(string_agg(h,'' ORDER BY h COLLATE "C"),'')) AS digest FROM (SELECT md5(row_to_json(original)::text) AS h FROM ${projection}) AS hashes`,
            )
          ).rows[0];
        check(
          /^\d{1,12}$/.test(size?.rows ?? "") &&
            /^\d{1,12}$/.test(size?.bytes ?? "") &&
            fp?.rows === size.rows &&
            /^[a-f0-9]{32}$/.test(fp.digest),
          "production75_live_fingerprint",
        );
        const rows = Number(size.rows),
          bytes = Number(size.bytes);
        totalRows += rows;
        totalBytes += bytes;
        check(
          rows <= 1000000 &&
            bytes <= 268435456 &&
            totalRows <= 5000000 &&
            totalBytes <= 536870912,
          "production75_live_fingerprint_bound",
        );
        fingerprints.push({
          table: table.name,
          rows,
          bytes,
          digest: fp.digest,
        });
      }
      const policy = await captureProduction75Policy(observer, principals),
        extra = await captureProduction75Extras(observer),
        identity = (await observer.query(IDENTITY_SQL)).rows[0];
      snapshots.push({
        name: database,
        catalog,
        fingerprints,
        identity,
        policy,
        extra,
      });
      await client.query("ROLLBACK");
      began = false;
    } finally {
      if (began && !resources.signal.aborted)
        try {
          await client.query("ROLLBACK");
        } catch {}
      await client.__driverClose();
    }
  }
  const result = { databases: snapshots };
  if (databases.length === 3) production75SnapshotDigest(result);
  return freeze(result);
}
