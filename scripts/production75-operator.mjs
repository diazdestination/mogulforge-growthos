/** Supplied-client lifecycle. No import-time I/O, live driver or implicit admission. */
import { randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual, types } from "node:util";
import {
  openOperatorCustody,
  operatorPlanDigest,
  consumeOperatorPermit,
  markOperatorPermitDispatched,
} from "./production75-custody.mjs";
import {
  mergeV1OwnershipEvidence,
  production75V1FailureMetadata,
} from "./production75-fly-v1.mjs";
import {
  expectedProduction75ReaderProfile,
  production75ProfileDigest,
  production75SnapshotDigest,
  assertProduction75ReaderDelta,
} from "./production75-reader-delta.mjs";
import { runProduction75Verification } from "./production75-verification.mjs";
import {
  runScheduling0019Verification,
  assertScheduling0019Preserved,
} from "./production75-scheduling0019.mjs";
import { catalogDigest } from "../reports/release-preparation-2026-10-09/schema-catalog.mjs";
const error = (code) => Object.assign(new Error(code), { safeCode: code });
const check = (v, code) => {
  if (!v) throw error(code);
};
const safeCode = (e) =>
  /^production75_[a-z0-9_]+$/.test(e?.safeCode ?? "")
    ? e.safeCode
    : "production75_operator_failure";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freeze = (v) => {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
const sha = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const combined = (p) => p?.kind === "PRODUCTION75_SCHEDULING0019_OPERATOR_V2";
function snapshotSchedulingState(input) {
  let nodes = 0,
    bytes = 0;
  const seen = new Set(),
    fail = () => check(false, "production75_operator_scheduling_context");
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
    const out = array ? [] : {},
      own = Reflect.ownKeys(v);
    for (const k of own) {
      if (array && k === "length") continue;
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (
        typeof k !== "string" ||
        !d.enumerable ||
        !Object.hasOwn(d, "value") ||
        (array && !/^(0|[1-9][0-9]*)$/.test(k))
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
    if (array && (own.length !== v.length + 1 || out.length !== v.length))
      fail();
    seen.delete(v);
    return out;
  };
  return freeze(copy(input));
}
function bindSchedulingContext(ctx, operator, prior) {
  const code = "production75_operator_scheduling_context";
  check(
    ctx &&
      typeof ctx === "object" &&
      !types.isProxy(ctx) &&
      Reflect.ownKeys(ctx).sort().join(",") ===
        "baseline,plan,readFresh,writer" &&
      Object.values(Object.getOwnPropertyDescriptors(ctx)).every(
        (d) => d.enumerable && Object.hasOwn(d, "value"),
      ) &&
      typeof ctx.readFresh === "function" &&
      typeof ctx.writer?.query === "function",
    code,
  );
  const b = snapshotSchedulingState(ctx.baseline),
    p = ctx.plan,
    i = b.identity;
  assertScheduling0019Preserved(b, b, p, "pre0019");
  if (prior) assertScheduling0019Preserved(prior, b, p, "pre0019");
  check(
    i.database === "fly-db" &&
      i.login === operator.readerName &&
      i.role === operator.readerName &&
      i.read_only === "on" &&
      i.isolation === "repeatable read" &&
      Number.isInteger(i.pid) &&
      i.pid > 0 &&
      i.version >= 160000 &&
      i.version < 170000 &&
      isDeepStrictEqual(p.source, operator.scheduling.source) &&
      isDeepStrictEqual(p.sourceBinding.candidate, operator.candidate) &&
      p.sourceBinding.moduleManifestSha256 === operator.moduleManifestSha256 &&
      p.target.readerLogin === operator.readerName &&
      p.target.readerRole === operator.readerName &&
      p.target.writerLogin === "fly-user" &&
      p.target.writerRole === "schema_admin",
    code,
  );
  const layout = operator.scheduling.layouts.find(
    (l) =>
      l.beforeCatalogSha256 ===
        catalogDigest(p.catalogs.before, { physical: true }) &&
      l.afterCatalogSha256 ===
        catalogDigest(p.catalogs.after, { physical: true }) &&
      l.beforePolicySha256 === sha(p.policyBefore) &&
      l.afterPolicySha256 === sha(p.policyAfter),
  );
  check(layout, code);
  return { plan: p, baseline: b, writer: ctx.writer, readFresh: ctx.readFresh };
}
function positiveLegacy(result, outcome) {
  const p = result?.proof,
    m = result?.mechanism;
  return (
    p?.extraPreserved === true &&
    p.nonTargetDatabasesPreserved === true &&
    m?.stepsAcknowledged === 19 &&
    (outcome === "rollback"
      ? result.status === "verified-rollback" && m.rollbackAcknowledged === true
      : ["verified-commit", "reconciled-commit-no-replay"].includes(
          result.status,
        ) &&
        p.freshReaderVerified === true &&
        p.originalTables === 75 &&
        p.originalColumns === 849 &&
        p.newTablesEmpty === 67 &&
        p.defaultsVerified === 13 &&
        m.commitDispatched === true &&
        (result.status !== "verified-commit" || m.commitAcknowledged === true))
  );
}
function positiveScheduling(r, outcome, binding, plan) {
  const p = r?.proof;
  return (
    r?.kind === "SCHEDULING0019_VERIFICATION" &&
    r.baselineSha256 === binding?.baselineSha256 &&
    r.sourceSha256 === plan.scheduling.source.sha256 &&
    p?.originalTables === 142 &&
    p.originalColumns === 1867 &&
    p.newColumns === 3 &&
    p.nullColumnsVerified === 3 &&
    p.preimageVerified === true &&
    p.postimageVerified === true &&
    p.freshReaderVerified === true &&
    p.reservationConfirmed === true &&
    p.sourceDispatched === true &&
    p.sourceAcknowledged === true &&
    (outcome === "rollback"
      ? r.status === "verified-rollback" &&
        p.rollbackAcknowledged === true &&
        p.transactionClosure === "acknowledged-rollback" &&
        p.journalConfirmed === true
      : ["verified-commit", "reconciled-commit-no-replay"].includes(r.status) &&
        p.commitDispatched === true &&
        (r.status !== "verified-commit" ||
          (p.commitAcknowledged === true &&
            p.journalConfirmed === true &&
            p.transactionClosure === "acknowledged-commit")))
  );
}
/** Resource-owning callbacks must acquire through this terminal registry. */
export function createOperatorResources({ now = Date.now, until } = {}) {
  const controller = new AbortController(),
    entries = new Set(),
    closing = new Set();
  let pending = 0,
    failed = false;
  const active = () =>
    check(
      !controller.signal.aborted && now() < until,
      "production75_operator_resources",
    );
  const close = (entry) => {
    if (entry.closed) return;
    entry.closed = true;
    const promise = Promise.resolve()
      .then(() => entry.close(entry.value))
      .catch(() => {
        failed = true;
      })
      .finally(() => closing.delete(promise));
    closing.add(promise);
  };
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
    for (const entry of entries) close(entry);
  };
  return Object.freeze({
    signal: controller.signal,
    deadline: until,
    assertActive: active,
    abort,
    async acquire(factory, dispose) {
      active();
      check(
        typeof factory === "function" && typeof dispose === "function",
        "production75_operator_resources",
      );
      pending++;
      let value;
      try {
        value = await factory({ signal: controller.signal, deadline: until });
      } finally {
        pending--;
      }
      const entry = { value, close: dispose, closed: false };
      entries.add(entry);
      if (controller.signal.aborted || now() >= until) {
        close(entry);
        await Promise.all([...closing]);
        throw error("production75_operator_resources");
      }
      return value;
    },
    async query(client, ...args) {
      active();
      const value = await client.query(...args);
      active();
      return value;
    },
    async drain(ms = 1000) {
      abort();
      let timer;
      try {
        await Promise.race([
          Promise.all([...closing]),
          new Promise((r) => {
            timer = setTimeout(r, Math.max(1, ms));
          }),
        ]);
        return { closed: pending === 0 && closing.size === 0 && !failed };
      } finally {
        clearTimeout(timer);
      }
    },
    status() {
      return {
        terminal: controller.signal.aborted,
        pending,
        closing: closing.size,
        failed,
      };
    },
  });
}
function bindVerificationContext(ctx, approved, delta, readerName) {
  const target = approved.databases.find((d) => d.name === "fly-db"),
    others = approved.databases
      .filter((d) => d.name !== "fly-db")
      .map(({ identity, ...d }) => d),
    b = ctx?.baseline;
  const principalNames = [
    ...new Set(target.policy.privileges.tables.map((r) => r.principal)),
  ].sort();
  check(
    b?.state?.phase === 75 &&
      isDeepStrictEqual(b.state.catalog, target.catalog) &&
      isDeepStrictEqual(b.state.fingerprints, target.fingerprints) &&
      isDeepStrictEqual(b.state.policy, target.policy) &&
      isDeepStrictEqual(b.extra, target.extra) &&
      isDeepStrictEqual(ctx.expectedExtra, target.extra) &&
      isDeepStrictEqual(b.otherDatabases, others) &&
      isDeepStrictEqual(b.capabilities, delta.capabilities) &&
      isDeepStrictEqual(ctx.plan?.catalog75, target.catalog) &&
      isDeepStrictEqual(ctx.plan?.policies?.[75], target.policy) &&
      isDeepStrictEqual(
        [...(ctx.plan?.target?.principals ?? [])].sort(),
        principalNames,
      ) &&
      ctx.capabilityReview?.readerLogin === readerName &&
      ctx.capabilityReview.readerRole === readerName &&
      ctx.capabilityReview.extraSha256 === sha(target.extra) &&
      ctx.capabilityReview.capabilitiesSha256 === sha(delta.capabilities),
    "production75_operator_verification_context",
  );
  return {
    ...ctx,
    baseline: freeze(structuredClone(b)),
    expectedExtra: freeze(structuredClone(ctx.expectedExtra)),
    capabilityReview: freeze(structuredClone(ctx.capabilityReview)),
  };
}
export async function runProduction75Operator({
  plan,
  custodyRoot,
  verifyOwnerApproval,
  verifyCapabilityReview,
  api,
  callbacks,
  now = Date.now,
  pause = wait,
  pollMs = 1000,
} = {}) {
  const result = {
    kind: "SUPPLIED_CLIENT_PRODUCTION75_OPERATOR",
    status: "held-before-create",
    creationAttempted: false,
    copyId: null,
    possibleCopyId: null,
    copyDeleted: false,
    readerProfileVerified: false,
    originalsPreserved: false,
    resourcesClosed: false,
    outcomes: {},
    sourceWritesAuthorized: false,
  };
  let custody,
    copy,
    before,
    cloneBefore,
    workResources,
    cleanupResources,
    complete = false,
    creationAcknowledged = false,
    latestOwnedInventory;
  const shutdown = async (final = false) => {
    let timer;
    const ms = Math.max(
      1,
      Math.min(60000, Math.floor((plan?.cleanupUntil - now()) / 4)),
    );
    try {
      workResources?.abort();
      if (final) cleanupResources?.abort();
      const closed = await Promise.race([
        Promise.resolve().then(() => callbacks?.closeResources?.()),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(error("production75_operator_resources")),
            ms,
          );
        }),
      ]);
      const work = await workResources?.drain(ms),
        cleanup = final ? await cleanupResources?.drain(ms) : { closed: true };
      check(
        closed?.closed === true &&
          work?.closed !== false &&
          cleanup?.closed !== false,
        "production75_operator_resources",
      );
      result.resourcesClosed = true;
    } catch {
      result.resourcesClosed = false;
      result.cleanupErrorCode = "production75_operator_resources";
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    operatorPlanDigest(plan);
    check(
      typeof now === "function" &&
        typeof pause === "function" &&
        Number.isInteger(pollMs) &&
        pollMs >= 0 &&
        pollMs <= 15000,
      "production75_operator_input",
    );
    const API_KEYS = [
      "listClusters",
      "getCluster",
      "listBackups",
      "listUsers",
      "restoreCopy",
      "createReader",
      "deleteCopy",
    ];
    const CALLBACK_KEYS = [
      "verifyIdentity",
      "moduleManifestSha256",
      "observeOriginals",
      "observeCopy",
      "verificationContext",
      "closeResources",
      "verifyProtected",
      ...(combined(plan) ? ["schedulingContext"] : []),
    ];
    if (combined(plan))
      for (const [object, keys] of [
        [api, API_KEYS],
        [callbacks, CALLBACK_KEYS],
      ])
        check(
          object &&
            !types.isProxy(object) &&
            keys.every((k) => {
              const d = Object.getOwnPropertyDescriptor(object, k);
              return (
                d && Object.hasOwn(d, "value") && typeof d.value === "function"
              );
            }),
          "production75_operator_input",
        );
    check(
      api &&
        callbacks &&
        API_KEYS.every((k) => typeof api[k] === "function") &&
        CALLBACK_KEYS.every((k) => typeof callbacks[k] === "function"),
      "production75_operator_input",
    );
    // Capture function references before the first await; caller object changes
    // cannot replace a reviewed transport or proof mid-operation.
    api = Object.freeze(
      Object.fromEntries(API_KEYS.map((k) => [k, api[k].bind(api)])),
    );
    callbacks = Object.freeze(
      Object.fromEntries(
        CALLBACK_KEYS.map((k) => [k, callbacks[k].bind(callbacks)]),
      ),
    );
    workResources = createOperatorResources({ now, until: plan.workUntil });
    cleanupResources = createOperatorResources({
      now,
      until: plan.cleanupUntil,
    });
    const call = async (fn, until = plan.workUntil) => {
      let timer;
      const deadline = Math.min(until, now() + 240000);
      try {
        check(now() < deadline, "production75_operator_deadline");
        const value = await Promise.race([
          Promise.resolve().then(() =>
            fn({
              resources: workResources,
              signal: workResources.signal,
              deadline,
            }),
          ),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => {
                workResources.abort();
                reject(error("production75_operator_deadline"));
              },
              Math.max(1, deadline - now()),
            );
          }),
        ]);
        if (now() >= deadline) workResources.abort();
        check(now() < deadline, "production75_operator_deadline");
        return value;
      } catch (e) {
        const diagnostic = production75V1FailureMetadata(e);
        if (diagnostic && !result.providerFailure)
          result.providerFailure = diagnostic;
        throw error("production75_operator_callback");
      } finally {
        clearTimeout(timer);
      }
    };
    const ownedFresh = async (until = plan.workUntil) => {
      const detail = await call(() => api.getCluster(copy.id), until),
        inventory = await call(() => api.listClusters(), until);
      check(
        detail &&
          detail.id === copy.id &&
          detail.name === plan.copyName &&
          detail.organization === plan.organization,
        "production75_operator_ownership",
      );
      const value = mergeV1OwnershipEvidence(detail, inventory);
      latestOwnedInventory = freeze(structuredClone(inventory));
      return value;
    };
    const waitOwnedReady = async () => {
      for (;;) {
        check(
          copy.version === plan.providerVersion &&
            copy.region === plan.region &&
            copy.plan === plan.plan,
          "production75_operator_suitability",
        );
        if (copy.status === "ready") return copy;
        check(
          ["creating", "restoring", "provisioning", "not-ready"].includes(
            copy.status,
          ) && now() < plan.workUntil,
          "production75_operator_not_ready",
        );
        await call(() => pause(pollMs));
        copy = await ownedFresh();
      }
    };
    custody = await openOperatorCustody({
      root: custodyRoot,
      plan,
      verifyOwnerApproval,
      verifyCapabilityReview,
      now,
    });
    const identity = await call(callbacks.verifyIdentity);
    check(
      identity?.account === plan.account &&
        identity.organization === plan.organization,
      "production75_operator_identity",
    );
    check(
      (await call(callbacks.moduleManifestSha256)) ===
        plan.moduleManifestSha256,
      "production75_operator_source",
    );
    const profile = expectedProduction75ReaderProfile(plan.readerName);
    check(
      production75ProfileDigest(profile) === plan.profileSha256,
      "production75_operator_profile",
    );
    const inventory = await call(() => api.listClusters());
    custody.observeBefore(inventory);
    const sourceMetadata = inventory.find((m) => m.id === plan.sourceCluster);
    check(
      sourceMetadata?.version === 1 &&
        sourceMetadata.plan === plan.plan &&
        sourceMetadata.region === plan.region,
      "production75_operator_source",
    );
    const backups = await call(() => api.listBackups(plan.sourceCluster)),
      backup = backups.find((b) => b.id === plan.backupId);
    check(
      backup?.status === "completed" &&
        Number.isFinite(Date.parse(backup.stop)) &&
        Date.parse(backup.stop) <= now() &&
        now() - Date.parse(backup.stop) <= 26 * 3600000,
      "production75_operator_backup",
    );
    before = freeze(
      structuredClone(
        await call((scope) =>
          callbacks.observeOriginals({ custody, plan, ...scope }),
        ),
      ),
    );
    check(
      production75SnapshotDigest(before) === plan.sourceSnapshotSha256,
      "production75_operator_source",
    );
    const creationPermit = custody.reserve("copy-create");
    result.creationAttempted = true;
    try {
      copy = await call(() => api.restoreCopy(creationPermit));
      creationAcknowledged = true;
    } catch {
      const after = await call(() => api.listClusters()),
        matches = after.filter(
          (m) =>
            m.name === plan.copyName &&
            !inventory.some((old) => old.id === m.id),
        );
      check(matches.length === 1, "production75_operator_create_unknown");
      copy = matches[0];
      result.possibleCopyId = copy.id;
      copy = await ownedFresh();
      await waitOwnedReady();
      cloneBefore = await call((scope) =>
        callbacks.observeCopy(copy, {
          readerName: null,
          custody,
          plan,
          ...scope,
        }),
      );
      custody.reconcileOwned(copy, {
        inventoryAfter: latestOwnedInventory,
        copySourceSnapshotSha256: production75SnapshotDigest(cloneBefore),
      });
      result.copyId = copy.id;
      throw error("production75_operator_create_unknown_no_replay");
    }
    // A creation response is not authoritative empty-attachment evidence.
    const creationEvidence = freeze(structuredClone(copy));
    result.possibleCopyId = copy.id;
    copy = await ownedFresh();
    custody.bindOwned(copy);
    result.copyId = copy.id;
    // Keep explicit acknowledgment contradictions visible while retaining owned cleanup.
    check(
      ["id", "name", "organization", "region", "plan"].every((k) =>
        isDeepStrictEqual(creationEvidence[k], copy[k]),
      ) &&
        (creationEvidence.version === null ||
          isDeepStrictEqual(creationEvidence.version, copy.version)) &&
        (creationEvidence.attachedApps === null ||
          isDeepStrictEqual(creationEvidence.attachedApps, copy.attachedApps)),
      "production75_operator_creation_conflict",
    );
    check(
      copy.version === plan.providerVersion &&
        copy.region === plan.region &&
        copy.plan === plan.plan,
      "production75_operator_suitability",
    );
    await waitOwnedReady();
    cloneBefore = freeze(
      structuredClone(
        await call((scope) =>
          callbacks.observeCopy(copy, {
            readerName: null,
            custody,
            plan,
            ...scope,
          }),
        ),
      ),
    );
    check(
      production75SnapshotDigest(cloneBefore) === plan.sourceSnapshotSha256,
      "production75_operator_clone",
    );
    custody.verifyClone(plan.sourceSnapshotSha256);
    const users = await call(() => api.listUsers(copy.id));
    check(
      !users.some((u) => u.name === plan.readerName),
      "production75_operator_reader_collision",
    );
    const readerPermit = custody.reserve("reader-create");
    await call(() => api.createReader(readerPermit));
    const afterReader = freeze(
      structuredClone(
        await call((scope) =>
          callbacks.observeCopy(copy, {
            readerName: plan.readerName,
            custody,
            plan,
            ...scope,
          }),
        ),
      ),
    );
    const delta = assertProduction75ReaderDelta({
      before: cloneBefore,
      after: afterReader,
      readerName: plan.readerName,
      expectedProfile: profile,
    });
    custody.verifyProfile(delta.profileSha256);
    result.readerProfileVerified = true;
    for (const outcome of ["rollback", "commit"]) {
      let ctx = await call((scope) =>
        callbacks.verificationContext({
          copy,
          readerName: plan.readerName,
          outcome,
          afterReader,
          delta,
          custody,
          plan,
          ...scope,
        }),
      );
      check(
        ctx?.plan?.target?.database === "fly-db" &&
          ctx.plan.target.writerLogin === "fly-user" &&
          ctx.plan.target.writerRole === "schema_admin" &&
          ctx.plan.target.readerLogin === plan.readerName &&
          ctx.plan.target.readerRole === plan.readerName &&
          ctx.capabilityReview?.receiptSha256 ===
            custody.status().reviewReceiptSha256,
        "production75_operator_verification_context",
      );
      ctx = bindVerificationContext(ctx, afterReader, delta, plan.readerName);
      const writer = ctx.writer,
        readFresh = ctx.readFresh;
      ctx = {
        ...ctx,
        writer: {
          connection: writer.connection,
          query: (...args) => workResources.query(writer, ...args),
        },
        readFresh: async (...args) => {
          workResources.assertActive();
          const result = await readFresh(...args, {
            resources: workResources,
            signal: workResources.signal,
            deadline: plan.workUntil,
          });
          workResources.assertActive();
          return result;
        },
      };
      const verified = await call(() =>
        runProduction75Verification({
          ...ctx,
          outcome,
          attemptId: randomUUID(),
          reserve: async (intent) => {
            check(
              intent.outcome === outcome &&
                intent.database === "fly-db" &&
                intent.sourceCommit === ctx.plan.sourceCommit,
              "production75_operator_reservation",
            );
            const permit = custody.reserve(`upgrade-${outcome}`);
            consumeOperatorPermit(permit, `upgrade-${outcome}`, copy.id);
            markOperatorPermitDispatched(permit);
            return true;
          },
          persist: (event) => custody.persistSQL(outcome, event),
        }),
      );
      result.outcomes[outcome] = {
        status: verified.status,
        proof: verified.proof ?? null,
        errorCode: verified.mechanism?.errorCode ?? verified.errorCode ?? null,
        stepsAcknowledged: verified.mechanism?.stepsAcknowledged ?? null,
      };
      if (combined(plan))
        check(
          positiveLegacy(verified, outcome),
          "production75_operator_upgrade_proof",
        );
      custody.recordUpgrade(outcome, verified.status);
      check(
        verified.status ===
          (outcome === "rollback" ? "verified-rollback" : "verified-commit") ||
          (outcome === "commit" &&
            verified.status === "reconciled-commit-no-replay"),
        "production75_operator_upgrade_held",
      );
    }
    if (combined(plan)) {
      result.outcomes.scheduling = {};
      let baseline = null;
      const usedWriters = new WeakSet();
      for (const outcome of ["rollback", "commit"]) {
        const supplied = await call((scope) =>
            callbacks.schedulingContext({
              copy,
              readerName: plan.readerName,
              outcome,
              baseline,
              custody,
              plan,
              ...scope,
            }),
          ),
          ctx = bindSchedulingContext(supplied, plan, baseline);
        check(
          !usedWriters.has(ctx.writer),
          "production75_operator_scheduling_context",
        );
        usedWriters.add(ctx.writer);
        if (!baseline) baseline = ctx.baseline;
        const rawWriter = ctx.writer,
          writeQuery = rawWriter.query,
          readFresh = ctx.readFresh,
          attemptId = randomUUID();
        let reservedBinding = null;
        const writer = {
          connection: rawWriter.connection,
          query: (...args) =>
            workResources.query(
              { query: (...q) => writeQuery.apply(rawWriter, q) },
              ...args,
            ),
        };
        const verified = await call(() =>
          runScheduling0019Verification({
            writer,
            plan: ctx.plan,
            baseline: ctx.baseline,
            outcome,
            attemptId,
            now,
            reserve: async (intent) => {
              check(
                intent &&
                  !types.isProxy(intent) &&
                  Reflect.ownKeys(intent).sort().join(",") ===
                    [
                      "kind",
                      "attemptId",
                      "database",
                      "sourceCommit",
                      "sourceSha256",
                      "baselineSha256",
                      "catalogSha256",
                      "policySha256",
                      "moduleManifestSha256",
                      "candidate",
                      "outcome",
                    ]
                      .sort()
                      .join(",") &&
                  Object.values(Object.getOwnPropertyDescriptors(intent)).every(
                    (d) => d.enumerable && Object.hasOwn(d, "value"),
                  ),
                "production75_operator_scheduling_reservation",
              );
              check(
                intent.kind === "SCHEDULING0019_TRANSACTION_RESERVATION" &&
                  intent.attemptId === attemptId &&
                  intent.outcome === outcome &&
                  intent.database === "fly-db" &&
                  intent.sourceCommit === plan.scheduling.source.sourceCommit &&
                  intent.sourceSha256 === plan.scheduling.source.sha256 &&
                  intent.moduleManifestSha256 === plan.moduleManifestSha256 &&
                  isDeepStrictEqual(intent.candidate, plan.candidate) &&
                  intent.catalogSha256 ===
                    catalogDigest(ctx.baseline.catalog, { physical: true }) &&
                  intent.policySha256 === sha(ctx.baseline.policy) &&
                  plan.scheduling.layouts.some(
                    (l) =>
                      l.beforeCatalogSha256 === intent.catalogSha256 &&
                      l.beforePolicySha256 === intent.policySha256,
                  ),
                "production75_operator_scheduling_reservation",
              );
              reservedBinding = freeze({
                baselineSha256: intent.baselineSha256,
                catalogSha256: intent.catalogSha256,
                policySha256: intent.policySha256,
              });
              custody.bindSchedulingBaseline(reservedBinding);
              const permit = custody.reserve(`scheduling0019-${outcome}`);
              consumeOperatorPermit(
                permit,
                `scheduling0019-${outcome}`,
                copy.id,
              );
              markOperatorPermitDispatched(permit);
              return true;
            },
            persist: (event) => custody.persistSchedulingSQL(outcome, event),
            readFresh: async () => {
              workResources.assertActive();
              const state = await readFresh();
              workResources.assertActive();
              return state;
            },
          }),
        );
        result.outcomes.scheduling[outcome] = verified;
        check(
          verified.attemptId === attemptId &&
            positiveScheduling(verified, outcome, reservedBinding, plan),
          "production75_operator_scheduling_held",
        );
        custody.recordScheduling(outcome, verified.status);
      }
    }
    complete = true;
  } catch (e) {
    result.errorCode = safeCode(e);
  } finally {
    // Resource closure is attempted before provider deletion on every path.
    await shutdown();
    if (custody) {
      const until = plan.cleanupUntil;
      const bounded = async (fn, maxMs = 30000) => {
        let timer;
        const deadline = Math.min(until, now() + maxMs);
        try {
          check(now() < deadline, "production75_operator_cleanup_deadline");
          const value = await Promise.race([
            Promise.resolve().then(() =>
              fn({
                resources: cleanupResources,
                signal: cleanupResources.signal,
                deadline,
              }),
            ),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => {
                  cleanupResources.abort();
                  reject(error("production75_operator_cleanup_deadline"));
                },
                Math.max(1, deadline - now()),
              );
            }),
          ]);
          if (now() >= deadline) cleanupResources.abort();
          check(now() < deadline, "production75_operator_cleanup_deadline");
          return value;
        } catch (e) {
          const diagnostic = production75V1FailureMetadata(e);
          if (diagnostic && !result.cleanupProviderFailure)
            result.cleanupProviderFailure = diagnostic;
          throw e;
        } finally {
          clearTimeout(timer);
        }
      };
      try {
        const id = custody.status().copyId;
        if (id) {
          const detail = await bounded(() => api.getCluster(id)),
            inventory = await bounded(() => api.listClusters());
          check(
            detail &&
              detail.id === id &&
              detail.name === plan.copyName &&
              detail.organization === plan.organization,
            "production75_operator_cleanup_ownership",
          );
          mergeV1OwnershipEvidence(detail, inventory);
          const deletionPermit = custody.reserve("copy-delete");
          try {
            await bounded(() => api.deleteCopy(deletionPermit));
          } catch {
            result.deleteAcknowledgmentUnknown = true;
          }
          while (now() < until) {
            const state = await bounded(() => api.getCluster(id)),
              active = await bounded(() => api.listClusters());
            check(
              Array.isArray(active) &&
                plan.protectedClusters.every((original) =>
                  active.some((m) => m.id === original),
                ),
              "production75_operator_original_missing",
            );
            if (
              !active.some((m) => m.id === id) &&
              (state === null ||
                (state.id === id && state.status === "deleted"))
            ) {
              custody.recordDeleted();
              result.copyDeleted = true;
              break;
            }
            if (state)
              check(
                state.id === id &&
                  state.name === plan.copyName &&
                  state.organization === plan.organization,
                "production75_operator_cleanup_ownership",
              );
            await bounded(() => pause(pollMs));
          }
          check(
            result.copyDeleted,
            "production75_operator_cleanup_unconfirmed",
          );
        }
        // A full fixed-query original proof can take longer than a provider request.
        // It follows owned deletion and remains inside the admitted cleanup deadline.
        try {
          check(
            (
              await bounded((scope) =>
                callbacks.verifyProtected({ before, plan, ...scope }),
              )
            )?.unchanged === true,
            "production75_operator_protected",
          );
          if (before)
            check(
              production75SnapshotDigest(
                await bounded(
                  (scope) =>
                    callbacks.observeOriginals({ custody, plan, ...scope }),
                  240000,
                ),
              ) === plan.sourceSnapshotSha256,
              "production75_operator_protected",
            );
          result.originalsPreserved = true;
        } catch {
          result.originalsPreserved = false;
        }
      } catch (e) {
        result.cleanupErrorCode = safeCode(e);
      } finally {
        result.custody = custody.status();
        try {
          custody.close();
        } catch {
          result.cleanupErrorCode = "production75_operator_custody_close";
        }
      }
    }
    await shutdown(true);
  }
  if (result.copyDeleted)
    result.status =
      complete &&
      result.originalsPreserved &&
      result.resourcesClosed &&
      !result.cleanupErrorCode
        ? "verified-and-cleaned"
        : "held-and-cleaned";
  else if (result.copyId || creationAcknowledged || result.creationAttempted)
    result.status = "held-owner-action-required";
  return Object.freeze(result);
}
