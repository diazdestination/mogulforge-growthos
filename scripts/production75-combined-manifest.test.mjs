import { beforeAll, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as manifest from "./production75-live-manifest.mjs";
import { PINNED_FILES, SOURCE_COMMIT } from "./production75-pins.mjs";
import { buildProduction75Source } from "./production75-source.mjs";
import { buildScheduling0019Source } from "./production75-scheduling0019.mjs";
import { makeScheduling0019Fixture } from "./production75-scheduling0019-test-support.mjs";
const root = new URL("../", import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const git = (commit, p) =>
  execFileSync("git", ["show", `${commit}:${p}`], {
    maxBuffer: 200000,
    windowsHide: true,
  });
const digest = (input) => {
  if (!manifest.combinedManifestDigest) throw Error("not_implemented");
  return manifest.combinedManifestDigest(input);
};
let input, sourceInput;
beforeAll(async () => {
  const fixtures = await Promise.all([
    makeScheduling0019Fixture({ layout: 0 }),
    makeScheduling0019Fixture({ layout: 1 }),
  ]);
  sourceInput = fixtures[0].sourceInput;
  const legacy = buildProduction75Source(
    PINNED_FILES.map((pin) => ({
      path: pin.path,
      bytes: git(SOURCE_COMMIT, pin.path),
    })),
  );
  const { sql: _, ...schedulingSource } =
    buildScheduling0019Source(sourceInput);
  input = {
    modules: manifest.production75RuntimeHashes(() => "runtime\n"),
    legacySource: {
      sourceCommit: legacy.sourceCommit,
      sourceFiles: legacy.sourceFiles,
      steps: legacy.steps.map(({ sql, ...d }) => d),
    },
    schedulingSource,
    catalogs: {
      legacy: {
        fly75: read(
          "reports/production75-recovery-2026-10-11/catalog75-fly-db.json",
        ),
        other75: read(
          "reports/production75-recovery-2026-10-11/catalog75-growthos_staging.json",
        ),
        canonical95: read(
          "reports/staging-observation-2026-10-10/fixtures/catalog-95.json",
        ),
        canonical142: read(
          "reports/staging-observation-2026-10-10/fixtures/catalog-142.json",
        ),
      },
      scheduling: fixtures.map((f) => f.catalogs),
    },
    oracle: {
      kind: "OWNED_NATIVE_COMBINED_POLICY_ORACLE",
      candidate: {
        repository: "diazdestination/mogulforge-growthos",
        commit: "1".repeat(40),
        tree: "2".repeat(40),
      },
      legacy: {
        kind: "OWNED_NATIVE_POLICY_ORACLE",
        sourceCandidate: "8df64dc72009832f93b2b491031acd1bb2afb903",
        templateReader: "production75-reader",
        policies: Object.fromEntries(
          [75, 95, 142].map((n) => [
            n,
            read(
              "reports/production75-recovery-2026-10-11/local-policy-fly-db.json",
            )["policy" + n],
          ]),
        ),
      },
      scheduling: {
        source: schedulingSource,
        layouts: fixtures.map((f) => ({
          templateReader: f.target.readerLogin,
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
    },
    candidate: {
      repository: "diazdestination/mogulforge-growthos",
      commit: "1".repeat(40),
      tree: "2".repeat(40),
    },
  };
}, 30000);
test("shared local and native callers hash identical acyclic inputs identically", () => {
  console.info(
    "task-4 compact full aggregate input bytes",
    Buffer.byteLength(JSON.stringify(input)),
  );
  expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(8000000);
  expect(digest(input)).toMatch(/^[a-f0-9]{64}$/);
  expect(digest(structuredClone(input))).toBe(digest(input));
});
test("every runtime dependency contributes, including the exact scheduling pair without helper code", () => {
  const base = digest(input);
  for (const p of manifest.PRODUCTION75_RUNTIME_FILES) {
    const changed = {
      ...input,
      modules: { ...input.modules, [p]: "0".repeat(64) },
    };
    expect(digest(changed)).not.toBe(base);
  }
  expect(
    Object.keys(input.modules).filter((p) => p.includes("scheduling0019")),
  ).toEqual([
    "scripts/production75-scheduling0019.mjs",
    "scripts/production75-scheduling0019-observer.mjs",
  ]);
  expect(() =>
    digest({
      ...input,
      modules: {
        ...input.modules,
        "scripts/production75-scheduling0019-test-support.mjs": "0".repeat(64),
      },
    }),
  ).toThrow(/production75_combined_manifest/);
}, 30000);
test("each catalog, oracle and reviewed candidate identity contributes to the aggregate", () => {
  const base = digest(input);
  for (const key of Object.keys(input.catalogs.legacy)) {
    const catalogs = structuredClone(input.catalogs);
    catalogs.legacy[key].tables[0].row_security =
      !catalogs.legacy[key].tables[0].row_security;
    expect(digest({ ...input, catalogs })).not.toBe(base);
  }
  for (let i = 0; i < 2; i++) {
    const catalogs = structuredClone(input.catalogs);
    catalogs.scheduling[i].after.columns[0].nullable =
      !catalogs.scheduling[i].after.columns[0].nullable;
    expect(digest({ ...input, catalogs })).not.toBe(base);
  }
  expect(
    digest({
      ...input,
      oracle: {
        ...input.oracle,
        legacy: { ...input.oracle.legacy, templateReader: "changed-reader" },
      },
    }),
  ).not.toBe(base);
  for (const field of ["commit", "tree"])
    expect(
      digest({
        ...input,
        candidate: { ...input.candidate, [field]: "3".repeat(40) },
      }),
    ).not.toBe(base);
});
test("runtime newline normalization never licenses altered exact SQL bytes or descriptors", () => {
  expect(manifest.production75RuntimeHashes(() => "a\r\nb\r\n")).toEqual(
    manifest.production75RuntimeHashes(() => "a\nb\n"),
  );
  expect(() =>
    buildScheduling0019Source({
      ...sourceInput,
      bytes: Buffer.from(sourceInput.bytes.toString().replaceAll("\n", "\r\n")),
    }),
  ).toThrow(/source_drift/);
  for (const field of ["sha256", "bytes", "sourceCommit", "path"]) {
    const source = {
      ...input.schedulingSource,
      [field]: field === "bytes" ? 8127 : "0".repeat(64),
    };
    expect(() => digest({ ...input, schedulingSource: source })).toThrow(
      /production75_combined_manifest/,
    );
  }
  const legacySource = structuredClone(input.legacySource);
  legacySource.steps[0].sha256 = "0".repeat(64);
  expect(() => digest({ ...input, legacySource })).toThrow(
    /production75_combined_manifest/,
  );
}, 30000);
test("every original SQL descriptor remains exact and both scheduling before catalogs retain their ordered admission", () => {
  for (const section of ["sourceFiles", "steps"])
    for (let i = 0; i < 19; i++) {
      const legacySource = structuredClone(input.legacySource);
      legacySource[section][i].sha256 = "0".repeat(64);
      expect(() => digest({ ...input, legacySource })).toThrow(
        /production75_combined_manifest/,
      );
    }
  for (let i = 0; i < 2; i++) {
    const catalogs = structuredClone(input.catalogs);
    catalogs.scheduling[i].before.columns[0].nullable =
      !catalogs.scheduling[i].before.columns[0].nullable;
    expect(() => digest({ ...input, catalogs })).toThrow(
      /production75_combined_manifest/,
    );
  }
  expect(() =>
    digest({
      ...input,
      catalogs: {
        ...input.catalogs,
        scheduling: [...input.catalogs.scheduling].reverse(),
      },
    }),
  ).toThrow(/production75_combined_manifest/);
}, 60000);
test("oversized scalar or key material is refused before aggregate serialization", () => {
  expect(() =>
    digest({ ...input, oracle: { measurement: "x".repeat(32000001) } }),
  ).toThrow(/production75_combined_manifest/);
  expect(() =>
    digest({ ...input, oracle: { ["k".repeat(32000001)]: true } }),
  ).toThrow(/production75_combined_manifest/);
}, 30000);
test.each([
  "moduleManifestSha256",
  "combinedManifestSha256",
  "combinedManifestDigest",
  "proofSha256",
  "proofDigest",
  "aggregateSha256",
  "manifest",
])(
  "self-referential oracle digest %s is rejected",
  (key) => {
    expect(() =>
      digest({
        ...input,
        oracle: { ...input.oracle, nested: { [key]: "a".repeat(64) } },
      }),
    ).toThrow(/production75_combined_manifest/);
  },
  30000,
);
test("hidden keys, accessors, proxies, hooks, circular payloads and unknown containers fail before invoking caller code", () => {
  let calls = 0;
  const hook = {
    toJSON() {
      calls++;
      return {};
    },
  };
  const getter = {};
  Object.defineProperty(getter, "value", {
    enumerable: true,
    get() {
      calls++;
      return 1;
    },
  });
  const hidden = {};
  Object.defineProperty(hidden, "secret", { value: "ignored" });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        calls++;
        return [];
      },
    },
  );
  const circular = {};
  circular.self = circular;
  for (const oracle of [hook, getter, hidden, proxy, circular])
    expect(() => digest({ ...input, oracle })).toThrow(
      /production75_combined_manifest/,
    );
  expect(calls).toBe(0);
  expect(() => digest({ ...input, ownDigest: "a".repeat(64) })).toThrow(
    /production75_combined_manifest/,
  );
  expect(() =>
    digest({
      ...input,
      schedulingSource: { ...input.schedulingSource, sql: "private SQL body" },
    }),
  ).toThrow(/production75_combined_manifest/);
}, 30000);
