import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  attestRelease,
  hostedConfiguration,
  hostedFailure,
  inspectionEnvironment,
  proveSessionLockExclusion,
  runHostedDrill,
  restoredReaderUrl,
  verifyInspectionHttp,
  RELEASE_SHA,
  IMAGE_REF,
} from "./hosted-pilot-drill.mjs";
import { parseRestoreDrillTarget } from "./restore-drill-readonly.mjs";
import { fixtureIds, fixtureObject } from "./restore-drill-fixture.mjs";

const env = {
  FLY_APP_NAME: "mogulforge-growthos-staging",
  GROWTHOS_OUTBOUND_HOLD: "true",
  STAGING_OUTBOUND_APPROVED: "false",
  SCHEDULER_AUTOSTART: "false",
  RESTORE_DRILL_RELEASE_SHA: RELEASE_SHA,
  RESTORE_DRILL_IMAGE_REF: IMAGE_REF,
  DATABASE_URL:
    "postgresql://growthos-staging-live:writer-private@pgbouncer.zp2wjrejd2zodn4q.flympg.net/growthos_staging",
  RESTORE_DRILL_READER_DATABASE_URL:
    "postgresql://growthos-restore-reader:reader-private@pgbouncer.zp2wjrejd2zodn4q.flympg.net/growthos_staging",
  OAUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 48).toString("base64"),
  RESTORE_DRILL_SESSION_BEARER: "a7".repeat(32),
  RESTORE_DRILL_SEED_APPROVED: "true",
};
const restored = () => ({
  ...env,
  RESTORE_DRILL_MODE: "managed",
  RESTORE_DRILL_EXPECTED_CLUSTER_ID: "restored123",
  RESTORE_DRILL_READER_DATABASE_URL:
    env.RESTORE_DRILL_READER_DATABASE_URL.replace(
      "zp2wjrejd2zodn4q",
      "restored123",
    ),
  RESTORE_DRILL_EXPECTED_BUNDLE_SHA256: "d".repeat(64),
  RESTORE_DRILL_SOURCE_FINGERPRINT_A: "a".repeat(64),
  RESTORE_DRILL_SOURCE_FINGERPRINT_B: "b".repeat(64),
});
const inspectionSlugs = ["restore-drill-pilot-a", "restore-drill-pilot-b"];
function successfulInspectionResponse(url, init = {}) {
  const path = new URL(url).pathname;
  const a = fixtureIds(inspectionSlugs[0]);
  const b = fixtureIds(inspectionSlugs[1]);
  if (
    init.method === "PATCH" ||
    [
      "/api/login",
      "/api/logout",
      "/api/v1/integrations/google/callback",
      "/api/v1/public/assessments",
    ].includes(path)
  )
    return new Response(null, { status: 405 });
  if (
    [
      `/api/v1/contacts/${b.contact}`,
      `/api/v1/leads/${b.lead}`,
      `/api/v1/revenue/rooms/${b.lead}`,
      `/api/v1/storage/objects/uploads/${b.object}`,
    ].includes(path)
  )
    return new Response(null, { status: 404 });
  if (path === `/api/v1/storage/objects/uploads/${a.object}`)
    return new Response(fixtureObject(inspectionSlugs[0]));
  const records = {
    "/api/auth/user": { user: { id: a.user } },
    [`/api/v1/contacts/${a.contact}`]: { id: a.contact },
    [`/api/v1/leads/${a.lead}`]: { id: a.lead },
    [`/api/v1/projects/${a.project}`]: { id: a.project },
    [`/api/v1/revenue/rooms/${a.lead}`]: {
      leadId: a.lead,
      versions: [{ id: a.room }],
    },
    "/api/v1/revenue/value": { entries: [{ id: a.value }] },
    [`/api/v1/revenue/executions/${a.execution}`]: {
      execution: { id: a.execution },
      events: [{ id: a.executionEvent }],
    },
    [`/api/v1/revenue/evidence/${a.lead}`]: { leadId: a.lead },
    "/api/v1/revenue/desk": {
      records: [{ id: a.lead }],
      executions: [{ id: a.execution }],
    },
  };
  if (!Object.hasOwn(records, path)) throw new Error("unexpected_test_route");
  return Response.json(records[path]);
}

describe("hosted pilot drill harness", () => {
  it("pins release refs and source hashes and compares recorded API bundle identity", async () => {
    const hash = (v) => createHash("sha256").update(v).digest("hex");
    const read = vi.fn(async (path) =>
      path.endsWith("index.mjs") ? Buffer.from("bundle") : "source\r\n",
    );
    const manifest = { "source.ts": hash("source\n") };
    expect(
      (await attestRelease("/app", env, read, manifest)).apiBundleSha256,
    ).toBe(hash("bundle"));
    await expect(
      attestRelease(
        "/app",
        { ...env, RESTORE_DRILL_IMAGE_REF: "latest" },
        read,
        manifest,
      ),
    ).rejects.toThrow("hosted_release_reference_mismatch");
    await expect(
      attestRelease("/app", env, read, { "source.ts": "0".repeat(64) }),
    ).rejects.toThrow("hosted_release_source_mismatch");
    await expect(
      attestRelease(
        "/app",
        { ...env, RESTORE_DRILL_EXPECTED_BUNDLE_SHA256: "0".repeat(64) },
        read,
        manifest,
      ),
    ).rejects.toThrow("hosted_release_bundle_mismatch");
  });
  it("requires explicit source seed controls and separate source/restore targets", () => {
    const source = hostedConfiguration("--seed-source", env);
    expect(source.seedEnvironments[0].RESTORE_DRILL_SESSION_BEARER).toBe(
      env.RESTORE_DRILL_SESSION_BEARER,
    );
    expect(
      source.seedEnvironments[1].RESTORE_DRILL_SESSION_BEARER,
    ).toBeUndefined();
    for (const reader of source.readerEnvironments)
      expect(parseRestoreDrillTarget(reader).mode).toBe("source");
    for (const reader of hostedConfiguration("--verify-restored", restored())
      .readerEnvironments)
      expect(parseRestoreDrillTarget(reader).mode).toBe("managed");
    expect(() =>
      hostedConfiguration("--seed-source", {
        ...env,
        RESTORE_DRILL_SEED_APPROVED: "false",
      }),
    ).toThrow("hosted_fixture_seed_not_enabled");
    expect(() => hostedConfiguration("--verify-restored", env)).toThrow(
      "hosted_restore_identity_incomplete",
    );
    expect(() =>
      hostedConfiguration("--verify-source", {
        ...env,
        GROWTHOS_OUTBOUND_HOLD: "false",
      }),
    ).toThrow("hosted_console_identity_or_holds_missing");
  });
  it("passes no writer, sender, hosting credential or inspection bearer into the private app", () => {
    const parent = {
      ...restored(),
      PATH: "/usr/bin",
      TWILIO_AUTH_TOKEN: "secret",
      FLY_API_TOKEN: "secret",
      RESEND_API_KEY: "secret",
      GOOGLE_CLIENT_SECRET: "secret",
    };
    const child = inspectionEnvironment(
      parent,
      hostedConfiguration("--inspect-restored-app", parent),
      31843,
    );
    expect(child.DATABASE_URL).toBe(parent.RESTORE_DRILL_READER_DATABASE_URL);
    expect(child.HOST).toBe("127.0.0.1");
    expect(child.APP_ORIGIN).toBe("http://127.0.0.1:31843");
    expect(child.FLY_APP_NAME).toBe("mogulforge-growthos-restore-drill");
    for (const name of [
      "TWILIO_AUTH_TOKEN",
      "FLY_API_TOKEN",
      "RESEND_API_KEY",
      "GOOGLE_CLIENT_SECRET",
      "RESTORE_DRILL_SESSION_BEARER",
    ])
      expect(child[name]).toBeUndefined();
    expect(JSON.stringify(child)).not.toContain("writer-private");
  });
  it("derives a managed restored Reader URL only from the exact guarded source secret and an explicit new cluster", () => {
    const config = {
      ...restored(),
      RESTORE_DRILL_READER_DATABASE_URL: env.RESTORE_DRILL_READER_DATABASE_URL,
      RESTORE_DRILL_USE_RESTORED_SOURCE_CREDENTIAL: "true",
    };
    const target = new URL(
      restoredReaderUrl("--verify-restored", config, parseRestoreDrillTarget),
    );
    const source = new URL(env.RESTORE_DRILL_READER_DATABASE_URL);
    expect(target.hostname).toBe("pgbouncer.restored123.flympg.net");
    for (const key of ["username", "password", "pathname", "port", "search"])
      expect(target[key]).toBe(source[key]);
    expect(config.RESTORE_DRILL_READER_DATABASE_URL).toBe(
      env.RESTORE_DRILL_READER_DATABASE_URL,
    );
    expect(
      hostedConfiguration(
        "--verify-restored",
        config,
        parseRestoreDrillTarget,
      ).readerEnvironments.every(
        (reader) => parseRestoreDrillTarget(reader).clusterId === "restored123",
      ),
    ).toBe(true);
    for (const cluster of [
      "zp2wjrejd2zodn4q",
      "kzpwm0j18eg04nv3",
      "evil.example/target",
    ])
      expect(() =>
        restoredReaderUrl(
          "--verify-restored",
          { ...config, RESTORE_DRILL_EXPECTED_CLUSTER_ID: cluster },
          parseRestoreDrillTarget,
        ),
      ).toThrow("hosted_restored_cluster_forbidden");
    for (const sourceUrl of [
      env.DATABASE_URL,
      env.RESTORE_DRILL_READER_DATABASE_URL.replace(
        "growthos_staging",
        "other_db",
      ),
      env.RESTORE_DRILL_READER_DATABASE_URL.replace(
        "zp2wjrejd2zodn4q",
        "kzpwm0j18eg04nv3",
      ),
      env.RESTORE_DRILL_READER_DATABASE_URL.replace(
        "pgbouncer.zp2wjrejd2zodn4q.flympg.net",
        "127.0.0.1",
      ),
    ])
      expect(() =>
        restoredReaderUrl(
          "--verify-restored",
          { ...config, RESTORE_DRILL_READER_DATABASE_URL: sourceUrl },
          parseRestoreDrillTarget,
        ),
      ).toThrow();
    expect(() =>
      restoredReaderUrl("--seed-source", config, parseRestoreDrillTarget),
    ).toThrow("hosted_restored_credential_mode_invalid");
    expect(() =>
      restoredReaderUrl(
        "--verify-restored",
        { ...config, RESTORE_DRILL_MODE: "logical" },
        parseRestoreDrillTarget,
      ),
    ).toThrow("hosted_restored_credential_mode_invalid");
  });
  it("uses a separately secured recovered Reader only for the exact managed restore and keeps source secrets unchanged", () => {
    const config = {
      ...restored(),
      RESTORE_DRILL_READER_DATABASE_URL: env.RESTORE_DRILL_READER_DATABASE_URL,
      RESTORE_DRILL_USE_RECOVERED_READER: "true",
      RESTORE_DRILL_RECOVERED_READER_DATABASE_URL:
        restored().RESTORE_DRILL_READER_DATABASE_URL.replace(
          "reader-private",
          "regenerated-reader-private",
        ),
    };
    const original = { ...config };
    const actual = hostedConfiguration(
      "--inspect-restored-app",
      config,
      parseRestoreDrillTarget,
    );
    expect(
      actual.readerEnvironments.every(
        (reader) =>
          reader.RESTORE_DRILL_DATABASE_URL ===
          config.RESTORE_DRILL_RECOVERED_READER_DATABASE_URL,
      ),
    ).toBe(true);
    expect(config).toEqual(original);
    expect(actual.seedEnvironments[0].RESTORE_DRILL_DATABASE_URL).toBe(
      env.DATABASE_URL,
    );
    expect(inspectionEnvironment(config, actual, 31843).DATABASE_URL).toBe(
      config.RESTORE_DRILL_RECOVERED_READER_DATABASE_URL,
    );
    expect(() =>
      restoredReaderUrl(
        "--verify-restored",
        { ...config, RESTORE_DRILL_USE_RESTORED_SOURCE_CREDENTIAL: "true" },
        parseRestoreDrillTarget,
      ),
    ).toThrow("hosted_restore_credential_modes_conflict");
    for (const mode of ["--seed-source", "--verify-source"])
      expect(() =>
        restoredReaderUrl(mode, config, parseRestoreDrillTarget),
      ).toThrow("hosted_restored_credential_mode_invalid");
    expect(() =>
      restoredReaderUrl(
        "--verify-restored",
        { ...config, RESTORE_DRILL_MODE: "logical" },
        parseRestoreDrillTarget,
      ),
    ).toThrow("hosted_restored_credential_mode_invalid");
    expect(() =>
      restoredReaderUrl(
        "--verify-restored",
        { ...config, RESTORE_DRILL_RECOVERED_READER_DATABASE_URL: undefined },
        parseRestoreDrillTarget,
      ),
    ).toThrow("hosted_recovered_reader_missing");
    for (const target of [
      env.RESTORE_DRILL_READER_DATABASE_URL,
      config.RESTORE_DRILL_RECOVERED_READER_DATABASE_URL.replace(
        "restored123",
        "kzpwm0j18eg04nv3",
      ),
      config.RESTORE_DRILL_RECOVERED_READER_DATABASE_URL.replace(
        "restored123",
        "different123",
      ),
      config.RESTORE_DRILL_RECOVERED_READER_DATABASE_URL.replace(
        "growthos-restore-reader",
        "growthos-staging-live",
      ),
      config.RESTORE_DRILL_RECOVERED_READER_DATABASE_URL.replace(
        "growthos_staging",
        "production_db",
      ),
      config.RESTORE_DRILL_RECOVERED_READER_DATABASE_URL.replace(
        "pgbouncer.restored123.flympg.net",
        "127.0.0.1",
      ),
    ])
      expect(() =>
        restoredReaderUrl(
          "--verify-restored",
          { ...config, RESTORE_DRILL_RECOVERED_READER_DATABASE_URL: target },
          parseRestoreDrillTarget,
        ),
      ).toThrow();
    expect(
      restoredReaderUrl(
        "--verify-source",
        {
          ...env,
          RESTORE_DRILL_RECOVERED_READER_DATABASE_URL:
            config.RESTORE_DRILL_RECOVERED_READER_DATABASE_URL,
        },
        parseRestoreDrillTarget,
      ),
    ).toBe(env.RESTORE_DRILL_READER_DATABASE_URL);
  });
  it("validates all targets before seeding and emits only the delegated safe evidence", async () => {
    const seed = vi.fn(async (config) => ({
      syntheticSlug: config.RESTORE_DRILL_SYNTHETIC_SLUG,
      inserted: true,
    }));
    const runtime = {
      parseRestoreDrillTarget,
      seedRestoreFixture: seed,
      runRestoreDrillReadOnly: vi.fn(async () => ({
        fingerprint: "a".repeat(64),
      })),
      verifyRestoreFixture: vi.fn(async () => ({
        credentialDecryptVerified: true,
      })),
    };
    const emit = vi.fn();
    const options = {
      attest: async () => ({ releaseSha: RELEASE_SHA }),
      load: async () => runtime,
      emit,
    };
    const result = await runHostedDrill("--seed-source", env, options);
    expect(seed).toHaveBeenCalledTimes(2);
    expect(result.tenants).toHaveLength(2);
    expect(result.providerCalled).toBe(false);
    for (const secret of [
      env.OAUTH_TOKEN_ENCRYPTION_KEY,
      env.RESTORE_DRILL_SESSION_BEARER,
      "writer-private",
      "reader-private",
    ])
      expect(emit.mock.calls[0][0]).not.toContain(secret);
    seed.mockClear();
    await expect(
      runHostedDrill(
        "--seed-source",
        {
          ...env,
          RESTORE_DRILL_READER_DATABASE_URL:
            env.RESTORE_DRILL_READER_DATABASE_URL.replace(
              "zp2wjrejd2zodn4q",
              "kzpwm0j18eg04nv3",
            ),
        },
        options,
      ),
    ).rejects.toThrow("restore_production_target_forbidden");
    expect(seed).not.toHaveBeenCalled();
  });
  it("reports a fixed phase and SQLSTATE without connection details or raw error messages", async () => {
    const secret = "postgresql://reader:never-output-this@private-db/restored";
    const runtime = {
      parseRestoreDrillTarget,
      runRestoreDrillReadOnly: async () => {
        const failure = new Error(`connection failed for ${secret}`);
        failure.code = "08P01";
        throw failure;
      },
    };
    let caught;
    try {
      await runHostedDrill("--verify-source", env, {
        attest: async () => ({ releaseSha: RELEASE_SHA }),
        load: async () => runtime,
        emit: vi.fn(),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toBe("08P01");
    const evidence = hostedFailure(caught);
    expect(evidence).toEqual({
      check: "hosted_pilot_drill_failure",
      phase: "fingerprint_tenant_a",
      label: "08P01",
      sqlstate: "08P01",
    });
    expect(JSON.stringify(evidence)).not.toContain(secret);
    expect(JSON.stringify(evidence)).not.toContain("connection failed");
    expect(
      hostedFailure({
        message: secret,
        hostedPhase: secret,
        code: secret,
      }),
    ).toEqual({
      check: "hosted_pilot_drill_failure",
      phase: "unknown",
      label: "operation_failed",
      sqlstate: null,
    });
  });
  it("checks separate session lock ownership and always closes the two clients", async () => {
    let owner = null;
    const clients = [];
    class Client {
      constructor() {
        this.id = clients.length + 10;
        this.connected = false;
        clients.push(this);
      }
      async connect() {
        this.connected = true;
      }
      async end() {
        this.connected = false;
      }
      async query(text) {
        if (text.includes("try_advisory")) {
          const acquired = owner === null || owner === this.id;
          if (acquired) owner = this.id;
          return { rows: [{ acquired, pid: this.id }] };
        }
        if (text.includes("advisory_unlock")) {
          const released = owner === this.id;
          if (released) owner = null;
          return { rows: [{ released }] };
        }
        return { rows: [{ pid: this.id }] };
      }
    }
    expect(
      (await proveSessionLockExclusion("unused", Client)).competingLockExcluded,
    ).toBe(true);
    expect(owner).toBeNull();
    expect(clients.every((client) => !client.connected)).toBe(true);
  });
  it("accepts the actual nested auth response contract and completes all read and denial checks", async () => {
    const request = vi.fn(async (url, init) =>
      successfulInspectionResponse(url, init),
    );
    await expect(
      verifyInspectionHttp(
        "http://127.0.0.1:31843",
        env.RESTORE_DRILL_SESSION_BEARER,
        inspectionSlugs,
        { fixtureIds, fixtureObject },
        request,
      ),
    ).resolves.toEqual({
      authenticatedReadChecks: 9,
      privateObjectBytesMatched: true,
      crossTenantReadDenials: 4,
      writeAndAuthenticationDenials: 5,
    });
    expect(request).toHaveBeenCalledTimes(19);
    expect(
      request.mock.calls.every(
        ([, init]) =>
          init.headers.authorization ===
          `Bearer ${env.RESTORE_DRILL_SESSION_BEARER}`,
      ),
    ).toBe(true);
  });
  it.each([
    [
      "status",
      () => new Response("sensitive response body", { status: 500 }),
      "unexpected_http_status",
      500,
    ],
    ["json", () => new Response("sensitive invalid JSON"), "invalid_json", 200],
    [
      "record",
      () =>
        Response.json({
          id: fixtureIds(inspectionSlugs[0]).user,
          secret: "sensitive legacy shape",
        }),
      "record_mismatch",
      200,
    ],
    ["null", () => Response.json(null), "record_mismatch", 200],
    [
      "transport",
      () => {
        throw new Error(
          `sensitive transport ${env.RESTORE_DRILL_SESSION_BEARER}`,
        );
      },
      "transport_error",
      null,
    ],
    [
      "timeout",
      () => {
        throw new DOMException("sensitive timeout", "TimeoutError");
      },
      "request_timeout",
      null,
    ],
  ])(
    "reports a safe auth route diagnostic for a %s failure",
    async (_name, response, category, status) => {
      const caught = await verifyInspectionHttp(
        "http://127.0.0.1:31843",
        env.RESTORE_DRILL_SESSION_BEARER,
        inspectionSlugs,
        { fixtureIds, fixtureObject },
        async () => response(),
      ).catch((error) => error);
      expect(caught).toBeInstanceOf(Error);
      const evidence = hostedFailure(caught);
      expect(evidence).toMatchObject({
        routeCheck: "auth_user",
        route: "GET /api/auth/user",
        httpStatus: status,
        expectedHttpStatus: 200,
        failureCategory: category,
      });
      expect(JSON.stringify(evidence)).not.toContain("sensitive");
      expect(JSON.stringify(evidence)).not.toContain(
        env.RESTORE_DRILL_SESSION_BEARER,
      );
    },
  );
  it("retains allowlisted route diagnostics through the outer inspection phase and rejects injected fields", async () => {
    const caught = await runHostedDrill("--inspect-restored-app", restored(), {
      attest: async () => ({ releaseSha: RELEASE_SHA }),
      load: async () => ({
        parseRestoreDrillTarget,
        runRestoreDrillReadOnly: async () => ({ fingerprint: "a".repeat(64) }),
        verifyRestoreFixture: async () => ({ credentialDecryptVerified: true }),
      }),
      inspect: async () =>
        verifyInspectionHttp(
          "http://127.0.0.1:31843",
          env.RESTORE_DRILL_SESSION_BEARER,
          inspectionSlugs,
          { fixtureIds, fixtureObject },
          async (url, init) =>
            url.endsWith("/api/v1/revenue/desk")
              ? new Response("sensitive failure body", { status: 503 })
              : successfulInspectionResponse(url, init),
        ),
      emit: vi.fn(),
    }).catch((error) => error);
    expect(hostedFailure(caught)).toMatchObject({
      phase: "inspect_private_app",
      label: "hosted_app_record_read_failed",
      routeCheck: "revenue_desk_a",
      route: "GET /api/v1/revenue/desk",
      httpStatus: 503,
      expectedHttpStatus: 200,
      failureCategory: "unexpected_http_status",
    });
    expect(JSON.stringify(hostedFailure(caught))).not.toContain("sensitive");
    expect(
      hostedFailure({
        message: "sensitive failure",
        hostedHttpCheck: "sensitive path",
        hostedHttpStatus: 500,
        hostedHttpCategory: "unexpected_http_status",
      }),
    ).not.toHaveProperty("routeCheck");
    expect(
      hostedFailure({
        message: "sensitive failure",
        hostedHttpCheck: "auth_user",
        hostedHttpStatus: 500,
        hostedHttpCategory: "sensitive response",
      }),
    ).not.toHaveProperty("routeCheck");
  });
  it("rejects corrupted private media in authenticated HTTP acceptance", async () => {
    const slugs = ["restore-drill-pilot-a", "restore-drill-pilot-b"];
    const id = fixtureIds(slugs[0]);
    const bodyFor = (path) => {
      if (path.endsWith("/api/auth/user")) return { user: { id: id.user } };
      if (path.includes("/contacts/")) return { id: id.contact };
      if (path.includes("/leads/")) return { id: id.lead };
      if (path.includes("/projects/")) return { id: id.project };
      if (path.includes("/rooms/"))
        return { leadId: id.lead, versions: [{ id: id.room }] };
      if (path.endsWith("/value")) return { entries: [{ id: id.value }] };
      if (path.includes("/executions/"))
        return {
          execution: { id: id.execution },
          events: [{ id: id.executionEvent }],
        };
      if (path.includes("/evidence/")) return { leadId: id.lead };
      return { records: [{ id: id.lead }], executions: [{ id: id.execution }] };
    };
    const request = vi.fn(async (path) =>
      path.includes("/storage/")
        ? new Response("corrupted")
        : Response.json(bodyFor(path)),
    );
    await expect(
      verifyInspectionHttp(
        "http://127.0.0.1:31843",
        env.RESTORE_DRILL_SESSION_BEARER,
        slugs,
        { fixtureIds, fixtureObject },
        request,
      ),
    ).rejects.toThrow("hosted_app_private_object_failed");
  });
});
