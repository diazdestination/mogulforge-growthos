import { readFile } from "node:fs/promises";
import { legacyModel } from "./production75-legacy-model.mjs";
import { expectedProduction75ReaderProfile } from "./production75-reader-delta.mjs";
import { assertLegacyReaderCapabilities } from "./production75-legacy-model.mjs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeScheduling0019Fixture } from "./production75-scheduling0019-test-support.mjs";
import { buildScheduling0019Source } from "./production75-scheduling0019.mjs";
import { buildProduction75Source } from "./production75-source.mjs";
import { PINNED_FILES, SOURCE_COMMIT } from "./production75-pins.mjs";
import {
  production75RuntimeHashes,
  combinedManifestDigest,
} from "./production75-live-manifest.mjs";
import { catalogDigest } from "../reports/release-preparation-2026-10-09/schema-catalog.mjs";

/** Explicitly synthetic unit data; never actual native authority or admission. */
export async function makeCombinedFixture() {
  const root = new URL("../", import.meta.url),
    read = async (p) => JSON.parse(await readFile(new URL(p, root), "utf8"));
  const fixtures = await Promise.all([
    makeScheduling0019Fixture({ layout: 0 }),
    makeScheduling0019Fixture({ layout: 1 }),
  ]);
  const readerName = fixtures[0].target.readerLogin;
  const native = await read(
    "reports/authenticated-driver-2026-10-12/8baf71b8-1e59-410a-9291-e9f955eae32f/oracle.json",
  );
  const rename = (v) =>
    Array.isArray(v)
      ? v.map(rename)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rename(x)]))
        : v === native.templateReader
          ? readerName
          : v;
  const order = (rows, fields) =>
    rows.sort((a, b) => {
      for (const k of fields) {
        const x = a[k] ?? "",
          y = b[k] ?? "";
        if (x !== y) return x < y ? -1 : 1;
      }
      return 0;
    });
  const sortPolicy = (p) => {
    order(p.ownership, ["kind", "schema", "name", "sub_name"]);
    for (const [k, rows] of Object.entries(p.privileges))
      order(
        rows,
        k === "memberships"
          ? ["role", "member", "grantor"]
          : k === "columns"
            ? ["principal", "table_name", "name"]
            : ["principal", "name"],
      );
    return p;
  };
  const policies = Object.fromEntries(
    [75, 95, 142].map((n) => [n, sortPolicy(rename(native.policies[n]))]),
  );
  for (const f of fixtures) {
    f.target.principals = [
      "fly-user",
      "growthos-staging-live",
      "reader",
      readerName,
    ];
    f.policyBefore = structuredClone(policies[142]);
    f.policyAfter = structuredClone(f.policyBefore);
    for (const [table, column] of [
      ["appointments", "scheduling_reservation"],
      ["org_settings", "scheduling_policy"],
      ["projects", "scheduling_reservation"],
    ]) {
      f.policyAfter.ownership.push({
        kind: "column",
        schema: "public",
        name: table,
        sub_name: column,
        owner: "schema_admin",
        acl: "DEFAULT",
      });
      for (const principal of f.target.principals) {
        const t = f.policyBefore.privileges.tables.find(
          (r) => r.principal === principal && r.name === table,
        );
        f.policyAfter.privileges.columns.push({
          principal,
          table_name: table,
          name: column,
          select: t.select,
          insert: t.insert,
          update: t.update,
          references: t.references,
        });
      }
    }
    sortPolicy(f.policyAfter);
    f.before.policy = structuredClone(f.policyBefore);
    f.after.policy = structuredClone(f.policyAfter);
  }
  const source = buildProduction75Source(
    PINNED_FILES.map((pin) => ({
      ...pin,
      bytes: execFileSync("git", ["show", `${SOURCE_COMMIT}:${pin.path}`], {
        cwd: fileURLToPath(root),
        windowsHide: true,
        maxBuffer: 200000,
      }),
    })),
  );
  const schedulingSource = buildScheduling0019Source(fixtures[0].sourceInput),
    { sql, ...descriptor } = schedulingSource;
  const candidate = {
    repository: "diazdestination/mogulforge-growthos",
    commit: "1".repeat(40),
    tree: "2".repeat(40),
  };
  const catalogs = {
    legacy: {
      fly75: await read(
        "reports/production75-recovery-2026-10-11/catalog75-fly-db.json",
      ),
      other75: await read(
        "reports/production75-recovery-2026-10-11/catalog75-growthos_staging.json",
      ),
      canonical95: await read(
        "reports/staging-observation-2026-10-10/fixtures/catalog-95.json",
      ),
      canonical142: await read(
        "reports/staging-observation-2026-10-10/fixtures/catalog-142.json",
      ),
    },
    scheduling: fixtures.map((f) => f.catalogs),
  };
  const oracle = {
    kind: "OWNED_NATIVE_COMBINED_POLICY_ORACLE",
    candidate,
    legacy: {
      kind: "OWNED_NATIVE_POLICY_ORACLE",
      sourceCandidate: "8df64dc72009832f93b2b491031acd1bb2afb903",
      templateReader: readerName,
      policies,
    },
    scheduling: {
      source: descriptor,
      layouts: fixtures.map((f) => ({
        templateReader: readerName,
        catalogs: f.catalogs,
        policies: { before: f.policyBefore, after: f.policyAfter },
      })),
      coverage: {
        tables: 142,
        columnsBefore: 1867,
        columnsAfter: 1870,
        layouts: 2,
      },
    },
  };
  const modules = production75RuntimeHashes(() => "synthetic unit runtime\n"),
    legacySource = {
      sourceCommit: source.sourceCommit,
      sourceFiles: source.sourceFiles,
      steps: source.steps.map(({ sql, ...s }) => s),
    };
  const input = {
    modules,
    legacySource,
    schedulingSource: descriptor,
    catalogs,
    oracle,
    candidate,
  };
  const hash = (v) =>
    createHash("sha256").update(JSON.stringify(v)).digest("hex");
  const deltaResult = (outcome, reconciled = false) => ({
    kind: "SCHEDULING0019_VERIFICATION",
    status: reconciled ? "reconciled-commit-no-replay" : `verified-${outcome}`,
    attemptId: randomUUID(),
    baselineSha256: "6".repeat(64),
    sourceSha256: descriptor.sha256,
    errorCode: null,
    proof: {
      originalTables: 142,
      originalColumns: 1867,
      newColumns: 3,
      nullColumnsVerified: 3,
      reservationConfirmed: true,
      beginDispatched: true,
      beginAcknowledged: true,
      sourceDispatched: true,
      sourceAcknowledged: true,
      commitDispatched: outcome === "commit",
      commitAcknowledged: outcome === "commit" && !reconciled,
      rollbackDispatched: outcome === "rollback",
      rollbackAcknowledged: outcome === "rollback",
      freshReaderVerified: true,
      journalConfirmed: !reconciled,
      preimageVerified: true,
      postimageVerified: true,
      transactionClosure: reconciled
        ? "unconfirmed"
        : `acknowledged-${outcome}`,
      requiresOwningCleanup: reconciled,
    },
  });
  const caseResult = (lost) => ({
    status: "verified-and-cleaned",
    copyDeleted: true,
    originalsPreserved: true,
    resourcesClosed: true,
    outcomes: {
      rollback: { status: "verified-rollback" },
      commit: {
        status: lost ? "reconciled-commit-no-replay" : "verified-commit",
      },
      scheduling: {
        rollback: deltaResult("rollback"),
        commit: deltaResult("commit"),
      },
    },
  });
  const proof = {
    kind: "SYNTHETIC_PROXY_REAL_DRIVER_SQL_COMBINED",
    status: "PASS",
    candidate,
    sourceCandidate: oracle.legacy.sourceCandidate,
    liveProviderCalls: false,
    legacySource,
    catalogs,
    oracleSha256: hash(oracle),
    moduleManifestSha256: combinedManifestDigest(input),
    moduleHashesBefore: modules,
    moduleHashesAfter: modules,
    cleanup: {
      clients: 10,
      sockets: 10,
      expectedClients: 10,
      containers: 8,
      expectedContainers: 8,
    },
    ownedContainers: Array.from({ length: 8 }, (_, i) => ({
      runId: `${String(i + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
      name: `production75-local-123-${String(i + 1).padStart(8, "0")}`,
      id: String(i + 1).repeat(64),
      removed: true,
      loopbackOnly: true,
      storage: {
        type: "tmpfs",
        destination: "/var/lib/postgresql/data",
        sizeBytes: 536870912,
        writable: true,
        volumeMounts: 0,
      },
    })),
    storageInventory: { before: [], after: [], unchanged: true },
    transportProofs: Array.from({ length: 3 }, () => ({
      clients: 2,
      clientsClosed: 2,
      socketsClosed: 2,
      proxies: 1,
      proxiesClosed: 1,
    })),
    cases: {
      normal: {
        result: caseResult(false),
        mutationCounts: { create: 1, reader: 1, delete: 1 },
      },
      "lost-commit": {
        result: caseResult(true),
        mutationCounts: { create: 1, reader: 1, delete: 1 },
      },
      "idle-client-error": {
        result: {
          status: "held-and-cleaned",
          copyDeleted: true,
          originalsPreserved: true,
          resourcesClosed: true,
          outcomes: {},
        },
        mutationCounts: { create: 1, reader: 1, delete: 1 },
      },
    },
    schedulingCases: fixtures.map((f, i) => ({
      beforeCatalogSha256: catalogDigest(f.catalogs.before, { physical: true }),
      afterCatalogSha256: catalogDigest(f.catalogs.after, { physical: true }),
      coverage: { tables: 142, columnsBefore: 1867, columnsAfter: 1870 },
      rollback: deltaResult("rollback"),
      lateFailure: {
        result: {
          ...deltaResult("rollback"),
          status: "failed-or-held",
          errorCode: "scheduling0019_verification_database",
          proof: {
            ...deltaResult("rollback").proof,
            sourceAcknowledged: false,
            postimageVerified: false,
            nullColumnsVerified: 0,
            journalConfirmed: false,
          },
        },
        rollbackAcknowledged: true,
        preimagePreserved: true,
        sqlState: "23514",
        failedConstraint: "projects_scheduling_reservation_ck",
      },
      commit: deltaResult("commit", i === 1),
      sourceDispatches: { rollback: 1, lateFailure: 1, commit: 1 },
      readerWriteDenied: true,
      duplicateMultiplicityVerified: true,
      sameCountDriftRejected: true,
      noDdlAfterPostimage: true,
      preLockConcurrentDriftRejected: true,
    })),
  };
  proof.storageMountEvidence = proof.ownedContainers.map(
    ({ runId, name, id }) => ({
      runId,
      name,
      id,
      Mounts: [
        { Type: "tmpfs", Destination: "/var/lib/postgresql/data", RW: true },
      ],
      HostConfig: {
        Mounts: [
          {
            Type: "tmpfs",
            Target: "/var/lib/postgresql/data",
            ReadOnly: false,
            TmpfsOptions: { SizeBytes: 536870912, Mode: 448 },
          },
        ],
      },
    }),
  );
  return {
    fixtures,
    source,
    schedulingSource,
    descriptor,
    candidate,
    catalogs,
    oracle,
    modules,
    input,
    proof,
    readerName,
    deltaResult,
    hash,
  };
}
export function combinedSourceSnapshot(f) {
  const snapshot = deltaFixture(f.readerName).before,
    policy = structuredClone(f.oracle.legacy.policies[75]);
  for (const [section, rows] of Object.entries(policy.privileges))
    policy.privileges[section] = rows.filter(
      (r) =>
        r.principal !== f.readerName &&
        r.name !== f.readerName &&
        r.member !== f.readerName &&
        r.role !== f.readerName,
    );
  snapshot.databases.find((d) => d.name === "fly-db").policy = policy;
  return snapshot;
}
export function verificationFixture(after, readerName) {
  const a = structuredClone(after),
    target = a.databases.find((d) => d.name === "fly-db"),
    otherDatabases = a.databases
      .filter((d) => d.name !== "fly-db")
      .map(({ identity, ...d }) => d),
    capabilities = assertLegacyReaderCapabilities(target.policy, {
      readerLogin: readerName,
      readerRole: readerName,
      writerRole: "schema_admin",
    }),
    sha = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
  return {
    plan: {
      target: {
        database: "fly-db",
        writerLogin: "fly-user",
        writerRole: "schema_admin",
        readerLogin: readerName,
        readerRole: readerName,
        principals: ["reader", readerName],
      },
      sourceCommit: "7091af816715cfd437925eb0af82fb47d3411e34",
      policies: { 75: structuredClone(target.policy) },
      catalog75: structuredClone(target.catalog),
    },
    writer: { query: () => {} },
    baseline: {
      state: {
        phase: 75,
        catalog: target.catalog,
        fingerprints: target.fingerprints,
        policy: target.policy,
        identity: target.identity,
      },
      extra: target.extra,
      capabilities,
      otherDatabases,
    },
    expectedExtra: structuredClone(target.extra),
    capabilityReview: {
      receiptSha256: "c".repeat(64),
      readerLogin: readerName,
      readerRole: readerName,
      extraSha256: sha(target.extra),
      capabilitiesSha256: sha(capabilities),
    },
    readFresh: async () => ({}),
  };
}
const catalog = JSON.parse(
  await readFile(
    new URL(
      "../reports/production75-recovery-2026-10-11/catalog75-fly-db.json",
      import.meta.url,
    ),
  ),
);
export function deltaFixture(
  readerName = "growthos-reader-abcdef01234546789abcdef012345678",
) {
  const READER = readerName,
    SOURCE = "fly-user";
  const profile = expectedProduction75ReaderProfile(READER),
    global = structuredClone(legacyModel().roles),
    group = global.find((r) => r.name === "reader");
  const roleRow = (r, principal) => {
    const { connection_limit, ...flags } = r;
    return { principal, ...flags, member: true, usable: true, can_set: true };
  };
  const database = (name) => {
    const populated = name !== "mogulforge-growthos-db",
      c = populated
        ? structuredClone(catalog)
        : {
            ...structuredClone(catalog),
            tables: [],
            columns: [],
            enums: [],
            foreignKeys: [],
            indexes: [],
            checks: [],
          },
      principal = "reader";
    return {
      name,
      catalog: c,
      fingerprints: c.tables.map((t) => ({
        table: t.name,
        rows: 0,
        bytes: 0,
        digest: "d41d8cd98f00b204e9800998ecf8427e",
      })),
      identity: {
        database: name,
        login: SOURCE,
        role: "schema_admin",
        version: 160014,
        pid: 10,
        read_only: "on",
        isolation: "repeatable read",
      },
      extra: {
        roles: structuredClone(global),
        roleSettings: [],
        extensions: [],
        extensionObjects: [],
        databases: [{ name: "postgres", acl: "PUBLIC TEMP" }],
      },
      policy: {
        ownership: [
          {
            kind: "schema",
            name: "public",
            owner: "pg_database_owner",
            acl: "same",
          },
        ],
        privileges: {
          memberships: structuredClone(legacyModel().memberships),
          roles: [
            roleRow(group, principal),
            roleRow(
              global.find((r) => r.name === "pg_read_all_data"),
              principal,
            ),
          ],
          tables: c.tables.map((t) => ({
            principal,
            name: t.name,
            owner: "schema_admin",
            select: true,
            insert: false,
            update: false,
            delete: false,
            truncate: false,
            references: false,
            trigger: false,
          })),
          columns: c.columns.map((x) => ({
            principal,
            table_name: x.table_name,
            name: x.name,
            select: true,
            insert: false,
            update: false,
            references: false,
          })),
          namespaces: [
            { principal, name: "public", create: false, usage: true },
          ],
          database: [
            { principal, name, create: false, connect: true, temporary: false },
          ],
          functions: [
            {
              principal,
              name: "provider",
              execute: true,
              security_definer: true,
              volatility: "v",
            },
          ],
          publicGrants: [{ name: "provider", privilege_type: "EXECUTE" }],
          defaultGrants: [],
        },
      },
    };
  };
  const before = {
      databases: ["fly-db", "growthos_staging", "mogulforge-growthos-db"].map(
        database,
      ),
    },
    after = structuredClone(before);
  for (const d of after.databases) {
    d.identity = { ...d.identity, login: READER, role: READER, pid: 20 };
    d.extra.roles.push(structuredClone(profile.role));
    d.extra.roles.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    d.policy.privileges.memberships.push(structuredClone(profile.membership));
    d.policy.privileges.memberships.sort((a, b) =>
      a.role < b.role
        ? -1
        : a.role > b.role
          ? 1
          : a.member < b.member
            ? -1
            : a.member > b.member
              ? 1
              : 0,
    );
    for (const [section, rows] of Object.entries(d.policy.privileges)) {
      if (["memberships", "publicGrants", "defaultGrants"].includes(section))
        continue;
      const added = rows
        .filter((r) => r.principal === "reader")
        .map((r) => ({ ...r, principal: READER }));
      if (section === "roles") added.push(roleRow(profile.role, READER));
      rows.push(...added);
      rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
  }
  return { before, after, readerName: READER, expectedProfile: profile };
}
