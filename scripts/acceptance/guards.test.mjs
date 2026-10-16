import { test } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const g = await import("./guards.mjs").catch(() => ({}));
const hash = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
const now = Date.parse("2026-10-16T20:00:00Z"),
  origin = "https://mogulforge-growthos-staging.fly.dev";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export function fixture() {
  const source = { commit: "a".repeat(40), tree: "b".repeat(40), clean: true };
  const companies = ["painless", "css"].map((key, i) => ({
    key,
    name: `TEST ${key}`,
    slug: `test-${key}`,
    organizationId: id(i + 1),
    siteId: id(i + 11),
    siteName: `TEST ${key} site`,
    staff: [
      {
        id: id(i + 21),
        role: "owner",
        last: "TEST owner",
        credentialModule: "file:///memory/owner.mjs",
        credentialModuleSha256: "2".repeat(64),
      },
      {
        id: id(i + 31),
        role: i ? "office" : "owner",
        last: "TEST staff",
        credentialModule: "file:///memory/staff.mjs",
        credentialModuleSha256: "3".repeat(64),
      },
    ],
  }));
  const attestation = {
    kind: "ROOT_PROVIDER_READ_ONLY",
    observedAt: "2026-10-16T19:59:00Z",
    stopAt: "2026-10-16T22:00:00Z",
    origin,
    app: "mogulforge-growthos-staging",
    configSha256: "c".repeat(64),
    imageSha256: "d".repeat(64),
    release: {
      sha: "e".repeat(40),
      builtAt: "2026-10-16T19:00:00.000Z",
      environment: "staging",
    },
    frontendIndexSha256: "f".repeat(64),
    schema: {
      database: "growthos_staging",
      cluster: "zp2wjrejd2zodn4q",
      tables: 142,
      columns: 1870,
      catalogSha256: "1".repeat(64),
    },
    holds: {
      outbound: true,
      scheduler: false,
      communications: false,
      stagingOutboundApproved: false,
      recipientAllowlistEmpty: true,
    },
    fixturesSha256: hash(companies),
  };
  return {
    source,
    manifest: {
      kind: "GROWTHOS_ACCEPTANCE_EXECUTION_V1",
      runId: id(100),
      origin,
      preparedAt: "2026-10-16T19:59:00Z",
      expiresAt: "2026-10-16T20:10:00Z",
      reviewedBy: "ROOT",
      source: structuredClone(source),
      companies,
      attestation,
      attestationSha256: hash(attestation),
    },
  };
}
function admitted() {
  const f = fixture();
  return {
    f,
    a: g.admitManifest(f.manifest, { origin, source: f.source, now }),
  };
}
function observation(company, staff, release) {
  return {
    origin,
    session: {
      id: staff.id,
      role: staff.role,
      isPlatformAdmin: false,
      organization: {
        id: company.organizationId,
        name: company.name,
        slug: company.slug,
      },
    },
    me: {
      id: staff.id,
      role: staff.role,
      isActive: true,
      organization: {
        id: company.organizationId,
        name: company.name,
        slug: company.slug,
      },
    },
    sites: [{ id: company.siteId, name: company.siteName }],
    users: company.staff.map((s) => ({
      ...s,
      isActive: true,
      operationallyEligible: true,
    })),
    release,
    frontendIndexSha256: "f".repeat(64),
  };
}
test("origin guard rejects configurable production aliases and every unexpected origin component", () => {
  assert.equal(typeof g.canonicalOrigin, "function", "missing target guard");
  for (const value of [
    "https://mogulforge-growthos.fly.dev",
    "http://mogulforge-growthos-staging.fly.dev",
    "https://mogulforge-growthos-staging.fly.dev:444",
    "https://mogulforge-growthos-staging.fly.dev/path",
    "https://mogulforge-growthos-staging.fly.dev?x=1",
    "https://u:p@mogulforge-growthos-staging.fly.dev",
    "http://127.0.0.1:4192.evil.test",
    "http://localhost:4192",
  ])
    assert.throws(() => g.canonicalOrigin(value));
  for (const value of [
    origin,
    "http://127.0.0.1:4192",
    "http://127.0.0.1:4193",
  ])
    assert.equal(g.canonicalOrigin(value), value);
});
test("manifest rejects missing, stale, wrong source/schema/hold/fixture bindings before mutation", async () => {
  assert.equal(typeof g.admitManifest, "function");
  for (const alter of [
    (m) => delete m.attestation,
    (m) => (m.expiresAt = "2026-10-16T19:00:00Z"),
    (m) => (m.source.commit = "0".repeat(40)),
    (m) => (m.attestation.schema.columns = 1867),
    (m) => (m.attestation.holds.outbound = false),
    (m) => (m.attestation.fixturesSha256 = "0".repeat(64)),
    (m) => (m.companies[0].name = "Real customer"),
    (m) => (m.companies[0].staff[0].password = "secret"),
  ]) {
    const f = fixture();
    alter(f.manifest);
    if (f.manifest.attestation)
      f.manifest.attestationSha256 = hash(f.manifest.attestation);
    assert.throws(() =>
      g.admitManifest(f.manifest, { origin, source: f.source, now }),
    );
  }
  const { a } = admitted();
  assert.ok(a);
});
test("actual staff session, TEST org/site, release, frontend and exact origin must all match", () => {
  assert.equal(typeof g.verifyObservation, "function");
  const { f, a } = admitted(),
    company = f.manifest.companies[0],
    staff = company.staff[0];
  const good = observation(company, staff, f.manifest.attestation.release);
  assert.ok(g.verifyObservation(a, company.key, staff.id, good));
  for (const alter of [
    (o) => (o.origin = origin + ".evil.test"),
    (o) => (o.session.id = id(999)),
    (o) => (o.me.organization.id = id(999)),
    (o) => (o.session.isPlatformAdmin = true),
    (o) => (o.sites[0].id = id(999)),
    (o) => (o.users[1].id = id(999)),
    (o) => (o.release.sha = "0".repeat(40)),
    (o) => (o.frontendIndexSha256 = "0".repeat(64)),
  ]) {
    const o = structuredClone(good);
    alter(o);
    assert.throws(() => g.verifyObservation(a, company.key, staff.id, o));
  }
});
test("public mutation boundary refuses missing admission, expired admission and changed session origin without sending", async () => {
  assert.equal(typeof g.guardMutation, "function");
  const { f, a } = admitted(),
    c = f.manifest.companies[0];
  const token = g.verifyObservation(
    a,
    c.key,
    c.staff[0].id,
    observation(c, c.staff[0], f.manifest.attestation.release),
  );
  let sends = 0;
  const send = async () => {
    sends++;
    return 200;
  };
  for (const patch of [
    { token: null },
    { url: origin + ".evil.test/api/v1/settings" },
    { now: now + 20 * 60_000 },
    { url: origin + "/api/v1/invoices/x/delivery/send" },
  ])
    await assert.rejects(
      g.guardMutation({
        admission: a,
        token,
        url: origin + "/api/v1/settings",
        method: "PUT",
        now,
        send,
        ...patch,
      }),
    );
  assert.equal(sends, 0);
  assert.equal(
    await g.guardMutation({
      admission: a,
      token,
      url: origin + "/api/v1/settings",
      method: "PUT",
      now,
      send,
    }),
    200,
  );
  assert.equal(sends, 1);
});
test("reschedule requires exactly the original persisted appointment, lineage and window", () => {
  assert.equal(typeof g.rescheduledExactly, "function");
  const expected = {
    id: id(1),
    contactId: id(2),
    propertyId: id(3),
    assignedUserId: id(4),
    scheduledStart: "2026-10-20T15:00:00Z",
    scheduledEnd: "2026-10-20T17:00:00Z",
  };
  const row = { ...expected, status: "scheduled" };
  assert.equal(g.rescheduledExactly([row], expected), true);
  for (const rows of [
    [],
    [row, row],
    [{ ...row, id: id(9) }],
    [{ ...row, propertyId: id(9) }],
    [{ ...row, scheduledEnd: "2026-10-20T18:00:00Z" }],
  ])
    assert.equal(g.rescheduledExactly(rows, expected), false);
});
test("customer/property lineage cannot pass on fallback creation, duplicate or unrelated reuse", () => {
  assert.equal(typeof g.lineageExactly, "function");
  const contact = { id: id(1), email: "test-one@example.invalid" },
    property = { id: id(2), contactId: id(1), addressLine1: "100 TEST Street" },
    lead = { contactId: id(1), propertyId: id(2) };
  const input = {
    lead,
    contacts: [contact],
    properties: [property],
    expectedEmail: contact.email,
    expectedAddress: property.addressLine1,
    beforeContacts: 0,
  };
  assert.equal(g.lineageExactly(input), true);
  for (const patch of [
    { lead: { contactId: null, propertyId: id(2) } },
    { contacts: [contact, contact] },
    { properties: [{ ...property, contactId: id(9) }] },
    { beforeContacts: 1 },
    { properties: [] },
  ])
    assert.equal(g.lineageExactly({ ...input, ...patch }), false);
});
test("whole issued document, exact required cents, recipients and credential check cannot false-pass", () => {
  assert.equal(typeof g.issuedDocumentUnchanged, "function");
  const invoice = {
    id: id(1),
    status: "issued",
    document: {
      title: "TEST",
      totalCents: 33000,
      equipment: [{ label: "TEST unit", serial: "A" }],
    },
  };
  assert.equal(
    g.issuedDocumentUnchanged(invoice, structuredClone(invoice)),
    true,
  );
  const changed = structuredClone(invoice);
  changed.document.equipment[0].serial = "B";
  assert.equal(g.issuedDocumentUnchanged(invoice, changed), false);
  assert.equal(g.issuedDocumentUnchanged({}, {}), false);
  const balances = {
    totalCents: 33000,
    recordedPaidCents: 10000,
    recordedBalanceCents: 23000,
    balanceDueCents: 23000,
    paymentState: "partial",
  };
  assert.equal(g.exactBalance(balances), true);
  for (const k of Object.keys(balances)) {
    const bad = { ...balances };
    delete bad[k];
    assert.equal(g.exactBalance(bad), false);
  }
  assert.equal(g.exactBalance({ ...balances, balanceDueCents: 0 }), false);
  assert.equal(
    g.recipientsExactly([{ userId: id(1) }, { userId: id(2) }], [id(1), id(2)]),
    true,
  );
  assert.equal(
    g.recipientsExactly([{ userId: id(1) }, { userId: id(9) }], [id(1), id(2)]),
    false,
  );
  assert.equal(
    g.recipientsExactly([{ userId: id(1) }, { userId: id(1) }], [id(1), id(2)]),
    false,
  );
  assert.equal(
    g.credentialVerified(
      { status: 200, json: { status: "credential_verified", siteId: id(1) } },
      id(1),
    ),
    true,
  );
  assert.equal(g.credentialVerified({ status: 401, json: {} }, id(1)), false);
});
test("visit link contains exact organization and appointment, while UI and API observations stay separate", () => {
  assert.equal(typeof g.appointmentLink, "function");
  const link = g.appointmentLink(id(1), id(2));
  const url = new URL(link, origin);
  assert.equal(url.searchParams.get("organizationId"), id(1));
  assert.equal(url.searchParams.get("appointmentId"), id(2));
  assert.equal(g.completionUiClaim("This appointment link is invalid"), "FAIL");
  assert.equal(g.completionUiClaim("Scheduled"), "NOT_RUN");
});
test("temporary policy is restored in finally even when intake throws", async () => {
  assert.equal(typeof g.withRestoredPolicy, "function");
  const calls = [];
  await assert.rejects(
    g.withRestoredPolicy({
      set: async (p) => calls.push(p),
      original: { enabled: true },
      temporary: { enabled: false },
      run: async () => {
        throw Error("fail");
      },
    }),
  );
  assert.deepEqual(calls, [{ enabled: false }, { enabled: true }]);
});
test("failed policy restoration is explicit even when the operation also fails", async () => {
  let calls = 0;
  await assert.rejects(
    g.withRestoredPolicy({
      set: async () => {
        if (++calls === 2) throw Error("RAW restore");
      },
      original: {},
      temporary: {},
      run: async () => {
        throw Error("RAW intake");
      },
    }),
    (e) => e.message === "policy_restore_failed",
  );
});
test("admission expires with the attestation and never extends the recorded staging stop window", () => {
  const f = fixture();
  f.manifest.expiresAt = "2026-10-16T20:14:00Z";
  const a = g.admitManifest(f.manifest, { origin, source: f.source, now });
  assert.throws(() => g.assertAdmission(a, Date.parse("2026-10-16T20:10:00Z")));
  const wrong = fixture();
  wrong.manifest.attestation.stopAt = "2026-10-16T20:05:00Z";
  wrong.manifest.attestationSha256 = hash(wrong.manifest.attestation);
  assert.throws(() =>
    g.admitManifest(wrong.manifest, { origin, source: wrong.source, now }),
  );
});
