/** Synthetic embedded fixtures only. Never native admission/oracle evidence. */
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  collectSchemaCatalog,
  CATALOG_QUERIES,
  catalogDifferences,
} from "../reports/release-preparation-2026-10-09/schema-catalog.mjs";
import {
  IDENTITY_SQL,
  PRODUCTION75_PRIVILEGE_QUERIES,
  OWNERSHIP_SQL,
} from "./production75-core.mjs";
const requireApi = createRequire(
  new URL("../artifacts/api-server/package.json", import.meta.url),
);
const { PGlite } = requireApi("@electric-sql/pglite");
const root = fileURLToPath(new URL("../", import.meta.url));
const path =
  "reports/staging-schema-preview-2026-10-01/0019_saved-scheduling-policy.sql";
const sourceCommit = "91b7fd2c1fd98d441848e0357954e35c9f65d688";
const read = async (name) =>
  JSON.parse(
    await readFile(
      new URL(
        `../reports/production75-recovery-2026-10-11/${name}`,
        import.meta.url,
      ),
    ),
  );
const q = (s) => `"${s}"`,
  literal = (s) => `'${s.replaceAll("'", "''")}'`;
const reader = "growthos-reader-abcdef01234546789abcdef012345678";
const additions = [
  ["appointments", "scheduling_reservation"],
  ["org_settings", "scheduling_policy"],
  ["projects", "scheduling_reservation"],
];
const sha = (s) => createHash("sha256").update(s).digest("hex");
function ddl(catalog) {
  const sql = catalog.enums.map(
    (e) =>
      `CREATE TYPE ${q(e.name)} AS ENUM (${e.labels.map(literal).join(",")});`,
  );
  for (const t of catalog.tables) {
    const cols = catalog.columns
      .filter((c) => c.table_name === t.name)
      .sort((a, b) => a.ordinal - b.ordinal);
    sql.push(
      `CREATE TABLE ${q(t.name)} (${cols.map((c) => `${q(c.name)} ${c.formatted_type}${c.default_expression === null ? "" : ` DEFAULT ${c.default_expression}`}${c.nullable ? "" : " NOT NULL"}`).join(",")});`,
    );
  }
  for (const c of catalog.constraints.filter((c) => c.kind !== "f"))
    sql.push(
      `ALTER TABLE ${q(c.table_name)} ADD CONSTRAINT ${q(c.name)} ${c.definition};`,
    );
  const backed = new Set(
    catalog.constraints
      .filter((c) => ["p", "u", "x"].includes(c.kind))
      .map((c) => `${c.table_name}.${c.name}`),
  );
  for (const i of catalog.indexes.filter(
    (i) => !backed.has(`${i.table_name}.${i.name}`),
  ))
    sql.push(`${i.definition};`);
  for (const c of catalog.constraints.filter((c) => c.kind === "f"))
    sql.push(
      `ALTER TABLE ${q(c.table_name)} ADD CONSTRAINT ${q(c.name)} ${c.definition};`,
    );
  return sql.join("\n");
}
async function independentState(db, catalog, policy, phase) {
  const fingerprints = [];
  for (const table of catalog.tables) {
    const cols = catalog.columns
      .filter(
        (c) =>
          c.table_name === table.name &&
          !additions.some(([t, c2]) => t === c.table_name && c2 === c.name),
      )
      .sort((a, b) => a.ordinal - b.ordinal);
    const projection = `(SELECT ${cols.map((c) => q(c.name)).join(",")} FROM public.${q(table.name)}) AS original`;
    const size = (
      await db.query(
        `SELECT count(*)::text AS rows,COALESCE(sum(octet_length(row_to_json(original)::text)),0)::text AS bytes FROM ${projection}`,
      )
    ).rows[0];
    const hash = (
      await db.query(
        `SELECT md5(COALESCE(string_agg(h,'' ORDER BY h COLLATE "C"),'')) AS digest FROM (SELECT md5(row_to_json(original)::text) AS h FROM ${projection}) AS hashes`,
      )
    ).rows[0];
    fingerprints.push({ table: table.name, ...size, ...hash });
  }
  const nullCounts = {};
  if (phase === "post0019")
    for (const [t, c] of additions)
      nullCounts[`${t}.${c}`] = (
        await db.query(
          `SELECT count(*)::text AS mismatches FROM public.${q(t)} WHERE ${q(c)} IS NOT NULL`,
        )
      ).rows[0].mismatches;
  return {
    phase,
    identity: {
      database: "fly-db",
      login: reader,
      role: reader,
      version: 160014,
      pid: 42,
      isolation: "repeatable read",
      read_only: "on",
    },
    catalog: structuredClone(catalog),
    fingerprints,
    policy: structuredClone(policy),
    nullCounts,
  };
}
/** The callback receives test-only DB access; makeScheduling0019Fixture stays closed. */
export async function withScheduling0019Database(
  { layout = 0 } = {},
  callback,
) {
  if (![0, 1].includes(layout)) throw Error("fixture_layout");
  const variant = ["fly-db", "growthos_staging"][layout],
    beforeCatalog = await read(`catalog142-${variant}.json`),
    oldPolicy = (await read(`local-policy-${variant}.json`)).policy142;
  const sourceInput = {
    sourceCommit,
    path,
    bytes: execFileSync("git", ["show", `${sourceCommit}:${path}`], {
      cwd: root,
      windowsHide: true,
      maxBuffer: 20000,
    }),
  };
  const target = {
    database: "fly-db",
    writerLogin: "fly-user",
    writerInitialRoles: ["fly-user", "schema_admin"],
    writerRole: "schema_admin",
    readerLogin: reader,
    readerRole: reader,
    principals: [reader, "fly-user"],
  };
  const remap = (s) =>
    s
      .replaceAll("production75-reader", reader)
      .replaceAll("production75-writer", "fly-user")
      .replaceAll("production75_owner", "schema_admin")
      .replaceAll(`production75_${variant.replaceAll("-", "_")}`, "fly-db");
  const policyBefore = JSON.parse(remap(JSON.stringify(oldPolicy))),
    policyAfter = structuredClone(policyBefore);
  for (const [t, c] of additions) {
    policyAfter.ownership.push({
      kind: "column",
      schema: "public",
      name: t,
      sub_name: c,
      owner: "schema_admin",
      acl: "DEFAULT",
    });
    for (const principal of target.principals) {
      const template = policyBefore.privileges.columns.find(
        (r) => r.principal === principal && r.table_name === t,
      );
      policyAfter.privileges.columns.push({ ...template, name: c });
    }
  }
  const db = await PGlite.create();
  try {
    await db.exec(ddl(beforeCatalog));
    // FKs are disabled only while seeding isolated synthetic rows; every CHECK remains enforced.
    await db.exec(`SET session_replication_role=replica;
   INSERT INTO org_settings(organization_id) VALUES ('00000000-0000-4000-8000-000000000001');
   INSERT INTO projects(organization_id,lead_id,name) VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003','Synthetic preserved project');
   INSERT INTO appointments(organization_id,scheduled_start) VALUES ('00000000-0000-4000-8000-000000000001','2026-01-01T00:00:00Z');
   INSERT INTO appointment_work_entries(id,organization_id,appointment_id,contact_id,checklist_revision_id,parent_snapshot,created_by_user_id,notes) VALUES
    ('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','{}','synthetic-worker','Preserve Ω'),
    ('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004','{}','synthetic-worker','Preserve Ψ');
   SET session_replication_role=origin;`);
    const actualBefore = await collectSchemaCatalog(db);
    const normalized = {
      ...actualBefore,
      constraints: actualBefore.constraints.filter((c) => c.kind !== "n"),
    };
    // Exact native16 and embedded definition hashes, measured independently. No name-only masking.
    const formatting = new Map([
      [
        ".callie_reception_events.callie_reception_event_key_ck",
        [
          "8da63a25c96055bfebb66cb927cbc61d213bcde51167816df2487eb235d17041",
          "a3ae8ca9acc68a9e0201f86bf448f3f52229c97ebee26b066b9fe98137dd6040",
        ],
      ],
      [
        ".callie_reception_sessions.callie_reception_session_bounded_ck",
        [
          "98cefbe7ba9e989e04cd294d826f2f184b0b2bb3c2c13bf130aecc756407c376",
          "f25497263edc2bfaaf3ff4c586d801f7a0e08a32cb7997d47e7755f16931e580",
        ],
      ],
      [
        ".invoice_delivery_attempts.invoice_attempt_ordinal_ck",
        [
          "cc2b22f34735aa2a6c3499c951261ab1c8cfdc8102279eb523273e23f7159bdd",
          "3cbd7f681113c57df649d376d6217f19604d82981c2426d364637dde2aac8547",
        ],
      ],
    ]);
    const differences = catalogDifferences(normalized, beforeCatalog, {
      physical: true,
    });
    if (
      differences.some((d) => {
        const pair = formatting.get(d.name),
          find = (c) =>
            c.constraints.find((r) => `.${r.table_name}.${r.name}` === d.name);
        return (
          d.section !== "constraints" ||
          !pair ||
          d.kind !== "changed" ||
          d.fields.join(",") !== "definition" ||
          sha(find(beforeCatalog).definition) !== pair[0] ||
          sha(find(normalized).definition) !== pair[1]
        );
      })
    )
      throw Error("fixture_old142_catalog_drift");
    const before = await independentState(
      db,
      beforeCatalog,
      policyBefore,
      "pre0019",
    );
    await db.exec(sourceInput.bytes.toString("utf8"));
    const actualAfter = await collectSchemaCatalog(db),
      afterCatalog = {
        ...actualAfter,
        constraints: actualAfter.constraints
          .filter((c) => c.kind !== "n")
          .map(
            (c) =>
              beforeCatalog.constraints.find(
                (old) => old.table_name === c.table_name && old.name === c.name,
              ) ?? c,
          ),
      };
    for (const old of actualBefore.constraints) {
      const current = actualAfter.constraints.find(
        (c) => c.table_name === old.table_name && c.name === old.name,
      );
      if (JSON.stringify(current) !== JSON.stringify(old))
        throw Error("fixture_retained_check_changed");
    }
    const after = await independentState(
      db,
      afterCatalog,
      policyAfter,
      "post0019",
    );
    const catalogs = { before: beforeCatalog, after: afterCatalog };
    const sourceBinding = {
      candidate: {
        repository: "diazdestination/mogulforge-growthos",
        commit: "98a90d69f28d898524da8ea2f945df768fcde2a3",
        tree: "a".repeat(40),
      },
      moduleManifestSha256: "b".repeat(64),
    };
    const fixture = {
      sourceInput,
      catalogs,
      target,
      policyBefore,
      policyAfter,
      before,
      after,
      sourceBinding,
    };
    const clientFor = (phase = "post0019", transform = (sql) => sql) => ({
      query: async (sql, args) => {
        const state = phase === "post0019" ? after : before;
        if (sql === IDENTITY_SQL)
          return { rows: [structuredClone(state.identity)] };
        const key = Object.keys(CATALOG_QUERIES).find(
          (k) => CATALOG_QUERIES[k] === sql,
        );
        if (key) return { rows: structuredClone(state.catalog[key]) };
        if (sql === OWNERSHIP_SQL)
          return { rows: structuredClone(state.policy.ownership) };
        const section = Object.keys(PRODUCTION75_PRIVILEGE_QUERIES).find(
          (k) => PRODUCTION75_PRIVILEGE_QUERIES[k] === sql,
        );
        if (section)
          return { rows: structuredClone(state.policy.privileges[section]) };
        return db.query(transform(sql), args);
      },
    });
    return await callback(fixture, { db, clientFor, sha });
  } finally {
    await db.close();
  }
}
export const makeScheduling0019Fixture = (options) =>
  withScheduling0019Database(options, async (f) => f);
