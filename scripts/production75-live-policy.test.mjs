import { test, expect } from "vitest";
import { deriveLivePolicies } from "./production75-live-policy.mjs";
const before = {
  ownership: [
    {
      kind: "column",
      schema: "public",
      name: "old",
      sub_name: "id",
      owner: "schema_admin",
      acl: "DEFAULT",
    },
    {
      kind: "relation",
      schema: "public",
      name: "old",
      sub_name: null,
      owner: "schema_admin",
      acl: "DEFAULT",
    },
  ],
  privileges: {
    tables: [
      { principal: "reader", name: "old", owner: "schema_admin", select: true },
    ],
    columns: [
      { principal: "reader", table_name: "old", name: "id", select: true },
    ],
    functions: [
      { principal: "reader", name: "native-provider", execute: true },
    ],
    roles: [{ principal: "reader", name: "reader" }],
  },
};
const next = structuredClone(before);
next.ownership.push({
  kind: "relation",
  schema: "public",
  name: "znew",
  sub_name: null,
  owner: "schema_admin",
  acl: "DEFAULT",
});
next.privileges.tables.push({
  principal: "reader",
  name: "znew",
  owner: "schema_admin",
  select: true,
});
next.privileges.columns.push({
  principal: "reader",
  table_name: "znew",
  name: "id",
  select: true,
});
next.ownership.splice(1, 0, {
  kind: "column",
  schema: "public",
  name: "znew",
  sub_name: "id",
  owner: "schema_admin",
  acl: "DEFAULT",
});
test("only locally observed additive rows merge; actual provider vectors remain", () => {
  const actual = structuredClone(before);
  actual.privileges.functions[0].name = "actual-provider";
  const r = deriveLivePolicies({
    baseline: actual,
    oracle: { 75: before, 95: next, 142: next },
    readerName: "growthos_reader_fixture",
    templateReader: "growthos_reader_fixture",
  });
  expect(r.policy95.privileges.functions).toEqual(actual.privileges.functions);
  expect(r.policy95.privileges.tables).toHaveLength(2);
  expect(r.policy75).toEqual(actual);
});
test.each([
  "changed-old",
  "removed-old",
  "provider-addition",
  "actual-application-drift",
])("oracle refuses %s", (kind) => {
  const actual = structuredClone(before),
    changed = structuredClone(next);
  if (kind === "changed-old") changed.privileges.tables[0].select = false;
  if (kind === "removed-old") changed.ownership.shift();
  if (kind === "provider-addition")
    changed.privileges.functions.push({
      principal: "reader",
      name: "new-side-effect",
      execute: true,
    });
  if (kind === "actual-application-drift")
    actual.privileges.tables[0].owner = "other";
  expect(() =>
    deriveLivePolicies({
      baseline: actual,
      oracle: { 75: before, 95: changed, 142: changed },
      readerName: "growthos_reader_fixture",
      templateReader: "growthos_reader_fixture",
    }),
  ).toThrow(/production75_live_policy/);
});
