import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
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
        "https://growthos-staging.example.test",
        "--company",
        "Painless Roofing",
        "--site-origin",
        "https://preview.example.test",
      ]),
    );
    expect(JSON.parse(staging.stderr)).toMatchObject({
      error: "staging_label_required",
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
      verified: true,
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
      verified: true,
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
        "--rotate-key",
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
      final: { isActive: true, analyticsEnabled: true, credentialVersion: 2 },
    });
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
      ["submit", "--api", base, "--site-label", "painless", "--postal-code", "30115"],
      env,
    );
    expect(submitted.exitCode).toBe(0);
    const out = JSON.parse(submitted.stdout);
    expect(out).toMatchObject({ label: "TEST", passed: true });
    expect(out.checks.map((c: { name: string }) => c.name)).toEqual([
      "intake_201_saved",
      "receipt_uuids",
      "receipt_contract",
      "idempotent_replay",
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
    const ids = ["--lead-id", out.leadId, "--request-id", out.requestId];
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
      deleted: { leads: 1, contacts: 1, smart_site_submissions: 1, crm_tasks: 1 },
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
      ["cleanup", "--lead-id", leadId, "--request-id", requestId, "--apply"],
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
    const ids = ["--lead-id", randomUUID(), "--request-id", randomUUID()];
    const remote = await run(acceptanceMain, ["cleanup", ...ids], {
      DATABASE_URL: "postgresql://u:p@db.example.test:5432/growthos",
    });
    expect(JSON.parse(remote.stderr)).toMatchObject({ error: "env_mismatch" });
    const staging = await run(
      acceptanceMain,
      ["cleanup", "--env", "staging", ...ids, "--apply"],
      { DATABASE_URL: process.env.DATABASE_URL },
    );
    expect(JSON.parse(staging.stderr)).toMatchObject({
      error: "confirmation_required",
    });
    const production = await run(
      acceptanceMain,
      ["submit", "--env", "production", "--api", "https://app.mogulforge.ai"],
      { GROWTHOS_SITE_ID: siteId, GROWTHOS_SITE_SECRET: secret },
    );
    expect(JSON.parse(production.stderr)).toMatchObject({
      error: "owner_approval_required",
    });
  });
});
