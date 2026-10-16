/** Explicit read-only prepare / separately admitted one-copy execution. Import-safe. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual, types } from "node:util";
import { createNativeLiveTransport } from "./production75-live-transport.mjs";
import {
  authenticateAttestation,
  createNativeAttestationAuthenticator,
} from "./production75-live-admission.mjs";
import {
  createOperatorResources,
  runProduction75Operator,
} from "./production75-operator.mjs";
import {
  prepareOperatorPlan,
  prepareCombinedOperatorPlan,
  operatorPlanDigest,
  production75ReaderName,
} from "./production75-custody.mjs";
import {
  expectedProduction75ReaderProfile,
  production75ProfileDigest,
  production75SnapshotDigest,
  assertProduction75ReaderDelta,
} from "./production75-reader-delta.mjs";
import {
  createProduction75V1Client,
  useProduction75Credentials,
} from "./production75-fly-v1.mjs";
import {
  captureLiveSnapshot,
  projectLiveReader,
  validateSourceSnapshot,
} from "./production75-live-observation.mjs";
import {
  deriveLivePolicies,
  deriveLiveScheduling0019Policy,
} from "./production75-live-policy.mjs";
import {
  buildScheduling0019Source,
  prepareScheduling0019,
  captureScheduling0019State,
  assertScheduling0019Catalogs,
} from "./production75-scheduling0019.mjs";
import { createScheduling0019Observer } from "./production75-scheduling0019-observer.mjs";
import { catalogDigest } from "../reports/release-preparation-2026-10-09/schema-catalog.mjs";
import {
  prepareProduction75,
  deriveProduction75Catalogs,
  captureProduction75State,
} from "./production75-core.mjs";
import {
  createProduction75Observer,
  captureProduction75Extras,
} from "./production75-observer.mjs";
import { assertLegacyReaderCapabilities } from "./production75-legacy-model.mjs";
import {
  buildProduction75Source,
  assertProduction75Source,
} from "./production75-source.mjs";
import { PINNED_FILES } from "./production75-pins.mjs";
import {
  production75RuntimeHashes,
  PRODUCTION75_RUNTIME_FILES,
  combinedManifestDigest,
} from "./production75-live-manifest.mjs";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  BASE = "8df64dc72009832f93b2b491031acd1bb2afb903",
  SOURCE = "kzpwm0j18eg04nv3",
  STAGE = "zp2wjrejd2zodn4q";
const sha = (v) => createHash("sha256").update(v).digest("hex"),
  digest = (v) => sha(JSON.stringify(v));
const check = (v, code) => {
  if (!v) throw Object.assign(new Error(code), { safeCode: code });
};
const freeze = (v) => {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
const moduleHashes = () =>
  production75RuntimeHashes((p) => readFileSync(resolve(ROOT, p), "utf8"));
const planInput = (p) =>
  Object.fromEntries(
    [
      "runId",
      "backupId",
      "sourceSnapshotSha256",
      "profileSha256",
      "moduleManifestSha256",
      "preparedAt",
      "workMs",
      "cleanupMs",
      "maxCostUsdMicros",
    ].map((k) => [k, p[k]]),
  );
function coreContext(deps, afterReader, readerName) {
  const policy75 = afterReader.databases.find(
      (d) => d.name === "fly-db",
    ).policy,
    policies = deriveLivePolicies({
      baseline: policy75,
      oracle: deps.oracle.policies,
      readerName,
      templateReader: deps.oracle.templateReader,
    }),
    target = {
      database: "fly-db",
      writerLogin: "fly-user",
      writerRole: "schema_admin",
      writerInitialRoles: ["fly-user", "schema_admin"],
      readerLogin: readerName,
      readerRole: readerName,
      principals: ["fly-user", "growthos-staging-live", "reader", readerName],
    };
  return prepareProduction75({
    source: deps.source,
    catalog75: deps.catalogs.fly75,
    canonical95: deps.catalogs.canonical95,
    canonical142: deps.catalogs.canonical142,
    target,
    ...policies,
  });
}
export function validateLiveOracle(oracle, proof, currentHashes = {}) {
  check(
    oracle?.kind === "OWNED_NATIVE_POLICY_ORACLE" &&
      oracle.sourceCandidate === BASE &&
      proof?.kind === "SYNTHETIC_PROXY_REAL_DRIVER_SQL" &&
      proof.status === "PASS" &&
      proof.sourceCandidate === BASE &&
      proof.liveProviderCalls === false &&
      proof.cleanup &&
      proof.cleanup.clients === proof.cleanup.expectedClients &&
      proof.cleanup.sockets === proof.cleanup.expectedClients &&
      proof.cleanup.containers === 6 &&
      proof.cleanup.expectedContainers === 6 &&
      proof.oracleSha256 === digest(oracle) &&
      Object.keys(proof.moduleHashesAfter ?? {}).join(",") ===
        PRODUCTION75_RUNTIME_FILES.join(",") &&
      isDeepStrictEqual(proof.moduleHashesBefore, proof.moduleHashesAfter) &&
      PRODUCTION75_RUNTIME_FILES.every(
        (p) => proof.moduleHashesAfter[p] === currentHashes[p],
      ),
    "production75_live_oracle",
  );
  check(
    proof.cases?.normal?.result?.status === "verified-and-cleaned" &&
      proof.cases?.["lost-commit"]?.result?.outcomes?.commit?.status ===
        "reconciled-commit-no-replay" &&
      proof.cases?.["idle-client-error"]?.result?.status ===
        "held-and-cleaned" &&
      proof.transportProofs?.length > 0 &&
      proof.transportProofs.every(
        (t) =>
          t.clients === t.clientsClosed &&
          t.clients === t.socketsClosed &&
          t.proxies === t.proxiesClosed,
      ),
    "production75_live_oracle",
  );
  return freeze(structuredClone(oracle));
}
export async function prepareLivePacket(deps, options = {}) {
  check(
    deps?.oracle?.kind !== "OWNED_NATIVE_COMBINED_POLICY_ORACLE",
    "production75_live_preparation",
  );
  return preparePacket(deps, options, false);
}
function combinedData(input) {
  let nodes = 0,
    bytes = 0;
  const seen = new Set(),
    fail = () => check(false, "production75_combined_live_oracle");
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
    const a = Array.isArray(v);
    if (Object.getPrototypeOf(v) !== (a ? Array.prototype : Object.prototype))
      fail();
    seen.add(v);
    const out = a ? [] : {},
      own = Reflect.ownKeys(v);
    for (const k of own) {
      if (a && k === "length") continue;
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (
        typeof k !== "string" ||
        !d.enumerable ||
        !Object.hasOwn(d, "value") ||
        (a && !/^(0|[1-9][0-9]*)$/.test(k))
      )
        fail();
      bytes += Buffer.byteLength(k) + 4;
      if (bytes > 32000000) fail();
      Object.defineProperty(out, k, {
        value: copy(d.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (a && (own.length !== v.length + 1 || out.length !== v.length)) fail();
    seen.delete(v);
    return out;
  };
  return copy(input);
}
const schedulingGuardedWriters = new WeakSet();
/** Caller owns the socket. A late app check cannot start a transaction. */
export function guardCombinedSchedulingWriter(input) {
  const code = "production75_combined_writer_guard";
  check(input && typeof input === "object" && !types.isProxy(input), code);
  const fields = Reflect.ownKeys(input);
  check(
    fields.every(
      (k) =>
        typeof k === "string" &&
        ["writer", "resources", "verifyProtected", "now"].includes(k) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(input, k), "value"),
    ),
    code,
  );
  const { writer, resources, verifyProtected, now = Date.now } = input;
  check(
    writer &&
      typeof writer === "object" &&
      !types.isProxy(writer) &&
      resources &&
      typeof resources === "object" &&
      !types.isProxy(resources) &&
      typeof verifyProtected === "function" &&
      typeof now === "function",
    code,
  );
  const queryDescriptor = Object.getOwnPropertyDescriptor(writer, "query"),
    activeDescriptor = Object.getOwnPropertyDescriptor(
      resources,
      "assertActive",
    ),
    deadlineDescriptor = Object.getOwnPropertyDescriptor(resources, "deadline");
  check(
    queryDescriptor &&
      Object.hasOwn(queryDescriptor, "value") &&
      typeof queryDescriptor.value === "function" &&
      activeDescriptor &&
      Object.hasOwn(activeDescriptor, "value") &&
      typeof activeDescriptor.value === "function" &&
      deadlineDescriptor &&
      Object.hasOwn(deadlineDescriptor, "value") &&
      Number.isFinite(deadlineDescriptor.value) &&
      !schedulingGuardedWriters.has(writer),
    code,
  );
  schedulingGuardedWriters.add(writer);
  const query = queryDescriptor.value,
    active = activeDescriptor.value.bind(resources),
    deadline = deadlineDescriptor.value;
  let unusable = false,
    busy = false;
  return Object.freeze({
    connection: writer.connection,
    query: async (...args) => {
      check(!unusable && !busy, code);
      active();
      busy = true;
      try {
        if (args[0] === "BEGIN ISOLATION LEVEL REPEATABLE READ") {
          const until = Math.min(deadline, now() + 12000);
          let timer;
          try {
            check(now() < until, code);
            const value = await Promise.race([
              Promise.resolve().then(verifyProtected),
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(Object.assign(Error(code), { safeCode: code })),
                  Math.max(1, until - now()),
                );
              }),
            ]);
            check(value === true && now() < until, code);
            active();
          } catch (e) {
            unusable = true;
            throw e;
          } finally {
            clearTimeout(timer);
          }
        }
        active();
        return await query.apply(writer, args);
      } finally {
        busy = false;
      }
    },
  });
}
const legacyDescriptor = (source) => ({
  sourceCommit: source.sourceCommit,
  sourceFiles: source.sourceFiles,
  steps: source.steps.map(({ sql, ...s }) => s),
});
const combinedInputs = (deps, modules) => ({
  modules,
  legacySource: legacyDescriptor(deps.source),
  schedulingSource: deps.oracle.scheduling.source,
  catalogs: {
    legacy: deps.catalogs,
    scheduling: deps.oracle.scheduling.layouts.map((l) => l.catalogs),
  },
  oracle: deps.oracle,
  candidate: deps.candidate,
});
const legacyDeps = (deps) => ({ ...deps, oracle: deps.oracle.legacy });
function deltaProof(r, outcome, reconciled = false) {
  const p = r?.proof;
  return (
    r?.kind === "SCHEDULING0019_VERIFICATION" &&
    r.status ===
      (reconciled ? "reconciled-commit-no-replay" : `verified-${outcome}`) &&
    p?.originalTables === 142 &&
    p.originalColumns === 1867 &&
    p.newColumns === 3 &&
    p.nullColumnsVerified === 3 &&
    p.reservationConfirmed === true &&
    p.beginDispatched === true &&
    p.beginAcknowledged === true &&
    p.freshReaderVerified === true &&
    p.preimageVerified === true &&
    p.postimageVerified === true &&
    p.sourceDispatched === true &&
    p.sourceAcknowledged === true &&
    (outcome === "rollback"
      ? p.rollbackDispatched === true &&
        p.rollbackAcknowledged === true &&
        p.commitDispatched === false &&
        p.commitAcknowledged === false
      : p.rollbackDispatched === false &&
        p.rollbackAcknowledged === false &&
        p.commitDispatched === true &&
        (reconciled
          ? p.commitAcknowledged === false
          : p.commitAcknowledged === true)) &&
    p.journalConfirmed === !reconciled &&
    p.transactionClosure ===
      (reconciled ? "unconfirmed" : `acknowledged-${outcome}`) &&
    p.requiresOwningCleanup === reconciled
  );
}
function assertCombinedNativeStorage(proof, code) {
  const storage = {
    type: "tmpfs",
    destination: "/var/lib/postgresql/data",
    sizeBytes: 536870912,
    writable: true,
    volumeMounts: 0,
  };
  const inventory = proof.storageInventory;
  check(
    inventory &&
      isDeepStrictEqual(Object.keys(inventory).sort(), [
        "after",
        "before",
        "unchanged",
      ]) &&
      inventory.unchanged === true &&
      isDeepStrictEqual(inventory.before, inventory.after),
    code,
  );
  for (const names of [inventory.before, inventory.after]) {
    check(
      Array.isArray(names) &&
        names.length <= 10000 &&
        names.every(
          (name) =>
            typeof name === "string" &&
            /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(name),
        ) &&
        new Set(names).size === names.length &&
        isDeepStrictEqual(names, [...names].sort()) &&
        names.reduce((bytes, name) => bytes + Buffer.byteLength(name) + 1, 0) <=
          1048576,
      code,
    );
  }
  check(
    Array.isArray(proof.storageMountEvidence) &&
      proof.storageMountEvidence.length === 8,
    code,
  );
  const mounts = new Map(
    proof.storageMountEvidence.map((entry) => [entry.id, entry]),
  );
  check(mounts.size === 8, code);
  for (const owned of proof.ownedContainers) {
    check(isDeepStrictEqual(owned.storage, storage), code);
    const evidence = mounts.get(owned.id);
    const configured = {
      Type: "tmpfs",
      Target: storage.destination,
      TmpfsOptions: { SizeBytes: storage.sizeBytes, Mode: 448 },
    };
    if (Object.hasOwn(evidence?.HostConfig?.Mounts?.[0] ?? {}, "ReadOnly"))
      configured.ReadOnly = false;
    check(
      isDeepStrictEqual(evidence, {
        runId: owned.runId,
        name: owned.name,
        id: owned.id,
        Mounts: [{ Type: "tmpfs", Destination: storage.destination, RW: true }],
        HostConfig: { Mounts: [configured] },
      }),
      code,
    );
  }
}
export function validateCombinedLiveOracle(
  rawOracle,
  rawProof,
  rawHashes,
  rawCandidate,
) {
  try {
    const [oracle, proof, currentHashes, candidate] = combinedData([
        rawOracle,
        rawProof,
        rawHashes,
        rawCandidate,
      ]),
      code = "production75_combined_live_oracle";
    check(
      oracle?.kind === "OWNED_NATIVE_COMBINED_POLICY_ORACLE" &&
        isDeepStrictEqual(oracle.candidate, candidate) &&
        proof?.kind === "SYNTHETIC_PROXY_REAL_DRIVER_SQL_COMBINED" &&
        proof.status === "PASS" &&
        proof.sourceCandidate === BASE &&
        proof.liveProviderCalls === false &&
        isDeepStrictEqual(proof.candidate, candidate) &&
        oracle.legacy?.kind === "OWNED_NATIVE_POLICY_ORACLE" &&
        oracle.legacy.sourceCandidate === BASE &&
        /^growthos-reader-[a-f0-9]{32}$/.test(oracle.legacy.templateReader) &&
        isDeepStrictEqual(oracle.scheduling?.coverage, {
          tables: 142,
          columnsBefore: 1867,
          columnsAfter: 1870,
          layouts: 2,
        }) &&
        oracle.scheduling.layouts?.length === 2,
      code,
    );
    check(
      Object.keys(currentHashes).join(",") ===
        PRODUCTION75_RUNTIME_FILES.join(",") &&
        isDeepStrictEqual(proof.moduleHashesBefore, proof.moduleHashesAfter) &&
        isDeepStrictEqual(proof.moduleHashesAfter, currentHashes) &&
        proof.oracleSha256 === digest(oracle),
      code,
    );
    const catalogs = proof.catalogs;
    for (const c of [catalogs.legacy.fly75, catalogs.legacy.other75])
      deriveProduction75Catalogs(
        c,
        catalogs.legacy.canonical95,
        catalogs.legacy.canonical142,
      );
    check(
      isDeepStrictEqual(
        catalogs.scheduling,
        oracle.scheduling.layouts.map((l) => l.catalogs),
      ),
      code,
    );
    for (const layout of oracle.scheduling.layouts) {
      assertScheduling0019Catalogs(layout.catalogs);
      deriveLiveScheduling0019Policy({
        baseline142: layout.policies.before,
        oracle: layout.policies,
        readerName: layout.templateReader,
        templateReader: layout.templateReader,
      });
    }
    const expected = combinedManifestDigest({
      modules: currentHashes,
      legacySource: proof.legacySource,
      schedulingSource: oracle.scheduling.source,
      catalogs,
      oracle,
      candidate,
    });
    check(expected === proof.moduleManifestSha256, code);
    const c = proof.cleanup;
    check(
      c?.clients > 0 &&
        Number.isSafeInteger(c.clients) &&
        c.clients === c.expectedClients &&
        c.sockets === c.clients &&
        c.containers === 8 &&
        c.expectedContainers === 8 &&
        proof.ownedContainers?.length === 8 &&
        new Set(proof.ownedContainers.map((x) => x.id)).size === 8 &&
        new Set(proof.ownedContainers.map((x) => x.name)).size === 8,
      code,
    );
    check(
      new Set(proof.ownedContainers.map((x) => x.runId)).size === 8 &&
        proof.ownedContainers.every(
          (x) =>
            /^[a-f0-9]{64}$/.test(x.id) &&
            /^production75-local-[0-9]+-[a-f0-9]{8}$/.test(x.name) &&
            /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
              x.runId,
            ) &&
            x.name.endsWith(x.runId.slice(0, 8)) &&
            x.removed === true &&
            x.loopbackOnly === true,
        ) &&
        proof.transportProofs?.length === 3 &&
        proof.transportProofs.every(
          (t) =>
            [
              t.clients,
              t.clientsClosed,
              t.socketsClosed,
              t.proxies,
              t.proxiesClosed,
            ].every(
              (n) => Number.isSafeInteger(n) && n > 0 && n <= c.clients,
            ) &&
            t.clients === t.clientsClosed &&
            t.clients === t.socketsClosed &&
            t.proxies === t.proxiesClosed,
        ) &&
        proof.transportProofs.reduce((total, t) => total + t.clients, 0) <=
          c.clients,
      code,
    );
    assertCombinedNativeStorage(proof, code);
    for (const key of ["normal", "lost-commit", "idle-client-error"]) {
      const test = proof.cases?.[key],
        r = test?.result;
      check(
        r?.copyDeleted === true &&
          r.originalsPreserved === true &&
          r.resourcesClosed === true &&
          test.mutationCounts?.create === 1 &&
          test.mutationCounts.reader === 1 &&
          test.mutationCounts.delete === 1,
        code,
      );
      if (key === "idle-client-error") {
        check(
          r.status === "held-and-cleaned" &&
            Object.keys(r.outcomes).length === 0,
          code,
        );
        continue;
      }
      check(
        r.status === "verified-and-cleaned" &&
          r.outcomes?.rollback?.status === "verified-rollback" &&
          ["verified-commit", "reconciled-commit-no-replay"].includes(
            r.outcomes.commit?.status,
          ) &&
          deltaProof(r.outcomes.scheduling?.rollback, "rollback") &&
          (deltaProof(r.outcomes.scheduling?.commit, "commit") ||
            deltaProof(r.outcomes.scheduling?.commit, "commit", true)) &&
          r.outcomes.scheduling.rollback.baselineSha256 ===
            r.outcomes.scheduling.commit.baselineSha256,
        code,
      );
      if (key === "lost-commit")
        check(r.outcomes.commit.status === "reconciled-commit-no-replay", code);
    }
    check(proof.schedulingCases?.length === 2, code);
    const results = [];
    for (const key of ["normal", "lost-commit"])
      results.push(
        proof.cases[key].result.outcomes.scheduling.rollback,
        proof.cases[key].result.outcomes.scheduling.commit,
      );
    proof.schedulingCases.forEach((c, i) => {
      const layout = oracle.scheduling.layouts[i],
        late = c.lateFailure,
        p = late?.result?.proof;
      check(
        c.beforeCatalogSha256 ===
          catalogDigest(layout.catalogs.before, { physical: true }) &&
          c.afterCatalogSha256 ===
            catalogDigest(layout.catalogs.after, { physical: true }) &&
          isDeepStrictEqual(c.coverage, {
            tables: 142,
            columnsBefore: 1867,
            columnsAfter: 1870,
          }) &&
          deltaProof(c.rollback, "rollback") &&
          deltaProof(c.commit, "commit", i === 1) &&
          late?.rollbackAcknowledged === true &&
          late.preimagePreserved === true &&
          late.sqlState === "23514" &&
          late.failedConstraint === "projects_scheduling_reservation_ck" &&
          p?.rollbackAcknowledged === true &&
          p.sourceDispatched === true &&
          p.sourceAcknowledged === false &&
          p.preimageVerified === true &&
          p.postimageVerified === false &&
          p.freshReaderVerified === true &&
          p.commitDispatched === false &&
          ["failed-or-held", "verification-held-no-replay"].includes(
            late.result.status,
          ) &&
          isDeepStrictEqual(c.sourceDispatches, {
            rollback: 1,
            lateFailure: 1,
            commit: 1,
          }) &&
          [
            "readerWriteDenied",
            "duplicateMultiplicityVerified",
            "sameCountDriftRejected",
            "noDdlAfterPostimage",
            "preLockConcurrentDriftRejected",
          ].every((k) => c[k] === true) &&
          c.rollback.baselineSha256 === c.commit.baselineSha256 &&
          c.rollback.baselineSha256 === late.result.baselineSha256,
        code,
      );
      results.push(c.rollback, late.result, c.commit);
    });
    check(
      results.length === 10 &&
        new Set(results.map((r) => r.attemptId)).size === 10 &&
        results.every(
          (r) =>
            r.sourceSha256 === oracle.scheduling.source.sha256 &&
            /^[a-f0-9]{64}$/.test(r.baselineSha256) &&
            /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
              r.attemptId,
            ),
        ),
      code,
    );
    return freeze(oracle);
  } catch {
    check(false, "production75_combined_live_oracle");
  }
}
function combinedStructure(input) {
  const code = "production75_combined_dependencies";
  check(
    input &&
      typeof input === "object" &&
      !types.isProxy(input) &&
      Object.getPrototypeOf(input) === Object.prototype,
    code,
  );
  const descriptors = Object.getOwnPropertyDescriptors(input);
  check(
    Reflect.ownKeys(descriptors).every(
      (k) =>
        typeof k === "string" &&
        descriptors[k].enumerable &&
        Object.hasOwn(descriptors[k], "value"),
    ),
    code,
  );
  const deps = Object.fromEntries(
    Object.entries(descriptors).map(([k, d]) => [k, d.value]),
  );
  check(
    typeof deps.currentHashes === "function" &&
      deps.schedulingSource &&
      deps.candidate &&
      deps.oracle &&
      deps.catalogs &&
      deps.source,
    code,
  );
  const [oracle, candidate, catalogs] = combinedData([
      deps.oracle,
      deps.candidate,
      deps.catalogs,
    ]),
    hashes = deps.currentHashes();
  assertProduction75Source(deps.source);
  check(
    oracle.kind === "OWNED_NATIVE_COMBINED_POLICY_ORACLE" &&
      isDeepStrictEqual(oracle.candidate, candidate) &&
      isDeepStrictEqual(oracle.scheduling?.coverage, {
        tables: 142,
        columnsBefore: 1867,
        columnsAfter: 1870,
        layouts: 2,
      }) &&
      oracle.scheduling.layouts?.length === 2,
    code,
  );
  const fixed = {
      ...deps,
      oracle: freeze(oracle),
      candidate: freeze(candidate),
      catalogs: freeze(catalogs),
    },
    manifest = combinedManifestDigest(combinedInputs(fixed, hashes));
  for (const l of oracle.scheduling.layouts) {
    const reader = l.templateReader;
    prepareScheduling0019({
      source: deps.schedulingSource,
      catalogs: l.catalogs,
      target: {
        database: "fly-db",
        writerLogin: "fly-user",
        writerInitialRoles: ["fly-user", "schema_admin"],
        writerRole: "schema_admin",
        readerLogin: reader,
        readerRole: reader,
        principals: [
          ...new Set(
            l.policies.before.privileges.tables.map((r) => r.principal),
          ),
        ],
      },
      policyBefore: l.policies.before,
      policyAfter: l.policies.after,
      sourceBinding: {
        candidate: deps.candidate,
        moduleManifestSha256: manifest,
      },
    });
  }
  return { deps: fixed, hashes, manifest };
}
function admitCombinedDependencies(input) {
  const { deps, hashes, manifest } = combinedStructure(input),
    code = "production75_combined_dependencies";
  check(deps.nativeProof, code);
  const nativeProof = freeze(combinedData(deps.nativeProof)),
    oracle = validateCombinedLiveOracle(
      deps.oracle,
      nativeProof,
      hashes,
      deps.candidate,
    ),
    aggregate = combinedInputs(deps, hashes);
  check(
    isDeepStrictEqual(aggregate.catalogs, nativeProof.catalogs) &&
      isDeepStrictEqual(aggregate.legacySource, nativeProof.legacySource) &&
      manifest === nativeProof.moduleManifestSha256,
    code,
  );
  return Object.freeze({ ...deps, nativeProof, oracle });
}
function capturedCombinedCallbacks(deps, execution = false) {
  const code = "production75_combined_dependencies",
    methods = (value, required) => {
      check(value && typeof value === "object" && !types.isProxy(value), code);
      const out = {};
      for (const key of Reflect.ownKeys(value)) {
        const d = Object.getOwnPropertyDescriptor(value, key);
        check(typeof key === "string" && Object.hasOwn(d, "value"), code);
        if (typeof d.value === "function")
          Object.defineProperty(out, key, {
            value: d.value.bind(value),
            enumerable: true,
          });
      }
      check(
        required.every((k) => typeof out[k] === "function"),
        code,
      );
      return Object.freeze(out);
    };
  check(typeof deps.manifestSha256 === "function", code);
  return Object.freeze({
    ...deps,
    manifestSha256: deps.manifestSha256.bind(deps),
    currentHashes: deps.currentHashes.bind(deps),
    transport: methods(deps.transport, [
      "verifyIdentity",
      "withSourceCredentials",
      "protectedApps",
      "close",
      "metadata",
      ...(execution ? ["openProxy", "connect", "closeResources"] : []),
    ]),
    api: methods(
      deps.api,
      execution
        ? [
            "listClusters",
            "getCluster",
            "listBackups",
            "listUsers",
            "restoreCopy",
            "createReader",
            "deleteCopy",
            "credentials",
          ]
        : ["listClusters", "listBackups"],
    ),
    ...(typeof deps.unprotect === "function"
      ? { unprotect: deps.unprotect.bind(deps) }
      : {}),
  });
}
function combinedScheduling(deps, corePlan) {
  return {
    source: deps.oracle.scheduling.source,
    coverage: deps.oracle.scheduling.coverage,
    layouts: deps.oracle.scheduling.layouts.map((l) => {
      const p = deriveLiveScheduling0019Policy({
        baseline142: corePlan.policies[142],
        oracle: l.policies,
        readerName: corePlan.target.readerLogin,
        templateReader: l.templateReader,
      });
      return {
        beforeCatalogSha256: catalogDigest(l.catalogs.before, {
          physical: true,
        }),
        afterCatalogSha256: catalogDigest(l.catalogs.after, { physical: true }),
        beforePolicySha256: digest(p.before),
        afterPolicySha256: digest(p.after),
      };
    }),
  };
}
export async function prepareCombinedLivePacket(deps, options = {}) {
  return preparePacket(
    capturedCombinedCallbacks(admitCombinedDependencies(deps)),
    options,
    true,
  );
}
async function preparePacket(
  deps,
  {
    now = Date.now,
    runId = randomUUID(),
    workMs = 5400000,
    cleanupMs = 1800000,
    maxCostUsdMicros = 150000,
    pricing = null,
  } = {},
  combinedMode = false,
) {
  const { transport, api } = deps,
    resources = createOperatorResources({ now, until: now() + 900000 });
  let packet, failure;
  try {
    const readerName = production75ReaderName(runId);
    await transport.verifyIdentity();
    const inventory = await api.listClusters();
    check(
      inventory.some(
        (m) =>
          m.id === SOURCE &&
          m.version === 1 &&
          m.region === "iad" &&
          m.plan === "basic" &&
          m.status === "ready",
      ) && inventory.some((m) => m.id === STAGE && m.status === "ready"),
      "production75_live_inventory",
    );
    const backups = (await api.listBackups(SOURCE))
      .filter(
        (b) =>
          b.status === "completed" &&
          Date.parse(b.stop) <= now() &&
          now() - Date.parse(b.stop) <= 26 * 3600000,
      )
      .sort((a, b) => Date.parse(b.stop) - Date.parse(a.stop));
    check(backups.length > 0, "production75_live_backup");
    const apps = await transport.protectedApps();
    const before = validateSourceSnapshot(
      await transport.withSourceCredentials((credentials) =>
        captureLiveSnapshot({
          transport,
          cluster: SOURCE,
          credentials,
          resources,
          catalogs: deps.catalogs,
        }),
      ),
    );
    await verifyLiveProtectedApps(transport, apps);
    const profile = expectedProduction75ReaderProfile(readerName),
      projected = projectLiveReader(before, profile),
      delta = assertProduction75ReaderDelta({
        before,
        after: projected,
        readerName: profile.readerLogin,
        expectedProfile: profile,
      });
    const preparedCore = coreContext(
      combinedMode ? legacyDeps(deps) : deps,
      projected,
      profile.readerLogin,
    );
    const manifest = await deps.manifestSha256(),
      plan = (combinedMode ? prepareCombinedOperatorPlan : prepareOperatorPlan)(
        {
          runId,
          backupId: backups[0].id,
          sourceSnapshotSha256: production75SnapshotDigest(before),
          profileSha256: production75ProfileDigest(profile),
          moduleManifestSha256: manifest,
          preparedAt: now(),
          workMs,
          cleanupMs,
          maxCostUsdMicros,
          ...(combinedMode
            ? {
                candidate: deps.candidate,
                scheduling: combinedScheduling(deps, preparedCore),
              }
            : {}),
        },
      );
    packet = {
      kind: combinedMode
        ? "UNADMITTED_COMBINED_LIVE_PREPARATION"
        : "UNADMITTED_LIVE_PREPARATION",
      plan,
      planSha256: operatorPlanDigest(plan),
      sourceBefore: before,
      protectedApps: apps,
      inventory,
      backup: backups[0],
      pricing,
      oracleSha256: digest(deps.oracle),
      capabilities: delta.capabilities,
      readerProfileActualVerified: false,
      paidAdmissionIssued: false,
      sourceWritesAuthorized: false,
    };
    check(
      (await deps.manifestSha256()) === manifest,
      "production75_live_source",
    );
  } catch {
    failure = true;
  } finally {
    const drained = await resources.drain(
      Math.max(1, Math.min(60000, resources.deadline - now())),
    );
    let closed;
    try {
      closed = await transport.close();
    } catch {
      failure = true;
    }
    if (!drained.closed || !closed?.closed) failure = true;
  }
  check(!failure && packet, "production75_live_preparation");
  return freeze({
    ...packet,
    transportProof: transport.metadata(),
    resourcesClosed: true,
  });
}
export function validateLivePricing(pricing, plan) {
  const p = pricing;
  check(
    p?.status === "verified-applicable-legacy-v1" &&
      /^[a-f0-9]{64}$/.test(p.evidenceSha256 ?? "") &&
      p.account === plan.account &&
      p.organization === plan.organization &&
      p.providerVersion === plan.providerVersion &&
      p.plan === plan.plan &&
      p.region === plan.region &&
      p.currency === "USD" &&
      Number.isSafeInteger(p.hourlyUsdMicros) &&
      p.hourlyUsdMicros > 0 &&
      Number.isSafeInteger(p.meteringQuantumMs) &&
      p.meteringQuantumMs > 0 &&
      p.meteringQuantumMs <= 3600000 &&
      p.coveredMs === plan.workMs + plan.cleanupMs &&
      Number.isSafeInteger(p.maximumUsdMicros) &&
      p.maximumUsdMicros > 0 &&
      p.maximumUsdMicros <= plan.maxCostUsdMicros,
    "production75_live_pricing",
  );
  const quantum =
    Math.ceil(p.coveredMs / p.meteringQuantumMs) * p.meteringQuantumMs;
  check(
    p.maximumUsdMicros >= Math.ceil((quantum * p.hourlyUsdMicros) / 3600000),
    "production75_live_pricing",
  );
  return digest(p);
}
export async function verifyLiveProtectedApps(transport, expectedApps) {
  check(
    expectedApps &&
      isDeepStrictEqual(await transport.protectedApps(), expectedApps),
    "production75_live_protected",
  );
  return true;
}
export function createGuardedLiveApi({ api, transport, expectedApps }) {
  const methods = Object.fromEntries(
      Object.entries(api).map(([k, fn]) => [k, fn.bind(api)]),
    ),
    restore = methods.restoreCopy;
  return Object.freeze({
    ...methods,
    restoreCopy: async (permit) => {
      await verifyLiveProtectedApps(transport, expectedApps);
      return restore(permit);
    },
  });
}
export async function executeLivePacket(deps, packet, attestations = {}) {
  return executePacket(deps, packet, attestations, false);
}
export async function executeCombinedLivePacket(
  deps,
  packet,
  attestations = {},
) {
  return executePacket(
    capturedCombinedCallbacks(admitCombinedDependencies(deps), true),
    packet,
    attestations,
    true,
  );
}
/** Supplied-client composition only. No ambient provider or native admission. */
export async function executeSuppliedCombinedPacket(
  input,
  packet,
  attestations = {},
) {
  check(
    !nativeCombinedDependencies.has(input),
    "production75_combined_dependencies",
  );
  const { deps } = combinedStructure(input),
    result = await executePacket(
      capturedCombinedCallbacks(deps, true),
      packet,
      attestations,
      true,
    );
  return Object.freeze({ ...result, nativeOracleAdmissionVerified: false });
}
async function executePacket(
  deps,
  packet,
  attestations = {},
  combinedMode = false,
) {
  // Authenticate exact protected price/app bindings before any provider access.
  check(
    packet?.kind ===
      (combinedMode
        ? "UNADMITTED_COMBINED_LIVE_PREPARATION"
        : "UNADMITTED_LIVE_PREPARATION"),
    "production75_live_admission",
  );
  const plan = combinedMode
    ? prepareCombinedOperatorPlan({
        ...planInput(packet.plan),
        candidate: packet.plan.candidate,
        scheduling: packet.plan.scheduling,
      })
    : prepareOperatorPlan(planInput(packet.plan));
  check(
    isDeepStrictEqual(plan, packet.plan) &&
      operatorPlanDigest(plan) === packet.planSha256 &&
      production75SnapshotDigest(packet.sourceBefore) ===
        plan.sourceSnapshotSha256 &&
      (await deps.manifestSha256()) === plan.moduleManifestSha256 &&
      digest(deps.oracle) === packet.oracleSha256,
    "production75_live_packet",
  );
  const bindings = {
    pricingSha256: validateLivePricing(packet.pricing, plan),
    protectedAppsSha256: digest(packet.protectedApps),
  };
  const owner = await authenticateAttestation({
      unprotect: deps.unprotect,
      blob: attestations.owner,
      plan,
      kind: "owner-approval",
      bindings,
    }),
    review = await authenticateAttestation({
      unprotect: deps.unprotect,
      blob: attestations.review,
      plan,
      kind: "independent-capability-review",
      bindings,
    });
  const { transport } = deps,
    api = createGuardedLiveApi({
      api: deps.api,
      transport,
      expectedApps: packet.protectedApps,
    }),
    writerCredentials = new Map(),
    readerCredentials = new Map(),
    proxies = new WeakMap();
  let committedLegacyPlan = null,
    committedProtected = null;
  const proxy = async (id, resources) => {
    let map = proxies.get(resources);
    if (!map) {
      map = new Map();
      proxies.set(resources, map);
    }
    if (!map.has(id)) map.set(id, await transport.openProxy(id, resources));
    return map.get(id);
  };
  const credentials = async (copy, custody, kind) => {
    const cache = kind === "writer" ? writerCredentials : readerCredentials;
    if (!cache.has(copy.id)) {
      const ticket = await api.credentials(
        custody.reserve(`credentials-${kind}`),
        kind,
      );
      await useProduction75Credentials(ticket, async (value) => {
        cache.set(copy.id, value);
      });
    }
    return cache.get(copy.id);
  };
  await verifyLiveProtectedApps(transport, packet.protectedApps);
  const snapshot = async (id, values, r, readerName = null, databases) =>
    captureLiveSnapshot({
      transport,
      cluster: id,
      credentials: values,
      resources: r,
      catalogs: deps.catalogs,
      readerName,
      databases,
      proxy: await proxy(id, r),
    });
  const callbacks = {
    verifyIdentity: () => transport.verifyIdentity(),
    moduleManifestSha256: deps.manifestSha256,
    observeOriginals: async ({ resources }) => {
      await verifyLiveProtectedApps(transport, packet.protectedApps);
      return transport.withSourceCredentials((value) =>
        snapshot(SOURCE, value, resources),
      );
    },
    observeCopy: async (copy, { readerName, custody, resources }) =>
      snapshot(
        copy.id,
        await credentials(copy, custody, readerName ? "reader" : "writer"),
        resources,
        readerName,
      ),
    verifyProtected: async () => ({
      unchanged: isDeepStrictEqual(
        await transport.protectedApps(),
        packet.protectedApps,
      ),
    }),
    closeResources: () => transport.closeResources(),
    verificationContext: async ({
      copy,
      readerName,
      afterReader,
      delta,
      custody,
      resources,
    }) => {
      await verifyLiveProtectedApps(transport, packet.protectedApps);
      const corePlan = coreContext(
          combinedMode ? legacyDeps(deps) : deps,
          afterReader,
          readerName,
        ),
        p = await proxy(copy.id, resources),
        writer = await transport.connect(
          p,
          "fly-db",
          await credentials(copy, custody, "writer"),
          { readonly: false, resources },
        ),
        reader = await transport.connect(
          p,
          "fly-db",
          await credentials(copy, custody, "reader"),
          { readonly: true, resources },
        );
      const writeQuery = writer.query.bind(writer);
      writer.query = async (...args) => {
        if (args[0] === "BEGIN")
          await verifyLiveProtectedApps(transport, packet.protectedApps);
        return writeQuery(...args);
      };
      const readFresh = async () => {
        // Other connections must not consume this Reader's idle-transaction budget.
        const other = await snapshot(
          copy.id,
          await credentials(copy, custody, "reader"),
          resources,
          readerName,
          ["growthos_staging", "mogulforge-growthos-db"],
        );
        await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        try {
          const observer = createProduction75Observer({
              client: reader,
              principals: corePlan.target.principals,
              catalog75: corePlan.catalog75,
              catalog142: corePlan.catalog142,
              identity: {
                database: "fly-db",
                login: readerName,
                role: readerName,
              },
            }),
            state = await captureProduction75State(observer, corePlan),
            extra = await captureProduction75Extras(observer);
          const evidence = {
            state,
            extra,
            capabilities: assertLegacyReaderCapabilities(state.policy, {
              readerLogin: readerName,
              readerRole: readerName,
              writerRole: "schema_admin",
            }),
            otherDatabases: other.databases.map(({ identity, ...d }) => d),
          };
          if (combinedMode && state.phase === 142) {
            committedLegacyPlan = corePlan;
            committedProtected = freeze(
              structuredClone({
                extra: evidence.extra,
                otherDatabases: evidence.otherDatabases,
                capabilities: evidence.capabilities,
              }),
            );
          }
          return evidence;
        } finally {
          if (!resources.signal.aborted) await reader.query("ROLLBACK");
        }
      };
      const baseline = await readFresh();
      check(
        isDeepStrictEqual(baseline.capabilities, delta.capabilities) &&
          isDeepStrictEqual(baseline.capabilities, packet.capabilities),
        "production75_live_capabilities",
      );
      return {
        writer,
        plan: corePlan,
        baseline,
        expectedExtra: afterReader.databases.find((d) => d.name === "fly-db")
          .extra,
        readFresh,
        capabilityReview: {
          status: "reviewed",
          scope: "fixed-query-observation-with-inherited-capabilities",
          readerLogin: readerName,
          readerRole: readerName,
          extraSha256: digest(baseline.extra),
          capabilitiesSha256: digest(baseline.capabilities),
          receiptSha256: review.receiptSha256,
          zeroDdlClusterWideVerified: false,
        },
      };
    },
  };
  if (combinedMode)
    callbacks.schedulingContext = async ({
      copy,
      readerName,
      resources,
      plan: operator,
      custody,
    }) => {
      check(
        committedLegacyPlan && committedProtected,
        "production75_combined_scheduling_context",
      );
      await verifyLiveProtectedApps(transport, packet.protectedApps);
      const layout = deps.oracle.scheduling.layouts.find(
        (l) =>
          catalogDigest(l.catalogs.before, { physical: true }) ===
          catalogDigest(committedLegacyPlan.catalog142, { physical: true }),
      );
      check(layout, "production75_combined_scheduling_context");
      const policies = deriveLiveScheduling0019Policy({
          baseline142: committedLegacyPlan.policies[142],
          oracle: layout.policies,
          readerName,
          templateReader: layout.templateReader,
        }),
        deltaPlan = prepareScheduling0019({
          source: deps.schedulingSource,
          catalogs: layout.catalogs,
          target: committedLegacyPlan.target,
          policyBefore: policies.before,
          policyAfter: policies.after,
          sourceBinding: {
            candidate: operator.candidate,
            moduleManifestSha256: operator.moduleManifestSha256,
          },
        }),
        p = await proxy(copy.id, resources);
      const writer = await transport.connect(
          p,
          "fly-db",
          await credentials(copy, custody, "writer"),
          { readonly: false, resources, settledServerErrors: true },
        ),
        reader = await transport.connect(
          p,
          "fly-db",
          await credentials(copy, custody, "reader"),
          { readonly: true, resources },
        );
      const guardedWriter = guardCombinedSchedulingWriter({
        writer,
        resources,
        verifyProtected: () =>
          verifyLiveProtectedApps(transport, packet.protectedApps),
      });
      const readFresh = async () => {
        await verifyLiveProtectedApps(transport, packet.protectedApps);
        const others = await snapshot(
          copy.id,
          await credentials(copy, custody, "reader"),
          resources,
          readerName,
          ["growthos_staging", "mogulforge-growthos-db"],
        );
        await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        try {
          const observer = createScheduling0019Observer({
              client: reader,
              principals: deltaPlan.target.principals,
              catalogs: deltaPlan.catalogs,
              identity: {
                database: "fly-db",
                login: readerName,
                role: readerName,
              },
            }),
            state = await captureScheduling0019State(observer, deltaPlan),
            extra = await captureProduction75Extras(observer),
            capabilities = assertLegacyReaderCapabilities(state.policy, {
              readerLogin: readerName,
              readerRole: readerName,
              writerRole: "schema_admin",
            });
          check(
            isDeepStrictEqual(extra, committedProtected.extra) &&
              isDeepStrictEqual(
                others.databases.map(({ identity, ...d }) => d),
                committedProtected.otherDatabases,
              ) &&
              isDeepStrictEqual(capabilities, committedProtected.capabilities),
            "production75_combined_protected",
          );
          return state;
        } finally {
          if (!resources.signal.aborted) await reader.query("ROLLBACK");
        }
      };
      return {
        plan: deltaPlan,
        writer: guardedWriter,
        baseline: await readFresh(),
        readFresh,
      };
    };
  try {
    return await runProduction75Operator({
      plan,
      custodyRoot: deps.custodyRoot,
      api,
      callbacks,
      verifyOwnerApproval: async () => owner,
      verifyCapabilityReview: async () => review,
    });
  } finally {
    writerCredentials.clear();
    readerCredentials.clear();
    await transport.close();
  }
}
const readOwned = (file, max = 32000000) => {
  const s = lstatSync(file);
  check(
    s.isFile() && !s.isSymbolicLink() && s.size <= max,
    "production75_live_file",
  );
  return readFileSync(file);
};
function nativeSourceInputs() {
  const git = (p) =>
      execFileSync("git", ["show", `${BASE}:${p}`], {
        cwd: ROOT,
        windowsHide: true,
        maxBuffer: 4000000,
      }),
    json = (p) => JSON.parse(git(p)),
    source = buildProduction75Source(
      PINNED_FILES.map((p) => ({ ...p, bytes: git(p.path) })),
    ),
    catalogs = {
      fly75: json(
        "reports/production75-recovery-2026-10-11/catalog75-fly-db.json",
      ),
      other75: json(
        "reports/production75-recovery-2026-10-11/catalog75-growthos_staging.json",
      ),
      canonical95: json(
        "reports/staging-observation-2026-10-10/fixtures/catalog-95.json",
      ),
      canonical142: json(
        "reports/staging-observation-2026-10-10/fixtures/catalog-142.json",
      ),
    };
  return { source, catalogs, git };
}
export function createNativeLiveDependencies(oracleDirectory) {
  check(isAbsolute(oracleDirectory), "production75_live_file");
  const hashes = moduleHashes(),
    oracle = validateLiveOracle(
      JSON.parse(readOwned(resolve(oracleDirectory, "oracle.json"))),
      JSON.parse(readOwned(resolve(oracleDirectory, "native-result.json"))),
      hashes,
    ),
    { source, catalogs } = nativeSourceInputs(),
    transport = createNativeLiveTransport();
  return {
    source,
    catalogs,
    oracle,
    transport,
    api: Object.freeze({
      ...createProduction75V1Client({
        fetchFn: globalThis.fetch,
        getAuthorization: () => transport.authorization("legacy"),
        organization: "adam-diaz",
      }),
      listBackups: async (id) => {
        check(id === SOURCE, "production75_live_read_scope");
        return transport.sourceBackups();
      },
    }),
    manifestSha256: async () =>
      digest({
        modules: moduleHashes(),
        source: source.sourceFiles,
        catalogs,
        oracle,
      }),
    unprotect: createNativeAttestationAuthenticator(),
  };
}
const nativeCombinedDependencies = new WeakSet();
function currentCandidate() {
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: ROOT,
      windowsHide: true,
      maxBuffer: 4000000,
    })
      .toString()
      .trim();
  check(
    /^https:\/\/github\.com\/diazdestination\/mogulforge-growthos(?:\.git)?$|^git@github\.com:diazdestination\/mogulforge-growthos(?:\.git)?$/.test(
      git("remote", "get-url", "origin"),
    ) && git("status", "--porcelain=v1") === "",
    "production75_combined_candidate",
  );
  const candidate = {
    repository: "diazdestination/mogulforge-growthos",
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
  };
  check(
    /^[a-f0-9]{40}$/.test(candidate.commit) &&
      /^[a-f0-9]{40}$/.test(candidate.tree),
    "production75_combined_candidate",
  );
  return freeze(candidate);
}
export function createNativeCombinedLiveDependencies(oracleDirectory) {
  check(isAbsolute(oracleDirectory), "production75_live_file");
  const candidate = currentCandidate(),
    currentHashes = () => {
      check(
        isDeepStrictEqual(currentCandidate(), candidate),
        "production75_combined_candidate",
      );
      return moduleHashes();
    },
    hashes = currentHashes(),
    nativeProof = freeze(
      JSON.parse(readOwned(resolve(oracleDirectory, "native-result.json"))),
    ),
    oracle = validateCombinedLiveOracle(
      JSON.parse(readOwned(resolve(oracleDirectory, "oracle.json"))),
      nativeProof,
      hashes,
      candidate,
    ),
    { source, catalogs } = nativeSourceInputs(),
    schedulingSource = buildScheduling0019Source({
      sourceCommit: oracle.scheduling.source.sourceCommit,
      path: oracle.scheduling.source.path,
      bytes: execFileSync(
        "git",
        [
          "show",
          `${oracle.scheduling.source.sourceCommit}:${oracle.scheduling.source.path}`,
        ],
        { cwd: ROOT, windowsHide: true, maxBuffer: 20000 },
      ),
    });
  freeze(catalogs);
  const preflight = {
    candidate,
    currentHashes,
    nativeProof,
    oracle,
    source,
    catalogs,
    schedulingSource,
  };
  admitCombinedDependencies(preflight);
  const transport = createNativeLiveTransport(),
    deps = {
      ...preflight,
      transport,
      api: Object.freeze({
        ...createProduction75V1Client({
          fetchFn: globalThis.fetch,
          getAuthorization: () => transport.authorization("legacy"),
          organization: "adam-diaz",
        }),
        listBackups: async (id) => {
          check(id === SOURCE, "production75_live_read_scope");
          return transport.sourceBackups();
        },
      }),
      unprotect: createNativeAttestationAuthenticator(),
    };
  deps.manifestSha256 = async () =>
    combinedManifestDigest(combinedInputs(deps, currentHashes()));
  nativeCombinedDependencies.add(deps);
  return Object.freeze(deps);
}
export async function main(
  args = process.argv.slice(2),
  {
    factory = createNativeLiveDependencies,
    combinedFactory = createNativeCombinedLiveDependencies,
  } = {},
) {
  check(
    Array.isArray(args) &&
      ((args.length === 3 &&
        ["prepare", "prepare-combined"].includes(args[0])) ||
        (args.length === 4 &&
          ["execute", "execute-combined"].includes(args[0]))) &&
      args.slice(1).every(isAbsolute),
    "production75_live_action",
  );
  const combinedMode = args[0].endsWith("-combined"),
    selectedFactory = combinedMode ? combinedFactory : factory;
  if (args[0] === "prepare" || args[0] === "prepare-combined") {
    const [_, oracleDirectory, outputDirectory] = args;
    check(!lstatExists(outputDirectory), "production75_live_file");
    const deps = selectedFactory(oracleDirectory),
      packet = await (
        combinedMode ? prepareCombinedLivePacket : prepareLivePacket
      )(deps);
    mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
    writeFileSync(
      resolve(outputDirectory, "packet.json"),
      JSON.stringify({ ...packet, oracleDirectory }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    const receipt = {
      kind: packet.kind,
      planSha256: packet.planSha256,
      sourceSnapshotSha256: packet.plan.sourceSnapshotSha256,
      backupId: packet.plan.backupId,
      resourcesClosed: packet.resourcesClosed,
      readerProfileActualVerified: false,
      paidAdmissionIssued: false,
      pricingVerified: false,
    };
    writeFileSync(
      resolve(outputDirectory, "preparation-receipt.json"),
      JSON.stringify(receipt, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    return receipt;
  }
  const packet = JSON.parse(readOwned(resolve(args[1], "packet.json"))),
    deps = { ...selectedFactory(packet.oracleDirectory), custodyRoot: args[1] };
  return (combinedMode ? executeCombinedLivePacket : executeLivePacket)(
    deps,
    packet,
    {
      owner: readOwned(args[2], 65536),
      review: readOwned(args[3], 65536),
    },
  );
}
function lstatExists(p) {
  try {
    lstatSync(p);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().then(
    (r) => {
      process.stdout.write(JSON.stringify(r) + "\n");
    },
    () => {
      process.stderr.write("production75_live_held\n");
      process.exitCode = 1;
    },
  );
