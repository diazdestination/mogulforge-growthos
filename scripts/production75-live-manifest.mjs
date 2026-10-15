/** Shared full executable dependency coverage. Supplied reads only, import-safe. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual, types } from "node:util";
import { PINNED_FILES, SOURCE_COMMIT } from "./production75-pins.mjs";
import { catalogDigest } from "../reports/release-preparation-2026-10-09/schema-catalog.mjs";
export const PRODUCTION75_RUNTIME_FILES = Object.freeze([
  ...[
    "live-manifest",
    "live-transport",
    "live-observation",
    "live-policy",
    "live-local",
    "live-admission",
    "live-runner",
    "operator",
    "custody",
    "reader-delta",
    "fly-v1",
    "observer",
    "verification",
    "scheduling0019",
    "scheduling0019-observer",
    "core",
    "legacy-model",
    "source",
    "pins",
    "local",
  ].map((name) => `scripts/production75-${name}.mjs`),
  "scripts/local-dev.mjs",
  "scripts/staging-observation-core.mjs",
  "reports/release-preparation-2026-10-09/schema-catalog.mjs",
  "pnpm-lock.yaml",
  "artifacts/api-server/package.json",
]);
export function production75RuntimeHashes(readText) {
  if (typeof readText !== "function")
    throw new Error("production75_live_manifest");
  return Object.fromEntries(
    PRODUCTION75_RUNTIME_FILES.map((p) => [
      p,
      createHash("sha256")
        .update(readText(p).replaceAll("\r\n", "\n"))
        .digest("hex"),
    ]),
  );
}

const check = (ok) => {
  if (!ok)
    throw Object.assign(Error("production75_combined_manifest"), {
      safeCode: "production75_combined_manifest",
    });
};
const exact = (o, names) =>
  o &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  Object.keys(o).length === names.length &&
  names.every((k) => Object.hasOwn(o, k));
const hex = (v, n) =>
  typeof v === "string" && new RegExp(`^[a-f0-9]{${n}}$`).test(v);
// Snapshot DATA descriptors before reading values; no getters, hooks or proxies.
function snapshot(input) {
  let nodes = 0,
    bytes = 0;
  const seen = new Set();
  function copy(v, depth = 0) {
    check(++nodes <= 2000000 && depth <= 40);
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") {
      bytes += Buffer.byteLength(v);
      check(bytes <= 32000000);
      return v;
    }
    if (typeof v === "number") {
      check(Number.isSafeInteger(v));
      return v;
    }
    check(v && typeof v === "object" && !types.isProxy(v) && !seen.has(v));
    seen.add(v);
    const array = Array.isArray(v);
    check(
      Object.getPrototypeOf(v) === (array ? Array.prototype : Object.prototype),
    );
    const result = array ? [] : {};
    const own = Reflect.ownKeys(v);
    check(own.length <= 100000);
    for (const k of own) {
      if (array && k === "length") continue;
      const d = Object.getOwnPropertyDescriptor(v, k);
      check(
        typeof k === "string" &&
          k !== "__proto__" &&
          d.enumerable &&
          Object.hasOwn(d, "value") &&
          (!array || /^(0|[1-9][0-9]*)$/.test(k)),
      );
      bytes += Buffer.byteLength(k) + 4;
      check(bytes <= 32000000);
      result[k] = copy(d.value, depth + 1);
    }
    if (array) check(own.length === v.length + 1 && result.length === v.length);
    seen.delete(v);
    return result;
  }
  return copy(input);
}
function noSelfDigest(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    check(
      !/(?:manifest|proof|aggregate).*(?:sha256|digest|hash)/i.test(key) &&
        !/^(?:modules|moduleHashes|currentHashes|proof|aggregate|(?:module|combined)?manifest)$/i.test(
          key,
        ),
    );
    noSelfDigest(item);
  }
}
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
const LEGACY_STEPS = [
  {
    path: "production75-selected-0000",
    sha256: "0240348d564b0d88860c4dde838949db8cdee81f13221a6dbf31841feb405a51",
    bytes: 18039,
  },
  ...PINNED_FILES.slice(1),
];
const sha = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const catalogHash = (c) => {
  check(
    exact(c, [
      "formatVersion",
      "tables",
      "columns",
      "constraints",
      "indexes",
      "enums",
      "triggers",
      "policies",
    ]) &&
      c.formatVersion === 1 &&
      Object.entries(c).every(
        ([k, v]) => k === "formatVersion" || Array.isArray(v),
      ),
  );
  return catalogDigest(c, { physical: true });
};
// Only independent payload bytes enter this hash. Finished proof/aggregate values
// are validated by admission and never enter the payload they attest to.
export function combinedManifestDigest(input) {
  const p = snapshot(input);
  check(
    exact(p, [
      "modules",
      "legacySource",
      "schedulingSource",
      "catalogs",
      "oracle",
      "candidate",
    ]),
  );
  const {
    modules,
    legacySource,
    schedulingSource,
    catalogs,
    oracle,
    candidate,
  } = p;
  check(
    exact(modules, PRODUCTION75_RUNTIME_FILES) &&
      PRODUCTION75_RUNTIME_FILES.every((k) => hex(modules[k], 64)),
  );
  check(
    exact(candidate, ["repository", "commit", "tree"]) &&
      candidate.repository === "diazdestination/mogulforge-growthos" &&
      hex(candidate.commit, 40) &&
      hex(candidate.tree, 40),
  );
  check(
    exact(legacySource, ["sourceCommit", "sourceFiles", "steps"]) &&
      legacySource.sourceCommit === SOURCE_COMMIT &&
      isDeepStrictEqual(legacySource.sourceFiles, PINNED_FILES) &&
      isDeepStrictEqual(legacySource.steps, LEGACY_STEPS),
  );
  check(isDeepStrictEqual(schedulingSource, DELTA));
  check(
    exact(catalogs, ["legacy", "scheduling"]) &&
      exact(catalogs.legacy, [
        "fly75",
        "other75",
        "canonical95",
        "canonical142",
      ]) &&
      Array.isArray(catalogs.scheduling) &&
      catalogs.scheduling.length === 2,
  );
  const legacy = ["fly75", "other75", "canonical95", "canonical142"].map(
    (k) => [k, catalogHash(catalogs.legacy[k])],
  );
  const scheduling = catalogs.scheduling.map((c, i) => {
    check(exact(c, ["before", "after"]));
    const before = catalogHash(c.before),
      after = catalogHash(c.after);
    check(before === PRE[i]);
    return { before, after };
  });
  check(oracle && typeof oracle === "object" && !Array.isArray(oracle));
  noSelfDigest(oracle);
  // Oracle object key insertion is immaterial; catalog physical order and source
  // descriptor order remain their explicit established contracts.
  const canonical = (v) =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical(v[k])]),
          )
        : v;
  return sha({
    kind: "PRODUCTION75_SCHEDULING0019_MANIFEST_V2",
    modules: PRODUCTION75_RUNTIME_FILES.map((k) => [k, modules[k]]),
    legacySource: {
      sourceCommit: SOURCE_COMMIT,
      sourceFiles: PINNED_FILES,
      steps: LEGACY_STEPS,
    },
    schedulingSource: DELTA,
    catalogs: { legacy, scheduling },
    oracle: canonical(oracle),
    candidate: {
      repository: candidate.repository,
      commit: candidate.commit,
      tree: candidate.tree,
    },
  });
}
