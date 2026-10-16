// Pure admission for ROOT/provider or disposable-local observations. No IO.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
export const STAGING_STOP_AT = "2026-10-18T04:00:00Z";
export const STAGING_SETUP_END_AT = "2026-10-16T22:00:00Z";
export const PROOF_MAX_AGE_MS = 5 * 60_000;
export const proofHash = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
const hex = (x, n) =>
  typeof x === "string" && new RegExp(`^[a-f0-9]{${n}}$`).test(x);
const check = (x, code) => {
  if (!x) throw Object.assign(Error(code), { code, status: "BLOCKED" });
};
const keys = (x, allowed) =>
  x &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  Object.keys(x).every((k) => allowed.includes(k));
export async function fingerprintFrontend(response) {
  check(
    response?.status === 200 && response.body,
    "execution_observation_missing",
  );
  const reader = response.body.getReader(),
    hash = createHash("sha256");
  let count = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      count += part.value.byteLength;
      check(count <= 2_000_000, "execution_observation_missing");
      hash.update(part.value);
    }
    return hash.digest("hex");
  } catch {
    try {
      await reader.cancel();
    } catch {}
    check(false, "execution_observation_missing");
  } finally {
    reader.releaseLock();
  }
}
export function canonicalRuntimeOrigin(origin) {
  const u = new URL(origin);
  if (u.hostname === "localhost") u.hostname = "127.0.0.1";
  check(
    !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === "/" &&
      [
        "http://127.0.0.1:4192",
        "http://127.0.0.1:4193",
        "https://mogulforge-growthos-staging.fly.dev",
      ].includes(u.origin),
    "execution_proof_target",
  );
  return u.origin;
}
export function validateExecutionProof(plan, now = Date.now()) {
  const p = plan?.executionProof,
    local = plan?.target === "local",
    origin = canonicalRuntimeOrigin(plan?.origin);
  check(
    ["local", "staging"].includes(plan?.target) &&
      (local
        ? origin.startsWith("http://127.0.0.1:")
        : origin === "https://mogulforge-growthos-staging.fly.dev"),
    "execution_proof_target",
  );
  check(
    keys(p, [
      "kind",
      "origin",
      "fixturesSha256",
      "observedAt",
      "expiresAt",
      "configSha256",
      "imageSha256",
      "frontendIndexSha256",
      "release",
      "schema",
      "holds",
      "runtime",
      ...(local
        ? []
        : [
            "reviewedBy",
            "account",
            "org",
            "orgId",
            "apiOrg",
            "app",
            "machine",
            "immutableImage",
          ]),
    ]) &&
      keys(p.release, ["sha", "builtAt", "environment"]) &&
      keys(p.schema, [
        "tables",
        "columns",
        "catalogSha256",
        "database",
        "cluster",
      ]) &&
      keys(
        p.runtime,
        local
          ? ["instanceId", "processId"]
          : [
              "instanceId",
              "state",
              "eventsSha256",
              "configSha256",
              "stopAt",
              "taskNextUtc",
              "anchorUpperAt",
              "capSeconds",
              "verifiedReceiptSha256",
              "anchorSha256",
            ],
      ),
    "execution_proof_shape",
  );
  check(
    p &&
      plan.executionProofSha256 === proofHash(p) &&
      p.kind ===
        (local
          ? "LOCAL_DEMO_EXECUTION_PROOF_V1"
          : "ROOT_DEMO_EXECUTION_PROOF_V1") &&
      p.origin === origin &&
      p.fixturesSha256 === proofHash(plan.companies),
    "execution_proof_missing",
  );
  const observed = Date.parse(p.observedAt),
    expires = Date.parse(p.expiresAt);
  check(
    Number.isFinite(observed) &&
      observed <= now &&
      now - observed <= PROOF_MAX_AGE_MS &&
      expires > now &&
      expires - observed <= PROOF_MAX_AGE_MS,
    "execution_proof_expired",
  );
  check(
    hex(p.configSha256, 64) &&
      hex(p.imageSha256, 64) &&
      hex(p.frontendIndexSha256, 64) &&
      hex(p.release?.sha, 40) &&
      Number.isFinite(Date.parse(p.release?.builtAt)) &&
      p.release.environment === (local ? "test" : "staging"),
    "execution_proof_deployment",
  );
  check(
    p.schema?.tables === 142 &&
      p.schema.columns === 1870 &&
      hex(p.schema.catalogSha256, 64) &&
      p.schema.database === (local ? "postgres" : "growthos_staging") &&
      (local
        ? p.schema.cluster === null
        : p.schema.cluster === "zp2wjrejd2zodn4q"),
    "execution_proof_schema",
  );
  check(
    isDeepStrictEqual(p.holds, {
      outbound: true,
      scheduler: false,
      communications: false,
      stagingOutboundApproved: false,
      recipientAllowlistEmpty: true,
    }),
    "execution_proof_holds",
  );
  if (local)
    check(
      p.runtime?.instanceId === plan.instanceId &&
        typeof plan.instanceId === "string" &&
        p.runtime.processId > 0,
      "execution_proof_runtime",
    );
  else {
    check(
      p.reviewedBy === "ROOT" &&
        p.account === "diazdestination@gmail.com" &&
        p.org === "personal" &&
        p.orgId === "1854600" &&
        p.apiOrg === "adam-diaz" &&
        p.app === "mogulforge-growthos-staging" &&
        p.machine === "8d96936a03d058" &&
        p.runtime?.state === "started" &&
        typeof p.runtime.instanceId === "string" &&
        p.runtime.instanceId.length > 0 &&
        hex(p.runtime.eventsSha256, 64) &&
        p.runtime.configSha256 === p.configSha256 &&
        p.immutableImage ===
          `registry.fly.io/mogulforge-growthos-staging@sha256:${p.imageSha256}` &&
        isDeepStrictEqual(p.release, plan.release),
      "execution_proof_target",
    );
    const stop = Date.parse(p.runtime.stopAt),
      upper = Date.parse(p.runtime.anchorUpperAt),
      cap = p.runtime.capSeconds;
    // Runtime availability and this setup's dispatch window are independent.
    // A later verified runtime stop never extends setup authority or proof life.
    check(
      Number.isFinite(stop) &&
        stop <= Date.parse(STAGING_STOP_AT) &&
        expires <= stop &&
        expires <= Date.parse(STAGING_SETUP_END_AT) &&
        now < stop &&
        now < Date.parse(STAGING_SETUP_END_AT) &&
        p.runtime.taskNextUtc === p.runtime.stopAt &&
        Number.isFinite(upper) &&
        upper <= observed &&
        Number.isSafeInteger(cap) &&
        cap > 0 &&
        upper + cap * 1000 <= stop &&
        hex(p.runtime.verifiedReceiptSha256, 64) &&
        hex(p.runtime.anchorSha256, 64),
      "execution_proof_stop",
    );
  }
  return p;
}
export function verifyDeploymentObservation(plan, o, now = Date.now()) {
  const p = validateExecutionProof(plan, now);
  check(
    o?.origin === p.origin &&
      isDeepStrictEqual(o.release, p.release) &&
      o.frontendIndexSha256 === p.frontendIndexSha256,
    "execution_observation_mismatch",
  );
  return p;
}
