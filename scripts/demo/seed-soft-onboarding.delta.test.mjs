import { describe, expect, it } from "vitest";
import {
  FakeGrowthOS,
  fakePlan,
  fakeExecutionProof,
} from "./fake-growthos-api.mjs";
import { proofHash } from "./execution-proof.mjs";
import { DEMO_DATE } from "./demo-data.mjs";
import {
  lockPath,
  planFromExecutionManifest,
  planFromLocalManifest,
  runCompany,
  safeBrief,
  safeError,
  seedCompany,
  STAGING_ORIGIN,
} from "./seed-soft-onboarding.mjs";
const custodyModule = await import("./mutation-custody.mjs").catch(() => ({}));
const proofModule = await import("./execution-proof.mjs").catch(() => ({}));
const NOW = () => Date.parse("2026-10-16T18:00:00Z");
export function memoryFiles() {
  const files = new Map();
  const missing = () => Object.assign(Error("missing"), { code: "ENOENT" });
  return {
    files,
    mkdir: async () => {},
    readdir: async (dir) =>
      [...files.keys()]
        .filter((k) => k.startsWith(dir + "/"))
        .map((k) => k.slice(dir.length + 1)),
    readFile: async (p) => {
      if (!files.has(p)) throw missing();
      return Buffer.from(files.get(p));
    },
    open: async (p, flag) => {
      if (flag !== "wx" || files.has(p))
        throw Object.assign(Error("exists"), { code: "EEXIST" });
      files.set(p, Buffer.alloc(0));
      return {
        write: async (bytes, offset, length, position) => {
          const count = Math.min(37, length);
          const out = Buffer.alloc(
            Math.max(files.get(p).length, position + count),
          );
          files.get(p).copy(out);
          bytes.copy(out, position, offset, offset + count);
          files.set(p, out);
          return { bytesWritten: count };
        },
        sync: async () => {},
        close: async () => {},
      };
    },
  };
}
function setup() {
  const { company, cplan, plan } = fakePlan("css"),
    api = new FakeGrowthOS({ company, cplan }),
    io = memoryFiles();
  const args = {
    call: api.call,
    publicPost: api.publicPost,
    company,
    cplan,
    plan,
    demoDate: DEMO_DATE,
    apply: true,
    session: api.session(),
    now: NOW,
    quiet: true,
    observe: () => api.observe?.(),
  };
  const fresh = () => {
    args.custody = custodyModule.createMutationCustody?.({
      plan,
      cplan,
      company,
      io,
    });
    return { ...args };
  };
  return { api, args, io, fresh, plan, cplan, company };
}
describe("remaining demo review counterexamples", () => {
  it("missing operational eligibility cannot pass", async () => {
    const s = setup();
    delete s.api.users[1].operationallyEligible;
    const r = await seedCompany(s.fresh());
    expect(r.status).toBe("BLOCKED");
    expect(s.api.writes).toEqual([]);
  });
  it("schema-free staging manifest cannot be accepted", () => {
    const s = setup(),
      m = {
        kind: "growthos-soft-onboarding-execution-manifest",
        target: "staging",
        origin: STAGING_ORIGIN,
        demoDate: DEMO_DATE,
        reviewedBy: "ROOT",
        reviewedAt: "2026-10-16T18:00:00Z",
        release: { sha: "a".repeat(40), environment: "staging" },
        holds: {
          outboundHold: true,
          communicationsEnabled: false,
          schedulerAutostart: false,
          evidence: "statement",
          verifiedAt: "2026-10-16T18:00:00Z",
        },
        companies: { css: s.cplan },
      };
    expect(() =>
      planFromExecutionManifest(m, {
        origin: STAGING_ORIGIN,
        keys: ["css"],
        now: NOW(),
      }),
    ).toThrow();
  });
  it("lost response plus delayed visibility remains reserved across a fresh writer with zero second POST", async () => {
    const s = setup();
    let posts = 0,
      first = true,
      pending;
    const call = s.api.call;
    s.args.call = async (method, p, body) => {
      if (method === "POST" && p === "/api/v1/contacts") posts++;
      return call(method, p, body);
    };
    s.api.fault("POST", /^\/api\/v1\/contacts$/, (_p, body) => {
      if (first) {
        first = false;
        pending = body;
        return { status: 0, json: null };
      }
      return null;
    });
    expect((await seedCompany(s.fresh())).status).toBe("UNKNOWN");
    const before = posts;
    expect(pending).toBeTruthy();
    const second = await seedCompany(s.fresh());
    expect(second.status).toBe("HOLD");
    expect(posts).toBe(before);
  });
  it("local aliases share the same canonical runtime claim", () => {
    expect(lockPath("fixed", "http://localhost:4192", "org", "instance")).toBe(
      lockPath("fixed", "http://127.0.0.1:4192", "org", "instance"),
    );
  });
  it("edited contact email preserves its original ID and holds instead of creating another contact/property", async () => {
    const s = setup();
    expect((await runCompany(s.fresh())).status).toBe("APPLIED");
    const old = s.api.db.contacts[0].id;
    s.api.db.contacts[0].email = "edited@example.invalid";
    const before = s.api.writes.length;
    const r = await seedCompany(s.fresh());
    expect(r.status).toBe("HOLD");
    expect(r.halt.code).toBe("fixture_conflict");
    expect(s.api.db.contacts.filter((x) => x.id === old)).toHaveLength(1);
    expect(s.api.writes.length).toBe(before);
  });
  it("edited task title cannot lose fixture ownership", async () => {
    const s = setup();
    expect((await runCompany(s.fresh())).status).toBe("APPLIED");
    s.api.db.tasks[0].title = "Edited by staff";
    const before = s.api.writes.length;
    expect((await seedCompany(s.fresh())).status).toBe("HOLD");
    expect(s.api.writes.length).toBe(before);
  });
  it.each(["issuerName", "dueDate", "notes", "issuerAddress"])(
    "edited invoice %s holds before issue or payment",
    async (field) => {
      const s = setup();
      expect((await runCompany(s.fresh())).status).toBe("APPLIED");
      const inv = s.api.db.invoices.find((x) => x.status === "issued");
      inv.status = "draft";
      inv.document[field] = field === "dueDate" ? "2026-12-31" : "Staff edit";
      const before = s.api.writes.length;
      const r = await seedCompany(s.fresh());
      expect(r.status).toBe("HOLD");
      expect(r.halt.code).toBe("fixture_conflict");
      expect(r.records.at(-1).detail).toContain(field);
      expect(s.api.writes.length).toBe(before);
    },
  );
  it("code-shaped markers and arbitrary exception class names never escape", () => {
    const marker = "SYNTHETIC_SECRET_MARKER_7A";
    expect(safeBrief({ status: 400, json: { code: marker } })).toBe("HTTP 400");
    expect(
      JSON.stringify(
        safeError({ name: marker, code: marker, message: marker }),
      ),
    ).not.toContain(marker);
  });
  it("proof boundary requires real pinned shape and rejects stale or substituted identity", () => {
    expect(typeof proofModule.validateExecutionProof).toBe("function");
    const s = setup();
    const p = s.plan.executionProof;
    expect(() =>
      proofModule.validateExecutionProof(s.plan, NOW()),
    ).not.toThrow();
    for (const mutate of [
      (x) => delete x.executionProof,
      (x) => (x.executionProof.observedAt = "2026-10-16T17:00:00Z"),
      (x) => (x.executionProof.schema.database = "production"),
      (x) => (x.executionProof.frontendIndexSha256 = "bad"),
    ]) {
      const bad = structuredClone(s.plan);
      mutate(bad);
      expect(() => proofModule.validateExecutionProof(bad, NOW())).toThrow();
    }
    expect(p).toBeTruthy();
  });
  it("one selected company keeps the full runtime fixture binding without requiring a second proof", () => {
    const css = fakePlan("css"),
      painless = fakePlan("painless"),
      plan = {
        ...css.plan,
        companies: { css: css.cplan, painless: painless.cplan },
      };
    const proof = fakeExecutionProof(plan);
    const manifest = {
      kind: "growthos-soft-onboarding-local-manifest",
      origin: plan.origin,
      port: 4192,
      instanceId: plan.instanceId,
      holds: {
        COMMUNICATIONS_ENABLED: "false",
        GROWTHOS_OUTBOUND_HOLD: "true",
        SCHEDULER_AUTOSTART: "false",
      },
      executionProof: proof,
      executionProofSha256: proofHash(proof),
      companies: [css, painless].map((x) => ({
        ...x.cplan,
        key: x.company.key,
        staff: x.company.staff.map((s) => ({
          ...s,
          id: x.cplan.staff[s.key],
          password: "memory-only",
        })),
      })),
    };
    const built = planFromLocalManifest(manifest, {
      origin: plan.origin,
      keys: ["css"],
      now: NOW(),
    });
    expect(built.plan.companies.css).toEqual(css.cplan);
    expect(built.plan.executionProof.fixturesSha256).toBe(
      proofHash(built.plan.companies),
    );
  });
});
