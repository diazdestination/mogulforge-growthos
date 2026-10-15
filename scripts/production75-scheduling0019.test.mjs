import { beforeAll, test, expect } from "vitest";
import {
  buildScheduling0019Source,
  prepareScheduling0019,
  captureScheduling0019State,
  assertScheduling0019Preserved,
} from "./production75-scheduling0019.mjs";
import {
  makeScheduling0019Fixture,
  withScheduling0019Database,
} from "./production75-scheduling0019-test-support.mjs";
let fixtures;
beforeAll(async () => {
  fixtures = await Promise.all(
    [0, 1].map((layout) => makeScheduling0019Fixture({ layout })),
  );
}, 30000);
const input = (f) => ({
  source: buildScheduling0019Source(f.sourceInput),
  catalogs: f.catalogs,
  target: f.target,
  policyBefore: f.policyBefore,
  policyAfter: f.policyAfter,
  sourceBinding: f.sourceBinding,
});
test.each([0, 1])(
  "exact source and complete layout %i preserve142/1867 through1870 and three NULL additions",
  (layout) => {
    const f = fixtures[layout],
      i = input(f),
      plan = prepareScheduling0019(i);
    expect(i.source.bytes).toBe(8126);
    expect(Object.isFrozen(plan.catalogs.before.columns)).toBe(true);
    expect(f.before.catalog.tables).toHaveLength(142);
    expect(f.before.catalog.columns).toHaveLength(1867);
    expect(f.after.catalog.columns).toHaveLength(1870);
    expect(Object.values(f.after.nullCounts)).toEqual(["0", "0", "0"]);
    expect(() =>
      assertScheduling0019Preserved(f.before, f.after, plan, "post0019"),
    ).not.toThrow();
    expect(() =>
      assertScheduling0019Preserved(f.before, f.before, plan, "pre0019"),
    ).not.toThrow();
    expect(JSON.stringify(plan)).not.toContain("ALTER TABLE");
  },
);
test("source rejects byte drift, CRLF, wrong source/path and unknown keys", () => {
  const f = fixtures[0];
  for (const change of [
    { bytes: Buffer.concat([f.sourceInput.bytes, Buffer.from(" ")]) },
    {
      bytes: Buffer.from(
        f.sourceInput.bytes.toString().replaceAll("\n", "\r\n"),
      ),
    },
    { sourceCommit: "a".repeat(40) },
    { path: "0019.sql" },
    { extra: true },
  ])
    expect(() =>
      buildScheduling0019Source({ ...f.sourceInput, ...change }),
    ).toThrow(/scheduling0019_source/);
  const same = Buffer.from(f.sourceInput.bytes);
  same[100] ^= 1;
  expect(() =>
    buildScheduling0019Source({ ...f.sourceInput, bytes: same }),
  ).toThrow(/scheduling0019_source/);
});
test("closed plan rejects forged source, unknown keys and invalid candidate binding", () => {
  const f = fixtures[0],
    i = input(f);
  for (const changes of [
    { source: { ...i.source } },
    { extra: true },
    {
      sourceBinding: {
        ...i.sourceBinding,
        moduleManifestSha256: "A".repeat(64),
      },
    },
    {
      sourceBinding: {
        ...i.sourceBinding,
        candidate: { ...i.sourceBinding.candidate, commit: "a".repeat(39) },
      },
    },
    { target: { ...i.target, database: "other-db" } },
    {
      target: {
        ...i.target,
        readerLogin: "reader",
        readerRole: "reader",
        principals: ["reader", "fly-user"],
      },
    },
  ])
    expect(() => prepareScheduling0019({ ...i, ...changes })).toThrow(
      /scheduling0019_/,
    );
  expect(() =>
    assertScheduling0019Preserved(
      f.before,
      f.after,
      { ...prepareScheduling0019(i) },
      "post0019",
    ),
  ).toThrow(/scheduling0019_plan/);
});
test("142 count alone, partial schema changes and relaxed checks cannot admit a catalog", () => {
  const f = fixtures[0],
    i = input(f);
  for (const mutate of [
    (c) => {
      c.before.columns[0].ordinal++;
    },
    (c) => {
      c.after.columns.pop();
    },
    (c) => {
      c.after.constraints.find(
        (x) => x.name === "org_settings_scheduling_policy_ck",
      ).definition = "CHECK (true)";
    },
    (c) => {
      c.after.tables[0].name = "pg_authid";
    },
  ]) {
    const catalogs = structuredClone(f.catalogs);
    mutate(catalogs);
    expect(() => prepareScheduling0019({ ...i, catalogs })).toThrow(
      /scheduling0019_catalog/,
    );
  }
});
test("policy validation rejects missing coverage, old ACL changes and added privilege drift", () => {
  const f = fixtures[0],
    i = input(f);
  for (const mutate of [
    (p) => p.privileges.columns.pop(),
    (p) => {
      p.ownership[0].acl = "changed";
    },
    (p) => {
      p.privileges.columns.find((c) => c.name === "scheduling_policy").update =
        true;
    },
  ]) {
    const policyAfter = structuredClone(f.policyAfter);
    mutate(policyAfter);
    expect(() => prepareScheduling0019({ ...i, policyAfter })).toThrow(
      /scheduling0019_policy/,
    );
  }
});
test("state rejects changed value with same count, incomplete/duplicate coverage and unsafe count conversion", () => {
  const f = fixtures[0],
    plan = prepareScheduling0019(input(f));
  for (const mutate of [
    (s) => {
      s.fingerprints.find(
        (x) => x.table === "appointment_work_entries",
      ).digest = "a".repeat(32);
    },
    (s) => s.fingerprints.pop(),
    (s) => {
      s.fingerprints[1] = s.fingerprints[0];
    },
    (s) => {
      s.fingerprints[0].rows = 0;
    },
    (s) => {
      s.fingerprints[0].bytes = "9007199254740993";
    },
    (s) => {
      s.nullCounts["org_settings.scheduling_policy"] = "1";
    },
    (s) => {
      s.extra = true;
    },
  ]) {
    const after = structuredClone(f.after);
    mutate(after);
    expect(() =>
      assertScheduling0019Preserved(f.before, after, plan, "post0019"),
    ).toThrow(/scheduling0019_/);
  }
});
test("fingerprint output order does not change a complete multiset", () => {
  const f = fixtures[0],
    after = structuredClone(f.after);
  after.fingerprints.reverse();
  expect(() =>
    assertScheduling0019Preserved(
      f.before,
      after,
      prepareScheduling0019(input(f)),
      "post0019",
    ),
  ).not.toThrow();
});
test("hidden constructor keys and accessor metadata cannot bypass closed input validation", () => {
  const f = fixtures[0],
    sourceInput = { ...f.sourceInput };
  Object.defineProperty(sourceInput, "hidden", { value: true });
  expect(() => buildScheduling0019Source(sourceInput)).toThrow(
    /scheduling0019_source/,
  );
  const accessor = { ...f.sourceInput };
  Object.defineProperty(accessor, "bytes", {
    enumerable: true,
    get: () => f.sourceInput.bytes,
  });
  expect(() => buildScheduling0019Source(accessor)).toThrow(
    /scheduling0019_source/,
  );
  const i = input(f);
  Object.defineProperty(i, "hidden", { value: true });
  expect(() => prepareScheduling0019(i)).toThrow(/scheduling0019_/);
});
test("nested hidden source-binding and catalog fields remain unknown keys", () => {
  const f = fixtures[0];
  for (const path of [
    "sourceBinding",
    "catalogs",
    "target",
    "policyBefore",
    "policyAfter",
  ]) {
    const i = input(f);
    i[path] = structuredClone(i[path]);
    Object.defineProperty(i[path], "hidden", { value: "unapproved" });
    expect(() => prepareScheduling0019(i)).toThrow(/scheduling0019_/);
  }
});
test("same-server version is retained while exact guarded writer/off observation is accepted", () => {
  const f = fixtures[0],
    plan = prepareScheduling0019(input(f)),
    writer = structuredClone(f.after);
  Object.assign(writer.identity, {
    login: "fly-user",
    role: "schema_admin",
    read_only: "off",
    pid: 43,
  });
  expect(() =>
    assertScheduling0019Preserved(f.before, writer, plan, "post0019"),
  ).not.toThrow();
  writer.identity.version = 160015;
  expect(() =>
    assertScheduling0019Preserved(f.before, writer, plan, "post0019"),
  ).toThrow(/scheduling0019_identity/);
});
test(
  "capture rejects unsafe backend counts before hashing or converting to numbers",
  async () =>
    withScheduling0019Database({}, async (f, { clientFor }) => {
      const plan = prepareScheduling0019(input(f));
      for (const value of ["9007199254740993", -1, 1, "01", "1000001"]) {
        const real = clientFor(),
          client = {
            query: async (sql, args) =>
              sql.includes("AS bytes FROM")
                ? { rows: [{ rows: value, bytes: "1" }] }
                : real.query(sql, args),
          };
        await expect(
          captureScheduling0019State(client, plan),
        ).rejects.toMatchObject({ safeCode: "scheduling0019_fingerprint" });
      }
    }),
  30000,
);
test(
  "real embedded queries catch changed late-stage data and duplicate multiplicity independent of output order",
  async () =>
    withScheduling0019Database({}, async (f, { db, clientFor }) => {
      const plan = prepareScheduling0019(input(f)),
        observed = await captureScheduling0019State(clientFor(), plan);
      expect(() =>
        assertScheduling0019Preserved(f.before, observed, plan, "post0019"),
      ).not.toThrow();
      const reversed = await captureScheduling0019State(
        clientFor("post0019", (sql) =>
          sql.replace(
            'FROM public."appointment_work_entries"',
            'FROM (SELECT * FROM public."appointment_work_entries" ORDER BY id DESC) AS reversed',
          ),
        ),
        plan,
      );
      expect(reversed.fingerprints).toEqual(observed.fingerprints);
      const duplicated = await captureScheduling0019State(
        clientFor("post0019", (sql) =>
          sql.replace(
            'FROM public."appointment_work_entries"',
            `FROM (SELECT * FROM public."appointment_work_entries" WHERE id='00000000-0000-4000-8000-000000000011' UNION ALL SELECT * FROM public."appointment_work_entries" WHERE id='00000000-0000-4000-8000-000000000011') AS duplicates`,
          ),
        ),
        plan,
      );
      const originalEntry = observed.fingerprints.find(
          (x) => x.table === "appointment_work_entries",
        ),
        duplicatedEntry = duplicated.fingerprints.find(
          (x) => x.table === "appointment_work_entries",
        );
      expect(duplicatedEntry.rows).toBe(originalEntry.rows);
      expect(duplicatedEntry.bytes).toBe(originalEntry.bytes);
      expect(duplicatedEntry.digest).not.toBe(originalEntry.digest);
      expect(() =>
        assertScheduling0019Preserved(f.before, duplicated, plan, "post0019"),
      ).toThrow(/scheduling0019_data/);
      await db.exec(
        "UPDATE appointment_work_entries SET notes='changed same row count'",
      );
      const changed = await captureScheduling0019State(clientFor(), plan);
      expect(
        changed.fingerprints.find((x) => x.table === "appointment_work_entries")
          .rows,
      ).toBe("2");
      expect(() =>
        assertScheduling0019Preserved(f.before, changed, plan, "post0019"),
      ).toThrow(/scheduling0019_data/);
    }),
  30000,
);
