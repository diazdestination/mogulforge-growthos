/** Exclusive, content-free copy custody. No networking or credential access. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual, types } from "node:util";
import { PINNED_FILES } from "./production75-pins.mjs";

const SOURCE = "kzpwm0j18eg04nv3",
  STAGING = "zp2wjrejd2zodn4q";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/,
  ID = /^[a-z0-9]{16}$/;
const plans = new WeakSet(),
  permits = new WeakMap();
// The exact-byte selector is independently exercised by production75-source tests.
// Its generated step differs from the hash of the full initial source file.
const SQL_JOURNAL_PINS = [
  {
    path: "production75-selected-0000",
    sha256: "0240348d564b0d88860c4dde838949db8cdee81f13221a6dbf31841feb405a51",
  },
  ...PINNED_FILES.slice(1),
];
const freeze = (v) => {
  if (v && typeof v === "object") {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
const hash = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const error = (code) => Object.assign(new Error(code), { safeCode: code });
const check = (ok, code) => {
  if (!ok) throw error(code);
};
const keys = (o, allowed) =>
  o &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  Object.keys(o).every((k) => allowed.includes(k));
const clone = (v) => {
  try {
    return structuredClone(v);
  } catch {
    throw error("production75_custody_shape");
  }
};
// V2 accepts data records only, before cloning can drop hidden keys or invoke hooks.
function data(
  value,
  seen = new Set(),
  depth = 0,
  budget = { nodes: 0, bytes: 0 },
) {
  check(depth <= 30 && ++budget.nodes <= 100000, "production75_custody_shape");
  if (typeof value === "string") {
    budget.bytes += Buffer.byteLength(value);
    check(budget.bytes <= 1000000, "production75_custody_shape");
    return value;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  check(
    value &&
      typeof value === "object" &&
      !types.isProxy(value) &&
      !seen.has(value),
    "production75_custody_shape",
  );
  seen.add(value);
  const array = Array.isArray(value);
  check(
    Object.getPrototypeOf(value) ===
      (array ? Array.prototype : Object.prototype),
    "production75_custody_shape",
  );
  const result = array ? [] : {};
  const own = Reflect.ownKeys(value);
  check(own.length <= 30000, "production75_custody_shape");
  for (const key of own) {
    if (array && key === "length") continue;
    const d = Object.getOwnPropertyDescriptor(value, key);
    check(
      typeof key === "string" &&
        d.enumerable &&
        Object.hasOwn(d, "value") &&
        key !== "__proto__" &&
        (!array || /^(0|[1-9][0-9]*)$/.test(key)),
      "production75_custody_shape",
    );
    budget.bytes += Buffer.byteLength(key) + 4;
    check(budget.bytes <= 1000000, "production75_custody_shape");
    result[key] = data(d.value, seen, depth + 1, budget);
  }
  if (array)
    check(
      own.length === value.length + 1 && result.length === value.length,
      "production75_custody_shape",
    );
  seen.delete(value);
  return result;
}
const exact = (v, names) =>
  keys(v, names) && Object.keys(v).length === names.length;
const PRE = [
  "307fee292bc66d8f9fe11858d9cd8fe2c2983a59563ba867d6ebf50504f3ef6e",
  "2ed9500b5fb077a19aa16003bd346f8369a1b1cb3da8ea8f9a396265b6410f7b",
];
const DELTA = {
  stage: "scheduling0019",
  sourceCommit: "91b7fd2c1fd98d441848e0357954e35c9f65d688",
  path: "reports/staging-schema-preview-2026-10-01/0019_saved-scheduling-policy.sql",
  bytes: 8126,
  sha256: "76e88d3410235f1b6a8a20e595b126455fd5711b46f87055b586786b28f81ca9",
};
const v2 = (plan) => plan.kind === "PRODUCTION75_SCHEDULING0019_OPERATOR_V2";
export const operatorPlanDigest = (plan) => {
  check(plans.has(plan), "production75_custody_plan");
  return hash(plan);
};
export function production75ReaderName(runId) {
  check(
    typeof runId === "string" && UUID.test(runId),
    "production75_custody_plan",
  );
  return `growthos-reader-${runId.replaceAll("-", "")}`;
}

export function prepareOperatorPlan(input = {}) {
  const p = clone(input),
    allowed = [
      "runId",
      "backupId",
      "sourceSnapshotSha256",
      "profileSha256",
      "moduleManifestSha256",
      "preparedAt",
      "workMs",
      "cleanupMs",
      "maxCostUsdMicros",
    ];
  check(
    keys(p, allowed) &&
      Object.keys(p).length === allowed.length &&
      UUID.test(p.runId ?? "") &&
      /^[a-zA-Z0-9_.-]{1,128}$/.test(p.backupId ?? "") &&
      ["sourceSnapshotSha256", "profileSha256", "moduleManifestSha256"].every(
        (k) => HASH.test(p[k] ?? ""),
      ),
    "production75_custody_plan",
  );
  check(
    Number.isSafeInteger(p.preparedAt) &&
      p.preparedAt > 0 &&
      Number.isSafeInteger(p.workMs) &&
      p.workMs >= 1000 &&
      p.workMs <= 5400000 &&
      Number.isSafeInteger(p.cleanupMs) &&
      p.cleanupMs >= 10000 &&
      p.cleanupMs <= 1800000 &&
      p.workMs + p.cleanupMs <= 7200000 &&
      Number.isSafeInteger(p.maxCostUsdMicros) &&
      p.maxCostUsdMicros > 0 &&
      p.maxCostUsdMicros <= 1000000,
    "production75_custody_limits",
  );
  const plan = freeze({
    ...p,
    kind: "PRODUCTION75_ONE_COPY_OPERATOR",
    account: "diazdestination@gmail.com",
    organization: "adam-diaz",
    sourceCluster: SOURCE,
    protectedClusters: [SOURCE, STAGING],
    region: "iad",
    providerVersion: 1,
    plan: "basic",
    sourceCandidate: "8df64dc72009832f93b2b491031acd1bb2afb903",
    copyName: `growthos-drill-${p.runId}`,
    readerName: production75ReaderName(p.runId),
    workUntil: p.preparedAt + p.workMs,
    cleanupUntil: p.preparedAt + p.workMs + p.cleanupMs,
  });
  plans.add(plan);
  return plan;
}

export function prepareCombinedOperatorPlan(input) {
  const p = data(input),
    baseFields = [
      "runId",
      "backupId",
      "sourceSnapshotSha256",
      "profileSha256",
      "moduleManifestSha256",
      "preparedAt",
      "workMs",
      "cleanupMs",
      "maxCostUsdMicros",
    ];
  check(
    exact(p, [...baseFields, "candidate", "scheduling"]),
    "production75_custody_plan",
  );
  const c = p.candidate,
    s = p.scheduling;
  check(
    exact(c, ["repository", "commit", "tree"]) &&
      c.repository === "diazdestination/mogulforge-growthos" &&
      [c.commit, c.tree].every(
        (v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v),
      ),
    "production75_custody_plan",
  );
  check(
    exact(s, ["source", "layouts", "coverage"]) &&
      isDeepStrictEqual(s.source, DELTA) &&
      isDeepStrictEqual(s.coverage, {
        tables: 142,
        columnsBefore: 1867,
        columnsAfter: 1870,
        layouts: 2,
      }) &&
      Array.isArray(s.layouts) &&
      s.layouts.length === 2,
    "production75_custody_plan",
  );
  const fields = [
    "beforeCatalogSha256",
    "afterCatalogSha256",
    "beforePolicySha256",
    "afterPolicySha256",
  ];
  check(
    s.layouts.every(
      (l) =>
        exact(l, fields) &&
        fields.every((k) => typeof l[k] === "string" && HASH.test(l[k])),
    ) &&
      new Set(s.layouts.map((l) => l.beforeCatalogSha256)).size === 2 &&
      s.layouts.every((l) => PRE.includes(l.beforeCatalogSha256)),
    "production75_custody_plan",
  );
  // Layout ordering is explicit, independent of the caller's object insertion order.
  s.layouts.sort(
    (a, b) =>
      PRE.indexOf(a.beforeCatalogSha256) - PRE.indexOf(b.beforeCatalogSha256),
  );
  const legacy = prepareOperatorPlan(
    Object.fromEntries(baseFields.map((k) => [k, p[k]])),
  );
  const plan = freeze({
    ...legacy,
    kind: "PRODUCTION75_SCHEDULING0019_OPERATOR_V2",
    candidate: { repository: c.repository, commit: c.commit, tree: c.tree },
    scheduling: {
      source: { ...DELTA },
      layouts: s.layouts.map((l) =>
        Object.fromEntries(fields.map((k) => [k, l[k]])),
      ),
      coverage: {
        tables: 142,
        columnsBefore: 1867,
        columnsAfter: 1870,
        layouts: 2,
      },
    },
  });
  plans.add(plan);
  return plan;
}

export function validateOperatorMetadata(value) {
  const m = clone(value),
    allowed = [
      "id",
      "name",
      "organization",
      "region",
      "plan",
      "version",
      "status",
      "attachedApps",
    ];
  check(
    keys(m, allowed) &&
      Object.keys(m).length === allowed.length &&
      ID.test(m.id ?? "") &&
      /^[a-z0-9][a-z0-9-]{0,62}$/.test(m.name ?? "") &&
      /^[a-z0-9-]{1,63}$/.test(m.organization ?? "") &&
      /^[a-z]{3}$/.test(m.region ?? "") &&
      /^[a-z][a-z0-9-]{0,31}$/.test(m.plan ?? "") &&
      [1, 2].includes(m.version) &&
      [
        "ready",
        "creating",
        "restoring",
        "provisioning",
        "deleting",
        "deleted",
        "failed",
        "suspended",
        "not-ready",
      ].includes(m.status) &&
      Array.isArray(m.attachedApps) &&
      m.attachedApps.length <= 100 &&
      m.attachedApps.every(
        (a) => typeof a === "string" && /^[a-z0-9-]{1,63}$/.test(a),
      ),
    "production75_custody_ownership",
  );
  return freeze(m);
}
function inventoryShape(values) {
  check(
    Array.isArray(values) && values.length <= 1000,
    "production75_custody_ownership",
  );
  const list = values.map(validateOperatorMetadata);
  check(
    new Set(list.map((m) => m.id)).size === list.length,
    "production75_custody_ownership",
  );
  return freeze(list);
}
async function authenticated(
  plan,
  verifyOwnerApproval,
  verifyCapabilityReview,
  now,
  resume = false,
) {
  check(
    plans.has(plan) &&
      typeof verifyOwnerApproval === "function" &&
      typeof verifyCapabilityReview === "function" &&
      typeof now === "function",
    "production75_custody_admission",
  );
  check(
    now() >= plan.preparedAt && (resume || now() < plan.workUntil),
    "production75_custody_admission",
  );
  const call = async (fn) => {
    let timer;
    const until = now() + 15000;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => fn(plan)),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(error("production75_custody_admission")),
            15000,
          );
        }),
      ]);
      check(now() < until, "production75_custody_admission");
      return freeze(clone(value));
    } catch {
      throw error("production75_custody_admission");
    } finally {
      clearTimeout(timer);
    }
  };
  const owner = await call(verifyOwnerApproval),
    review = await call(verifyCapabilityReview),
    digest = operatorPlanDigest(plan);
  check(
    owner?.authenticated === true &&
      owner.kind === "owner-approval" &&
      owner.planSha256 === digest &&
      HASH.test(owner.receiptSha256 ?? "") &&
      owner.maxCopies === 1 &&
      owner.maxCostUsdMicros === plan.maxCostUsdMicros &&
      owner.expiresAt === plan.cleanupUntil &&
      owner.sourceWritesAuthorized === false,
    "production75_custody_admission",
  );
  check(
    review?.authenticated === true &&
      review.kind === "independent-capability-review" &&
      review.planSha256 === digest &&
      HASH.test(review.receiptSha256 ?? "") &&
      review.profileSha256 === plan.profileSha256 &&
      review.sourceSnapshotSha256 === plan.sourceSnapshotSha256 &&
      review.scope === "fixed-query-observation-with-inherited-capabilities" &&
      review.zeroDdlClusterWideVerified === false,
    "production75_custody_admission",
  );
  check(
    now() >= plan.preparedAt && (resume || now() < plan.workUntil),
    "production75_custody_admission",
  );
  return {
    ownerReceiptSha256: owner.receiptSha256,
    reviewReceiptSha256: review.receiptSha256,
  };
}

const OPERATIONS = new Set([
  "copy-create",
  "reader-create",
  "upgrade-rollback",
  "upgrade-commit",
  "scheduling0019-rollback",
  "scheduling0019-commit",
  "copy-delete",
  "credentials-source",
  "credentials-writer",
  "credentials-reader",
]);
function legacySQLShape(event) {
  const allowed = ["phase", "pid", "path", "sha256", "proof", "afterFailure"];
  check(
    keys(event, allowed) &&
      [
        "begin-intent",
        "begin-ack",
        "step-intent",
        "step-ack",
        "bridge-verified",
        "precommit-verified",
        "rollback-intent",
        "commit-intent",
        "rollback-ack",
        "commit-ack",
      ].includes(event.phase),
    "production75_custody_shape",
  );
  if ("pid" in event)
    check(
      Number.isInteger(event.pid) && event.pid > 0,
      "production75_custody_shape",
    );
  if ("path" in event)
    check(
      SQL_JOURNAL_PINS.some(
        (f) =>
          f.path === event.path &&
          (!("sha256" in event) || f.sha256 === event.sha256),
      ),
      "production75_custody_shape",
    );
  if ("proof" in event)
    check(
      keys(event.proof, [
        "originalTables",
        "originalColumns",
        "newTablesEmpty",
        "defaultsVerified",
      ]) &&
        Object.keys(event.proof).length === 4 &&
        Object.values(event.proof).every(
          (v) => Number.isSafeInteger(v) && v >= 0 && v <= 2000,
        ),
      "production75_custody_shape",
    );
  if ("afterFailure" in event)
    check(
      typeof event.afterFailure === "boolean",
      "production75_custody_shape",
    );
}
export function consumeOperatorPermit(permit, kind, target) {
  const p = permits.get(permit);
  check(
    p &&
      !p.consumed &&
      p.isUsable() &&
      p.kind === kind &&
      p.target === target &&
      p.now() < p.until,
    "production75_custody_permit",
  );
  p.consumed = true;
  return freeze(clone(p.scope));
}
export function describeOperatorPermit(permit, kind) {
  const p = permits.get(permit);
  check(
    p && !p.consumed && p.isUsable() && p.kind === kind && p.now() < p.until,
    "production75_custody_permit",
  );
  return freeze({ ...clone(p.scope), target: p.target });
}
export function markOperatorPermitDispatched(permit) {
  const p = permits.get(permit);
  check(
    p && p.consumed && !p.dispatched && p.isUsable() && p.now() < p.until,
    "production75_custody_permit",
  );
  p.dispatched = true;
  p.persistDispatch?.();
}
function construct({ root, plan, evidence, now, resume, io }) {
  let fd = null,
    lockFd = null,
    unusable = false,
    closed = false,
    sequence = 0,
    previous = "0".repeat(64),
    before = null,
    owned = null,
    ownership = null,
    cloneVerified = false,
    profileVerified = false,
    rollbackVerified = false,
    reconciling = resume;
  const used = new Set(),
    dispatched = new Set(),
    legacyEvidence = { rollback: {}, commit: {} },
    stageEvidence = { rollback: {}, commit: {} },
    digest = operatorPlanDigest(plan);
  let directory,
    baseline = null,
    legacyCommitVerified = false,
    schedulingRollbackVerified = false;
  const stageKind = (kind) => kind.startsWith("scheduling0019-");
  function schedulingPrerequisites(kind) {
    check(
      v2(plan) &&
        legacyCommitVerified &&
        baseline &&
        (!kind.endsWith("-commit") || schedulingRollbackVerified),
      "production75_custody_phase",
    );
  }
  function schedulingEvent(outcome, event) {
    check(
      v2(plan) &&
        ["rollback", "commit"].includes(outcome) &&
        dispatched.has(`scheduling0019-${outcome}`) &&
        !stageEvidence[outcome].result,
      "production75_custody_phase",
    );
    check(
      event &&
        typeof event === "object" &&
        !Array.isArray(event) &&
        typeof event.phase === "string",
      "production75_custody_shape",
    );
    const shapes = {
      "begin-intent": ["phase"],
      "begin-ack": ["phase", "pid"],
      "step-intent": ["phase", "path", "sha256"],
      "step-ack": ["phase", "path"],
      "precommit-verified": ["phase", "proof"],
      "rollback-intent": ["phase"],
      "commit-intent": ["phase"],
      "rollback-ack": [
        "phase",
        ...("afterFailure" in event ? ["afterFailure"] : []),
      ],
      "commit-ack": ["phase"],
    };
    check(
      exact(event, shapes[event.phase] ?? []) &&
        Object.hasOwn(shapes, event.phase),
      "production75_custody_shape",
    );
    if (
      event.phase.startsWith("commit-") ||
      event.phase.startsWith("rollback-")
    )
      check(
        event.phase.startsWith(outcome + "-") ||
          (event.phase === "rollback-ack" && event.afterFailure === true),
        "production75_custody_shape",
      );
    if ("pid" in event)
      check(
        Number.isSafeInteger(event.pid) && event.pid > 0,
        "production75_custody_shape",
      );
    if ("path" in event)
      check(
        event.path === plan.scheduling.source.path &&
          (!("sha256" in event) ||
            event.sha256 === plan.scheduling.source.sha256),
        "production75_custody_shape",
      );
    if ("proof" in event)
      check(
        isDeepStrictEqual(event.proof, {
          originalTables: 142,
          originalColumns: 1867,
          newColumns: 3,
          nullColumnsVerified: 3,
        }),
        "production75_custody_shape",
      );
    if ("afterFailure" in event)
      check(event.afterFailure === true, "production75_custody_shape");
    const previous = stageEvidence[outcome].phase ?? null;
    const prior = {
      "begin-intent": null,
      "begin-ack": "begin-intent",
      "step-intent": "begin-ack",
      "step-ack": "step-intent",
      "precommit-verified": "step-ack",
      [`${outcome}-intent`]: "precommit-verified",
      [`${outcome}-ack`]: `${outcome}-intent`,
    };
    if (event.afterFailure)
      check(
        [
          "begin-intent",
          "begin-ack",
          "step-intent",
          "step-ack",
          "precommit-verified",
        ].includes(previous),
        "production75_custody_phase",
      );
    else
      check(
        Object.hasOwn(prior, event.phase) && previous === prior[event.phase],
        "production75_custody_phase",
      );
  }
  const statuses = [
    "verified-rollback",
    "verified-commit",
    "reconciled-commit-no-replay",
    "verification-held-no-replay",
    "failed-or-held",
  ];
  const validStatus = (outcome, status) =>
    statuses.includes(status) &&
    (status !== "verified-rollback" || outcome === "rollback") &&
    (!["verified-commit", "reconciled-commit-no-replay"].includes(status) ||
      outcome === "commit");
  const failFs = () => {
    unusable = true;
    throw error("production75_custody_filesystem");
  };
  try {
    check(
      typeof root === "string" &&
        path.isAbsolute(root) &&
        io.lstatSync(root).isDirectory() &&
        !io.lstatSync(root).isSymbolicLink(),
      "production75_custody_root",
    );
    const canonical = io.realpathSync(root);
    check(
      path.resolve(root).toLowerCase() === canonical.toLowerCase(),
      "production75_custody_root",
    );
    directory = path.join(canonical, `operator-${digest}`);
    if (!resume) {
      try {
        io.mkdirSync(directory, { mode: 0o700 });
      } catch (e) {
        if (e.code === "EEXIST") throw error("production75_custody_replay");
        throw e;
      }
    } else
      check(
        io.lstatSync(directory).isDirectory() &&
          !io.lstatSync(directory).isSymbolicLink(),
        "production75_custody_journal",
      );
  } catch (e) {
    if (/^production75_custody_(root|replay|journal)$/.test(e?.safeCode ?? ""))
      throw e;
    throw error("production75_custody_filesystem");
  }
  const audit = path.join(directory, "audit.jsonl");
  const lock = path.join(directory, "active.lock");
  // Never steal a stale lock. An unclean exit requires explicit recovery review.
  // Exclusive creation works across processes, before any journal is read.
  try {
    lockFd = io.openSync(lock, "wx", 0o600);
    io.fsyncSync(lockFd);
  } catch (e) {
    if (e.code === "EEXIST") throw error("production75_custody_busy");
    throw error("production75_custody_filesystem");
  }
  const owns = (m) => {
    check(
      used.has("copy-create") &&
        before &&
        ID.test(m.id) &&
        !plan.protectedClusters.includes(m.id) &&
        !before.some((v) => v.id === m.id) &&
        m.name === plan.copyName &&
        m.organization === plan.organization &&
        m.attachedApps.length === 0,
      "production75_custody_ownership",
    );
  };
  function apply(event) {
    if (v2(plan)) {
      const shapes = {
        opened: ["kind", "plan", "evidence"],
        "inventory-before": ["kind", "inventory"],
        intent: ["kind", "operation", "target"],
        dispatched: ["kind", "operation"],
        owned: ["kind", "copy", "ownership"],
        "clone-verified": ["kind", "sha256"],
        "profile-verified": ["kind", "sha256"],
        "upgrade-result": ["kind", "outcome", "status"],
        sql: ["kind", "outcome", "event"],
        "scheduling-baseline": ["kind", "binding"],
        "scheduling-sql": ["kind", "outcome", "event"],
        "scheduling-result": ["kind", "outcome", "status"],
        deleted: ["kind", "copyId"],
      };
      check(
        Object.hasOwn(shapes, event.kind) && exact(event, shapes[event.kind]),
        "production75_custody_journal",
      );
    }
    switch (event.kind) {
      case "opened":
        check(
          sequence === 0 &&
            isDeepStrictEqual(event.plan, plan) &&
            isDeepStrictEqual(event.evidence, evidence),
          "production75_custody_journal",
        );
        break;
      case "inventory-before":
        check(
          !before && !used.has("copy-create"),
          "production75_custody_journal",
        );
        before = inventoryShape(event.inventory);
        check(
          plan.protectedClusters.every((id) =>
            before.some(
              (m) =>
                m.id === id &&
                m.organization === plan.organization &&
                m.status === "ready",
            ),
          ) && !before.some((m) => m.name === plan.copyName),
          "production75_custody_journal",
        );
        break;
      case "intent": {
        const kind = event.operation;
        check(
          OPERATIONS.has(kind) &&
            !used.has(kind) &&
            before &&
            event.target ===
              (["copy-create", "credentials-source"].includes(kind)
                ? plan.sourceCluster
                : owned?.id),
          "production75_custody_journal",
        );
        if (v2(plan)) {
          check(
            ownership !== "reconciled-clone" ||
              ["copy-delete", "credentials-writer"].includes(kind),
            "production75_custody_reconciliation",
          );
          if (!["copy-create", "credentials-source"].includes(kind))
            check(owned, "production75_custody_phase");
          if (owned && kind !== "copy-delete")
            check(
              owned.region === plan.region &&
                owned.plan === plan.plan &&
                owned.version === plan.providerVersion,
              "production75_custody_suitability",
            );
          if (kind === "reader-create")
            check(cloneVerified, "production75_custody_phase");
          if (kind === "credentials-reader")
            check(
              cloneVerified && used.has("reader-create"),
              "production75_custody_phase",
            );
          if (kind === "upgrade-rollback" || kind === "upgrade-commit")
            check(profileVerified, "production75_custody_phase");
          if (kind === "upgrade-commit")
            check(rollbackVerified, "production75_custody_phase");
        }
        if (stageKind(kind)) schedulingPrerequisites(kind);
        used.add(kind);
        break;
      }
      case "dispatched":
        check(
          v2(plan) &&
            exact(event, ["kind", "operation"]) &&
            used.has(event.operation) &&
            !dispatched.has(event.operation),
          "production75_custody_journal",
        );
        dispatched.add(event.operation);
        break;
      case "owned": {
        check(
          !owned &&
            ["acknowledged", "reconciled-clone"].includes(event.ownership),
          "production75_custody_journal",
        );
        const m = validateOperatorMetadata(event.copy);
        owns(m);
        owned = m;
        ownership = event.ownership;
        reconciling ||= ownership === "reconciled-clone";
        break;
      }
      case "clone-verified":
        check(
          event.sha256 === plan.sourceSnapshotSha256 && (!v2(plan) || owned),
          "production75_custody_journal",
        );
        cloneVerified = true;
        break;
      case "profile-verified":
        check(
          event.sha256 === plan.profileSha256 &&
            (!v2(plan) || (owned && used.has("reader-create"))),
          "production75_custody_journal",
        );
        profileVerified = true;
        break;
      case "upgrade-result": {
        if (v2(plan)) {
          check(
            exact(event, ["kind", "outcome", "status"]) &&
              ["rollback", "commit"].includes(event.outcome) &&
              validStatus(event.outcome, event.status) &&
              dispatched.has(`upgrade-${event.outcome}`) &&
              !legacyEvidence[event.outcome].result,
            "production75_custody_phase",
          );
          if (
            event.status === `verified-${event.outcome}` ||
            event.status === "reconciled-commit-no-replay"
          )
            check(
              legacyEvidence[event.outcome].precommit &&
                legacyEvidence[event.outcome].intent &&
                (event.status === "reconciled-commit-no-replay" ||
                  legacyEvidence[event.outcome].ack),
              "production75_custody_phase",
            );
          legacyEvidence[event.outcome].result = event.status;
          if (
            ["verified-commit", "reconciled-commit-no-replay"].includes(
              event.status,
            )
          )
            legacyCommitVerified = true;
        }
        if (
          event.outcome === "rollback" &&
          event.status === "verified-rollback"
        )
          rollbackVerified = true;
        break;
      }
      case "sql":
        if (v2(plan)) {
          check(
            ["rollback", "commit"].includes(event.outcome) &&
              dispatched.has(`upgrade-${event.outcome}`) &&
              !legacyEvidence[event.outcome].result,
            "production75_custody_phase",
          );
          legacySQLShape(event.event);
          if (event.event.phase === "precommit-verified")
            legacyEvidence[event.outcome].precommit = true;
          if (event.event.phase === `${event.outcome}-intent`)
            legacyEvidence[event.outcome].intent = true;
          if (
            event.event.phase === `${event.outcome}-ack` &&
            !event.event.afterFailure
          )
            legacyEvidence[event.outcome].ack = true;
        }
        break;
      case "scheduling-baseline":
        check(
          v2(plan) &&
            exact(event, ["kind", "binding"]) &&
            legacyCommitVerified &&
            !baseline &&
            exact(event.binding, [
              "baselineSha256",
              "catalogSha256",
              "policySha256",
            ]) &&
            Object.values(event.binding).every(
              (v) => typeof v === "string" && HASH.test(v),
            ) &&
            plan.scheduling.layouts.some(
              (l) =>
                l.beforeCatalogSha256 === event.binding.catalogSha256 &&
                l.beforePolicySha256 === event.binding.policySha256,
            ),
          "production75_custody_phase",
        );
        baseline = freeze(clone(event.binding));
        break;
      case "scheduling-sql":
        check(
          exact(event, ["kind", "outcome", "event"]),
          "production75_custody_shape",
        );
        schedulingEvent(event.outcome, event.event);
        stageEvidence[event.outcome].phase = event.event.phase;
        if (event.event.phase === "precommit-verified")
          stageEvidence[event.outcome].precommit = true;
        if (
          event.event.phase === `${event.outcome}-ack` &&
          !event.event.afterFailure
        )
          stageEvidence[event.outcome].ack = true;
        break;
      case "scheduling-result":
        check(
          v2(plan) &&
            exact(event, ["kind", "outcome", "status"]) &&
            ["rollback", "commit"].includes(event.outcome) &&
            validStatus(event.outcome, event.status) &&
            dispatched.has(`scheduling0019-${event.outcome}`) &&
            !stageEvidence[event.outcome].result,
          "production75_custody_phase",
        );
        if (event.status === `verified-${event.outcome}`)
          check(
            stageEvidence[event.outcome].precommit &&
              stageEvidence[event.outcome].ack,
            "production75_custody_phase",
          );
        if (event.status === "reconciled-commit-no-replay")
          check(
            stageEvidence.commit.precommit &&
              ["commit-intent", "commit-ack"].includes(
                stageEvidence.commit.phase,
              ),
            "production75_custody_phase",
          );
        stageEvidence[event.outcome].result = event.status;
        if (event.status === "verified-rollback")
          schedulingRollbackVerified = true;
        break;
      case "deleted":
        if (v2(plan))
          check(
            owned && used.has("copy-delete") && event.copyId === owned.id,
            "production75_custody_phase",
          );
        break;
      default:
        throw error("production75_custody_journal");
    }
  }
  function append(event) {
    check(!closed && !unusable, "production75_custody_unusable");
    const row = { sequence, previous, event };
    row.sha256 = hash(row);
    try {
      const bytes = Buffer.from(JSON.stringify(row) + "\n");
      check(bytes.length <= 1000000, "production75_custody_shape");
      let offset = 0;
      while (offset < bytes.length) {
        const written = io.writeSync(fd, bytes, offset, bytes.length - offset);
        check(written > 0, "production75_custody_filesystem");
        offset += written;
      }
      io.fsyncSync(fd);
      apply(event);
      sequence++;
      previous = row.sha256;
    } catch {
      failFs();
    }
  }
  try {
    if (resume) {
      check(
        io.lstatSync(audit).isFile() &&
          !io.lstatSync(audit).isSymbolicLink() &&
          io.statSync(audit).size <= 8000000,
        "production75_custody_journal",
      );
      const bytes = io.readFileSync(audit, "utf8");
      check(bytes.endsWith("\n"), "production75_custody_journal");
      const lines = bytes.trimEnd().split("\n");
      check(lines.length <= 25000, "production75_custody_journal");
      for (const text of lines) {
        const row = JSON.parse(text);
        check(
          keys(row, ["sequence", "previous", "event", "sha256"]) &&
            Object.keys(row).length === 4 &&
            row.sequence === sequence &&
            row.previous === previous &&
            row.sha256 ===
              hash({
                sequence: row.sequence,
                previous: row.previous,
                event: row.event,
              }),
          "production75_custody_journal",
        );
        apply(row.event);
        sequence++;
        previous = row.sha256;
      }
      check(sequence > 0, "production75_custody_journal");
      fd = io.openSync(audit, "a", 0o600);
    } else {
      fd = io.openSync(audit, "wx", 0o600);
      append({ kind: "opened", plan, evidence });
    }
  } catch {
    if (fd !== null)
      try {
        io.closeSync(fd);
      } catch {}
    try {
      io.closeSync(lockFd);
      io.unlinkSync(lock);
    } catch {}
    throw error("production75_custody_journal");
  }
  // A fsynced reservation file survives interruption before its journal row.
  for (const kind of OPERATIONS)
    if (io.existsSync(path.join(directory, `reserved-${kind}`))) used.add(kind);
  const healthy = () =>
    check(!closed && !unusable, "production75_custody_unusable");
  return Object.freeze({
    observeBefore(values) {
      healthy();
      check(
        !used.has("copy-create") && !before && !reconciling,
        "production75_custody_phase",
      );
      const list = inventoryShape(clone(values));
      check(
        plan.protectedClusters.every((id) =>
          list.some(
            (m) =>
              m.id === id &&
              m.organization === plan.organization &&
              m.status === "ready",
          ),
        ) && !list.some((m) => m.name === plan.copyName),
        "production75_custody_ownership",
      );
      append({ kind: "inventory-before", inventory: list });
    },
    bindOwned(value) {
      healthy();
      check(!owned && !reconciling, "production75_custody_phase");
      const m = validateOperatorMetadata(value);
      owns(m);
      append({ kind: "owned", copy: m, ownership: "acknowledged" });
    },
    reconcileOwned(value, { inventoryAfter, copySourceSnapshotSha256 } = {}) {
      healthy();
      check(!owned, "production75_custody_phase");
      const m = validateOperatorMetadata(value),
        after = inventoryShape(inventoryAfter);
      owns(m);
      check(
        copySourceSnapshotSha256 === plan.sourceSnapshotSha256 &&
          after.filter((v) => v.name === plan.copyName).length === 1 &&
          after.some((v) => isDeepStrictEqual(v, m)) &&
          plan.protectedClusters.every((id) => after.some((v) => v.id === id)),
        "production75_custody_ownership",
      );
      append({ kind: "owned", copy: m, ownership: "reconciled-clone" });
    },
    verifyClone(sha256) {
      healthy();
      check(
        owned && sha256 === plan.sourceSnapshotSha256,
        "production75_custody_phase",
      );
      append({ kind: "clone-verified", sha256 });
    },
    verifyProfile(sha256) {
      healthy();
      check(
        owned && used.has("reader-create") && sha256 === plan.profileSha256,
        "production75_custody_phase",
      );
      append({ kind: "profile-verified", sha256 });
    },
    reserve(kind) {
      healthy();
      check(
        OPERATIONS.has(kind) && (!stageKind(kind) || v2(plan)),
        "production75_custody_phase",
      );
      check(!used.has(kind), "production75_custody_replay");
      check(
        !reconciling || ["copy-delete", "credentials-writer"].includes(kind),
        "production75_custody_reconciliation",
      );
      const cleanup = kind === "copy-delete",
        until = cleanup ? plan.cleanupUntil : plan.workUntil;
      check(now() < until, "production75_custody_expired");
      if (kind === "copy-create")
        check(before && !owned, "production75_custody_phase");
      else if (kind === "credentials-source")
        check(before, "production75_custody_phase");
      else check(owned, "production75_custody_phase");
      if (owned && kind !== "copy-delete")
        check(
          owned.region === plan.region &&
            owned.plan === plan.plan &&
            owned.version === plan.providerVersion,
          "production75_custody_suitability",
        );
      if (kind === "reader-create")
        check(cloneVerified, "production75_custody_phase");
      if (kind === "upgrade-rollback" || kind === "upgrade-commit")
        check(profileVerified, "production75_custody_phase");
      if (kind === "credentials-reader")
        check(
          cloneVerified && used.has("reader-create"),
          "production75_custody_phase",
        );
      if (kind === "upgrade-commit")
        check(rollbackVerified, "production75_custody_phase");
      if (stageKind(kind)) schedulingPrerequisites(kind);
      const target =
        kind === "copy-create" || kind === "credentials-source"
          ? plan.sourceCluster
          : owned.id;
      let reservationFd;
      try {
        reservationFd = io.openSync(
          path.join(directory, `reserved-${kind}`),
          "wx",
          0o600,
        );
        io.fsyncSync(reservationFd);
      } catch (e) {
        if (e.code === "EEXIST") throw error("production75_custody_replay");
        failFs();
      } finally {
        if (reservationFd !== undefined)
          try {
            io.closeSync(reservationFd);
          } catch {
            failFs();
          }
      }
      append({ kind: "intent", operation: kind, target });
      const permit = Object.freeze({});
      permits.set(permit, {
        kind,
        target,
        until,
        now,
        consumed: false,
        dispatched: false,
        isUsable: () => !closed && !unusable,
        persistDispatch: v2(plan)
          ? () => append({ kind: "dispatched", operation: kind })
          : undefined,
        scope: {
          planSha256: digest,
          sourceCluster: plan.sourceCluster,
          backupId: plan.backupId,
          copyName: plan.copyName,
          copyId: owned?.id ?? null,
          readerName: plan.readerName,
          organization: plan.organization,
          until,
          ...(stageKind(kind)
            ? {
                ...baseline,
                sourceCommit: plan.scheduling.source.sourceCommit,
                sourceSha256: plan.scheduling.source.sha256,
                moduleManifestSha256: plan.moduleManifestSha256,
                candidate: plan.candidate,
              }
            : {}),
        },
      });
      return permit;
    },
    recordUpgrade(outcome, status) {
      healthy();
      check(
        ["rollback", "commit"].includes(outcome) &&
          used.has(`upgrade-${outcome}`) &&
          statuses.includes(status),
        "production75_custody_phase",
      );
      if (v2(plan)) {
        check(
          dispatched.has(`upgrade-${outcome}`) &&
            validStatus(outcome, status) &&
            !legacyEvidence[outcome].result,
          "production75_custody_phase",
        );
        if (
          status === `verified-${outcome}` ||
          status === "reconciled-commit-no-replay"
        )
          check(
            legacyEvidence[outcome].precommit &&
              legacyEvidence[outcome].intent &&
              (status === "reconciled-commit-no-replay" ||
                legacyEvidence[outcome].ack),
            "production75_custody_phase",
          );
      }
      append({ kind: "upgrade-result", outcome, status });
    },
    bindSchedulingBaseline(value) {
      healthy();
      const binding = data(value);
      check(
        v2(plan) && !reconciling && legacyCommitVerified,
        "production75_custody_phase",
      );
      check(now() < plan.workUntil, "production75_custody_expired");
      check(
        exact(binding, ["baselineSha256", "catalogSha256", "policySha256"]) &&
          Object.values(binding).every(
            (v) => typeof v === "string" && HASH.test(v),
          ) &&
          plan.scheduling.layouts.some(
            (l) =>
              l.beforeCatalogSha256 === binding.catalogSha256 &&
              l.beforePolicySha256 === binding.policySha256,
          ),
        "production75_custody_shape",
      );
      if (baseline) {
        check(
          isDeepStrictEqual(baseline, binding),
          "production75_custody_phase",
        );
        return;
      }
      append({ kind: "scheduling-baseline", binding });
    },
    recordScheduling(outcome, status) {
      healthy();
      check(
        v2(plan) &&
          ["rollback", "commit"].includes(outcome) &&
          validStatus(outcome, status) &&
          dispatched.has(`scheduling0019-${outcome}`) &&
          !stageEvidence[outcome].result,
        "production75_custody_phase",
      );
      if (status === `verified-${outcome}`)
        check(
          stageEvidence[outcome].precommit && stageEvidence[outcome].ack,
          "production75_custody_phase",
        );
      if (status === "reconciled-commit-no-replay")
        check(
          stageEvidence.commit.precommit &&
            ["commit-intent", "commit-ack"].includes(
              stageEvidence.commit.phase,
            ),
          "production75_custody_phase",
        );
      append({ kind: "scheduling-result", outcome, status });
    },
    persistSchedulingSQL(outcome, value) {
      healthy();
      const event = data(value);
      schedulingEvent(outcome, event);
      append({ kind: "scheduling-sql", outcome, event });
    },
    persistSQL(outcome, value) {
      if (v2(plan))
        check(
          ["rollback", "commit"].includes(outcome) &&
            dispatched.has(`upgrade-${outcome}`) &&
            !legacyEvidence[outcome].result,
          "production75_custody_phase",
        );
      healthy();
      const event = v2(plan) ? data(value) : clone(value);
      check(
        ["rollback", "commit"].includes(outcome) &&
          used.has(`upgrade-${outcome}`),
        "production75_custody_shape",
      );
      legacySQLShape(event);
      append({ kind: "sql", outcome, event });
    },
    recordDeleted() {
      healthy();
      check(owned && used.has("copy-delete"), "production75_custody_phase");
      append({ kind: "deleted", copyId: owned.id });
    },
    status() {
      return freeze({
        directory,
        planSha256: digest,
        reviewReceiptSha256: evidence.reviewReceiptSha256,
        copyId: owned?.id ?? null,
        ownership,
        used: [...used],
        reconciliationOnly: reconciling,
        unusable,
        closed,
      });
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        io.closeSync(fd);
        io.closeSync(lockFd);
        io.unlinkSync(lock);
      } catch {
        throw error("production75_custody_filesystem");
      }
    },
  });
}
export async function openOperatorCustody({
  root,
  plan,
  verifyOwnerApproval,
  verifyCapabilityReview,
  now = Date.now,
  io = fs,
} = {}) {
  const evidence = await authenticated(
    plan,
    verifyOwnerApproval,
    verifyCapabilityReview,
    now,
  );
  return construct({ root, plan, evidence, now, resume: false, io });
}
export async function resumeOperatorCustody({
  root,
  plan,
  verifyOwnerApproval,
  verifyCapabilityReview,
  now = Date.now,
  io = fs,
} = {}) {
  const evidence = await authenticated(
    plan,
    verifyOwnerApproval,
    verifyCapabilityReview,
    now,
    true,
  );
  return construct({ root, plan, evidence, now, resume: true, io });
}
