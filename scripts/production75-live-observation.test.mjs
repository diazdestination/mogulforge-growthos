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
} from "./production75-live-observation.mjs";
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
