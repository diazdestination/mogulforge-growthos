import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  appointmentsTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  smartSiteSubmissionsTable,
  smartSitesTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../../app";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

type Main = (
  argv: string[],
  io: Record<string, unknown>,
) => Promise<number>;
const scriptUrl = (name: string) =>
  new URL(`../../../../../scripts/smart-sites/${name}`, import.meta.url).href;
let provisionMain: Main;
let acceptanceMain: Main;

const COMPANY = "Painless Roofing LOCAL TEST";
let server: Server;
let base: string;
let orgId: string;
let session: string;
let otherOrgId: string;

const sink = () => {
  let text = "";
  return {
    isTTY: false,
    write: (chunk: string) => {
      text += chunk;
      return true;
    },
    get text() {
      return text;
    },
  };
};
const run = async (
  main: Main,
  argv: string[],
  environment: Record<string, string | undefined> = {},
) => {
  const stdout = sink();
  const stderr = sink();
  const exitCode = await main(argv, {
    environment: { GROWTHOS_OWNER_SESSION: session, ...environment },
    stdout,
    stderr,
  });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
};
const provisionArgs = (overrides: string[] = []) => [
  "--env",
  "local",
  "--api",
  base,
  "--company",
  COMPANY,
  "--site-key",
  "painless-roofing-website",
  "--site-name",
  "Painless Roofing website",
  "--profile",
  "roofing-exteriors",
  "--site-origin",
  "http://127.0.0.1:8788",
  "--analytics",
  "off",
  ...overrides,
];
const siteRow = async () =>
  (
    await db
      .select()
      .from(smartSitesTable)
      .where(eq(smartSitesTable.organizationId, orgId))
  )[0];

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !url.pathname.endsWith("_test")
  )
    throw new Error("Hookup script tests require a local *_test database");
  provisionMain = (await import(scriptUrl("provision-site.mjs"))).main;
  acceptanceMain = (await import(scriptUrl("acceptance-lead.mjs"))).main;
  const [org, other] = await db
    .insert(organizationsTable)
    .values([
      { name: COMPANY, slug: `hookup-${randomUUID()}` },
      { name: "Other hookup company", slug: `hookup-other-${randomUUID()}` },
    ])
    .returning();
  orgId = org.id;
  otherOrgId = other.id;
  const [owner] = await db
    .insert(usersTable)
    .values({
      organizationId: orgId,
      role: "owner",
      email: `hookup-owner-${randomUUID()}@example.test`,
      emailVerifiedAt: new Date(),
    })
    .returning();
  session = await createSession({
    user: {
      id: owner.id,
      email: owner.email,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "test-only",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server?.close();
  await deleteTestOrgs(orgId, otherOrgId);
});

describe("provision-site.mjs guards", () => {
  it("refuses production without the owner-approval flag and pins the production origin", async () => {
    const args = (api: string, extra: string[] = []) =>
      provisionArgs([
        "--env",
        "production",
        "--api",
        api,
        "--site-origin",
        "https://painlessroofing.com",
        ...extra,
      ]);
    const refused = await run(provisionMain, args("https://app.mogulforge.ai"));
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stderr)).toMatchObject({
      error: "owner_approval_required",
    });
    const wrongOrigin = await run(
      provisionMain,
      args("https://staging.example.test", ["--i-have-owner-approval"]),
    );
    expect(JSON.parse(wrongOrigin.stderr)).toMatchObject({
      error: "env_mismatch",
    });
    expect(refused.stdout + wrongOrigin.stdout).toBe("");
  });
  it("requires TEST labels on staging, loopback for local and exact origins", async () => {
    const staging = await run(
      provisionMain,
      provisionArgs([
        "--env",
        "staging",
        "--api",
        "https://mogulforge-growthos-staging.fly.dev",
        "--company",
        "Painless Roofing",
        "--site-origin",
        "https://preview.example.test",
      ]),
    );
    expect(JSON.parse(staging.stderr)).toMatchObject({
      error: "staging_label_required",
    });
    const otherStaging = await run(
      provisionMain,
      provisionArgs([
        "--env",
        "staging",
        "--api",
        "https://some-other-app.example.test",
        "--site-origin",
        "https://preview.example.test",
      ]),
    );
    expect(JSON.parse(otherStaging.stderr)).toMatchObject({
      error: "env_mismatch",
    });
    const remoteLocal = await run(
      provisionMain,
      provisionArgs(["--api", "https://app.mogulforge.ai"]),
    );
    expect(JSON.parse(remoteLocal.stderr)).toMatchObject({
      error: "env_mismatch",
    });
    const pathOrigin = await run(
      provisionMain,
      provisionArgs(["--site-origin", "https://painlessroofing.com/contact"]),
    );
    expect(JSON.parse(pathOrigin.stderr)).toMatchObject({
      error: "invalid_origin",
    });
    const unknown = await run(provisionMain, provisionArgs(["--secret", "x"]));
    expect(JSON.parse(unknown.stderr)).toMatchObject({ error: "unknown_flag" });
    const noSession = await run(provisionMain, provisionArgs(), {
      GROWTHOS_OWNER_SESSION: undefined,
    });
    expect(JSON.parse(noSession.stderr)).toMatchObject({
      error: "missing_secret_env",
    });
  });
});

describe("provision-site.mjs against the local API", () => {
  let secret: string;
  let siteId: string;

  it("dry-runs by default without writing anything", async () => {
    const result = await run(provisionMain, provisionArgs());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      mode: "dry-run",
      actions: [
        "create_site",
        "credential_check",
        "capture_left_off_needs_confirm_launch",
      ],
    });
    expect(await siteRow()).toBeUndefined();
  });

  it("refuses a session from a different company than the one named", async () => {
    const result = await run(
      provisionMain,
      provisionArgs(["--company", "Climate Simulation Solutions LOCAL TEST"]),
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: "company_mismatch",
    });
  });

  it("creates, credential-checks and enables the site, printing only the secret on stdout", async () => {
    const result = await run(
      provisionMain,
      provisionArgs(["--apply", "--confirm-launch"]),
    );
    expect(result.exitCode).toBe(0);
    secret = result.stdout.trim();
    expect(result.stdout).toMatch(/^ss_[a-f0-9]{64}\n$/);
    expect(result.stderr).not.toContain(secret);
    const out = JSON.parse(result.stderr);
    siteId = out.siteId;
    expect(out).toMatchObject({
      mode: "apply",
      secretIssued: true,
      secretOutcome: "DELIVERED",
      secretCheck: "verified",
      status: "READY",
      configurationVerified: true,
      readyToCapture: true,
      missing: [],
      blockers: [],
      siteOrigin: "http://127.0.0.1:8788",
      final: { isActive: true, analyticsEnabled: false },
      siteConfig: { GROWTHOS_API_ORIGIN: base, GROWTHOS_SITE_ID: siteId },
    });
    const row = await siteRow();
    expect(row.id).toBe(siteId);
    expect(row.keyHash).toBe(createHash("sha256").update(secret).digest("hex"));
    expect(row.credentialCheckedAt).not.toBeNull();
  });

  it("re-verifies an existing site idempotently without issuing a secret", async () => {
    const result = await run(
      provisionMain,
      provisionArgs(["--apply", "--confirm-launch"]),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      actions: ["verify_existing_site"],
      secretIssued: false,
      status: "READY",
      final: { isActive: true },
    });
  });

  it("rotates the key, sets analytics and prints env lines; the old secret stops working", async () => {
    const result = await run(
      provisionMain,
      provisionArgs([
        "--analytics",
        "on",
        "--apply",
        "--confirm-launch",
        "--rotate-secret",
        "--expected-credential-version",
        "1",
        "--stdout",
        "env",
      ]),
    );
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toBe(`GROWTHOS_SITE_ID=${siteId}`);
    expect(lines[1]).toMatch(/^GROWTHOS_SITE_SECRET=ss_[a-f0-9]{64}$/);
    const rotated = lines[1].split("=")[1];
    expect(rotated).not.toBe(secret);
    expect(JSON.parse(result.stderr)).toMatchObject({
      status: "READY",
      final: { isActive: true, analyticsEnabled: true, credentialVersion: 2 },
    });
    // A rerun of the same command never rotates twice: the version moved on.
    const again = await run(
      provisionMain,
      provisionArgs([
        "--analytics",
        "on",
        "--apply",
        "--confirm-launch",
        "--rotate-secret",
        "--expected-credential-version",
        "1",
      ]),
    );
    expect(again.exitCode).toBe(1);
    expect(again.stdout).toBe("");
    expect(JSON.parse(again.stderr)).toMatchObject({
      error: "credential_version_mismatch",
      currentCredentialVersion: 2,
    });
    expect((await siteRow()).credentialVersion).toBe(2);
    const old = await fetch(
      `${base}/api/v1/public/smart-sites/${siteId}/check`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ schemaVersion: 1 }),
      },
    );
    expect(old.status).toBe(401);
    secret = rotated;
  });

  it("submits a labeled TEST acceptance lead, verifies it, and removes it", async () => {
    const env = { GROWTHOS_SITE_ID: siteId, GROWTHOS_SITE_SECRET: secret };
    const submitted = await run(
      acceptanceMain,
      ["submit", "--api", base, "--company", COMPANY, "--site-label", "painless", "--postal-code", "30115"],
      env,
    );
    expect(submitted.exitCode).toBe(0);
    const out = JSON.parse(submitted.stdout);
    expect(out).toMatchObject({ label: "TEST", passed: true, organizationId: orgId });
    expect(out.checks.map((c: { name: string }) => c.name)).toEqual([
      "intake_201_saved",
      "receipt_uuids",
      "receipt_contract",
      "idempotent_replay",
      "lead_saved_in_target_workspace",
      "lead_labeled_test",
      "inquiry_followup_record",
      "office_task_created",
      "owner_alert_coverage_recorded",
    ]);
    expect(out.ownerAlert.status).toEqual(expect.any(String));
    expect(submitted.stdout).not.toContain(secret);
    const [receipt] = await db
      .select()
      .from(smartSiteSubmissionsTable)
      .where(eq(smartSiteSubmissionsTable.id, out.receiptId));
    expect(receipt.leadId).toBe(out.leadId);
    expect(receipt.consent).toMatchObject({ channels: [] });

    const dbEnv = { DATABASE_URL: process.env.DATABASE_URL };
    const ids = [
      "--lead-id", out.leadId, "--request-id", out.requestId, "--receipt-id", out.receiptId,
      "--task-id", out.taskId, "--contact-id", out.contactId, "--expected-organization-id", orgId,
    ];
    expect(out.cleanup).toContain(`--task-id ${out.taskId}`);

    // Downstream business work on the TEST lead is never swept: cleanup refuses.
    const [appointment] = await db
      .insert(appointmentsTable)
      .values({ organizationId: orgId, leadId: out.leadId, scheduledStart: new Date(Date.now() + 86_400_000) })
      .returning();
    const blocked = await run(acceptanceMain, ["cleanup", ...ids, "--apply"], dbEnv);
    expect(blocked.exitCode).toBe(1);
    expect(JSON.parse(blocked.stderr)).toMatchObject({ error: "downstream_work_present" });
    expect(JSON.parse(blocked.stderr).message).toContain("appointments.lead_id");
    expect(
      await db.select().from(smartSiteSubmissionsTable).where(eq(smartSiteSubmissionsTable.id, out.receiptId)),
    ).toHaveLength(1);
    await db.delete(appointmentsTable).where(eq(appointmentsTable.id, appointment.id));
    const dry = await run(acceptanceMain, ["cleanup", ...ids], dbEnv);
    expect(dry.exitCode).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({
      mode: "dry-run",
      verifiedRemoved: true,
      committed: false,
    });
    expect(
      await db.select().from(leadsTable).where(eq(leadsTable.id, out.leadId)),
    ).toHaveLength(1);

    const applied = await run(
      acceptanceMain,
      ["cleanup", ...ids, "--apply"],
      dbEnv,
    );
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      committed: true,
      deleted: {
        leads: 1,
        contacts: 1,
        smart_site_submissions: 1,
        crm_tasks: 1,
        activities: 1,
        staff_lead_alert_coverage: 1,
      },
    });
    expect(
      await db.select().from(leadsTable).where(eq(leadsTable.id, out.leadId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(contactsTable)
        .where(eq(contactsTable.id, out.contactId)),
    ).toHaveLength(0);
  });

  it("cleanup refuses a lead that is not a labeled TEST lead", async () => {
    const requestId = randomUUID();
    const res = await fetch(`${base}/api/v1/public/smart-sites/${siteId}/intake`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schemaVersion: 1,
        requestId,
        contact: { name: "Real Looking Homeowner", email: `${randomUUID()}@example.com` },
        project: { serviceCode: "roof-repair", timing: "soon" },
        consent: { contact: true, policyVersion: "test-inquiry-v1", channels: ["phone"] },
      }),
    });
    expect(res.status).toBe(201);
    const { leadId } = (await res.json()) as { leadId: string };
    const refused = await run(
      acceptanceMain,
      [
        "cleanup", "--lead-id", leadId, "--request-id", requestId, "--receipt-id", randomUUID(),
        "--task-id", randomUUID(), "--contact-id", randomUUID(), "--apply",
      ],
      { DATABASE_URL: process.env.DATABASE_URL },
    );
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stderr)).toMatchObject({
      error: "not_a_test_lead",
    });
    expect(
      await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)),
    ).toHaveLength(1);
  });

  it("refuses a remote database for local cleanup and staging deletes without confirmation", async () => {
    const ids = [
      "--lead-id", randomUUID(), "--request-id", randomUUID(), "--receipt-id", randomUUID(),
      "--task-id", randomUUID(), "--contact-id", randomUUID(),
    ];
    const remote = await run(acceptanceMain, ["cleanup", ...ids], {
      DATABASE_URL: "postgresql://u:p@db.example.test:5432/growthos",
    });
    expect(JSON.parse(remote.stderr)).toMatchObject({ error: "env_mismatch" });
    const staging = await run(
      acceptanceMain,
      ["cleanup", "--env", "staging", ...ids, "--expected-organization-id", randomUUID(), "--apply"],
      { DATABASE_URL: process.env.DATABASE_URL },
    );
    expect(JSON.parse(staging.stderr)).toMatchObject({
      error: "confirmation_required",
    });
    const production = await run(
      acceptanceMain,
      ["submit", "--env", "production", "--api", "https://app.mogulforge.ai", "--company", COMPANY],
      { GROWTHOS_SITE_ID: siteId, GROWTHOS_SITE_SECRET: secret },
    );
    expect(JSON.parse(production.stderr)).toMatchObject({
      error: "owner_approval_required",
    });
    // The production Fly alias is not staging, and staging is one exact origin.
    for (const api of ["https://mogulforge-growthos.fly.dev", "https://mogulforge-growthos-staging.fly.dev.example.test"]) {
      const alias = await run(
        acceptanceMain,
        ["submit", "--env", "staging", "--api", api, "--company", COMPANY],
        { GROWTHOS_SITE_ID: siteId, GROWTHOS_SITE_SECRET: secret },
      );
      expect(JSON.parse(alias.stderr)).toMatchObject({ error: "env_mismatch" });
      const prodAlias = await run(
        acceptanceMain,
        ["submit", "--env", "production", "--api", api, "--company", COMPANY, "--i-have-owner-approval"],
        { GROWTHOS_SITE_ID: siteId, GROWTHOS_SITE_SECRET: secret },
      );
      expect(JSON.parse(prodAlias.stderr)).toMatchObject({ error: "env_mismatch" });
    }
  });

  it("submit refuses a session from another company before sending the lead", async () => {
    const before = await db.select().from(smartSiteSubmissionsTable).where(eq(smartSiteSubmissionsTable.siteId, siteId));
    const wrong = await run(
      acceptanceMain,
      ["submit", "--api", base, "--company", "Climate Simulation Solutions LOCAL TEST"],
      { GROWTHOS_SITE_ID: siteId, GROWTHOS_SITE_SECRET: secret },
    );
    expect(wrong.exitCode).toBe(1);
    expect(JSON.parse(wrong.stderr)).toMatchObject({ error: "company_mismatch" });
    const otherSite = await run(
      acceptanceMain,
      ["submit", "--api", base, "--company", COMPANY],
      { GROWTHOS_SITE_ID: randomUUID(), GROWTHOS_SITE_SECRET: secret },
    );
    expect(JSON.parse(otherSite.stderr)).toMatchObject({ error: "site_not_in_workspace" });
    const after = await db.select().from(smartSiteSubmissionsTable).where(eq(smartSiteSubmissionsTable.siteId, siteId));
    expect(after).toHaveLength(before.length);
  });
});

describe("hookup scripts failure paths (in-memory HTTP/SQL substitutes, no network)", () => {
  const siteId = "11111111-1111-4111-8111-111111111111";
  const orgUuid = "33333333-3333-4333-8333-333333333333";
  const issued = `ss_${"a".repeat(64)}`;
  const company = "Review LOCAL TEST";
  const ok = (data: unknown, status = 200) => ({
    status,
    ok: status < 400,
    text: async () => JSON.stringify(data),
  });
  const baseSite = {
    id: siteId,
    siteKey: "review-test",
    profile: "hvac",
    isActive: true,
    analyticsEnabled: false,
    analyticsRetentionDays: 90,
    credentialVersion: 1,
  };
  const args = (extra: string[] = []) => [
    "--env", "local", "--api", "http://127.0.0.1:3001", "--company", company,
    "--site-key", "review-test", "--site-name", "Review TEST website", "--profile", "hvac",
    "--site-origin", "http://127.0.0.1:8788", "--analytics", "off", "--apply", ...extra,
  ];
  type Opts = {
    listThrowsAfterFirst?: boolean;
    rotate?: "ok" | "throw" | "500";
    readiness?: "ready" | "blocked" | "503";
  };
  const fakeApi = (opts: Opts = {}) => {
    const calls: string[] = [];
    let lists = 0;
    const fetchImpl = async (url: string, init: { method?: string }) => {
      const path = new URL(url).pathname.replace("/api/v1", "");
      const method = init.method ?? "GET";
      calls.push(`${method} ${path}`);
      if (path === "/me") return ok({ role: "owner", organization: { id: orgUuid, name: company } });
      if (path === "/smart-sites/profiles") return ok([{ id: "hvac" }]);
      if (path === "/smart-sites" && method === "GET") {
        lists++;
        if (opts.listThrowsAfterFirst && lists > 1) throw new Error("synthetic reset");
        return ok([baseSite]);
      }
      if (path === `/smart-sites/${siteId}/rotate-key`) {
        if (opts.rotate === "throw") throw new Error("synthetic timeout");
        if (opts.rotate === "500") return ok({ error: "x" }, 500);
        return ok({ ...baseSite, isActive: false, credentialVersion: 2, secret: issued });
      }
      if (path === `/public/smart-sites/${siteId}/check`) return ok({ status: "credential_verified" });
      if (path.startsWith(`/smart-sites/${siteId}`)) return ok({ ...baseSite });
      if (path === "/smart-sites/launch-readiness") {
        if (opts.readiness === "503") return ok({ error: "unavailable" }, 503);
        if (opts.readiness === "blocked")
          return ok({
            staffing: { activeManagers: 1, activeResponders: 0 },
            sites: [{ id: siteId, ready: false, blockers: ["active_responder_required"] }],
          });
        return ok({
          staffing: { activeManagers: 1, activeResponders: 1 },
          sites: [{ id: siteId, ready: true, blockers: [] }],
        });
      }
      throw new Error(`unexpected ${path}`);
    };
    return { fetchImpl, calls };
  };
  const runFake = async (argv: string[], api: ReturnType<typeof fakeApi>) => {
    const stdout = sink();
    const stderr = sink();
    const exitCode = await provisionMain(argv, {
      environment: { GROWTHOS_OWNER_SESSION: "synthetic-session" },
      fetchImpl: api.fetchImpl,
      stdout,
      stderr,
    });
    return { exitCode, stdout: stdout.text, stderr: stderr.text };
  };

  it("delivers a rotated secret exactly once even when every later readback fails", async () => {
    const api = fakeApi({ listThrowsAfterFirst: true, readiness: "503" });
    const result = await runFake(
      args(["--confirm-launch", "--rotate-secret", "--expected-credential-version", "1"]),
      api,
    );
    expect(result.stdout).toBe(`${issued}\n`);
    expect(result.stderr).not.toContain(issued);
    expect(result.exitCode).toBe(2);
    const out = JSON.parse(result.stderr);
    expect(out).toMatchObject({ secretOutcome: "DELIVERED", status: "INCOMPLETE" });
    expect(out.missing).toEqual(
      expect.arrayContaining(["site_readback_failed", "readiness_readback_failed"]),
    );
    expect(api.calls.filter((c) => c.endsWith("/rotate-key"))).toHaveLength(1);
  });

  it.each(["throw", "500"] as const)(
    "reports UNKNOWN and stops when the rotation outcome is uncertain (%s)",
    async (rotate) => {
      const api = fakeApi({ rotate });
      const result = await runFake(
        args(["--rotate-secret", "--expected-credential-version", "1"]),
        api,
      );
      expect(result.exitCode).toBe(3);
      expect(result.stdout).toBe("");
      const out = JSON.parse(result.stderr);
      expect(out).toMatchObject({ status: "UNKNOWN", secretOutcome: "UNKNOWN" });
      expect(out.recovery).toContain("--expected-credential-version");
      expect(api.calls.filter((c) => c.endsWith("/rotate-key"))).toHaveLength(1);
      expect(api.calls.some((c) => c.includes("/check") || c.startsWith("PATCH"))).toBe(false);
    },
  );

  it("never rotates on a rerun without --rotate-secret and refuses a stale expected version", async () => {
    const plain = fakeApi();
    expect((await runFake(args(["--confirm-launch"]), plain)).exitCode).toBe(0);
    expect(plain.calls.some((c) => c.endsWith("/rotate-key"))).toBe(false);
    const stale = fakeApi();
    const refused = await runFake(
      args(["--rotate-secret", "--expected-credential-version", "4"]),
      stale,
    );
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stderr)).toMatchObject({ error: "credential_version_mismatch" });
    expect(stale.calls.some((c) => c.endsWith("/rotate-key"))).toBe(false);
    const missingVersion = await runFake(args(["--rotate-secret"]), fakeApi());
    expect(JSON.parse(missingVersion.stderr)).toMatchObject({ error: "invalid_flag" });
  });

  it.each(["blocked", "503"] as const)(
    "does not report READY when launch readiness is %s",
    async (readiness) => {
      const result = await runFake(args(["--confirm-launch"]), fakeApi({ readiness }));
      expect(result.exitCode).toBe(2);
      const out = JSON.parse(result.stderr);
      expect(out).toMatchObject({
        status: "CONFIGURED_NOT_READY",
        configurationVerified: true,
        readyToCapture: false,
      });
      expect(out.missing).toEqual([
        readiness === "blocked" ? "blocker:active_responder_required" : "readiness_readback_failed",
      ]);
    },
  );

  it("reports a requested analytics state that did not stick", async () => {
    const result = await runFake(args(["--analytics", "on", "--confirm-launch"]), fakeApi());
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      status: "INCOMPLETE",
      missing: ["analytics_state"],
    });
  });

  describe("cleanup target binding", () => {
    const leadId = "44444444-4444-4444-8444-444444444444";
    const requestId = "22222222-2222-4222-8222-222222222222";
    const stagingIdentity = { database: "growthos_staging", login: "growthos-staging-live" };
    const fakePg = (
      identity: { database: string; login: string },
      orgName = "TEST Contractor Acceptance 2026-10-16",
      downstream: { table_name: string; column_name: string }[] = [],
    ) => {
      const queries: string[] = [];
      class FakeClient {
        async connect() {}
        async end() {}
        async query(sql: string) {
          queries.push(sql);
          if (sql.includes("current_database()")) return { rows: [identity] };
          if (sql.includes("SELECT l.id AS lead_id"))
            return {
              rows: [
                {
                  lead_id: leadId,
                  contact_id: requestId,
                  organization_id: orgUuid,
                  organization_name: orgName,
                  summary: "TEST lead - GrowthOS website hookup acceptance (review)",
                  first_name: "TEST",
                  last_name: "GrowthOS Acceptance",
                  email: "growthos-acceptance+22222222@example.test",
                  receipt_id: requestId,
                  other_leads: 0,
                },
              ],
            };
          if (sql.includes("pg_constraint")) return { rows: downstream };
          if (sql.includes("::text = $1")) return { rows: [{ n: 1 }] };
          if (sql.includes(" AS n")) return { rows: [{ n: 0 }] };
          return { rows: [], rowCount: sql.startsWith("DELETE") ? 1 : 0 };
        }
      }
      return { pgModule: { Client: FakeClient }, queries };
    };
    const wrote = (queries: string[]) =>
      queries.some((q) => q.startsWith("DELETE") || q === "COMMIT");
    const cleanupRun = async (argv: string[], pg: ReturnType<typeof fakePg>) => {
      const stdout = sink();
      const stderr = sink();
      const exitCode = await acceptanceMain(
        [
          "cleanup", "--lead-id", leadId, "--request-id", requestId, "--receipt-id", requestId,
          "--task-id", leadId, "--contact-id", requestId, ...argv,
        ],
        {
          // A loopback URL proves nothing: it can be a tunnel to any cluster.
          environment: { DATABASE_URL: "postgresql://u:p@127.0.0.1:16380/anything" },
          pgModule: pg.pgModule,
          fetchImpl: async () => {
            throw new Error("network forbidden");
          },
          stdout,
          stderr,
        },
      );
      return { exitCode, stdout: stdout.text, stderr: stderr.text };
    };
    const staging = [
      "--env", "staging", "--expected-organization-id", orgUuid, "--apply", "--confirm-delete-test-lead",
    ];

    it("refuses a staging cleanup connected to a non-staging database", async () => {
      const pg = fakePg({ database: "growthos_production", login: "growthos-app" });
      const result = await cleanupRun(staging, pg);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: "database_identity_mismatch" });
      expect(wrote(pg.queries)).toBe(false);
    });
    it("refuses staging without an organization binding, a non-TEST workspace or another organization", async () => {
      const unbound = await cleanupRun(
        ["--env", "staging", "--apply", "--confirm-delete-test-lead"],
        fakePg(stagingIdentity),
      );
      expect(JSON.parse(unbound.stderr)).toMatchObject({ error: "organization_binding_required" });
      const realOrg = fakePg(stagingIdentity, "Painless Roofing");
      const notTest = await cleanupRun(staging, realOrg);
      expect(JSON.parse(notTest.stderr)).toMatchObject({ error: "not_a_test_organization" });
      expect(wrote(realOrg.queries)).toBe(false);
      const other = fakePg(stagingIdentity);
      const otherOrg = await cleanupRun(
        ["--env", "staging", "--expected-organization-id", randomUUID(), "--apply", "--confirm-delete-test-lead"],
        other,
      );
      expect(JSON.parse(otherOrg.stderr)).toMatchObject({ error: "organization_mismatch" });
      expect(wrote(other.queries)).toBe(false);
    });
    it("commits only on the verified staging identity, TEST workspace and matching organization", async () => {
      const pg = fakePg(stagingIdentity);
      const result = await cleanupRun(staging, pg);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        committed: true,
        organizationId: orgUuid,
        connectedDatabase: { database: "growthos_staging" },
      });
      expect(pg.queries).toContain("COMMIT");
    });
    it("production cleanup needs owner approval and an attested non-staging identity", async () => {
      const pg = fakePg(stagingIdentity);
      const noApproval = await cleanupRun(["--env", "production", "--expected-organization-id", orgUuid], pg);
      expect(JSON.parse(noApproval.stderr)).toMatchObject({ error: "owner_approval_required" });
      const noIdentity = await cleanupRun(
        ["--env", "production", "--expected-organization-id", orgUuid, "--i-have-owner-approval"],
        pg,
      );
      expect(JSON.parse(noIdentity.stderr)).toMatchObject({ error: "database_binding_required" });
      const stagingAsProd = await cleanupRun(
        [
          "--env", "production", "--expected-organization-id", orgUuid, "--i-have-owner-approval",
          "--expected-database", "growthos_staging", "--expected-login", "growthos-staging-live",
        ],
        pg,
      );
      expect(JSON.parse(stagingAsProd.stderr)).toMatchObject({ error: "env_mismatch" });
      expect(pg.queries).toHaveLength(0);
    });
    it("never deletes beyond the intake rows: downstream business records make cleanup refuse", async () => {
      const pg = fakePg(stagingIdentity, undefined, [{ table_name: "invoices", column_name: "lead_id" }]);
      const result = await cleanupRun(staging, pg);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: "downstream_work_present" });
      expect(pg.queries.some((q) => /DELETE FROM "?invoices/.test(q))).toBe(false);
      expect(pg.queries.some((q) => q.startsWith("DELETE FROM leads"))).toBe(false);
      expect(pg.queries).not.toContain("COMMIT");
      // Every DELETE that did run (and was rolled back) is one of the fixed intake statements.
      const tables = pg.queries
        .filter((q) => q.startsWith("DELETE"))
        .map((q) => q.split(" ")[2]);
      expect(new Set(tables)).toEqual(
        new Set(["staff_push_deliveries", "staff_lead_alert_coverage", "activities", "crm_tasks", "smart_site_submissions"]),
      );
    });
    it("local cleanup refuses a loopback tunnel whose database is not *_test", async () => {
      const pg = fakePg(stagingIdentity);
      const result = await cleanupRun(["--apply"], pg);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: "database_identity_mismatch" });
      expect(wrote(pg.queries)).toBe(false);
    });
  });
});
