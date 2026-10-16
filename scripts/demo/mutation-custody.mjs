// Canonical permanent mutation custody. Import/construction performs no IO.
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { canonicalRuntimeOrigin } from "./execution-proof.mjs";
export const CUSTODY_ROOT =
  "C:/Forge/artifacts/growthos-demo-seed-correction-20261016/custody";
const sha = (x) =>
  createHash("sha256")
    .update(Buffer.isBuffer(x) ? x : JSON.stringify(x))
    .digest("hex");
const hex = (x) => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const uuid = (x) =>
  typeof x === "string" &&
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(x);
const codes = new Set([
  "custody_identity",
  "custody_uncertain",
  "mutation_reserved",
]);
export class CustodyHalt extends Error {
  constructor(code) {
    super(codes.has(code) ? code : "custody_uncertain");
    this.code = this.message;
    this.status = "HOLD";
  }
}
const fail = (code) => {
  throw new CustodyHalt(code);
};
export function createMutationCustody({
  plan,
  cplan,
  company,
  runId = null,
  now = Date.now,
  io = { mkdir, open, readFile, readdir },
}) {
  const origin = canonicalRuntimeOrigin(plan.origin),
    runtime =
      plan.target === "local"
        ? `${origin}|${plan.instanceId}`
        : "mogulforge-growthos-staging|zp2wjrejd2zodn4q|growthos_staging";
  if (
    !uuid(cplan.organizationId) ||
    !uuid(
      plan.instanceId ??
        (plan.target === "staging" ? cplan.organizationId : null),
    )
  )
    fail("custody_identity");
  const scope = sha({
      fixturePlan: "growthos-soft-onboarding-20261017",
      runtime,
      organizationId: cplan.organizationId,
      company: company.key,
    }),
    dir = CUSTODY_ROOT + "/" + scope,
    fixtureSha256 = sha(company),
    creationIdentitySha256 = sha({ company, cplan }),
    resources = new Map();
  let poisoned = false,
    begun = false,
    completed = false,
    loaded = false,
    busy = false,
    dispatching = false;
  const parse = (b) => {
    try {
      return JSON.parse(b);
    } catch {
      fail("custody_uncertain");
    }
  };
  const op = ({ kind, key }) => sha({ kind, key });
  async function read(name) {
    try {
      const b = await io.readFile(dir + "/" + name);
      if (b.length > 1000000) fail("custody_uncertain");
      return { bytes: b, value: parse(b) };
    } catch (e) {
      if (e?.code === "ENOENT") return null;
      fail("custody_uncertain");
    }
  }
  async function write(name, value) {
    if (poisoned || busy) fail("custody_uncertain");
    busy = true;
    let h,
      failed = false;
    const b = Buffer.from(JSON.stringify(value) + "\n");
    try {
      h = await io.open(dir + "/" + name, "wx");
      for (let offset = 0; offset < b.length;) {
        const r = await h.write(b, offset, b.length - offset, offset);
        if (
          !Number.isInteger(r?.bytesWritten) ||
          r.bytesWritten <= 0 ||
          r.bytesWritten > b.length - offset
        )
          throw Error();
        offset += r.bytesWritten;
      }
      await h.sync();
    } catch {
      failed = true;
      poisoned = true;
    } finally {
      if (h)
        try {
          await h.close();
        } catch {
          failed = true;
          poisoned = true;
        }
      busy = false;
    }
    if (failed) fail("custody_uncertain");
    return sha(b);
  }
  async function load({ readOnly = false } = {}) {
    if (poisoned) fail("custody_uncertain");
    try {
      await io.mkdir(dir, { recursive: true });
      resources.clear();
      const names = await io.readdir(dir),
        intent = await read("plan.intent.json"),
        done = await read("plan.complete.json");
      if (names.length && !intent) fail("custody_uncertain");
      if (
        intent &&
        (intent.value.scope !== scope ||
          intent.value.fixtureSha256 !== fixtureSha256 ||
          intent.value.creationIdentitySha256 !== creationIdentitySha256)
      )
        fail("custody_identity");
      if (intent && !done && !(readOnly && begun)) fail("mutation_reserved");
      if (
        done &&
        (done.value.scope !== scope ||
          done.value.intentSha256 !== sha(intent.bytes) ||
          done.value.fixtureSha256 !== fixtureSha256)
      )
        fail("custody_uncertain");
      completed = Boolean(done);
      for (const name of names) {
        if (
          !/^(plan\.(intent|complete)|[a-f0-9]{64}\.(intent|ack|binding))\.json$/.test(
            name,
          )
        )
          fail("custody_uncertain");
        if (name.startsWith("plan.")) continue;
        const r = (await read(name)).value;
        if (
          r.scope !== scope ||
          !hex(r.creationRequestSha256 ?? r.requestSha256) ||
          op(r) !== name.split(".")[0]
        )
          fail("custody_uncertain");
        if (name.endsWith(".intent.json")) {
          if (!(await read(name.replace(".intent.json", ".ack.json"))))
            fail("mutation_reserved");
          continue;
        }
        if (!uuid(r.resourceId) || resources.has(r.kind + ":" + r.key))
          fail("custody_uncertain");
        if (name.endsWith(".ack.json")) {
          const original = await read(
            name.replace(".ack.json", ".intent.json"),
          );
          if (
            !original ||
            r.intentSha256 !== sha(original.bytes) ||
            r.creationRequestSha256 !== original.value.requestSha256 ||
            original.value.planIntentSha256 !== sha(intent.bytes) ||
            original.value.scope !== scope ||
            original.value.kind !== r.kind ||
            original.value.key !== r.key
          )
            fail("custody_uncertain");
        }
        resources.set(r.kind + ":" + r.key, r);
      }
      for (const r of resources.values())
        if (r.parentKind) {
          const p = resources.get(r.parentKind + ":" + r.parentKey);
          if (
            !p ||
            p.resourceId !== r.parentResourceId ||
            p.intentSha256 !== r.parentIntentSha256
          )
            fail("custody_uncertain");
        }
      loaded = true;
      return resources;
    } catch (e) {
      poisoned = true;
      if (e instanceof CustodyHalt) throw e;
      fail("custody_uncertain");
    }
  }
  return {
    load,
    resource: (kind, key) =>
      resources.get(kind + ":" + key)?.resourceId ?? null,
    begin: async () => {
      if (!loaded || poisoned) fail("mutation_reserved");
      if (completed) return;
      if (begun) fail("mutation_reserved");
      await write("plan.intent.json", {
        scope,
        fixtureSha256,
        creationIdentitySha256,
        originalRuntime: runtime,
        originalRunId: runId,
        executionProofSha256: plan.executionProofSha256,
        at: new Date(now()).toISOString(),
      });
      begun = true;
    },
    dispatch: async (
      { kind, key, method, pathname, body },
      action,
      idOf,
      beforeDispatch = () => {},
    ) => {
      if (dispatching) {
        poisoned = true;
        fail("mutation_reserved");
      }
      if (!begun || completed || poisoned) fail("mutation_reserved");
      dispatching = true;
      try {
        const name = op({ kind, key });
        if (await read(name + ".intent.json")) fail("mutation_reserved");
        const requestSha256 = sha({ method, pathname, body }),
          planIntent = await read("plan.intent.json"),
          intentSha256 = await write(name + ".intent.json", {
            scope,
            kind,
            key,
            method,
            requestSha256,
            planIntentSha256: sha(planIntent.bytes),
            at: new Date(now()).toISOString(),
          });
        let r;
        try {
          beforeDispatch();
        } catch (e) {
          poisoned = true;
          throw e;
        }
        try {
          r = await action();
        } catch {
          poisoned = true;
          return { status: 0, json: null };
        }
        if (Number.isInteger(r?.status) && r.status >= 200 && r.status < 300) {
          const resourceId = idOf(r);
          if (!uuid(resourceId)) {
            poisoned = true;
            return { status: 0, json: null };
          }
          const record = {
            scope,
            kind,
            key,
            resourceId,
            creationRequestSha256: requestSha256,
            intentSha256,
          };
          await write(name + ".ack.json", record);
          resources.set(kind + ":" + key, record);
        } else poisoned = true;
        return r;
      } finally {
        dispatching = false;
      }
    },
    bindDerived: async (
      kind,
      key,
      resourceId,
      parentKind,
      parentKey,
      identity,
    ) => {
      const parent = resources.get(parentKind + ":" + parentKey);
      if (!parent || !uuid(resourceId) || poisoned || !begun || completed)
        fail("custody_uncertain");
      const old = resources.get(kind + ":" + key);
      if (old) {
        if (old.resourceId !== resourceId) fail("custody_identity");
        return;
      }
      const record = {
        scope,
        kind,
        key,
        resourceId,
        creationRequestSha256: sha(identity),
        parentKind,
        parentKey,
        parentResourceId: parent.resourceId,
        parentIntentSha256: parent.intentSha256,
      };
      await write(op({ kind, key }) + ".binding.json", record);
      resources.set(kind + ":" + key, record);
    },
    complete: async () => {
      if (completed) return;
      if (!begun || poisoned || dispatching) fail("custody_uncertain");
      const original = await read("plan.intent.json");
      await write("plan.complete.json", {
        scope,
        fixtureSha256,
        intentSha256: sha(original.bytes),
      });
      completed = true;
    },
  };
}
