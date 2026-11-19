import { test, afterAll } from "vitest";
import assert from "node:assert/strict";
// Vitest/Vite supplies BASE_URL='/' by default. Set the test's explicit
// allowed target before loading the real Node CLI helpers.
const previousOrigin = process.env.BASE_URL;
process.env.BASE_URL = "http://127.0.0.1:4192";
const lib = await import("./lib.mjs");
const { runWorkday } = await import("./run-workday-acceptance.mjs");
afterAll(() => {
  if (previousOrigin === undefined) delete process.env.BASE_URL;
  else process.env.BASE_URL = previousOrigin;
});
import { admitManifest, semanticHash } from "./guards.mjs";
import { createHash } from "node:crypto";
test("actual workday entrypoint refuses invalid fixture input before browser launch or mutation", async () => {
  let launched = 0;
  await assert.rejects(
    runWorkday({
      inputManifest: { kind: "wrong" },
      browserFactory: async () => {
        launched++;
        throw Error("must not launch");
      },
    }),
  );
  assert.equal(launched, 0);
});
test("actual API helper cannot dispatch a business mutation without a bound staff admission", async () => {
  let requests = 0;
  const page = {
    url: () => lib.BASE_URL + "/",
    evaluate: async () => {
      requests++;
      return { status: 200, json: {} };
    },
    goto: async () => {},
  };
  await assert.rejects(lib.api(page, "PUT", "/api/v1/staff-push/policy", {}));
  assert.equal(requests, 0);
});
test("same-origin API helper rejects prefix-matching foreign pages and absolute request paths", async () => {
  let requests = 0;
  const page = {
    url: () => lib.BASE_URL + ".evil.test/",
    evaluate: async () => {
      requests++;
    },
    goto: async () => {
      throw Error("must not navigate a foreign session");
    },
  };
  await assert.rejects(lib.api(page, "GET", "/api/v1/session"));
  assert.equal(requests, 0);
});
test("evidence writer creates immutable runs and refuses screenshot/result overwrite", async () => {
  assert.equal(typeof lib.createEvidenceRun, "function");
  const dirs = new Set(),
    files = new Map();
  const io = {
    mkdir: async (p) => {
      if (dirs.has(p)) throw Error("exists");
      dirs.add(p);
    },
    writeFile: async (p, b, options) => {
      assert.equal(options.flag, "wx");
      if (files.has(p)) throw Error("exists");
      files.set(p, b);
    },
  };
  const run = await lib.createEvidenceRun(
    "test-run",
    { source: { commit: "a".repeat(40) } },
    {
      io,
      root: "C:/Forge/artifacts/growthos-launch-codex-20261016/acceptance-guardfix",
    },
  );
  await run.write("results.json", { status: "PASS" });
  await assert.rejects(run.write("results.json", { status: "FAIL" }));
  await assert.rejects(
    lib.createEvidenceRun(
      "test-run",
      {},
      {
        io,
        root: "C:/Forge/artifacts/growthos-launch-codex-20261016/acceptance-guardfix",
      },
    ),
  );
  assert.equal(files.size, 1);
  assert.match([...files.values()][0], /PASS/);
});
test("safe evidence projection excludes response payloads and credential-bearing extras", () => {
  assert.equal(typeof lib.safeExtras, "function");
  const out = lib.safeExtras({
    company: { secret: "DO_NOT_KEEP" },
    step: "setup",
    password: "DO_NOT_KEEP",
    siteKey: "DO_NOT_KEEP",
    readiness: { apiKey: "DO_NOT_KEEP" },
    coverage: { secret: "DO_NOT_KEEP" },
    apiStatus: 200,
  });
  assert.equal(out.apiStatus, 200);
  assert.equal(JSON.stringify(out).includes("DO_NOT_KEEP"), false);
});
async function admittedBrowser() {
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    now = Date.parse("2026-10-16T20:00:00Z"),
    source = { commit: "a".repeat(40), tree: "b".repeat(40), clean: true };
  const companies = ["painless", "css"].map((key, i) => ({
    key,
    name: `TEST ${key}`,
    slug: `test-${key}`,
    siteName: `TEST ${key} site`,
    organizationId: id(i + 1),
    siteId: id(i + 11),
    staff: [
      { id: id(i + 21), role: "owner" },
      { id: id(i + 31), role: i ? "office" : "owner" },
    ],
  }));
  const html = Buffer.from("<html>TEST local frontend</html>"),
    release = {
      sha: source.commit,
      builtAt: "2026-10-16T19:00:00.000Z",
      environment: "test",
    },
    runId = id(100);
  const attestation = {
    kind: "LOCAL_RUNTIME_READ_ONLY",
    runtimeId: runId,
    origin: lib.BASE_URL,
    observedAt: "2026-10-16T19:59:00Z",
    configSha256: "c".repeat(64),
    imageSha256: "d".repeat(64),
    frontendIndexSha256: createHash("sha256").update(html).digest("hex"),
    release,
    schema: {
      database: "postgres",
      tables: 150,
      columns: 2004,
      catalogSha256: "92a06a784d8d90539e17c6f1558d69d2df46d16fff2b22a652f970b0e3a8ce0b",
    },
    holds: {
      outbound: true,
      scheduler: false,
      communications: false,
      stagingOutboundApproved: false,
      recipientAllowlistEmpty: true,
    },
    fixturesSha256: semanticHash(companies),
  };
  const manifest = {
    kind: "GROWTHOS_ACCEPTANCE_EXECUTION_V1",
    runId,
    origin: lib.BASE_URL,
    reviewedBy: "ROOT",
    preparedAt: "2026-10-16T19:59:00Z",
    expiresAt: "2026-10-16T20:10:00Z",
    source,
    companies,
    attestation,
    attestationSha256: semanticHash(attestation),
  };
  for (const drift of [{ tables: 149 }, { columns: 2005 }, { catalogSha256: "a".repeat(64) }]) {
    const changed = structuredClone(manifest);
    Object.assign(changed.attestation.schema, drift);
    changed.attestationSha256 = semanticHash(changed.attestation);
    assert.throws(() => admitManifest(changed, { origin: lib.BASE_URL, source, now }), /attestation_schema/);
  }
  const admission = admitManifest(manifest, {
    origin: lib.BASE_URL,
    source,
    now,
  });
  lib.configureExecution(admission, { now: () => now });
  const c = companies[0],
    staff = c.staff[0];
  let currentId = staff.id,
    mutations = 0,
    liveRelease = release,
    liveHtml = html;
  const page = {
    url: () => lib.BASE_URL + "/",
    evaluate: async (_fn, args) => {
      if (!args) return [...liveHtml];
      if (args.method !== "GET") {
        mutations++;
        return { status: 200, json: {} };
      }
      const who = {
        id: currentId,
        role: "owner",
        isPlatformAdmin: false,
        isActive: true,
        organization: { id: c.organizationId, name: c.name, slug: c.slug },
      };
      return {
        status: 200,
        json:
          args.pathname === "/api/readyz"
            ? { release: liveRelease }
            : args.pathname === "/api/v1/smart-sites"
              ? [{ id: c.siteId, name: c.siteName }]
              : args.pathname === "/api/v1/users"
                ? c.staff.map((s) => ({
                    ...s,
                    isActive: true,
                    operationallyEligible: true,
                  }))
                : who,
      };
    },
  };
  await lib.preflightPage(page, c, staff);
  return { page, c, staff, id, now, admission, actor: value => { currentId = value; },
    release: value => { liveRelease = value; }, html: value => { liveHtml = value; }, mutations: () => mutations };
}
test("actual API wrapper rechecks session identity and blocks a later actor switch", async () => {
  const f = await admittedBrowser(), { page, id, staff } = f;
  await lib.api(page, "PUT", "/api/v1/staff-push/policy", {});
  assert.equal(f.mutations(), 1);
  f.actor(id(999));
  await assert.rejects(lib.api(page, "PUT", "/api/v1/staff-push/policy", {}));
  assert.equal(f.mutations(), 1);
  f.actor(staff.id);
  f.release({ ...f.admission.manifest.attestation.release, sha: "0".repeat(40) });
  await assert.rejects(lib.api(page, "PUT", "/api/v1/staff-push/policy", {}));
  assert.equal(f.mutations(), 1);
  f.release(f.admission.manifest.attestation.release);
  f.html(Buffer.from("unreviewed frontend"));
  await assert.rejects(lib.api(page, "PUT", "/api/v1/staff-push/policy", {}));
  assert.equal(f.mutations(), 1);
});

test.each(["valid", "foreign", "different object", "extra query", "wrong bytes", "actor changed", "admission replaced", "expired", "redirect", "wrong media"])("guarded loopback photo upload: %s", async scenario => {
  const f = await admittedBrowser();
  let handler, instant = f.now;
  lib.configureExecution(f.admission, { now: () => instant });
  await lib.installContextGuard({route: async (_, callback) => {handler = callback;}});
  const visit = f.id(41), entry = f.id(42), object = f.id(43), requestId = f.id(44), photoId = f.id(45);
  const bytes = Buffer.from("synthetic fixture");
  const type = "image/png";
  const routePath = "/api/v1/appointments/" + visit + "/work/entries/" + entry + "/photos/request-url";
  const signedPath = "/api/v1/public/uploads/local/" + object + "?token=test.fixture";
  await lib.expectLocalVisitPhoto(f.page, { appointmentId: visit, entryId: entry, bytes, contentType: type });
  const response = {organizationId:f.c.organizationId, receipt:{requestId,replayed:false}, photoId,
    uploadExpiresAt:new Date(instant + 1000).toISOString(), uploadUrl:signedPath,
    work:{organizationId:f.c.organizationId,appointment:{id:visit},entries:[{id:entry,photos:[{id:photoId,entryId:entry,state:"reserved",contentType:type,sizeBytes:bytes.length}]}]}};
  let transmitted = 0;
  async function invoke(url, method, contentType, data, status = 200) {
    let outcome;
    const req = { url:()=>url, method:()=>method, frame:()=>({page:()=>f.page}), headers:()=>({"content-type":contentType}),
      postDataJSON:()=>({requestId,contentType:type,sizeBytes:bytes.length}), postDataBuffer:()=>data };
    await handler({request:()=>req, continue:()=>{outcome="continue";},abort:()=>{outcome="abort";},fulfill:()=>{outcome="fulfill";},
      fetch:async opts=>{assert.equal(opts.maxRedirects,0);if(method==="PUT")transmitted++;return {status:()=>status,json:async()=>response};}});
    return outcome;
  }
  assert.equal(await invoke(lib.BASE_URL + routePath,"POST","application/json"),"fulfill");
  let url = lib.BASE_URL + signedPath, data = bytes, media = type;
  if(scenario==="foreign")url=url.replace("127.0.0.1","example.invalid");
  if(scenario==="different object")url=url.replace(object,f.id(49));
  if(scenario==="extra query")url+="&extra=1";
  if(scenario==="wrong bytes")data=Buffer.alloc(bytes.length);
  if(scenario==="actor changed")f.actor(f.id(99));
  if (scenario === "admission replaced") {
    const replacement = admitManifest(f.admission.manifest, {
      origin: lib.BASE_URL, source: f.admission.manifest.source, now: instant,
    });
    assert.notEqual(replacement, f.admission);
    lib.configureExecution(replacement, { now: () => instant });
  }
  if(scenario==="expired")instant+=1001;
  if(scenario==="wrong media")media="image/jpeg";
  const valid=scenario==="valid";
  assert.equal(await invoke(url,"PUT",media,data,scenario==="redirect"?307:201),valid?"fulfill":"abort");
  assert.equal(transmitted,valid||scenario==="redirect"?1:0);
  if(valid)assert.equal(await invoke(url,"PUT",media,data),"abort");
});
