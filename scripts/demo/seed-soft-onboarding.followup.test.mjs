import { describe, expect, it } from "vitest";
import {
  FakeGrowthOS,
  fakePlan,
  fakeExecutionProof,
  memoryCustodyFiles,
} from "./fake-growthos-api.mjs";
import { createMutationCustody } from "./mutation-custody.mjs";
import { proofHash } from "./execution-proof.mjs";
import {
  runCompany,
  seedCompany,
  STAGING_ORIGIN,
} from "./seed-soft-onboarding.mjs";

const ROOT_A = "11111111-1111-4111-8111-111111111111";
const ROOT_B = "22222222-2222-4222-8222-222222222222";
const START = Date.parse("2026-10-16T21:59:00Z");
function scenario({ staging = false, invoiceRoot = true } = {}) {
  const fixture = fakePlan("css"),
    { plan, cplan } = fixture,
    company = structuredClone(fixture.company);
  if (staging)
    company.customers.sort(
      (a, b) =>
        Number(a.key === company.smartSiteLead.customer) -
        Number(b.key === company.smartSiteLead.customer),
    );
  const api = new FakeGrowthOS({ company, cplan }),
    io = memoryCustodyFiles();
  let clock = staging ? START : Date.parse("2026-10-16T18:00:00Z");
  if (staging) {
    plan.target = "staging";
    plan.origin = STAGING_ORIGIN;
    plan.release = { ...plan.release, environment: "staging" };
    plan.executionProof = fakeExecutionProof(plan, clock);
    plan.executionProof.expiresAt = "2026-10-16T22:00:00Z";
    plan.executionProof.runtime.capSeconds = 60;
    plan.executionProofSha256 = proofHash(plan.executionProof);
  }
  const ordinary = api.call;
  const call = async (method, pathname, body) => {
    const r = await ordinary(method, pathname, body);
    if (pathname === "/api/readyz" && staging) r.json.release = plan.release;
    // Product createInvoice(existing_customer) creates a customer_work root.
    // Literal DTO values are independent of the seeder/custody implementation.
    if (invoiceRoot && method === "POST" && pathname === "/api/v1/invoices") {
      r.json.invoice.sourceKind = "customer_work";
      r.json.invoice.customerWorkId = [ROOT_A, ROOT_B][
        company.invoices.findIndex((x) => x.title === body.document.title)
      ];
    }
    return r;
  };
  const args = {
    call,
    publicPost: api.publicPost,
    plan,
    cplan,
    company,
    demoDate: plan.demoDate,
    apply: true,
    session: api.session(),
    now: () => clock,
    quiet: true,
    observe: () => ({
      ...api.observe(),
      origin: plan.origin,
      release: plan.release,
    }),
  };
  const fresh = () => ({
    ...args,
    custody: createMutationCustody({
      plan,
      cplan,
      company,
      io,
      now: () => clock,
    }),
  });
  return {
    api,
    io,
    plan,
    company,
    args,
    fresh,
    setClock: (value) => (clock = value),
  };
}
const records = (s) => [...s.io.files.values()].map((b) => JSON.parse(b));
const checkIntent = (s) =>
  records(s).find(
    (r) =>
      r.kind === "smart-site" &&
      r.key === "credential-check" &&
      r.method === "POST",
  );
const checkWrites = (s) => s.api.writes.filter((p) => p.endsWith("/check"));

describe("0953 review invoice DTO and original returning-work identity", () => {
  it("actual customer_work DTO completes and its original root survives fresh zero-write readback", async () => {
    const s = scenario();
    expect((await runCompany(s.fresh())).status).toBe("APPLIED");
    const acks = records(s).filter((r) => r.kind === "invoice" && r.resourceId);
    expect(acks).toHaveLength(s.company.invoices.length);
    expect(
      Object.fromEntries(acks.map((r) => [r.key, r.customerWorkId])),
    ).toEqual({
      "inv-moss": ROOT_A,
      "inv-brown": ROOT_B,
    });
    const before = s.api.writes.length;
    expect((await runCompany(s.fresh())).status).toBe("APPLIED");
    expect(s.api.writes.length).toBe(before);
  });
  it("a different non-null root on first readback holds before issue/payment", async () => {
    const s = scenario();
    const call = s.args.call;
    s.args.call = async (method, pathname, body) => {
      const r = await call(method, pathname, body);
      if (method === "POST" && pathname === "/api/v1/invoices") {
        const response = structuredClone(r);
        s.api.db.invoices.at(-1).customerWorkId = ROOT_B;
        return response;
      }
      return r;
    };
    const r = await seedCompany(s.fresh());
    expect(r.status).toBe("HOLD");
    expect(r.halt.code).toBe("fixture_conflict");
    expect(
      s.api.writes.some((p) => /\/invoices\/.*\/(issue|payments)$/.test(p)),
    ).toBe(false);
  });
  it("an issued invoice relinked to another valid root holds with zero later mutations", async () => {
    const s = scenario();
    expect((await runCompany(s.fresh())).status).toBe("APPLIED");
    s.api.db.invoices.find((r) => r.status === "issued").customerWorkId =
      ROOT_B;
    const before = s.api.writes.length;
    const r = await seedCompany(s.fresh());
    expect(r.status).toBe("HOLD");
    expect(r.halt.code).toBe("fixture_conflict");
    expect(s.api.writes.length).toBe(before);
  });
  it.each([null, "not-a-uuid"])(
    "missing/invalid original root %s is UNKNOWN and never replayed",
    async (root) => {
      const s = scenario();
      const call = s.args.call;
      s.args.call = async (method, pathname, body) => {
        const r = await call(method, pathname, body);
        if (method === "POST" && pathname === "/api/v1/invoices")
          r.json.invoice.customerWorkId = root;
        return r;
      };
      expect((await seedCompany(s.fresh())).status).toBe("UNKNOWN");
      const before = s.api.writes.length;
      expect((await seedCompany(s.fresh())).status).toBe("HOLD");
      expect(s.api.writes.length).toBe(before);
    },
  );
});

describe("0953 review public credential-check is a durable mutation", () => {
  it("expiry during the final contact lookup prevents credential-check POST after 22Z", async () => {
    const s = scenario({ staging: true });
    const lastEmail = s.company.customers.at(-1).email;
    s.api.fault("GET", /^\/api\/v1\/contacts\?/, (p) => {
      if (
        new URL(p, "http://fake.local").searchParams.get("search") === lastEmail
      )
        s.setClock(Date.parse("2026-10-16T22:00:00.001Z"));
      return null;
    });
    const r = await seedCompany(s.fresh());
    expect(r.status).toBe("BLOCKED");
    expect(r.halt.code).toBe("execution_proof_expired");
    expect(checkWrites(s)).toHaveLength(0);
  });
  it("expiry during the check's last session read preserves its intent without dispatch", async () => {
    const s = scenario({ staging: true });
    let afterLookup = false;
    s.api.fault("GET", /^\/api\/v1\/contacts\?/, (p) => {
      if (
        new URL(p, "http://fake.local").searchParams.get("search") ===
        s.company.customers.at(-1).email
      )
        afterLookup = true;
      return null;
    });
    s.api.fault("GET", /^\/api\/v1\/me$/, () => {
      if (afterLookup) s.setClock(Date.parse("2026-10-16T22:00:00.001Z"));
      return null;
    });
    const r = await seedCompany(s.fresh());
    expect(r.status).toBe("BLOCKED");
    expect(checkWrites(s)).toHaveLength(0);
    expect(checkIntent(s)).toBeTruthy();
    expect(
      records(s).some(
        (x) =>
          x.kind === "smart-site" &&
          x.key === "credential-check" &&
          x.resourceId,
      ),
    ).toBe(false);
    s.setClock(START);
    const before = s.api.writes.length;
    expect((await seedCompany(s.fresh())).status).toBe("HOLD");
    expect(s.api.writes.length).toBe(before);
  });
  it("lost check acknowledgement is UNKNOWN, had intent before dispatch, and has zero replay in a new run", async () => {
    const s = scenario();
    const post = s.args.publicPost;
    let reservedAtDispatch = false;
    s.args.publicPost = async (pathname, body, key) => {
      if (pathname.endsWith("/check"))
        reservedAtDispatch = Boolean(checkIntent(s));
      const r = await post(pathname, body, key);
      return pathname.endsWith("/check") ? { status: 0, json: null } : r;
    };
    expect((await seedCompany(s.fresh())).status).toBe("UNKNOWN");
    expect(reservedAtDispatch).toBe(true);
    expect(checkWrites(s)).toHaveLength(1);
    expect(JSON.stringify(records(s))).not.toContain(s.api.siteKey);
    const before = s.api.writes.length;
    expect((await seedCompany(s.fresh())).status).toBe("HOLD");
    expect(s.api.writes.length).toBe(before);
  });
  it("HTTP 200 without the real credential_verified identity cannot activate or create intake", async () => {
    const s = scenario();
    s.api.fault("POST", /\/check$/, () => ({
      status: 200,
      json: { ok: true },
    }));
    const r = await seedCompany(s.fresh());
    expect(r.status).toBe("UNKNOWN");
    expect(
      s.api.writes.some(
        (p) =>
          p.startsWith("PATCH /api/v1/smart-sites/") || p.endsWith("/intake"),
      ),
    ).toBe(false);
    expect(checkIntent(s)).toBeTruthy();
  });
});
