import { test, expect } from "vitest";
import { deltaFixture } from "./production75-operator-test-support.mjs";
import {
  expectedProduction75ReaderProfile,
  assertProduction75ReaderDelta,
  production75SnapshotDigest,
} from "./production75-reader-delta.mjs";
import {
  projectLiveReader,
  validateSourceSnapshot,
  captureLiveSnapshot,
} from "./production75-live-observation.mjs";
import fs from "node:fs";
import { IDENTITY_SQL } from "./production75-core.mjs";
import { createOperatorResources } from "./production75-operator.mjs";
import {
  production75Diagnostic,
  registerProduction75SafeError,
  withProduction75Stage,
} from "./production75-safe-diagnostics.mjs";
const readCatalog = (p) =>
  JSON.parse(fs.readFileSync(new URL(`../reports/${p}`, import.meta.url)));
const catalogs = {
  fly75: readCatalog("production75-recovery-2026-10-11/catalog75-fly-db.json"),
  other75: readCatalog(
    "production75-recovery-2026-10-11/catalog75-growthos_staging.json",
  ),
  canonical95: readCatalog(
    "staging-observation-2026-10-10/fixtures/catalog-95.json",
  ),
  canonical142: readCatalog(
    "staging-observation-2026-10-10/fixtures/catalog-142.json",
  ),
};
function closingSnapshotFixture({ failObservation, primary }) {
  const resources = createOperatorResources({ until: Date.now() + 10000 });
  const closeFailure = registerProduction75SafeError(
    Error("synthetic private closure"),
    "production75_live_socket",
  );
  let ending;
  const client = {
    query: async (sql) => {
      if (failObservation && sql.startsWith("BEGIN")) throw primary;
      return {
        rows:
          sql === IDENTITY_SQL
            ? [
                {
                  database: "mogulforge-growthos-db",
                  login: "fly-user",
                  role: "schema_admin",
                  version: 160014,
                  pid: 101,
                  isolation: "repeatable read",
                  read_only: "on",
                },
              ]
            : [],
      };
    },
    __driverClose: () => (ending ??= Promise.reject(closeFailure)),
  };
  const transport = {
    openProxy: async () => ({}),
    connect: async () =>
      resources.acquire(
        async () => client,
        (c) => c.__driverClose(),
      ),
  };
  const run = () =>
    withProduction75Stage("legacy-reader-other-databases", () =>
      captureLiveSnapshot({
        transport,
        cluster: "fixture",
        credentials: {},
        resources,
        catalogs,
        databases: ["mogulforge-growthos-db"],
      }),
    );
  return { run, resources, closeFailure };
}
test.each(["error", "undefined", "null", "false", "zero", "empty"])(
  "snapshot closure preserves the exact primary %s and unconfirmed cleanup",
  async (kind) => {
    const primary =
      kind === "error"
        ? Error("synthetic private primary")
        : {
            undefined: undefined,
            null: null,
            false: false,
            zero: 0,
            empty: "",
          }[kind];
    const f = closingSnapshotFixture({ failObservation: true, primary });
    let rejected = false,
      actual;
    try {
      await f.run();
    } catch (error) {
      rejected = true;
      actual = error;
    }
    expect(rejected).toBe(true);
    expect(actual).toBe(primary);
    if (kind === "error")
      expect(production75Diagnostic(actual)).toEqual({
        stage: "legacy-reader-other-databases",
        safeCode: "production75_diagnostic_unknown",
        secondary: {
          stage: "snapshot-close",
          safeCode: "production75_live_socket",
        },
      });
    expect(await f.resources.drain()).toEqual({ closed: false });
  },
);
test("snapshot closure-only failure holds the complete fixed-query observation and never confirms cleanup", async () => {
  const f = closingSnapshotFixture({ failObservation: false });
  await expect(f.run()).rejects.toBe(f.closeFailure);
  expect(production75Diagnostic(f.closeFailure)).toEqual({
    stage: "snapshot-close",
    safeCode: "production75_live_socket",
  });
  expect(await f.resources.drain()).toEqual({ closed: false });
});
test("Reader proposal derives only the already measured group and exact new role", () => {
  const f = deltaFixture(),
    projected = projectLiveReader(
      f.before,
      expectedProduction75ReaderProfile(f.readerName),
    );
  expect(
    assertProduction75ReaderDelta({ ...f, after: projected }),
  ).toMatchObject({
    originalVectorsPreserved: true,
    readerProfileVerified: true,
  });
  for (let i = 0; i < 3; i++) {
    expect(projected.databases[i].catalog).toEqual(
      f.before.databases[i].catalog,
    );
    expect(projected.databases[i].fingerprints).toEqual(
      f.before.databases[i].fingerprints,
    );
  }
  expect(production75SnapshotDigest(f.before)).toBe(
    production75SnapshotDigest(structuredClone(f.before)),
  );
});
test("proposal refuses existing name and source observations with missing group", () => {
  const f = deltaFixture();
  expect(() =>
    projectLiveReader(f.after, expectedProduction75ReaderProfile(f.readerName)),
  ).toThrow(/production75_live_/);
  f.before.databases[0].policy.privileges.roles = [];
  expect(() =>
    projectLiveReader(
      f.before,
      expectedProduction75ReaderProfile(f.readerName),
    ),
  ).toThrow(/production75_live_/);
});
test("source validates all three databases and their actual read-only identities", () => {
  const f = deltaFixture();
  expect(validateSourceSnapshot(f.before)).toBeTruthy();
  f.before.databases[2].identity.login = "foreign";
  expect(() => validateSourceSnapshot(f.before)).toThrow(/production75_live_/);
});
