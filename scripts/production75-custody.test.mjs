import { test, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import {
  prepareOperatorPlan,
  openOperatorCustody,
  resumeOperatorCustody,
  consumeOperatorPermit,
  operatorPlanDigest,
  production75ReaderName,
} from "./production75-custody.mjs";
import * as custodyAPI from "./production75-custody.mjs";

export const metadata = (id, name) => ({
  id,
  name,
  organization: "adam-diaz",
  region: "iad",
  plan: "basic",
  version: id === "zp2wjrejd2zodn4q" ? 2 : 1,
  status: "ready",
  attachedApps: [],
});
export const inventory = () => [
  metadata("kzpwm0j18eg04nv3", "mogulforge-growthos-db"),
  metadata("zp2wjrejd2zodn4q", "growthos-staging"),
];
export function planInput() {
  return {
    runId: randomUUID(),
    backupId: "backup_local_fixture",
    sourceSnapshotSha256: "a".repeat(64),
    profileSha256: "b".repeat(64),
    moduleManifestSha256: "c".repeat(64),
    preparedAt: Date.now(),
    workMs: 90000,
    cleanupMs: 30000,
    maxCostUsdMicros: 150000,
  };
}
export function authority(plan) {
  return {
    verifyOwnerApproval: async () => ({
      authenticated: true,
      kind: "owner-approval",
      planSha256: operatorPlanDigest(plan),
      receiptSha256: "d".repeat(64),
      maxCopies: 1,
      maxCostUsdMicros: plan.maxCostUsdMicros,
      expiresAt: plan.cleanupUntil,
      sourceWritesAuthorized: false,
    }),
    verifyCapabilityReview: async () => ({
      authenticated: true,
      kind: "independent-capability-review",
      planSha256: operatorPlanDigest(plan),
      receiptSha256: "e".repeat(64),
      profileSha256: plan.profileSha256,
      sourceSnapshotSha256: plan.sourceSnapshotSha256,
      scope: "fixed-query-observation-with-inherited-capabilities",
      zeroDdlClusterWideVerified: false,
    }),
  };
}
function temp() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "production75-custody-test-"),
  );
  return {
    root,
    cleanup() {
      const absolute = fs.realpathSync(root);
      if (
        path.dirname(absolute) !== fs.realpathSync(os.tmpdir()) ||
        !path.basename(absolute).startsWith("production75-custody-test-")
      )
        throw new Error("owned test path refused");
      fs.rmSync(absolute, { recursive: true });
    },
  };
}

const candidate = {
  repository: "diazdestination/mogulforge-growthos",
  commit: "1".repeat(40),
  tree: "2".repeat(40),
};
const deltaSource = {
  stage: "scheduling0019",
  sourceCommit: "91b7fd2c1fd98d441848e0357954e35c9f65d688",
  path: "reports/staging-schema-preview-2026-10-01/0019_saved-scheduling-policy.sql",
  bytes: 8126,
  sha256: "76e88d3410235f1b6a8a20e595b126455fd5711b46f87055b586786b28f81ca9",
};
const preDigests = [
  "307fee292bc66d8f9fe11858d9cd8fe2c2983a59563ba867d6ebf50504f3ef6e",
  "2ed9500b5fb077a19aa16003bd346f8369a1b1cb3da8ea8f9a396265b6410f7b",
];
const combinedInput = () => ({
  ...planInput(),
  candidate,
  scheduling: {
    source: deltaSource,
    layouts: preDigests.map((beforeCatalogSha256, i) => ({
      beforeCatalogSha256,
      afterCatalogSha256: String(i + 3).repeat(64),
      beforePolicySha256: "4".repeat(64),
      afterPolicySha256: "5".repeat(64),
    })),
    coverage: {
      tables: 142,
      columnsBefore: 1867,
      columnsAfter: 1870,
      layouts: 2,
    },
  },
});
const combinedPlan = (input) => {
  if (!custodyAPI.prepareCombinedOperatorPlan) throw Error("not_implemented");
  return custodyAPI.prepareCombinedOperatorPlan(input ?? combinedInput());
};
const binding = {
  baselineSha256: "6".repeat(64),
  catalogSha256: preDigests[0],
  policySha256: "4".repeat(64),
};
function dispatch(c, kind, target = "abcdefghijklmnop") {
  const p = c.reserve(kind);
  consumeOperatorPermit(p, kind, target);
  custodyAPI.markOperatorPermitDispatched(p);
  return p;
}
function readyLegacy(c, p) {
  c.observeBefore(inventory());
  dispatch(c, "copy-create", p.sourceCluster);
  c.bindOwned(metadata("abcdefghijklmnop", p.copyName));
  c.verifyClone(p.sourceSnapshotSha256);
  dispatch(c, "reader-create");
  c.verifyProfile(p.profileSha256);
}
function finishLegacy(c, outcome) {
  dispatch(c, `upgrade-${outcome}`);
  c.persistSQL(outcome, {
    phase: "precommit-verified",
    proof: {
      originalTables: 75,
      originalColumns: 900,
      newTablesEmpty: 67,
      defaultsVerified: 1,
    },
  });
  c.persistSQL(outcome, { phase: `${outcome}-intent` });
  c.persistSQL(outcome, { phase: `${outcome}-ack` });
  c.recordUpgrade(outcome, `verified-${outcome}`);
}
function finishScheduling(c, outcome) {
  dispatch(c, `scheduling0019-${outcome}`);
  c.persistSchedulingSQL(outcome, { phase: "begin-intent" });
  c.persistSchedulingSQL(outcome, { phase: "begin-ack", pid: 123 });
  c.persistSchedulingSQL(outcome, {
    phase: "step-intent",
    path: deltaSource.path,
    sha256: deltaSource.sha256,
  });
  c.persistSchedulingSQL(outcome, {
    phase: "step-ack",
    path: deltaSource.path,
  });
  c.persistSchedulingSQL(outcome, {
    phase: "precommit-verified",
    proof: {
      originalTables: 142,
      originalColumns: 1867,
      newColumns: 3,
      nullColumnsVerified: 3,
    },
  });
  c.persistSchedulingSQL(outcome, { phase: `${outcome}-intent` });
  c.persistSchedulingSQL(outcome, { phase: `${outcome}-ack` });
  c.recordScheduling(outcome, `verified-${outcome}`);
}
async function withCombined(fn) {
  const t = temp();
  let c;
  try {
    const p = combinedPlan();
    c = await openOperatorCustody({ root: t.root, plan: p, ...authority(p) });
    await fn(c, p, t);
  } finally {
    c?.close();
    t.cleanup();
  }
}

test("combined constructor is closed, branded, frozen and separate from unchanged nine-input legacy plan", () => {
  const input = combinedInput(),
    p = combinedPlan(input);
  expect(p.kind).toBe("PRODUCTION75_SCHEDULING0019_OPERATOR_V2");
  expect(Object.isFrozen(p.scheduling.layouts[0])).toBe(true);
  expect(operatorPlanDigest(p)).not.toBe(
    operatorPlanDigest(prepareOperatorPlan(planInput())),
  );
  input.scheduling.layouts[0].afterCatalogSha256 = "0".repeat(64);
  expect(p.scheduling.layouts[0].afterCatalogSha256).toBe("3".repeat(64));
  for (const change of [
    { candidate: { ...candidate, commit: "A".repeat(40) } },
    { extra: 1 },
    {
      scheduling: {
        ...combinedInput().scheduling,
        coverage: {
          tables: 141,
          columnsBefore: 1867,
          columnsAfter: 1870,
          layouts: 2,
        },
      },
    },
    {
      scheduling: {
        ...combinedInput().scheduling,
        source: { ...deltaSource, sha256: "0".repeat(64) },
      },
    },
  ])
    expect(() => combinedPlan({ ...combinedInput(), ...change })).toThrow(
      /production75_custody/,
    );
  expect(() => prepareOperatorPlan(combinedInput())).toThrow(
    /production75_custody_plan/,
  );
});
test("legacy plans refuse scheduling permits and baseline admission", async () => {
  const t = temp();
  let c;
  try {
    const p = prepareOperatorPlan(planInput());
    c = await openOperatorCustody({ root: t.root, plan: p, ...authority(p) });
    expect(() => c.reserve("scheduling0019-rollback")).toThrow(
      /production75_custody/,
    );
    expect(() => c.bindSchedulingBaseline(binding)).toThrow(
      /production75_custody_phase/,
    );
  } finally {
    c?.close();
    t.cleanup();
  }
});
test("scheduling requires dispatched actual successful legacy commit evidence then stable full142 baseline and verified delta rollback", async () =>
  withCombined((c, p) => {
    readyLegacy(c, p);
    expect(() => c.bindSchedulingBaseline(binding)).toThrow(
      /production75_custody_phase/,
    );
    finishLegacy(c, "rollback");
    const permit = c.reserve("upgrade-commit");
    expect(() => c.recordUpgrade("commit", "verified-commit")).toThrow(
      /production75_custody_phase/,
    );
    consumeOperatorPermit(permit, "upgrade-commit", "abcdefghijklmnop");
    custodyAPI.markOperatorPermitDispatched(permit);
    expect(() => c.recordUpgrade("commit", "verified-commit")).toThrow(
      /production75_custody_phase/,
    );
    c.persistSQL("commit", {
      phase: "precommit-verified",
      proof: {
        originalTables: 75,
        originalColumns: 900,
        newTablesEmpty: 67,
        defaultsVerified: 1,
      },
    });
    c.persistSQL("commit", { phase: "commit-intent" });
    c.persistSQL("commit", { phase: "commit-ack" });
    c.recordUpgrade("commit", "verified-commit");
    expect(() => c.reserve("scheduling0019-rollback")).toThrow(
      /production75_custody_phase/,
    );
    for (const bad of [
      { ...binding, catalogSha256: "0".repeat(64) },
      { ...binding, policySha256: "0".repeat(64) },
      { ...binding, baselineSha256: "invalid" },
      { ...binding, copyId: "foreign" },
    ])
      expect(() => c.bindSchedulingBaseline(bad)).toThrow(
        /production75_custody/,
      );
    c.bindSchedulingBaseline(binding);
    expect(() =>
      c.bindSchedulingBaseline({ ...binding, baselineSha256: "7".repeat(64) }),
    ).toThrow(/production75_custody/);
    expect(() => c.reserve("scheduling0019-commit")).toThrow(
      /production75_custody_phase/,
    );
    finishScheduling(c, "rollback");
    expect(() => c.reserve("scheduling0019-rollback")).toThrow(
      /production75_custody_replay/,
    );
    const stage = c.reserve("scheduling0019-commit");
    expect(() =>
      consumeOperatorPermit(stage, "scheduling0019-commit", "ponmlkjihgfedcba"),
    ).toThrow(/production75_custody_permit/);
    const scope = consumeOperatorPermit(
      stage,
      "scheduling0019-commit",
      "abcdefghijklmnop",
    );
    expect(scope).toMatchObject({
      baselineSha256: binding.baselineSha256,
      sourceSha256: deltaSource.sha256,
      candidate,
      moduleManifestSha256: p.moduleManifestSha256,
    });
    custodyAPI.markOperatorPermitDispatched(stage);
    expect(() => custodyAPI.markOperatorPermitDispatched(stage)).toThrow(
      /production75_custody_permit/,
    );
  }));
test("scheduling SQL has phase-specific closed source allowlists, proof counts and one-use dispatch", async () =>
  withCombined((c, p) => {
    readyLegacy(c, p);
    finishLegacy(c, "rollback");
    finishLegacy(c, "commit");
    c.bindSchedulingBaseline(binding);
    c.reserve("scheduling0019-rollback");
    expect(() =>
      c.persistSchedulingSQL("rollback", { phase: "begin-intent" }),
    ).toThrow(/production75_custody_phase/);
  }));
test("scheduling SQL rejects foreign source, surplus keys, malformed ACKs and stand-alone results", async () =>
  withCombined((c, p) => {
    readyLegacy(c, p);
    finishLegacy(c, "rollback");
    finishLegacy(c, "commit");
    c.bindSchedulingBaseline(binding);
    dispatch(c, "scheduling0019-rollback");
    for (const value of [
      null,
      0,
      "malformed",
      true,
      undefined,
      [],
      { phase: "step-intent", path: deltaSource.path, sha256: "0".repeat(64) },
      { phase: "step-intent", path: "foreign", sha256: deltaSource.sha256 },
      { phase: "step-ack", path: deltaSource.path, sha256: deltaSource.sha256 },
      { phase: "begin-intent", pid: 1 },
      { phase: "begin-ack", pid: 0 },
      {
        phase: "precommit-verified",
        proof: {
          originalTables: 141,
          originalColumns: 1867,
          newColumns: 3,
          nullColumnsVerified: 3,
        },
      },
      { phase: "commit-ack" },
      { phase: "rollback-ack", afterFailure: false },
      { phase: "bridge-verified" },
    ])
      expect(() => c.persistSchedulingSQL("rollback", value)).toThrow(
        /production75_custody_shape/,
      );
    expect(() => c.recordScheduling("rollback", "verified-rollback")).toThrow(
      /production75_custody_phase/,
    );
  }));
test("v2 resume validates durable stage events and forbids all new upgrade permits", async () =>
  withCombined(async (c, p, t) => {
    readyLegacy(c, p);
    finishLegacy(c, "rollback");
    finishLegacy(c, "commit");
    c.bindSchedulingBaseline(binding);
    finishScheduling(c, "rollback");
    const directory = c.status().directory;
    c.close();
    const r = await resumeOperatorCustody({
      root: t.root,
      plan: p,
      ...authority(p),
    });
    try {
      for (const kind of ["upgrade-commit", "scheduling0019-commit"])
        expect(() => r.reserve(kind)).toThrow(
          /production75_custody_(replay|reconciliation)/,
        );
    } finally {
      r.close();
    }
    const file = path.join(directory, "audit.jsonl"),
      rows = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
    rows.find(
      (row) =>
        row.event.kind === "scheduling-sql" &&
        row.event.event.phase === "step-intent",
    ).event.event.sha256 = "0".repeat(64);
    let previous = "0".repeat(64);
    for (const row of rows) {
      row.previous = previous;
      row.sha256 = createHash("sha256")
        .update(
          JSON.stringify({
            sequence: row.sequence,
            previous,
            event: row.event,
          }),
        )
        .digest("hex");
      previous = row.sha256;
    }
    fs.writeFileSync(file, rows.map(JSON.stringify).join("\n") + "\n");
    await expect(
      resumeOperatorCustody({ root: t.root, plan: p, ...authority(p) }),
    ).rejects.toMatchObject({ safeCode: "production75_custody_journal" });
  }));
test("verified status for another outcome cannot manufacture legacy commit or scheduling rollback evidence", async () =>
  withCombined((c, p) => {
    readyLegacy(c, p);
    dispatch(c, "upgrade-rollback");
    c.persistSQL("rollback", {
      phase: "precommit-verified",
      proof: {
        originalTables: 75,
        originalColumns: 900,
        newTablesEmpty: 67,
        defaultsVerified: 1,
      },
    });
    c.persistSQL("rollback", { phase: "rollback-intent" });
    c.persistSQL("rollback", { phase: "rollback-ack" });
    expect(() => c.recordUpgrade("rollback", "verified-commit")).toThrow(
      /production75_custody_phase/,
    );
    c.recordUpgrade("rollback", "verified-rollback");
    finishLegacy(c, "commit");
    c.bindSchedulingBaseline(binding);
    dispatch(c, "scheduling0019-rollback");
    expect(() => c.recordScheduling("rollback", "verified-commit")).toThrow(
      /production75_custody_phase/,
    );
  }));
test("v2 legacy SQL requires its dispatched permit before any journal append", async () =>
  withCombined((c, p) => {
    readyLegacy(c, p);
    c.reserve("upgrade-rollback");
    const before = fs.readFileSync(
      path.join(c.status().directory, "audit.jsonl"),
      "utf8",
    );
    expect(() =>
      c.persistSQL("rollback", {
        phase: "precommit-verified",
        proof: {
          originalTables: 75,
          originalColumns: 900,
          newTablesEmpty: 67,
          defaultsVerified: 1,
        },
      }),
    ).toThrow(/production75_custody_phase/);
    expect(c.status().unusable).toBe(false);
    expect(
      fs.readFileSync(path.join(c.status().directory, "audit.jsonl"), "utf8"),
    ).toBe(before);
  }));
test.each([
  "reservation-fsync",
  "journal-fsync",
  "partial-write",
  "zero-write",
  "reservation-close",
])(
  "stage %s interruption burns custody and outstanding permits without replay",
  async (mode) => {
    const t = temp();
    let c, r;
    try {
      const p = combinedPlan();
      let active = false,
        reservationFd = null,
        auditFd = null;
      const io = {
        ...fs,
        openSync(file, ...args) {
          const fd = fs.openSync(file, ...args);
          if (path.basename(file) === "reserved-scheduling0019-rollback")
            reservationFd = fd;
          if (path.basename(file) === "audit.jsonl") auditFd = fd;
          return fd;
        },
        fsyncSync(fd) {
          if (
            active &&
            ((mode === "reservation-fsync" && fd === reservationFd) ||
              (mode === "journal-fsync" && fd === auditFd))
          )
            throw Error("synthetic failure");
          return fs.fsyncSync(fd);
        },
        closeSync(fd) {
          fs.closeSync(fd);
          if (active && mode === "reservation-close" && fd === reservationFd)
            throw Error("synthetic close failure");
        },
        writeSync(fd, buffer, offset, length) {
          if (active && mode === "zero-write") return 0;
          if (active && mode === "partial-write") {
            fs.writeSync(fd, buffer, offset, Math.min(10, length));
            throw Error("synthetic partial write");
          }
          return fs.writeSync(fd, buffer, offset, length);
        },
      };
      c = await openOperatorCustody({
        root: t.root,
        plan: p,
        ...authority(p),
        io,
      });
      readyLegacy(c, p);
      finishLegacy(c, "rollback");
      finishLegacy(c, "commit");
      c.bindSchedulingBaseline(binding);
      const prior = c.reserve("credentials-writer");
      active = true;
      expect(() => c.reserve("scheduling0019-rollback")).toThrow(
        /production75_custody_filesystem/,
      );
      expect(c.status().unusable).toBe(true);
      expect(() =>
        consumeOperatorPermit(prior, "credentials-writer", "abcdefghijklmnop"),
      ).toThrow(/production75_custody_permit/);
      const directory = c.status().directory;
      expect(
        fs.existsSync(path.join(directory, "reserved-scheduling0019-rollback")),
      ).toBe(true);
      active = false;
      c.close();
      c = null;
      if (mode === "partial-write") {
        await expect(
          resumeOperatorCustody({ root: t.root, plan: p, ...authority(p) }),
        ).rejects.toMatchObject({ safeCode: "production75_custody_journal" });
      } else {
        r = await resumeOperatorCustody({
          root: t.root,
          plan: p,
          ...authority(p),
        });
        expect(() => r.reserve("scheduling0019-rollback")).toThrow(
          /production75_custody_replay/,
        );
        expect(() => r.reserve("scheduling0019-commit")).toThrow(
          /production75_custody_reconciliation/,
        );
        r.close();
        r = null;
      }
      fs.writeFileSync(path.join(directory, "active.lock"), "stale");
      await expect(
        resumeOperatorCustody({ root: t.root, plan: p, ...authority(p) }),
      ).rejects.toMatchObject({ safeCode: "production75_custody_busy" });
    } finally {
      c?.close();
      r?.close();
      t.cleanup();
    }
  },
);
test("positive exact Reader reconciliation after lost legacy ACK permits delta, but lacks authority without precommit and terminal intent", async () =>
  withCombined((c, p) => {
    readyLegacy(c, p);
    finishLegacy(c, "rollback");
    dispatch(c, "upgrade-commit");
    expect(() =>
      c.recordUpgrade("commit", "reconciled-commit-no-replay"),
    ).toThrow(/production75_custody_phase/);
    c.persistSQL("commit", {
      phase: "precommit-verified",
      proof: {
        originalTables: 75,
        originalColumns: 900,
        newTablesEmpty: 67,
        defaultsVerified: 1,
      },
    });
    expect(() =>
      c.recordUpgrade("commit", "reconciled-commit-no-replay"),
    ).toThrow(/production75_custody_phase/);
    c.persistSQL("commit", { phase: "commit-intent" });
    c.recordUpgrade("commit", "reconciled-commit-no-replay");
    c.bindSchedulingBaseline(binding);
    expect(() => c.reserve("scheduling0019-rollback")).not.toThrow();
  }));
test("stage journal must progress through actual BEGIN, source step, preservation, and terminal ACK", async () =>
  withCombined((c, p) => {
    readyLegacy(c, p);
    finishLegacy(c, "rollback");
    finishLegacy(c, "commit");
    c.bindSchedulingBaseline(binding);
    dispatch(c, "scheduling0019-rollback");
    expect(() =>
      c.persistSchedulingSQL("rollback", {
        phase: "precommit-verified",
        proof: {
          originalTables: 142,
          originalColumns: 1867,
          newColumns: 3,
          nullColumnsVerified: 3,
        },
      }),
    ).toThrow(/production75_custody_phase/);
    c.persistSchedulingSQL("rollback", { phase: "begin-intent" });
    expect(() =>
      c.persistSchedulingSQL("rollback", { phase: "begin-intent" }),
    ).toThrow(/production75_custody_phase/);
    c.persistSchedulingSQL("rollback", { phase: "begin-ack", pid: 123 });
    c.persistSchedulingSQL("rollback", {
      phase: "step-intent",
      path: deltaSource.path,
      sha256: deltaSource.sha256,
    });
    c.persistSchedulingSQL("rollback", {
      phase: "rollback-ack",
      afterFailure: true,
    });
    c.recordScheduling("rollback", "failed-or-held");
    expect(() => c.recordScheduling("rollback", "verified-rollback")).toThrow(
      /production75_custody_phase/,
    );
    expect(() => c.reserve("scheduling0019-commit")).toThrow(
      /production75_custody_phase/,
    );
  }));
test("cleanup ACK cannot follow any terminal dispatch intent", async () =>
  withCombined((c, p) => {
    readyLegacy(c, p);
    finishLegacy(c, "rollback");
    finishLegacy(c, "commit");
    c.bindSchedulingBaseline(binding);
    dispatch(c, "scheduling0019-rollback");
    for (const value of [
      { phase: "begin-intent" },
      { phase: "begin-ack", pid: 123 },
      {
        phase: "step-intent",
        path: deltaSource.path,
        sha256: deltaSource.sha256,
      },
      { phase: "step-ack", path: deltaSource.path },
      {
        phase: "precommit-verified",
        proof: {
          originalTables: 142,
          originalColumns: 1867,
          newColumns: 3,
          nullColumnsVerified: 3,
        },
      },
      { phase: "rollback-intent" },
    ])
      c.persistSchedulingSQL("rollback", value);
    expect(() =>
      c.persistSchedulingSQL("rollback", {
        phase: "rollback-ack",
        afterFailure: true,
      }),
    ).toThrow(/production75_custody_phase/);
  }));
test.each([
  "missing-legacy-rollback",
  "changed-baseline",
  "foreign-legacy-source",
  "unknown-legacy-event",
  "changed-stage-order",
  "missing-commit-intent",
])(
  "journal replay refuses semantically altered %s despite valid hash chain",
  async (attack) =>
    withCombined(async (c, p, t) => {
      readyLegacy(c, p);
      finishLegacy(c, "rollback");
      finishLegacy(c, "commit");
      c.bindSchedulingBaseline(binding);
      finishScheduling(c, "rollback");
      const file = path.join(c.status().directory, "audit.jsonl");
      c.close();
      let rows = fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      if (attack === "missing-legacy-rollback")
        rows = rows.filter(
          ({ event: e }) =>
            !(
              e.operation === "upgrade-rollback" ||
              (["sql", "upgrade-result"].includes(e.kind) &&
                e.outcome === "rollback")
            ),
        );
      if (attack === "changed-baseline")
        rows.find(
          (r) => r.event.kind === "scheduling-baseline",
        ).event.binding.policySha256 = "0".repeat(64);
      if (attack === "foreign-legacy-source") {
        const row = rows.find((r) => r.event.kind === "sql");
        row.event.event = {
          phase: "step-intent",
          path: "foreign-unreviewed.sql",
          sha256: "0".repeat(64),
        };
      }
      if (attack === "unknown-legacy-event")
        rows.find((r) => r.event.kind === "sql").event.event.secret =
          "not permitted";
      if (attack === "changed-stage-order")
        rows.find((r) => r.event.kind === "scheduling-sql").event.event = {
          phase: "begin-ack",
          pid: 1,
        };
      if (attack === "missing-commit-intent")
        rows = rows.filter(
          ({ event: e }) =>
            !(
              e.kind === "sql" &&
              e.outcome === "commit" &&
              e.event.phase === "commit-intent"
            ),
        );
      let previous = "0".repeat(64);
      rows.forEach((row, i) => {
        row.sequence = i;
        row.previous = previous;
        row.sha256 = createHash("sha256")
          .update(JSON.stringify({ sequence: i, previous, event: row.event }))
          .digest("hex");
        previous = row.sha256;
      });
      fs.writeFileSync(
        file,
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
      await expect(
        resumeOperatorCustody({ root: t.root, plan: p, ...authority(p) }),
      ).rejects.toMatchObject({ safeCode: "production75_custody_journal" });
    }),
);

test("scheduling reconciled commit needs preserved precommit and actual terminal dispatch intent", async () =>
  withCombined((c, p) => {
    readyLegacy(c, p);
    finishLegacy(c, "rollback");
    finishLegacy(c, "commit");
    c.bindSchedulingBaseline(binding);
    finishScheduling(c, "rollback");
    dispatch(c, "scheduling0019-commit");
    expect(() =>
      c.recordScheduling("commit", "reconciled-commit-no-replay"),
    ).toThrow(/production75_custody_phase/);
    for (const event of [
      { phase: "begin-intent" },
      { phase: "begin-ack", pid: 123 },
      {
        phase: "step-intent",
        path: deltaSource.path,
        sha256: deltaSource.sha256,
      },
      { phase: "step-ack", path: deltaSource.path },
      {
        phase: "precommit-verified",
        proof: {
          originalTables: 142,
          originalColumns: 1867,
          newColumns: 3,
          nullColumnsVerified: 3,
        },
      },
    ])
      c.persistSchedulingSQL("commit", event);
    expect(() =>
      c.recordScheduling("commit", "reconciled-commit-no-replay"),
    ).toThrow(/production75_custody_phase/);
    c.persistSchedulingSQL("commit", { phase: "commit-intent" });
    expect(() =>
      c.recordScheduling("commit", "reconciled-commit-no-replay"),
    ).not.toThrow();
  }));

test("identical active baseline bind is idempotent without a second event or reservation rearm", async () =>
  withCombined((c, p) => {
    readyLegacy(c, p);
    finishLegacy(c, "rollback");
    finishLegacy(c, "commit");
    c.bindSchedulingBaseline(binding);
    const file = path.join(c.status().directory, "audit.jsonl"),
      before = fs.readFileSync(file, "utf8");
    expect(() => c.bindSchedulingBaseline({ ...binding })).not.toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    finishScheduling(c, "rollback");
    c.bindSchedulingBaseline({ ...binding });
    expect(() => c.reserve("scheduling0019-rollback")).toThrow(
      /production75_custody_replay/,
    );
    expect(() =>
      c.bindSchedulingBaseline({ ...binding, baselineSha256: "7".repeat(64) }),
    ).toThrow(/production75_custody/);
  }));
test("expired custody cannot bind or repeat a baseline", async () => {
  const t = temp();
  let c;
  try {
    let now = Date.now();
    const p = combinedPlan({ ...combinedInput(), preparedAt: now });
    c = await openOperatorCustody({
      root: t.root,
      plan: p,
      ...authority(p),
      now: () => now,
    });
    readyLegacy(c, p);
    finishLegacy(c, "rollback");
    finishLegacy(c, "commit");
    c.bindSchedulingBaseline(binding);
    now = p.workUntil;
    expect(() => c.bindSchedulingBaseline({ ...binding })).toThrow(
      /production75_custody_expired/,
    );
  } finally {
    c?.close();
    t.cleanup();
  }
});
test("each approved plan input changes the bound digest while hidden or hook metadata never executes", () => {
  const raw = combinedInput(),
    base = operatorPlanDigest(combinedPlan(raw));
  const variations = [
    { runId: randomUUID() },
    { backupId: "different_backup" },
    { sourceSnapshotSha256: "0".repeat(64) },
    { profileSha256: "0".repeat(64) },
    { moduleManifestSha256: "0".repeat(64) },
    { preparedAt: raw.preparedAt + 1 },
    { workMs: 91000 },
    { cleanupMs: 31000 },
    { maxCostUsdMicros: 150001 },
    { candidate: { ...candidate, commit: "3".repeat(40) } },
    { candidate: { ...candidate, tree: "3".repeat(40) } },
  ];
  for (const change of variations)
    expect(operatorPlanDigest(combinedPlan({ ...raw, ...change }))).not.toBe(
      base,
    );
  for (let i = 0; i < 2; i++)
    for (const field of [
      "afterCatalogSha256",
      "beforePolicySha256",
      "afterPolicySha256",
    ]) {
      const modified = structuredClone(raw);
      modified.scheduling.layouts[i][field] = "9".repeat(64);
      expect(operatorPlanDigest(combinedPlan(modified))).not.toBe(base);
    }
  let calls = 0;
  const getter = structuredClone(raw);
  Object.defineProperty(getter.candidate, "commit", {
    enumerable: true,
    get() {
      calls++;
      return "1".repeat(40);
    },
  });
  const hidden = structuredClone(raw);
  Object.defineProperty(hidden.scheduling.source, "hidden", { value: 1 });
  const hook = structuredClone(raw);
  hook.scheduling.coverage.toJSON = () => {
    calls++;
    return {};
  };
  for (const value of [
    getter,
    hidden,
    hook,
    new Proxy(raw, {
      ownKeys() {
        calls++;
        return [];
      },
    }),
  ])
    expect(() => combinedPlan(value)).toThrow(/production75_custody/);
  expect(calls).toBe(0);
});

test("plan pins protected identities and a full nonce; input is snapshotted", () => {
  const input = {
      ...planInput(),
      runId: "abcdef01-2345-4678-9abc-def012345678",
    },
    p = prepareOperatorPlan(input);
  input.runId = randomUUID();
  expect(p.copyName).toBe(
    "growthos-drill-abcdef01-2345-4678-9abc-def012345678",
  );
  expect(p.readerName).toBe("growthos-reader-abcdef01234546789abcdef012345678");
  expect(p.readerName).toHaveLength(48);
  expect(p.readerName).toMatch(/^[a-z][a-z0-9-]+$/);
  expect(p.protectedClusters).toEqual(["kzpwm0j18eg04nv3", "zp2wjrejd2zodn4q"]);
  expect(Object.isFrozen(p.protectedClusters)).toBe(true);
});
test("distinct full UUID nonces retain the final bit in Reader identity and plan digest", () => {
  const input = {
      ...planInput(),
      runId: "abcdef01-2345-4678-9abc-def012345678",
    },
    a = prepareOperatorPlan(input),
    b = prepareOperatorPlan({
      ...input,
      runId: "abcdef01-2345-4678-9abc-def012345679",
    });
  expect(b.readerName).toBe("growthos-reader-abcdef01234546789abcdef012345679");
  expect(a.readerName).not.toBe(b.readerName);
  expect(operatorPlanDigest(a)).not.toBe(operatorPlanDigest(b));
});
test.each([
  "ABCDEF01-2345-4678-9abc-def012345678",
  "abcdef01-2345-4678-9abc-def01234567g",
  "abcdef01234546789abcdef012345678",
  "abcdef01-2345-4678-9abc-def01234567",
  null,
  123,
])("invalid UUID %s cannot create a future Reader plan", (runId) => {
  expect(() => prepareOperatorPlan({ ...planInput(), runId })).toThrow(
    /production75_custody_plan/,
  );
});
test("shared pure generator rejects coercible inputs and plan forbids caller-supplied usernames", () => {
  expect(production75ReaderName("abcdef01-2345-4678-9abc-def012345678")).toBe(
    "growthos-reader-abcdef01234546789abcdef012345678",
  );
  for (const value of [
    new String("abcdef01-2345-4678-9abc-def012345678"),
    { toString: () => "abcdef01-2345-4678-9abc-def012345678" },
    null,
  ])
    expect(() => production75ReaderName(value)).toThrow(
      "production75_custody_plan",
    );
  for (const readerName of [
    "growthos_reader_fixture",
    "growthos-reader-abcdef01234546789abcdef012345678",
  ])
    expect(() => prepareOperatorPlan({ ...planInput(), readerName })).toThrow(
      "production75_custody_plan",
    );
});
test.each([
  { workMs: 0 },
  { cleanupMs: 1 },
  { maxCostUsdMicros: 0 },
  { runId: "../escape" },
  { sourceSnapshotSha256: "invalid" },
  { extra: "unreviewed" },
])("invalid/unreviewed plan input %j is refused", (change) => {
  expect(() => prepareOperatorPlan({ ...planInput(), ...change })).toThrow(
    /production75_custody_/,
  );
});
test("missing/boolean/foreign approval refuses custody before writing", async () => {
  const t = temp();
  try {
    const p = prepareOperatorPlan(planInput());
    for (const callbacks of [
      {},
      { ...authority(p), verifyOwnerApproval: async () => true },
      {
        ...authority(p),
        verifyCapabilityReview: async () => ({
          ...(await authority(p).verifyCapabilityReview()),
          planSha256: "f".repeat(64),
        }),
      },
    ])
      await expect(
        openOperatorCustody({ root: t.root, plan: p, ...callbacks }),
      ).rejects.toMatchObject({ safeCode: "production75_custody_admission" });
    expect(fs.readdirSync(t.root)).toEqual([]);
  } finally {
    t.cleanup();
  }
});
test("durable reservation and branded permit prevent replay and forgery", async () => {
  const t = temp();
  let c;
  try {
    const p = prepareOperatorPlan(planInput());
    c = await openOperatorCustody({ root: t.root, plan: p, ...authority(p) });
    c.observeBefore(inventory());
    const permit = c.reserve("copy-create");
    expect(
      consumeOperatorPermit(permit, "copy-create", p.sourceCluster),
    ).toMatchObject({
      planSha256: operatorPlanDigest(p),
      copyName: p.copyName,
    });
    expect(() =>
      consumeOperatorPermit(permit, "copy-create", p.sourceCluster),
    ).toThrow(/production75_custody_permit/);
    expect(() =>
      consumeOperatorPermit({}, "copy-create", p.sourceCluster),
    ).toThrow(/production75_custody_permit/);
    expect(() => c.reserve("copy-create")).toThrow(
      /production75_custody_replay/,
    );
    c.close();
    c = undefined;
    await expect(
      openOperatorCustody({ root: t.root, plan: p, ...authority(p) }),
    ).rejects.toMatchObject({ safeCode: "production75_custody_replay" });
  } finally {
    c?.close();
    t.cleanup();
  }
});
test("protected, existing, attached and same-name foreign copies never become owned", async () => {
  const t = temp();
  let c;
  try {
    const p = prepareOperatorPlan(planInput());
    c = await openOperatorCustody({ root: t.root, plan: p, ...authority(p) });
    c.observeBefore(inventory());
    c.reserve("copy-create");
    for (const change of [
      { id: p.sourceCluster },
      { id: p.protectedClusters[1] },
      { name: "foreign-copy" },
      { organization: "foreign-org" },
      { attachedApps: ["customer-app"] },
    ])
      expect(() =>
        c.bindOwned({ ...metadata("abcdefghijklmnop", p.copyName), ...change }),
      ).toThrow(/production75_custody_ownership/);
    expect(() => c.reserve("copy-delete")).toThrow(
      /production75_custody_phase/,
    );
  } finally {
    c?.close();
    t.cleanup();
  }
});
test("restart is reconciliation-only and cannot recreate or re-delete", async () => {
  const t = temp();
  let c, r;
  try {
    const p = prepareOperatorPlan(planInput());
    c = await openOperatorCustody({ root: t.root, plan: p, ...authority(p) });
    c.observeBefore(inventory());
    c.reserve("copy-create");
    const copy = metadata("abcdefghijklmnop", p.copyName);
    c.bindOwned(copy);
    c.close();
    c = undefined;
    r = await resumeOperatorCustody({ root: t.root, plan: p, ...authority(p) });
    expect(() => r.reserve("reader-create")).toThrow(
      /production75_custody_reconciliation/,
    );
    consumeOperatorPermit(r.reserve("copy-delete"), "copy-delete", copy.id);
    r.close();
    r = undefined;
    const again = await resumeOperatorCustody({
      root: t.root,
      plan: p,
      ...authority(p),
    });
    try {
      expect(() => again.reserve("copy-delete")).toThrow(
        /production75_custody_replay/,
      );
    } finally {
      again.close();
    }
  } finally {
    c?.close();
    r?.close();
    t.cleanup();
  }
});
test("exclusive disk custody refuses original-versus-resume and simultaneous recovery", async () => {
  const t = temp();
  let c, r;
  try {
    const p = prepareOperatorPlan(planInput()),
      args = { root: t.root, plan: p, ...authority(p) };
    c = await openOperatorCustody(args);
    c.observeBefore(inventory());
    c.reserve("copy-create");
    c.bindOwned(metadata("abcdefghijklmnop", p.copyName));
    await expect(resumeOperatorCustody(args)).rejects.toMatchObject({
      safeCode: "production75_custody_busy",
    });
    c.close();
    c = undefined;
    const results = await Promise.allSettled([
      resumeOperatorCustody(args),
      resumeOperatorCustody(args),
    ]);
    expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    expect(results.find((v) => v.status === "rejected").reason.safeCode).toBe(
      "production75_custody_busy",
    );
    r = results.find((v) => v.status === "fulfilled").value;
    consumeOperatorPermit(
      r.reserve("copy-delete"),
      "copy-delete",
      "abcdefghijklmnop",
    );
  } finally {
    c?.close();
    r?.close();
    t.cleanup();
  }
});
test("persisted reservation without a journal row never replays and stale locks are never stolen", async () => {
  const t = temp();
  let c, r;
  try {
    const p = prepareOperatorPlan(planInput()),
      args = { root: t.root, plan: p, ...authority(p) };
    c = await openOperatorCustody(args);
    c.observeBefore(inventory());
    c.reserve("copy-create");
    c.bindOwned(metadata("abcdefghijklmnop", p.copyName));
    const directory = c.status().directory;
    c.close();
    c = undefined;
    fs.writeFileSync(path.join(directory, "reserved-copy-delete"), "");
    r = await resumeOperatorCustody(args);
    expect(() => r.reserve("copy-delete")).toThrow(
      /production75_custody_replay/,
    );
    r.close();
    r = undefined;
    fs.writeFileSync(path.join(directory, "active.lock"), "");
    await expect(resumeOperatorCustody(args)).rejects.toMatchObject({
      safeCode: "production75_custody_busy",
    });
  } finally {
    c?.close();
    r?.close();
    t.cleanup();
  }
});
test("unknown create ownership needs matching fresh clone and unique inventory", async () => {
  const t = temp();
  let c;
  try {
    const p = prepareOperatorPlan(planInput());
    c = await openOperatorCustody({ root: t.root, plan: p, ...authority(p) });
    c.observeBefore(inventory());
    c.reserve("copy-create");
    const copy = metadata("abcdefghijklmnop", p.copyName),
      after = [...inventory(), copy];
    expect(() =>
      c.reconcileOwned(copy, {
        inventoryAfter: after,
        copySourceSnapshotSha256: "0".repeat(64),
      }),
    ).toThrow(/production75_custody_ownership/);
    c.reconcileOwned(copy, {
      inventoryAfter: after,
      copySourceSnapshotSha256: p.sourceSnapshotSha256,
    });
    expect(c.status()).toMatchObject({
      copyId: copy.id,
      ownership: "reconciled-clone",
    });
    expect(() => c.reserve("reader-create")).toThrow(
      /production75_custody_reconciliation/,
    );
    expect(
      consumeOperatorPermit(c.reserve("copy-delete"), "copy-delete", copy.id)
        .copyId,
    ).toBe(copy.id);
  } finally {
    c?.close();
    t.cleanup();
  }
});
test("torn journal refuses reconciliation and exposes no raw file content", async () => {
  const t = temp();
  let c;
  try {
    const p = prepareOperatorPlan(planInput());
    c = await openOperatorCustody({ root: t.root, plan: p, ...authority(p) });
    const directory = c.status().directory;
    c.close();
    c = undefined;
    fs.appendFileSync(
      path.join(directory, "audit.jsonl"),
      "private malformed payload",
    );
    await expect(
      resumeOperatorCustody({ root: t.root, plan: p, ...authority(p) }),
    ).rejects.toMatchObject({ safeCode: "production75_custody_journal" });
  } finally {
    c?.close();
    t.cleanup();
  }
});
test("closing custody invalidates an outstanding mutation permit", async () => {
  const t = temp();
  let c;
  try {
    const p = prepareOperatorPlan(planInput());
    c = await openOperatorCustody({ root: t.root, plan: p, ...authority(p) });
    c.observeBefore(inventory());
    const permit = c.reserve("copy-create");
    c.close();
    expect(() =>
      consumeOperatorPermit(permit, "copy-create", p.sourceCluster),
    ).toThrow(/production75_custody_permit/);
  } finally {
    c?.close();
    t.cleanup();
  }
});
test("work expiry during authentication refuses directory creation", async () => {
  const t = temp();
  try {
    let clock = Date.now();
    const p = prepareOperatorPlan({
        ...planInput(),
        preparedAt: clock,
        workMs: 1000,
      }),
      a = authority(p);
    a.verifyCapabilityReview = async () => {
      clock += 1001;
      return authority(p).verifyCapabilityReview();
    };
    await expect(
      openOperatorCustody({ root: t.root, plan: p, ...a, now: () => clock }),
    ).rejects.toMatchObject({ safeCode: "production75_custody_admission" });
    expect(fs.readdirSync(t.root)).toEqual([]);
  } finally {
    t.cleanup();
  }
});
test("a consumer cannot override the custody deadline with an earlier clock", async () => {
  const t = temp();
  let c;
  try {
    let clock = Date.now();
    const p = prepareOperatorPlan({ ...planInput(), preparedAt: clock });
    c = await openOperatorCustody({
      root: t.root,
      plan: p,
      ...authority(p),
      now: () => clock,
    });
    c.observeBefore(inventory());
    const permit = c.reserve("copy-create");
    clock = p.workUntil + 1;
    expect(() =>
      consumeOperatorPermit(
        permit,
        "copy-create",
        p.sourceCluster,
        () => p.preparedAt,
      ),
    ).toThrow(/production75_custody_permit/);
  } finally {
    c?.close();
    t.cleanup();
  }
});
test("unexpected configuration holds work but cannot strand a positively owned copy", async () => {
  const t = temp();
  let c;
  try {
    const p = prepareOperatorPlan(planInput());
    c = await openOperatorCustody({ root: t.root, plan: p, ...authority(p) });
    c.observeBefore(inventory());
    c.reserve("copy-create");
    const copy = {
      ...metadata("abcdefghijklmnop", p.copyName),
      version: 2,
      region: "ord",
      plan: "startup",
    };
    c.bindOwned(copy);
    expect(() => c.reserve("credentials-writer")).toThrow(
      /production75_custody_suitability/,
    );
    expect(
      consumeOperatorPermit(c.reserve("copy-delete"), "copy-delete", copy.id)
        .copyId,
    ).toBe(copy.id);
  } finally {
    c?.close();
    t.cleanup();
  }
});
test("a coherently rehashed journal cannot turn an original into the owned copy", async () => {
  const t = temp();
  let c;
  try {
    const p = prepareOperatorPlan(planInput());
    c = await openOperatorCustody({ root: t.root, plan: p, ...authority(p) });
    c.observeBefore(inventory());
    c.reserve("copy-create");
    c.bindOwned(metadata("abcdefghijklmnop", p.copyName));
    const directory = c.status().directory;
    c.close();
    c = undefined;
    const file = path.join(directory, "audit.jsonl"),
      rows = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
    rows.find((r) => r.event.kind === "owned").event.copy.id = p.sourceCluster;
    let previous = "0".repeat(64);
    for (const r of rows) {
      r.previous = previous;
      r.sha256 = createHash("sha256")
        .update(
          JSON.stringify({
            sequence: r.sequence,
            previous: r.previous,
            event: r.event,
          }),
        )
        .digest("hex");
      previous = r.sha256;
    }
    fs.writeFileSync(
      file,
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    await expect(
      resumeOperatorCustody({ root: t.root, plan: p, ...authority(p) }),
    ).rejects.toMatchObject({ safeCode: "production75_custody_journal" });
  } finally {
    c?.close();
    t.cleanup();
  }
});
test("selected initial bridge is separately pinned and arbitrary bridge hashes are refused", async () => {
  const t = temp();
  let c;
  try {
    const p = prepareOperatorPlan(planInput());
    c = await openOperatorCustody({ root: t.root, plan: p, ...authority(p) });
    c.observeBefore(inventory());
    c.reserve("copy-create");
    c.bindOwned(metadata("abcdefghijklmnop", p.copyName));
    c.verifyClone(p.sourceSnapshotSha256);
    c.reserve("reader-create");
    c.verifyProfile(p.profileSha256);
    c.reserve("upgrade-rollback");
    expect(() =>
      c.persistSQL("rollback", {
        phase: "step-intent",
        path: "production75-selected-0000",
        sha256: "0".repeat(64),
      }),
    ).toThrow(/production75_custody_shape/);
    expect(() =>
      c.persistSQL("rollback", {
        phase: "step-intent",
        path: "production75-selected-0000",
        sha256:
          "0240348d564b0d88860c4dde838949db8cdee81f13221a6dbf31841feb405a51",
      }),
    ).not.toThrow();
  } finally {
    c?.close();
    t.cleanup();
  }
});
