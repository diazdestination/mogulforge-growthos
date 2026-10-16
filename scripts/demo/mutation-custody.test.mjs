import { describe, expect, it } from "vitest";
import { createMutationCustody } from "./mutation-custody.mjs";
import {
  FakeGrowthOS,
  fakePlan,
  memoryCustodyFiles,
  fakeExecutionProof,
} from "./fake-growthos-api.mjs";
import * as proofModule from "./execution-proof.mjs";
const { proofHash, validateExecutionProof } = proofModule;
import {
  runCompany,
  seedCompany,
  SeedHalt,
  safeError,
} from "./seed-soft-onboarding.mjs";
const now = () => Date.parse("2026-10-16T18:00:00Z");
function scenario(key = "css", modify = () => {}) {
  const { plan, cplan, company } = fakePlan(key),
    api = new FakeGrowthOS({ company, cplan }),
    io = memoryCustodyFiles();
  modify(io);
  const fresh = () => ({
    call: api.call,
    publicPost: api.publicPost,
    company,
    cplan,
    plan,
    demoDate: plan.demoDate,
    apply: true,
    session: api.session(),
    now,
    quiet: true,
    observe: () => api.observe(),
    custody: createMutationCustody({ plan, cplan, company, io }),
  });
  return { api, plan, cplan, company, io, fresh };
}
describe("canonical mutation custody failure boundaries", () => {
  it.each(["css", "painless"])(
    "%s healthy completion permits only zero-write exact readback on a fresh writer",
    async (key) => {
      const s = scenario(key);
      expect((await runCompany(s.fresh())).status).toBe("APPLIED");
      const before = s.api.writes.length;
      const r = await runCompany(s.fresh());
      expect(r.status).toBe("APPLIED");
      expect(r.readBack.pass).toBe(true);
      expect(s.api.writes.length).toBe(before);
    },
  );
  it.each(["zero", "sync", "close"])(
    "%s intent failure prevents dispatch and remains held across a new writer",
    async (kind) => {
      const s = scenario("css", (io) => {
        const open = io.open;
        io.open = async (...args) => {
          const h = await open(...args);
          if (args[0].endsWith("plan.intent.json")) {
            if (kind === "zero") h.write = async () => ({ bytesWritten: 0 });
            else
              h[kind] = async () => {
                throw Error("SYNTHETIC_PRIVATE_MARKER");
              };
          }
          return h;
        };
      });
      const first = await seedCompany(s.fresh());
      expect(first.status).toBe("HOLD");
      expect(JSON.stringify(first)).not.toContain("PRIVATE");
      expect(s.api.writes).toEqual([]);
      expect((await seedCompany(s.fresh())).status).toBe("HOLD");
      expect(s.api.writes).toEqual([]);
    },
  );
  it.each(["sync", "close"])(
    "ack %s failure after acknowledged effect never permits another mutation",
    async (kind) => {
      const s = scenario("css", (io) => {
        const open = io.open;
        io.open = async (...args) => {
          const h = await open(...args);
          if (args[0].endsWith(".ack.json"))
            h[kind] = async () => {
              throw Error("SYNTHETIC_PRIVATE_MARKER");
            };
          return h;
        };
      });
      const r = await seedCompany(s.fresh());
      expect(r.status).toBe("HOLD");
      expect(r.halt.code).toBe("custody_uncertain");
      expect(s.api.db.contacts).toHaveLength(1);
      const before = s.api.writes.length;
      expect((await seedCompany(s.fresh())).status).toBe("HOLD");
      expect(s.api.writes.length).toBe(before);
    },
  );
  it("all original creation IDs and request identities survive a new writer", async () => {
    const s = scenario();
    expect((await runCompany(s.fresh())).status).toBe("APPLIED");
    const next = s.fresh().custody;
    await next.load({ readOnly: true });
    expect(next.resource("customer", s.company.customers[0].key)).toBe(
      s.api.db.contacts[0].id,
    );
    const records = [...s.io.files.values()].map((b) => JSON.parse(b));
    expect(
      records.some((x) => /^[a-f0-9]{64}$/.test(x.creationRequestSha256 ?? "")),
    ).toBe(true);
    expect(JSON.stringify(records)).not.toContain(s.company.customers[0].email);
  });
  it("UNKNOWN writer cannot append another operation even in the same process", async () => {
    const s = scenario(),
      c = s.fresh().custody;
    await c.load();
    await c.begin();
    await c.dispatch(
      {
        kind: "customer",
        key: "one",
        method: "POST",
        pathname: "/api/v1/contacts",
        body: {},
      },
      async () => ({ status: 0, json: null }),
      () => null,
    );
    let calls = 0;
    await expect(
      c.dispatch(
        {
          kind: "customer",
          key: "two",
          method: "POST",
          pathname: "/api/v1/contacts",
          body: {},
        },
        async () => {
          calls++;
          return { status: 201 };
        },
        () => null,
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it("an overlapping operation poisons the writer without a second dispatch", async () => {
    const s = scenario(),
      c = s.fresh().custody;
    await c.load();
    await c.begin();
    let release, start;
    const started = new Promise((resolve) => (start = resolve)),
      first = c.dispatch(
        {
          kind: "customer",
          key: "one",
          method: "POST",
          pathname: "/api/v1/contacts",
          body: {},
        },
        () =>
          new Promise((resolve) => {
            release = resolve;
            start();
          }),
        (r) => r.json.id,
      );
    await started;
    let calls = 0;
    const refused = await c
      .dispatch(
        {
          kind: "customer",
          key: "two",
          method: "POST",
          pathname: "/api/v1/contacts",
          body: {},
        },
        async () => {
          calls++;
          return { status: 0, json: null };
        },
        () => null,
      )
      .then(
        () => false,
        () => true,
      );
    release({ status: 201, json: { id: s.cplan.staff.owner } });
    await first.catch(() => {});
    expect(refused).toBe(true);
    expect(calls).toBe(0);
    await expect(c.complete()).rejects.toThrow();
  });
  it("a forged code-shaped deliberate stop is still redacted", () => {
    expect(
      safeError(new SeedHalt("HOLD", "SYNTHETIC_SECRET_MARKER_7A", "private")),
    ).toEqual({ status: "ERROR", code: "unexpected" });
  });
  it.each(["ack", "binding"])(
    "tampered %s creation custody cannot be reused",
    async (type) => {
      const s = scenario();
      expect((await runCompany(s.fresh())).status).toBe("APPLIED");
      const entry = [...s.io.files.keys()].find((x) =>
          x.endsWith(`.${type}.json`),
        ),
        record = JSON.parse(s.io.files.get(entry));
      if (type === "ack") record.creationRequestSha256 = "0".repeat(64);
      else record.parentIntentSha256 = "0".repeat(64);
      s.io.files.set(entry, Buffer.from(JSON.stringify(record) + "\n"));
      const before = s.api.writes.length;
      expect((await seedCompany(s.fresh())).status).toBe("HOLD");
      expect(s.api.writes.length).toBe(before);
    },
  );
});
describe("fresh ROOT proof and runtime cutoff", () => {
  function stage() {
    const p = fakePlan().plan;
    p.target = "staging";
    p.origin = "https://mogulforge-growthos-staging.fly.dev";
    p.release = {
      sha: "a".repeat(40),
      builtAt: "2026-10-16T17:59:00.000Z",
      environment: "staging",
    };
    p.instanceId = null;
    p.executionProof = fakeExecutionProof(p);
    p.executionProofSha256 = proofHash(p.executionProof);
    return p;
  }
  it("requires exact ROOT deployment/catalog/holds and real absolute cap/task cutoff", () => {
    const p = stage();
    expect(() => validateExecutionProof(p, now())).not.toThrow();
    for (const change of [
      (x) => (x.schema.database = "production"),
      (x) => (x.schema.catalogSha256 = "bad"),
      (x) => (x.app = "mogulforge-growthos"),
      (x) => (x.machine = "other"),
      (x) => (x.holds.outbound = false),
      (x) => (x.runtime.capSeconds = 20000),
      (x) => (x.runtime.stopAt = "2026-10-18T04:00:00Z"),
      (x) => (x.observedAt = "2026-10-16T17:54:59Z"),
    ]) {
      const q = stage();
      change(q.executionProof);
      q.executionProofSha256 = proofHash(q.executionProof);
      expect(() => validateExecutionProof(q, now())).toThrow();
    }
  });
  it("source/frontend substitution in actual application observation prevents every mutation", async () => {
    const s = scenario(),
      args = s.fresh();
    args.observe = async () => ({
      ...s.api.observe(),
      frontendIndexSha256: "0".repeat(64),
    });
    const r = await seedCompany(args);
    expect(r.status).toBe("BLOCKED");
    expect(s.api.writes).toEqual([]);
  });
  it("proof expiring during the last session GET is checked again after durable intent and before POST", async () => {
    const s = scenario(),
      args = s.fresh();
    let clock = now(),
      me = 0;
    args.now = () => clock;
    s.api.fault("GET", /^\/api\/v1\/me$/, () => {
      if (++me === 2) clock += 6 * 60000;
      return null;
    });
    const r = await seedCompany(args);
    expect(r.status).toBe("BLOCKED");
    expect(r.halt.code).toBe("execution_proof_expired");
    expect(s.api.writes).toEqual([]);
    expect((await seedCompany(s.fresh())).status).toBe("HOLD");
  });
  it("eligibility changing after admission blocks the first dispatch", async () => {
    const s = scenario();
    let reads = 0;
    s.api.fault("GET", /^\/api\/v1\/users$/, () => {
      if (++reads > 1) s.api.users[1].operationallyEligible = false;
      return null;
    });
    const r = await seedCompany(s.fresh());
    expect(r.status).toBe("BLOCKED");
    expect(r.halt.code).toBe("staff_unverified");
    expect(s.api.writes).toEqual([]);
  });
  it("frontend fingerprint consumes only bounded successful bytes and never error bodies", async () => {
    expect(typeof proofModule.fingerprintFrontend).toBe("function");
    const response = (bytes) => ({
      status: 200,
      body: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    });
    expect(
      await proofModule.fingerprintFrontend(
        response(Buffer.from("fixture frontend")),
      ),
    ).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      proofModule.fingerprintFrontend(response(new Uint8Array(2_000_001))),
    ).rejects.toThrow("execution_observation_missing");
    await expect(
      proofModule.fingerprintFrontend({ status: 503, body: null }),
    ).rejects.toThrow("execution_observation_missing");
  });
  it("ROOT proof cannot carry extra raw provider or secret-bearing fields into receipts", () => {
    const p = stage();
    p.executionProof.rawProvider = { password: "SYNTHETIC_MARKER" };
    p.executionProofSha256 = proofHash(p.executionProof);
    expect(() => validateExecutionProof(p, now())).toThrow();
  });
  it("a local proof cannot be relabeled onto the hosted staging origin", () => {
    const p = fakePlan().plan;
    p.origin = "https://mogulforge-growthos-staging.fly.dev";
    p.executionProof.origin = p.origin;
    p.executionProofSha256 = proofHash(p.executionProof);
    expect(() => validateExecutionProof(p, now())).toThrow();
  });
});
