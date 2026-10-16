// Synthetic policy fixtures and exact callback bodies. No provider access,
// credentials, source snapshots, or mutation admission.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { deltaFixture } from "../production75-operator-test-support.mjs";
import { assertProduction75ReaderDelta } from "../production75-reader-delta.mjs";
import { assertLegacyReaderCapabilities } from "../production75-legacy-model.mjs";

export function readerTimingCase({
  kind,
  otherDatabaseMs = 20001,
  source,
  actualReader,
  captureOthers,
  mainFailure,
  otherFailure,
} = {}) {
  if (!["legacy", "scheduling"].includes(kind))
    throw Error("invalid_test_kind");
  source ??= readFileSync(
    new URL("../production75-live-runner.mjs", import.meta.url),
    "utf8",
  );
  source = source.replaceAll("\r\n", "\n");
  const begin =
    kind === "legacy"
      ? "verificationContext: "
      : "callbacks.schedulingContext = ";
  const end =
    kind === "legacy"
      ? "\n  };\n  if (combinedMode)"
      : "\n  try {\n    return await runProduction75Operator";
  const start = source.indexOf(begin),
    stop = source.indexOf(end, start + begin.length);
  if (start < 0 || stop < start)
    throw Error("production_callback_boundary_changed");
  const body = source
    .slice(start + begin.length, stop)
    .trim()
    .replace(kind === "legacy" ? /,$/ : /;$/, "");
  const fixture = deltaFixture(),
    projected = fixture.after,
    readerName = fixture.readerName;
  const delta = assertProduction75ReaderDelta({
    ...fixture,
    readerName,
    expectedProfile: fixture.expectedProfile,
  });
  const app = projected.databases.find((d) => d.name === "fly-db"),
    others = projected.databases.filter((d) => d.name !== "fly-db");
  const capabilities = assertLegacyReaderCapabilities(app.policy, {
    readerLogin: readerName,
    readerRole: readerName,
    writerRole: "schema_admin",
  });
  const metrics = {
    begin: 0,
    rollback: 0,
    writerCalls: 0,
    otherCaptures: 0,
    otherInsideTransaction: [],
    transactionOpen: false,
  };
  let clock = 0,
    lastQueryAt = 0;
  const reader = {
    query: async (sql) => {
      if (sql.startsWith("BEGIN")) {
        const result = actualReader
          ? await actualReader.query(sql)
          : { command: "BEGIN" };
        metrics.begin++;
        metrics.transactionOpen = true;
        lastQueryAt = clock;
        return result;
      }
      if (sql === "ROLLBACK") {
        metrics.rollback++;
        if (
          !actualReader &&
          metrics.transactionOpen &&
          clock - lastQueryAt > 20000
        )
          throw Object.assign(Error("simulated idle termination"), {
            safeCode: "production75_live_client",
          });
        const result = actualReader
          ? await actualReader.query(sql)
          : { command: "ROLLBACK" };
        metrics.transactionOpen = false;
        lastQueryAt = clock;
        return result;
      }
      throw Error("unexpected_test_reader_query");
    },
  };
  const writer = {
    query: async () => {
      metrics.writerCalls++;
      throw Error("writer_must_remain_unused");
    },
  };
  const layout = {
    catalogs: {
      before: { fixture: "layout0" },
      after: { fixture: "layout0-after" },
    },
    policies: { before: {}, after: {} },
    templateReader: "synthetic-template",
  };
  const state = {
    phase: kind === "legacy" ? 75 : "pre0019",
    policy: app.policy,
  };
  const captureMain = async () => {
    if (mainFailure) throw mainFailure;
    return state;
  };
  const env = {
    verifyLiveProtectedApps: async () => true,
    transport: {
      connect: async (_proxy, _database, _credentials, options) =>
        options.readonly ? reader : writer,
    },
    packet: { protectedApps: {}, capabilities },
    coreContext: () => ({
      target: { principals: [] },
      catalog75: {},
      catalog142: {},
    }),
    combinedMode: true,
    legacyDeps: (x) => x,
    deps: {
      oracle: { scheduling: { layouts: [layout] } },
      schedulingSource: {},
    },
    proxy: async () => ({}),
    credentials: async () => ({}),
    createProduction75Observer: () => ({}),
    captureProduction75State: captureMain,
    captureProduction75Extras: async () => app.extra,
    snapshot: async () => {
      metrics.otherCaptures++;
      metrics.otherInsideTransaction.push(metrics.transactionOpen);
      clock += otherDatabaseMs;
      if (captureOthers) await captureOthers();
      if (otherFailure) throw otherFailure;
      return { databases: others };
    },
    assertLegacyReaderCapabilities,
    freeze: (x) => x,
    check: (ok, code) => {
      if (!ok) throw Object.assign(Error(code), { safeCode: code });
    },
    digest: (x) => createHash("sha256").update(JSON.stringify(x)).digest("hex"),
    review: { receiptSha256: "0".repeat(64) },
    isDeepStrictEqual,
    committedLegacyPlan: {
      catalog142: layout.catalogs.before,
      policies: { 142: app.policy },
      target: { principals: [] },
    },
    committedProtected: {
      extra: app.extra,
      otherDatabases: others.map(({ identity, ...d }) => d),
      capabilities,
    },
    catalogDigest: (x) => JSON.stringify(x),
    deriveLiveScheduling0019Policy: () => ({ before: {}, after: {} }),
    prepareScheduling0019: () => ({
      target: { principals: [] },
      catalogs: layout.catalogs,
    }),
    guardCombinedSchedulingWriter: ({ writer }) => writer,
    createScheduling0019Observer: () => ({}),
    captureScheduling0019State: captureMain,
  };
  const callback = Function(
    ...Object.keys(env),
    "return (" + body + ");",
  )(...Object.values(env));
  return {
    metrics,
    run: () =>
      callback({
        copy: { id: "synthetic-only" },
        readerName,
        afterReader: projected,
        delta,
        custody: {},
        resources: { signal: { aborted: false } },
        plan: { candidate: {}, moduleManifestSha256: "0".repeat(64) },
      }),
  };
}
