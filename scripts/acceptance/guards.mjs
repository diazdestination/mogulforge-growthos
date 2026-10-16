import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
const sha = (x) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const hex = (x, n) =>
  typeof x === "string" && new RegExp(`^[a-f0-9]{${n}}$`).test(x);
const uuid = (x) =>
  typeof x === "string" &&
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(x);
const check = (ok, code) => {
  if (!ok) throw Object.assign(new Error(code), { code });
};
const admissions = new WeakSet(),
  tokens = new WeakSet();
const freeze = (x) => {
  if (x && typeof x === "object") {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }
  return x;
};
export function canonicalOrigin(input) {
  let u;
  try {
    u = new URL(input);
  } catch {
    throw Error("target_origin");
  }
  check(
    !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash,
    "target_origin",
  );
  check(
    [
      "http://127.0.0.1:4192",
      "http://127.0.0.1:4193",
      "https://mogulforge-growthos-staging.fly.dev",
    ].includes(u.origin),
    "target_origin",
  );
  return u.origin;
}
function noSecrets(x) {
  if (!x || typeof x !== "object") return;
  for (const [key, value] of Object.entries(x)) {
    check(
      !/^(password|siteKey|apiKey|secret|cookie|authorization|storageState)$/i.test(
        key,
      ),
      "manifest_secret",
    );
    noSecrets(value);
  }
}
export function admitManifest(
  manifest,
  { origin, source, now = Date.now() } = {},
) {
  const target = canonicalOrigin(origin);
  noSecrets(manifest);
  check(
    manifest?.kind === "GROWTHOS_ACCEPTANCE_EXECUTION_V1" &&
      uuid(manifest.runId) &&
      manifest.origin === target &&
      manifest.reviewedBy === "ROOT",
    "manifest_identity",
  );
  const prepared = Date.parse(manifest.preparedAt),
    expires = Date.parse(manifest.expiresAt);
  check(
    Number.isFinite(prepared) &&
      prepared <= now &&
      now - prepared <= 15 * 60_000 &&
      expires > now &&
      expires - prepared <= 15 * 60_000,
    "manifest_expired",
  );
  check(
    source?.clean === true &&
      hex(source.commit, 40) &&
      hex(source.tree, 40) &&
      isDeepStrictEqual(source, manifest.source),
    "manifest_source",
  );
  const companies = manifest.companies;
  check(
    Array.isArray(companies) &&
      companies.length === 2 &&
      new Set(companies.map((c) => c.key)).size === 2 &&
      ["painless", "css"].every((k) => companies.some((c) => c.key === k)),
    "manifest_fixtures",
  );
  const ids = [];
  for (const c of companies) {
    check(
      /^TEST\b/.test(c.name) &&
        /^test-/.test(c.slug) &&
        /^TEST\b/.test(c.siteName) &&
        uuid(c.organizationId) &&
        uuid(c.siteId) &&
        Array.isArray(c.staff) &&
        c.staff.length === 2,
      "manifest_fixtures",
    );
    ids.push(c.organizationId, c.siteId);
    for (const [i, s] of c.staff.entries()) {
      check(
        uuid(s.id) &&
          s.role === (i === 0 || c.key === "painless" ? "owner" : "office"),
        "manifest_staff",
      );
      ids.push(s.id);
    }
  }
  check(new Set(ids).size === ids.length, "manifest_fixtures");
  const a = manifest.attestation,
    local = target.startsWith("http:");
  if (!local)
    for (const c of companies)
      for (const s of c.staff)
        check(
          typeof s.credentialModule === "string" &&
            s.credentialModule.startsWith("file:///") &&
            hex(s.credentialModuleSha256, 64),
          "manifest_auth_module",
        );
  check(
    a &&
      a.kind ===
        (local ? "LOCAL_RUNTIME_READ_ONLY" : "ROOT_PROVIDER_READ_ONLY") &&
      a.origin === target &&
      a.fixturesSha256 === sha(companies) &&
      manifest.attestationSha256 === sha(a),
    "manifest_attestation",
  );
  check(
    Date.parse(a.observedAt) <= now &&
      now - Date.parse(a.observedAt) <= 10 * 60_000 &&
      Date.parse(a.observedAt) >= prepared - 10 * 60_000,
    "attestation_stale",
  );
  check(
    hex(a.configSha256, 64) &&
      hex(a.imageSha256, 64) &&
      hex(a.frontendIndexSha256, 64) &&
      hex(a.release?.sha, 40) &&
      Number.isFinite(Date.parse(a.release?.builtAt)) &&
      a.release.environment === (local ? "test" : "staging"),
    "attestation_release",
  );
  check(
    local
      ? a.runtimeId === manifest.runId
      : a.app === "mogulforge-growthos-staging",
    "attestation_runtime",
  );
  check(
    local
      ? a.release.sha === source.commit
      : Number.isFinite(Date.parse(a.stopAt)) &&
          expires <= Date.parse(a.stopAt),
    "attestation_window",
  );
  check(
    a.schema?.tables === 142 &&
      a.schema.columns === 1870 &&
      hex(a.schema.catalogSha256, 64) &&
      (local
        ? a.schema.database === "postgres"
        : a.schema.database === "growthos_staging" &&
          a.schema.cluster === "zp2wjrejd2zodn4q"),
    "attestation_schema",
  );
  check(
    a.holds?.outbound === true &&
      a.holds.scheduler === false &&
      a.holds.communications === false &&
      a.holds.stagingOutboundApproved === false &&
      a.holds.recipientAllowlistEmpty === true,
    "attestation_holds",
  );
  const admitted = freeze({
    origin: target,
    expiresAt: Math.min(expires, Date.parse(a.observedAt) + 10 * 60_000),
    manifest: JSON.parse(JSON.stringify(manifest)),
    manifestSha256: sha(manifest),
  });
  admissions.add(admitted);
  return admitted;
}
export function assertAdmission(a, now = Date.now()) {
  check(admissions.has(a) && now < a.expiresAt, "admission_missing_or_expired");
}
export function verifyObservation(a, key, staffId, o) {
  check(admissions.has(a), "admission_missing");
  const c = a.manifest.companies.find((c) => c.key === key),
    staff = c?.staff.find((s) => s.id === staffId);
  check(c && staff, "staff_not_in_fixture");
  check(
    o?.origin === a.origin &&
      isDeepStrictEqual(o.release, a.manifest.attestation.release) &&
      o.frontendIndexSha256 === a.manifest.attestation.frontendIndexSha256,
    "observed_release",
  );
  for (const who of [o.session, o.me])
    check(
      who?.id === staff.id &&
        who.role === staff.role &&
        who.organization?.id === c.organizationId &&
        who.organization.name === c.name &&
        who.organization.slug === c.slug,
      "observed_session",
    );
  check(
    o.session.isPlatformAdmin === false && o.me.isActive === true,
    "observed_actor",
  );
  check(
    Array.isArray(o.sites) &&
      o.sites.filter((s) => s.id === c.siteId && s.name === c.siteName)
        .length === 1,
    "observed_site",
  );
  check(
    Array.isArray(o.users) &&
      c.staff.every(
        (s) =>
          o.users.filter(
            (u) =>
              u.id === s.id &&
              u.role === s.role &&
              u.isActive === true &&
              u.operationallyEligible === true,
          ).length === 1,
      ),
    "observed_staff",
  );
  const token = freeze({
    admission: a,
    companyKey: key,
    staffId,
    organizationId: c.organizationId,
    siteId: c.siteId,
  });
  tokens.add(token);
  return token;
}
export function assertMutation({
  admission,
  token,
  url,
  method,
  now = Date.now(),
}) {
  assertAdmission(admission, now);
  check(
    tokens.has(token) && token.admission === admission,
    "session_not_admitted",
  );
  const u = new URL(url);
  check(
    u.origin === admission.origin &&
      !u.username &&
      !u.password &&
      !u.hash &&
      !u.search &&
      u.pathname.startsWith("/api/"),
    "request_origin",
  );
  check(
    !/\/delivery\/send(?:\/|$)|\/dispatch(?:\/|$)|\/logout(?:\/|$)|\/platform\//.test(
      u.pathname,
    ),
    "mutation_not_in_slice",
  );
  check(["POST", "PUT", "PATCH"].includes(method), "mutation_method");
  return token;
}
export async function guardMutation({ send, ...input }) {
  assertMutation(input);
  return send();
}
export function rescheduledExactly(rows, e) {
  const mine = rows.filter(
    (r) => r.contactId === e.contactId && r.status !== "cancelled",
  );
  if (mine.length !== 1) return false;
  const r = mine[0];
  return (
    ["id", "contactId", "propertyId", "assignedUserId"].every(
      (k) => r[k] === e[k],
    ) &&
    ["scheduledStart", "scheduledEnd"].every(
      (k) =>
        Number.isFinite(Date.parse(r[k])) &&
        Date.parse(r[k]) === Date.parse(e[k]),
    )
  );
}
export function lineageExactly({
  lead,
  contacts,
  properties,
  expectedEmail,
  expectedAddress,
  beforeContacts,
}) {
  return (
    beforeContacts === 0 &&
    uuid(lead?.contactId) &&
    uuid(lead?.propertyId) &&
    contacts.length === 1 &&
    properties.length === 1 &&
    contacts[0].id === lead.contactId &&
    contacts[0].email === expectedEmail &&
    properties[0].id === lead.propertyId &&
    properties[0].contactId === lead.contactId &&
    properties[0].addressLine1 === expectedAddress
  );
}
export function issuedDocumentUnchanged(a, b) {
  return !!(
    a?.id &&
    a.id === b?.id &&
    a.status === "issued" &&
    b.status === "issued" &&
    a.document &&
    typeof a.document === "object" &&
    isDeepStrictEqual(a.document, b.document)
  );
}
export function exactBalance(i) {
  return (
    i?.totalCents === 33000 &&
    i.recordedPaidCents === 10000 &&
    i.recordedBalanceCents === 23000 &&
    i.balanceDueCents === 23000 &&
    i.paymentState === "partial"
  );
}
export function recipientsExactly(rows, expected) {
  const ids = rows.map((r) => r.userId);
  return (
    ids.length === expected.length &&
    new Set(ids).size === ids.length &&
    [...ids].sort().every((id, i) => id === [...expected].sort()[i])
  );
}
export function credentialVerified(r, siteId) {
  return (
    r?.status === 200 &&
    r.json?.status === "credential_verified" &&
    r.json?.siteId === siteId
  );
}
export function appointmentLink(org, id) {
  check(uuid(org) && uuid(id), "appointment_identity");
  return `/appointments?appointmentId=${encodeURIComponent(id)}&organizationId=${encodeURIComponent(org)}`;
}
export function completionUiClaim(text) {
  return /appointment link is invalid|No linked appointment was opened/i.test(
    text,
  )
    ? "FAIL"
    : "NOT_RUN";
}
export async function withRestoredPolicy({ set, original, temporary, run }) {
  let value, primary;
  try {
    await set(temporary);
    value = await run();
  } catch (e) {
    primary = e;
  } finally {
    try {
      await set(original);
    } catch {
      primary = Object.assign(Error("policy_restore_failed"), {
        code: "policy_restore_failed",
      });
    }
  }
  if (primary) throw primary;
  return value;
}
export const semanticHash = sha;
