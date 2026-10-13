/** Explicit read-only prepare / separately admitted one-copy execution. Import-safe. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
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
  operatorPlanDigest,
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
import { deriveLivePolicies } from "./production75-live-policy.mjs";
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
import { buildProduction75Source } from "./production75-source.mjs";
import { PINNED_FILES } from "./production75-pins.mjs";
import {
  production75RuntimeHashes,
  PRODUCTION75_RUNTIME_FILES,
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
export async function prepareLivePacket(
  deps,
  {
    now = Date.now,
    runId = randomUUID(),
    workMs = 5400000,
    cleanupMs = 1800000,
    maxCostUsdMicros = 150000,
    pricing = null,
  } = {},
) {
  const { transport, api } = deps,
    resources = createOperatorResources({ now, until: now() + 900000 });
  let packet, failure;
  try {
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
    const profile = expectedProduction75ReaderProfile(
        `growthos_reader_${runId.replaceAll("-", "")}`,
      ),
      projected = projectLiveReader(before, profile),
      delta = assertProduction75ReaderDelta({
        before,
        after: projected,
        readerName: profile.readerLogin,
        expectedProfile: profile,
      });
    coreContext(deps, projected, profile.readerLogin);
    const manifest = await deps.manifestSha256(),
      plan = prepareOperatorPlan({
        runId,
        backupId: backups[0].id,
        sourceSnapshotSha256: production75SnapshotDigest(before),
        profileSha256: production75ProfileDigest(profile),
        moduleManifestSha256: manifest,
        preparedAt: now(),
        workMs,
        cleanupMs,
        maxCostUsdMicros,
      });
    packet = {
      kind: "UNADMITTED_LIVE_PREPARATION",
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
  // Authenticate exact protected price/app bindings before any provider access.
  check(
    packet?.kind === "UNADMITTED_LIVE_PREPARATION",
    "production75_live_admission",
  );
  const plan = prepareOperatorPlan(planInput(packet.plan));
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
      const corePlan = coreContext(deps, afterReader, readerName),
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
            extra = await captureProduction75Extras(observer),
            other = await snapshot(
              copy.id,
              await credentials(copy, custody, "reader"),
              resources,
              readerName,
              ["growthos_staging", "mogulforge-growthos-db"],
            );
          return {
            state,
            extra,
            capabilities: assertLegacyReaderCapabilities(state.policy, {
              readerLogin: readerName,
              readerRole: readerName,
              writerRole: "schema_admin",
            }),
            otherDatabases: other.databases.map(({ identity, ...d }) => d),
          };
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
export function createNativeLiveDependencies(oracleDirectory) {
  check(isAbsolute(oracleDirectory), "production75_live_file");
  const hashes = moduleHashes(),
    oracle = validateLiveOracle(
      JSON.parse(readOwned(resolve(oracleDirectory, "oracle.json"))),
      JSON.parse(readOwned(resolve(oracleDirectory, "native-result.json"))),
      hashes,
    );
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
    },
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
export async function main(
  args = process.argv.slice(2),
  { factory = createNativeLiveDependencies } = {},
) {
  check(
    Array.isArray(args) &&
      ((args.length === 3 && args[0] === "prepare") ||
        (args.length === 4 && args[0] === "execute")) &&
      args.slice(1).every(isAbsolute),
    "production75_live_action",
  );
  if (args[0] === "prepare") {
    const [_, oracleDirectory, outputDirectory] = args;
    check(!lstatExists(outputDirectory), "production75_live_file");
    const deps = factory(oracleDirectory),
      packet = await prepareLivePacket(deps);
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
    deps = factory(packet.oracleDirectory);
  deps.custodyRoot = args[1];
  return executeLivePacket(deps, packet, {
    owner: readOwned(args[2], 65536),
    review: readOwned(args[3], 65536),
  });
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
